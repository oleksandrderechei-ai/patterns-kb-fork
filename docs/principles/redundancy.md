---
title: Make Everything Redundant
description: "Two of everything, failing independently, with a rule for who decides"
area: principles-systems
owner: Oleksandr Derechei
tags: [resilience, availability, isolation]
status: stable
solves: [we have three instances and all three went down in the same minute, one bad config push took out every copy of the service at once, losing a single machine costs us an hour of downtime, "we never tested our spare copy taking over, so we do not know the backup works", both halves of the cluster kept accepting writes and now the data disagrees]
---

# Make Everything Redundant

Run more than one of everything on the critical path, and make sure the copies cannot fail for the same reason. Redundancy buys availability only when the copies are isolated from each other and something can decide which one is authoritative — two instances sharing a rack, a deployment or a bug are one instance with two invoices.

## What it says
<!--meta block=description-->

Run more than one of every component a request passes through, and make each copy fail for its own reasons. Each single instance, queue, primary or pipeline is a part whose loss is the system's loss. A second copy turns an outage into a degraded minute, but only if losing one leaves the other standing. Two copies sharing a rack, power feed, config push or bug are one copy, and deciding which is authoritative is where the cost lives.

## Explained
<!--meta block=explain-->

Redundancy means running more than one copy of every part a request depends on, with each copy able to fail for its own reasons, so one loss becomes a degraded minute instead of an outage. Two copies that share a rack, a power feed, a config push or a bug are one copy with two invoices, because whatever kills one kills both. So count failure domains, not instances. Choose it over making one part more reliable when a single loss is unacceptable, and choose limiting what one failure can reach when that is cheaper, since it costs a boundary rather than a second copy of everything. Copies add a question: which one is right? If the network splits, both halves accept writes that cannot be merged, so settle authority by majority vote before the split. Size the survivors for the loss, because when one of three instances dies the other two carry half as much again. Roll changes out in waves, because a config push reaches every copy at once.

**Example.** A service runs 2 instances at 70% load each. When one dies, the other must carry 140% of what it can serve and falls over, so the spare only hid a capacity problem. The team moves to 3 instances in 3 zones sharing the same load, about 47% each. When one dies, the other two carry 70% each and keep serving. Then a bad config pushed to all three at once takes them down in a minute, so changes now roll out one instance at a time with a 10-minute soak. The cost is a third instance on the bill and deployments that take 30 minutes instead of 10.

## Why it helps
<!--meta block=rationale-->

Independent failures multiply. If one instance is unavailable an hour a month, and a second fails for unrelated reasons, both being down together is a rare intersection rather than a monthly event; the same two instances sharing a cause stay at one hour. Unavailable about 0.14% of the time each (1 hour of 730), two independent copies are both down about 0.0002% of the time, about 5 seconds a month. The gain comes from the independence rather than the number, which is why the useful question about a redundant design is not how many copies it has but what single event could take them all.

Spare capacity also buys the right to do maintenance during the working day. A service with no spare has to be patched, resized and re-deployed in a window nobody is watching, which is how change becomes rare and rare change becomes risky. With a spare, removing one instance is a routine that runs constantly. A failover you exercise on purpose, on a schedule you set, is far likelier to work the day it happens on its own.

## Applying it
<!--meta block=applying-->

Add copies where a single loss is unacceptable, and make each copy fail for its own reasons:

- Take the state out of the instance first. A [Stateless Service](../patterns/distributed/routing/stateless-service.md) is redundant by construction — any instance serves any request, so replacing one is a routing change rather than a recovery. Whatever state remains is where the hard part of this principle lives.
- Put something in front that notices. A [Load Balancer](../patterns/distributed/routing/load-balancer.md) delivers redundancy only if it health-checks and drains. A spare that keeps receiving requests from a balancer with no health check is not a spare; it is a second source of errors.
- Copy data deliberately and know which mode you bought. [Replication](../patterns/distributed/coordination/replication.md) that acknowledges before the copy lands keeps writes fast and loses the most recent ones on failover; replication that waits pays the latency on every write and loses nothing the waited-on copies hold, so name how many copies must confirm. Choose per dataset, not per system.
- Spread the copies across failure domains you can name — different host, rack, power feed, network path, region. Each level costs more and removes one more shared cause, so write down which level you bought. That sentence is your availability claim.
- Settle who is authoritative before the partition rather than during it. [Leader Election](../patterns/distributed/coordination/leader-election.md) over a [Quorum](../patterns/distributed/coordination/quorum-consensus.md) produces an answer a majority agrees on; without one, two survivors both believe they are in charge and both accept writes. Use an odd voter count (2f+1: 3 tolerate one loss, 5 tolerate two). Two sites cannot form a majority after a cut, so spread voters over three failure domains or put a small witness in a third.
- Stagger every change that touches all the copies. A config push, a schema migration or an image rollout reaches every replica at machine speed, and that is a failure mode more copies do nothing about, as are shared upstream dependencies such as DNS or identity. Deploy in waves with a soak between them, so the first wave finds the defect while the rest are still serving. Abort the next wave when the error rate or latency of the one before rises above its baseline.
- Size the survivors for the failure, not for the average. When one of three instances dies the other two carry half as much again; provisioned for the average, they meet the loss already full. Pair that headroom with a [Bulkhead](../patterns/distributed/resilience/bulkhead.md) so a saturated pool cannot spread into the ones that are still healthy. With N copies, peak load must stay under (N-1)/N of fleet capacity: 50% for 2, 67% for 3, 75% for 4; alert when peak crosses that line. If you take instances out for maintenance in the working day, size for that loss plus a failure.

Redundancy is bought at the level of a failure domain, not at the level of a component. Say out loud which domain each copy protects you from, and the design either answers the question or reveals that it never did.

## Taken too far
<!--meta block=overreach-->

Copies raise a question a single instance never had to answer: which one is right. Partition the network and both halves are alive, both are reachable by some clients, and both accept writes that cannot afterwards be merged. That is [Split-Brain](../hazards/split-brain.md), and it is redundancy's own hazard rather than a bug in someone's implementation. Answering it costs a majority quorum, a fencing token, or an agreed window of writes you are willing to lose; declining to answer it costs correctness.

The rest of the bill is paid on every request rather than during the failure. Synchronous replication puts the slowest copy on the critical path of each write, and moving the copies further apart to break correlation makes that copy slower. The isolation you want and the latency you want are one dial pulled in opposite directions. The money is simpler: standby capacity is capacity you buy and never serve from, and it grows again with each failure domain you add. Limiting what one failure can reach is often the cheaper purchase, because it costs a boundary rather than a second copy of everything behind it.

The case that catches teams out is redundancy that is real and still useless. Two replicas each running at 70% look healthy right up to the moment one dies and the other meets 140% of what it can serve, so the spare masks a capacity problem until both halves are underwater. The failover machinery is itself a component that can misfire or flap, so rehearse it with game days. The same applies to the path itself: a standby nobody has ever promoted is an assumption, not a mitigation, and it fails on the credential, the permission or the schema version nobody exercised. And not everything earns a copy. An internal tool whose users can wait an hour does not need a second region, and buying one hands a coordination problem to a service that did not have one.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Replication](../patterns/distributed/coordination/replication.md) — More than one copy is how a lost copy stops mattering
- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — Spare capacity helps only if traffic can actually reach it
- [Quorum & Consensus](../patterns/distributed/coordination/quorum-consensus.md) — Copies must agree who decides, or they quietly diverge
- [Leader Election](../patterns/distributed/coordination/leader-election.md) — Replace a failed coordinator automatically instead of standing one up by hand
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — An interchangeable instance is what makes another instance a real spare
- [Design for Self-Healing](./self-healing.md) — Spare capacity earns nothing until something fails over to it
- [Analyse Failure Modes](./failure-mode-analysis.md) — What to duplicate is an output of the analysis, not a default
- [Build for the Needs of the Business](./build-for-business.md) — The availability target decides how much redundancy is worth buying
- [Regions & Availability](../capabilities/regions.md) — Regions and zones are where this principle gets priced.
- [Defense in Depth](./defense-in-depth.md) — Redundant controls count only if they do not fail together.

**Alternative to**

- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — Limit what one failure can reach for the cost of a boundary, not a second copy of everything

**Often confused with**

- [Sharding](../patterns/distributed/routing/sharding.md) — Copies buy availability; splitting data buys capacity — different problems

<!-- relationships:end -->
