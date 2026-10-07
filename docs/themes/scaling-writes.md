---
title: Scaling Writes
description: "Escalating write capacity past a single primary with partitioning, queues, and batching"
area: themes-scale
owner: Oleksandr Derechei
tags: [scalability, throughput]
status: stable
aliases: [write scaling]
---

# Scaling Writes

The write-path scaling ladder — climb from a single primary through a write-optimized engine and sharded partitions, then burst-absorbing queues and load shedding, up to batching and hierarchical aggregation. Every rung spreads, smooths, or coalesces the write stream so no single component has to sustain the whole of it.

## The question
<!--meta block=description-->

Scaling writes is the harder half of scaling. Reads lean on serving many copies of data that rarely changes; every write must land somewhere durable and ordered, often under contention, and copying it more does not make it faster. So the ladder reduces the write rate each component must sustain: one server first, then shards, then a queue that absorbs bursts and sheds the unimportant, then batching and aggregation. Scaling Reads climbs a different ladder.

## Explained
<!--meta block=explain-->

Scaling writes means lowering the writes per second that any one component must sustain, and it is the harder half because you cannot make a write faster by copying it. Climb in order. First do the arithmetic to confirm a real limit exists. Then pick a store whose engine suits writes. Then partition by key, so each shard owns part of the stream, using an id such as the user or post that spreads evenly. A weak key, such as a country, leaves one shard busy and another idle. Then absorb bursts with a queue and batch small writes into fewer big ones. A queue buys burst tolerance by confirming the write was accepted, not yet applied, so readers see old data for a while, and a backlog grows without bound if input outruns draining. Growing from 8 shards to 16 without downtime means writing to both places during the move. A single viral key can exceed any shard, and for counts you split it across sub-keys and sum on read.

**Example.** One primary handles 5,000 writes a second. Traffic averages 3,000 and peaks at 12,000 for 10 minutes. A queue accepts the peak: the backlog grows by 7,000 a second for 600 s, 4.2 million writes, then drains at 2,000 a second net, 2,100 s, 35 minutes. Readers see old data for that time. Three shards instead take 4,000 each at peak and need no queue, but you must choose a key that spreads writes evenly and accept that a query across shards asks all three.

## The tradespace
<!--meta block=tradespace-->

The trade at the bottom of the ladder is where the write becomes durable against how fast it is acknowledged. A write-optimized engine (log-structured, time-series, column store) buys throughput by appending sequentially and pays it back in read amplification and in compaction, which rewrites data and can stall writes if it falls behind; a queue buys burst tolerance by acknowledging that the write was accepted, not yet applied to the store, and pays it back in eventual consistency and the risk of an unbounded backlog if inflow outpaces drain. Both move the cost somewhere the requirements must tolerate. The key you insert under is a write cost too: a random primary key sends each insert to a different page and slows the table as it grows, while a time-ordered id from [Unique ID Generation](../patterns/distributed/coordination/unique-id-generation.md) keeps inserts at the tail of the index. Check with quick math that a real wall exists before reaching for any of this; inventing one is the worst outcome. The [Metrics & Monitoring](../designs/metrics-monitoring.md) case study sizes this at five million points a second.

Partitioning's central trade is the key. A good partition key minimizes per-shard variance by hashing a primary identifier such as a user or post id; a bad one — raw country, say — concentrates load on one shard while another idles, or forces every read to fan out across all of them. And partitions are not static: going from eight shards to sixteen without downtime is its own problem, solved in production by **dual-write migration** — write to both old and new locations during the move, prefer the new shard on reads, and cut over once caught up, trading a window of double writes for continuous availability. The [Facebook Post Search](../designs/fb-post-search.md) case study absorbs a write-heavy firehose, and [Strava](../designs/strava.md) moves the write load onto the client with a batched sync.

Even perfect key distribution breaks on a **[hot partition](../hazards/hot-partition.md)** caused by one hot key: a viral post taking 100,000 likes/sec that no single shard can hold (the cache-side twin is [hot key](../hazards/hot-key.md)). The fixes only work for aggregable metrics (likes, views, counts): split the counter across k sub-keys and sum on read, either statically for every key or dynamically once a key is detected hot. The catch is reader–writer agreement: if writers split but readers don't check every sub-key, the count is wrong; most systems keep it simple by having readers always sum all sub-keys, accepting read amplification (extra reads per lookup) in exchange for correctness. Data that must stay atomic, like a profile, can't be split this way — but such data rarely sees this kind of write pressure.

```mermaid caption="The write-path ladder: exhaust single-server options first, partition the write stream next, then smooth bursts and coalesce — each rung lowering the throughput any one component must sustain."
flowchart TB
    Q["Writes outgrowing one primary"]
    Q -->|"first rung"| A["Bigger box + write-optimized engine"]
    A -->|"still saturated"| B["Shard writes by key; split columns by access pattern"]
    B -->|"bursty inflow"| C["Absorb bursts in a queue; shed low-value writes"]
    C -->|"many tiny writes"| D["Batch small writes; aggregate hierarchically"]
```

## The tour
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Sharding](../patterns/distributed/routing/sharding.md) {#tour-sharding}

The default move once one primary, even on a write-optimized engine, cannot keep up. Sharding partitions the data across nodes by key, so if one server sustains 1,000 writes/sec, ten shards approach 10,000 — the multi-node fleet hidden behind one logical database. Everything rides on the partition key: hash a primary identifier and load spreads evenly; pick something skewed like raw country and one shard melts while another idles. Weigh reads too — the write path is cheap to shard, but if reads must fan out across every shard the per-request overhead can eat the win.

### [log-structured merge tree (LSM tree)](../patterns/distributed/coordination/lsm-tree.md) {#tour-lsm-tree}

Before adding nodes, consider a storage engine built for writes. A log-structured merge (LSM) tree turns random in-place updates into sequential appends to an in-memory table that is flushed and later compacted, so a disk that struggles with scattered B-tree updates streams writes fast — the reason a log-structured store sustains write throughput far above a comparable B-tree store. The trade is on the read side: a lookup may have to check and merge several on-disk files, so you spend read latency to buy write throughput — worth it exactly when the workload is write-dominated.

### [Unique ID Generation](../patterns/distributed/coordination/unique-id-generation.md) {#tour-unique-id-generation}

Random keys send every insert to a different page and inflate log volume, while a time-ordered key keeps inserts at the tail of the index. Any node can generate such ids without a central allocator, which removes one more thing every writer must wait for.

### [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) {#tour-load-leveling}

Real write traffic is bursty — a holiday order spike, a flood of drivers on New Year's — and provisioning for the peak wastes capacity the rest of the year. Load leveling puts a queue between accepting a write and applying it, so the database drains at its steady rate while the queue absorbs the burst. The cost is that the client learns only that the write was accepted, not yet applied to the store, so it often needs a callback or poll to confirm; and a queue is for short bursts, not a database that simply can't keep up — feed it faster than it drains and the backlog grows without bound. Its sibling is [load shedding](../patterns/distributed/resilience/load-shedding.md): when even the queue can't cope, deliberately drop the least valuable writes — one of many location pings — to keep the important ones flowing.

### [Batching](../patterns/concurrency/batching.md) {#tour-batching}

Every individual write carries fixed overhead — a round trip, transaction setup, index maintenance — and most stores handle one large write far more efficiently than many small ones. Batching coalesces them: an application or an intermediate processor tallies a stream — a minute of like events on a post becomes one increment instead of a hundred — and writes the aggregate. It only pays when the window matches the traffic (a one-minute batch on a post that gets a like an hour buys nothing), and buffering before the durable write opens a data-loss window if the batcher crashes, unless it can replay its source.

### [CQRS](../patterns/architecture/cqrs.md) {#tour-cqrs}

When the write path and the read path pull in different directions, give them separate models. Command query responsibility segregation (CQRS) splits the command side from the query side, so writes land in a store and schema tuned for ingest — normalized, write-optimized, lightly indexed — while a separate read model is projected for queries, each scaled on its own. It is the heavier option, buying independent write scaling at the price of two models to keep in sync and the eventual consistency between them, so it pays off when the load shapes diverge rather than merely large.

<!-- tour:end -->

## How to decide
<!--meta block=decide-->

| If you need… | Lean | Reach for |
| --- | --- | --- |
| Writes outgrowing a single primary | Partition by key | [Sharding](../patterns/distributed/routing/sharding.md) |
| A write-dominated workload fighting a B-tree store | Switch the engine | [LSM-Tree](../patterns/distributed/coordination/lsm-tree.md) |
| Bursty spikes far above steady-state load | Buffer, and shed if needed | [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) |
| Inserts slowing down because the primary key is random | Time-ordered ids | [Unique ID Generation](../patterns/distributed/coordination/unique-id-generation.md) |
| Many tiny writes with fixed per-write overhead | Coalesce them | [Batching](../patterns/concurrency/batching.md) |
| Write and read load shapes diverging | Split the models | [CQRS](../patterns/architecture/cqrs.md) |
| A single key too hot for even its own shard | Split the counter (aggregable metrics only) | Sub-key splitting atop [Sharding](../patterns/distributed/routing/sharding.md), against a [hot partition](../hazards/hot-partition.md) |

## Sibling themes
<!--meta block=siblings-->

- [Scalability](./scalability.md) — The general capacity theme; these write-path patterns overlap with it, but here they are ordered as a single ladder specifically for reducing per-component write throughput.
- [Handling Spikes](./spike-handling.md) — The queues and load shedding on this ladder are the write-path answer to the traffic bursts that theme treats head-on.
- [Consistency & Replication](./consistency-and-replication.md) — Queues, batching, and sharded writes all relax consistency to gain throughput; this is where that cost is reasoned about.
- [Scaling Reads](./scaling-reads.md) — The other ladder: copies and caches for reads, where this page partitions for writes.
- [Dealing with Contention](./dealing-with-contention.md) — Writers fighting over the same row; sharding spreads different keys, not one contended one.
