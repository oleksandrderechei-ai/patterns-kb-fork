---
title: Ad Click Aggregator
description: "Absorb 10k ad clicks a second without losing one, and answer advertiser queries per-minute in sub-second time"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [event-driven, throughput, durability, read-optimization]
status: stable
aliases: [ad analytics pipeline, click aggregation]
solves: [my database falls over when I try to count millions of events a second in real time, advertisers want up-to-the-minute click totals but my aggregation queries take seconds to return, a viral item floods one partition and that shard spikes while the rest sit idle, the same click gets counted twice when a user double-taps or a request retries, a processing crash loses events and I have no way to recover the exact counts]
---

# Ad Click Aggregator

An ad click aggregator turns a firehose of raw clicks into per-minute metrics advertisers can query in near-real time. Almost all the load sits on the write path, so the design is ingest-first: buffer clicks in a durable stream, pre-aggregate them as they flow, and keep a slower batch layer whose only job is to make the counts exact.

## Understanding the problem
<!--meta block=description-->

An ad click aggregator records every click on an ad, redirects the user, and rolls the clicks up so advertisers can see how a campaign performs. The click is trivial. The load is not: about 10,000 clicks a second arrive at peak, while advertisers refresh a few dashboards a few times a minute. This page walks through ingest that never drops a click and totals computed before anyone asks.

## Explained
<!--meta block=explain-->

An ad click aggregator counts every click ahead of time, so advertisers read finished totals instead of scanning raw events. Each ad link points at your server, which checks the click's signed impression id, drops duplicates, appends the click to a durable queue split by ad, and only then redirects. A stream job folds the queue into one total per ad per minute inside a column-oriented store built for sums over millions of rows. Choose it over one table and a GROUP BY query when writes outnumber reads by about a thousand to one and advertisers are billed on the numbers; the plain table stays cheaper and correct until both stop holding.

- **Two paths.** A live count and a slow recount from the raw log can disagree, so make the recount the authority and alert on corrections.
- **Slow long ranges.** Minute totals make a year-long query slow, so roll them into daily and weekly totals before the first advertiser asks.
- **Hot ad.** A viral ad floods one queue split, so add a random suffix to popular ads keys and sum the pieces on write.

**Example.** At peak your service takes 10,000 clicks a second. A viral ad draws 4,000 of them, but one queue shard accepts about 1,000 records a second, so three quarters of its clicks back up. You salt that ad's key into 8 suffixes, so each shard sees 500 a second, and the stream job sums the 8 sub-totals into one minute total. The cost is 8 pieces to recombine for one ad. A year of that campaign is 525,600 minute totals; after the nightly rollup it is 365 daily rows, so the dashboard answers in milliseconds.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. A user clicks an ad and is redirected to the advertiser's website.
2. An advertiser queries aggregated click metrics over a time range, down to 1-minute granularity.

Out of scope, named to keep the design narrow: ad targeting and serving, cross-device tracking, offline-channel attribution, fraud and spam detection, and demographic or conversion profiling.

### Non-functional
<!--meta requirement=nfr-->

- **Scale** — 10M active ads, peak ~10k clicks/sec (~1k average, ≈100M clicks/day).
- **Latency** — advertiser queries return in **sub-second** time.
- **No data loss** — collection is accurate and fault-tolerant; a dropped click is a wrong number an advertiser is billed on.
- **Freshness** — as near-real-time as possible; advertisers see a click soon after it happens.
- **Idempotency** — a click is counted once after reconciliation; a duplicate can sit in the live count until the recount corrects it.

## Right-sizing
<!--meta block=sizing-->

**Writes.** Peak is ~10k clicks/sec. Treating peak as roughly 10× the mean gives ~1k clicks/sec on average, so ~1k × 86,400 ≈ **100M clicks/day**. This stream, not the query load, is what the architecture has to survive.

**Reads.** Advertiser traffic is small next to that — dashboards polling pre-computed numbers. The write-to-read asymmetry is the main fact, and it is why the read side gets a query-optimised store while the write side gets a stream.

**Batch window.** If a batch job ran every 5 minutes it would sweep ~300k events at the ~1k/sec mean (~30&nbsp;MB at ~100 bytes each) and ~3M events at the 10k/sec peak (~300&nbsp;MB), small enough for one machine either way. The volume is modest; the rate is the challenge, which is why the choice is about throughput, not storage.

**Dedup set.** Keeping one id per click for idempotency costs 100M/day × 16 bytes (a 128-bit id) ≈ **1.6&nbsp;GB** — trivial to hold in memory.

## Core entities
<!--meta block=entities-->

The write model is deliberately append-only — a click is a fact that happened, never edited afterward:

- **Click** — one click event: `impression_id` (the idempotency key), `ad_id`, event-time `timestamp`, and optional context. Written once, aggregated, never mutated.
- **Impression** — one render of an ad, carrying a unique signed id. A user shown the same ad three times generates three impressions; a click quotes exactly one of them. This is the unit that makes retargeting countable.
- **Ad** — the creative plus metadata (the redirect URL), owned by an advertiser.
- **AdMetric** — the pre-aggregated rollup: `(ad_id, minute_bucket) → clicks, unique_users`. This is the only thing advertisers actually read.
- **Advertiser** — owns ads and queries their metrics.

## The interface
<!--meta block=interface-->

Two surfaces, one per requirement — a write path that is deliberately fat (it does real work before it redirects) and a read path that is deliberately thin:

```http summary="HTTP — track a click, then query the rollup"
GET /click?impression_id=b1f3…&ad_id=123&sig=9c2a…
  # sig is the HMAC over impression_id + ad_id, issued with the ad
→ 302 Found
  Location: https://advertiser.example.com/landing

GET /ads/123/metrics?from=1640000000&to=1640003600&granularity=1m
→ 200 {
  "ad_id": "123",
  "buckets": [
    { "minute": 1640000000, "clicks": 100, "unique_users": 74 },
    { "minute": 1640000060, "clicks":  92, "unique_users": 71 }
  ]
}
```

The ad's link points at `/click`, so a click arrives as an ordinary browser navigation — a GET carrying the signed impression — and the redirect is a **server-side 302** rather than a destination the browser already knows. The server tracks the click first and only then hands back the redirect, so every click on a /click link is tracked before the redirect. A client-side redirect shipped with the ad is simpler but leaky — a savvy user or extension can grab the destination URL and navigate straight there, skipping tracking and quietly corrupting the numbers.

## How the system is built
<!--meta block=architecture-->

The spine is a [command/query split](../patterns/architecture/cqrs.md): the write side ingests and aggregates, the read side answers questions, and the two never share a data model. A **Click Processor** behind a [load balancer](../patterns/distributed/routing/load-balancer.md) verifies the click, dedupes it, and appends it to a durable stream (Kafka or Kinesis) [sharded by `ad_id`](../patterns/distributed/routing/sharding.md). The stream is the shock absorber — it [levels the 10k/sec spikes](../patterns/distributed/resilience/load-leveling.md) and decouples ingest from processing, so a slow aggregator can never stall a click. A **Flink** stream processor reads each shard, folds clicks into per-minute buckets on event time, and upserts the totals into an **online analytical processing (OLAP) store** (Redshift, Snowflake, BigQuery, or a self-managed ClickHouse) whose columnar layout makes `COUNT`/`SUM` over millions of rows fast.

Speed alone is not enough when the numbers get billed on, so the stream also forks into a **Simple Storage Service (S3) raw-event lake**. A periodic Spark job recomputes the same aggregates from those raw events and repairs any drift in the live counts — a fast, approximate speed layer backed by a slow, authoritative batch layer, the **Lambda architecture** in miniature.

```mermaid caption="The write path (verify → dedup → stream → aggregate) carries ~10k clicks/sec; the read path is a single query against pre-computed rollups. The lake + Spark loop is the correctness backstop."
flowchart TB
    Browser["User / browser"]:::ext
    CP["Click Processor: verify, dedup"]
    Stream[("Kafka / Kinesis, sharded by ad_id")]
    Flink["Flink stream processor"]
    OLAP[("OLAP store")]
    Lake[("S3 raw-event lake")]
    Spark["Spark reconciliation"]
    Adv["Advertiser dashboard"]:::ext

    Browser -->|"GET /click (signed id)"| CP
    CP -.->|"302 redirect"| Browser
    CP -->|"append event"| Stream
    Stream -->|"per-shard read"| Flink
    Stream -->|"raw sink"| Lake
    Flink -->|"per-minute upsert"| OLAP
    Lake -->|"recompute aggregates"| Spark
    Spark -->|"correct counts"| OLAP
    Adv -->|"query metrics"| OLAP
    classDef ext stroke-dasharray:4 4;
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Why not just store clicks and count them?

The tempting first cut is one table of raw events and a query on demand:

```sql summary="SQL — the aggregation you cannot afford to run live"
SELECT COUNT(*)               AS clicks,
       COUNT(DISTINCT user_id) AS unique_users
FROM   click_events
WHERE  ad_id = 123
  AND  ts BETWEEN 1640000000 AND 1640000060;
```

At 10k writes/sec the transactional store is already saturated, and a `GROUP BY` scan over millions of rows blows the sub-second budget on every dashboard load. The fix is to aggregate ahead of time and let advertisers read a [materialized view](../patterns/distributed/coordination/materialized-view.md) — the `(ad_id, minute)` rollup — instead of the raw events. A batch job that pre-aggregates every few minutes works, but it always shows data minutes old, and a traffic spike widens the next batch window into cascading staleness. Streaming aggregation dissolves that: Flink windows on event time, so an out-of-order click still lands in the minute it actually happened, and watermarks tell the processor when a window is safe to close. Tightening freshness is then just shrinking the window — far easier than cranking a batch job to run more often.

### 2 · Scaling to 10k clicks per second

Every hop scales out. The Click Processor is stateless and autoscales behind the load balancer. The stream is [partitioned by `ad_id`](../patterns/distributed/routing/sharding.md) so all events for one ad land on one shard and Flink can read shards in parallel — Kinesis, for instance, caps a shard near 1&nbsp;MB/s or 1,000 records/sec, so many shards are mandatory. One Flink job per shard keeps aggregation embarrassingly parallel, and a self-managed OLAP store can be sharded by `advertiser_id` so a single advertiser's data sits on one node. The failure mode is a [hot shard](../hazards/hot-key.md): a viral ad — think a superstar-fronted spot during a final — floods one partition, spiking its latency and risking loss. The mitigation is to salt the partition key for known-popular ads only, found by watching each ad_id's per-shard rate against the 1,000 records/sec cap, appending a random suffix (`ad_id:0..N`) so the load fans across shards; Flink strips the suffix and upserts with a `SUM` so the sub-partitions recombine into one correct total on write.

```mermaid caption="How does a viral ad stop flooding one shard? Known-hot ads get a salted partition key, so the load fans across shards and the SUM upsert recombines it into one total."
flowchart TB
    CP["Click Processor: verify, dedup"]
    S0[("Stream shard ad_id:0")]
    S1[("Stream shard ad_id:1")]
    S2[("Stream shard ad_id:2")]
    Flink["Flink stream processor"]
    OLAP[("OLAP store")]
    CP -->|"append, random suffix 0..N"| S0
    CP -->|"append, random suffix 0..N"| S1
    CP -->|"append, random suffix 0..N"| S2
    S0 -->|"per-shard read"| Flink
    S1 -->|"per-shard read"| Flink
    S2 -->|"per-shard read"| Flink
    Flink -->|"strip suffix, upsert with SUM"| OLAP
```

### 3 · Never losing a click

The stream is the durability layer: Kafka replicates across brokers, Kinesis across availability zones, and a multi-day retention window means a crashed processor replays from where it left off rather than losing data. Flink checkpoints its state to S3 for resume-from-failure, but for minute-sized windows that is often over-engineered — a Flink outage loses at most a minute of aggregates, all recoverable from the retained stream. The real guarantee comes from the batch layer: every raw click is also sinked to S3 (via Kafka Connect or Kinesis Firehose, adding no load to Flink), and a daily Spark job re-aggregates the lake [MapReduce-style](../patterns/distributed/coordination/mapreduce.md) and reconciles it against the live counts, correcting any drift from bad deploys or transient errors. That append-only raw log is the [source of truth](../patterns/architecture/event-sourcing.md) the fast path is measured against. Kinesis keeps records 24 hours by default, so extended retention must be enabled for a multi-day replay.

### 4 · Counting each click exactly once

Idempotency is not deduping by user — logging `user_id` forces every user to be logged in and collapses retargeting to one click per user per ad, forever. The unit that works is the **impression**. The Ad Placement Service generates a fresh id for every render, signs `impression_id + ad_id` with a **hash-based message authentication code (HMAC)** secret, and ships it with the ad; the browser echoes it back on click. The Click Processor verifies the signature (a microsecond hash, not asymmetric crypto) to reject forged ids, then enforces [idempotency](../patterns/messaging/idempotency.md): check the id against a Redis set — a hit means duplicate, drop it; a miss means write to the stream first, then record the id. That ordering is deliberate — if the cache update fails, a click is never lost, only occasionally double-written, and reconciliation catches it. Two concurrent duplicates can also both miss the check and both write, and the recount only removes them if it dedupes on impression_id, so the Spark job must. Dedup has to happen before the stream write, because it cannot span aggregation windows: a duplicate straddling a minute boundary would otherwise land in two buckets. The set is a ~1.6&nbsp;GB Redis Cluster with a replica and persistence enabled.

### 5 · Keeping big-range queries fast

Pre-aggregation already makes the common query — one ad over a recent window — instant. The slow tail is the wide query: a year of a campaign is millions of minute-buckets to sum on read. The answer is more of the same medicine one level up: a nightly job rolls the minute buckets into daily and weekly tables, and a query hits the coarsest table that satisfies its range, drilling down to finer granularity only where needed. It is caching by another name — spend storage on the query shapes advertisers actually run, to buy back read latency. Rollups sum clicks, but unique_users is a distinct count and does not add across buckets, so a rollup table either keeps a mergeable per-bucket sketch for it or reports clicks only.

```mermaid caption="How is each click counted exactly once? Dedup by signed impression id, and write to the stream before recording the id — so a cache failure double-writes (reconciliation fixes it) rather than losing a click."
sequenceDiagram
    autonumber
    participant B as Browser
    participant CP as Click Processor
    participant R as Redis dedup set
    participant S as Stream
    B->>CP: GET /click (impression_id, ad_id, HMAC)
    CP->>CP: verify HMAC signature
    alt forged signature
        CP--xB: reject
    else valid
        CP->>R: is impression_id seen?
        alt duplicate (hit)
            R-->>CP: present
            CP--xS: drop, no write
        else new (miss)
            R-->>CP: absent
            CP->>S: append click event
            CP->>R: record impression_id
        end
    end
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Ingests 10k clicks/sec without loss — the stream absorbs spikes and the counts are pre-computed, so advertisers read in sub-second time.
- Freshness is a dial: shrink the Flink window to seconds without re-plumbing anything, which a batch cadence can't match.
- A batch layer recomputes the numbers from raw events, so any drift in the fast path is caught and repaired.

### What it gives up
<!--meta polarity=con-->

- The same metric is produced by two code paths (speed + batch) that must be kept in agreement — real operational surface.
- Idempotency leans on signed impression ids and a dedup cache; a cache-write gap trades an occasional double-count for never dropping a click.
- Hot ads need deliberate key-salting; the partition scheme is not self-balancing.
- Metrics are eventually consistent — the most recent minute may be partial until its window closes.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — an end-to-end flow (click → track → redirect, then query aggregated metrics), the realisation that metrics must be pre-aggregated rather than counted on read, at least a batch solution, and sensible problem-solving when probed on idempotency or database choice.
- **Senior** — contrasts batch against streaming and justifies real-time aggregation, explains event-time windows and MapReduce at a working level, drives the read/write asymmetry and partitioning, and goes genuinely deep on a couple of areas (scaling, latency, or fault tolerance).
- **Staff+** — weighs batch vs real-time in detail, designs for zero loss with retention, replay, and a reconciliation/Lambda layer, reasons about OLAP and storage choices under load, and handles hot shards and idempotency edge cases from real experience rather than recall.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Hot Partition](../hazards/hot-partition.md) — Falls into it when one ad_id takes most clicks; key-salting spreads it.
- [Hot Key](../hazards/hot-key.md) — A viral ad floods one ad_id partition; mitigated by salting the key for known-hot ads only.

**Demonstrates**

- [CQRS](../patterns/architecture/cqrs.md) — the write path ingests and aggregates clicks while a separate online analytical processing (OLAP) model answers advertiser queries
- [Idempotency](../patterns/messaging/idempotency.md) — a signed impression id checked against a Redis set makes each click count exactly once despite retries and double-taps
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — advertisers read pre-aggregated (ad_id, minute) rollups instead of scanning raw events on demand
- [Sharding](../patterns/distributed/routing/sharding.md) — the click stream is partitioned by ad_id so shards aggregate in parallel, with key-salting for hot ads
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — the Kafka/Kinesis stream buffers 10k/sec spikes so a slow aggregator never stalls a click
- [MapReduce](../patterns/distributed/coordination/mapreduce.md) — a nightly Spark job re-aggregates the raw S3 lake to reconcile and correct the live stream counts
- [Event Sourcing](../patterns/architecture/event-sourcing.md) — the append-only S3 click log is the authoritative record the fast path is measured and corrected against
- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — Click Processors sit behind a load balancer that spreads click traffic before it is verified, deduped and appended to the stream

<!-- relationships:end -->
