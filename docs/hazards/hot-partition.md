---
title: Hot Partition
description: One shard takes most of the traffic while its peers sit idle
area: hazards
owner: Oleksandr Derechei
tags: [partitioning, throughput, load-balancing]
status: stable
aliases: [hot shard, partition skew]
solves: [one shard is pinned at its ceiling while its peers sit near idle, cluster utilisation looks comfortable but one node is throttling writes, adding shards changed nothing because the busy key still resolves to one of them, throughput is capped by a single node no matter how far we scale out]
---

# Hot Partition

A partition key that spreads the data evenly but not the load, so one shard runs at its limit while its peers idle — and the cluster's usable throughput collapses to whatever that single shard can take.

## What it is
<!--meta block=description-->

A **hot partition** is a shard that receives far more traffic than its share of the data, so one machine is full while its neighbours idle. You recognise it when requests are throttled although the cluster's total load is low, and adding shards does not help. The defining trait is that the load follows the partition key, not the data volume: skew from a date, counter or oversized tenant lands on exactly one shard.

## Explained
<!--meta block=explain-->

A hot partition is a shard that gets far more traffic than its share of the data, so one machine is full while its neighbours are nearly idle. A partitioned store places every row by its partition key, and if requests share one key value, or values that sort next to each other, they all land on the same shard. You build it early by choosing the key for query convenience: a date, a status, a region, an auto-counting id, or a tenant that turns out to be huge. Adding shards does not help, because the busy key still lands on exactly one of them. Price the cluster by its busiest shard, not its total. Fix the key: choose one with many values, and keep timestamps and counters out of the first position. Where one value must stay hot, salt it by writing under a fixed number of sub-keys. Give one oversized tenant its own shard, and alarm on the busiest shard, since averages hide it.

- **Read fan-out.** Salting multiplies every read of that value by the sub-key count; use the smallest number that works.
- **Special cases.** A tenant on its own shard needs its own routing and monitoring.

**Example.** A store has 10 shards, each limited to 1,000 writes a second. Events are keyed by date, so today's 6,000 writes a second all hit one shard. It accepts 1,000, and 5,000 a second are throttled, while the other 9 shards idle. Adding 10 more shards changes nothing. You salt the key into 8 sub-keys, so each shard takes 750 writes a second. Six sub-keys would sit exactly at the limit, so eight leave headroom; this assumes the sub-keys hash to different shards. A report on one day now queries 8 sub-keys and merges the results, which is the permanent read cost.

## How it happens
<!--meta block=causes-->

It comes from one decision made early: which field the data gets split by. Choose a field with only a handful of values, or one that counts upward like a date or an id, and new traffic has nowhere to go but the same machine. Nothing about it looks wrong at review time, since the query works and the write succeeds, and none of the causes below is caught by a schema review. The skew only surfaces once the volume arrives.

Placement is a function of the key; load is not. A hash-partitioned store spreads distinct key values evenly, so skew survives only where one value is genuinely popular. A range-partitioned store keeps neighbouring keys together, so any monotonic component parks every new write on the tail partition. The four causes below are the usual ways a key acquires one of those properties.

```mermaid caption="Why adding capacity does not help: the key decides placement, so new shards never see the hot key."
flowchart LR
    K["Partition key carries today's date"] -->|"placement follows the key"| P["Every new write lands on one shard"]
    P -->|"per-shard throughput limit"| T["That shard throttles and queues"]
    T -->|"nineteen peers stay idle"| A["Cluster average still looks healthy"]
    A -->|"operator adds shards"| S["New shards take no traffic"]
    S -->|"key unchanged, placement unchanged"| P
```

- A low-cardinality partition key — status, region, country, day — offers fewer distinct values than there are partitions, so some partitions hold nothing and one holds the working set.
- A monotonic key: a timestamp, an auto-increment id or any sequential prefix keeps consecutive writes adjacent, so a range-partitioned store puts every insert on the same tail partition.
- Real-world skew under an evenly-hashed key: one tenant, one seller or one device fleet produces a large fraction of the rows, because hashing distributes values and not volume.
- A split that leaves the key alone: dividing a hot range yields two ranges, but requests still resolve by the same value, so the traffic follows it into one half and the other half stays cold.

## What it costs
<!--meta block=cost-->

- **The cluster's ceiling becomes one shard's ceiling.** You provisioned aggregate throughput and can only use the fraction the busiest shard allows; the idle peers are capacity you pay for and cannot reach.
- **Requests to that partition degrade or fail.** Queues build and tail latency climbs, and per-partition limits throttle writes; retries land on the same shard, so they cannot clear a sustained overload.
- **The blast radius is the whole partition.** Every unrelated key that happens to live there slows down alongside the hot one, so the incident looks broader than its cause and sends you hunting in the wrong place.
- **Averages conceal it.** Cluster utilisation and mean latency read healthy, because one saturated shard in twenty barely moves the aggregate; the signal exists only in the per-partition breakdown.
- **The usual scaling lever is dead.** Adding nodes moves key ranges but does not split one key's traffic, so against a single hot key the usual fix changes little.

The real cost is the migration. The durable fix changes the partition key, which is embedded in every query, every secondary index and every row already written, so it means a backfill, a window of dual reads and a cutover, all against a system already degraded. Hot partitions get absorbed with extra capacity and retries for as long as capacity covers the gap, and deferral adds rows to the backfill.

## Getting out
<!--meta block=mitigation-->

Fix the key, not the cluster. Pick a partition key with enough distinct values to cover every partition and enough evenness to keep them all busy, and keep monotonic components — timestamps, sequences — out of the leading position, so consecutive writes stop landing together. Where one logical value has to stay hot, salt it: write it under a bounded set of sub-keys and read all of them back, which trades a fan-out on reads for a division of writes.

Choose the salt factor deliberately, because it is a permanent tax on every read of that value: a factor of ten divides the write load by ten and multiplies each read by ten. Compute it as the hot key's write rate divided by the per-partition limit, rounded up, plus headroom: 6,000 / 1,000 gives 6, and the example uses 8. A factor of ten divides write load by ten only when the sub-keys land on different partitions and writes spread evenly. So the right number is the smallest one that brings the busiest partition under its limit. If the skew is one tenant rather than one key shape, isolate instead — give that tenant its own partition or its own cluster, and let the shared pool serve the long tail it was sized for. Where the store supports it, a manual split plus a placement change moves the hot range onto a node of its own, which buys time without touching the schema; it helps only when the hot range holds several keys, since a split leaves one [hot key](./hot-key.md) on one half. For read-heavy skew on one popular value, put a cache or read replicas in front of it; see [hot key](./hot-key.md).

Make per-partition utilisation a first-class signal before you need it, and alarm on the busiest partition rather than the mean, because an aggregate dashboard cannot show this failure at all. Buffering in front of the store — coalescing or batching writes that share a key — also buys time without a migration, at the cost of a window in which the buffer holds data the store does not, and a recovery path for what is in it when the process dies. When a re-key is unavoidable, run the new key alongside the old and cut reads over once the backfill has caught up; a flag day on a store already at its limit is how a capacity problem turns into an outage.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Hot Key](./hot-key.md) — The cache-tier cousin: one entry saturates, not a whole shard

**Mitigated by**

- [Sharding](../patterns/distributed/routing/sharding.md) — Choose a partition key for load, not only for storage
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — Virtual nodes even placement; single-value skew still needs salting
- [Partition Around Limits](../principles/partition-around-limits.md) — Choosing the key against the limit is what stops one partition carrying everything

**Threatens**

- [MapReduce](../patterns/distributed/coordination/mapreduce.md) — A reducer owning a skewed key is the batch form of one overloaded shard.
- [Ad Click Aggregator](../designs/ad-click-aggregator.md) — Click aggregation keyed by ad_id hits it when one ad is hot.
- [Facebook Live Comments](../designs/fb-live-comments.md) — a live-comment design that hashes on liveVideoId concentrates one viral stream on one server

<!-- relationships:end -->
