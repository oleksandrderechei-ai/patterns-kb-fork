---
title: Sharding
description: Splits data across nodes by a partition key
area: distributed-scale
owner: Oleksandr Derechei
tags: [partitioning, throughput, isolation]
status: stable
aliases: [horizontal partitioning]
solves: [our database has outgrown the biggest disk we can attach to one machine, the primary cannot keep up with writes no matter how much we tune it, we added read replicas but writes are still the bottleneck, we ran out of database instance sizes and nothing bigger is left to buy, one enormous customer is slowing the database down for everybody else]
---

# Sharding

Splits a dataset across many independent nodes by a partition key, so each shard owns only a slice of the whole and no single machine has to store or serve it all.

## What it is
<!--meta block=description-->

Sharding splits a dataset into disjoint subsets, called shards, and places each on a different node, chosen by a key taken from each record such as a user, tenant or order ID. It resolves the single-node ceiling: a dataset outgrowing one disk, or writes outgrowing one primary. Adding a node adds both storage and write capacity, at the price of cross-shard queries and a key choice that is hard to undo.

## Explained
<!--meta block=explain-->

Sharding splits one big dataset into pieces, called shards, and puts each piece on a different machine, chosen by a key taken from each record such as a user ID. No machine holds everything, and every record lives on exactly one. You need it when the data outgrows one disk or the writes outgrow one primary database (the copy that accepts writes), because a bigger machine always hits a wall and costs more at each step. Adding a machine adds both storage and write capacity. Choose it over [replication](../coordination/replication.md) when writes are the problem, since replication copies the same data everywhere and only adds read capacity.

- **Scattered queries.** A query across many keys hits every shard and a cross-shard transaction turns distributed, so design queries around one key.
- **Key choice.** A bad key makes one shard hot and changing it moves live data, so pick a key with many evenly used values.
- **Rebalancing.** Adding a shard moves live data, so copy it first and switch reads after.
- **Lookup tables.** Small shared tables are copied to every shard, so accept brief staleness there.

**Example.** A 2 TB orders table outgrows one primary that can take 20,000 writes a second. Shard it by customer ID across 4 machines: each holds 500 GB and takes about 5,000 writes a second, and one customer's orders sit on one shard. Sharding by order date would send every new write to the newest shard, which runs hot while the rest idle. The cost shows when you ask for the top 10 customers by spend, which must query all 4 shards, and when you add a fifth: an even split moves 400 GB onto it while the table stays live.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a request find its data when no node holds all of it? The router turns the key into exactly one shard, so the other two never see the query and never spend work on it."
flowchart LR
    C["Client"]
    R["Router"]
    Map[("Shard map")]
    subgraph Space["One key space, split with no overlap"]
        S1[("Shard 1 · A-M")]
        S2[("Shard 2 · N-T")]
        S3[("Shard 3 · U-Z")]
    end
    C -->|"1 read orders for user u42"| R
    R -->|"2 look up which shard owns u42"| Map
    R -->|"3 query that shard alone"| S2
    S2 -->|"4 return the rows"| R
    R -->|"5 return the result"| C
```

## Variations
<!--meta block=variations-->

- **Range-based sharding** — Each shard owns a contiguous range of key values. Cheap range scans, but keys clustered in time (e.g. sequential IDs, timestamps) pile onto the newest shard.
- **Hash-based sharding** — A hash function scatters keys evenly across shards regardless of their natural order. Kills hotspots and range scans alike — a query for "all of last week" now hits every shard.
- **[Consistent hashing](./consistent-hashing.md)** — Places shards and keys on the same hash ring so adding or removing a shard remaps only its neighbors' keys, not the whole dataset.
- **Directory-based (lookup service)** — An explicit key-to-shard mapping table, looked up on every routing decision. Flexible and rebalance-friendly, but the directory itself becomes a critical, must-scale dependency.
- **Entity / tenant sharding** — Shard by tenant ID or account ID so one customer's data never crosses shard boundaries — simplifies isolation, backup, and per-tenant data residency.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Scales storage** and write throughput horizontally by adding more shards.
- **Each shard is smaller**, so its working set and indexes fit in memory and queries stay local and fast.
- **A failure or maintenance window** on one shard affects only its slice of the data, not the whole dataset.
- **Lets data** be placed by geography or tenant to satisfy residency and isolation requirements.

### Cons
<!--meta polarity=con-->

- **Cross-shard joins**, aggregations, and transactions become distributed and slow, if they're possible at all.
- **Rebalancing an unevenly loaded key** space means moving live data between nodes without downtime.
- **The shard key is hard to change later** — a poor early choice creates a permanently hot shard.
- **Adds a routing layer** and more nodes to provision, monitor, back up, and upgrade.
- **Small lookup tables the shard** key doesn't cover get copied onto every shard to keep queries single-shard, and each copy is briefly stale while an update propagates.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Data volume** or write throughput has outgrown what one node can hold or absorb.
- **Access is mostly keyed** by a natural partition key, like a user ID or tenant ID.
- **You need to scale writes**, not just reads — replication alone only helps read capacity.

### Avoid when
<!--meta polarity=avoid-->

- **The dataset comfortably fits** and performs on a single, well-tuned node or replica set.
- **Queries routinely join** or aggregate across entities that a shard key would split apart.
- **You don't yet have a stable**, evenly-distributed shard key — sharding on the wrong one is costly to undo.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal hash-based shard router"
class ShardRouter<T> {
  constructor(private readonly shards: readonly T[]) {}

  private hash(key: string): number {
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = (h * 31 + key.charCodeAt(i)) >>> 0; // unsigned 32-bit
    }
    return h;
  }

  connectionFor(key: string): T {
    const index = this.hash(key) % this.shards.length;
    return this.shards[index];
  }
}

// One router instance per process, wrapping live DB connections.
const router = new ShardRouter([shardA, shardB, shardC]);

async function ordersFor(userId: string) {
  const conn = router.connectionFor(userId);
  return conn.query("SELECT * FROM orders WHERE user_id = $1", [userId]);
}
```

## In the wild
<!--meta block=wild-->

- **Vitess** — VTGate routes queries and vindexes map keyspace IDs to shards, making many MySQL shards look like one database; online resharding runs through Reshard workflows that copy and cut over traffic. Built at YouTube; now a Cloud Native Computing Foundation (CNCF) graduated project run at Slack and Square. {#wild-vitess}
- **MongoDB** — A collection is sharded on a declared key (ranged or hashed); the mongos router forwards queries using metadata from config servers, and a background balancer migrates chunks between shards to keep them evenly filled. {#wild-mongodb}
- **Citus** — A PostgreSQL extension whose coordinator distributes a table by a chosen column across worker nodes via create_distributed_table and parallelizes queries across them; rebalance_table_shards moves shards to even out load. {#wild-citus}
- **Sharded model training (FSDP / DeepSpeed ZeRO)** — When a model is too large for one GPU, its parameters, gradients, and optimizer state are sharded across the GPUs of a data-parallel group — PyTorch FSDP and DeepSpeed ZeRO each keep only a slice on every device and gather the rest on demand. {#wild-fsdp-zero}
- **Sharded vector search** — Billion-scale embedding indexes are partitioned across nodes so each holds a slice of the vectors; a query fans out to the shards and merges the nearest-neighbour results — the same partition-then-fan-out shape as a sharded database. {#wild-vector-shard}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Shard key** — The field records are partitioned on — the decision that matters most and is hardest to change; it must spread evenly and match the dominant access pattern.
- **Shard count and pre-splitting** — How many shards the key space is divided into up front, and whether ranges are pre-split so a new deployment does not start with one hot shard.
- **Rebalancing throttle** — The rate at which chunks or ranges of live data are moved between nodes, traded off against the latency impact on foreground traffic during migration.
- **Per-shard replication factor** — How many copies of each shard are kept, so losing one node does not make that slice of data unavailable.

### Signals to watch
<!--meta polarity=signal-->

- **Per-shard load skew** — Queries per second (QPS), connection count, and stored bytes per shard; a shard running far hotter than its peers is the classic sign of a poor key or a monotonic key on range sharding.
- **Cross-shard query proportion** — Share of queries that fan out to more than one shard (Scatter-Gather); rising fan-out erodes the locality sharding was meant to buy.
- **Rebalancing progress** — Data still in flight and chunks pending during a rebalance, watched alongside foreground latency to catch migration starving live traffic.
- **Per-shard storage headroom** — Disk utilization on each node; a shard approaching its ceiling forces a split or move before it runs out of space.

### Failure modes under load
<!--meta polarity=failure-->

- **Hot shard** — One shard takes a disproportionate share of reads or writes — a skewed key, or sequential keys landing on the newest range — while the others sit idle.
- **Cross-shard fan-out** — Joins, aggregations, and transactions that span shards become distributed operations that are slow, or not supported at all.
- **Rebalance contention** — Moving live data to even out the key space competes with foreground traffic for I/O and CPU and degrades latency while it runs.
- **Single-shard outage** — A node failure takes its whole slice offline; without per-shard replication that slice is simply unavailable until it recovers.

### Readiness checklist
<!--meta polarity=check-->

- Shard key distributes evenly and matches the dominant access pattern, validated against real data before committing
- Each shard is replicated so losing one node does not lose or block its slice of the data
- The routing or directory layer is itself highly available and not a throughput bottleneck
- Rebalancing is throttled and proven to run online, moving live data without downtime
- Backups, restores, and schema migrations are exercised across every shard, not just one

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [System Design Interview](../../../themes/system-design-interview.md) — Split data when one database won't fit {#fluency-system-design-interview}
- [Scalability](../../../themes/scalability.md) — Partition data to scale writes {#fluency-scalability}
- [Proximity Search](../../../themes/proximity-search.md) — Partition the space by region or prefix so each shard owns an area {#fluency-proximity-search}
- [Scaling Reads](../../../themes/scaling-reads.md) — Partition data so reads spread across nodes {#fluency-scaling-reads}
- [Scaling Writes](../../../themes/scaling-writes.md) — Partition writes across nodes by key {#fluency-scaling-writes}
- [Gen AI at Scale](../../../themes/genai-scale.md) — Split a model too big for one device {#fluency-genai-scale}
- [Scale Units & Stamps](../../../themes/scale-units-and-stamps.md) — The data ceilings a compute boundary does not cover {#fluency-scale-units-and-stamps}
- [Data Platform](../../../themes/data-platform.md) — The partition key, and the ceiling it commits you to {#fluency-data-platform}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Replication](../coordination/replication.md) — Partition for scale, replicate each shard for safety
- [MapReduce](../coordination/mapreduce.md) — Each shard is processed in place by its own map task
- [Geohash](./geohash.md) — Geospatial data shards cleanly by geohash prefix, colocating nearby points
- [Design to Scale Out](../../../principles/scale-out.md) — Sharding is what stops the database capping the instance count
- [Partition Around Limits](../../../principles/partition-around-limits.md) — Sharding is this principle applied to a data store
- [Index Table](../coordination/index-table.md) — Hashing destroys ordered access, and an index table is how you get range queries back
- [Relational databases](../../../comparisons/relational-databases.md) — Distributed SQL is this done for you, billed as commit latency and a license.
- [Unique ID Generation](../coordination/unique-id-generation.md) — The partition key is often carved out of the identifier itself
- [Consistent Hashing](./consistent-hashing.md) — Consistent hashing is how shards are placed
- [Multi-Tenancy](./multi-tenancy.md) — The tenant id is a natural shard key.

**Alternative to**

- [Vertical Partitioning](./vertical-partitioning.md) — Splits rows across nodes and keeps each row whole; the column split is the axis at right angles to it
- [Functional Partitioning](./functional-partitioning.md) — Splits one area by key; when the pressure is several unrelated areas sharing a store, the functional split is the axis

**Often confused with**

- [Replication](../coordination/replication.md) — Split data vs. copy data
- [Make Everything Redundant](../../../principles/redundancy.md) — Sharding buys capacity, not availability; the copies are a separate decision

**Prevents**

- [Hot Partition](../../../hazards/hot-partition.md) — A shard key chosen badly piles traffic onto one node

**Exposed to**

- [Hot Key](../../../hazards/hot-key.md) — Can fall into hot key when a sharded cache puts a viral key on exactly one shard

**Demonstrated by**

- [Distributed Cache](../../../designs/design-distributed-cache.md) — shows partitioning turn an unservable dataset into per-node slices that scale by adding nodes
- [Distributed Rate Limiter](../../../designs/distributed-rate-limiter.md) — Redis Cluster's slot-based sharding is what lets a write-heavy global counter scale horizontally
- [Top-K](../../../designs/top-k.md) — billions of distinct keys and a 70x single-node write overload are split across shards so each stays within node limits
- [Ad Click Aggregator](../../../designs/ad-click-aggregator.md) — both throughput and hot-shard mitigation come down to choosing and salting the partition key
- [Instagram](../../../designs/instagram.md) — horizontal scale of the metadata store comes from partitioning by user id, the core of sharding
- [Facebook Post Search](../../../designs/fb-post-search.md) — keyword sharding is how the design spreads a 10k-post/sec write fan-out across the cluster
- [Gopuff](../../../designs/gopuff.md) — region-keyed horizontal partitioning of the inventory table keeps each query local to a shard
- [Uber](../../../designs/uber.md) — partitioning by geography co-locates related data and bounds cross-shard scatter-gather
- [Tinder](../../../designs/tinder.md) — partitioning is chosen here for atomicity — co-locating related rows — not merely to spread load
- [Strava](../../../designs/strava.md) — time-based sharding keeps hundreds of TB/year queryable by localizing the hot working set
- [Online Auction](../../../designs/online-auction.md) — auction-keyed sharding is the case where each entity's whole read/write traffic stays on a single shard
- [Robinhood](../../../designs/robinhood.md) — partitioning by the access key keeps every read and update for an order on a single shard
- [Payment System](../../../designs/payment-system.md) — the 10k-transactions per second (TPS) write pressure is exactly the condition that forces horizontal partitioning of the store
- [Job Scheduler](../../../designs/job-scheduler.md) — the hot-partition bottleneck is dissolved by spreading writes across a suffixed key space
- [YouTube](../../../designs/youtube.md) — A video catalogue's metadata is sharded while its bytes live in object storage

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Automatically sharded databases do the split and the rebalancing for you.

<!-- relationships:end -->
