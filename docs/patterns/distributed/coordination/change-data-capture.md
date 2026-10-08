---
title: Change Data Capture
description: Stream a database's row-level changes from its log to other systems
area: distributed-data
owner: Oleksandr Derechei
tags: [event-driven, decoupling, asynchrony]
status: stable
aliases: [CDC, log tailing]
solves: [my search index and cache keep drifting out of sync with the database, I need to react to every row change without dual-writing from the application, I want a stream of database changes without adding extra tables and code to every service, our nightly export means every other system is a day behind, "the service crashed after saving the row but before updating the search index, and they disagree now"]
---

# Change Data Capture

Tails a database's own replication log and streams every row-level insert, update, and delete, in commit order, to search indexes, caches, warehouses, and other services — so downstreams stay in sync without the application dual-writing.

## What it is
<!--meta block=description-->

Updating a database and then a search index, a cache and a broker from application code leaves them disagreeing after any crash between the writes. Change data capture reads the database's own durable log of committed row changes and delivers each one, in commit order, to downstream systems. The application only writes to its database. Delivery is at least once, so consumers must tolerate repeats.

## Explained
<!--meta block=explain-->

Change data capture reads a database's own log of committed row changes and delivers each one, in commit order, to other systems such as a search index, a cache or a warehouse. The application only writes to its database, so you do not wire updates to several stores into the write path, where a crash between two writes leaves them disagreeing. Choose it over a transactional outbox (an events table your code fills inside each transaction) when you would rather change no application code: the log already records every committed write, so none can be missed.

- **Raw events** Events are before-and-after row values, not business events; each consumer rebuilds the meaning, and an upstream column change can break them.
- **Repeats** Delivery is at least once, so a restart can repeat an event; make every consumer safe to run twice.
- **Another system** The pipeline is one more thing to run; monitor its lag.
- **Pinned log** A stopped consumer makes the database keep unread log; alert on retained log size, and re-snapshot if its bookmark is lost.

**Example.** An orders table takes 500 writes a second, and each change event is about 1 KB, so the log grows 0.5 MB a second. The search-index consumer crashes at 02:00, and the database keeps all the log it has not read. After one hour that is 1.8 GB, after two hours 3.6 GB. The primary has 20 GB of free disk, so it fills in about 11 hours, and the page would arrive as a database outage instead of a stale search index. An alert on 2 GB of retained log fires at about 03:07, in time to restart the consumer or drop its bookmark.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a search index learn about a row that changed, without the application telling it? The connector reads the same durable log the database uses to recover, so no committed change can be missed, and republishes it in commit order."
flowchart LR
    App["Application"]
    subgraph Src["One database — the log the primary already keeps"]
        Rows[("Rows")]
        Log[("Replication log: WAL / binlog / oplog")]
    end
    C["CDC connector"]
    Q[("Stream / broker")]
    Idx["Search index"]:::ext
    Cache["Cache"]:::ext
    App -->|"1 insert, update, delete"| Rows
    Rows -->|"2 record the committed change"| Log
    C -->|"3 snapshot, then tail from a log position"| Log
    C -->|"4 publish change events in commit order"| Q
    Q -->|"5 upsert document"| Idx
    Q -->|"6 invalidate key"| Cache
    C -->|"7 acknowledge position, log recycles"| Log
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Log-based vs. query-based** — Log-based CDC tails the database's replication log (Postgres's write-ahead log, MySQL's binlog, MongoDB's oplog). It captures every committed change, deletes included, in order, with no polling queries against the primary. Query-based CDC instead polls for rows whose `updated_at` changed since last time: simpler and needing no log access, but it misses deletes, misses intermediate states between polls, and adds query load. Prefer log-based when the source database supports it.
- **Trigger-based capture** — Database triggers fire on insert/update/delete and write change rows to an audit or event table that a consumer then reads. It works without log access and captures deletes, but the triggers run inside every write transaction, adding latency and coupling to the schema.
- **Snapshot then stream** — For an initial load, take a consistent snapshot of existing rows, record the log position it corresponds to, then switch to tailing the log from there. A new consumer gets the full current state before it receives live changes, and no change is lost at the handoff; a change near the switch may arrive twice, so consumers stay idempotent.
- **CDC vs. the [transactional outbox](./outbox.md)** — The [outbox](./outbox.md) has the application write an explicit events table in the same transaction as the business change, giving it full control over event shape at the cost of a table and relay to maintain. CDC reads the log the database already keeps, needing neither — but the events mirror raw row changes rather than domain intent. Debezium's outbox router blends the two: CDC that reads an outbox table.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No dual writes**: the application only touches its database, so downstream stores cannot silently diverge from a half-completed multi-system write.
- **Log-based capture sees every committed change** while the consumer stays within log retention, and sends the primary no polling queries; wider row images cost it write-side overhead (see con-5), and past retention the consumer must re-snapshot.
- **Changes arrive in commit order**, and when the source is set to record before and after images, they carry enough to rebuild indexes, caches and warehouses.
- **New consumers attach** to the existing stream without any change to the application or its write path.

### Cons
<!--meta polarity=con-->

- **Delivery is at-least-once** — a restart can redeliver a change — so every consumer must be idempotent.
- **A stalled or slow consumer** pins its replication slot (the database's marker of the last change that consumer read). The database cannot recycle the write-ahead log (WAL) past that point, so the disk fills.
- **Source schema changes** (a dropped column, a type change) can break the stream or downstream consumers if not handled deliberately.
- **Events mirror raw row changes, not domain intent**; consumers must reconstruct meaning, and the CDC pipeline is one more thing to run and monitor.
- **How much prior state** an event carries depends on how the source table is configured: by default an update or delete may show only its key columns, and widening that costs extra write-side overhead on the primary.
- **Order holds on a single stream**; once events are partitioned by key it holds per key only, and one transaction's changes can arrive separately, so consumers must not assume cross-row atomicity.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A search index**, cache, or read replica must stay in sync with a source database and keeps drifting when kept in sync by hand.
- **Other systems need to react** to every row change, and you want that decoupled from the application's write path.
- **You want an ordered event** stream of changes but would rather not add and maintain an outbox table and relay.

### Avoid when
<!--meta polarity=avoid-->

- **You need full control over event shape** and semantics — the outbox emits domain events, CDC emits raw row diffs.
- **The database offers no accessible** replication log and query- or trigger-based capture would cost more than it is worth.
- **Only one consumer needs the change** and a direct synchronous update is simpler than standing up a streaming pipeline.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an idempotent CDC consumer that keeps an index in sync"
type Op = "insert" | "update" | "delete";

interface ChangeEvent {
  lsn: string;   // log position — monotonic; doubles as the consumer offset
  op: Op;
  key: string;
  after: Record<string, unknown> | null; // null on a delete
}

// Tail the ordered change stream, apply each event to a downstream store,
// then commit the log position. Consumers must survive redelivery.
async function consume(
  stream: AsyncIterable<ChangeEvent>,
  index: SearchIndex,
  offsets: OffsetStore,
) {
  for await (const e of stream) {
    // At-least-once: the same event may arrive twice after a restart.
    // Upsert-by-key and delete-by-key are idempotent, so a replay is a no-op.
    if (e.op === "delete") {
      await index.remove(e.key);
    } else {
      await index.upsert(e.key, e.after!);
    }
    // Commit the offset only AFTER the apply succeeds, so a crash resumes
    // from the last durably-applied change rather than skipping one.
    await offsets.commit(e.lsn);
  }
}

```

## In the wild
<!--meta block=wild-->

- **Debezium** — An open-source CDC platform, usually run as Kafka Connect source connectors. It tails Postgres logical replication (pgoutput/decoderbufs), the MySQL binlog, and the MongoDB change stream/oplog among others, emitting each row change as a record with before/after state. Its Outbox Event Router turns an outbox table's inserts into routed events. {#wild-debezium}
- **Amazon DynamoDB Streams** — A built-in change feed: each item-level insert, modify, or remove is published as an ordered stream record with a configurable view (keys only, new image, or old and new images), consumed by Lambda or through the Kinesis adapter — commonly used to keep an OpenSearch index or analytics pipeline in sync. {#wild-dynamodb-streams}
- **PostgreSQL logical replication** — Postgres exposes committed changes through logical decoding: a replication slot streams row changes in commit order via an output plugin such as the built-in pgoutput or wal2json. The slot retains WAL until the consumer acknowledges it, so no change is skipped while the slot exists, at the cost of disk that grows if the consumer stalls. {#wild-postgres-logical-replication}
- **MySQL binary log (binlog)** — MySQL's row-based binary log records every committed change and is the foundation of its native replication. CDC tools tail the binlog from a saved position or GTID to reconstruct inserts, updates, and deletes as an ordered change stream. {#wild-mysql-binlog}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Snapshot vs. streaming mode** — Whether the connector takes an initial consistent snapshot of existing rows before it starts tailing the log, or begins from the current position. Snapshotting a large table is expensive but gives a new downstream the full current state before live changes arrive.
- **Replication slot / log retention** — How much log the database keeps for the consumer — a Postgres replication slot pins WAL until acknowledged, binlog has an expiry, DynamoDB Streams retains records for 24 hours. Too little and a lagging consumer loses its position and must re-snapshot.
- **Batch / fetch size** — How many change events the connector fetches and the consumer applies per round. Larger batches raise throughput but enlarge the redelivery window on a crash and hold more in memory.
- **Consumer offset commit** — How often, and after which step, the consumer commits its log position. For at-least-once safety, commit only after the change is applied downstream; the interval sets how much is re-read on restart.

### Signals to watch
<!--meta polarity=signal-->

- **Replication slot lag / retained log bytes** — How far behind the slowest consumer is and how much WAL/binlog the database is holding for it — the number that predicts disk exhaustion on the primary
- **End-to-end CDC lag** — Time from a database commit to the change landing downstream — the freshness other systems actually see
- **Consumer offset lag** — Events between the log head and the consumer's committed position; sustained growth means the consumer cannot keep up with write volume
- **Connector error / restart rate** — Failed or restarting connectors — often the first sign of an incompatible schema change or a downstream outage

### Failure modes under load
<!--meta polarity=failure-->

- **Stalled consumer pins the slot** — A down or slow consumer stops acknowledging, so the database cannot recycle WAL/binlog; the retained log grows until the disk fills and the primary itself is at risk
- **Schema change breaks the stream** — An incompatible data definition language (DDL) — a dropped or renamed column, a type change — makes events undeserializable or breaks the downstream mapping, halting the pipeline until handled
- **Duplicate delivery on redelivery** — After a crash the connector re-reads from its last committed offset and re-emits changes; a non-idempotent consumer double-applies them
- **Snapshot storm** — An initial snapshot of a huge table floods the stream and downstream all at once, and long-running snapshots can hold resources or locks on the source

### Readiness checklist
<!--meta polarity=check-->

- Make every consumer idempotent — upsert by key, or dedupe on a change id / log position — because delivery is at-least-once
- Alert on replication-slot lag and retained-log bytes before they can fill the database disk
- Plan schema-change handling (a schema registry or compatibility rules) so DDL does not silently break the stream
- Size log retention (WAL keep / binlog expiry / stream retention) for the slowest consumer's worst-case downtime
- Have a re-snapshot / reseed procedure to rebuild a downstream from scratch after corruption or a long outage

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Consistency & Replication](../../../themes/consistency-and-replication.md) — Stream committed row changes from the database log to the copies that must follow. {#fluency-consistency-and-replication}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Big Data](../../architecture/big-data.md) — Streaming a database's changes is a common front door into the ingestion path.
- [Data & Analytics](../../../capabilities/data-analytics.md) — The usual entry point into an analytics pipeline.
- [Messaging Bridge](../../messaging/messaging-bridge.md) — Turns a legacy database into a producer the bridge can drain
- [Index Table](./index-table.md) — Feeds the worker that keeps hand-built secondary indexes in step with the data
- [Retrieval-Augmented Generation](../../ml/rag.md) — Feeding an embedding pipeline is a common consumer of the change stream
- [Materialized View](./materialized-view.md) — A change stream keeps a precomputed view continuously in sync with its source
- [Inverted Index](./inverted-index.md) — Streams row changes to a search index kept as a second copy of the data

**Alternative to**

- [Outbox](./outbox.md) — Tail the database (DB)'s own log instead of writing an events table in the same transaction

**Requires**

- [Write-Ahead Log](./write-ahead-log.md) — Log-based capture reads the database's own write-ahead log to publish every committed change

**Often confused with**

- [Event Sourcing](../../architecture/event-sourcing.md) — Builds events after the fact from state the database already committed

**Prevents**

- [Dual-Write Inconsistency](../../../hazards/dual-write-inconsistency.md) — One authority: events are a projection of committed rows

**Demonstrated by**

- [Google News](../../../designs/google-news.md) — the feed cache is kept fresh by reacting to row-level changes in the article store rather than polling it or waiting on a time to live (TTL)
- [Yelp](../../../designs/yelp.md) — the search engine is a read model fed by the store's change stream, never the system of record
- [Tinder](../../../designs/tinder.md) — the profile-store-to-search-index sync is a change data capture (CDC) pipeline trading a small lag for decoupled writes
- [Ticketmaster](../../../designs/ticketmaster.md) — syncing a search-optimised store to the system-of-record in near-real time is a canonical change data capture (CDC) pipeline
- [Payment System](../../../designs/payment-system.md) — the design's whole durability guarantee rests on capturing changes below the application, exactly what change data capture (CDC) provides
- [CamelCamelCamel](../../../designs/camelcamelcamel.md) — CamelCamelCamel streams price-row inserts from its Postgres log to a Kafka topic that drives price-drop alerts

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Managed stores expose the log directly rather than making you tail it.

<!-- relationships:end -->
