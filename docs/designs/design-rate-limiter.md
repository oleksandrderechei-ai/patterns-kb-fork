---
title: Rate Limiter
description: "Resolve an endpoint's policy, delegate to a swappable limiting algorithm behind one interface, and answer each request allow-or-deny with a retry hint"
area: designs-foundational
owner: Oleksandr Derechei
tags: [low-level-design, extensibility, polymorphism, state-management]
status: stable
aliases: [throttler]
solves: ["one client hammers my API and starves everyone else, so I must cap each caller per second", different endpoints need different throttling rules and I do not want a giant if/else deciding which one runs, adding a new throttling algorithm means editing my orchestrator and every call site instead of dropping in one class, my in-memory quota tracker keeps growing because I never drop clients that stopped calling, two concurrent requests both read the same remaining quota and both slip past the limit]
---

# Rate Limiter

A rate limiter caps how many requests a client may make to an endpoint inside a time window: it checks the caller's quota, lets the request through if there is room, and turns it away with a retry hint if not. As a low-level design the distributed plumbing is out of scope — the whole exercise is object modelling: one interface for interchangeable algorithms, a factory that builds them from heterogeneous config, and per-client state kept isolated behind each limiter.

## Understanding the problem
<!--meta block=description-->

A rate limiter for an API gateway takes a clientId and an endpoint, checks the client's quota under that endpoint's policy, and answers allowed or denied with the quota left and a retry delay. Each endpoint may run a different algorithm, loaded from configuration at startup. The limiter is single-process and in-memory, so the page is object modelling: name the classes, isolate each client's state, and make new algorithms cheap to add.

## Explained
<!--meta block=explain-->

A single-process rate limiter looks up the policy for the endpoint being called, hands the request to a limiting algorithm behind one small interface, and answers allowed or denied, with the quota left and, on denial, how long to wait. The algorithm is a swappable strategy ([Strategy](../patterns/gof/behavioral/strategy.md)), such as a [token bucket](../patterns/distributed/resilience/token-bucket.md), so each endpoint can use a different one. Choose it while one process owns all the counters. Once two servers must share a limit, the counters move to a shared store and a lock inside one process no longer works.

- **Racing threads.** Check and update are two steps, so two threads can both see one token and pass. Lock each caller's own counter.
- **Unbounded memory.** A counter is kept for every id that ever called. Cap the map or drop idle ids before real traffic arrives.
- **Reload resets.** Rebuilding limiters on a config reload gives an abuser a clean slate. Change settings in place and trim counters.

**Example.** The /search endpoint is configured with capacity 1000 and a refill of 10 tokens a second. A new client starts with a full bucket, so it can burst 1,000 requests. Later its bucket holds 0.3 tokens and it calls again: it needs 0.7 more, and 0.7 x 1000 / 10 is 70, so the answer is denied, retry after 70 ms. If two threads of that client both read 1 token with no lock, both pass; with the bucket's own lock the second sees 0 and is denied.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Load per-endpoint configuration once at startup; each entry names an algorithm and carries that algorithm's own parameter shape.
2. On each request `(clientId, endpoint)`, check the client against that endpoint's policy and enforce the limit.
3. Return a structured result: `allowed` (bool), `remaining` (int, quota left after this request), `retryAfterMs` (long, or null when allowed).
4. An endpoint with no configuration falls back to a default policy — never reject a request merely because config is missing.
5. Support several algorithms (Token Bucket, Sliding Window Log, and more) chosen per endpoint.

Out of scope: distributed limiting across servers (Redis, coordination), dynamic config reload at first, metrics and monitoring, and validation beyond basic checks.

### Non-functional (constraints)
<!--meta requirement=nfr-->

- **Extensibility** — a new algorithm should drop in without touching the orchestrator or existing limiters.
- **Isolation** — each client's state is independent; one caller can never spend another's quota.
- **Honest retry** — a denied caller learns exactly how many milliseconds to wait, never too early.
- **Evolvability** — thread safety, live config changes, and bounded memory should slot in later without a rewrite.

## Core entities
<!--meta block=entities-->

Four classes, and three nouns that deliberately stay out of the model:

- **RateLimiter** — the orchestrator and the only public surface. Holds a map of endpoint&nbsp;→&nbsp;limiter plus a shared `defaultLimiter`, resolves the right limiter for a request, and delegates to it.
- **Limiter** — the interface every algorithm implements, a single method `allow(key) → RateLimitResult`. It is an interface, not an abstract base class, because the algorithms share no per-key state to hoist (see the deep dives).
- **RateLimitResult** — an immutable [value object](../patterns/ddd/value-object.md) carrying `allowed`, `remaining`, and `retryAfterMs`. Set once, read-only after — [immutability](../patterns/functional/immutability.md) keeps the answer from being mutated in flight.
- **LimiterFactory** — turns one raw config entry into the correct `Limiter` subtype, reading the `algorithm` field as a discriminator and pulling out that algorithm's parameters.
- **Request, Client, Endpoint — not classes.** A request is just the two method arguments; a client is a lookup key for per-client state; an endpoint is a string used as a map key. None owns a lifecycle the system must manage, so modelling any of them as a class would be state with no owner.

## The interface
<!--meta block=interface-->

Config flows in as raw, heterogeneous data; a single public method flows out an answer. There is deliberately no `getConfig()` or `updateConfig()` up front — nothing in the requirements queries or mutates config, so adding those methods would be speculative surface, exactly the [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) trap. They earn their place only when a live-reload requirement appears.

```json summary="The config it loads (one entry per endpoint)"
{
  "endpoint": "/search",
  "algorithm": "TokenBucket",
  "algoConfig": { "capacity": 1000, "refillRatePerSecond": 10 }
}
// algoConfig is always present, but its inner fields vary by algorithm:
// SlidingWindowLog carries { "maxRequests": 100, "windowMs": 60000 }
```

```python summary="The public API"
class RateLimiter:
    def allow(self, client_id: str, endpoint: str) -> RateLimitResult:
        limiter = self._limiters.get(endpoint, self._default_limiter)
        return limiter.allow(client_id)   # clientId is the per-client key
```

## How the system is built
<!--meta block=architecture-->

At startup the `RateLimiter` walks the config list, asks the factory to build one limiter per endpoint, and stores them in a map keyed by endpoint — plus one limiter built from the default config. Every limiter is created eagerly; there are only dozens to hundreds of endpoints, so lazy, first-request construction would add locking for no measurable gain. On each call, `allow` looks up the endpoint's limiter, falls back to the default on a miss, and delegates with `clientId` as the key. The important structural fact is that each limiter owns its own per-key state map — Token Bucket keeps a bucket per client, Sliding Window Log keeps a timestamp queue per client — so the orchestrator never touches algorithm state.

~~~mermaid caption="The orchestrator resolves an endpoint to a limiter; the factory hides construction; each algorithm keeps its own per-client state behind the shared `Limiter` interface."
classDiagram
    class RateLimiter {
        -Map~String,Limiter~ limiters
        -Limiter defaultLimiter
        +allow(clientId, endpoint) RateLimitResult
    }
    class Limiter {
        <<interface>>
        +allow(key) RateLimitResult
    }
    class LimiterFactory {
        +create(config) Limiter
    }
    class RateLimitResult {
        -bool allowed
        -int remaining
        -long retryAfterMs
    }
    class TokenBucketLimiter {
        -int capacity
        -int refillRatePerSecond
        -Map~String,TokenBucket~ buckets
        +allow(key) RateLimitResult
    }
    class SlidingWindowLogLimiter {
        -int maxRequests
        -long windowMs
        -Map~String,RequestLog~ logs
        +allow(key) RateLimitResult
    }
    class TokenBucket {
        -double tokens
        -long lastRefillTime
    }
    class RequestLog {
        -Queue~long~ timestamps
    }
    RateLimiter o-- "*" Limiter : owns per endpoint
    RateLimiter ..> LimiterFactory : builds via
    LimiterFactory ..> Limiter : creates
    Limiter <|.. TokenBucketLimiter : implements
    Limiter <|.. SlidingWindowLogLimiter : implements
    TokenBucketLimiter o-- "*" TokenBucket : per-client state
    SlidingWindowLogLimiter o-- "*" RequestLog : per-client state
~~~

## Deep dives
<!--meta block=deepdives-->

### 1 · Why Limiter is an interface, not an abstract base class

An abstract base class only pays off when subclasses share fields or behaviour worth hoisting. Here they share nothing: Token Bucket's per-key state is `(tokens, lastRefillTime)`, Sliding Window Log's is a `Queue` of timestamps, Fixed Window Counter's is `(count, windowStart)`. A common base would carry zero shared members — "an interface with extra steps." A single-method interface is the honest contract, and keeping it to exactly one method is [interface segregation](../principles/interface-segregation.md) in the small: no implementation is forced to carry a method it does not use. Because the algorithms are interchangeable behind that contract, the design is the [Strategy](../patterns/gof/behavioral/strategy.md) pattern — the orchestrator holds a `Limiter` and never learns which algorithm answered.

### 2 · Building the right limiter from heterogeneous config

Config entries all share a shape but differ in their `algoConfig` payload, and the runtime `algorithm` string decides which class to instantiate — the textbook trigger for a factory. `LimiterFactory.create` switches on the discriminator, extracts that algorithm's parameters, and constructs the matching limiter; an unknown algorithm fails fast with an exception rather than silently defaulting. This is a [factory](../patterns/gof/creational/factory-method.md) concentrating all creation knowledge in one place, and it is what makes the system [open for extension, closed for modification](../principles/open-closed.md): adding Fixed Window Counter means writing one new `Limiter` class and adding one `case` — the orchestrator and every existing limiter stay untouched. If algorithms ever need to be registered at runtime rather than compiled in, the switch graduates to a registry (a map of name&nbsp;→&nbsp;constructor); for two algorithms in scope, the switch is clearer.

A config entry becomes a limiter in one place, and an unknown algorithm stops there.

```mermaid caption="How does one config entry become the right Limiter, and what happens to an unknown algorithm?"
flowchart TB
    Cfg["Config entry: algorithm + algoConfig"] -->|"create(entry)"| F["LimiterFactory"]
    F -->|"switch on algorithm"| Sw{"which algorithm?"}
    Sw -->|"token bucket"| TB["Token Bucket limiter"]
    Sw -->|"sliding window log"| SW["Sliding Window Log limiter"]
    Sw -->|"fixed window counter"| FW["Fixed Window Counter limiter"]
    Sw -->|"unknown"| Err["throw exception, no silent default"]
```

### 3 · Lazy refill and the retry-time math (Token Bucket)

[Token Bucket](../patterns/distributed/resilience/token-bucket.md) is the workhorse: each client holds a bucket that refills at a steady rate and drains one token per request, permitting bursts up to `capacity` while bounding the average rate. The subtlety is when refill happens. Rather than a background thread topping up every bucket on a timer — which would scan even idle clients — refill is computed on demand from elapsed time at request time. A first-time client's bucket starts full, so it gets an immediate burst. On denial the limiter reports exactly how long to wait: the tokens still needed, divided by the refill rate, rounded up so the client never retries a hair too early. This is the [lazy](../patterns/gof/extra/lazy-initialization.md) instinct applied to state, not objects — do the work only when a request forces it.

```python summary="TokenBucketLimiter.allow — refill, then decide"
def allow(self, key: str) -> RateLimitResult:
    bucket = self._get_or_create_bucket(key)        # new buckets start full
    now = now_ms()
    elapsed = now - bucket.last_refill_time
    bucket.tokens = min(self._capacity,
                        bucket.tokens + elapsed * self._rate / 1000)
    bucket.last_refill_time = now

    if bucket.tokens >= 1:
        bucket.tokens -= 1
        return RateLimitResult(True, floor(bucket.tokens), None)

    needed = 1 - bucket.tokens                       # e.g. 0.7 tokens short
    return RateLimitResult(False, 0, ceil(needed * 1000 / self._rate))
```

The refill happens only when a request arrives, and the same step decides allow or deny.

```mermaid caption="What happens inside one Token Bucket allow call, and how is the retry time computed on a denial?"
flowchart TB
    Req["allow(key)"] -->|"get or create bucket, new bucket starts full"| Fill["Refill from elapsed time, capped at capacity"]
    Fill -->|"update lastRefillTime"| Chk{"tokens >= 1?"}
    Chk -->|"yes"| Take["Drain one token"]
    Take -->|"allowed, remaining = floor(tokens)"| Ok["RateLimitResult allowed"]
    Chk -->|"no"| Wait["needed = 1 - tokens"]
    Wait -->|"retryAfterMs = ceil(needed / rate)"| No["RateLimitResult denied"]
```

### 4 · Concurrency: the check-then-act race

The base design is not thread-safe, and the gap is a classic [race condition](../hazards/race-condition.md): two threads for the same client both read `tokens = 1`, both pass the check, both decrement — two requests allowed against a capacity of one. The fix is per-key locking, not a global lock. Store buckets in a concurrent map, get-or-create the bucket atomically, and then synchronise on the bucket object itself for the read-modify-write. The bucket doubles as its own lock, so different clients never block each other — only same-client requests serialise. Guarding a shared object's whole check-and-update behind the object's own lock is the [Monitor Object](../patterns/concurrency/monitor-object.md) pattern; the result object is constructed after the lock is released.

```python summary="Making allow thread-safe with a per-bucket lock"
def allow(self, key: str) -> RateLimitResult:
    bucket = self._buckets.compute_if_absent(     # atomic get-or-create
        key, lambda: TokenBucket(self._capacity, now_ms()))

    with bucket.lock:                             # only same-client calls block
        # ... refill, check, decrement, compute result values ...
        allowed, remaining, retry = self._evaluate(bucket)

    return RateLimitResult(allowed, remaining, retry)   # built outside the lock
```

### 5 · Bounded memory and live config changes

Every unique `clientId` that ever calls leaves a bucket or log behind, and the maps grow forever — a latent [resource leak](../hazards/resource-leak.md) that becomes an out-of-memory risk at millions of clients. Eviction closes it: track last-access per key and let a background sweep drop entries idle past a threshold, cap the map with an LRU (least recently used), or (in a distributed variant) let Redis key TTLs (times to live) do it. An evicted client's next request simply looks like a first-timer — acceptable, since it had gone quiet. The other evolution is live config: the blunt option rebuilds every limiter and atomically swaps the map, which is simple but resets all per-key state — fine when raising limits, dangerous when lowering them to stop an abuser who then gets a clean slate. The careful option adds `updateConfig` to the interface so each limiter mutates its own parameters in place and clamps existing state to the new capacity, preserving continuity; switching an endpoint's algorithm outright still requires a full replacement, since the two states are incompatible.

```mermaid caption="Why do two requests for the same client over-admit — and why does locking the bucket, not the whole limiter, fix it? Different clients never contend; only same-key calls serialise."
sequenceDiagram
    autonumber
    participant A as Thread A (key alice)
    participant B as Thread B (key alice)
    participant K as Bucket (its own lock)
    alt no lock — check-then-act race
        A->>K: read tokens (= 1)
        B->>K: read tokens (= 1)
        A->>K: check ok, decrement to 0
        B->>K: check ok, decrement to -1
        Note over A,B: two allowed against a capacity of one
    else per-bucket lock (chosen)
        A->>K: acquire lock, spend to 0, release
        B->>K: acquire lock, bucket empty
        B-->>B: denied, retry-after returned
    end
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- A new algorithm is one class plus one factory case; the orchestrator and existing limiters never change.
- Each limiter owns its own per-key state, so clients are fully isolated and the algorithms share no accidental coupling.
- On-demand, elapsed-time refill needs no [sweeper](../patterns/distributed/coordination/sweeper.md) thread and does no work for idle clients.
- An immutable result carries allow/deny plus an exact retry hint, so every caller gets a self-describing answer.

### What it gives up
<!--meta polarity=con-->

- The factory switch grows one arm per algorithm — creation is centralised, but it is still a single edit point that expands.
- Per-key state maps grow unbounded until an eviction policy is bolted on.
- The base design is not thread-safe; correctness under load requires explicit per-key locking.
- Config loads once — changing limits without a restart means reload-and-swap or in-place updates, each with its own state cost.

## What's expected at each level
<!--meta block=levels-->

- **Junior** — with the algorithm explained, a working system: an orchestrator, a `Limiter` interface, a value result, and a factory that reads config and builds the right limiter. Tracks per-client state, decides allow/deny by the algorithm's rules, and rejects an unknown algorithm. May need hints on where each responsibility sits.
- **Mid-level** — draws the boundaries unprompted: orchestrator delegates, factory creates, each limiter owns its state, the result is a plain value object. Sees config as raw heterogeneous data flowing through the factory rather than typed config classes, handles unknown endpoints and over-limit clients with correct retry math, and can discuss at least one extension.
- **Senior** — class boundaries are obvious without deliberation; volunteers the trade-offs (the switch grows with algorithms, lazy refill versus a scheduler, per-key locking versus its bookkeeping) and catches edge cases like a client idle for days blowing up the refill math or timestamp overflow. Sequences extensions simple-first, names when a registry or a state-preserving update earns its keep, and may reach distributed limiting or memory-at-scale unprompted.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Strategy](../patterns/gof/behavioral/strategy.md) — interchangeable limiting algorithms sit behind one Limiter interface the orchestrator holds without knowing which is running
- [Token Bucket](../patterns/distributed/resilience/token-bucket.md) — the flagship algorithm — a per-client bucket that refills at a steady rate and permits bursts up to capacity
- [Open/Closed Principle](../principles/open-closed.md) — adding an algorithm is a new class plus one factory case; the orchestrator and existing limiters stay untouched
- [Interface Segregation Principle](../principles/interface-segregation.md) — Limiter is a single allow(key) method, so no algorithm carries state or behaviour it does not use
- [Value Object](../patterns/ddd/value-object.md) — RateLimitResult is an immutable record of allowed/remaining/retryAfterMs, set once and read-only
- [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) — no getConfig/updateConfig methods until a live-reload requirement actually appears
- [Monitor Object](../patterns/concurrency/monitor-object.md) — thread safety comes from synchronizing each client's check-and-update on the bucket object's own lock
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — The whole design is a rate limiter: one allow call per client and endpoint that returns allowed, remaining and retry-after
- [Sliding Window](../patterns/distributed/coordination/sliding-window.md) — Sliding Window Log is one of the per-endpoint algorithms, keeping a queue of timestamps per client
- [Immutability](../patterns/functional/immutability.md) — RateLimitResult is a read-only value, set once so the answer cannot change in flight
- [Factory Method](../patterns/gof/creational/factory-method.md) — LimiterFactory reads the algorithm discriminator from heterogeneous config and constructs the matching Limiter subtype

<!-- relationships:end -->
