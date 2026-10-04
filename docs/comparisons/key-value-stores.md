---
title: Key-value & cache stores
description: "An in-memory cache you can lose and recompute, or a durable key-value database you cannot"
area: comparisons
owner: Oleksandr Derechei
tags: [persistence, latency, durability, data-access, cloud]
status: stable
aliases: [redis, valkey, memcached, dragonfly, dynamodb, elasticache]
solves: ["I cannot tell whether we need a cache, a key-value database, or a wide-column store", our cache software changed its license and our legal team will not approve it, we need a cache but nobody here wants to run one, our key-value data has to survive a restart, a node fell over and half the keys vanished with it]
---

# Key-value & cache stores

Redis, Valkey, Memcached, Dragonfly, DynamoDB and Cassandra side by side — which of them you may lose without consequence, what each license commits you to, and who will run it for you.

## What this compares
<!--meta block=description-->

Every store here answers one question fast: give me the value filed under this key. The speed costs you joins and ad-hoc filters. One line splits the field. A [distributed cache](../patterns/caching/distributed-cache.md) holds a copy you can recompute, so losing it costs a slow hour, while a durable key-value database is the record, so losing it is an incident. License terms, which turned real in 2024, and who gets paged when the node fills decide the rest.
## Explained
<!--meta block=explain-->

A key-value store answers one question fast: give me the value filed under this key. It gets that speed by giving up joins and ad-hoc filters. Pick a side before you pick a product. An in-memory cache holds a copy of something you can compute again, so losing it costs a slow hour, not a customer's data. A durable key-value database is the record itself, so losing it is an incident. Default to a managed cache running an open engine, because the same binary can run on your own machines if the terms or the bill change. Take Redis when you use its richer data types, and Memcached when a plain cache is the whole job. Cross to the durable side the moment the store becomes the record.

- **License terms changed in 2024 and have not settled** Read them before you depend on an engine.
- **A cache that restarts empty sends every read to the database** Warm it or size the database for it.
- **A managed durable store ties you to one vendor** Budget on requests and keep the access patterns written down.

**Example.** A cache fronts a database. Traffic is 1,000 reads a second and the hit rate is 90 percent, so the database sees 100 reads a second and handles up to 300. The cache node restarts empty. For the next minutes every read misses, so the database sees up to 1,000 a second, over three times its limit, and slows for everyone. Warming the cache from a list of hot keys before it takes traffic, or capping the rate of misses sent to the database, keeps the load under 300. The cost is that restart now takes a longer, planned step.

## The contenders
<!--meta block=contenders-->

- **Redis** — Rich in-memory data structures — hashes, sorted sets, streams — on a single-threaded command core, with optional snapshot or append-only persistence. Since Redis 8 (May 2025) it is tri-licensed under RSALv2, SSPLv1 or AGPLv3; the AGPLv3 option returned it to OSI-approved open source after the 2024 move to source-available. Amazon ElastiCache, Azure Managed Redis (successor to Azure Cache for Redis, which retires in 2028) and Google Memorystore run it for you.
- **Valkey** — The community fork of Redis 7.2.4, created after the 2024 relicense and hosted by the Linux Foundation with its own contributors and roadmap. BSD-3-Clause and drop-in compatible, so existing clients keep working. ElastiCache and Memorystore both sell a Valkey engine, which makes it the cheapest way to keep a permissive license without running the server.
- **Memcached** — A multithreaded cache and nothing more: no persistence, no replication, no data structures past an opaque value under a key. BSD-3-Clause. The missing features are the product — less to configure, less to go wrong — and ElastiCache runs it for you.
- **Amazon DynamoDB** — A partitioned key-value and document store AWS runs and you cannot: proprietary, managed only, single-digit-millisecond reads, autoscaling partitions, pay-per-request billing. Writes replicate across availability zones before they are acknowledged, so this holds the record itself rather than a copy.
- **Dragonfly** — A multithreaded engine speaking the Redis API, built to get more out of one large machine before you take on sharding. Business Source License 1.1 — source-available, not open source — so put it past your legal team before you depend on it. No major cloud sells it as an engine, so you run it yourself or buy Dragonfly Cloud from its maker.
- **Apache Cassandra** — A wide-column store with leaderless replication and a write-optimised engine, so every replica takes the write and multi-region is the design rather than a bolt-on. Apache-2.0. Amazon Keyspaces and Azure Managed Instance for Apache Cassandra run compatible services.

## How they compare
<!--meta block=matrix-->

| Criterion | Redis | Valkey | Memcached | DynamoDB | Dragonfly | Cassandra |
| --- | --- | --- | --- | --- | --- | --- |
| Survives a restart | Optional snapshot or append-only file | Same options as Redis | No — cache only | Yes, by design | Optional snapshot | Yes, by design |
| Data model | Structures: hashes, sorted sets, streams | Same structures | Opaque bytes under a key | Item with attributes, partition and sort key | Redis command surface | Wide-column rows under a partition key |
| Scaling shape | One core per node, shard to grow | Same sharding model | Multithreaded, sharded by the client | Repartitioned for you | Multithreaded, scale up first | Add nodes to a leaderless ring |
| License | RSALv2 / SSPLv1 / AGPLv3 | BSD-3-Clause | BSD-3-Clause | Proprietary, service only | BSL 1.1 | Apache-2.0 |
| Who runs it for you | ElastiCache, Azure Managed Redis, Memorystore | ElastiCache, Memorystore | ElastiCache | AWS only | Dragonfly Cloud, or you operate it | Keyspaces, Azure Managed Instance |
| Typical role | Cache, sessions, queues, leaderboards | Same, on a permissive license | Cache-aside and nothing else | System of record | Drop-in cache at higher throughput | Write-heavy system of record |
| Replication and failover | Primary-replica, plus cluster mode | Same | None — a lost node is lost keys | Multi-AZ, global tables across regions | Primary-replica over the Redis protocol | Leaderless, tunable quorum, multi-region |
| What you pay for | Memory hours | Memory hours | Memory hours | Requests or provisioned capacity | Memory hours on fewer, larger nodes | Nodes and disks you keep running |
| Reads that are not by key | Sorted-set ranges and scans | Same | None | Secondary indexes and sort-key queries | As Redis | Clustering-key ranges, secondary indexes |

## Choosing between them
<!--meta block=choosing-->

Default to a managed cache running an open engine: ElastiCache or Memorystore with the Valkey engine gives you [cache-aside](../patterns/caching/cache-aside.md) today and leaves the exit door open, because the same BSD-3-Clause binary runs on your own machines if the terms or the bill change. Take Redis instead when you use its depth — sorted-set ranges, streams, server-side scripting — and your legal team has read the terms it now ships under. Take Memcached when a plain multithreaded cache is the whole job, and treat its missing features as one less thing to operate.

Cross to the durable side the moment the store becomes the record. Choose DynamoDB when you want zero operations and can accept one vendor, and budget on requests rather than memory. Choose Cassandra when write volume and multi-region writes dominate, and staff for the nodes and repairs that come with it.

Do less first. If one node's memory holds the working set and each node may keep its own copy, an in-process map with a TTL (time to live) needs no service, no network hop and no failover plan. Move to a shared store when the copies disagree in ways users notice, or when the working set stops fitting.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Specializes**

- [Databases](../capabilities/databases.md) — Narrows the database choice to key-access stores, where the split is whether losing the data means recomputing it or losing it.

**Implements**

- [Distributed Cache](../patterns/caching/distributed-cache.md) — Redis, Valkey and Memcached are what a distributed cache is usually made of; the license and the operator differ more than the mechanism does.
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — Where the product places a key decides what adding a node costs: a ring reshuffles one node's share, a client-side scheme reshuffles whatever its hash says.
- [Cache-Aside](../patterns/caching/cache-aside.md) — Most of these stores are used as the cache in cache-aside.

<!-- relationships:end -->
