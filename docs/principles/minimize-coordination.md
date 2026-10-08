---
title: Minimize Coordination
description: Work that needs no agreement is the only work that scales
area: principles-systems
owner: Oleksandr Derechei
tags: [coordination, decoupling]
status: stable
aliases: [coordination avoidance]
solves: [we added more workers and the job got slower instead of faster, "every write has to grab the same lock, so most of the machines sit idle waiting", throughput flattens out no matter how many instances we run, two jobs keep stepping on each other and we keep adding locks to stop it, one row in one table is the bottleneck for the entire system]
---

# Minimize Coordination

Every point where two pieces of work must agree before either may proceed is a point where your system stops scaling. Coordination is not free and not optional everywhere — so make it rare, make it narrow, and know exactly where each remaining piece of it lives.

## What it says
<!--meta block=description-->

Do as much work as you can without asking another participant for permission. Work that needs no agreement scales by adding machines; work that needs agreement makes every new machine another participant in a conversation you cannot run in parallel. Coordination is a spectrum, from a version check through a lock and a quorum write to a single node assigning all work, and it sits in both the data and compute layers. Keep it rare and narrow.

## Explained
<!--meta block=explain-->

Minimize coordination means doing as much work as you can without asking another participant for permission, because work that needs no agreement scales by adding machines, while every machine added to an agreement joins one more conversation that cannot run in parallel. It is not a ban on agreement: keep it rare and narrow. Move down a ladder and stop at the first rung that holds. Split the work so the question never comes up, make operations safe to repeat, detect conflicts instead of preventing them when collisions are rare, then narrow the scope of any lock. Choose it over a central coordinator when the conversation caps your throughput. Keep the round trip for invariants that must hold, such as a balanced ledger or a seat sold once, and shrink their scope instead.

- **Inconsistency window.** Removing an agreement does not remove the requirement it enforced, so decide how long the window lasts and what a customer sees.
- **Compensations.** Undoing a step later is not the inverse of doing it, so price the compensations.
- **Retry load.** Under heavy contention the retries become the load, so cap the attempts.

**Example.** Two warehouses reserve stock from one shared count, and each reservation holds one lock on the stock table across a slow availability check. Orders queue behind it, so a third warehouse adds no capacity. The team gives each warehouse its own slice of every item's stock and checks a version on write, retrying on the rare clash. The warehouses now scale independently. The cost is a lagging combined view: a customer near the border can see an item in stock after the other warehouse sold its last unit. The team decides overselling by one unit is cheaper than a round trip and refunds when it happens. The money ledger keeps one lock per account, because it must balance.

## Why it helps
<!--meta block=rationale-->

Agreement is paid for in the two currencies you have least of: latency and availability. Reaching it costs at least one network round trip on the critical path of every request that needs it, and it can only be reached while enough participants are reachable — so the coordinated path is down exactly when the network is having a bad day. A path that needs nobody's permission answers in local time and keeps answering while half the fleet is unreachable, which is why the uncoordinated parts of a system are usually also its most available parts.

The throughput argument is sharper still. A shared point of agreement is a serial section, and the ceiling it sets is what one participant can do per second, not what the fleet can. Add machines and you do not raise that ceiling; you lengthen the queue in front of it, so the median holds while the tail latency climbs and the extra capacity shows up as waiting. Contended agreement is also where the ugliest failures live: two holders each waiting on what the other holds is [Deadlock](../hazards/deadlock.md), and that failure mode simply does not exist in work that never asks anyone for anything.

## Applying it
<!--meta block=applying-->

Work down the ladder in order, and stop at the first rung that holds:

- Partition the work so the question never arises. Two workers must process every order exactly once, and the reflex is a coordinator that hands orders out one at a time. Give each worker a disjoint range of order ids instead and the contention stops existing: no worker can reach another's range, so nothing has to be arbitrated. A crashed worker's range is picked up by a peer, but that takeover is itself an ownership decision (a lease or a membership change), so keep it rare and off the per-order path, and expect the peer to redo orders the crash left half-done unless processing is idempotent.
- Make the operation safe to repeat, then stop paying to prevent repeats. [Idempotency](../patterns/messaging/idempotency.md) turns a race into wasted work rather than wrong data: if applying the same request twice leaves the same state as applying it once, two workers colliding costs you a cycle instead of a correctness bug, and you no longer need the lock that was there to guarantee exactly one attempt.
- Detect conflicts instead of preventing them where collisions are rare. [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) checks a version on write and retries when it lost; it costs almost nothing on the requests that do not collide (one version compare on write), whereas a lock charges a round trip to every request whether or not anyone else wanted the row. Measure the retry rate per key; when retries become the load, move that key to a single queue.
- Narrow the scope before you remove the mechanism. The cost of an agreement scales with how many participants it spans and how long it is held, so a lock per tenant beats a lock per service, and one taken after the expensive computation beats one taken before it. When that section is the bottleneck and saturated, halving the held duration roughly doubles its throughput; take the lock after the computation only if you recheck, under the lock, the state you read before it.
- Keep the agreement out of the request path. An [Outbox](../patterns/distributed/coordination/outbox.md) lets a service commit its own state and the intent to tell others in one local transaction, and a [Saga](../patterns/distributed/coordination/saga.md) replaces one distributed transaction with a sequence of local ones plus compensations. Both trade a cross-service agreement for a delay you can measure.
- Where exclusivity is genuinely required, express it as something that expires. A [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) held as a [lease](../patterns/distributed/coordination/lease.md) with a deadline, or a [Leader Election](../patterns/distributed/coordination/leader-election.md) with a bounded term, releases when the holder dies without anyone having to notice. A lock you can release only by contacting the holder fails exactly when the holder is unreachable. A paused holder can still write after its lease lapses, so the protected resource must check a fencing token and reject writes from an expired holder.
- Separate what must agree from what merely must be current. [Command query responsibility segregation (CQRS)](../patterns/architecture/cqrs.md) keeps the agreement on the write model and lets read models be computed from it, and [Event Sourcing](../patterns/architecture/event-sourcing.md) makes that computation replayable, so a reader that is a second behind costs you a stale screen instead of a round trip. Say which reads may lag and by how much, because that sentence is the whole design.

Every rung you clear takes a participant out of a conversation that was capping your throughput. The rungs are also ordered by regret: partitioning is the one you can still change your mind about cheaply, and a leader you built the whole system around is the one you cannot.

## Taken too far
<!--meta block=overreach-->

Removing an agreement does not remove the requirement it was enforcing. It moves that requirement into the part of the system nobody wrote down, and the usual result is a system that is eventually consistent by accident. Two warehouses may now both promise the last unit from a lagging combined count, which is fine if someone decided that overselling by one unit is cheaper than a round trip — and a bug if nobody decided anything. The failure is never that the window exists; it is that nobody named its length, nobody chose what a customer sees inside it, and nobody owns the cases that resolve the wrong way.

Compensations are the second bill, and they are routinely underpriced. Undoing a step in a world that has since moved on is not the inverse of doing it: a refund is not an unmade charge, because the customer was notified, the fraud score moved and the invoice number is spent. Count that work before you trade one transaction for a chain of local ones. Optimistic conflict detection has a mirror failure — under real contention, the retries become the load, since every loser re-reads, re-computes and re-writes, so cost rises fastest exactly when collisions get common. Bound the attempts and route the hot key through a single queue rather than letting the retry traffic turn into your workload.

Some invariants are worth the round trip, and pretending otherwise moves the arbitration onto a human. A ledger that must balance, a seat sold once, a username that must be unique: an eventual path around any of these buys throughput nobody asked for and hands operations a reconciliation queue. What you minimize on those paths is scope, not existence — agree per account rather than per system, hold the exclusive section for the write rather than for the request, and keep everything that does not touch the invariant outside it. Measure first, too. The coordination that caps your throughput is one specific point; the others usually cost little that you can measure, and removing them buys you no capacity while costing you the simplest code you had.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Saga](../patterns/distributed/coordination/saga.md) — Replace one distributed transaction with local steps that can compensate
- [Outbox](../patterns/distributed/coordination/outbox.md) — One local transaction, then publish — no agreement across two systems
- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — Assume no conflict, detect the rare one, and retry only that
- [Idempotency](../patterns/messaging/idempotency.md) — At-least-once delivery is cheap; the coordination behind exactly-once is not
- [Event Sourcing](../patterns/architecture/event-sourcing.md) — Appending is atomic on its own, so writers stop contending for a row
- [CQRS](../patterns/architecture/cqrs.md) — Readers and writers stop queueing behind each other
- [Design to Scale Out](./scale-out.md) — Removing coordination is what makes added machines actually help
- [Fallacies of Distributed Computing](./fallacies-of-distributed-computing.md) — The fallacies are why each coordination step costs more than it looks.
- [Sharding](../patterns/distributed/routing/sharding.md) — Each shard owns its keys, so writes on different shards never ask each other for agreement
- [Lease](../patterns/distributed/coordination/lease.md) — Exclusivity that expires frees itself when the holder dies, with no talk to the holder

**Alternative to**

- [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) — Partition the work so that nothing needs the lock
- [Leader Election](../patterns/distributed/coordination/leader-election.md) — Give each worker a disjoint range instead of arbitrating between them

**Prevents**

- [Deadlock](../hazards/deadlock.md) — There is no lock ordering to get wrong when there are no locks to order

<!-- relationships:end -->
