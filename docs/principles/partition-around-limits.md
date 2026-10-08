---
title: Partition Around Limits
description: "Name the ceiling you will hit first, then split before you reach it"
area: principles-systems
owner: Oleksandr Derechei
tags: [partitioning, isolation, resource-management]
status: stable
solves: [one table got so big that every query against it times out, we hit a limit we did not know the platform had and everything stopped, one customer sends so much traffic that everyone else slows down, we split the data and one of the pieces still takes almost all the load, my queue backs up under load and adding more consumers does not drain it any faster]
---

# Partition Around Limits

Everything you build on has a ceiling — rows per table, connections per pool, requests per account, messages per queue, cores per quota. Find the one you will reach first, then divide the work so that no single unit of it ever gets close, and so that the unit which does fails alone.

## What it says
<!--meta block=description-->

Divide the system so that no single unit approaches the ceiling of anything it runs on. Name the ceiling first, with its number, its current value and the distance between them, and only then choose where the line goes. A split aimed at the wrong ceiling costs complexity and buys nothing. Ceilings nest across layers, such as rows, connections, file handles and requests per account; measure each distance to find the one that binds first.

## Explained
<!--meta block=explain-->

Partitioning around limits means you divide the system so that no single unit nears the ceiling of anything it runs on, after naming that ceiling with its number and your distance from it. A split aimed at the wrong ceiling buys complexity and nothing else. Ceilings are layered, such as rows per table, connections per pool, requests per second per account and messages per queue, and the one that binds, meaning the one you hit first, is rarely the one planned for. Choose partitioning over a bigger machine only when measuring shows the binding ceiling cannot be raised. Pick a key that spreads load evenly, carry it with every request so a query reaches one partition, and split at the lowest level that solves the problem.

- **Early splitting.** Joins and tooling cost you against a limit that may never come; start when growth reaches it within a rehearsed split's lead time.
- **Costly to move.** Choose a key whose meaning survives product changes, and use consistent hashing, which moves few keys when the count changes.
- **More to run.** Every partition needs backup, monitoring and patching, so keep the count as low as the ceiling allows.

**Example.** A chat service stores 400 million messages in one table and the team fears the table size. They measure: the database allows 500 connections, the app uses 450, and storage is at 20%. The binding ceiling is connections, so splitting the table would have solved nothing. They add a connection pooler, which lifts that ceiling. Later one big customer sends 60% of traffic, so keying by customer id would create a hot partition, and they key by a hash of the conversation id instead. Listing one customer's messages now queries every partition, so they keep a per-customer index. That index is keyed by customer, so the big customer's index runs hot and every write touches two stores.

## Why it helps
<!--meta block=rationale-->

An unpartitioned unit has one ceiling, and it moves only by migration or a quota change. A partitioned one has a ceiling per partition, so growth becomes an arithmetic problem you solve by adding partitions rather than a cliff you hit at an hour of someone else's choosing. The second gain is containment: a partition that exhausts its own limit exhausts it alone while partitions share no pool, router or deploy path, which turns a total outage into a fraction of customers seeing errors while everyone else keeps working. This is the same argument that makes a [Bulkhead](../patterns/distributed/resilience/bulkhead.md) worth its overhead.

Partitioning also makes capacity knowable, which is worth as much as the capacity itself. A bounded unit can be load-tested to its own ceiling, and once you know what one partition holds you can multiply, plan the next split against a growth rate, and set an alert at a percentage of a number you actually know. An unbounded shared unit gives you no such figure: you learn where its limit was on the day you crossed it, from your customers, during an incident.

## Applying it
<!--meta block=applying-->

Name the ceiling first, and only then choose where the line goes:

- Write down the limit you are partitioning around, with its number and your current distance from it. Splitting a table across ten nodes does nothing for a per-account request quota that all ten still count against, and you will not discover that until the split is done and the errors are unchanged. If nobody can state the ceiling, the partition scheme is guesswork with a migration attached.
- Pick the key on how traffic distributes, not on what is convenient to read. A key that concentrates load has moved the problem rather than solved it, and the result is a [Hot Partition](../hazards/hot-partition.md) doing most of the work while its peers idle. Hash a high-cardinality identifier. Avoid surnames or timestamps as the key for write-heavy load, since today's traffic lands in one place; time ranges fit when you drop data by age and spread writes another way. Hashing gives up range scans and ordering, so keep a read model for them, and chart per-partition load against the mean to catch skew.
- Partition at the lowest level that solves the problem. The hierarchy runs from a table, through a database, a service and a cluster, up to a whole account, and every step up multiplies what you operate while making the decision harder to reverse. Splitting one table is cheaper to reverse than splitting an account, though it still needs a backfill; splitting one account is a second copy of everything you run, including the parts that were fine.
- Remember that queues, caches, pools and accounts partition too. A shared worker pool where one tenant's slow requests starve everyone else is a [Noisy Neighbour](../hazards/noisy-neighbour.md) problem with a partitioning answer: separate pools, or a per-tenant cap enforced by a [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md), so one caller's appetite meets a limit that is theirs alone.
- Carry the partition key with the work. A request that arrives without enough information to name its partition must be sent to all of them, and its latency becomes whatever the slowest one costs. Put the key in the path, the message header or the token, and design the queries that cannot carry it as their own read model rather than as a scan.
- Choose a scheme that survives resizing, and rehearse the resize. Splitting by a modulus of the partition count moves nearly every key when the count changes, which is why [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) or an explicit range map is worth the extra indirection, because the first split you make is never the last. Or fix a high logical partition count up front and move whole partitions between nodes. Rehearse on a production-sized copy, time it, and verify row counts per partition before cutover. A rebalance path you have never executed is a rebalance path that does not work.
- Let the domain draw the line where it already has one. A [Bounded Context](../patterns/ddd/bounded-context.md) that owns its data splits schema and load in the same cut, and that boundary holds through reorganisations because it follows meaning rather than a hash. Where the domain offers no such seam, [Sharding](../patterns/distributed/routing/sharding.md) on a synthetic key is the honest fallback.
- **Set the split trigger from time, not hope.** Read the ceiling from the engine or provider docs, confirm it by load-testing one unit, and start when time to the ceiling falls below the time a rehearsed split takes, plus a margin your team sets.

Two questions decide the whole design: which ceiling binds first, and which key spreads load evenly beneath it. A partitioning plan that cannot answer both is complexity you will maintain for no return.

## Taken too far
<!--meta block=overreach-->

Partitioning before you are near any ceiling pays the whole cost up front for a benefit that arrives on a date you invented. From the first day you write joins that span nodes, transactions that cannot span them, and tooling that has to know which unit holds what. You do this to stay clear of a limit that is two years or two orders of magnitude away, and may never arrive at all. One machine holds often more than estimated; check by load test.

The line, once drawn, is the expensive part to move. A key you cannot change without rewriting every row commits you to a distribution you chose before you had traffic to observe, so pick one whose meaning will still be true after the product changes. Watch the crossings, too: a query that spans partitions costs whatever the slowest partition costs, and a write that spans two is a distributed transaction carrying all the agreement you split the data to avoid. Once a meaningful share of your operations cross the boundary, the boundary is in the wrong place, and correcting it moves data rather than configuration. Track the share of requests that touch more than one partition and agree a limit before you split. Unique constraints and secondary indexes also stop being local and need their own structure.

Operational cost then grows with the count, with no natural stopping point. Every partition is another thing to back up, restore, patch, monitor, fail over and rebalance, and the shell script that handles four of them is a platform team at four hundred — so treat partition count as a number to keep as low as the binding ceiling permits, not as a score. The ceiling itself can also move: a quota someone else sets can be raised on request or lowered on their schedule, and a storage engine's practical limit shifts with a version upgrade. Re-measure before the next split.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Design to Scale Out](./scale-out.md) — Partitioning is what scale-out does when a ceiling gets in the way
- [Sharding](../patterns/distributed/routing/sharding.md) — Split the data when one store's ceiling is the one you hit first
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — Adding a partition should not reshuffle everything already placed
- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — A partition is a blast radius as well as a capacity unit
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — A quota you enforce is a limit you stop hitting by accident
- [Bounded Context](../patterns/ddd/bounded-context.md) — Functional partitioning follows seams the domain has already drawn

**Prevents**

- [Hot Partition](../hazards/hot-partition.md) — The key is the whole decision; pick one whose values actually spread
- [Noisy Neighbour](../hazards/noisy-neighbour.md) — Give each tenant its own ceiling instead of one shared pool
- [Hot Key](../hazards/hot-key.md) — Spread the key space rather than concentrating traffic on one value
- [Starvation](../hazards/starvation.md) — Sizing each partition to its own limit stops one tenant taking the shared pool

<!-- relationships:end -->
