---
title: Priority Inversion
description: A high-priority task waits on a lock held by a low-priority one while medium-priority work runs
area: hazards
owner: Oleksandr Derechei
tags: [concurrency, latency]
status: stable
solves: [my most urgent task misses its deadline while the CPU is not busy and it is waiting on a lock, a background job holding a lock keeps getting pushed aside and the important task stays blocked behind it, our watchdog reset the system even though every task was making progress, raising a thread's priority did not make it faster because a lower thread holds what it needs]
---

# Priority Inversion

A high-priority task waits for a lock held by a low-priority task, and medium-priority work keeps the low-priority task off the processor, so the most urgent work is delayed by the least urgent for as long as the middle tasks choose to run.

## What it is
<!--meta block=description-->

Priority inversion reverses the priority order you set: a low-priority task holds a lock, a high-priority task blocks on it, and a medium-priority task that needs neither keeps preempting the holder. You see a deadline missed with ordinary CPU use and no crash, and a trace showing the urgent task waiting on a lock whose holder is runnable but not running. The defining trait is that an unrelated task outcompetes the holder; deadlock and starvation by policy are different.

## Explained
<!--meta block=explain-->

Priority inversion is a low-priority task holding a lock that a high-priority task needs, while a medium-priority task keeps the low one from running. The scheduler always runs the highest task that is ready. The high task is blocked on the lock, so it is not ready, and the medium task runs instead. The low task never gets time to finish and release the lock, so the urgent work waits behind work that ranks below it, for as long as the medium task runs. It looks like a slow system, but CPU use is fine and nothing has crashed. Fix it with priority inheritance: while a task holds a lock, it takes the priority of the highest task waiting for it. A priority ceiling gives each lock the highest priority of any user, at the cost of knowing every user. Or avoid the sharing: keep the critical section short, pass work through a queue and measure how long high-priority tasks wait on locks.

**Example.** A spacecraft has three tasks. A bus task at high priority, a weather task at low priority and a radio task at medium priority. The weather task takes the lock on the data bus. The radio task wakes and runs for 200 ms, which keeps the weather task off the processor. The bus task needs the lock, waits, and misses its 100 ms deadline. A watchdog resets the computer. With priority inheritance, the weather task runs at the bus task's priority while holding the lock, finishes in 2 ms and releases it. The cost is that the option must be on for every lock shared across priorities.

## How it happens
<!--meta block=causes-->

The hazard needs a shared lock between tasks of different priority, and a scheduler that always runs the highest-priority task that is ready. A lock lets one task at a time use a resource, and any other task that wants it must wait for the holder, whatever its own priority. The scheduler knows nothing of that wait: it sees the blocked high task as not ready and the medium task as ready, and runs the medium one.

- A lock shared across priority levels, so a low-priority task can hold what a high-priority task needs.
- A scheduler that is strictly priority-based and preemptive, so a ready medium task always beats a runnable low one.
- A medium-priority task that can run for a long or unbounded time, because a short one lets the low task finish quickly and the delay stays small.
- A lock implementation with no priority inheritance, so the holder keeps its low priority while a high-priority task waits on it.
- A real-time deadline or a watchdog, which turns a delay into a failure, since without one the inversion only costs time.
- Chains of dependency, where the high task waits on a lock held by a task that is itself waiting on a lower one, so the delay stacks up.

## What it costs
<!--meta block=cost-->

- **Missed deadlines on the work you ranked highest.** The task that matters most waits as long as the middle tasks run, which can be unbounded.
- **A reset or crash instead of a slowdown.** In a system with a watchdog, a delayed task is read as a hung task and the whole system restarts, as on Pathfinder.
- **A bug that appears only under load.** It needs all three tasks to line up, so it passes tests and shows up rarely, in production.
- **Hard diagnosis.** CPU use looks fine and no task has crashed, so the first sign is a missed deadline whose cause is a lock held by an idle-looking task.
- **Priorities that mean nothing.** Once a team learns the order is not honoured, tuning priorities stops being a safe way to control latency.

## Getting out
<!--meta block=mitigation-->

Let the lock holder inherit the priority of the highest task waiting for it. With **priority inheritance**, the low task is raised for as long as it holds the lock, so the medium task can no longer preempt it, it finishes its short critical section and releases the lock, and the high task runs. Many real-time operating systems offer this as an option on their locks, and it was the fix for Pathfinder. It must be on for the locks that cross priorities, and the raised priority drops back when the lock is released. It needs a lock with one owner to raise, so it does not help a semaphore used as a signal. It must also pass along a chain: when the holder is itself blocked on another lock, that lock's holder is raised too.

A stricter form is a **priority ceiling**: give each lock the priority of the highest task that ever uses it, and run any holder at that level. It stops the inversion on that lock before it starts and rules out some [Deadlock](./deadlock.md) cases, at the price of knowing every user of each lock in advance; a task missing from that list breaks the guarantee.

Or avoid the sharing. Keep the critical section as short as possible: with inheritance on, the delay is bounded by how long the holder takes, so a shorter section shrinks the bound but does not remove the cause. Pass data between priorities through a queue or message instead of a shared lock, so a high-priority task never waits on a low one; a [Priority Queue](../patterns/messaging/priority-queue.md) puts the ordering in the data rather than in a lock, though a queue with its own lock moves the inversion there. Where you can, use [lock-free structures](../patterns/concurrency/lock-free.md) between the levels; they trade the inversion for retries. And measure: log how long high-priority tasks wait on locks, so an inversion shows up as a number before it shows up as a reset.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Deadlock](./deadlock.md) — Both wait on a lock, but here the holder finishes given time.
- [Priority Queue](../patterns/messaging/priority-queue.md) — Priority is set on messages there and on locking tasks here.
- [Starvation](./starvation.md) — Here an unrelated task outcompetes the lock holder; starvation is the wider case, and inversion is one way into it.

**Mitigated by**

- [Lock-Free](../patterns/concurrency/lock-free.md) — No lock means no holder to preempt, at the price of retries.

**Threatens**

- [Mutex](../patterns/concurrency/mutex.md) — A low-priority holder is preempted by unrelated work while a high-priority task waits
- [Monitor Object](../patterns/concurrency/monitor-object.md) — A monitor lock shared across priorities is where the inversion forms
- [Read-Write Lock](../patterns/concurrency/rw-lock.md) — A low-priority reader or writer holding the lock blocks a high-priority task

<!-- relationships:end -->
