---
title: Vertical Partitioning
description: "Split an entity by column, so a read touches only the fields it needs"
area: distributed-scale
owner: Oleksandr Derechei
tags: [partitioning, read-optimization]
status: stable
aliases: [column partitioning, hot-cold split, row splitting]
solves: [the listing query reads a megabyte per row to display two fields, a stock counter updated on every order keeps invalidating the cached product page, the table has forty columns and the hot query needs three of them, backups are enormous because the database stores images nobody ever queries, only four fields are sensitive but the whole table is under the strict access policy]
---

# Vertical Partitioning

Cuts one wide entity into narrow ones along its columns, grouping fields by how they are actually used rather than by what they describe. The hot fields every request reads live in one partition, the bulky or rarely-read ones in another — so the common query stops paying for data it never looks at.

## What it is
<!--meta block=description-->

A database reads whole pages, so a query for a product's name and price also drags in the description, images and stock history stored beside them. Vertical partitioning splits one record by field: the fields read on almost every request go in one table, the bulky or rarely read ones in another, both keyed by the same ID. Hot queries then read less and cache better.

## Explained
<!--meta block=explain-->

Vertical partitioning splits one record by field: the fields read on almost every request go in one table, and the bulky or rarely read ones go in another, both keyed by the same ID. A database reads whole pages, so a query for a product's name and price also drags in the description, images and stock history that share its page. A narrow hot table fits more rows per page, so more of it stays in memory and each query reads less, with no change to the query. The split also separates slow-changing fields from a counter updated on every order, and lets sensitive fields have stricter access. Choose it over [sharding](sharding.md) when the trouble is wide rows, not too many rows. Skip it when most queries want most of the record, or on a column store, which already reads only the columns a query names.

- **Halves drift apart.** Nothing keeps the two tables in step, so write both in one transaction or run a repair job.
- **Joins you write.** A query needing both halves is a join you maintain, so split only where access patterns truly differ and measure first.
- **Frozen access pattern.** The split bakes in today's reads, so changing it later is a data migration.

**Example.** A products table has 10 million rows of 2 KB each, 20 GB in all, and pages of 8 KB hold 4 rows. List queries need only name and price, which fit in 128 bytes. Moving them to a hot table makes it about 1.3 GB, which fits in a 4 GB cache, and a page holds 64 rows. The list query no longer touches the 20 GB. The cost is the product detail page, which now joins both tables for one extra lookup, and any change to a product must write both halves together.

## How it works
<!--meta block=structure-->

```mermaid caption="Why does narrowing the row speed up a query that already selected only two columns? Because the store reads pages, not columns — a narrow partition fits more rows per page, so the same listing costs fewer reads and stays cached longer."
flowchart LR
    L["Listing query"]:::ext
    D["Detail query"]:::ext
    subgraph Ent["One entity, two partitions, same key"]
        H[("Hot: id, name, price")]
        C[("Cold: id, description, images, stock")]
    end
    L -->|"1 read the fields the list shows"| H
    H -->|"2 narrow rows, more per page, high cache hit"| L
    D -->|"3 open one product"| H
    D -->|"4 fetch the rest by the same key"| C
    C -->|"5 the join is now the application's job"| D
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What did the split cost? The store guaranteed the row was consistent with itself; two partitions are two objects, so keeping them in step becomes a transaction you must scope deliberately or a compensation you must write."
sequenceDiagram
    participant A as Application
    participant H as Hot partition
    participant C as Cold partition
    A->>H: UPDATE price
    A->>C: UPDATE stock_count
    Note over H,C: two writes, one logical entity
    A--xC: the second write fails
    Note over A: the store enforces nothing across partitions
    A->>H: compensate, or wrap both in one transaction
```

## Variations
<!--meta block=variations-->

- **Hot/cold column split** — The everyday form: fields read on nearly every request in one partition, everything else in another, keyed identically. It is the version to reach for first because the benefit is measurable before you build it — profile the top queries, count the bytes they read and never use. Keep both partitions in the same store, where a local transaction still covers a write that touches both.
- **Read-rate versus write-rate split** — The columns are grouped by how often they change rather than how often they are read. Slow-moving descriptive fields become safe to cache aggressively, because the counter that updates on every order no longer invalidates the page they share. It makes caching the slow half worthwhile when the counter's churn was the main source of invalidations.
- **Sensitive-field split** — Regulated or confidential fields move to their own partition with their own access controls, encryption and audit trail. It shrinks the surface that needs the strict handling, so the ordinary query path stops carrying compliance weight it does not need. The cost is that any operation genuinely needing both halves now crosses a security boundary on purpose, which is the point.
- **Large payload to [object storage](./object-storage.md)** — The cold partition is not a table at all: images, documents and blobs move to object storage and the hot row keeps only a reference. The database stops paying to store and back up bytes it can never query, and the payload can be served directly to the client. You have crossed a store boundary, so there is no transaction covering both — orphaned objects and dangling references are now real, and a [sweeper](../coordination/sweeper.md) is part of the design.
- **Column families in a wide-column store** — The split is expressed as a physical grouping inside one logical table, and the engine reads only the families a query names. There is no second object, so integrity and joins are unaffected, and the layout can be tuned per family. It requires a store built for it, and the grouping is close enough to permanent that changing it later means rewriting the data.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The common query stops reading** bytes it never uses, so its cost drops without any change to the query.
- **Narrow rows pack more entries** per page and per cached block, which raises the hit rate for the same memory.
- **Slow-moving fields separated** from fast-moving ones become genuinely cacheable, because a hot counter no longer invalidates them.
- **Sensitive fields** can carry stricter controls than the rest of the entity, shrinking what has to be handled carefully.
- **Each partition can sit** in the store that suits it — a row store for the hot fields, object storage for the bulk.

### Cons
<!--meta polarity=con-->

- **One entity becomes two objects**, and nothing forces a detail row to exist or match the hot row; a foreign key guards only the key, so the rest is your transaction.
- **Any query wanting both halves** is now a join you write and maintain, and it is slower than the read it replaced.
- **The split encodes today's access** pattern into the schema, and changing it later means migrating data rather than editing a query.
- **A write touching both partitions** needs a transaction scoped over both, or a compensation for the half that failed.
- **No transaction across stores** covers both halves, so orphaned payloads and dangling references need a reaper you run.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Profiling shows the hottest queries** read a small fraction of each row and pay for all of it.
- **An entity carries large fields** — documents, images, serialised blobs — that most reads never touch.
- **Some fields change constantly while others barely change**, and the churn is defeating your cache.
- **A few fields are sensitive** enough to want their own access controls and audit trail.

### Avoid when
<!--meta polarity=avoid-->

- **Most queries want most of the entity**, where the split only adds a join to every read.
- **The entity is narrow already**, where the saving is smaller than the complexity it buys.
- **The real problem is volume rather than width**, where partitioning the rows across nodes is the axis that helps.
- **The store already reads by column family**, where a physical grouping gets the same result without a second object.

## Code sketch
<!--meta block=sketch-->

```sql summary="SQL — one entity split by access pattern, with the write kept atomic"
-- HOT: what the listing and search read. Narrow on purpose: more rows per
-- page and a higher cache hit rate.
CREATE TABLE product (
  id           bigint PRIMARY KEY,
  name         text        NOT NULL,
  price_cents  integer     NOT NULL,
  updated_at   timestamptz NOT NULL
);
-- COLD: the bulk nobody reads until a product is opened. Same key, one row each.
CREATE TABLE product_detail (
  product_id   bigint PRIMARY KEY REFERENCES product(id) ON DELETE CASCADE,
  description  text,
  spec_sheet   jsonb,
  image_keys   text[]        -- references into object storage, not the bytes
);
-- VOLATILE: updated on every order, so its churn stops invalidating the cold page.
CREATE TABLE product_stock (
  product_id   bigint PRIMARY KEY REFERENCES product(id) ON DELETE CASCADE,
  on_hand      integer     NOT NULL
);

-- The listing pays for nothing it does not show.
SELECT id, name, price_cents FROM product WHERE price_cents < 5000 LIMIT 25;

-- Same store: one transaction spans the partitions. Split across two STORES
-- and this guarantee is gone — then it is a compensation you write.
BEGIN;
  UPDATE product       SET price_cents = 4200, updated_at = now() WHERE id = 7;
  UPDATE product_stock SET on_hand = on_hand - 1                  WHERE product_id = 7;
COMMIT;
```

## In the wild
<!--meta block=wild-->

- **Apache Cassandra** — A query can name just the columns it needs, so a wide row is not returned whole. The layout is one table rather than a second object, so the integrity cost of vertical partitioning largely disappears here. {#wild-cassandra}
- **Apache HBase** — Column families are stored in separate files and can be configured independently: different compression, block size and in-memory setting, so hot and cold groups of a wide row are tuned separately. {#wild-hbase}
- **PostgreSQL TOAST** — The engine already does a version of this without being asked: an oversized field is moved out of the main row into a side table and fetched only when the query references it, so scans of the main table read narrower rows. {#wild-toast}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Which columns are hot** — The cut line itself. Base it on profiling the top queries rather than on how the entity reads on a whiteboard, and expect to revisit it when the access pattern shifts.
- **Store boundary** — Whether both partitions live in one store or the cold half moves elsewhere. Inside one store a local transaction still covers a write to both; across stores it does not, and that is the single biggest consequence of the split.
- **Denormalised columns** — Cold fields copied back into the hot partition because a query wants them together often. Each copy removes a join and adds a value that can go stale.
- **Row width and rows per page** — How many rows a page holds after the split, read from the table's average row size. The pattern works only if this number rises, so measure it. Fill factor is a separate setting that reserves update headroom, so it is not this number.

### Signals to watch
<!--meta polarity=signal-->

- **Bytes read per row returned** — How much the store touched to answer the hot query. The number should fall sharply after the split; if it does not, the cut line is wrong.
- **Buffer cache hit ratio on the hot partition** — Narrow rows should raise it for the same memory. A flat ratio means the hot partition is still carrying something bulky.
- **Cross-partition join rate** — How often a query needs both halves. Rising steadily is the signal that the access pattern has moved and the split no longer matches it.
- **Orphaned cold rows and dangling references** — Rows in one partition with no counterpart in the other. Across a store boundary this only ever grows unless something reaps it.

### Failure modes under load
<!--meta polarity=failure-->

- **The split made things slower** — The cold columns turn out to be needed by the hot query after all, so every read is now two reads and a join. It shows up as extra latency once load is realistic. Reverting means merging the tables back, a data migration, so measure before splitting.
- **Partitions drift out of step** — A write updates one partition and fails on the other, leaving an entity that is internally inconsistent. The store enforces nothing, so nothing raises an error at the time.
- **Orphaned payloads across a store boundary** — An entity is deleted and its object-storage content is not, or the reverse. Storage cost grows quietly and a reference eventually resolves to nothing.
- **Access pattern moves and the schema does not** — A field promoted to the hot path stays in the cold partition, so the flagship query silently pays for a join nobody remembers adding.

### Readiness checklist
<!--meta polarity=check-->

- The split is justified by a profile of the top queries, not by the shape of the entity
- Both partitions share one key, so joining them is identity rather than a lookup
- Writes touching both partitions are wrapped in one transaction, or have a written compensation
- Bytes read per query was measured before and after, and it actually fell
- Anything split across a store boundary has a reaper for orphans on both sides
- The cross-partition join rate is monitored, so a drifting access pattern is visible

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Performance](../../../themes/performance.md) — Stop the hot query paying for columns it never reads {#fluency-performance}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Object Storage](./object-storage.md) — The cold half is often not a table at all: large content moves to object storage and the hot row keeps a reference
- [In-Process Cache](../../caching/in-process-cache.md) — Splitting slow-moving fields away from a counter updated on every write is what makes the slow half worth caching

**Alternative to**

- [Sharding](./sharding.md) — Splits the same entity by column instead of splitting the rows across nodes — the other axis of the same decision

**Often confused with**

- [Functional Partitioning](./functional-partitioning.md) — Splits one entity by column so a read touches fewer fields

**Prevents**

- [Extraneous Fetching](../../../hazards/extraneous-fetching.md) — Splitting an entity by column lets a read touch only the fields it needs

<!-- relationships:end -->
