---
title: Timeout / Deadline
description: Caps how long a call may take before giving up
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, latency, resource-management]
status: stable
aliases: [deadline propagation, request deadline]
solves: [my request just hangs forever and never comes back, a stuck call is holding a connection open and now the pool is dry, the user waited nine seconds because three chained services each waited three, one slow backend makes the entire page take forever to load, i promise a two second response but nothing in my code actually enforces it]
favourite: true
---

# Timeout / Deadline

Caps how long any single call may run, and lets a deadline bound an entire chain of calls to one shared budget, so a caller gives up cleanly instead of waiting forever.

## What it is
<!--meta block=description-->

A call that never answers holds a thread and a connection, and so does the next, until your service has nothing left to serve anyone. A timeout caps the wait for one call. A deadline is a time set once at the top of a request and passed to every service it calls, so each shrinks its wait to the budget left. When time runs out, you give up and free the thread.

## Explained
<!--meta block=explain-->

A timeout limits how long you wait for one call, and a deadline limits the whole request, shared by every service it passes through. When the time is up you give up, free the thread and report the failure. A deadline is a clock time set once at the top and passed along with each call, so every service shrinks its own wait to what is left. Choose it over a separate timeout per call when one request crosses several services, because separate timeouts add up: a 500 ms budget becomes seconds when three services each wait a fresh 500 ms. An unbounded wait is a cost nobody priced, because a thread, a socket and a pool slot stay pledged to a dependency for as long as it stays silent.

- **Too tight aborts.** It aborts calls that would have succeeded, so base it on the dependency's measured p99 (the time 99 of 100 calls beat).
- **Giving up is not stopping.** A write may still land after you left, so use a unique key and a later check.
- **Clock skew.** Hosts disagree on the time, so send the time remaining where you cannot trust clocks.

**Example.** A request has a 500 ms budget and calls services B, C and D one after another, each with its own 500 ms timeout. All three are slow, so the caller can wait 1,500 ms. With a deadline set once at 500 ms, B takes 300 ms, so C is given the 200 ms left, times out at 500 ms, and D is never called. The caller gets its failure at 500 ms. The cost is that C might have needed 250 ms and succeeded, and C may still finish its write after the caller left, so C's write needs a unique key and a check later.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one silent dependency stop holding a thread forever? The budget set once at the top shrinks at every hop, and whoever is still waiting when it reaches zero gives up and reports it."
flowchart LR
    Client["Caller"]
    subgraph Budget["One deadline, computed once at the top"]
        A["Service A"]
        B["Service B"]
    end
    Dep[("Vendor or database")]:::ext
    Give["Give up: free the thread, say so"]
    Client -->|"1 request, 500 ms budget"| A
    A -->|"2 forward what is left of it"| B
    B -->|"3 call, bounded by the remainder"| Dep
    Dep -->|"4 answer inside the budget"| B
    B -->|"5 budget gone, abort"| Give
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What happens to a call when the shared deadline runs out mid-hop? The budget set once at the top shrinks through each hop; whichever hop is still working when it hits zero aborts, and the error propagates straight back to the caller."
sequenceDiagram
    autonumber
    participant C as Caller
    participant A as Service A
    participant B as Service B
    C->>A: call, deadline 500ms from now
    A->>B: forward, budget now 320ms
    alt B replies within budget
        B-->>A: result
        A-->>C: result
    else budget hits zero
        B--xA: deadline exceeded
        A-->>C: abort, deadline exceeded
    end
```

## Variations
<!--meta block=variations-->

- **Timeout vs. deadline** — A timeout resets with every retry; a deadline does not — three retries at a 200 ms timeout can burn 600 ms even though the caller only budgeted 300 ms total.
- **Absolute vs. relative deadline** — Propagate a fixed wall-clock instant rather than a duration, so clock skew and processing delay between hops don't silently eat into the remaining budget.
- **Idle vs. total timeout** — An idle timeout bounds the gap between bytes on a connection; a total timeout bounds the whole operation — a slow trickle can satisfy the first while blowing through the second.
- **Deadline propagation mechanisms** — Carried as a context value, a gRPC deadline, or an HTTP header, so every service in the chain enforces the same shared clock instead of inventing its own.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Guarantees no caller waits indefinitely** on a hung or unresponsive dependency.
- **Frees the thread**, socket, or connection-pool slot a stuck call would otherwise hold hostage.
- **Propagated end-to-end**, it caps the total latency of an entire call chain, not just one hop.
- **Costs almost nothing to add** — one value threaded through calls, no new infrastructure.

### Cons
<!--meta polarity=con-->

- **Set too tight**, it aborts calls that would have succeeded a moment later — compute it from that dependency's measured p99 with headroom, not from a round number.
- **Set too loose, it barely helps** — the resource exhaustion it's meant to prevent still has time to happen.
- **Without propagation**, each hop's fresh timeout can multiply total wait time far past what the caller intended — pass the remaining budget forward and let every hop shrink to it.
- **Timeout is not proof of failure** — it only tells you the caller gave up; the remote side may have already committed the work, so give the operation an [idempotency key](../../messaging/idempotency.md) and a reconciliation path before you treat an expiry as a failure.
- **Deadlines depend on clock accuracy** — an absolute deadline is only as good as the clocks carrying it: skew between hosts hands a downstream more or less budget than the caller meant to give it. Keep hosts synchronized, and send the remaining duration instead where you cannot trust the clock.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Any call crosses a process**, network, or disk boundary and could hang or run unexpectedly long.
- **A request fans out across several chained services** that should share one latency budget.
- **A stuck dependency could tie up** your own threads, sockets, or connection-pool slots.

### Avoid when
<!--meta polarity=avoid-->

- **The operation is local**, in-process, and bounded by nature — there's nothing to time out on.
- **The work is fire-and-forget** with no caller waiting on the result — there's no one to give up on its behalf.
- **You need the underlying work truly cancelled**, not just ignored — pair it with real cancellation, or the call keeps running after you've stopped waiting on it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — one shrinking deadline across two vendor calls"
class Deadline {
  private readonly at: number;

  constructor(ms: number) {
    this.at = Date.now() + ms;
  }

  remaining(): number {
    return Math.max(0, this.at - Date.now());
  }

  async run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.remaining() === 0) throw new Error("deadline already exceeded");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.remaining());
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

// Neither vendor publishes a latency bound, so the task carries its own: one
// budget for the whole step, and the second call gets only what the first left.
const deadline = new Deadline(20_000);
const doc = await deadline.run(signal => idVendor.verify(personaId, flowId, signal));
await deadline.run(signal => sanctionsVendor.screen(doc.name, flowId, signal));
// Exhausting the budget aborts the leg and fails the task loudly, so it is
// rescheduled rather than sitting on a worker slot until the lease expires.
```

## In the wild
<!--meta block=wild-->

- **gRPC** — Deadlines are first-class and absolute: the client sets one, it travels with the request as the grpc-timeout header, a server can read the time remaining from its context, and a breach surfaces as the DEADLINE_EXCEEDED status — propagating through chained calls when the context is forwarded. {#wild-grpc}
- **Go context** — context.WithTimeout and WithDeadline return a context whose Done channel closes when time runs out and whose Err reports context.DeadlineExceeded; threading it through a call tree gives every function a shared cancellation deadline to select on. {#wild-go-context}
- **Envoy** — A per-route timeout (default 15s) bounds the whole proxied request so a hung upstream cannot hold the connection open indefinitely; a separate per-try timeout bounds each retry attempt and an idle timeout reaps quiet connections. {#wild-envoy}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Per-attempt timeout** — How long a single call may run before the caller treats it as failed.
- **End-to-end deadline** — The budget computed once at the top of the request and propagated to every hop, so total latency is capped once instead of per hop.
- **Idle against total timeout** — Separate dials for the gap between bytes on a connection and for the whole operation. A slow trickle satisfies the first and blows through the second.
- **Propagation mechanism** — How the remaining budget travels — a gRPC deadline, a context value, an HTTP header — and whether it carries an instant or a duration.
- **Connection-phase timeouts** — Separate bounds on connect and on Transport Layer Security (TLS) handshake, which fail for different reasons than a slow response and are often left unset by client-library defaults.

### Signals to watch
<!--meta polarity=signal-->

- **Timeout rate** — The share of calls aborted at the limit, per dependency. Rising means the value is too tight or the dependency is degrading.
- **Headroom above p99** — The gap between the timeout and observed p99 or p99.9 latency. Little headroom means ordinary slow calls are being converted into errors.
- **Resource occupancy** — Threads, sockets and pool slots held by in-flight calls — the resource an unbounded wait consumes, watched while it is still recoverable.
- **Budget exhausted on arrival** — Requests reaching a hop with no time left. That hop is failing for something an earlier hop spent, and the trace names which one.

### Failure modes under load
<!--meta polarity=failure-->

- **Too tight under load** — A timeout below real latency aborts calls that would have succeeded, and the retries behind it add load to a dependency that was only slow.
- **No propagation** — Each hop starts a fresh timeout, the waits stack, and the caller waits far past the budget it set at the top.
- **Abandoned but still running** — The caller stopped waiting; the remote side did not stop working, and may commit after the caller has reported failure.
- **Clock skew on absolute deadlines** — A wall-clock instant propagated between hosts with unsynchronized clocks arrives early or late, so a hop gets a budget nobody intended.
- **Synchronized expiry** — One shared dependency crossing the threshold makes every caller time out at the same instant, and their retries arrive together as a second wave.

### Readiness checklist
<!--meta polarity=check-->

- No call crossing a process, network or disk boundary is left unbounded — including the ones inside client libraries, whose default is often no timeout at all
- Each value was computed from that dependency's measured latency, and the measurement is recent enough to still be true
- A traced request through the whole chain shows the end-to-end wait matching the budget set at the top, not the sum of the hops
- The unknown outcome has an owner: when a call expires, an idempotency key or a reconciliation path decides whether the work happened
- Retried attempts draw on the same deadline instead of resetting it, verified against a dependency held slow on purpose
- The timeout, retry and breaker settings around one dependency were reviewed together, so tightening one does not quietly multiply the others

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Resilience](../../../themes/resilience.md) — Never wait forever — a bounded wait is what gives the thread, the socket and the caller an answer. {#fluency-resilience}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Sweeper](../coordination/sweeper.md) — a deadline nobody checks is a comment — a periodic scan is what turns it into an outcome
- [Service Mesh](../routing/service-mesh.md) — Mesh policy sets timeouts fleet-wide instead of per client library
- [Fail Fast](../../../principles/fail-fast.md) — A bounded wait is how a call fails fast instead of hanging
- [Idempotency](../../messaging/idempotency.md) — An expiry means unknown, not did-not-happen — reconciliation needs a key
- [Request Coalescing](./request-coalescing.md) — Cap the shared in-flight call, because its waiters all inherit whatever it does
- [Analyse Failure Modes](../../../principles/failure-mode-analysis.md) — A deadline is the decided response to a dependency that answers late
- [Fault Injection](./fault-injection.md) — A deliberate slow dependency is what reveals the bound was never set
- [Fallacies of Distributed Computing](../../../principles/fallacies-of-distributed-computing.md) — A deadline is the habit the fallacies of reliability and zero latency call for.
- [Fallback](./fallback.md) — Without a fallback, a timeout turns a slow call into a plain error.
- [Hedged Request](./hedged-request.md) — A hedge turns a slow call into a fast one before the timeout turns it into an error.
- [Bulkhead](./bulkhead.md) — Bounds how long a call holds its compartment's permit
- [Scatter-Gather](../../messaging/scatter-gather.md) — A fan-out call needs one deadline for the whole gather, not one per recipient.

**Alternative to**

- [Heartbeat](../coordination/heartbeat.md) — When a request is in flight a deadline suffices, so no heartbeat is needed.

**Enables**

- [Circuit Breaker](./circuit-breaker.md) — You can't trip on slowness without timeouts
- [Retry with Backoff](./retry-backoff.md) — A bounded attempt is what gives retry a clear failure to react to

**Prevents**

- [Deadlock](../../../hazards/deadlock.md) — A lock-acquisition timeout breaks an otherwise indefinite circular wait
- [Cascading Failure](../../../hazards/cascading-failure.md) — Callers that wait unbounded exhaust themselves and spread it
- [Connection-Pool Exhaustion](../../../hazards/connection-pool-exhaustion.md) — A stuck dependency otherwise ties up every pool slot
- [Starvation](../../../hazards/starvation.md) — A bounded wait turns an unbounded one into a visible error
- [Leaky Abstraction](../../../hazards/leaky-abstraction.md) — Forces a substrate's latency and failure into the interface, where it cannot be forgotten
- [Metastable Failure](../../../hazards/metastable-failure.md) — Dropping expired requests stops the work done for callers who have left.
- [Head-of-Line Blocking](../../../hazards/head-of-line-blocking.md) — A timeout stops a hung item from blocking the lane forever.

**Demonstrated by**

- [Payment System](../../../designs/payment-system.md) — payments illustrate the subtlety that a deadline expiring means 'unknown', not 'did not happen'
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — bounding an ID-verification and a sanction-check call that publish no latency guarantee of their own
- [LeetCode](../../../designs/leetcode.md) — a bounded deadline caps work that could otherwise run forever and pin a core
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — deadlines as columns rather than call settings, which is what turns a silent third party into a breach somebody is paged for

**Implemented by**

- [Networking](../../../capabilities/networking.md) — A mesh sets per-route timeouts in configuration, so a slow call is cut off outside your code.

<!-- relationships:end -->
