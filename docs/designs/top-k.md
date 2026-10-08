---
title: Top-K
description: "Rank the exact top K most-viewed items over rolling windows, from a firehose of billions of events, in tens of milliseconds"
area: designs-foundational
owner: Oleksandr Derechei
tags: [partitioning, batching, read-optimization]
status: stable
aliases: [top K, leaderboard, most-viewed ranking, heavy hitters]
solves: [my most-viewed ranking query scans billions of rows and takes minutes to return, "recomputing the top items for the last hour, day and month on every request is far too slow", a firehose of events is overwhelming my single database with writes, I need exact counts across billions of distinct keys and a plain hash table will not fit in memory, thousands of identical ranking requests hit my database at once and blow the latency budget]
---

# Top-K

A top-K service answers one question — which items are most popular right now — over a stream too large to count naively. Framed here as YouTube video views, it is the meeting point of two hard problems: a firehose of writes to absorb and a ranking query that must return in tens of milliseconds. Almost every good decision is a way to not compute the answer at request time.

## Understanding the problem
<!--meta block=description-->

A service returns the K most-viewed videos for the last hour, day, month and all time from a stream of view events, roughly 70 billion a day. The write path must absorb that rate while queries answer in tens of milliseconds, so the page walks through what to precompute and when.

## Explained
<!--meta block=explain-->

A top-K service keeps a running view count per video for each time window and refreshes each window's ranking into a cache ahead of time, so a query reads a ready list in tens of milliseconds. Writes are the first problem: 700,000 views a second is 70 times what one database node takes. Group the stream by video id, add up each video's views in memory for a short window, and write once per batch to a store split by video id. Choose clock-aligned windows over sliding ones: a one-minute slide over a month multiplies stored state about 43,000 times, so slide only the last hour and let day and month jump on the clock.

- **Sliding windows.** Decrementing needs a second reader trailing the log by one window length, so slide only where users need it.
- **Approximation.** A frequency sketch shrinks gigabytes to megabytes but is inexact and holds no video ids, so pair it with a ranked list.
- **Distinct keys.** Billions of videos make ranking expensive, so keep a ranked list per shard.

**Example.** 70 billion views a day over about 100,000 seconds is 700,000 a second. One node takes about 10,000, so unbatched you need about 70 shards. Videos are skewed, so in-memory batching collapses many increments for hot videos into one write, and 5 to 10 shards are enough. Each shard returns its own top 1,000, and the service merges them, which is exact because a global top video is in the top of its own shard. A month sums 24 x 30 = 720 hourly rows per video, so you keep a running total per window instead.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Query the top K most-viewed videos for all time, up to a cap of K&nbsp;=&nbsp;1,000.
2. Query the top K over tumbling windows of one hour, one day, and one month — each window aligned to a clock boundary, always looking back from now.

Out of scope: arbitrary time periods (querying June 2024 from October 2025) and arbitrary start/end points. Every query looks back from the present moment, which is what makes precomputation possible. Beyond K&nbsp;=&nbsp;1,000 a client really wants the whole dataset — a different system's job. Tumbling windows (fixed clock-aligned buckets) are chosen over sliding windows because they are far cheaper to maintain; a sliding-window variant is explored later.

### Non-functional
<!--meta requirement=nfr-->

- **Exactness** — results must be precise, not approximate. Approximation is held back as an optional optimisation once the interviewer allows it.
- **Freshness** — a view may take up to one minute to be reflected in the ranking. That budget is what unlocks caching and batch aggregation.
- **Latency** — responses in the tens of milliseconds, which effectively mandates precomputed, cached answers.
- **Scale** — a massive and sustained view rate across billions of distinct videos.

## Right-sizing
<!--meta block=sizing-->

**Writes.** 70B views/day over ~100k seconds/day ≈ **700k writes/sec**. A well-tuned relational node manages roughly 10k writes/sec, so the raw event rate is about 70× a single node — the number the whole write path has to defeat.

**Cardinality.** Roughly one hour of content is uploaded every second; at ~6 minutes per video that is ~1M new videos/day, and over ten years about **3.6B videos**. This high cardinality — billions of distinct keys — is the real difficulty, more than the raw view rate.

**Storage.** One flat table of ID + count is ~4B × (8&nbsp;B id + 8&nbsp;B count) ≈ **64&nbsp;GB** — small enough to hold, but the cost is in ranking across all of it repeatedly, not in storing it.

**Reads.** The exact query rate is left open, but it is large and every request must land in the tens-of-ms budget — which means the answer has to already exist in a cache before the request arrives.

**Windows.** Each of the four window tables is at most the ~64 GB above, about 256 GB if every video were active. The hour, day and month tables hold only videos viewed in their window, so far less. The cache holds 1,000 rows per window, about 4 × 1,000 × 16 B = 64 KB.

## Core entities
<!--meta block=entities-->

Three entities, plus the computed tables that carry the real weight:

- **Video** — the thing being viewed, identified by a `videoId`.
- **View** — a single view event arriving on the stream; the atom being counted.
- **Time Window** — the look-back a query names: `all-time`, `last-hour`, `last-day`, `last-month`.
- **Window aggregate — computed.** A running `(videoId, views)` total per window, indexed on `views`. These are not source data; they are the precomputed rollups every fast query reads from.

## The interface
<!--meta block=interface-->

One read endpoint — there is no write API here, because the view stream is produced by an existing system upstream:

```http summary="HTTP — query a window"
GET /views/top-k?window={WINDOW}&k={K}
    WINDOW ∈ { all-time, last-hour, last-day, last-month }
    K ≤ 1000
→ 200 [ { "videoId": "abc123", "views": 918273 },
          { "videoId": "def456", "views": 872011 }, ... ]
```

No pagination: the result is capped at 1,000 rows and the client already states the K it wants, so there is nothing to page through.

## How the system is built
<!--meta block=architecture-->

Start from the simplest thing that answers the all-time query, then let each requirement bend it. A view consumer reads events from a Kafka `ViewEvent` topic (partitioned by video ID) and increments a per-video counter in a store; a **Top-K service** behind a [load balancer](../patterns/distributed/routing/load-balancer.md) answers reads. With an index on the `views` column, `ORDER BY views DESC LIMIT k` is an O(k) walk down a sorted list. Windows add a timestamp dimension: keep a separate running aggregate per window so every query stays the same cheap index walk. The event rate makes a single writer impossible, so a stream processor (Flink) sits between Kafka and the store, batching and aggregating views before they land, and the store is sharded by video ID. Finally, because even the fast query cannot meet the SLA (service-level agreement) under load, a precompute job keeps the answer for each window sitting in a cache, and the Top-K service only ever reads cache.

```mermaid caption="Writes are absorbed by Flink and fan into sharded window tables; a precompute job keeps each window's answer warm in cache, so the read path never touches the store."
flowchart TB
    Kafka[("Kafka ViewEvent stream — partitioned by videoId")]
    Flink["Flink — batch & window-aggregate views"]
    Store[("Sharded window-aggregate store — indexed on views")]
    Precompute["Precompute job — top K per window"]
    Cache[("Redis — precomputed top K per window")]
    TopK["Top-K service"]
    LB["Load balancer"]
    Client["Client"]
    Kafka -->|"view events"| Flink
    Flink -->|"bulk hourly writes"| Store
    Precompute -->|"scatter query each shard, merge local top-K"| Store
    Precompute -->|"warm ahead of expiry"| Cache
    Client -->|"GET /views/top-k"| LB
    LB -->|"route read"| TopK
    TopK -->|"read only"| Cache
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Getting the ranking out of the request path

Running the windowed query on every request would melt the store — millions of identical queries competing for the same expensive scan. The one-minute freshness budget is the opening: the answer barely changes second to second, so compute it rarely and reuse it. A [cache-aside](../patterns/caching/cache-aside.md) layer (Redis) keyed by `top-k:{window}:{truncated_timestamp}` turns almost all traffic into sub-millisecond hits. The weakness is the moment an entry expires: a flood of requests all miss at once and pile onto the store, every one of them blowing the SLA — a classic [cache stampede](../hazards/cache-stampede.md). [Request coalescing](../patterns/distributed/resilience/request-coalescing.md) (one in-flight recompute per window, the rest waiting on its result) limits the pile-up but not the latency spike. The fix is to stop letting entries expire cold: a precompute job runs on a fixed cadence and [refreshes each window ahead of time](../patterns/caching/refresh-ahead.md), so the cache is always warm and the Top-K service becomes a pure cache reader. Keep entries alive for a couple of hours so a late precompute serves slightly stale data rather than nothing.

The precompute job keeps the cache warm so the read path never waits on the store:

```mermaid caption="How does refresh-ahead keep every window warm so no request ever meets a cold cache?"
sequenceDiagram
    autonumber
    participant J as Precompute job
    participant S as Window tables
    participant C as Redis cache
    participant T as Top-K service
    participant Cl as Client
    loop fixed cadence, before entries expire
        J->>S: query each window's top-K
        J->>C: write top-k:{window}:{truncated_timestamp} (kept a couple of hours)
    end
    Cl->>T: request top-K
    T->>C: read entry
    C-->>T: warm hit
    T-->>Cl: top-K list
```

### 2 · Absorbing the write firehose

700k writes/sec is roughly 70× a single node, and view volume is wildly skewed — a handful of videos take a huge share of traffic, so those keys become [hot keys](../hazards/hot-key.md) that no single writer can keep up with. Two moves compound. First, [shard](../patterns/distributed/routing/sharding.md) the ingest and the store on video ID; Kafka is already partitioned that way, so each consumer set owns a partition and writes only its own shard. Second, and more powerful, [batch](../patterns/concurrency/batching.md) the writes: Flink aggregates views per video over a tumbling window and flushes one bulk write instead of thousands of increments. Because the skew is exactly where batching helps most, the collapse is large — often several times fewer writes (here about 7–14×) — and shard count drops from ~70 to a realistic 5–10. Flink's checkpointing (with a bounded-out-of-orderness watermark tolerating ~30s of late events, inside the one-minute budget) means a lost node costs no views. A failed node rewinds to the last Kafka offset and replays, so no views are lost, and the idempotent bulk write keeps them from being counted twice. Sharding does break the single-query read — the global top-K now lives across shards — but a [Scatter-Gather](../patterns/messaging/scatter-gather.md) fixes it: query each shard for its local top-K and merge. It is exact, because a video in the true global top-K must be in the top-K of whatever shard holds it.

### 3 · Making the windowed query cheap

A month-scale query that sums 24×30 = 720 hourly rows per video, across billions of videos, degrades into a scan of up to 720 rows per video, tens of TB if every video is active (720 × 64 GB ≈ 46 TB) — minutes, not milliseconds. Throwing Spark at it parallelises the pain without removing it. The structural fix is to never aggregate on demand: maintain a [materialized](../patterns/distributed/coordination/materialized-view.md) running total per named window — `VideoViewsLastHour`, `VideoViewsLastDay`, `VideoViewsLastMonth` — each indexed on `views`, so every window reuses the same O(k) index walk as the all-time table. Flink still aggregates at hour grain; as each window completes it updates the per-window tables. This trades read cost for write cost — now writing to four tables instead of one — which is the right trade when reads vastly outnumber writes. (Coarser rollups, e.g. daily aggregates feeding the monthly view, avoid re-scanning hourly rows.) The same shape appears in off-the-shelf engines: TimescaleDB's continuous aggregates and the roll-up tables of real-time OLAP (online analytical processing) stores (Druid, Pinot, ClickHouse) are the built-in version of these hand-maintained window tables — useful, but caching and sharding are still required on top.

### 4 · Sliding windows, if the product demands them

A tumbling "last hour" jumps on the clock boundary; a true sliding window advances every minute. Maintaining one means, each minute, incrementing the running total by the newest minute's views and decrementing it by the views from exactly one window-length ago — the minute now leaving the window. That adds a read (to find the expiring count) to what was an insert-only path, and forces minute-grained data to be retained for a full month so it can be subtracted when it exits "last month". The elegant alternative is a second, lagged Kafka consumer group: one group increments as events arrive, a group trailing by the window length decrements them as they expire, leaning on Kafka's own retention instead of a separate minute-grained store. The lagged group needs the raw log kept for the full window length: about 2.5B events for last hour (700k/s × 3,600 s), but about 2.1T for last month (70B/day × 30). That is why only last hour slides. Native Flink sliding windows are rejected outright — a one-minute slide over a month multiplies state by 60×24×30 ≈ 43,000×. The pragmatic answer is to slide only "last hour" (which changes fast and matters) and keep "last day" and "last month" tumbling (they barely move).

### 5 · Trading exactness for memory with approximation

If the interviewer relaxes exactness, the gaps between top videos are usually thousands of views — the ranking is about direction, not a precise tally — which opens the door to a [Count-Min Sketch](../patterns/distributed/coordination/count-min-sketch.md). It estimates per-item frequencies in a fixed 2D counter array via several hash functions, using hundreds of MB where an exact hash table would need about 64 GB (the all-time table in the sizing block). The catch is that the sketch stores frequencies, not identities: it can answer "how many times has X been seen?" but cannot list its own top items. So it is paired with a sorted set — on each view, increment the sketch, read back the estimate, and upsert that item into a per-window sorted set trimmed to 1,000. Redis does this natively (`CMS.INCRBY` → `CMS.QUERY` → `ZADD`), skipping the `ZADD` for items already below the top-1,000 floor; the risk is a durability gap between updating the sketch and the sorted set. Keeping both structures inside Flink's checkpointed state removes that gap and, uniquely, supports the decrement a sliding window needs — Redis exposes no `CMS.DECRBY`.

```mermaid caption="How does a Count-Min Sketch produce a top-K list when it stores only frequencies, not the item identities?"
flowchart LR
    View["view event"] -->|"CMS.INCRBY item"| Sketch[("Count-Min Sketch — frequency estimates")]
    Sketch -->|"CMS.QUERY estimated count"| Gate{"above top-1,000 floor?"}
    Gate -->|"yes: ZADD"| ZSet[("Per-window sorted set — trimmed to 1,000")]
    Gate -->|"no: skip ZADD"| Drop["dropped from ranking"]
    ZSet -->|"read top-K"| Out["top-K answer"]
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Every query is a warm-cache read of a precomputed answer, so the tens-of-ms SLA holds regardless of query volume.
- Batching plus sharding cuts a 70× write overload to 5–10 shards, and Flink checkpoints with an idempotent bulk write keyed by video and window give exactly-once counts after a replay.
- Per-window materialized tables keep every window at the same cheap O(k) index walk, and Scatter-Gather merges shards without losing exactness.

### What it gives up
<!--meta polarity=con-->

- Answers lag reality by up to a minute, and the precompute job is a new operational surface: if it runs late the cache keeps serving older answers until entries expire, up to a couple of hours, so alert on cache entry age per window.
- Maintaining a table per window shifts cost onto writes — four writes where there was one — and every extra rollup adds pipeline stages and latency.
- True sliding windows are expensive enough that only "last hour" gets one; the approximation path buys memory by giving up exactness and clean durability.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end design: a consumer counting views, an indexed `ORDER BY views LIMIT k`, per-window tables, and the insight that the one-minute budget lets caching carry the read load. Rough edges and a non-optimal write path are fine.
- **Senior** — reasons about the stream fluently: names the write firehose and resolves it with sharding plus batching, precomputes windows instead of aggregating on demand, and argues the read/write cost shift of per-window tables with clear trade-offs.
- **Staff+** — frames precomputation and caching as the core primitives from the outset, identifies high cardinality (not raw rate) as the real problem, and moves quickly to the genuinely hard parts — sliding-window schemes, Count-Min Sketch, and where a specialized OLAP or time-series engine does or doesn't earn its place.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Trie](../patterns/distributed/coordination/trie.md) — The top-K most frequent items can feed the ranked suggestion lists of a prefix tree

**Exposed to**

- [Cache Stampede](../hazards/cache-stampede.md) — When a window's cached ranking expires, every request falls through to the store at once; a precompute job refreshes it ahead of expiry.
- [Hot Key](../hazards/hot-key.md) — A few viral videos take most views, so the writer that owns their counters cannot keep up; batching in the stream job absorbs them.

**Demonstrates**

- [Cache-Aside](../patterns/caching/cache-aside.md) — Redis fronts the store keyed by window and timestamp, so nearly all reads are sub-millisecond memory hits and only misses recompute
- [Refresh-Ahead](../patterns/caching/refresh-ahead.md) — a precompute job warms each window's answer before its cache entry expires, turning the Top-K service into a pure cache reader
- [Batching](../patterns/concurrency/batching.md) — Flink aggregates views per video over a tumbling window and flushes one bulk write instead of thousands of per-event increments
- [Sharding](../patterns/distributed/routing/sharding.md) — ingest consumers and the aggregate store are partitioned by video ID along Kafka's existing partition boundary
- [Scatter-Gather](../patterns/messaging/scatter-gather.md) — once the store is sharded, the global top-K is rebuilt by querying each shard's local top-K and merging the partials
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — a running per-window total is maintained and indexed on views, so every windowed query is the same O(k) index walk rather than an on-demand scan
- [Count-Min Sketch](../patterns/distributed/coordination/count-min-sketch.md) — the optional approximate path estimates per-video frequencies in a fixed 2D counter array, paired with a trimmed sorted set to produce the ranking
- [Sliding Window](../patterns/distributed/coordination/sliding-window.md) — the ranking turns on sliding the fast window while leaving the slower ones tumbling

<!-- relationships:end -->
