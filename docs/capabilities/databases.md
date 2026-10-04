---
title: Databases
description: "Relational, key-value, document and in-memory — what each cloud calls it, and what managed does not cover"
area: capabilities
owner: Oleksandr Derechei
tags: [persistence, cloud]
status: stable
aliases: [managed databases, DBaaS]
solves: [I know the AWS database service but not what it is called on Azure or Google Cloud, we moved to a managed database and the slow queries are still slow, our application keeps running out of database connections and adding replicas makes it worse, I cannot compare two clouds database bills because they are not priced in the same unit, the PostgreSQL extension we depend on is not available on the managed service]
---

# Databases

The database engines a cloud runs on your behalf — relational, key-value, document, wide-column and in-memory — what each one is for, what every provider calls it, and which of the hard problems it has already solved for you.

## What the cloud gives you here
<!--meta block=description-->

Every cloud rents you database engines it runs for you: relational, key-value, document, wide-column and in-memory. You are buying the operating, meaning failover, backups, patching and disk growth, while you keep the schema, the queries and the access pattern. The engines mostly port, because they speak PostgreSQL, MySQL or the Redis protocol. The bill, version lag and connection limits around them do not.

## Explained
<!--meta block=explain-->

A managed database is an engine the provider operates for you: it handles failover, backups, patching and disk growth, while you keep the schema, the queries and the way you access the data. Choose by the access pattern you can guarantee, not by the data. If every query is known and names one record, a key-value store keeps its speed at any size. If queries are open-ended, or someone will write new ones next quarter, take the relational engine and pay for a bigger instance so you can still answer questions you have not thought of. A managed service does not choose your partition key, which decides whether one [hot partition](../hazards/hot-partition.md) takes all the traffic, and it will not turn a query that runs once per row into one query. It will sell you a bigger machine to run the many.

- **Connection limits.** The limit grows with instance size and every idle application copy holds a pool; put a connection pooler in front before you resize.
- **Version lag.** Supported versions and extensions trail the open-source release; check your extension list against the provider's catalogue at design time.
- **Failover pause.** Failover means tens of seconds of failed writes, not zero; make your client retry work that is safe to repeat.

**Example.** A relational instance allows 100 connections. Each copy of your service keeps a pool of 10. At 8 copies you hold 80, and all is well. A traffic spike autoscales you to 12 copies, which want 120 connections, so 20 requests are refused while the database CPU sits at 20 percent. Buying a bigger instance would fix it, but a pooler fixes it cheaper: 12 copies connect to the pooler, which holds 30 real connections to the database. The cost is one more component to run and a small extra hop on every query.

## The capabilities
<!--meta block=capabilities-->

- **Managed relational engine** — A standard engine — PostgreSQL, MySQL, SQL Server — on hardware the provider patches, backs up and fails over. Reach for it by default: joins, secondary indexes and multi-row transactions cost you nothing until you use them, and the schema moves to another provider unchanged.
- **Key-value store** — A store that routes every request by a partition key and returns one item, with capacity declared as throughput rather than as a machine size. It is for access patterns you can name in advance, and it holds its latency as the table grows because no request ever touches more than one partition.
- **Document store** — A store of self-describing records, usually JSON, indexed on fields inside the record with no fixed schema. Reach for it when the shape of a record varies by tenant or by version, and the relational answer would be a table of forty nullable columns.
- **[Managed in-memory cache](../patterns/caching/distributed-cache.md)** — A cluster speaking a cache protocol you already know, run by the provider in its own tier so every application instance sees the same entries. It is what keeps read traffic off the database, and it is the cheapest order of magnitude of read throughput you can buy.
- **[Read replicas](../patterns/distributed/coordination/replication.md)** — Asynchronous copies of the primary that serve reads and accept no writes. They buy read capacity and a warm promotion target, and they charge you in replication lag: a read issued straight after a write may not see it.
- **[Automatic failover to a standby](../patterns/distributed/coordination/leader-election.md)** — A second copy in another availability zone that the provider promotes when the primary stops answering. It turns a dead machine from an outage into tens of seconds of errors, which leaves you one job: a client that retries rather than one that gives up.
- **[Point-in-time restore](../patterns/distributed/coordination/write-ahead-log.md)** — Continuous archiving of the engine's write log, so you can rebuild the database as it stood at a chosen second inside the retention window. It is the only feature here that answers a bad migration or a wrong `DELETE`, because replicas copy the mistake faithfully.
- **Cloud-native scale-out relational** — A relational engine re-plumbed so that storage is a distributed service rather than a disk on the instance. Replicas attach to the same storage instead of copying it, which makes adding a reader and recovering from a failure fast, and ties that database to one provider.
- **Scale-to-zero relational** — A relational tier billed by consumption that suspends itself when idle and resumes on the next connection. It is for development environments and low-traffic services with long quiet periods, and you pay for it in resume latency on the first request after a pause.
- **Wide-column store** — A store of sparse rows addressed by an ordered row key and grouped into column families, built for sustained write rates and range scans. Reach for it for time series and event data, where you read a span of keys rather than one item by name.
- **[Change stream off the primary](../patterns/distributed/coordination/change-data-capture.md)** — An ordered feed of committed writes that other systems consume without querying the database. It is how a search index, a cache or a downstream service stays current without a nightly job and without your application code writing to two places at once.
- **Globally distributed strongly consistent relational** — A relational engine that shards across regions and still orders cross-shard transactions consistently for every reader. It buys you one logical database across continents, and it bills you in write latency and in a schema you have to design around the shard key.

## What each cloud calls it
<!--meta block=mapping-->

| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Managed relational, open-source engines | Amazon RDS | Azure Database for PostgreSQL, Azure Database for MySQL | Cloud SQL | [PostgreSQL](../comparisons/relational-databases.md), MySQL |
| Managed relational, SQL Server | RDS for SQL Server | Azure SQL Database, Azure SQL Managed Instance | Cloud SQL for SQL Server | no direct open-source equivalent |
| Cloud-native scale-out relational | Amazon Aurora | Azure SQL Database Hyperscale | AlloyDB for PostgreSQL | Vitess, CockroachDB (source-available) |
| Key-value store | Amazon DynamoDB | Azure Cosmos DB, Azure Table Storage | Cloud Bigtable (wide-column, used for key lookups) | [Redis](../comparisons/key-value-stores.md), Valkey |
| Document store | Amazon DocumentDB | Azure Cosmos DB | Firestore | MongoDB (SSPL) |
| Managed in-memory cache | Amazon ElastiCache | Azure Managed Redis (replaces Azure Cache for Redis, retiring September 2028) | Memorystore | Valkey, Memcached |
| Read replicas | RDS read replicas | read replicas; active geo-replication | Cloud SQL read replicas | PostgreSQL streaming replication |
| Point-in-time restore | RDS point-in-time restore | point-in-time restore | Cloud SQL point-in-time recovery | PostgreSQL WAL archiving |
| Scale-to-zero relational | Aurora Serverless | Azure SQL Database serverless | no first-party equivalent | no direct open-source equivalent |
| Wide-column store | Amazon Keyspaces | Azure Managed Instance for Apache Cassandra | Cloud Bigtable | Apache Cassandra |
| Change stream off the primary | DynamoDB Streams | Cosmos DB change feed | Spanner change streams, Bigtable change streams | Debezium |
| Automatic failover to a new primary | RDS Multi-AZ failover, Aurora failover | Azure SQL Database failover groups | Cloud SQL high availability | Patroni, Orchestrator |
| Materialized view maintained by the engine | Amazon Redshift materialized views | Azure Synapse materialized views | BigQuery materialized views | PostgreSQL MATERIALIZED VIEW |
| Globally distributed strongly consistent relational | Amazon Aurora DSQL | no first-party equivalent | Cloud Spanner | CockroachDB (source-available), YugabyteDB |
| Managed data warehouse | Amazon Redshift | Microsoft Fabric Warehouse | BigQuery | ClickHouse |
| Database migration | AWS Database Migration Service | Azure Database Migration Service | Database Migration Service | no direct open-source equivalent |
| Cache that reads and writes through to the database | Amazon DynamoDB Accelerator (DAX), read-through and write-through for DynamoDB | no first-party equivalent | no first-party equivalent | Hazelcast, Apache Ignite |
| Automatically sharded database | Amazon DynamoDB | Azure Cosmos DB | Cloud Spanner | Vitess, MongoDB sharding (SSPL) |
| Conditional write | DynamoDB condition expressions | Cosmos DB ETag with If-Match | Cloud Bigtable check-and-mutate | etcd transactions |
| Distributed lock and lease | DynamoDB Lock Client (library over conditional writes) | Azure Blob Storage leases | no first-party equivalent | etcd, Apache ZooKeeper, Consul |
| Approximate distinct count | Amazon Redshift HLLSKETCH, ElastiCache PFCOUNT | Azure Data Explorer hll() and dcount_hll() | BigQuery HLL_COUNT functions | Valkey PFADD and PFCOUNT, Apache DataSketches |

## Choosing between them
<!--meta block=choosing-->

Start from the managed relational engine and make everything else earn its place. It answers questions nobody has written yet, it holds the constraints in one place, and every engineer you hire already knows it. The question that moves you off it is not scale — it is whether you can name every access pattern in advance, because naming them is the trade a key-value store asks you to make.

| If you need… | Choose | Because |
| --- | --- | --- |
| A default store for a new service | Managed relational engine | Joins and transactions cost nothing until you use them, and the schema ports |
| Fixed access patterns over an unbounded item count | Key-value store | Every request is routed by partition key, so latency does not move as the table grows |
| Records whose shape differs per tenant | Document store | Indexes fields inside the record, with no migration for every new field |
| Read traffic growing faster than writes | A cache first, then read replicas | Both add read capacity without touching the write path; the cache costs far less per read |
| A dead machine to cost seconds rather than hours | Synchronous standby with automatic failover | Promotion is the provider's job; yours is a client that retries |
| To undo a bad migration or a wrong `DELETE` | Point-in-time restore | Replicas copy the mistake; only the archived write log predates it |
| Time-series or event data at a sustained write rate | Wide-column store | Ordered row keys make range scans cheap and keep writes sequential |
| A development database idle most of the week | Scale-to-zero relational tier | You pay for requests instead of for an idle machine, at the price of a resume delay |
| One logical database across continents | Globally distributed relational engine | Cross-shard transactions stay consistently ordered; every write pays the distance |

Connections deserve their own decision, because the limit is not a dial you can turn on its own. On most managed engines the maximum connection count scales with the instance size, and every application replica holds a pool whether it is serving traffic or not — so autoscaling the application is what exhausts the database. Put a connection pooler between the two before you resize the database, or you will buy memory to fix a counting problem.

Managed does not mean tuned, and the two workloads that prove it are worth rehearsing. A key-value table whose partition key has low cardinality sends most of its traffic to one partition, and no instance class fixes that — you fix it by changing the key, which is a [sharding](../patterns/distributed/routing/sharding.md) decision the provider will never make for you. A relational read path that has outgrown the primary is fixed first by a [cache](../patterns/caching/cache-aside.md), then by replicas, and when neither is enough by splitting the read model from the write model with [command query responsibility segregation (CQRS)](../patterns/architecture/cqrs.md) — and watch the cache for the single [hot key](../hazards/hot-key.md) that lands every request on one node, because sharding the cache does not spread one key.

## What does not port
<!--meta block=portability-->

- **The bill is not metered in the same unit**: one provider charges for provisioned hardware by the hour, another for database size plus connections, a third for consumption units that fold CPU, memory and I/O into one number. You cannot compare two clouds from the instance size alone, so model the workload's real read and write rates or the migration case rests on a number that means nothing.
- **Connection limits are the wall you hit first**: the maximum number of connections rises with instance size, and every idle application replica is still holding a pool. Size for connections as well as for CPU, or put a pooler in front — otherwise the first traffic spike fails on refused connections while CPU sits at twenty percent.
- **"Compatible with PostgreSQL" is an API claim, not a behaviour claim**: a compatible engine accepts the same wire protocol and the same SQL, and it may still plan a query differently, lock differently, or refuse an extension you depend on. Test the extensions and the slow queries, not the connection.
- **Version support lags upstream by different amounts**: each provider certifies major versions on its own schedule and retires them on its own schedule. Depending on a feature from the newest upstream release can pin you to one provider for a year, or force an engine change you had not budgeted.
- **A cross-region replica is not always a readable replica**: some serve reads at any time, and others exist only as a promotion target and answer nothing until you fail over to them. Read the specific mode, because it decides whether the second region carries traffic or merely survives.
- **Failover is neither free nor instant**: promoting a standby drops in-flight connections and takes tens of seconds, and writes fail for the whole of it. Give the client retry with backoff on idempotent work and let the health check tolerate the gap, or an automatic recovery becomes a restart storm.
- **The concurrency primitive differs**: relational engines give you multi-row transactions and row locks, while key-value and document stores give you a [conditional write](../patterns/distributed/coordination/conditional-write.md) on one item and a transaction API with tighter limits. Logic that was a transaction becomes an [optimistic retry loop](../patterns/distributed/coordination/optimistic-concurrency-control.md), and you have to decide what the application does when it loses.
- **You do not get superuser**: a managed instance withholds the top privilege level, so extensions, some system settings and anything wanting filesystem access are available only where the provider allows them. Every step in your runbook that starts by becoming superuser needs a replacement found before the migration, not during it.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Generalizes**

- [Key-value & cache stores](../comparisons/key-value-stores.md) — The key-value slice of this capability, argued product by product.
- [Search engines](../comparisons/search-engines.md) — The search-index slice of this capability: Lucene family against the single-binary engines.
- [Relational databases](../comparisons/relational-databases.md) — Which SQL engine sits inside the managed service, and what each commits you to.

**Implements**

- [Replication](../patterns/distributed/coordination/replication.md) — Read replicas and automatic failover are the managed form of this.
- [Leader Election](../patterns/distributed/coordination/leader-election.md) — Automatic failover is leader election you never see run.
- [Distributed Cache](../patterns/caching/distributed-cache.md) — Managed Redis and Memcached are this pattern rented by the hour.
- [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) — Change streams and change feeds emit the row-level log as an event source.
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — Warehouses and document stores maintain these on your behalf.
- [LSM Tree](../patterns/distributed/coordination/lsm-tree.md) — Wide-column stores are log-structured merge (LSM) engines you rent, with compaction running without you scheduling it.
- [Quorum & Consensus](../patterns/distributed/coordination/quorum-consensus.md) — A globally consistent relational service commits through a replica majority, and the latency is the bill.
- [Cache-Aside](../patterns/caching/cache-aside.md) — The managed in-memory cache is the store your application code reads aside and fills on a miss.
- [Read-Through](../patterns/caching/read-through.md) — A cache that loads missing entries from the database for you is this pattern sold ready-made.
- [Write-Through](../patterns/caching/write-through.md) — A cache that writes each update to the database before it acknowledges is this pattern sold ready-made.
- [Conditional Write](../patterns/distributed/coordination/conditional-write.md) — The store rejects a write when your stated condition no longer holds.
- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — Conditional writes and version tags give you optimistic concurrency without a lock.
- [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) — Lease-backed locks are available as a library, a blob lease or a coordination service.
- [Lease](../patterns/distributed/coordination/lease.md) — Blob leases and coordination-service leases hand out time-limited ownership.
- [HyperLogLog](../patterns/distributed/coordination/hyperloglog.md) — Warehouses and in-memory stores count distinct values approximately in small, fixed memory.
- [Sharding](../patterns/distributed/routing/sharding.md) — These stores split data across partitions by key without you choosing the shard map.

<!-- relationships:end -->
