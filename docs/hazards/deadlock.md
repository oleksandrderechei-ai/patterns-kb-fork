---
title: Deadlock
description: "Two holders each wait for a lock the other holds, forever"
area: hazards
owner: Oleksandr Derechei
tags: [concurrency, resource-management, isolation]
status: stable
aliases: [circular wait, deadly embrace]
solves: [two transactions each wait on the other and neither ever finishes, "the process is stuck with no error, no progress and no timeout", threads park forever and everything behind them piles up, the job hangs indefinitely and only a restart clears it]
---

# Deadlock

Two or more holders each hold one lock and wait for a lock another holds — a circular wait that never resolves on its own, so the work stalls permanently.

## What it is
<!--meta block=description-->

A deadlock is a standoff: two threads or transactions each hold a lock the other needs and wait for the other to let go, so neither ever moves. You recognize it when nothing runs, nothing throws, and every request touching either lock queues behind the pair while CPU sits near zero. It is the mirror of a race condition: a race does too much at once, a deadlock does nothing forever.

## Explained
<!--meta block=explain-->

A deadlock is a standoff where two tasks each hold a lock the other needs and each waits for the other to let go, so neither ever moves. A lock is a marker that lets one task at a time change a piece of data. Nothing crashes and nothing logs an error, and everyone who later needs either lock queues up behind the pair until a whole thread pool is frozen. You build one by taking many small locks to win back concurrency, then letting operations that need two of them grab them in whatever order their input arrives. Prevent it by always taking locks in one fixed order, such as the lower ID first, so no loop can form. Keep critical sections short and make no network call while holding a lock. Add a timeout on acquiring a lock, so a hang becomes an error you can retry. The deeper cure is to share no locks: give each piece of state one owner and pass messages ([actor model](../patterns/concurrency/actor-model.md)).

- **Retry duty.** A database picks a victim and aborts it, and a lock timeout fails slow but healthy work, so callers must retry.
- **Ordering discipline.** Fixed lock order only holds if every code path follows it, so enforce it in one helper.

**Example.** A bank service runs transfers on a pool of 8 threads, locking the source account and then the destination. Transfer 17 to 42 locks 17 and waits for 42. At the same moment, 42 to 17 locks 42 and waits for 17. Two threads are stuck for good, and every request touching either account joins them. After 4 such pairs, all 8 threads are held and the service answers nothing while CPU sits near zero. The fix is to lock the lower account number first, so both transfers ask for 17 before 42 and one simply waits. A 2 s lock timeout stays as a backstop.

## How it happens
<!--meta block=causes-->

```mermaid caption="Both swaps need the same two locks and take them in opposite orders, so each ends up waiting on the one the other holds — a closed loop with no exit."
flowchart LR
    TA["Thread A (Alice's swap)"] -->|"waits for"| L2["Lock on seat 12B"]
    L2 -->|"held by"| TB["Thread B (Bob's swap)"]
    TB -->|"waits for"| L1["Lock on seat 7A"]
    L1 -->|"held by"| TA
```

A deadlock needs four conditions at once, and every operating-systems text calls them the Coffman conditions after the 1971 survey that first set them out: mutual exclusion, locks held exclusively; hold and wait, holders that keep waiting while still holding; no preemption, no way to force a lock back; and circular wait, each holder waiting on the next. The first three are usually properties of the locks you were given. The one you actually control, and the one that turns a latent risk into a real hang, is the **circular wait**. Two recurring setups create it:

- **Inconsistent lock-acquisition order under fine-grained locking.** Once you protect many small things with their own locks — one per seat, one per account row — an operation that needs two of them can grab them in whatever order its inputs happen to arrive in. Alice's swap locks 7A then reaches for 12B while Bob's swap locks 12B then reaches for 7A; an account transfer that locks the source row then the destination will deadlock the instant two transfers run in opposite directions between the same two accounts. Same locks, opposite order — a cycle.
- **A non-reentrant lock re-acquired by the thread that already holds it.** If a method takes a lock and then calls another method that takes the same lock, a non-reentrant lock treats the caller as a stranger and makes it wait for a lock it is itself holding — an instant self-deadlock. This bites exactly when a coarse operation such as a transfer is composed of smaller synchronized steps (remove from source, then add to destination) that each lock the same object.

Coarse locking rarely deadlocks — a single lock cannot form a cycle — so deadlocks are largely a tax on the finer-grained locking you adopt to win back concurrency. The more locks there are, and the more operations that must hold two of them together, the easier a cycle is to build by accident.

## What it costs
<!--meta block=cost-->

The immediate cost is that the deadlocked work never finishes. The two holders are stuck, and because they never release their locks, everything that later needs those locks queues up behind them and stalls too. What began as two blocked threads spreads outward until a whole request path — or the pool of worker threads serving it — is frozen, and throughput on that path falls to zero even though the machine looks idle.

How long it lasts depends on who is deadlocked. A database watches for the cycle: every major engine runs deadlock detection, picks a victim transaction, aborts it with a deadlock error, and lets the other proceed — so there the damage is a failed transaction the application must retry, not a permanent freeze. Application threads holding in-process locks usually have no such referee. Absent a lock-acquisition timeout they wait forever, and the only way out is a restart. Either way it is self-inflicted: no external fault caused it, and no amount of waiting will ever resolve it.

## Getting out
<!--meta block=mitigation-->

The one reliable prevention is **a consistent global lock order**: sort every lock an operation needs by some deterministic key — the lower ID first, always — and acquire them in that order regardless of the business-level direction. Both the seat swap and the account transfer then contend for the same first lock instead of forming a loop; one waits for the other and both make progress. That breaks the circular wait, the condition every deadlock depends on.

Several habits shrink the exposure. **Keep critical sections small**, and never do slow I/O — a network or payment call — while holding a lock, so any window for a cycle stays tiny. Where the extra concurrency isn't needed, **one coarser lock** cannot deadlock against itself and is often the simpler, safer choice. Add a **lock-acquisition timeout** as a backstop, so a thread that can't get a lock in time gives up and retries instead of hanging forever, and **treat a database's deadlock-abort as a normal, retryable outcome** — catch it and re-run the transaction with locks taken in the same consistent order. Use **reentrant locks** when a coarse operation composes smaller synchronized steps, so re-taking a lock the thread already holds doesn't wedge it against itself.

The deeper escape is to **not share the locks at all**: confine each piece of state to a single owner, or coordinate through message passing instead of shared memory, and there are no competing acquisitions left to form a cycle in the first place.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Starvation](./starvation.md) — Deadlock halts everyone and is easy to spot; starvation keeps throughput normal and hides
- [Priority Inversion](./priority-inversion.md) — A deadlock never ends; priority inversion ends once the holder runs.

**Mitigated by**

- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — A lock-acquisition timeout is the backstop that breaks an otherwise indefinite wait
- [Minimize Coordination](../principles/minimize-coordination.md) — Removing shared locks removes the cycle rather than managing it
- [Lock-Free](../patterns/concurrency/lock-free.md) — Remove the locks entirely and the hold-and-wait precondition disappears
- [Actor Model](../patterns/concurrency/actor-model.md) — Actors remove lock-ordering deadlocks by giving each piece of state one owner; circular request-reply waits can still stall them, so time out every ask
- [Thread Confinement](../patterns/concurrency/thread-confinement.md) — Confinement removes lock-order cycles, but owners blocked on each other's queues can still deadlock

**Threatens**

- [Mutex](../patterns/concurrency/mutex.md) — Two tasks taking two mutexes in different orders wait on each other forever
- [Pessimistic Locking](../patterns/distributed/coordination/pessimistic-locking.md) — Row locks taken in inconsistent order across transactions form a wait cycle
- [Monitor Object](../patterns/concurrency/monitor-object.md) — Nested monitor calls take locks in whatever order the call chain dictates
- [Two-Phase Commit](../patterns/distributed/coordination/two-phase-commit.md) — Participants holding locks while waiting on the coordinator can wait in a cycle
- [Backpressure](../patterns/concurrency/backpressure.md) — A cycle of stages with full bounded buffers deadlocks when each waits on the other's slow-down signal
- [Read-Write Lock](../patterns/concurrency/rw-lock.md) — Two readers that each try to upgrade a read hold wait on each other forever

<!-- relationships:end -->
