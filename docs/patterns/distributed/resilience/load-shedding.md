---
title: Load Shedding
description: Rejects work early once the server is past what it can serve
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, availability, latency, throughput]
status: stable
aliases: [admission control, brownout, graceful degradation under load]
solves: [under a spike every request gets slower until none of them finish in time, the server looks busy but throughput has collapsed and nobody is being served, we keep accepting work we have no chance of completing before the caller gives up, a burst of traffic takes the whole service down instead of just the excess]
---

# Load Shedding

Past the point where a server can serve everything asked of it, it stops trying — cheaply refusing the requests it cannot finish in time, so the ones it accepts still get answered instead of everything degrading until no response arrives soon enough to be worth anything.

## What it is
<!--meta block=description-->

A service that accepts everything offered fails by getting slower: queues grow, answers arrive after callers gave up and retried, and throughput collapses. Load shedding measures how busy you are right now and, past a set level, refuses some new work at once and cheaply. What you accept still finishes in time, and a fast no is worth more to a caller than a slow maybe.

## Explained
<!--meta block=explain-->

Load shedding measures how busy you are right now and, past a set level, refuses some new work at once and cheaply, so the work you accept still finishes in time. Without it, queues grow, each request waits longer, retries add load, and nobody is served. Measure how full you are, not how many requests came, for example calls in progress, queue length or latency above target. When the level is crossed, return 503 (service unavailable) with a retry-after header before any expensive work starts, and choose who loses by priority, so checkout survives and a bulk export is refused. Choose it over a queue when the caller is waiting for an answer, since a queue past capacity only adds delay and a fast no beats a slow maybe.

- **Refusals are failures.** Count them and set the level so it fires only on real overload.
- **Instant retries.** A caller that retries at once turns a refusal into more load, so require backoff in your clients.
- **Local decisions.** One hot shard can shed hard while the average looks fine, so watch per-instance numbers.

**Example.** One instance serves 100 requests a second and callers time out after 1 s. Demand is 150 a second. Without shedding, the queue grows by 50 a second, reaches 100 requests after 2 s, and from then on every answer takes over 1 s, so every caller has already given up. With a rule to refuse when 50 are queued, the wait never passes 0.5 s, the 100 accepted requests a second finish in time, and 50 a second get an instant 503. The cost is that a third of requests fail, and clients that retry at once would push demand to 200.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a server past capacity keep serving anyone? Step 2 happens before step 3 commits anything, so a refusal at step 4 costs almost nothing — and step 6 is what keeps the threshold tracking reality instead of a guess."
flowchart LR
    C["Callers"] -->|"1 request arrives"| AD["Admission check"]
    subgraph gate["Decided before any resource is committed"]
      AD -->|"2 read current saturation"| S[("Load signal: in-flight, queue depth, latency")]
    end
    AD -->|"3 under threshold, so admit"| W["Worker pool"]
    AD -->|"4 over threshold, so 503 with Retry-After"| C
    W -->|"5 served inside its deadline"| C
    W -->|"6 feeds the signal back"| S
```

The subgraph is the boundary that makes the pattern work. Once a request holds a thread, a connection or a database slot, refusing it has already spent the thing that was scarce — so the decision has to sit in front of the pool rather than inside it.

```mermaid caption="Priority is what turns shedding from a blunt instrument into a useful one. The same saturation refuses the export and admits the checkout, so the traffic worth least pays for the traffic worth most."
sequenceDiagram
    participant Lo as Bulk caller
    participant Hi as Checkout caller
    participant A as Admission check
    participant W as Worker pool
    Note over W: 34 in flight, both classes under threshold
    Lo->>A: POST /export
    A->>W: admit
    Note over W: 35 in flight, bulk ceiling reached
    Lo->>A: POST /export
    A-->>Lo: 503, Retry-After 5
    Hi->>A: POST /checkout
    A->>W: admit, the interactive ceiling is higher
    W-->>Hi: 200, inside the deadline
```

## Variations
<!--meta block=variations-->

- **Concurrency-limited admission** — Cap the number of requests in flight and refuse anything beyond it. The signal needs no tuning against traffic shape because it measures the scarce resource itself rather than a proxy for it — this is the version worth trying first.
- **Priority shedding** — Requests carry a class assigned at the edge and the threshold applies per class, so bulk work is refused well before interactive work is. It needs a classification everyone agrees on and callers who declare it honestly, and it is what makes shedding a product decision rather than a technical one.
- **[Deadline](./timeout-deadline.md)-aware shedding** — Each request carries the time it has left, and anything whose remaining budget is smaller than the current queue wait is dropped on arrival — the caller would have abandoned it anyway. It discards precisely the work that was already worthless, and it is worth nothing unless deadlines are propagated end to end.
- **Adaptive thresholds** — The limit is inferred rather than configured, by watching throughput against concurrency and settling near the point where more concurrency stops buying more throughput. It survives dependency slowdowns and hardware changes that a constant does not, at the cost of a control loop that can oscillate.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Holds throughput up under overload**: what is accepted still finishes in time, instead of everything finishing too late to matter.
- **Turns a slow, ambiguous failure** into a fast, explicit one the caller can act on — back off, fail over, or degrade its own feature.
- **Lets you choose what to lose**. With priorities, the traffic worth least absorbs the shortage.

### Cons
<!--meta polarity=con-->

- **Refusals are real failures for real users**, and they count against availability even when shedding was the right call.
- **Threshold is only as good as its signal** — on the wrong one it sheds while idle or accepts while drowning.
- **A caller that retries immediately** turns a refusal into more load, so it works only if the client honours the backoff.
- **It is local to an instance**, so a hot shard can be shedding hard while the fleet average looks healthy and nothing scales out.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Demand can outrun capacity** faster than capacity can be added, so waiting for [autoscaling](../routing/autoscaling.md) is not an answer.
- **A fast refusal serves the caller better** than a slow success — most interactive request paths.
- **Traffic separates into classes worth different amounts**, so there is something you would rather lose first.

### Avoid when
<!--meta polarity=avoid-->

- **The work is deferrable**. A durable queue that absorbs the burst serves everyone eventually, which beats refusing them.
- **Every request is equally critical** and none may be dropped, as with payment capture or an audit trail.
- **What you actually want is fairness between customers** rather than self-protection — that is a [rate limiter](./rate-limiter.md), and the two answer different questions.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — concurrency-limited admission with two priority classes"
/* The decision is made before the handler runs, so a refusal costs one
 * comparison instead of a thread, a connection and a database slot. */
const INTERACTIVE_LIMIT = 50;     // what this instance can hold in flight
const BULK_LIMIT = 35;            // bulk traffic is refused earlier

let inFlight = 0;

function admit(priority: "interactive" | "bulk"): boolean {
  const ceiling = priority === "bulk" ? BULK_LIMIT : INTERACTIVE_LIMIT;
  if (inFlight >= ceiling) return false;
  inFlight++;
  return true;
}

export async function handle(req: Request, run: () => Promise<Response>) {
  const priority = classify(req);
  if (!admit(priority)) {
    shedRate.inc({ priority });                 // count sheds separately from errors
    return new Response("overloaded", {
      status: 503,
      headers: { "Retry-After": "5" },          // tell the caller to back off
    });
  }
  try {
    return await run();
  } finally {
    inFlight--;                                 // release on failure too, or the limit leaks
  }
}

```

## In the wild
<!--meta block=wild-->

- **Envoy overload manager** — Resource monitors track proxy resources such as heap use, and configured actions react when a threshold is crossed, including refusing new requests. {#wild-envoy-overload}
- **Netflix concurrency-limits** — A Java library that adjusts a service's concurrency limit from observed latency, with a limiter that rejects requests once in-flight work reaches the limit. {#wild-concurrency-limits}
- **Google site reliability engineering (SRE) book, "Handling Overload"** — The published chapter on how a service should refuse work, by criticality and per client, rather than fail for everyone when demand passes capacity. {#wild-google-sre-overload}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Shed trigger** — The signal that starts rejection: in-flight request limit, queue wait time, CPU or memory use, or event-loop lag. Queue wait and concurrency track overload sooner than CPU does.
- **Fixed or adaptive limit** — A hand-set concurrency cap against one that adjusts from observed latency. A fixed cap goes stale as the service or its dependencies change.
- **What to drop first** — By priority class, by cost, or newest against oldest. Drop low-priority and already-late work first, or you spend capacity on answers nobody waits for.
- **Rejection response** — A fast error such as 429 or 503, with a retry-after hint if clients honour it. A slow rejection costs the capacity you were trying to protect.
- **Recovery margin** — The gap between the level that starts shedding and the one that stops it. A zero gap makes the shedder flap.

### Signals to watch
<!--meta polarity=signal-->

- **Rejected requests by priority** — Rate of rejections per class. Rejections in the highest class mean the capacity is wrong, not the policy.
- **In-flight requests against the limit** — How close to the cap the service runs in normal load.
- **Queue wait of admitted requests** — The p99 wait before work starts. It should stay under client timeouts when shedding works.
- **Goodput against offered load** — Successful responses per second as incoming load rises. It should plateau at capacity, not fall.

### Failure modes under load
<!--meta polarity=failure-->

- **Shedding starts too late** — The queue is already deep, admitted requests outlive client timeouts, and the server finishes work nobody reads.
- **Critical traffic shed equally** — Health checks, auth or payments are rejected with the rest. You see a restart loop or failed logins during the overload.
- **Retry amplification** — Rejected clients retry at once, and the load that caused the shedding grows. You see offered load rise after the first rejections.
- **Flapping at the threshold** — The service alternates between accepting and shedding every few seconds, so users see random failures.
- **Expensive rejection** — The service parses, authenticates and logs before it rejects, so shedding does not free the capacity it should.

### Readiness checklist
<!--meta polarity=check-->

- A load test pushed past capacity shows goodput holding flat rather than collapsing
- Priority classes are assigned and tested, with health checks exempt
- Clients back off on rejection or honour a retry-after hint
- The reject path is cheap and runs before the costly work
- Shed counts are exported and alerting treats sustained shedding as a capacity problem

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Handling Spikes](../../../themes/spike-handling.md) — Refuse some work early, cheaply, so the work you accept still finishes in time. {#fluency-spike-handling}
- [Streaming](../../../themes/streaming.md) — Drop the least valuable events when a stage is overloaded and the producer cannot be slowed. {#fluency-streaming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Bulkhead](./bulkhead.md) — Partitions bound which pool saturates; shedding decides what to do once one has
- [Backpressure](../../concurrency/backpressure.md) — Backpressure asks the producer to slow down; shedding refuses when it will not or cannot
- [Retry with Backoff](./retry-backoff.md) — A refusal only helps if the caller backs off — otherwise it returns as more load
- [Autoscaling](../routing/autoscaling.md) — Shedding holds the line for the minutes capacity takes to arrive
- [Request Coalescing](./request-coalescing.md) — Coalescing removes duplicate demand; what remains is genuine, and shedding decides how much of it fits
- [Design for Operations](../../../principles/design-for-operations.md) — Shedding is a designed response to overload rather than an improvisation
- [Build for the Needs of the Business](../../../principles/build-for-business.md) — What to drop first is decided before the incident, not during it
- [Feature Flag](../routing/feature-flag.md) — The operator can drop optional work by flipping it off

**Alternative to**

- [Rate Limiter](./rate-limiter.md) — Self-protection from a live load signal, rather than a per-client quota agreed in advance
- [Queue-Based Load Leveling](./load-leveling.md) — Refuse the burst when the work cannot wait; queue it when it can
- [Fallback](./fallback.md) — Shedding refuses early and cheaply, and a fallback that does extra work during overload deepens it.

**Often confused with**

- [Leaky Bucket](./leaky-bucket.md) — Shedding refuses by measured saturation and never makes the caller wait.
- [Circuit Breaker](./circuit-breaker.md) — Shedding refuses by measured saturation; a breaker stops calling what already failed.

**Prevents**

- [Cascading Failure](../../../hazards/cascading-failure.md) — Refusing the excess is what stops one saturated service dragging its callers down with it
- [Metastable Failure](../../../hazards/metastable-failure.md) — Shedding by measured saturation is the usual way out of a metastable state.

**Demonstrated by**

- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — shedding published as a contract term rather than applied as an incident measure, with the drain-rate signal that decides when it fires

<!-- relationships:end -->
