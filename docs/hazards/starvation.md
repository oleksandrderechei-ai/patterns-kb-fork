---
title: Starvation
description: Some work waits without bound while everything else keeps being served
area: hazards
owner: Oleksandr Derechei
tags: [concurrency, resource-management, throughput, latency]
status: stable
aliases: [thread starvation, resource starvation]
solves: [low-priority jobs sit in the queue for hours and some never run at all, one heavy tenant takes the whole pool and everyone else times out, my writers can never get the lock because readers keep arriving, requests time out but the error rate is zero and the machine looks idle, the backlog drains but the oldest items in it never move]
---

# Starvation

A fairness failure: one class of work is perpetually overtaken and never reaches the front, while throughput, error rate and the machine all look healthy.

## What it is
<!--meta block=description-->

Starvation is work that never gets its turn. One class of requests, threads or messages is perpetually overtaken, so it waits without bound while everything else is served normally. It differs from [deadlock](./deadlock.md), where nobody progresses and the freeze is its own alarm: here throughput is on target and no error appears. It is also not a [race condition](./race-condition.md); the allocation policy works as configured and puts no floor under anyone.

## Explained
<!--meta block=explain-->

Starvation is work that never gets its turn. One class of requests, threads or messages is always overtaken by others, so it waits without limit while everything else is served normally. Nothing has failed and nothing is stuck, which separates it from deadlock, where nobody moves and the freeze is its own alarm. Under starvation throughput is on target, the workers are busy, no errors appear, and one class never finishes. The cause is a policy that decides who goes next with no floor under anyone: if the preferred class arrives as fast as the server drains it, the moment it is idle never comes. Averages hide it because the victim is a minority, so watch per-class tail latency and the age of the oldest queued item. Fix it by giving the victim a guarantee through [scheduling](../patterns/concurrency/scheduling.md): aging, which raises an item's priority as it waits, or a reserved share of workers.

- **Aging delays urgent work.** Aged low-priority jobs compete with urgent ones, so urgent latency rises until you add capacity.
- **Reserved share idles.** A slice held for one class bounds its wait but sits unused when that class is quiet.

**Example.** A queue has 4 workers that each handle 25 jobs a second, so 100 a second. Urgent jobs arrive at 100 a second and report jobs at 5 a second, served only when no urgent job waits. The reports never run, and after 10 minutes 3,000 are waiting while every dashboard is green. Reports start two levels below urgent, and aging raises a report one level every 10 s, so after 20 s it ties with urgent jobs and runs. Demand is now 105 against 100, so the urgent backlog grows by 5 a second until you add capacity.

## How it happens
<!--meta block=causes-->

```mermaid caption="Why does a starved request differ from a stuck one? The worker never idles and step 6 keeps firing, so throughput stays at target — step 5 is simply never reached, and the low queue's oldest item ages without bound."
flowchart LR
    Hot["Greedy class — keeps arriving"]
    Cold["Victim class"]
    subgraph Server["One shared server, strict preference"]
      HighQ[("High queue")]
      LowQ[("Low queue")]
      Worker["Worker"]
    end
    Done["Served"]
    Hot -->|"1 enqueue, without pause"| HighQ
    Cold -->|"2 enqueue once"| LowQ
    Worker -->|"3 take the preferred queue first"| HighQ
    HighQ -->|"4 never empty"| Worker
    Worker -.->|"5 step never reached"| LowQ
    Worker -->|"6 complete"| Done
```

The setup is always the same three parts: a shared server — a [thread pool](../patterns/concurrency/thread-pool.md), a lock, a set of consumers — a policy that decides who goes next, and a class of arrivals the policy keeps preferring. Starvation begins the moment the preferred class arrives at least as fast as the server drains it, because "when the preferred class is idle" then never comes. These setups recur:

- **Strict priority under sustained load.** The low class runs only when the high class is empty, and under a steady stream of urgent work it never is. A [priority queue](../patterns/messaging/priority-queue.md) draining highest-first asks for exactly this preemption; starvation is the price of the guarantee.
- **Lock preference policy.** A [read-write lock](../patterns/concurrency/rw-lock.md) that admits every arriving reader while readers are present holds the writer out for as long as the read traffic lasts. Flip the preference to writers and the readers starve instead.
- **Unfair or barging locks.** A thread that has just released a lock or a [semaphore](../patterns/concurrency/semaphore.md) permit re-acquires it before the queued waiter finishes waking, so the waiter is passed over on every round. Barging is faster than fairness, which is why many lock and semaphore implementations default to unfair acquisition.
- **An undersized share of a partitioned resource.** Split the pool per class and each class waits only on its own capacity — but size one compartment below its arrival rate and its queue grows without bound inside the wall you built to protect it. As [bulkhead](../patterns/distributed/resilience/bulkhead.md) puts it, undersize a compartment and you have rebuilt the starvation you meant to prevent.
- **Retry amplification.** A client that times out and retries multiplies its own share of the server, so the loudest caller's second attempt crowds out the quiet caller's first. The quiet caller then times out and joins in, and the imbalance widens itself.

## What it costs
<!--meta block=cost-->

The first cost is that your instruments cannot see it. Throughput holds at target, the workers stay busy, and the error rate is zero, so every alarm that watches errors stays green while the victim's latency grows without bound. The machine looks healthy because it is healthy. What is failing is the order it serves people in, and no default host metric records that.

Averages hide it too. The starved class is a minority of the traffic by definition, so a mean or a median barely moves while one class waits forever. It shows up in the tail, in the age of the oldest item still queued, and in latency broken out per class — or it does not show up at all. Until you chart tail latency, oldest-item age and per-class latency, a customer reports the incident first.

Then comes the business cost: work that is silently never done. You meet the aggregate service-level target and miss it for one class, so the number you report and the experience you sold disagree. The backlog drains at a healthy rate while its oldest entries never move. And the low-priority job somebody marked deferrable turns out to have had a deadline nobody wrote down — a password reset, a refund, a compliance export.

## Getting out
<!--meta block=mitigation-->

Give the starved class a guarantee, and expect to pay for it. Each counter-move below hands back some of the preference you originally asked for:

- **Aging.** Raise an item's priority as it waits, so a long enough wait eventually wins. This is the standard answer and it bounds the worst case; it costs you part of the strict-priority guarantee, because a sufficiently aged low item now delays urgent work.
- **Reserved floors.** Guarantee each class a slice of capacity, such as one worker held back or a fixed share of the pool, so its worst case is bounded rather than unbounded. The bound holds only while the slice covers that class's arrival rate: 5 reports a second needs a fifth of a 25-jobs-a-second worker. You pay in utilisation, since the reserved slice idles whenever its class is quiet.
- **Fair or ticket-based queueing.** Serve in arrival order and no policy can prefer anyone, which removes starvation by construction. It costs bookkeeping and some peak throughput: the barging that starves a waiter is the same thing that makes an unfair lock fast. Under overload every class waits instead of one, because order is bounded, not delay.
- **Bounded waits.** A timed acquire or a queue-time [deadline](../patterns/distributed/resilience/timeout-deadline.md) turns an unbounded wait into an error. It does not serve the starved work. It makes the starvation visible on the error-rate dashboard that was staying green.
- **Isolation into separate pools.** Give each class its own workers and one class can no longer take another's. Size every compartment against its own arrival rate: undersize one and you have rebuilt the starvation inside the wall.

Instrument before you tune. Per-class tail latency and the age of the oldest queued item tell you whether the policy still has a floor under it; without both, every fix above is a change you cannot check.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Noisy Neighbour](./noisy-neighbour.md) — Starvation is the victim's symptom; a noisy neighbour is one way to produce it.

**Often confused with**

- [Deadlock](./deadlock.md) — Under deadlock nobody progresses; under starvation the system progresses fine while one victim never does
- [Priority Inversion](./priority-inversion.md) — Priority inversion is one way a task is starved of central processing unit (CPU) time.
- [Head-of-Line Blocking](./head-of-line-blocking.md) — Starvation is policy-driven and blocking is order-driven.

**Mitigated by**

- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — Isolate each class in its own compartment so no class can be crowded out — but undersize a compartment and the starvation reappears inside it
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — Cap the wait so a starved caller fails loudly instead of hanging forever
- [Scheduling](../patterns/concurrency/scheduling.md) — Raise priority with waiting time, or reserve a slice of capacity for each class
- [Partition Around Limits](../principles/partition-around-limits.md) — Give each tenant or class its own bounded share instead of a first-come claim on one pool

**Threatens**

- [Priority Queue](../patterns/messaging/priority-queue.md) — Low-priority items are never served while high-priority work keeps arriving
- [Read-Write Lock](../patterns/concurrency/rw-lock.md) — A stream of readers can keep a writer out indefinitely
- [Thread Pool](../patterns/concurrency/thread-pool.md) — A fixed pool is a common site where long tasks crowd out the rest
- [Semaphore](../patterns/concurrency/semaphore.md) — A semaphore whose release lets the releasing thread retake the permit starves the queued waiters.

<!-- relationships:end -->
