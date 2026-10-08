---
title: Metrics & Monitoring
description: "Ingest five million metric points a second, serve dashboards over weeks of history, and fire alerts within a minute"
area: designs-foundational
owner: Oleksandr Derechei
tags: [observability, throughput, latency]
status: stable
aliases: [observability platform, metrics platform]
solves: [half a million machines report stats every few seconds and my ingestion tier falls over under the write flood, my dashboard takes forever to render because every chart rescans weeks of raw data points, one failing cluster tripped a threshold and paged the on-call engineer a hundred times for what was really one incident, every new label my services attach silently multiplies my stored series until storage and memory blow up, a threshold breach is not caught until almost a minute after it happened and I need to know sooner]
---

# Metrics & Monitoring

A metrics platform collects performance signals — CPU, memory, latency, custom counters — from a fleet of servers, stores them as time-series, charts them on dashboards, and pages a human when a threshold is breached. The shape is a firehose of writes on one side and sporadic, expensive reads on the other, so the design is really four sub-problems stacked in order: ingest, store, query, then alert.

## Understanding the problem
<!--meta block=description-->

A monitoring platform, the engine behind Datadog, Prometheus with Grafana or CloudWatch, ingests numeric measurements from services, stores them as time-series, charts them and fires alerts. Writes arrive constantly in huge volume, while reads are bursty and expensive. The page walks through absorbing the write flood cheaply and answering slow questions over long history fast.

## Explained
<!--meta block=explain-->

A metrics platform has an agent on each host batch its points, puts a queue between ingestion and a database built for time-ordered data, and answers dashboards and alert rules as queries over that one store. The queue levels the flood so the database sees a steady rate. Build it only when your volume and retention make a hosted service's per-host bill the larger number; below that, buy it. It costs three things. Cardinality, the number of distinct label combinations, not raw volume, breaks the budget: one label carrying a request id turns one metric into millions of series, so allow only listed label keys per metric and alert on the count of dropped points, or the loss stays silent. A second alert path that judges rules on the stream doubles the code that decides whether to page, so keep it for rules whose window is seconds. Full-resolution history is the quiet expense, so decide how long to keep each resolution before storage forces you to delete.

**Example.** 500,000 servers each send 100 measurements every 10 seconds: 500,000 x 100 / 10 = 5 million points a second, at 200 bytes about 1 GB a second, 86 TB a day. A 30-day chart of one series would scan 30 x 86,400 / 10 = 259,200 raw points, but 30 daily rollups. A metric with labels for 1,000 hosts, 5 regions, 200 endpoints, 10 statuses and 5 methods can reach 50 million series, so ingestion strips unlisted labels and counts what it drops.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Ingest metrics — CPU, memory, latency, custom counters — emitted by services across the fleet.
2. Query and visualise those metrics on dashboards, with filters, aggregations, and arbitrary time ranges.
3. Define alert rules as a threshold over a window, e.g. p99 latency > 500&nbsp;ms for 5 minutes.
4. Deliver notifications when a rule fires — Slack, PagerDuty, email.

Out of scope: log aggregation and full-text search, span/trace collection, and ML-based anomaly detection.

### Non-functional
<!--meta requirement=nfr-->

- **Write scale** — sustain ~5M metric points/second from ~500k servers.
- **Query latency** — dashboard queries return in seconds, even spanning days or weeks.
- **Alert latency** — under a minute from emission to a rule firing.
- **Availability > consistency** — dashboards may be eventually consistent; alert evaluation must stay reliable, and late/out-of-order data is expected.

## Right-sizing
<!--meta block=sizing-->

**Writes.** 500k servers, each reporting ~100 distinct measurements every 10&nbsp;seconds, is 500k × 100 ÷ 10 = **5M points/second** at peak. This is the number the whole architecture has to survive, and it never sleeps.

**Volume.** A point — timestamp, value, and its labels — is ~100–200 bytes on the wire, so raw ingestion runs near **1&nbsp;GB/second**, roughly **86&nbsp;TB/day** before compression. A time-series store leans hard on delta and columnar compression to knock that down by an order of magnitude, and rollups plus retention keep old data from accumulating at full resolution.

**Reads.** Dashboard traffic is a rounding error next to writes on average, but it spikes hard during an incident and a single panel can ask to scan billions of points. The alert path is steadier: rules × evaluation interval, a few thousand scheduled queries a minute.

## Core entities
<!--meta block=entities-->

Three data concepts drive everything, and getting the relationship between them right is the whole game:

- **Metric** — a named measurement, e.g. `cpu_usage`.
- **Label** — a key-value tag attached to a metric for slicing, e.g. `host="web-42"`, `region="us-east"`.
- **Series** — one unique combination of metric name + labels, tracked over time. `cpu_usage{host="web-42"}` is one series; `cpu_usage{host="web-43"}` is another. **Series count is the central scaling variable**: 500k hosts reporting one metric is already 500k series, and every additional distinguishing label multiplies it — the cardinality problem, which sets both what the platform costs to store and how fast it can aggregate.
- **Alert Rule** — a saved query, a threshold, and a duration ("average CPU in us-east above 90% for 5 minutes"), plus where to notify.
- **Dashboard** — a collection of panels, each a saved query rendered as a chart; not modelled in depth, but it sets the read-query volume.

## The interface
<!--meta block=interface-->

Three surfaces with very different traffic shapes: a high-volume batched write, an expensive read, and a low-frequency rule registration whose rows are then evaluated constantly. JSON is shown for readability; at 5M/s a real deployment ships a binary format like protobuf.

```http summary="HTTP — ingest, query, and alert rules"
POST /metrics/ingest            # batched, continuous, ~5M points/s
{ "metrics": [
    { "name": "cpu_usage",
      "labels": { "host": "web-42", "region": "us-east" },
      "value": 0.73, "ts": 1737331200 } ] }
→ 202 Accepted

GET /metrics/query?q=avg(cpu_usage{region="us-east"})&start=A&end=B&step=60
→ 200 { "timestamps": [...], "values": [...] }   # PromQL-style DSL

POST /alerts/rules              # written rarely, evaluated every minute
{ "name": "High CPU — us-east",
  "query": "avg(cpu_usage{region='us-east'}) > 0.9",
  "for": "5m",
  "notify": ["slack:#oncall", "pagerduty:team-infra"] }
→ 201 Created
```

## How the system is built
<!--meta block=architecture-->

**Write path.** Having every server POST straight into an ingestion service that writes straight to a database collapses at this volume, and simply adding ingestion instances only moves the flood downstream. So the fix works the edge and the middle: an **agent** on each host [batches](../patterns/concurrency/batching.md) and pre-aggregates points locally before shipping them, and a [message queue](../patterns/messaging/message-queue.md) (Kafka) sits between ingestion and storage. The queue decouples the two and does [load leveling](../patterns/distributed/resilience/load-leveling.md) — a burst is absorbed into the log so the store sees a steady, survivable rate instead of the raw spike.

**Store and read.** The store is a purpose-built **time-series database**, a specialised engine fits here because its [LSM-tree](../patterns/distributed/coordination/lsm-tree.md) backbone turns the incoming firehose into sequential appends, exactly what a Postgres row-per-point layout can't sustain. In front of it, a separate **query service** translates the PromQL-style DSL (domain-specific language) into storage scans. Splitting the read path from the write path is deliberate [command-query separation](../patterns/architecture/cqrs.md): writes are constant and should rarely drop, and every drop is counted (`dropped_metrics`), reads are sporadic and expensive, so each scales and tunes independently — and a cache can be bolted onto the query side without touching ingestion.

**Alert and notify.** Alerts are built on top of queries, not as a separate engine — the sub-minute budget allows it. Rules live in Postgres; an **alert evaluator** pulls them on a fixed interval and runs each as a scheduled query against the store (as Prometheus rule evaluation does: rules run as scheduled queries; the Alertmanager role is the notification service's grouping and dedup). On breach it emits an event to a **notification service**, which is what stands between a breach and a human: it tracks each alert as firing or resolved and pages only on state transitions, and it [aggregates](../patterns/messaging/aggregator.md) breaches arriving in a short window by label so a hundred servers tripping one threshold become one page, not a hundred.

```mermaid caption="The write path (agent → queue → time-series store) is a steady firehose; the read path forks off it, and alerting rides the same store the dashboards query."
flowchart TB
    Agents["Server agents: batch and pre-aggregate"]
    Ingest["Ingestion: validate and cap cardinality"]
    Kafka[["Kafka buffer"]]
    TSDB[("Time-series database")]
    Query["Query service: dashboards, cache and rollups"]
    Eval["Alert evaluator: scheduled queries"]
    Notify["Notification service: group and dedup"]
    Channels["Slack, PagerDuty, email"]:::ext

    Agents -->|"batched points"| Ingest
    Ingest -->|"publish"| Kafka
    Kafka -->|"consume and write"| TSDB
    Query -->|"PromQL scan and rollups"| TSDB
    Eval -->|"scheduled query"| TSDB
    Eval -->|"breach event"| Notify
    Notify -->|"one page per group"| Channels
    classDef ext stroke-dasharray:4 4;
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Fast dashboards over weeks of data

"CPU for every production pod over the last 30 days" can touch billions of points; scanning full-resolution data on each request is hopeless. Two instincts apply — pre-compute, and cache.

- **Pre-computed rollups.** Maintain the metric as a [materialized view](../patterns/distributed/coordination/materialized-view.md) at several granularities — 1-minute, 1-hour, 1-day buckets. A month-long chart reads about 30 daily buckets per series instead of 259,200 raw points at a 10-second interval, and the query planner picks the coarsest resolution the requested `step` allows. Roll up histogram buckets or mergeable sketches, not precomputed percentiles, so p99 over a coarse bucket stays correct.
- **Cache plus query splitting.** Put a [cache-aside](../patterns/caching/cache-aside.md) layer in front of the query service and split each request along the time axis, so overlapping and repeated windows (everyone reloads the same "last 6 hours" panel) are served from cache and only the uncached tail hits storage. Rollups shrink the work; the cache removes the repeated work entirely.

### 2 · Driving alert latency below a minute

Polling every minute meets the requirement for most rules only while poll interval plus ingest lag plus query time stays under 60 seconds; a breach one second after a cycle waits ~59 seconds before the next look, and a few critical services want faster. Increasing the poll frequency is an incremental patch — it never removes the round trip. The real move is **stream processing**: evaluate the condition directly on the Kafka stream (kafka → stream → alert) instead of round-tripping through the database (kafka → db → alert), reacting to data in flight. It adds complexity, so keep it a minority path — most alerts stay on the cheap polling loop, and only the few that need seconds go real-time. Evaluating a daily-grained metric in real time is overkill.

```mermaid caption="Why does evaluating alerts on the stream beat polling the database?"
flowchart LR
    subgraph Poll["Polling path - most alerts, up to ~59 s late"]
        K1[("Kafka")] --> DB[("Database")]
        DB -->|"rule polled every minute"| A1["Alert"]
    end
    subgraph Stream["Stream path - few critical rules, seconds"]
        K2[("Kafka")] -->|"data in flight"| SP["Stream processing"]
        SP -->|"condition breached"| A2["Alert"]
    end
```

### 3 · Staying up exactly when it matters

A monitoring system that dies during an incident blinds you at the worst possible moment, so availability matters more here than almost anywhere. Both paths need redundancy: the ingest/data path so collection survives node loss, and the alert/notify path so breaches are still detected and delivered. The durable queue already double-buffers ingestion through transient failures. The recurring post-mortem trap is **meta-monitoring**: never run the monitoring system on the very infrastructure it watches, or it goes dark alongside the outage it should be reporting.

### 4 · Taming cardinality explosion

Every distinct metric-plus-label combination is a new series, and combinations multiply fast: `http_requests{host, region, endpoint, status, method}` across 1,000 hosts × 5 regions × 200 endpoints × 10 statuses × 5 methods is up to 50M series in theory. Each series costs index, metadata, and memory on the write side, and aggregating across millions of them is slow on the read side. The fix is an admission step wedged into the ingestion service, between validation and the queue, backed by two stores: a **policy store** (Postgres) mapping each metric to its allowed label keys and a maximum series count, and a fast **series tracker** (Redis) counting the unique series seen per metric. Ingestion strips non-allowlisted labels, hashes the rest into a series id, and checks whether that series is known and under cap — accepting and publishing if so, dropping and bumping a `dropped_metrics` counter if not. That counter becomes a first-class monitored signal (more monitoring of the monitor), and hitting a cap fires an alert through the existing notification path. A membership check per point at 5M/s is itself a cost, so a local [Bloom filter](../patterns/distributed/coordination/bloom-filter.md) fronts Redis as a cheap first pass: only combinations the filter says might be new pay for a round trip.

```mermaid caption="How the ingestion admission step accepts or drops each point to bound cardinality."
flowchart TB
    Point["Incoming point: metric + labels"]
    Ingest["Ingestion admission"]
    Policy[("Policy store: allowed keys, max series")]
    Bloom["Local Bloom filter"]
    Redis[("Series tracker: unique series per metric")]
    Queue[["Kafka buffer"]]
    Drop["Drop and bump dropped_metrics"]
    Notify["Notification service"]

    Point -->|"strip non-allowlisted labels, hash to series id"| Ingest
    Ingest -->|"read allowed keys, cap"| Policy
    Ingest -->|"seen this series?"| Bloom
    Bloom -->|"probably seen — skip the round trip"| Queue
    Bloom -->|"definitely new"| Redis
    Redis -->|"register it — still under cap"| Queue
    Redis -->|"registering it would breach the cap"| Drop
    Drop -->|"cap breached"| Notify
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Agent batching plus a buffering queue absorb 5M-point/second bursts, so the store only ever sees a steady, survivable write rate.
- Read and write paths scale independently — a query storm during an incident can't stall ingestion, though alert queries share the read store with dashboards, and a cache slots onto the read side alone.
- Alerts are just scheduled queries over the same store the dashboards use — one mental model, easy to debug — with grouping and dedup keeping a big incident to one page.

### What it gives up
<!--meta polarity=con-->

- Buffering is double-edged: a multi-minute outage leaves a backlog that only drains if you run with spare headroom — for monitoring it's often better to drop data than fall permanently behind.
- Cardinality caps silently drop real data when mis-tuned; per-metric policies assume you actually understand each metric's usage.
- Default alerting is near-minute; true sub-second detection needs a second, more complex path that judges each rule on the data in flight.
- Dashboards are only eventually consistent, so a panel can lag the newest points.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — lays out the end-to-end flow (ingest → store → query → alert), reaches for a queue and some form of time-series storage, and has at least a naive "poll the database" answer for alerts. Should explain, when asked, why Kafka helps and why a TSDB beats Postgres here; may not raise cardinality unprompted.
- **Senior** — drives the write/read split, treats cardinality as a first-class problem and proposes controls, argues stream-vs-poll for alert latency, and brings rollups and retention for query speed — clear thinking on two or three core challenges.
- **Staff+** — goes deep on operations: meta-monitoring, [backpressure](../patterns/concurrency/backpressure.md) and the drop-versus-catch-up policy, alert fatigue, and multi-tenant isolation. Holds experience-backed opinions on pull-versus-push collection and on histogram/percentile aggregation, and shows judgment about what to optimise now versus defer.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Observability](../themes/observability.md) — The case study's metrics are one of the three records this theme joins.

**Exposed to**

- [Metastable Failure](../hazards/metastable-failure.md) — A queue backlog after an outage keeps ingestion behind unless spare headroom or dropping is policy.

**Demonstrates**

- [Message Queue](../patterns/messaging/message-queue.md) — Kafka sits between the ingestion service and the store, decoupling them so a spike is buffered rather than dropped
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — the queue smooths a bursty 5M-point/second firehose into a steady rate the write-limited store can sustain
- [Batching](../patterns/concurrency/batching.md) — host agents batch and pre-aggregate points locally before shipping, and the ingest application programming interface (API) itself is batched
- [CQRS](../patterns/architecture/cqrs.md) — the read (query) path is split from the write (ingest) path so each scales, tunes, and caches independently
- [LSM Tree](../patterns/distributed/coordination/lsm-tree.md) — the time-series store's log-structured backbone turns the incoming firehose into cheap sequential appends
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — metrics are pre-aggregated into multi-resolution rollups so a month-long chart reads buckets, not billions of raw samples
- [Cache-Aside](../patterns/caching/cache-aside.md) — a cache in front of the query service serves repeated dashboard windows without re-scanning storage
- [Aggregator](../patterns/messaging/aggregator.md) — the notification service collects breaches arriving in a short window and groups them by label into a single page
- [Bloom Filter](../patterns/distributed/coordination/bloom-filter.md) — a local Bloom filter fronts the Redis series tracker so only possibly-new series pay for a round trip
- [Backpressure](../patterns/concurrency/backpressure.md) — A multi-minute backlog forces a drop-versus-catch-up choice; the queue only drains with spare headroom, so monitoring prefers dropping.

<!-- relationships:end -->
