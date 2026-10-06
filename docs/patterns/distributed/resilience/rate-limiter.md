---
title: Rate Limiter
description: Caps how many requests a client can make in a window
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, backpressure, resource-management]
status: stable
aliases: [throttling, throttle]
solves: [one client is making thousands of calls a second and starving everyone else, a buggy script stuck in a loop took down our api overnight, we burned through our paid quota on a third-party api in two days, i need free users capped at a hundred calls an hour but cannot enforce it across servers, scrapers keep pounding my endpoints and driving database load through the roof]
favourite: true
---

# Rate Limiter

Caps how many requests a client can make in a fixed window, rejecting or delaying the rest so no single caller can overrun shared capacity.

## What it is
<!--meta block=description-->

One caller's script stuck in a loop can send a thousand requests a second, and the shared database serves all of them while every other customer sees a slow site. A rate limiter keeps a counter per caller and refuses requests over an allowance per time window, usually with HTTP 429. The excess is dropped, not queued, so one runaway client pays for its own load.

## Explained
<!--meta block=explain-->

A rate limiter counts the requests each caller sends and refuses those over an allowance per time window, so one runaway client cannot use up capacity everyone shares. It keeps a counter per key, such as an API key or a user, and answers a refused call at once with HTTP 429 (too many requests) and a retry-after header. Put it where traffic meets, such as the gateway. Choose it over a queue when overload should be refused, not held, because a limiter drops the excess and a queue stores it. Backpressure instead asks the caller to slow down and refuses nothing. Choose it over a [bulkhead](bulkhead.md) when the danger is the request rate, not calls stuck in progress.

- **Real bursts refused.** Set the burst allowance from real traffic, not the steady rate.
- **Per-copy counters.** Each copy multiplies the limit, so share one counter store and decide whether it fails open or closed.
- **Shared keys.** One office address blocks all its users together, so limit on an identity the caller cannot rotate.

**Example.** A database handles 1,000 requests a second. Twenty customers normally send 20 a second each, 400 in all. Then one customer's script loops and sends 1,000 a second instead of 20, so the database sees 380 plus 1,000, which is 1,380, and every customer slows down. With a limit of 100 a second per API key, the looping client gets 100 through and 900 refused with 429, and the database sees 480. The cost shows up with three gateway copies that each count alone: the real limit is 300 a second. A shared counter fixes that, but it adds one lookup to every request.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one runaway caller stop spending everybody else's capacity? The gateway counts per key and refuses the excess before it ever reaches the shared database."
flowchart LR
    Client["Caller"]:::ext
    subgraph GW["Gateway — where the traffic converges"]
        Lim["Limiter: allowance per key"]
    end
    Counters[("Counter store, one key per caller")]
    Svc["Your service"]
    DB[("Shared database")]
    Client -->|"1 request, carrying its key"| Lim
    Lim -->|"2 spend the key's allowance"| Counters
    Lim -->|"3 inside the allowance, forward"| Svc
    Lim -->|"4 over it, 429 + Retry-After"| Client
    Svc -->|"5 bounded load"| DB
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="A token bucket in action. Each request spends one token if one is available; refills happen continuously on their own schedule, independent of request arrival."
flowchart LR
    Req["Request arrives"] -->|"check quota"| Bucket{"Token available?"}
    Bucket -->|"yes"| Allow["Consume token, forward request"]
    Bucket -->|"no"| Deny["Reject, 429 plus Retry-After"]
    Refill["Refiller"] -->|"add tokens on schedule"| Bucket
```

## Variations
<!--meta block=variations-->

- **[Token Bucket](./token-bucket.md)** — Tokens accumulate at a fixed rate up to a cap; each request spends one, so bursts up to the bucket size are allowed as long as tokens remain.
- **Leaky Bucket** — Requests queue and drain at a constant rate instead of bursting through — it smooths traffic into a steady outflow rather than admitting spikes.
- **Fixed window counter** — Count requests per key inside a whole-second or whole-minute window. Simple, but a burst straddling the window boundary can momentarily double the intended rate.
- **[Sliding window](../coordination/sliding-window.md) (log or counter)** — Weight the current and previous window by elapsed time, or keep a rolling log of timestamps, to smooth out the boundary problem at some extra memory cost.
- **Distributed rate limiting** — Back the counter with a shared store — Redis, Memcached — so the limit holds across a fleet of instances instead of resetting per process.
- **Client-side limiting** — Hold the counter in the caller and meter your own outgoing requests to fit under a ceiling someone else enforces — a paid API's quota, a scrape target's tolerance. The algorithms are identical; what changes is that the overflow waits instead of being refused, because the work still has to go through eventually.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Protects shared capacity** from being monopolized by one noisy or abusive client.
- **Keeps load on downstream systems and databases** predictable and bounded.
- **Cheap to implement and reason about** — a counter, a clock, and a key.
- **Gives callers an explicit, machine-readable signal** to back off instead of silent failure.

### Cons
<!--meta polarity=con-->

- **Legitimate bursts get rejected** right alongside abusive ones unless the burst allowance is sized from real traffic rather than the steady rate.
- **Per-instance counters multiply the real limit** by the replica count, so fleet-wide enforcement needs a shared counter store — which then sits on every request path and needs its own fail-open or fail-closed decision.
- **Choosing window size and rate** is a tuning exercise, not a fixed answer.
- **A hard cap turns a rare spike** into visible errors rather than degraded-but-working service — buffer the work that can wait behind [load leveling](./load-leveling.md) and keep the cap for the work that cannot.
- **A key that many users share** — one office NAT (network address translation), one partner's gateway — sheds all of them together when it trips, so limit on an identity the caller cannot rotate and cannot pool, and give known aggregators their own allowance.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A shared resource** — an API, a database, a downstream service — must survive noisy or abusive clients.
- **You need to enforce a fair-use policy** or a paid-tier quota.
- **Predictable load matters more than accepting every request** that arrives.

### Avoid when
<!--meta polarity=avoid-->

- **You need to absorb bursts** rather than reject them — a [queue](./load-leveling.md) buffers, a limiter sheds.
- **The bottleneck is concurrent work in flight**, not request rate — isolate it with a [Bulkhead](./bulkhead.md) instead.
- **The caller can be told to slow down** cooperatively — that's [Backpressure](../../concurrency/backpressure.md), not a hard cap.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a token bucket per tenant, and a tighter one per flow"
class TokenBucket {
  private last = Date.now();
  private tokens: number;
  constructor(private capacity: number, private refillPerSec: number) { this.tokens = capacity; }

  tryConsume(cost = 1): boolean {
    const now = Date.now();                       // refill lazily, on each call
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) / 1000 * this.refillPerSec);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

// One bucket per key, so one tenant's onboarding burst cannot drain the
// vendor quota every other tenant is queued behind.
const buckets = new Map<string, TokenBucket>();
function limiterFor(key: string, capacity: number, refillPerSec: number): TokenBucket {
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = new TokenBucket(capacity, refillPerSec)));
  return b;
}

// API edge: a tenant submitting personas for verification. Burst 100, refill 10/s.
if (!limiterFor(`client:${clientId}`, 100, 10).tryConsume()) throw new Error("429 Too Many Requests");

// The resend endpoint is bounded far tighter — a handful of links per flow per hour.
if (!limiterFor(`resend:${flowId}`, 3, 3 / 3600).tryConsume()) throw new Error("429 Too Many Requests");
```

## In the wild
<!--meta block=wild-->

- **NGINX** — The limit_req module applies a leaky bucket per key defined by limit_req_zone (commonly client IP): the burst parameter sets how many excess requests may queue, nodelay serves them immediately up to that burst, and limit_req_status sets the rejection code (503 by default). {#wild-nginx}
- **Envoy** — A local token-bucket filter enforces per-route limits in-process, while the global rate-limit service — a gRPC endpoint (the reference implementation is backed by Redis) — evaluates request descriptors so a limit holds across the fleet at the edge or between services. {#wild-envoy}
- **Stripe API** — Caps requests per second per account and answers over-rate callers with HTTP 429 Too Many Requests, documenting exponential backoff as the client's expected response. {#wild-stripe-api}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Rate and window** — The requests per unit of time each key is allowed — the ceiling itself.
- **Burst capacity** — How much unused allowance a caller may spend at once (token-bucket capacity, NGINX burst). Size it from real traffic, not from the sustained rate.
- **Key dimension** — What the count is attributed to — API key, authenticated user, IP, route, or a pair of them. IP alone is shared behind NAT and cheap to rotate.
- **Algorithm** — Token bucket to admit bursts, leaky bucket to smooth them away, sliding window to close the fixed-window boundary gap.
- **Reject behaviour** — What an over-rate caller gets: a status code, a Retry-After header, or a delay instead of a refusal.
- **Counter placement** — In-process counters, or a shared store every replica reads. The first is free and enforces per replica; the second enforces fleet-wide and joins the request path.

### Signals to watch
<!--meta polarity=signal-->

- **Throttle rate per key and route** — The share of requests refused. One key dominating means an abusive caller; every key throttling means the cap is too low.
- **Utilization against the limit** — How close each key runs to its ceiling — the headroom that tells you whether a tier is priced right before anyone complains.
- **Counter-store latency and availability** — With a shared store the limiter inherits its p99 and its uptime on every request.
- **Return traffic after a rejection** — How much refused traffic comes straight back. A client ignoring Retry-After turns a cap into a busier loop, not a quieter one.
- **Key cardinality** — How many distinct keys hold counters. A sudden jump is key rotation or a fan-out designed to slip under a per-key cap.

### Failure modes under load
<!--meta polarity=failure-->

- **Fixed-window boundary burst** — A burst straddling the window edge admits up to twice the intended rate in a short span, which is exactly when it hurts.
- **Per-instance undercount** — Without a shared store each replica counts alone, so the fleet-wide limit is the configured one multiplied by the replica count.
- **Counter store unreachable** — The limiter has to choose in the moment between admitting everything and refusing everything, and whichever it does was decided by whoever wrote the default.
- **Clock skew across instances** — Windows keyed to wall-clock time drift apart on hosts with unsynchronized clocks, so resets land at different moments and the effective rate wobbles.
- **Rejection is not free** — At flood scale, identifying the caller and answering the 429 is itself work. A limiter alone does not survive a volumetric attack; the cheap refusals have to happen further out, at the connection or the edge.

### Readiness checklist
<!--meta polarity=check-->

- A caller cannot buy a fresh allowance by rotating IPs, sessions or keys — the dimension counted against is one they cannot cheaply change
- What a throttled caller sees was agreed with whoever owns the API contract: the status, the headers, and whether a client is expected to retry
- The behaviour when the counter store is unreachable was chosen deliberately and exercised with the store switched off
- A load test drove a burst across the window boundary and the admitted rate matched the intended one
- Throttle counts are exported per key and per route, so one abusive caller is distinguishable from a cap set too low for everybody
- Callers that must never be throttled — health checks, the control plane, payment callbacks — run on an exempt path or their own allowance

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [System Design Interview](../../../themes/system-design-interview.md) — Protect the system from overload by refusing what exceeds a rate it can actually serve. {#fluency-system-design-interview}
- [Handling Spikes](../../../themes/spike-handling.md) — Shed load above a safe rate, so the traffic that is admitted still gets served properly. {#fluency-spike-handling}
- [API Design](../../../themes/api-design.md) — Cap what any one caller can consume so the boundary stays fair {#fluency-api-design}

<!-- fluency:end -->

## Check yourself
<!--meta block=selfcheck-->

> **Why does a per-instance counter let more traffic through than the limit?**
>
> Each replica counts alone, so the real limit multiplies by the replica count, see [con 2](rate-limiter.md#tradeoffs-con-2).

> **Why size the burst allowance from real traffic and not the steady rate?**
>
> Otherwise legitimate bursts are rejected along with abusive ones, see [con 1](rate-limiter.md#tradeoffs-con-1).

> **When do you want a bulkhead instead of a limiter?**
>
> When the bottleneck is concurrent work in flight rather than request rate, see [avoid 2](rate-limiter.md#usage-avoid-2).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [API Gateway](../routing/api-gateway.md) — The gateway is where limits are usually enforced
- [Pagination](../routing/pagination.md) — Without a page cap a caller stays inside its request budget and still asks for the whole table
- [Partition Around Limits](../../../principles/partition-around-limits.md) — Rate limiting is how a shared ceiling gets divided on purpose
- [Priority Queue](../../messaging/priority-queue.md) — Prefer high-value callers when deciding whose requests to turn away
- [Sliding Window](../coordination/sliding-window.md) — A sliding window closes the fixed-window boundary gap, at the cost of extra state per caller
- [Leaky Bucket](./leaky-bucket.md) — A limiter can use a leaky bucket when the target cannot take any burst.
- [Multi-Tenancy](../routing/multi-tenancy.md) — Keyed by tenant id, it is the pool model's fairness control.

**Alternative to**

- [Queue-Based Load Leveling](./load-leveling.md) — Shed excess vs. buffer it
- [Load Shedding](./load-shedding.md) — A per-client quota answers fairness; shedding answers whether this instance can cope at all

**Has variant**

- [Token Bucket](./token-bucket.md) — Token- and leaky-bucket are the classic algorithms

**Often confused with**

- [Bulkhead](./bulkhead.md) — Isolate resources vs. cap request rate
- [Backpressure](../../concurrency/backpressure.md) — Reject over-rate vs. ask upstream to slow

**Prevents**

- [Noisy Neighbour](../../../hazards/noisy-neighbour.md) — Unmetered tenants take pool capacity from their neighbours
- [Retry Storm](../../../hazards/retry-storm.md) — Caps what a runaway retry loop can offer a shared resource
- [Thundering Herd](../../../hazards/thundering-herd.md) — Sheds a synchronized wave the resource is not sized for
- [Cascading Failure](../../../hazards/cascading-failure.md) — A cap protects the survivors while capacity is short

**Demonstrated by**

- [Distributed Rate Limiter](../../../designs/distributed-rate-limiter.md) — shows the pattern's mechanics realised across a gateway fleet: identify client, check quota, reject overflow with headers
- [Web Crawler](../../../designs/web-crawler.md) — per-domain request rate is bounded to keep the crawler a polite guest on every site
- [ChatGPT](../../../designs/chatgpt.md) — admission control keyed to a per-user budget is a rate limiter deliberately measuring the resource that actually costs money
- [CamelCamelCamel](../../../designs/camelcamelcamel.md) — respecting the ~1 req/sec/IP ceiling on outbound crawling is the rate limit that shapes the entire system
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — capping a client's request rate on a persona-verification application programming interface (API) so one client cannot exhaust a shared vendor quota
- [Bitly](../../../designs/bitly.md) — A URL shortener limits on the miss path, because a scan of the code space looks exactly like a flood of misses
- [Gopuff](../../../designs/gopuff.md) — a delivery surge is paid in availability queries first, because browsing is sheddable and ordering is not
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — a limiter that stops calls which would succeed, drawn beside the breaker that stops calls which would fail
- [Rate Limiter](../../../designs/design-rate-limiter.md) — A low-level design of the limiter itself, split into a contract and swappable per-endpoint algorithms
- [Facebook Post Search](../../../designs/fb-post-search.md) — Rate limiting applied at the edge of a read-heavy path

**Implemented by**

- [Networking](../../../capabilities/networking.md) — Enforceable at the managed gateway rather than in the service.
- [Load balancers, proxies & gateways](../../../comparisons/load-balancers-and-gateways.md) — The edge products that enforce this pattern before traffic reaches your services.

<!-- relationships:end -->
