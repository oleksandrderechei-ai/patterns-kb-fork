---
title: Monolithic Persistence
description: "Every kind of data in one store, whatever its access shape"
area: hazards
owner: Oleksandr Derechei
tags: [performance, isolation, data-access]
status: stable
aliases: [one database for everything, single-store persistence]
solves: [writing logs to the same database slows down checkout, we keep uploaded files as rows in the main database, a jobs table gets polled by every worker all day long, unrelated workloads run out of database connections together, business records and telemetry share one backup and one retention policy]
---

# Monolithic Persistence

Every kind of data the system holds — business records, logs, queued work, large files, cached values, telemetry — lives in one store, whatever its shape or access pattern. Workloads that have nothing to do with each other then contend for the same capacity, and most of them are held in an engine that was never built for them.

## What it is
<!--meta block=description-->

Monolithic persistence is using one data store for everything the system keeps, chosen once and never revisited as the kinds of data multiplied. You recognise it in the mix of load, not one slow query: the busiest tables hold audit rows, events and job state, while the transactional tables users wait on queue behind them. The defining trait is unlike workloads competing for one engine's connections, memory and disk.

## Explained
<!--meta block=explain-->

Monolithic persistence is using one data store for everything the system keeps, chosen once and never reconsidered as the kinds of data multiplied. Log lines, job queues, search and money-moving records all share the same connections, memory and disk bandwidth. A high-volume stream of appended records crowds out the transactional work users are waiting on, and one engine has to fit data it was never shaped for. Split by how the data is used, and start with whatever is loudest, not whatever is largest. Logs go first, since they are appended and not read on the request path (the path a user's request takes). Queued work comes next, because a polled table, one workers keep re-reading to find work, turns every idle worker into read traffic, and a real queue removes it. Read-heavy views can then move to a store built for reading. Split business data last, along ownership lines.

- **Lost transactions.** An order and its audit record no longer commit together; accept a lag or save an outbox row with the order.
- **More systems.** Every store you add needs backups and on-call, so justify each split with its share of the load.

**Example.** A database volume allows 10,000 I/O operations a second. Audit logging takes 6,000, polling the job table takes 2,500, and checkout needs 3,000 at peak, 11,500 in all. Checkout gets about 3,000 / 11,500 x 10,000 = 2,600, so it queues (assuming the volume shares I/O in proportion to demand; real engines vary, so measure). Move the logs to a log store and the jobs to a queue, and the database has 3,000 of 10,000 in use.

## How it happens
<!--meta block=causes-->

- **One store is what the team can already run.** Operating a second engine means new backups, new monitoring, new failure modes and new expertise, so adding a table to the store that already exists is not laziness — it is the cheaper decision on the day it is made.
- **The data kinds arrived one at a time.** Nobody chose to put logs, jobs and documents in the transactional store. Each was added alone, each addition was small, and the aggregate was never a decision anyone made.
- **A relational store can represent anything.** A column will hold a document, a blob, a serialized payload. Being able to store it is mistaken for being suited to storing it, and the difference only shows at volume.
- **Transactional convenience keeps them together.** Sharing one store means one transaction can span the business write and its audit record, which is a real guarantee — and it quietly couples the availability and capacity of two things that did not need to be coupled.
- **The access patterns were never written down.** Sequential high-volume writes, random reads of small records, rare reads of large objects and short-lived volatile values want different things from a store, and without that inventory the argument for splitting cannot be made.

## What it costs
<!--meta block=cost-->

- **Unrelated workloads throttle each other.** The rate of a background writer sets the latency of a user-facing read, so performance depends on activity the affected code has no relationship with — the shape of [Noisy Neighbour](./noisy-neighbour.md), inside a single store.
- **Capacity runs out for the whole system at once.** Connections, memory and I/O are pooled, so the load that exhausts them slows or fails every operation sharing the pool, not only the one that caused it.
- **Ill-suited data costs more than it should.** Large objects held as rows consume buffer memory that indexed lookups need and bloat every backup; volatile values written durably pay the full price of a guarantee nobody wanted.
- **Retention and durability get one setting for all.** Business records that must be kept for years and telemetry worth a fortnight share a backup schedule, a replication policy and a restore time, so one of the two is always over-served and paid for.
- **Scaling is mostly all-or-nothing.** Pressure is aggregate, so the main lever is a bigger machine. When that runs out, the answer is partitioning the whole store, when the need was to move one high-volume workload.
- **Maintenance and recovery are shared.** A heavy table's index build, migration or upgrade touches every workload, and restore time is set by the largest data in the store.

## Getting out
<!--meta block=mitigation-->

Separate data by how it is used, and start with the workload that is loudest rather than the one that is largest. Logs and telemetry are usually the first move and the cheapest: they are append-only, read by nobody on the request path, and lifting them out is a change to one writer. The rule underneath is fit — sequential high-volume writes belong somewhere built for sequential high-volume writes, and large binary content belongs in **[Object Storage](../patterns/distributed/routing/object-storage.md)** with only its key in the record that references it.

Queued work is the other easy win. A jobs table that is polled makes every worker's idle loop into read traffic on the transactional store; a real queue removes that load and gives you delivery semantics you were otherwise hand-rolling. Read models are the third: **[command query responsibility segregation (CQRS)](../patterns/architecture/cqrs.md)** lets a read-heavy view live in a store shaped for reading while writes stay where the invariants are, at the cost of a propagation lag that has to be visible to whoever reads it.

For splitting business data rather than technical data, the seam is ownership, not size. A **[Bounded Context](../patterns/ddd/bounded-context.md)** that owns its own store can be scaled and operated on its own terms; a split drawn anywhere else produces two stores that still have to be read together, which is worse than one. The price is paid in the transaction you lose across the seam — writes that used to be atomic now need an explicit way to converge, such as an outbox, a row saved with the business write in the same transaction and relayed to the other store later, and pretending otherwise is how [Dual-Write Inconsistency](./dual-write-inconsistency.md) arrives.

Before adding a store, try isolation inside the one you have: separate connection pools per workload, a read replica for reporting, and retention or partitioning for old audit rows.

Every store you add is one more thing to back up, monitor, patch and be woken by, so make the count a deliberate number rather than a consequence. Polyglot is a means, not a goal: three stores each earning their place beats seven adopted per team preference. Justify each split with the numbers you already have — the workload's share of the shared capacity, read from the engine's per-table I/O and per-client connection counts, and its access shape — and if you cannot show both, the honest first move is scaling up while you collect them.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Noisy Neighbour](./noisy-neighbour.md) — The single-store case: unlike workloads in one engine throttle each other.
- [Dual-Write Inconsistency](./dual-write-inconsistency.md) — Splitting stores breaks the shared transaction, and unsynchronised writes then diverge.

**Mitigated by**

- [Bounded Context](../patterns/ddd/bounded-context.md) — Split business data along ownership, so each context can operate and scale its own store
- [Object Storage](../patterns/distributed/routing/object-storage.md) — Large binary content leaves the record, which keeps only the key that points at it
- [CQRS](../patterns/architecture/cqrs.md) — Let a read-heavy view live in a store shaped for reading, while writes stay where the invariants are
- [Functional Partitioning](../patterns/distributed/routing/functional-partitioning.md) — Splitting by area stops one store serving every access shape badly

**Threatens**

- [Microservices](../patterns/architecture/microservices.md) — Services that share one database keep unlike workloads on one engine

<!-- relationships:end -->
