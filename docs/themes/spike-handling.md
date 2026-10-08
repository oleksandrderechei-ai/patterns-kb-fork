---
title: Handling Spikes
description: "Absorb, shed, or scale when traffic suddenly surges"
area: themes-scale
owner: Oleksandr Derechei
tags: [scalability, backpressure, availability]
status: stable
aliases: [traffic spikes, burst handling]
---

# Handling Spikes

Traffic never arrives at a steady pace — a flash sale, a viral post, or a retry storm can multiply request rate in seconds. A resilient system doesn't just survive that moment; it decides, deliberately, whether to absorb the burst, shed the excess, or scale to meet it.

## The question
<!--meta block=description-->

Every system is sized for a steady load and eventually sees a rate far past it: a marketing push, every client firing a cron job at once, a retry storm after an upstream blip. What happens in the seconds before anyone can add capacity by hand? Three answers exist. Absorb the burst in a buffer, which trades latency. Shed the excess, which trades completeness. Scale, which trades time. The weakest link saturates first, so contain the damage there.

## Explained
<!--meta block=explain-->

When traffic suddenly passes what your system was sized for, you have three honest answers, and each costs something different. Absorb the burst by queuing the work and draining it at a rate you can sustain, which costs delay. Shed it by refusing the excess so that what gets through succeeds, which costs the refused requests. Scale by adding capacity so the surge becomes the new normal, which costs time, since nothing starts instantly. They work on different timescales, so a mature system layers them: shed what is clearly over budget, queue the legitimate burst, and scale in the background so the queue actually drains. A queue has a limit too, so cap its length at the spare drain rate times the longest wait users accept, and tell producers to slow down. Without containment, one saturated dependency adds waiting to every caller and the overload spreads, so give each dependency its own share of threads and stop calling one that is failing. Choose shedding over a bigger queue when users would give up before the delay ends.

**Example.** A service handles 1,000 requests a second and normally gets 600. A launch sends 3,000 a second for 60 s. Absorbing queues 2,000 a second for 60 s, a 120,000 request backlog. With 400 a second of spare capacity afterward, it takes 300 s to drain, and the longest wait is 120 s: 120,000 requests are ahead of the last spike request, served at 1,000 a second. Shedding refuses 2,000 a second, 120,000 refusals, but everyone else is served at once. Scaling is too slow here: new copies take 90 s to start, and the 60 s spike is over by then.

## The trade-space
<!--meta block=tradespace-->

Absorb, shed, and scale are not competing strategies you pick once. They operate on different timescales and compose. Scaling is slow but raises the ceiling; absorbing is instant but finite (a queue has a limit too); shedding is instant and not bounded by queue size, but sacrifices some requests to save the rest. A mature system layers all three: shed the traffic that's clearly over budget, absorb the legitimate burst in a queue while capacity catches up, and scale in the background so the queue actually drains instead of growing forever. Set the shed budget from load-tested capacity, then check it against the longest wait users accept, and shed the least important requests first, not at random. Two buckets pace traffic at the edge: [Token Bucket](../patterns/distributed/resilience/token-bucket.md) lets a quiet caller burst and then paces it, while [Leaky Bucket](../patterns/distributed/resilience/leaky-bucket.md) turns a burst into a short wait at a fixed rate and refuses only what overflows the queue. When the spike is identical reads on one hot key, [Request Coalescing](../patterns/distributed/resilience/request-coalescing.md) cuts the duplicate demand, so shedding and queues only deal with the demand that is left. Retries from refused callers can turn shedding into a bigger spike, so pace them with [Retry Backoff](../patterns/distributed/resilience/retry-backoff.md).

None of that helps if the overload is allowed to spread. A saturated dependency that keeps getting called just adds latency everywhere that calls it. Containment (bulkheads, circuit breakers) therefore sits alongside the three primary strategies rather than as a fourth option: it's what keeps one overwhelmed part from taking down the parts that are still healthy. The [Distributed Rate Limiter](../designs/distributed-rate-limiter.md) case study enforces per-client quotas at the edge of a fleet.

```mermaid caption="The three strategies compose — containment keeps the overloaded part from sinking the rest."
flowchart TB
    S{"Spike detected"}
    S -->|"Elastic capacity available"| SC["Scale out via autoscaling"]
    S -->|"Bursty but bounded"| AB["Absorb in a queue, drain steadily"]
    S -->|"Downstream already saturated"| SH["Shed with a rate limiter, fail fast"]
    AB -->|"queue filling"| BP["Backpressure tells producers to slow down"]
    SH -->|"dependency failing"| CB["Circuit breaker stops cascading failure"]
```

## Patterns that implement the choice
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) {#tour-load-leveling}

Absorb the burst in a queue. A producer can write as fast as the spike demands while a consumer drains it at whatever rate it can actually sustain — the cost is latency and a backlog to work through, not dropped work.

### [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) {#tour-rate-limiter}

Shed load above a safe rate. Requests past the threshold are rejected immediately instead of accepted only to fail deeper in the stack — it protects capacity for the traffic that's already in flight.

### [Token Bucket](../patterns/distributed/resilience/token-bucket.md) {#tour-token-bucket}

Capacity sets how big a burst you tolerate and the refill rate sets the long-run average. A quiet caller can spend a whole bucketful at once, then is paced to the refill rate, so a surge from a normal spiky client is not punished while a sustained flood is.

### [Leaky Bucket](../patterns/distributed/resilience/leaky-bucket.md) {#tour-leaky-bucket}

Requests join a queue of fixed size and leave at a fixed rate, so a burst becomes waiting and the target never sees a spike. When the queue is full the rest are refused. You pay in delay for the requests that wait.

### [Autoscaling](../patterns/distributed/routing/autoscaling.md) {#tour-autoscaling}

Add capacity as the surge builds. A load signal — central processing unit (CPU), queue depth, request rate — triggers new instances so throughput grows with demand; because it's never instant, it's a complement to absorbing and shedding during ramp-up, not a substitute for them. Measure how long a new instance takes to start; if that is longer than the spike, scaling cannot help.

### [Backpressure](../patterns/concurrency/backpressure.md) {#tour-backpressure}

Signal upstream to slow down. Rather than silently dropping work or buffering without limit, the receiver tells the sender to pause, giving a queue downstream time to drain before memory or disk runs out.

### [Load Shedding](../patterns/distributed/resilience/load-shedding.md) {#tour-load-shedding}

Backpressure asks the producer to slow down; load shedding refuses when it will not or cannot. Past a live saturation signal, such as queue depth or in-flight concurrency, the admission check returns a fast 503 so what you do accept still finishes inside its deadline.

### [Bulkhead](../patterns/distributed/resilience/bulkhead.md) {#tour-bulkhead}

Contain the blast radius of overload. Partitioning resources — thread pools, connection pools — per dependency means one saturated downstream can't starve every other request path sharing the same pool.

### [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) {#tour-circuit-breaker}

[Fail fast](../principles/fail-fast.md) when downstream is saturated. Once a dependency's failure rate crosses a threshold, stop calling it and return quickly instead of piling up latency and threads waiting on a call unlikely to succeed.

### [CDN](../patterns/distributed/routing/cdn.md) {#tour-cdn}

Serve the static surge from the edge. Cacheable responses live on nodes near the user, so repeat reads for a viral asset are served from the edge and only a cache miss reaches origin.

### [Cache-Aside](../patterns/caching/cache-aside.md) {#tour-cache-aside}

Take read pressure off the origin. Populate a cache on first miss, then serve every repeat read from it — so a burst of identical reads hits the cache, not the database, on the way through.

### [Request Coalescing](../patterns/distributed/resilience/request-coalescing.md) {#tour-request-coalescing}

A surge on a hot key sends hundreds of identical misses to the origin at once. A gate in front of the fetch lets the first caller do the work while the rest wait on its result, so duplicate demand through that gate never reaches the backend; one gate per process still lets each process send one. The genuine demand left is what shedding has to size.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Strategy | Reach for |
| --- | --- | --- |
| Smooth a burst of work without losing any of it | Absorb | [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) |
| Cap traffic at a fixed safe rate, whatever the server's current load | Shed | [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) |
| Let one client burst briefly but cap its sustained rate | Shed | [Token Bucket](../patterns/distributed/resilience/token-bucket.md) |
| Hold a partner API to an exact steady rate whatever the burst | Smooth | [Leaky Bucket](../patterns/distributed/resilience/leaky-bucket.md) |
| Grow capacity to meet a sustained surge | Scale | [Autoscaling](../patterns/distributed/routing/autoscaling.md) |
| Stop a downstream queue from growing unbounded | Signal | [Backpressure](../patterns/concurrency/backpressure.md) |
| Keep one saturated dependency from starving others | Isolate | [Bulkhead](../patterns/distributed/resilience/bulkhead.md) |
| Every request slows down until none finish in time, so refuse work on live saturation (queue depth, in-flight requests) | Shed | [Load Shedding](../patterns/distributed/resilience/load-shedding.md) |
| Stop hammering a downstream that's already failing | Fail fast | [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) |
| Take read-heavy spikes off the origin entirely | Edge / cache | [CDN](../patterns/distributed/routing/cdn.md), [Cache-Aside](../patterns/caching/cache-aside.md) |
| Hundreds of identical reads hit the origin when one hot key expires | Collapse | [Request Coalescing](../patterns/distributed/resilience/request-coalescing.md) |

## Related areas
<!--meta block=siblings-->

- [Resilience](./resilience.md) — Containing overload so one saturated part doesn't take down the rest is a resilience concern too. Go there when the trigger is a failing dependency rather than a load surge.
- [Scalability](./scalability.md) — Autoscaling and sharding are how "scale" as a spike response actually gets built.
- [Performance](./performance.md) — Caching and edge delivery cut the load a spike generates in the first place.
- [Scaling Writes](./scaling-writes.md) — Its ladder ends in queues and load shedding, the write-path form of these spike answers; go there when the surge is on writes.
- [Scaling Reads](./scaling-reads.md) — CDN, Cache-Aside and Request Coalescing also sit on its read ladder; go there when the load is steady read growth, not a sudden surge.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Securing Availability](./securing-availability.md) — Edge rejection of hostile floods reuses the screening controls this theme covers.

<!-- relationships:end -->
