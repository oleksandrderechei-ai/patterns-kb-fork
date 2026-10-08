---
title: Bulkhead
description: Isolates resources so one failure can't sink all
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, isolation, resource-management]
status: stable
aliases: [bulkhead isolation]
solves: [one slow dependency ate every thread and now unrelated endpoints time out too, a single big customer spikes traffic and starves capacity for everybody else, my connection pool is always empty because one chatty endpoint hogs it all, "checkout breaks whenever the recommendation service is slow, even though the two share no code", one runaway background job keeps dragging the whole process down with it]
favourite: true
---

# Bulkhead

Partitions threads, connections, or other shared resources into isolated compartments per dependency or tenant — so one failing or saturated consumer drains only its own pool, never the rest of the system's.

## What it is
<!--meta block=description-->

One slow dependency can hold every thread in a pool your whole service shares, so unrelated calls such as checkout fail too. A bulkhead gives each dependency its own small, fixed share of the resource. A call takes a permit from its own share or is refused at once, so exhaustion stops at the compartment, as a ship's watertight bulkheads stop a flood.

## Explained
<!--meta block=explain-->

A bulkhead gives each thing you call its own small, fixed share of a resource, such as threads or connections, so one slow dependency can use up only its own share. Without it, every call draws from one shared pool. When a dependency slows down, its calls hold threads for the full wait, soon take every thread, and calls to healthy dependencies then find none and fail as well. With separate shares, a call takes a permit from its own share or is refused on the spot, and the refusal names the dependency at fault. Nothing has to detect an error, so it works when a dependency is only slow. Choose it over a [rate limiter](rate-limiter.md) when calls pile up in progress: a limiter caps calls started per second, but when a dependency hangs, any allowed rate still piles up.

- **Idle shares.** Reserved capacity sits unused, so split only the dependencies that can stall.
- **Sizing guess.** A share too small recreates the starvation, so measure peak concurrent calls per dependency first.
- **Shared roots.** Shares on one database fill together, so split that resource too, and pair with a \[circuit breaker\](circuit-breaker.md).

**Example.** A service has 100 threads. Checkout calls payment at 50 requests a second, each taking 100 ms, so 5 threads are busy. Recommendations get 100 requests a second at 50 ms, so 5 more. Recommendations slow to 10 s. With one shared pool, 100 calls a second need 1,000 threads, the pool is empty after 1 s, and checkout fails. With a bulkhead of 20 threads each, recommendations fill their 20 in 0.2 s and every later call is refused at once, while payment still has 15 of its 20 free. The cost is 40 threads held back, and payment's 20 sit mostly idle at a peak need of 5.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one slow dependency stop taking the workers everything else needs? Each dependency draws from its own fixed set of permits, so exhaustion stops at the compartment wall and Pool B still serves Service B."
flowchart LR
    R["Incoming calls"]
    subgraph BA["One compartment, one dependency"]
        PA["Pool A — 10 permits"]
    end
    Reject["Refused on the spot"]
    PB["Pool B — 10 permits"]
    SA["Service A"]:::ext
    SB["Service B"]:::ext
    R -->|"1 route by dependency"| PA
    PA -->|"2 take a permit, call"| SA
    SA -->|"3 reply, permit released"| PA
    PA -->|"4 permits gone, refuse"| Reject
    R -->|"5 untouched, own permits"| PB
    PB -->|"6 call"| SB
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **[Thread Pool](../../concurrency/thread-pool.md) per dependency** — Dedicate a fixed-size thread pool to each downstream call. Classic and easy to reason about, at the cost of reserving threads that may sit idle most of the time.
- **[Semaphore](../../concurrency/semaphore.md) isolation** — Guard each dependency with a counting semaphore instead of a dedicated pool. Callers still run on a shared executor, but only a bounded number can be in flight per dependency. It costs no extra threads, but a hung call still holds its caller's thread, so the timeout must come from the client library.
- **Process or container isolation** — Run a workload in its own process, container, or node so a crash, memory leak, or CPU spike can't touch the rest of the fleet — the same idea enforced by the OS instead of application code.
- **Per-tenant / per-priority partitioning** — Split pools by customer tier or request priority rather than by downstream service, so one abusive or high-volume tenant can't starve capacity meant for everyone else.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Contains resource exhaustion** to one compartment instead of letting it cascade system-wide, provided the compartments share no downstream resource (see con 5).
- **A saturated pool is a precise, attributable signal** — it names the dependency whose calls are filling it; check hold time to tell a slowing dependency from an undersized pool.
- **Works even against slow degradation**, not just outright failure, since it never depends on detecting an error.
- **Compartments can be tuned** and paired with other resilience patterns independently, dependency by dependency.

### Cons
<!--meta polarity=con-->

- **More pools mean more configuration**, and reserved capacity that often sits idle — compartment the dependencies that can stall, not every call you make.
- **Static sizing is a guess**; undersize a pool and you've recreated the starvation it was meant to prevent, so measure peak concurrency per dependency before fixing the number.
- **Extra threads, connections, or processes** cost more overall than one generously-sized shared pool.
- **Isolates the damage** but does nothing to fix the failing dependency — pair it with a [circuit breaker](./circuit-breaker.md) so the compartment stops dialling a dependency that is already down.
- **Compartments that share one database, egress path or file-descriptor table saturate together**, so isolation on the diagram is not isolation at runtime. Partition the shared resource, or document the correlation.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple call paths or downstream dependencies** currently share one thread or connection pool.
- **A single slow or saturated dependency** must not be allowed to starve calls that don't even use it.
- **You serve multiple tenants or priority classes** from shared infrastructure and need to isolate them.

### Avoid when
<!--meta polarity=avoid-->

- **There's genuinely only one downstream dependency** — there's nothing else to isolate it from.
- **The resource is cheap and effectively unbounded**, so partitioning adds cost without a real benefit.
- **You are considering a [rate limiter](./rate-limiter.md) instead.** A limiter bounds arrivals per unit time, not calls held in flight, so when a dependency hangs any admitted rate piles up. Skip the bulkhead only when nothing you call can stall long enough for in-flight work to accumulate.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a semaphore-bounded worker pool per vendor"
class Bulkhead {
  private inFlight = 0;
  constructor(private readonly name: string, private readonly maxConcurrent: number) {}

  free(): number { return this.maxConcurrent - this.inFlight; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free() === 0) throw new Error(`${this.name} pool full — rejecting immediately`);
    this.inFlight++;
    try { return await fn(); }
    finally { this.inFlight--; } // always release the permit, even on error
  }
}
// One compartment per vendor, plus one for our own outbound invites.
const pools = {
  idVendor: new Bulkhead("idVendor", 20),
  sanctionsVendor: new Bulkhead("sanctionsVendor", 8),
  invite: new Bulkhead("invite", 10),
};

// Not shown: fn needs a per-call timeout so a hung vendor call frees its permit,
// and run() should export rejection and in-flight counts per pool name.
// A worker only claims a task type whose pool has room. Eight sanctions tasks
// hung on a stalled vendor therefore cannot take the slots ID verification needs.
// This holds while one loop owns each pool; with concurrent loops, reserve the permit before claimTask.
for (const [type, pool] of Object.entries(pools)) {
  if (pool.free() === 0) continue;
  const task = await claimTask(type);          // FOR UPDATE SKIP LOCKED
  if (task) void pool.run(() => runTask(task));
}
```

## In the wild
<!--meta block=wild-->

- **Resilience4j** — Two implementations: a SemaphoreBulkhead governed by maxConcurrentCalls and maxWaitDuration, and a ThreadPoolBulkhead backed by a bounded queue and fixed thread pool — each configured per named instance. {#wild-resilience4j}
- **Netflix Hystrix** — Thread-pool isolation was its default: each command group ran on its own bounded pool and queue, with semaphore isolation as a lighter alternative. Now in maintenance mode. {#wild-hystrix}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Compartment size** — The ceiling of in-flight calls one dependency may hold (maxConcurrentCalls, pool size). Size it from that dependency's measured peak concurrency, not from a shared round number.
- **Wait budget** — How long a caller blocks for a permit before it is rejected (maxWaitDuration, queue capacity). Zero is fail-fast; a bounded wait trades latency for fewer rejections in a burst.
- **Partition dimension** — The axis compartments split along — downstream service, tenant tier, or request priority. It decides which noisy neighbour you are protected from.
- **Isolation mechanism** — Semaphore permits on a shared executor, or a dedicated thread pool per dependency. The first is cheap and leaves callers on shared threads; the second isolates the threads and reserves them.
- **Total allocation** — The sum of every compartment against the threads, connections and file descriptors the host actually supplies — the bound is only real if the sum fits.

### Signals to watch
<!--meta polarity=signal-->

- **Compartment saturation** — Permits or threads in use against the ceiling, per compartment. Sustained near-full is the dial being too tight or the dependency degrading.
- **Rejection rate per compartment** — Calls turned away because a compartment was full — attributable to one dependency without further digging.
- **Permit wait and queue depth** — How long callers block before entering a compartment. Rising wait is the leading indicator; rejections are the lagging one.
- **Permit hold time** — How long a call keeps its permit. A hold time drifting upward is the dependency slowing down before any compartment is full.

### Failure modes under load
<!--meta polarity=failure-->

- **Undersized compartment** — Set too small, it rejects calls at ordinary load and recreates the starvation it was there to prevent.
- **Semaphore isolation still shares threads** — Callers run on a shared executor, so a slow dependency ties up shared threads while holding its permits. Only thread-pool isolation separates them.
- **Sum of compartments exceeds the host** — Generous compartments can total more threads or connections than the node supplies, so the process runs out before any single bound is reached.
- **Correlated compartments** — Compartments over one database or one egress path fill together, and isolation that exists on the diagram does not exist at runtime.
- **Fail-fast under a brief burst** — With a zero wait budget, a burst that would have drained in seconds becomes user-visible rejections — the compartment has no give in it.

### Readiness checklist
<!--meta polarity=check-->

- A load test with one dependency artificially stalled shows the other compartments still serving — isolation proven rather than assumed
- Every compartment exports saturation and rejections under its own name, so a full pool names its dependency with no dashboard search
- Rejection has a user-visible behaviour someone approved — an error, a queued job, a cached answer — and that path runs in tests
- The sum of all compartments was checked against the host's real thread, connection and descriptor limits
- Peak concurrency was observed per dependency during an actual peak, not inferred from average traffic
- Compartments sharing one database, cache or egress path are documented as correlated, so nobody reads more isolation into the diagram than the runtime provides

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Handling Spikes](../../../themes/spike-handling.md) — Contain the blast radius of overload — a burst aimed at one dependency cannot spend the capacity the others need. {#fluency-spike-handling}
- [Resilience](../../../themes/resilience.md) — Isolate failures to one compartment, so the rest of the service keeps serving while that one is stuck. {#fluency-resilience}
- [Microservices Design](../../../themes/microservices-design.md) — Cap what one slow dependency can consume {#fluency-microservices-design}
- [Scale Units & Stamps](../../../themes/scale-units-and-stamps.md) — The compartment drawn around an entire environment {#fluency-scale-units-and-stamps}

<!-- fluency:end -->

## Check yourself
<!--meta block=selfcheck-->

> **Why does a bulkhead work against slow degradation as well as outright failure?**
>
> It bounds concurrency per dependency and never needs to detect an error, see [pro 3](bulkhead.md#tradeoffs-pro-3).

> **How can an undersized pool defeat the pattern?**
>
> A pool that is too small recreates the starvation it was meant to prevent, so measure peak concurrency before fixing the size, see [con 2](bulkhead.md#tradeoffs-con-2).

> **Why are two compartments not isolated if they share one database?**
>
> They saturate the shared resource together, so the isolation on the diagram is not the isolation at runtime, see [con 5](bulkhead.md#tradeoffs-con-5).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Circuit Breaker](./circuit-breaker.md) — Isolate, then stop calling the failing pool
- [Thread Pool](../../concurrency/thread-pool.md) — Separate pools are a common bulkhead
- [Microkernel / Plugin](../../architecture/microkernel.md) — A plug-in in its own process is a failure boundary around untrusted code
- [Load Shedding](./load-shedding.md) — Shedding is per-instance, so isolation is what stops one saturated pool spending another's capacity
- [Design for Self-Healing](../../../principles/self-healing.md) — Isolation is what keeps a recovery local instead of global
- [Analyse Failure Modes](../../../principles/failure-mode-analysis.md) — Compartments are how a rated blast radius is made small
- [Partition Around Limits](../../../principles/partition-around-limits.md) — Compartments are partitions chosen for failure rather than for capacity
- [Deployment Stamp](../routing/deployment-stamp.md) — The compartment can be an entire deployment, not just a pool
- [Fault Injection](./fault-injection.md) — The isolation claim is unverified until something is deliberately overwhelmed
- [Fallback](./fallback.md) — A call turned away by the bulkhead can be answered from a fallback.
- [Timeout / Deadline](./timeout-deadline.md) — A permit held by a hung call is only freed when a deadline expires
- [Multi-Tenancy](../routing/multi-tenancy.md) — Compartments per tenant keep one tenant's load from spending another's capacity.
- [Semaphore](../../concurrency/semaphore.md) — A bulkhead's permit is a counting semaphore sized per dependency
- [Priority Queue](../../messaging/priority-queue.md) — Per-class queues with their own pools are the messaging form of the compartment.

**Alternative to**

- [Compute Resource Consolidation](../routing/compute-resource-consolidation.md) — Isolate into pools when shared fate is unacceptable, whatever it costs in idle capacity
- [Make Everything Redundant](../../../principles/redundancy.md) — Redundancy survives a loss; a bulkhead keeps the loss small. Pick by which costs less

**Often confused with**

- [Rate Limiter](./rate-limiter.md) — Isolate resources vs. cap request rate

**Prevents**

- [Noisy Neighbour](../../../hazards/noisy-neighbour.md) — One shared pool lets a tenant's burst queue everyone else's work
- [Cascading Failure](../../../hazards/cascading-failure.md) — Isolation stops a failed peer's load landing on everyone
- [Connection-Pool Exhaustion](../../../hazards/connection-pool-exhaustion.md) — Partitioned pools contain exhaustion to one compartment
- [Busy Front End](../../../hazards/busy-front-end.md) — Confines a heavy background workload to its own pool, so cheap requests keep their latency
- [Starvation](../../../hazards/starvation.md) — Compartments stop one class consuming the whole pool
- [Synchronous I/O](../../../hazards/synchronous-io.md) — Gives blocking work its own bounded pool so it cannot starve request workers

**Demonstrated by**

- [LeetCode](../../../designs/leetcode.md) — failure isolation confines a fault to one compartment instead of sinking every in-flight request
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — isolating each external vendor's queue, concurrency, and failure handling in a persona-verification saga so no vendor can starve another
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — the isolation applied twice — per dependency and per workload — with the vendor quota split the same way, because two pools on one ceiling are not two pools

<!-- relationships:end -->
