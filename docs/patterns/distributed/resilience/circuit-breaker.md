---
title: Circuit Breaker
description: Stops calling a service that's already failing
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, isolation, latency]
status: stable
aliases: [breaker, CB]
solves: [my thread pool is exhausted and every request hangs, one failing dependency took down my whole service, we keep hammering a downstream that is already down, a slow downstream is making my own latency explode, retries are making an outage worse instead of better]
favourite: true
---

# Circuit Breaker

Stops calling a service that's already failing — so callers fail fast instead of piling on, and the struggling dependency gets room to recover.

## What it is
<!--meta block=description-->

When a service you call stops answering, every call to it waits, holding a thread until your own service has none left. A circuit breaker wraps one dependency and counts failures. Past a threshold it opens, so calls return at once with an error or a fallback, and after a cooldown it lets one trial call test whether the dependency has recovered.

## Explained
<!--meta block=explain-->

A circuit breaker is a gate in front of one dependency. It counts recent failures and, once there are too many, stops sending calls and answers at once from a [fallback](fallback.md), such as a cached value or a plain error. Without it, a slow or dead dependency still costs a full wait per call, so every thread in your service ends up waiting and the healthy parts starve. With it, the failed calls cost a fallback instead of a wait and the sick service gets quiet time to recover. After a cooldown the gate lets one trial call through: if it works, the gate closes again; if not, it stays open. Add it to a plain [timeout](timeout-deadline.md) plus retry when the dependency is slow rather than down, because a timeout bounds one call while a breaker stops this process making the next call at all and, with shared state, every copy of your service.

- **Thresholds to tune.** They depend on your traffic, so test against a service made slow, not one switched off.
- **Masked degradation.** An open gate hides a half-healthy service, so keep health checks running.
- **Uneven counters.** Per-process counters make each copy learn of an outage alone, so share the state if they must trip together.
- **Rush at cooldown end.** Every caller returns at once, so allow just one trial call.

**Example.** Checkout calls a fraud-check service that answers in 50 ms. Checkout has 200 threads, takes 100 requests a second and times out fraud calls after 1 s. The service slows to 10 s. Without a breaker, 100 requests a second times 1 s ties up about 100 threads and makes every checkout a second slower; a retry per failure, or double the traffic, needs all 200 and the site stalls. With a breaker set to open after 20 failures in 10 s, it opens about 1.2 s after the slowdown and checkout answers in milliseconds again, queuing orders for manual review. That queues about 3,000 orders per 30 s open. Every 30 s one trial call tests the service.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a dead dependency stop costing the caller anything? The gate passes calls through until counted failures cross the threshold, then answers from the fallback until a trial call succeeds."
flowchart LR
    Caller["Your service"]
    subgraph CB["Circuit breaker — one dependency"]
        Gate["Gate: closed, open or half-open"]
        Count[("Failure count + opened-at")]
    end
    Fallback["Fallback: cached value or error"]
    Dep["Remote dependency"]:::ext
    Caller -->|"1 call"| Gate
    Gate -->|"2 pass through while closed"| Dep
    Dep -->|"3 error or timeout counted"| Count
    Count -->|"4 threshold crossed, open"| Gate
    Gate -->|"5 fail fast, no network"| Fallback
    Gate -->|"6 after cooldown, one trial"| Dep
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The three states. A closed breaker counts failures; an open one fails fast; a half-open one probes for recovery."
stateDiagram-v2
    [*] --> Closed
    Closed --> Open: failures ≥ threshold
    Open --> HalfOpen: after cooldown
    HalfOpen --> Closed: trial succeeds
    HalfOpen --> Open: trial fails
    note right of Closed: calls pass through, failures counted
    note right of Open: calls fail fast, no network attempt
    note right of HalfOpen: one trial call probes recovery
```

## Variations
<!--meta block=variations-->

- **Count-based vs. time-window** — Trip after N consecutive failures, or after a failure rate (e.g. >50% of calls in the last 10 s). Rate-based handles bursty traffic more fairly.
- **Accelerated tripping on an informative error** — Some failures announce themselves. A 429 or a 503 carrying a retry-after hint says the callee is already shedding load and names how long it wants to be left alone, which is enough evidence to open on the first response instead of waiting for a count to accumulate — and enough to hold open for the interval advertised rather than a cooldown you guessed. You are trusting a number the callee chose, so bound it: a mistaken or absurd hint would otherwise keep you open long after the dependency recovered.
- **Half-open trial policies** — Allow a single probe, or a limited number of concurrent trials, before deciding to close. With shared state, a short-lived lease decides who probes: one replica wins it, the rest stay open until the winner reports back.
- **[Fallback](./fallback.md) / degraded answer** — An open breaker can return a cached value, a default, or a queued request instead of a bare error. See [Null Object](../../gof/extra/null-object.md).
- **Per-endpoint vs. per-dependency** — One breaker per remote host, or a finer breaker per operation. Finer granularity isolates a single bad endpoint without cutting off a whole service.
- **Per-instance vs. shared state** — Counters and the open flag live in process memory, or in a store every replica reads — a row or key per dependency that expires on its own, so the open state clears without anyone sweeping it. In-process costs nothing on the call path and nothing to operate. Shared state trips the whole fleet on one replica's evidence, at the price of a lookup on the hot path and a dependency of its own in the failure path.
- **Who closes the breaker** — Normally the breaker closes itself after a successful probe. Two extensions matter under a tight recovery objective: let the recovered dependency clear its own open record rather than waiting out someone else's cooldown, and give operators an explicit force-open and force-close so a known-bad dependency can be cut off, or a healthy one restored, without a deploy. Both need shared state to act on.
- **Service-agnostic breaker** — One breaker implementation, parameterised by the name of the callee, rather than bespoke breaker code at each call site. It keeps the policy in one reviewable place and stops the same thresholds being re-guessed in every service — the difference between a breaker you can reason about fleet-wide and a dozen that only their authors understand.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Stops cascades** — One dependency's slowness no longer spreads upward as thread starvation, given a timeout on every wrapped call and a fallback that absorbs the error (see con 4).
- **Fails fast** — frees threads, sockets, and memory that would block.
- **Gives the failing dependency space to recover** instead of hammering it.
- **Its state is a high-signal health metric** for dashboards and alerts.

### Cons
<!--meta polarity=con-->

- **Another stateful component to tune** — bad thresholds cause flapping or false trips.
- **An open breaker can mask a dependency** that's only mildly degraded — pair it with [health checks](./health-endpoint.md), so something still reports on the dependency while nobody is calling it.
- **Where the state lives is a real choice**: in-process breakers trip unevenly across a cluster, and shared state fixes that at the cost of a lookup on the hot path and a dependency of its own.
- **Needs sensible fallbacks**, or "fail fast" just becomes "fail loudly."
- **A single breaker over sharded or cell-based backends** reads one bad partition as total failure and cuts off healthy ones — scope one breaker per shard or endpoint instead, and pay for the extra state and the extra dashboards.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You call a remote service or resource** that can fail or slow down.
- **Calls to it hold a resource** the rest of your service shares — a thread, a connection, a slot in a pool.
- **You want load shed off a struggling downstream** automatically, without an operator noticing first.

### Avoid when
<!--meta polarity=avoid-->

- **The call is local**, in-process, and can't fail in this way.
- **Failures are permanent, not transient** — fix the call, don't trip around it.
- **Timeout plus bounded retry suffices**: A [timeout](./timeout-deadline.md) plus a bounded [retry](./retry-backoff.md) already absorbs the blips. Add the breaker once failures are sustained, and [bulkhead](./bulkhead.md) when the shared pool is the problem.

Without it, one dead dependency freezes every caller behind it, the chain reaction named in [cascading failure](../../../hazards/cascading-failure.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — checkout to fraud check: the smallest breaker that works, state in this process"
class Breaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;                                   // true while the one trial call runs
  constructor(private threshold = 5, private cooldownMs = 30_000) {}
  private state(): "closed" | "open" | "half-open" {
    if (this.failures < this.threshold) return "closed";
    return Date.now() - this.openedAt < this.cooldownMs ? "open" : "half-open";
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state();
    if (state === "open") throw new DependencyDown();        // fail fast, no network
    if (state === "half-open") {
      if (this.probing) throw new DependencyDown();          // only the first caller probes
      this.probing = true;
    }
    try {
      const result = await fn();
      this.failures = 0;                                     // success closes it
      return result;
    } catch (err) {
      const n = ++this.failures;
      if (n === this.threshold || state === "half-open") this.openedAt = Date.now(); // first opener owns the deadline; only a failed probe restarts it
      throw err;
    } finally { this.probing = false; }
  }
}
await new Breaker().call(() => checkFraud(order, deadline));
```

```typescript summary="TypeScript — production-shaped variant: one breaker per vendor, state in a shared cache"
class SharedBreaker {
  constructor(
    private readonly kv: Kv,          // TTL-capable key-value store, shared by all workers
    private readonly vendor: string,  // "idVendor" | "sanctionsVendor"
    private readonly threshold = 5, private readonly cooldownMs = 30_000,
  ) {}
  private readonly holdMs = this.cooldownMs * 10;  // the open record outlives the cooldown
  private key(s: string) { return `cb:${this.vendor}:${s}`; }
  async call<T>(flowId: string, fn: () => Promise<T>): Promise<T> {
    const state = await this.state(flowId);
    if (state === "open") throw new VendorUnavailable(this.vendor); // fail fast
    try {
      const result = await fn();
      await Promise.all(["open", "failures", "probe"].map(s => this.kv.del(this.key(s))));
      return result;                  // success closes the breaker for everyone
    } catch (err) {
      if (state === "half-open") {
        await this.kv.set(this.key("open"), String(Date.now()), this.holdMs); // a failed probe restarts the cooldown
        throw err;
      }
      const failures = await this.kv.incr(this.key("failures"), this.cooldownMs);
      if (failures >= this.threshold) await this.kv.setIfAbsent(this.key("open"), String(Date.now()), this.holdMs); // first opener owns the deadline
      throw err;
    }
  }
  private async state(flowId: string): Promise<"closed" | "open" | "half-open"> {
    const openedAt = await this.kv.get(this.key("open"));
    if (!openedAt) return "closed";
    if (Date.now() - Number(openedAt) < this.cooldownMs) return "open";
    // Exactly one replica wins the probe lease and goes half-open. The rest stay
    // open, so a recovering vendor sees one request instead of the whole fleet.
    const won = await this.kv.setIfAbsent(this.key("probe"), flowId, this.cooldownMs);
    return won ? "half-open" : "open";
  }
}
// One compartment per vendor: a jammed sanctions list never trips ID verification.
await new SharedBreaker(kv, "idVendor").call(flowId, () => verifyDocument(personaId, deadline));
```

## In the wild
<!--meta block=wild-->

- **opossum** — The Node circuit breaker: wrap an async function and it trips on errorThresholdPercentage (50 by default) measured over a rollingCountTimeout window split into rollingCountBuckets, holds open for resetTimeout (30 s) then goes half-open, and counts a call that exceeds timeout (10 s) as a failure. A volumeThreshold keeps a quiet endpoint from tripping on one error, .fallback() supplies the degraded path, and open, halfOpen and close are events you can export as metrics. {#wild-opossum}
- **AWS Step Functions + DynamoDB** — AWS documents the breaker as shared state rather than a per-process counter: a workflow reads a CircuitStatus table before calling, fails fast if an unexpired record exists for that callee, and writes one with an expiry timestamp after the retries are exhausted. DynamoDB time to live (TTL) deletes the expired records, so the breaker closes itself with no sweeper — and every replica sees the same state. {#wild-aws-step-functions}
- **Netflix Hystrix** — Popularized the pattern in the Java virtual machine (JVM) world: trips on an error percentage over a rolling window once a minimum request volume is met (errorThresholdPercentage, requestVolumeThreshold), then waits a sleep window before probing. Now in maintenance mode, with Resilience4j the usual successor. {#wild-hystrix}
- **Envoy** — Outlier detection ejects an upstream host after consecutive 5xx or gateway failures, holds it out for a base ejection time that grows with repeat ejections, then probes it back in — with max_ejection_percent capping how much of the pool can be removed at once. {#wild-envoy}
- **Polly** — The .NET resilience library; its circuit-breaker strategy trips on a failure ratio measured over a sampling duration above a minimum throughput, and composes in a pipeline with retry and timeout. {#wild-polly}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Failure threshold** — The count of consecutive failures, or the failure-rate percentage over the window, at which the breaker opens (failureRateThreshold, errorThresholdPercentage).
- **Rolling window and minimum volume** — How many calls or how much time failures are measured over, plus the minimum call count before a rate means anything (slidingWindowSize, minimumNumberOfCalls, requestVolumeThreshold).
- **Open-state duration (cooldown)** — How long the breaker stays open before it admits a probe (waitDurationInOpenState, resetTimeout, sleepWindow). Size it from the dependency's observed recovery time, not from a round number.
- **Half-open trial count** — How many probe calls are admitted while half-open before the breaker decides to close or re-open (permittedNumberOfCallsInHalfOpenState).
- **What counts as a failure** — Which exceptions and timeouts increment the counter, and whether a call slower than a latency threshold counts even when it eventually returns (slowCallDurationThreshold, slowCallRateThreshold). Exclude errors that blame the caller (malformed request, not found); count timeouts, connection errors, 5xx and the shedding signals variations-item-2 describes.
- **Where the state lives** — In-process counters, or a shared record per dependency that expires on its own. The shared form trips the fleet together and lets a recovered callee or an operator clear it directly; it also puts a lookup on every call and a store in the failure path.

### Signals to watch
<!--meta polarity=signal-->

- **Breaker state and transitions** — Closed / open / half-open per dependency, plus the open and close events — an open breaker names the unhealthy dependency directly, with no dashboard search.
- **Failure or slow-call rate in the window** — The measured percentage the trip decision reads, next to the threshold it is compared against.
- **Fast-failed call count** — Calls rejected while the breaker is open — the load shed off the downstream, and the volume of user-facing errors that have no downstream request behind them.
- **Probe outcomes** — How many half-open trials closed the breaker versus re-opened it. Repeated re-opens mean the cooldown is shorter than the dependency actually needs.

### Failure modes under load
<!--meta polarity=failure-->

- **Threshold-induced flapping** — Thresholds set too tight make the breaker oscillate open and closed under marginal load, so it adds failures instead of preventing them.
- **Cooldown that never expires** — Concurrent callers each push the expiry out as they fail, so the open window is renewed faster than it elapses and the probe never fires. The first failure to open the breaker owns the deadline; the rest must read it, not rewrite it.
- **Per-instance state divergence** — With in-process breakers every replica has to fail enough times on its own to learn the dependency is down, so the fleet trips at different moments and the load reaching the downstream stays uncoordinated.
- **Thundering herd at half-open** — With trials unlimited, the instant the cooldown ends the whole caller pool rushes a dependency that has recovered for a few seconds at most.
- **Never trips on a quiet endpoint** — A minimum-volume window set too high means a low-traffic endpoint never accumulates the calls to trip, and the breaker sits there doing nothing through an outage.

### Readiness checklist
<!--meta polarity=check-->

- Thresholds were exercised against a dependency made slow, not one switched off — the slow case is what they exist for
- Every call the breaker wraps is bounded by a timeout
- Each breaker covers one dependency or endpoint, so one bad partition cannot cut off a healthy one
- The open state has a fallback whose user-visible behaviour someone approved, and that path runs in tests rather than first in an outage
- Breaker state and its transitions are exported as metrics, with an alert on a breaker that stays open longer than one cooldown
- Fast-failed calls are logged as rejections, so a user-facing error with no downstream request behind it is explainable
- Operators can force a breaker open or closed without a deploy

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Resilience](../../../themes/resilience.md) — Stop hammering a failing dependency so the system degrades gracefully. {#fluency-resilience}
- [Handling Spikes](../../../themes/spike-handling.md) — Fail fast when a downstream is saturated, instead of queueing forever. {#fluency-spike-handling}
- [Observability](../../../themes/observability.md) — Breaker state (open/closed) is a first-class health signal. {#fluency-observability}
- [Microservices Design](../../../themes/microservices-design.md) — Stop calling a dependency that is already failing {#fluency-microservices-design}
- [Health Modeling](../../../themes/health-modeling.md) — State that already names the failing dependency {#fluency-health-modeling}

<!-- fluency:end -->

## Check yourself
<!--meta block=selfcheck-->

> **Why trip on an error rate over a window rather than on one failure?**
>
> One slow call is noise, and a single trip would flap the breaker; the cost is thresholds you must tune, see [con 1](circuit-breaker.md#tradeoffs-con-1).

> **What can an open breaker hide, and what do you pair it with?**
>
> It stops traffic, so a mildly degraded dependency goes unobserved; a health check keeps reporting on it, see [con 2](circuit-breaker.md#tradeoffs-con-2).

> **Why is failing fast not enough on its own?**
>
> Without a fallback, fail fast just becomes failing loudly to the caller, see [con 4](circuit-breaker.md#tradeoffs-con-4).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Retry with Backoff](./retry-backoff.md) — Retry transient errors; trip the breaker on sustained ones
- [Bulkhead](./bulkhead.md) — Isolate the pool, then stop calling it when it's failing.
- [Health Endpoint Monitoring](./health-endpoint.md) — Health signals inform and corroborate breaker state.
- [Fail Fast](../../../principles/fail-fast.md) — Fails calls immediately rather than queueing on a dead dependency
- [Service Mesh](../routing/service-mesh.md) — A mesh applies it in the proxy, out of the application's hands
- [Design for Self-Healing](../../../principles/self-healing.md) — Tripping the circuit is recovery the system performs on itself
- [Fault Injection](./fault-injection.md) — Its threshold is guesswork until a deliberate fault exercises it
- [Messaging Bridge](../../messaging/messaging-bridge.md) — Stops a bridge condemning healthy messages when the far broker is simply down
- [Service Discovery](../routing/service-discovery.md) — Guards calls to an instance that discovery still believes in
- [Fallback](./fallback.md) — An open breaker answers from a fallback, such as a cached value or a default.

**Requires**

- [Timeout / Deadline](./timeout-deadline.md) — You can't trip on slowness without bounding how long a call may take.

**Often confused with**

- [Load Shedding](./load-shedding.md) — The breaker guards a caller against a sick callee; shedding guards a server against its own saturation.
- [Rate Limiter](./rate-limiter.md) — A breaker stops calls to a failing dependency; a limiter caps a caller's rate.

**Prevents**

- [Retry Storm](../../../hazards/retry-storm.md) — Failing fast beats a longer backoff against a dead service
- [Cascading Failure](../../../hazards/cascading-failure.md) — Prevents the chain reaction that ends in a total outage
- [Connection-Pool Exhaustion](../../../hazards/connection-pool-exhaustion.md) — Calls holding a shared pool slot are the case it exists for
- [Metastable Failure](../../../hazards/metastable-failure.md) — Stopping calls to an overloaded dependency lets it escape a sustained overload.

**Exposed to**

- [Thundering Herd](../../../hazards/thundering-herd.md) — Can fall into thundering herd when a fleet shares one cooldown, so every half-open trial call lands in the same instant

**Demonstrated by**

- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — one breaker per external vendor in a persona-verification saga, isolating a slow sanction-list check from a healthy ID-verification call
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — a breaker whose state is shared on purpose, with the cold-start seeding rule that a per-process copy cannot express

**Implemented by**

- [Networking](../../../capabilities/networking.md) — A mesh applies the breaker in the proxy, so every service gets it without code changes.

<!-- relationships:end -->
