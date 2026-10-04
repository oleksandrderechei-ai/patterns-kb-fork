---
title: Busy Database
description: The database spends its shared capacity running application logic
area: hazards
owner: Oleksandr Derechei
tags: [performance, data-access, separation-of-concerns]
status: stable
aliases: [logic in the database, overused stored procedures]
solves: [the database is at full CPU and returning hardly any data, our stored procedures format the output and apply the business rules, throughput is capped by one database while the app servers are idle, we cannot add capacity because the bottleneck is the one shared database, the only place the business rules live is inside the data store]
---

# Busy Database

So much processing is pushed into the data store that it spends its capacity running application logic rather than storing and retrieving data. The work is on the one tier in the system that every request shares and that is hardest to add more of.

## What it is
<!--meta block=description-->

A busy database is a data store doing the application's work: formatting values, joining strings, converting result sets, evaluating business rules in procedures and triggers. You recognize it when the store's processor is pinned while the data it returns is small and the application servers sit idle. The defining trait is that the store is computing rather than reading, which separates it from slow queries or plain volume.

## Explained
<!--meta block=explain-->

A busy database is a data store that spends its processor time on the application's work, such as formatting dates and currency or running business rules in stored procedures (code kept and run inside the database), instead of finding and returning rows. Each step works and the data is right there, so nobody sees a capacity decision being made. The trouble is that every request shares the one store: you add application servers by changing a number but cannot add a second database without redesigning it. Choose this diagnosis over plain slow queries when the statements are computing rather than reading. Move out what only reshapes data, and keep in the store what shrinks the result, such as filtering, joining and totals. Put the moved rules in one service layer so the next rule has an obvious home. If work must stay near the data and is still costly, precompute it on a schedule.

- **Opposite failure.** Pulling a total out forces every row across the network, so keep shrinking work, such as filters and totals, in the store.
- **Staleness.** A precomputed result is bounded-stale and needs a refresh job you must run and watch.

**Example.** A 16-core database serves 500 order-list requests a second. Each spends 30 ms of processor time, 24 ms building display strings and 6 ms finding rows. That is 500 x 30 ms = 15 cores busy, 94%, so throughput stops near 530 requests a second while four 4-core application servers idle. Moving the formatting into the application leaves the database 500 x 6 ms = 3 cores, 19%. The application takes on 12 cores of work, 75% of its 16. The rows returned are unchanged, so no new network cost appears. The price is a code change, and the rules now need application tests.

## How it happens
<!--meta block=causes-->

- **The store is treated as a service rather than a repository.** It can run code, so it is asked to. Whether it ought to is a question nobody raises, because nothing about writing the procedure feels like a capacity decision.
- **Queries are written to return display-ready output.** Formatting dates and currency, building names, shaping the result into the transport format the client expects — all done in the query so the calling code can pass it straight through.
- **Over-correcting for over-fetching.** A team fixing [Extraneous Fetching](./extraneous-fetching.md) learns to move work toward the data, and keeps moving — past the reductions that were worth it and into transformations that were not.
- **Procedures are chosen as the home for business rules.** One deployable place, one language, no release coordination — appealing on maintenance grounds, and it quietly puts the rules on the tier with the least headroom and the most contention.
- **Nobody prices the shared tier.** Application instances are added by changing a number; a store is scaled up until it cannot be, and scaled out only by a redesign. Work placed there is therefore far more expensive than the same work placed anywhere else, and nothing in the development loop shows it.

## What it costs
<!--meta block=cost-->

- **The bottleneck lands where it is hardest to relieve.** Compute on the application tier is bought by adding instances; compute on the store is bounded by one machine until somebody re-partitions the data, which is a project rather than a setting.
- **Everything queues behind it.** The store is shared by every operation, so cycles spent formatting one report are cycles unavailable to unrelated queries, and response times degrade across the whole system rather than on the guilty path.
- **Throughput plateaus with capacity to spare.** Requests per second flatten while the application tier idles, so the system looks saturated at a level well below what its hardware bill implies.
- **Metered stores bill for the computation.** Where capacity is sold as a unit combining processor, memory and I/O, logic executed in the store converts directly into consumption of a quota that exists to serve data access.
- **The logic is harder to test and to change.** Rules living in procedures sit outside the application's test harness, its review path and often its release process, so they are the least verified code in the system and the most frightening to touch.

## Getting out
<!--meta block=mitigation-->

Draw the line at reduction. Let the store do what it is optimized for and what shrinks the result — filtering, joining, sorting, aggregating, anything that means fewer bytes cross the wire. Move out what merely reshapes: formatting, string building, serialization, and the business rules that decide what the answer means. Give those rules a home in the application with a **[Service Layer](../patterns/enterprise/service-layer.md)**, so there is somewhere obvious for them to go and the next one does not end up in a procedure by default.

The move only pays because of where the work lands. A **[Stateless Service](../patterns/distributed/routing/stateless-service.md)** tier holds no session of its own, so relieving the store means adding instances behind the balancer rather than planning a migration. Budget for that: the tier taking the work needs the headroom to do it, and a change that halves the store's utilization while doubling the application's has still bought you something, because only one of those two numbers is expensive to raise.

Do not overshoot into the opposite hazard. Pulling an aggregation out of the store so the application can sum the rows itself means dragging every row across the network to produce one number — the fix for a busy database becoming [Extraneous Fetching](./extraneous-fetching.md). Before moving any piece of work, ask what it does to the volume of data returned: if that number goes up, leave the work where it is and find the cycles somewhere else.

For work that must stay close to the data and is still expensive, stop paying for it per request. A **[Materialized View](../patterns/distributed/coordination/materialized-view.md)** computes the shape once on a schedule and turns the read into a lookup, converting a per-request cost into a background one — bought with staleness that has to be bounded to what the reader tolerates, and with a refresh job that is now part of what you operate. Where legacy procedures cannot be moved at once, move them one at a time and keep a facade in place, measuring the store's utilization after each: the goal is a store whose effort is proportional to the data it serves.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Extraneous Fetching](./extraneous-fetching.md) — Telemetry looks alike — a busy store — but here the store is computing, not shipping data it need not

**Mitigated by**

- [Service Layer](../patterns/enterprise/service-layer.md) — Give business rules a home in the application, so they stop landing in the store by default
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — Relieving the store only pays because this tier grows by adding instances rather than by migration
- [Big Data](../patterns/architecture/big-data.md) — Analytical reads on the operational store are what a separate analytics path takes off it.

<!-- relationships:end -->
