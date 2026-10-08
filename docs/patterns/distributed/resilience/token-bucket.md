---
title: Token Bucket
description: Caps the average rate but lets short bursts through
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, throughput, resource-management, availability]
status: stable
aliases: [token bucket algorithm]
solves: [one client is hammering my API and starving everyone else, I need to allow short bursts of traffic but cap the sustained rate, my fixed-window counter lets double the requests through at the window boundary, a flood of requests is overwhelming my backend and I need to throttle callers, how do I let each user make N requests a second while still allowing an occasional spike]
---

# Token Bucket

Meters work against a bucket of tokens that refills at a steady rate — letting callers burst up to the bucket's size, then pacing everything to the refill rate.

## What it is
<!--meta block=description-->

Real traffic is spiky, so a strict constant-rate limiter refuses honest bursts, and a fixed-window counter can let double the rate through at a window edge. A token bucket holds up to a set number of tokens and refills at a steady rate. Each request takes one, so a quiet caller can burst a full bucket, then is paced to the refill rate.

## Explained
<!--meta block=explain-->

A token bucket lets a caller send bursts while holding its long-run average to a set rate. Picture a bucket that holds up to C tokens and gains r tokens a second until it is full. Each request takes a token, and if the bucket is empty the request is refused or made to wait. A caller who has been quiet finds a full bucket and can spend it all at once, then is held to r a second. Capacity sets the biggest burst and the refill rate sets the average. Choose it over a fixed-window counter, which lets double the rate through across the edge between two windows. Choose it over a [leaky bucket](leaky-bucket.md) unless the target cannot take a burst at all. Envoy, Go's x/time/rate and AWS API Gateway all run it.

- **Per-copy buckets.** Each copy multiplies the allowed rate, so keep one shared bucket, which adds an atomic call to every request.
- **Big bursts.** A big bucket can flatten a fragile downstream, so size capacity to what it absorbs.
- **Tuning.** Both numbers need tuning, so start from measured traffic.

**Example.** A bucket holds 100 tokens and refills 10 a second. A client quiet for 30 s finds it full at 100, not 300, because refill stops at capacity. It sends 100 requests at once and all pass. In the next second 50 more arrive: 10 pass on the new tokens and 40 are refused. Over any 60 s the most it can send is 100 plus 600, which is 700. If the downstream takes only 50 a second, the first burst is twice what it can absorb, so capacity should have been 50.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a caller who has been quiet get to spend a burst without ever beating the average? Step 2 tops the bucket up from the clock and stops at C, so the burst is bounded by the bucket and the long run by the refill rate."
flowchart LR
    Caller["Caller"]
    L["Limiter"]
    subgraph Bkt["One bucket per caller"]
        Tokens[("Token count + last-refill time")]
    end
    Svc["Protected service"]:::ext
    Caller -->|"1 request"| L
    L -->|"2 add elapsed x r tokens, capped at C"| Tokens
    L -->|"3 spend one token"| Tokens
    L -->|"4 forward the request"| Svc
    Svc -->|"5 response"| Caller
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What happens when the bucket runs dry? The limiter refuses the request and tells the caller when to come back, so the burst allowance and the sustained rate stay separate promises."
sequenceDiagram
    autonumber
    participant C as Caller
    participant L as Limiter
    participant B as Bucket
    participant S as Service
    C->>L: request
    L->>B: add elapsed x r tokens, clamp to capacity C
    alt at least one token
        L->>B: subtract the request's cost
        L->>S: forward
        S-->>C: 200
    else bucket empty
        L--xC: 429 with Retry-After
        Note over L,B: the caller is paced to r until tokens accrue again
    end
```

## Variations
<!--meta block=variations-->

- **Token bucket vs. leaky bucket** — Both bound a rate, and which leaky bucket you mean decides the rest. As a queue it holds arrivals and drains them at a strictly constant rate, so nothing bursty leaves it. This queue form is the strict twin. As a meter it queues nothing and only marks each arrival as conforming or not. With the same rate and size it admits exactly what a token bucket admits, because smoothing comes from queueing the work, not from the accounting. Use the queue form for perfectly smooth output, and the token bucket when a burst is fine.
- **Lazy (on-demand) refill** — Instead of a background timer dripping tokens in, store a `lastRefill` timestamp and, on each request, add `elapsed × rate` tokens (capped at capacity). No thread, no scheduler — the standard implementation.
- **Distributed / shared bucket** — Keep the token count in a shared store so a whole cluster enforces one global rate rather than one rate per replica. Correctness then rests on an atomic check-and-decrement (for example a Redis Lua script).
- **Weighted / cost-based tokens** — Let an expensive request cost more than one token — by payload size, query complexity, or price tier — so the limit tracks real work rather than raw request count.
- **Hierarchical buckets** — Layer buckets: a per-user bucket plus a global bucket, and a request must draw a token from every level it passes through. This bounds any single caller and the aggregate at once.
- **GCRA (meter-form leaky bucket)** — The generic cell rate algorithm, from ATM traffic control, is the meter-form leaky bucket. It stores one timestamp per key, the earliest time the next request conforms, instead of a count plus a refill time.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Allows bursts up to capacity** while bounding the long-run average rate — two independent dials.
- **Cheap and O(1)**: each bucket is just a token count plus a last-refill timestamp.
- **Lazy refill** needs no background timer or scheduler thread.
- **Fairer than a fixed-window counter**, which lets a double burst slip across the window boundary.

### Cons
<!--meta polarity=con-->

- **Per-instance buckets don't share state**; N replicas allow up to N× the intended global rate.
- **A global limit needs an atomic shared store**, adding a dependency and per-call latency.
- **Large capacity lets bursts through** — a big burst can overwhelm a fragile downstream.
- **Choosing capacity and rate is real tuning**; wrong values throttle honest traffic or leak too much.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You must cap the average request rate** but want to tolerate short, natural bursts.
- **You're building an API limiter keyed per user**, per API key, per tenant, or per IP.
- **You want to shape offered load** to a downstream's real capacity.
- **A fixed-window counter is too coarse** or unfair at its window edges.

### Avoid when
<!--meta polarity=avoid-->

- **You need a strictly constant output rate** with no bursts: use the [leaky bucket](./leaky-bucket.md) in its queue form, or a [queue](./load-leveling.md), which delays arrivals instead of refusing them.
- **No contention on a single node** — one process, one caller and nothing downstream to protect: a local limiter adds tuning and no protection. A per-caller limit or a fragile downstream still justifies one.
- **The limit must be exact and global** but you cannot afford an atomic shared store — rethink the requirement.
- **You actually want to buffer excess work** rather than shed it.

Guards against the overload that turns one traffic spike into a system-wide brownout, where a struggling service degrades every caller behind it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a token bucket with lazy refill"
class TokenBucket {
  private tokens: number;
  private lastRefill = performance.now();

  constructor(
    private readonly capacity: number,     // burst size — the most you may spend at once
    private readonly refillPerSec: number, // steady-state rate
  ) { this.tokens = capacity; }            // start full

  /** Seconds to wait: 0 if the request is allowed now, more if it should be rate-limited. */
  tryConsume(cost = 1): number {
    // shared bucket: run these same steps inside one Redis EVAL script, and read the clock with TIME (the store's clock, not the client's)
    if (cost > this.capacity) return Infinity; // cost above capacity can never pass
    // lazy refill: no timer — compute accrued tokens from elapsed time
    const now = performance.now();
    const elapsedSec = Math.max(0, now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
    if (this.tokens < cost) return (cost - this.tokens) / this.refillPerSec; // bucket empty → shed the request
    this.tokens -= cost;
    return 0;
  }
}

// 10 requests/second sustained, bursts up to 20
const bucket = new TokenBucket(20, 10);
const wait = bucket.tryConsume();
if (wait > 0) throw new Error("429, retry after " + Math.ceil(wait) + "s");
```

## In the wild
<!--meta block=wild-->

- **Envoy** — Its local rate-limit filter is configured with a literal `token_bucket` block — `max_tokens` (capacity), `tokens_per_fill`, and `fill_interval` — spending a token per matching request. {#wild-envoy}
- **Go `golang.org/x/time/rate`** — The standard `rate.Limiter` is a token bucket: `NewLimiter(r, b)` sets the refill rate r and burst size b, exposed through `Allow`, `Wait`, and `Reserve`. {#wild-go-x-time-rate}
- **Guava `RateLimiter`** — Hands out permits at a fixed rate and lets unused permits accumulate up to a small burst (`SmoothBursty`) — token-bucket behaviour under the hood. {#wild-guava-ratelimiter}
- **AWS API Gateway** — Request throttling uses the token bucket algorithm, with a steady-state `rateLimit` (refill) and a `burstLimit` (bucket capacity) per stage or route. {#wild-aws-api-gateway}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Bucket capacity (burst size)** — The maximum number of tokens, and so the largest instantaneous burst you permit (max_tokens, burstLimit, the burst `b`).
- **Refill rate** — Tokens added per unit time; this is the enforced steady-state average rate (tokens_per_fill / fill_interval, rateLimit, the rate `r`).
- **Token cost per request** — Whether every request costs one token or expensive ones cost more, weighting the limit by real work rather than raw count.
- **Bucket key granularity** — Whether buckets are keyed per IP, per API key, per tenant, or global — this sets how many buckets exist and what each one caps.
- **On-empty behaviour** — Reject immediately (shed load, e.g. HTTP 429) or block and wait for a token (throttle) when the bucket is empty.

### Signals to watch
<!--meta polarity=signal-->

- **Throttle / rejection rate** — The fraction of requests denied for lack of a token (e.g. the 429 count) — a limit that is biting hard.
- **Available tokens / fill level** — How full buckets are; buckets that sit persistently empty mean the configured rate is below offered load.
- **Offered rate vs. configured rate** — Incoming request rate measured against the refill rate, to see how close callers run to the cap.
- **Token-store latency and errors** — For a shared bucket, the added latency per check and the error rate of the atomic store.

### Failure modes under load
<!--meta polarity=failure-->

- **Per-instance divergence** — Replicas each holding a local bucket collectively admit up to N× the intended global rate.
- **Shared-store hot key** — A single key backing a global bucket becomes a contention and latency hotspot at high request volume. Split one global bucket into k sub-buckets that each take 1/k of the rate and are picked at random, or have each node lease tokens in batches from the shared bucket. The limit becomes approximate.
- **Oversized burst** — A capacity set too high lets a burst through that overwhelms a fragile downstream even though the average is within budget.
- **Clock skew on lazy refill** — A coarse or non-monotonic clock distorts the elapsed-time calculation, leaking too many or too few tokens. Clamp elapsed at 0, read a monotonic clock locally, and in a shared store use the store's own clock (Redis `TIME`), not each client's.
- **Shared store down or slow** — Callers must fail open (no limit, downstream exposed) or fail closed (every caller refused). Pick one per route, and fall back to a local bucket with a short timeout on the store call.

### Readiness checklist
<!--meta polarity=check-->

- Decide global vs. per-instance; if global, hold bucket state in an atomic shared store (e.g. a Redis check-and-decrement script).
- Set capacity and refill rate from the downstream's measured capacity, not from a guess. Refill is the downstream's sustained safe rate minus headroom. Capacity is the most it absorbs in one burst, or refill times the longest burst you tolerate.
- Return 429 with a Retry-After (or equivalent) so clients back off instead of retrying instantly. Wait = (cost − tokens) / refill rate, rounded up. A cost above capacity can never pass.
- Emit throttle-rate and rejection metrics with alerts on sustained shedding.
- Choose the bucket key deliberately and bound the number of buckets so memory stays finite.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Handling Spikes](../../../themes/spike-handling.md) — Cap the average rate while letting a short burst through. {#fluency-spike-handling}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Hedged Request](./hedged-request.md) — A hedge budget is a token bucket applied to the extra copies.

**Alternative to**

- [Sliding Window](../coordination/sliding-window.md) — A token bucket buys the same smoothness by refilling credit instead of remembering arrivals
- [Leaky Bucket](./leaky-bucket.md) — The leaky bucket is the strict twin that smooths output completely, at the cost of queueing delay.

**Variant of**

- [Rate Limiter](./rate-limiter.md) — Token Bucket is the classic rate-limiting algorithm — it permits bursts up to the bucket size, then paces to the refill rate.

**Prevents**

- [Unbounded Queue](../../../hazards/unbounded-queue.md) — Rate-limit intake so the backlog can't outrun the consumer indefinitely
- [Noisy Neighbour](../../../hazards/noisy-neighbour.md) — A per-key bucket caps what one tenant can take, so a burst spends that tenant's own tokens.

**Demonstrated by**

- [Distributed Rate Limiter](../../../designs/distributed-rate-limiter.md) — the whole limiter is a working token bucket sharded across Redis, capping sustained load by refill rate and bursts by bucket depth
- [Rate Limiter](../../../designs/design-rate-limiter.md) — Rate Limiter implements Token Bucket end to end, including on-demand refill and retry-time math
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — A local bucket keeps a vendor's quota respected even when the shared counter is gone

**Implemented by**

- [Networking](../../../capabilities/networking.md) — Application programming interface (API) Gateway throttling and Envoy's local rate-limit filter expose the bucket directly, so rate and burst are the two knobs you actually set.

<!-- relationships:end -->
