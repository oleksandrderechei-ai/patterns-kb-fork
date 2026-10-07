---
title: Extraneous Fetching
description: Reading far more data than the operation actually uses
area: hazards
owner: Oleksandr Derechei
tags: [performance, data-access, read-optimization, latency, throughput]
status: stable
aliases: [over-fetching, select star]
solves: [the query pulls back megabytes and the response is a few bytes, we read every row to compute one total, the screen shows twenty rows and the query returns all of them, the code fetches the whole record then keeps two fields, memory spikes on a request that returns almost nothing]
---

# Extraneous Fetching

An operation pulls back far more data than it will use — every column when it needs two, every row when it will show twenty, the whole table when it wants a single total — and then discards the remainder in memory. The work is done twice over: once to move the data, once to throw it away.

## What it is
<!--meta block=description-->

Extraneous fetching is reading more data than the operation uses: every column when two are needed, every row when the screen shows twenty, or raw rows the application filters or totals itself. You recognise it when a request reads hundreds of kilobytes to return a few dozen bytes, and when a query fast in testing slows as the table grows. The defining trait is the gap between bytes read and bytes returned, not slowness in one query.

## Explained
<!--meta block=explain-->

Extraneous fetching is reading data the operation never uses. It comes in three shapes: too many columns, where a query selects everything and the code keeps two fields; too many rows, where a read has no limit and the screen shows twenty; and work in the wrong place, where the application pulls rows to filter or total them itself. The cost is bytes read, moved and thrown away on every request, and it grows with the data, so a query that was fast in testing slows as the table fills. You find it by comparing bytes read from the store with bytes returned to the caller. Name the columns you need, put the filter and the total in the query, and give every read a page size. Precompute a read that is assembled over and over as a [materialized view](../patterns/distributed/coordination/materialized-view.md), and accept its staleness. Stop before moving formatting into the store, which creates a [busy database](busy-database.md).

- **Paging.** Deep pages need a key to continue from, so give clients a cursor rather than an offset.
- **Narrow queries.** A new column on the screen needs a new query; keep the projection in one reviewed place.

**Example.** An order screen shows a customer's last 20 orders, two fields each. The query selects every column with no limit. The customer has 5,000 orders of 2 KB each, so the database sends 10 MB. At 100 MB/s that is 100 ms before the application throws away 4,980 rows. Selecting only the id and total with a limit of 20 returns 20 x 40 bytes = 800 bytes, over 12,000 times less.

## How it happens
<!--meta block=causes-->

- **Over-correcting for chattiness.** A team that has just fixed too many small calls learns that fewer calls are better, and reaches the other extreme: one call that fetches everything the operation might need, most of which it does not.
- **Selecting everything by default.** Asking for all columns is shorter to write, survives a schema change without edits, and costs nothing visible until a wide row picks up a large text or binary column that every read now carries.
- **No limit on a growing set.** A read written against a table with a hundred rows needs no pagination and gets none; the same code meets a hundred thousand rows two years later, and nothing in it changed to say so.
- **Aggregating in the application.** Summing, counting or grouping in code means every underlying record crosses the wire so that a single number can come out the other end: the clearest case, where every record crosses the wire to produce one number.
- **A predicate the query layer cannot translate.** When part of a filter has no equivalent in the target query language, the abstraction silently evaluates it client-side. The code still reads as a filter, and the store still returns every row.
- **A shared read shaped by its most demanding caller.** One consumer needs the full object, so the single fetch used by all of them returns it, and every other caller pays for a payload it immediately narrows.
- **Eager relations by default.** The mapper joins related objects on every load, so a join fan-out multiplies rows the caller never reads.

## What it costs
<!--meta block=cost-->

- **Latency rises with payload, not with usefulness.** The bytes have to be read, serialized, transferred and deserialized before the code can discard them, and every one of those steps is paid in full on data that will never be looked at.
- **Memory spikes on the caller.** A result set sized by the table rather than by the screen has to fit somewhere first, so an operation that returns a few kilobytes can hold megabytes while it runs. The peak comes when concurrency is highest.
- **The store loses its own optimizations.** A narrow projection can often be answered from an index alone; asking for every column forces a lookup back into the base rows, so the query is not just larger but takes a slower path.
- **Contention grows with the read.** Longer scans hold their resources longer, evict more useful pages from the store's buffer cache, and saturate the network link between tiers, so unrelated queries slow down too.
- **The failure mode is a cliff, not a slope.** An unbounded read slows gradually while the data is small, then fails outright: a timeout or an exhausted heap, at a data volume nobody chose and no deploy announced.

## Getting out
<!--meta block=mitigation-->

Select only what the operation reads. Project the columns the operation actually reads, put the filter in the query rather than in the loop that follows it, and let the store compute the aggregate it is built to compute. Bound every read that is unbounded today: a page size fixes the cost of one page; deep offset pages still cost more, so continue by cursor. Where the caller's shape differs from the record's shape, name that shape: a **[data transfer object (DTO)](../patterns/enterprise/dto.md)** makes the narrow projection an explicit, reviewable contract rather than a habit that erodes on the next edit.

When one read serves several callers with genuinely different appetites, stop making them share. Split the object into the small part almost everyone wants and the bulky part few do, and serve the second only on request. Where a demanding read shape is assembled from the same sources over and over, precompute it as a **[Materialized View](../patterns/distributed/coordination/materialized-view.md)**, so the expensive assembly happens on a schedule rather than on the request path — paid for in staleness, which has to be bounded to what the reader can tolerate, and in a refresh job that is now part of the system you operate.

Push work toward the store, and know when to stop pushing. Filtering and aggregation belong there because that is what the engine is optimized for. Formatting, string manipulation and business rules do not, and moving them in to save a few bytes trades this hazard for [Busy Database](./busy-database.md): a shared resource that is usually far harder to scale out than the tier you took the work from. The dividing line is whether the operation reduces data or merely transforms it.

Instrument the ratio, because neither half of it alarms on its own. Compare bytes fetched with bytes returned per operation and treat a large disparity rather than waiting for the latency that only appears once the data has grown. Check the executed statement rather than the code that produced it; a query builder that silently evaluates a predicate in memory reads as correct and executes as a scan, and only the emitted query shows which one you got.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Chatty I/O](./chatty-io.md) — The opposite failure: fixing it by enlarging every call is how chattiness gets traded for waste
- [Busy Database](./busy-database.md) — Both show as a database-heavy operation, and their fixes push in opposite directions

**Mitigated by**

- [DTO](../patterns/enterprise/dto.md) — Name the narrow shape the caller needs, so the projection is a reviewable contract instead of a habit
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — Precompute the demanding read shape so the request reads an answer rather than assembling one
- [Vertical Partitioning](../patterns/distributed/routing/vertical-partitioning.md) — Keep the small hot columns apart from the bulky ones so most reads skip the bulk
- [Pagination](../patterns/distributed/routing/pagination.md) — A page size is what keeps a read from loading everything that has accumulated
- [CQRS](../patterns/architecture/cqrs.md) — A separate read model shaped per screen stops full-row and unbounded reads

**Threatens**

- [Repository](../patterns/enterprise/repository.md) — A generic repository returns whole entities when callers need two fields
- [Data Mapper](../patterns/enterprise/data-mapper.md) — The mapper loads full rows and objects by default
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — Fixed response shapes ship fields and rows the client never shows

<!-- relationships:end -->
