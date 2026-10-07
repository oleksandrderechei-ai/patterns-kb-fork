---
title: Chatty I/O
description: Many small I/O calls where a few larger ones would do
area: hazards
owner: Oleksandr Derechei
tags: [performance, latency, throughput, data-access]
status: stable
aliases: [chatty interface, chatty API, talkative I/O]
solves: [one screen makes forty tiny calls before it can render, the trace is a long ladder of short identical spans, every call is fast and the whole operation is slow, the API has one endpoint per field so the client calls it six times, "response time grows with the number of items, not their size"]
---

# Chatty I/O

One logical operation is carried out as a long series of small I/O requests — a query per row, a call per field, a write per record. Each request is fast on its own, and the fixed cost every request pays, multiplied by how many there are, is what makes the operation slow.

## What it is
<!--meta block=description-->

Chatty I/O is an operation that crosses an I/O boundary far more often than it needs to: forty small queries to render a screen, six HTTP calls to read one object. You recognize it by a ratio, high calls per operation and low bytes per call, and by a ladder of short, near-identical spans in traces. The defining trait is that response time tracks item count, and the remote side reports each call as fast.

## Explained
<!--meta block=explain-->

Chatty I/O is an operation that crosses a boundary, such as a database, a remote service or a disk, many more times than it needs to. Every crossing pays a fixed toll for the round trip, the handshake and the setup, whatever the amount of data moved. So an operation that does little work still spends its time on the tolls, and its response time follows the number of items rather than their size. Choose the fix by who makes the calls. Inside one process, ask once for the whole set: one query with a join or a list of keys instead of one per row, or one buffered file write ([batching](../patterns/concurrency/batching.md)). Between a client and many services, put a [backend for frontend](../patterns/distributed/routing/bff.md), a small service that makes the internal calls on a fast network and returns one answer shaped for the screen. Then assert on calls per operation in tests, since average latency hides the count.

- **Overshoot.** One huge call that carries data nobody reads trades this for extraneous fetching. Split the object so the small hot part travels alone.
- **Extra surface.** A batch endpoint or aggregating service is one more thing to version and run.

**Example.** A product page shows 40 items and reads each item's price with its own query. Each query costs a 1.5 ms round trip plus 0.3 ms of work, so 40 x 1.8 ms = 72 ms. One query with a list of 40 keys costs 1.5 ms plus 4 ms of work, 5.5 ms. The page is about 13 times faster, and at 80 items the first design takes 144 ms while the second stays near 9.5 ms. The trap is putting every item's 200 KB description into the same query, which moves 8 MB to save a few milliseconds.

## How it happens
<!--meta block=causes-->

```mermaid caption="The work is tiny and the tolls are not. Each of the N requests pays the same setup, round-trip and teardown regardless of how little data it carries, so the total is governed by the call count rather than by the payload."
flowchart TB
    A["One logical operation<br/>“show this order”"] --> B{"split into N small requests"}
    B -->|"1 · connect, ask, wait, close"| C["request 1"]
    B -->|"2 · connect, ask, wait, close"| D["request 2"]
    B -->|"N · connect, ask, wait, close"| E["request N"]
    C --> F["N × fixed per-call cost<br/>swamps the bytes actually moved"]
    D --> F
    E --> F
```

- **Remote things are treated as local things.** An interface that reads naturally in memory — fetch the object, then read a field, then read another — turns each field access into a network round-trip once the object lives on the far side of a wire.
- **A fine-grained API invites fine-grained use.** Exposing one endpoint per property is defensible in isolation, and every client that needs six properties then makes six calls, because the interface never offered them a single one.
- **A loop crosses the boundary.** Any I/O placed inside an iteration makes the call count a function of the result-set size, which is small in development and large in production. The database form of this has its own name: the [N+1 Query](./n-plus-1-query.md).
- **The unit of work is the record rather than the batch.** A writer that opens, appends and closes once per record pays the file-open and flush costs per record, and on a spinning or log-structured store also fragments what it writes, taxing every later read.
- **Layers each add a hop nobody counted.** A helper that fetches what it needs is correct on its own terms; three of them composed into one request produce three round-trips, and no single author saw the total.
- **Lazy loading hides the query.** A lazy-loaded association turns a plain field read into a database call, so the loop that makes many calls is invisible in code review.

## What it costs
<!--meta block=cost-->

- **Latency adds up in series.** Requests issued one after another sum their round-trips, so an operation made of forty 5&nbsp;ms calls takes 200&nbsp;ms of pure waiting — and the far side, timed per call, looks perfectly healthy throughout.
- **Response time scales with item count, not data size.** Ten rows return in a blink; a thousand take on the order of a second or more at a millisecond or two per call, because time follows call count.
- **Throughput falls before latency alarms when the pool is shared and near its limit.** Each call holds a connection, a slot and a thread for its round-trip, so pool occupancy grows with call count times round-trip time and unrelated requests queue behind it. See [Connection Pool Exhaustion](./connection-pool-exhaustion.md).
- **The far side pays the overhead too.** Parsing, planning, authorizing and logging happen once per request, so a caller that splits one question into forty spends forty times the server-side fixed cost to learn the same thing.
- **Metered dependencies bill per call.** Where the dependency charges by request or enforces a per-second quota, chattiness converts directly into cost and into throttling that arrives long before the system is actually busy.
- **Tail latency compounds.** An operation made of many calls is as slow as its slowest one, so the page is slow far more often than any single call.

## Getting out
<!--meta block=mitigation-->

Move the boundary crossing out of the loop and ask once for the whole set. For a data store that means one query with a join or an `IN` list in place of one query per row; for a remote service it means an endpoint shaped around what a caller actually does, so the six field reads become one object read; for a file it means buffering the records and writing them in a single pass. **[Batching](../patterns/concurrency/batching.md)** is the general form of all three — accumulate the requests, issue one call, distribute the answers. When calls cannot be merged, issue them concurrently or over one multiplexed connection; that cuts the serial sum but not the server-side overhead per call. Cap each batch at the store's parameter or payload limit and chunk above it.

When the chattiness lives between a client and a fleet of services rather than inside one process, put the aggregation where the calls are cheap. A **[Backend for Frontend](../patterns/distributed/routing/bff.md)** makes the several internal calls on a fast internal network and returns one client-shaped response, turning six round-trips over a mobile link into one. The price is a component that must be versioned alongside the screens it serves, and that becomes a bottleneck of its own if every team's aggregation lands in it.

Do not overshoot. Fewer, larger calls is the fix only up to the point where the larger call carries data nobody reads, and past that point you have traded this hazard for [Extraneous Fetching](./extraneous-fetching.md). Split the object instead: return the small, frequently read part in the common call and leave the rare, bulky part behind a second one. Where the same answer is requested repeatedly, the cheapest call is the one not made at all — a cache removes the round-trip on a hit, at the price of stale data and an invalidation rule, rather than enlarging it.

Make the count visible or it will grow back. Assert on calls per operation in a trace, not on average latency: chattiness is linear in a number your dashboards do not plot, and the first regression looks like a slightly slower page rather than a defect. Where the data-access layer can refuse an unplanned lazy load, turn that on — a reintroduced loop then fails in a test run instead of degrading quietly, at the cost of every association having to be declared by the query that needs it. Read the count from trace spans per request, set the budget from the count at a known item count, and fail the test when it grows with item count.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Connection-Pool Exhaustion](./connection-pool-exhaustion.md) — Each call holds a connection for its round-trip, so a chatty operation drains the pool and unrelated requests queue.

**Generalizes**

- [N+1 Query](./n-plus-1-query.md) — The database case of the same defect — a boundary crossing placed inside a loop over rows

**Often confused with**

- [Extraneous Fetching](./extraneous-fetching.md) — The opposite failure, and the usual result of over-correcting this one: too few calls carrying too much

**Mitigated by**

- [Batching](../patterns/concurrency/batching.md) — Accumulate the per-item requests and issue one keyed call, so the count stops tracking the result size
- [Backend-for-Frontend](../patterns/distributed/routing/bff.md) — Make the several calls on a fast internal network and return one client-shaped response
- [Unit of Work](../patterns/enterprise/unit-of-work.md) — Write-side case: per-object saves are fixed by one tracked flush
- [Cache-Aside](../patterns/caching/cache-aside.md) — A cache skips the round-trip for repeated requests, at the price of stale data and an invalidation rule.

**Threatens**

- [Repository](../patterns/enterprise/repository.md) — A repository that loads per item or per field makes one query per row
- [Data Mapper](../patterns/enterprise/data-mapper.md) — Lazy loading in the mapper fires a query per association
- [Microservices](../patterns/architecture/microservices.md) — Fine-grained services need many calls to render one screen

<!-- relationships:end -->
