---
title: Index Table
description: "A second table keyed by the field you query, when the store has no secondary index"
area: distributed-data
owner: Oleksandr Derechei
tags: [data-modeling, data-access, read-optimization]
status: stable
aliases: [secondary index table, inverted lookup table]
solves: [the store only lets me look records up by id and i need to search by city, finding a record by any other field means scanning the whole table, our store has no secondary indexes and every query is a full scan, the shard key is hashed so i cannot do a range query at all]
---

# Index Table

Builds the secondary index by hand — a second table keyed by the field the query actually filters on, pointing at or duplicating the rows — for stores that offer lookup by primary key and nothing else.

## What it is
<!--meta block=description-->

Stores keyed only by primary key answer "give me this id" well, but any other question means reading everything. An index table is a second table you build yourself, keyed by the field you filter on, so a lookup becomes two cheap reads. It also restores range scans on a hashed shard key. It costs an extra write on every change.

## Explained
<!--meta block=explain-->

An index table is a second table you build and keep up to date, keyed by the field you search on, for stores that offer no secondary index. A lookup becomes one cheap read of the index instead of a scan that reads everything and throws most away. Choose it when your store cannot index that field for you, and when the query runs often enough to repay the extra writes. If the engine offers its own secondary index, use that, because it removes the maintenance you would otherwise write; check whether it is synchronous. You decide what the index holds. Copy only the primary key and the index stays small, but every read needs a second lookup. Copy everything and one read answers, at the cost of a full second copy. Copy the hot fields only, which is usually right.

- **A write per index.** Each index is another place to write. Build one only for a query you actually run.
- **Indexes drift.** Keeping several in step is hard. Post changes to a queue and accept a short window of disagreement.
- **Poor fit for low-variety fields.** Skip fields with few distinct values; the index narrows nothing.

**Example.** A users table of 20 million rows is spread over shards by hashed user id. Finding everyone in Lviv scans all rows at 100,000 rows a second, which takes 200 s. You add an index keyed by city that holds user id and name, so the same query is one range read of about 4,000 entries. A second index, by signup date, serves reports. The cost is that each signup now writes 3 times, one fact row and two index entries, so 1,000 signups a second means 3,000 writes a second. A queue applies the index writes, so a new user may be missing from the city list for a few seconds.

## How it works
<!--meta block=structure-->

```mermaid caption="What does a read cost, and who keeps the index true? Steps 2 and 3 are the two strategies — one hop if the index carries the data, two if it only points — and steps 5 to 7 are the price, paid on every write rather than on the query."
flowchart LR
    Q["Query by a non-primary field"]
    IX[("Index table — keyed by that field")]
    FT[("Fact table — keyed by primary or shard key")]
    W["Writer"]
    MQ[("Change queue")]
    Q -->|"1 lookup by the secondary key"| IX
    IX -->|"2 denormalised: answered here"| Q
    IX -->|"3 reference: returns the primary or hashed shard key"| FT
    FT -->|"4 fetch the row"| Q
    W -->|"5 write the row"| FT
    W -->|"6 enqueue the index change"| MQ
    MQ -->|"7 apply asynchronously"| IX
```

```mermaid caption="Asynchronous maintenance means the index is a hint, not a fact. A reader inside the window sees entries the fact table no longer supports, so a normalised index gets the truth for free on its second lookup and a fully denormalised one has to reconcile some other way."
sequenceDiagram
    autonumber
    participant A as Application
    participant F as Fact table
    participant W as Index worker
    participant I as Index table
    A->>F: update customer 42, town Oslo to Bergen
    F-->>A: committed
    A->>W: change event
    Note over I: index still lists 42 under Oslo
    W->>I: delete 42 from Oslo, insert under Bergen
    alt reader arrives inside the window
        A->>I: find customers in Oslo
        I-->>A: includes 42 — stale
        A->>F: fetch 42
        F-->>A: town is Bergen — verify before trusting the index
    end
```

## Variations
<!--meta block=variations-->

- **Full denormalisation** — Each index holds a complete copy of the record, ordered by its own key, so any query resolves in one lookup. Right when the data is near-static relative to how often it is read; wrong as soon as it churns, because every update now rewrites every copy.
- **Normalised reference index** — The index stores only the secondary key and the primary key, and the rows stay in the fact table. Smallest to store and cheapest to maintain, and every read pays a second round trip — which also means a stale index entry is caught by the second lookup rather than returned as truth.
- **Partial denormalisation** — The index duplicates the handful of fields the common query displays and references the fact table for everything else. The usual choice, because it buys the one-hop read for the queries that matter without buying a second copy of the whole dataset.
- **Composite key** — Where queries filter on a combination of fields, concatenate them into the index key. Entries then sort by the first attribute and by the second within it, so both the prefix query and the full combination are contiguous ranges — and the order you concatenate in decides which queries are cheap.
- **Index over a hashed shard key** — Key the index by the natural value and store the hashed shard key as the payload. This restores ordered and range access to a store whose [Sharding](../routing/sharding.md) scattered it, and the fact-row fetch goes straight to its shard.
- **Sharded index** — The index table is itself large enough to partition, and gets its own shard key. Worth remembering that this reintroduces the original problem one level down — an index sharded on the wrong key has the same access-path gap the fact table had.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **A full scan becomes a keyed lookup** or range read, so cost follows the number of entries returned rather than the size of the dataset.
- **Ordered and range access come** back to a hash-sharded store, which otherwise has no way to answer "everything between these two values".
- **The index already carries the shard key**, so the fact-row fetch goes straight to the right shard.
- **You choose the storage-versus-round-trip point** per index rather than accepting whatever the engine would have done.

### Cons
<!--meta polarity=con-->

- **Every write now writes in several places**, so write amplification scales with the number of indexes and it is paid on every update, not just the ones a query will use.
- **Keeping several indexes consistent** with the fact table is genuinely hard at scale, which usually forces an eventual-consistency design and a window where readers see entries the data no longer supports.
- **Duplication costs storage in proportion** to how much you copied, and the fully denormalised form doubles the dataset per index.
- **The normalised form costs** a round trip on every read, forever.
- **A speculative index is pure loss** — it is maintained on every write and never read, so build one only for a query the application actually performs.
- **A low-cardinality or heavily skewed key buys nothing**. If ninety percent of records share one value, maintaining the index costs more than scanning, unless the queries reliably target the sparse remainder.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The application frequently retrieves data** by a key other than the primary or shard key, and the store offers no secondary index of its own.
- **The store is sharded** on a hashed key and you need range or ordered access back.
- **The query set is known and stable**, so you can name which indexes will be read regularly.
- **Reads outnumber writes by enough** that write amplification is the cheaper side of the trade.

### Avoid when
<!--meta polarity=avoid-->

- **The engine already maintains secondary indexes.** Let it: an engine index removes the hand-built maintenance, though it still costs a write per change and may itself be asynchronous, so check which your store gives.
- **The data is volatile.** Every change must also write the index, so maintenance load and the stale window grow with churn, and maintenance can outrun the saving.
- **The candidate key has few** distinct values or a heavily skewed distribution, where a scan is competitive.
- **The real need is a precomputed answer** rather than a faster path to the rows — that is a [Materialized View](./materialized-view.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a partially denormalised index over a hash-sharded fact table"
type Customer = { id: string; town: string; lastName: string; email: string; notes: string }
// Partial denormalisation: carry the fields the list view renders, plus the
// shard key needed to fetch the rest. The lookup never recomputes the hash.
type IndexEntry = { town: string; lastName: string; shardKey: string; customerId: string }

interface Store {
  put(table: string, key: string, value: unknown): Promise<void>
  delete(table: string, key: string): Promise<void>
  get(table: string, key: string, shardKey: string): Promise<Customer | undefined>
  rangeScan(table: string, prefix: string): Promise<IndexEntry[]>
}

// Composite key: sorted by town, then by surname inside a town — so both
// "everyone in Bergen" and "the Olsens in Bergen" are one contiguous range.
const indexKey = (c: Customer) => `${c.town}#${c.lastName}#${c.id}`

// The index is a hint: re-read each fact row (the shard key routes the read)
// and drop entries the row no longer supports.
async function findByTown(store: Store, town: string) {
  const entries = await store.rangeScan('customers_by_town', `${town}#`)
  const rows = await Promise.all(entries.map(e => store.get('customers', e.customerId, e.shardKey)))
  return rows.filter((r): r is Customer => r !== undefined && r.town === town)
}

// Called by the worker draining the change queue, never inline with the write:
// the two tables are updated separately, so there is a window where they disagree.
// after === null means the customer was removed.
async function reindex(store: Store, before: Customer | null, after: Customer | null) {
  if (before && (!after || indexKey(before) !== indexKey(after))) {
    await store.delete('customers_by_town', indexKey(before))
  }
  if (after) {
    await store.put('customers_by_town', indexKey(after), {
      town: after.town, lastName: after.lastName,
      shardKey: hashShardKey(after.id), customerId: after.id,
    })
  }
}
```

## In the wild
<!--meta block=wild-->

- **Amazon DynamoDB global secondary indexes** — The managed version of exactly this pattern: an index with its own partition and sort key, maintained asynchronously by the service, and with a projection setting that is the denormalisation choice — KEYS_ONLY, INCLUDE for chosen attributes, or ALL. {#wild-dynamodb-gsi}
- **Apache Cassandra** — Its documented modelling guidance is to write the same data into several tables, each partitioned by the key one query filters on — hand-built index tables as the normal way to model, because the engine will not scan across partitions for you. {#wild-cassandra-materialized}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Projection breadth** — Which fields the index duplicates. Keys only is cheapest to maintain and costs a second read; all fields is one hop and a full second copy.
- **Composite key field order** — Decides which prefix queries are contiguous ranges, and therefore which queries are cheap.
- **Index maintenance lag budget** — How far behind the fact table an asynchronously-updated index may fall before it is considered broken. Compute it from the longest staleness the least tolerant reader accepts, and alert before it is reached.
- **Index shard key** — An index large enough to partition needs its own key, and the wrong one recreates the access-path gap one level down.

### Signals to watch
<!--meta polarity=signal-->

- **Index maintenance lag** — The age of the oldest unapplied change, which is the width of the window where readers see entries the data no longer supports.
- **Write amplification factor** — Writes to index tables per write to the fact table — the running cost of every index you kept.
- **Reads served per index** — An index with near-zero reads is being maintained on every write for nothing, and should be dropped.
- **Fetch-after-lookup miss rate** — Index entries pointing at rows that no longer match indicate the lag budget is being exceeded.

### Failure modes under load
<!--meta polarity=failure-->

- **Stale entries returned as truth** — A fully denormalised index has no second lookup to catch itself with, so it serves values the fact table has already changed.
- **Write path slows as indexes accumulate** — Each index added is another write per update, and the cost lands on the hot path rather than on the query.
- **Skewed key builds a hot partition** — An index on a low-cardinality or heavily skewed field concentrates traffic on one partition of the index.
- **Maintenance worker falls behind under load** — The asynchronous updater lags precisely when write volume is highest, so the index is least accurate when it is most read.

### Readiness checklist
<!--meta polarity=check-->

- Every index exists for a query the application actually performs, verified against real traffic.
- The staleness window is bounded, measured, and acceptable to each reader.
- Readers that cannot tolerate lag verify against the fact table before acting.
- Key cardinality and skew were checked before the index was built.
- Where the store allows it, fact and index rows sharing a partition are updated atomically.
- Index maintenance lag is alerted on, not merely graphed.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Scaling Reads](../../../themes/scaling-reads.md) — Build the missing secondary index yourself as a table keyed by the query field. {#fluency-scaling-reads}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Sharding](../routing/sharding.md) — Its highest-value use: keyed by the natural value, carrying the hashed shard key as payload
- [Change Data Capture](./change-data-capture.md) — Drives asynchronous index maintenance off the fact table's committed changes
- [Cache-Aside](../../caching/cache-aside.md) — Both trade a maintained copy for a cheaper read, and both owe you a staleness answer

**Often confused with**

- [Materialized View](./materialized-view.md) — An index gives a faster path to the rows; a view precomputes the answer itself

<!-- relationships:end -->
