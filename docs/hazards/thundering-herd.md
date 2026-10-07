---
title: Thundering Herd
description: One event releases every waiter at once and they all rush the same resource
area: hazards
owner: Oleksandr Derechei
tags: [concurrency, availability]
status: stable
solves: [every waiter was released at the same instant and rushed the same resource, concurrency spikes for one second while the per-minute rate looks ordinary, the dependency came back and every waiting client hit it at once, all our tokens expire on the same clock so the crowd re-forms on a rhythm]
---

# Thundering Herd

One event releases every waiter at once — a lock unlocks, a lease expires, a service comes back — and the whole crowd rushes a resource that can only serve a few of them, so the work is mostly wasted and the resource is hit with a concurrency spike it was never sized for.

## What it is
<!--meta block=description-->

A thundering herd is many waiters released at the same instant who all rush one resource, such as a lock freed, a lease expired or a dependency back after an outage. You see a spike in concurrency, not in traffic: a minute looks ordinary, one second looks impossible. The defining trait is synchronization, not volume: the crowd built up while blocked, and it re-forms on the same clock.

## Explained
<!--meta block=explain-->

A thundering herd is many waiters released at the same instant who all rush the same resource. The crowd builds while callers are blocked, then one event lets it go, so the resource sees the depth of the queue instead of the normal arrival rate. Winners are served, and the rest wait, fail or repeat work someone else is already doing. The deeper cause is that systems synchronize themselves: clients that start together stay together, and values written together expire together. Decide first whether it hurts, since fifty aligned pollers on a database serving thousands can be ignored. Where it hurts, wake one waiter instead of all, or put a gate in front that admits a fixed number at a time. Spread expiries, schedules and reconnect delays over a random window. Where all waiters want the same answer, let one do the work and hand its result to the others, which is [request coalescing](../patterns/distributed/resilience/request-coalescing.md). After an outage, ramp traffic back in steps, since recovery is when the herd is biggest. The cache form is a [cache stampede](cache-stampede.md).

- **Follower wait.** Coalesced waiters wait for the one rebuild, and share its failure, so cap the wait with a timeout.
- **Slower recovery.** Ramping traffic in steps lengthens an outage, so size the steps from what the resource can serve warm.

**Example.** A hot cache entry gets 2,000 requests a second and takes 500 ms to rebuild from the database. When it expires, every request in the next 0.5 s misses, so 1,000 rebuilds start together against a database that handles 100 at a time. With coalescing, the first request rebuilds and the other 999 wait on its result, so the database sees 1 query. Random jitter on the expiry keeps hot entries from expiring together. Waiters can wait up to 500 ms, and if the rebuild fails all 1,000 fail with it.

## How it happens
<!--meta block=causes-->

The herd is made while you are not looking. Anything that makes callers wait quietly collects a crowd, and then one event lets the whole crowd go at once. The resource sees none of that build-up — it sees only the moment everybody arrives. The events below do the releasing.

Two ingredients are needed: a queue of waiters, and a release that is broadcast rather than handed to one of them. Waiters accumulate at the rate arrivals exceed service; the release converts that accumulated queue into instantaneous concurrency, so the resource is offered the depth of the queue rather than the rate of the traffic. The mechanisms below supply the release.

The deeper cause is that distributed systems acquire synchronization on their own. Clients that start together stay together, values written together expire together, and instances deployed together warm together — so phase alignment builds up quietly and is only spent during an incident. Nothing on this list is a bug: each one is a correct mechanism whose cost is paid by whoever owns the shared resource.

```mermaid caption="The herd re-forms while it is being served: a resource slowed by the crowd makes the next wave of waiters bigger than the last."
flowchart LR
    W["Callers block on one resource"] -->|"single release event wakes them all"| R["Whole crowd arrives at once"]
    R -->|"one succeeds, the rest contend"| C["Resource saturates on wasted work"]
    C -->|"service slows, new callers block"| W
```

- Wake-all semantics: a broadcast notification wakes every waiter for something only one of them can hold, so all but one wake, contend, fail and sleep again.
- Shared expiry: leases, tokens and cache entries issued in the same moment expire in the same moment, so every holder renews together.
- Clock alignment: a schedule on the hour, a nightly batch, a poll interval that every client set to the same value — the timers fire in the same second across the fleet.
- Recovery: a dependency comes back and every client that was blocked reconnects at once, so the first thing a just-healthy service sees is peak concurrency.
- Cold start: a deploy or a scale-up brings instances up together, and they load the same configuration, warm the same caches and open the same connections in parallel.

## What it costs
<!--meta block=cost-->

- **The resource is sized for a rate and handed a depth.** Capacity planning is done on requests per second averaged over a minute; the herd delivers the whole accumulated queue inside one of those seconds.
- **Nearly all the work is wasted.** When only one waiter can win, the others spend context switches, connections or a full recomputation to discover that someone else already did the job.
- **Latency goes bimodal.** A few callers are served at the usual speed and the rest wait behind the crowd, so the average looks fine while the tail is a different system entirely.
- **Recovery is the worst moment for it.** A dependency that just came back has cold caches and empty pools, and the reconnect wave arrives before any of that is warm — so the first thing it does after recovering is fall over again.
- **It repeats on a schedule.** Everyone served together gets a value that expires together, so unless something breaks the alignment the same spike returns every interval, forever.

The uncomfortable part is that synchronization accumulates for free while desynchronization has to be bought. Every shared deadline, every deploy, every recovery re-aligns the fleet a little more, and no ordinary load test reveals it because a test rig starts its clients at random. So you provision either for the peak concurrency of the herd — capacity you use for one second in every interval — or you spend engineering on jitter, coalescing and staged admission and provision for the mean. The second is almost always cheaper, but it is work someone has to own, whereas the first is just a bigger bill.

## Getting out
<!--meta block=mitigation-->

Wake one waiter, not all of them. Where the resource can only serve one at a time, hand it to a single waiter and leave the rest asleep; where it can serve several, put a gate in front and let a fixed number through at a time. Either way the crowd is admitted at a rate the resource can actually sustain, instead of arriving as one block.

Then break the alignment that formed the crowd. Spread expiries, schedules and reconnect delays over a random window, and size that window from what the resource can serve rather than from what looks tidy. Where the waiters all want the same answer, collapse them: let one caller do the work and give every other waiter the same result, so a thousand requests become one and the rest are free.

Recovery deserves its own plan, because that is when the herd is largest and the resource is weakest. Ramp traffic back rather than opening the gate — a fraction at a time, watched, until the caches and pools are warm. Stagger the probes too: breakers across a fleet share one cooldown, so every client's trial call lands in the same instant unless you randomize it. And watch concurrency at the resource, not request rate, because the rate that averages fine over a minute is exactly the metric that hides this.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Cache Stampede](./cache-stampede.md) — The cache-specific case: the shared resource is one expensive value to recompute

**Mitigated by**

- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — A queue absorbs the burst; consumers drain at their own rate
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — Bounds arrivals when the crowd cannot be gated at the resource
- [Request Coalescing](../patterns/distributed/resilience/request-coalescing.md) — Let the first arrival do the work and hand its result to everyone who arrived behind it
- [Semaphore](../patterns/concurrency/semaphore.md) — Permits admit a fixed number, and release wakes one waiter

**Threatens**

- [Cache-Aside](../patterns/caching/cache-aside.md) — Entries written together expire together, so every miss recomputes at once
- [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) — A fleet shares one cooldown, so every half-open trial call lands in the same instant
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — Clients that fail together retry together unless the delay is jittered
- [Lease](../patterns/distributed/coordination/lease.md) — Leases granted together expire together, and the holders all renew in the same instant
- [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) — A popular lock freeing wakes every waiter at once and hammers the lock store
- [Scheduling](../patterns/concurrency/scheduling.md) — Shared schedules such as midnight release the crowd at once
- [WebSocket](../patterns/messaging/websocket.md) — A deploy or balancer reset makes every dropped socket reconnect in the same instant.

<!-- relationships:end -->
