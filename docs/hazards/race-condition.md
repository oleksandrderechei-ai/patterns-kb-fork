---
title: Race Condition
description: Unsynchronized concurrent access whose result depends on timing
area: hazards
owner: Oleksandr Derechei
tags: [concurrency, isolation, state-management]
status: stable
aliases: [data race, TOCTOU, lost update]
solves: [two requests update the same record at once and one change silently disappears, two people booked the same seat, a counter that should read 1000 reads 847, the tests pass every time and production produces impossible results, "flaky, intermittent failures that only show up under real concurrency"]
---

# Race Condition

Unsynchronized concurrent access to shared state whose outcome depends on thread timing — code that passes every test yet produces impossible results once real load makes two writers overlap.

## What it is
<!--meta block=description-->

A race condition is two or more actors (threads, requests, processes) touching the same shared state without coordinating, so the outcome depends on who arrives first. It rarely crashes: it passes tests, then in production returns impossible results, such as a seat sold twice or a counter reading 847 instead of 1,000. The tell is one question: could another actor change this between my read and my action? If yes, you have a race.

## Explained
<!--meta block=explain-->

A race condition is a bug where two actors, such as threads or requests, use the same shared data at the same time and the result depends on who gets there first. It rarely crashes. It returns wrong data with no error, such as two buyers getting the same seat or one of two increments vanishing. It takes two forms: check-then-act, where another writer changes the condition between your check and your action, and read-modify-write, where two actors read the same value and one write erases the other. A gap of microseconds is crossed many times a day at high volume, and a green test suite proves only that the bad order did not happen. Every fix closes the gap. Fold the check into the write with a [conditional write](../patterns/distributed/coordination/conditional-write.md), or attach a version and reject a stale write with [optimistic concurrency control](../patterns/distributed/coordination/optimistic-concurrency-control.md). Or hold one lock across both steps, on every code path. Or give the data a single owner so nothing is shared.

- **Rejected writes.** The loser must retry or report a refusal instead of a silent success; design the caller for that.
- **Lock scope.** A lock held on every path allows one critical section at a time; keep it to the check and write, no external calls.

**Example.** A shop has 1 shirt left. Two buyers load the page, each request reads stock = 1, both pass the check, and both write stock = 0. Two orders are confirmed for one shirt, and nothing logs an error. At 10,000 requests a second and a 2 ms gap between read and write, 20 requests are inside that gap at any moment. The fix is one statement, UPDATE items SET stock = stock - 1 WHERE id = 7 AND stock >= 1. The second buyer's update matches 0 rows and gets a sold-out message.

## How it happens
<!--meta block=causes-->

```mermaid caption="Both requests read before either writes, so B computes from a balance that is already stale and its write erases A's deposit — with no error raised at any step."
sequenceDiagram
    autonumber
    participant A as Request A (deposit $50)
    participant DB as Balance row (starts at $100)
    participant B as Request B (deposit $500)
    A->>DB: read balance = 100
    B->>DB: read balance = 100
    A->>DB: write 100 + 50 = 150
    B->>DB: write 100 + 500 = 600
    Note over A,B: $650 expected, $600 stored — A's deposit is gone
```

Races take two shapes:

- **Check-then-act — time-of-check to time-of-use (TOCTOU).** You test a condition, then act on the assumption it still holds, but another writer invalidates it in the gap between. Two buyers both read "seat 7A is available" and both book it, so the second write overwrites the first; a [rate limiter](../patterns/distributed/resilience/rate-limiter.md) reads "99 requests, under the limit" on two threads at once and admits request 101; a connection pool sees one connection free and hands it to two callers. The action is only correct while the check stays true, and nothing kept it true.
- **Read-modify-write — the lost update.** It always writes: two threads read the same value, each computes a new one from it, each writes it back, and one update is silently clobbered. `count++` is really read-add-write, three steps; if two threads both read 5, both compute 6, both store 6, one increment vanishes. A $50 deposit and a $500 deposit that both read a $100 balance leave $600 instead of $650 if the $500 write lands last (the $50 is lost); if the $50 write lands last the balance is $150.

Both need only two ingredients: state shared between concurrent actors, and a read and a write that are not fused into one indivisible step. The wider the gap between them — a slow validation, an external API call, application logic deciding what to write — the larger the window in which another writer can slip through. Even with no check-then-act gap, unsynchronised reads can see stale values; a lock or memory barrier fixes visibility, as [Double-Checked Locking](../patterns/concurrency/double-checked-locking.md) shows.

## What it costs
<!--meta block=cost-->

The cost of a race is silently wrong data that everyone downstream trusts, not a stack trace. A double-booked seat puts two people in one chair. A lost increment lets a view or metrics counter drift low, quietly, over millions of requests until the analytics are wrong. An oversold inventory row means a shirt sold twice, with one buyer refunded and disappointed. A corrupted balance means money that was deposited is just not there.

When the racing check guards a permission or a claim on a scarce resource, the window stops being bad luck. Someone who can reach the same resource provokes it deliberately and retries until it opens, so the rarity that made the bug feel tolerable protects nothing. The same check-then-act — the time-of-check to time-of-use case above — then can buy privilege escalation or a denial of service, not merely wrong data.

Because there is no error, nothing pages you and nothing rolls back. The invariant the code was meant to protect — one owner per seat, count never above the cap, money conserved — has quietly been violated, and the system carries on as if it were fine. The damage is found later by a customer, an auditor, or a reconciliation job, long after the interleaving that caused it has evaporated and left nothing to reproduce. Look for it on purpose: run a reconciliation query that checks the invariant (one owner per seat, count at or under the cap, money conserved), alert on any violation, and stress-test the code path with forced interleavings, since waiting for a repro will not work.

## Getting out
<!--meta block=mitigation-->

Every fix either closes the gap between reading and writing or removes the sharing.

**Serialize the check and the write** into one step: hold a single lock across both, so a second writer waits and the check stays true because nothing else can run in between. The same lock must guard every operation that maintains the invariant; locking the check but releasing before the write recreates the bug. A lock inside one process does not exclude other instances, so with several instances keep the lock in the store (a row lock or a conditional write) or use a lease, as in [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md); a lease can expire under a slow holder. For read-heavy state with rare writes, a reader/writer lock lets readers run in parallel and excludes them only for a write. For one counter, use an atomic increment or compare-and-swap, not a lock.

**Make the write atomic at the store**, so no application lock is needed. Fold the condition into the write with a [conditional write](../patterns/distributed/coordination/conditional-write.md) whose `WHERE` clause re-checks as it updates, or attach a version to the row and let [optimistic concurrency control](../patterns/distributed/coordination/optimistic-concurrency-control.md) reject a stale write. In a store that applies the conditional write atomically, writes to one row are serialised and the loser matches nothing. Bound the retry: cap the attempts, add jitter between them, and return a conflict to the caller when the cap is hit.

**Remove the sharing.** If only one actor touches a piece of state, confine it to one thread or partition the data so each owner holds a slice; no interleaving is possible.

Pick the lightest mechanism the contention allows: optimistic when conflicts are rare, pessimistic locking when retries pile up. Start with one lock and move to finer ones when measured contention shows.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Mitigated by**

- [Conditional Write](../patterns/distributed/coordination/conditional-write.md) — Fold the check into the write so the store applies them as one indivisible step
- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — Attach a version and let a stale write fail, then reload and retry
- [Pessimistic Locking](../patterns/distributed/coordination/pessimistic-locking.md) — Lock the row up front so only the holder can run the check-then-write
- [Monitor Object](../patterns/concurrency/monitor-object.md) — Hold one lock across the check and the write so nothing interleaves
- [Read-Write Lock](../patterns/concurrency/rw-lock.md) — Exclude everyone during a write; let reads run in parallel the rest of the time
- [Thread Confinement](../patterns/concurrency/thread-confinement.md) — Give one owner the state so there's no sharing to race over at all
- [Copy-on-Write](../patterns/concurrency/copy-on-write.md) — Publish a finished copy rather than mutating in place, so no reader can catch a partial write
- [Immutability](../patterns/functional/immutability.md) — Shared state that is never written after creation needs no lock to read safely
- [Mutex](../patterns/concurrency/mutex.md) — Guarding the shared data with a lock stops two threads interleaving their reads and writes
- [Barrier](../patterns/concurrency/barrier.md) — A barrier orders the phases of a parallel job, so a fast thread cannot read a slow thread's unfinished result
- [Sequential Convoy](../patterns/messaging/sequential-convoy.md) — Serialize per entity rather than detecting the collision afterwards

**Threatens**

- [Double-Checked Locking](../patterns/concurrency/double-checked-locking.md) — The race is the failure this idiom produces when written without a memory barrier
- [Singleton](../patterns/gof/creational/singleton.md) — Lazy initialisation can create two instances when threads check at once
- [Cache-Aside](../patterns/caching/cache-aside.md) — A read that reloaded an old value can re-cache it just after a write's invalidation
- [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) — A lock whose expiry races with a slow holder admits two holders
- [Monostate](../patterns/gof/extra/monostate.md) — Two threads that update a monostate's shared static fields without a lock can interleave their writes
- [Lazy Initialization](../patterns/gof/extra/lazy-initialization.md) — Two first callers both run the factory, so the value is built twice
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — Rate Limiter's check-then-count is a check-then-act race when its counter is shared
- [Inventory Management](../designs/inventory-management.md) — the inventory transfer shows the check-then-act race and its lock fix
- [Distributed Rate Limiter](../designs/distributed-rate-limiter.md) — Two gateways reading the same last token both admit; a shard-side script closes the window.
- [Parking Lot](../designs/parking-lot.md) — A check-then-act on a shared set: two entrances claim one parking bay.
- [Elevator](../designs/elevator.md) — An elevator controller handling concurrent hall calls can double-assign an idle car or corrupt a car's stop set mid-tick.

<!-- relationships:end -->
