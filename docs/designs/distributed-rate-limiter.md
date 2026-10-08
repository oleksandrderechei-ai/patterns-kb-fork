---
title: Distributed Rate Limiter
description: "Enforce per-client request quotas across a fleet of gateways from shared token-bucket state, in under 10 ms"
area: designs-foundational
owner: Oleksandr Derechei
tags: [resilience, availability, latency, throughput]
status: stable
aliases: [throttling, API throttle]
solves: [one abusive client keeps hammering my API and the backend falls over for everyone else, "I cap each user at 100 requests a minute, but my gateways each count separately so the limit leaks", two requests from one user race on the same counter and both pass when one slot was left, a viral post throws thousands of requests a second at one key and that one shard tips over, I need to reject excess traffic in under 10 ms without a database round trip on every request]
---

# Distributed Rate Limiter

A rate limiter is the traffic controller in front of an API: it counts how many requests each client has made in a window and rejects the rest with a 429. The whole problem is doing that count correctly and cheaply when the counting is spread across dozens of gateways serving a million requests a second.

## Understanding the problem
<!--meta block=description-->

A rate limiter for a social platform's public API admits, say, 100 requests per minute per user and answers the overflow with HTTP 429. Enforcement must be server-side, because a client cannot be trusted to throttle itself. The hard part is not the counting rule but keeping one honest count when many machines count and traffic is enormous. The page walks through requirements, sizing, the shared-state design and its failure modes.

## Explained
<!--meta block=explain-->

A distributed rate limiter keeps each client's allowance in a shared store, so the cap holds no matter which of many gateway servers receives the request. Each gateway hashes the client id to pick one shard ([sharding](../patterns/distributed/routing/sharding.md)), then runs a [token bucket](../patterns/distributed/resilience/token-bucket.md) check there: the bucket refills steadily, each request spends a token, and an empty bucket gets HTTP 429. The check must run as one indivisible script on the shard, because two gateways reading the same last token and both writing would let both requests through. Choose it over a count kept in each gateway's own memory when the cap must hold globally; a per-gateway count lets a client send its full allowance to each gateway.

- **Round trip.** The network hop, not the store, eats the 10 ms budget. Pool connections and keep shards in the caller's region.
- **Regional drift.** Counting separately per region can overshoot. Publish a cap with that drift priced in.
- **Lost shard.** Its clients go unchecked. Replicate each shard and reject while it fails over, since outages arrive with the surge the limit exists for.

**Example.** The service handles 1 million checks a second. Each check is a read and a write, so 2 million store operations a second; one Redis instance does 100,000 to 200,000, which is 50,000 to 100,000 checks, so you run about 10 shards. Alice has 1 token left and two gateways check her at once. The shard script runs them one after the other: the first spends the token, the second sees 0 and gets a 429. If Alice's shard dies, the clients on it are rejected for the 1 to 2 seconds a replica takes to be promoted.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Identify the client behind each request — by user ID, IP address, or API key — so the right limits apply.
2. Allow or deny each request against configurable rules (for example, 100 requests/minute/user), enforcing the most restrictive rule when several apply.
3. On rejection, return HTTP 429 with helpful headers: the ceiling, the count remaining, and when the window resets.

Out of scope: analytics or ad-hoc querying over rate-limit data, and long-term persistence of that data — it is disposable, per-window state.

### Non-functional
<!--meta requirement=nfr-->

- **Latency** — the check adds under 10&nbsp;ms to a request; it sits in the hot path of every call.
- **Availability** — high; [eventual consistency](../themes/consistency-and-replication.md) is acceptable, so a small cross-node drift in the count is fine.
- **Scale** — 1M requests/second across 100M daily actives.
- **Correctness under contention** — concurrent requests for the same client must not both slip through one remaining slot.

## Right-sizing
<!--meta block=sizing-->

**Throughput.** Every request is one check, so the limiter carries the full **1M req/s**. Done naïvely each check is two store operations — read the bucket, write it back — so budget **~2M store ops/second**. The chosen design folds the read and write into one Lua script (one EVAL per check), so the call rate is ~1M/s but each call does more work; size shards from measured EVAL throughput, not the 2-op figure. That single number drives the whole scaling story.

**Store capacity.** A Redis instance handles roughly 100k–200k ops/second on simple operations, which lands each instance at **~50k–100k checks/second** once you count both ops. To absorb 1M checks/second you therefore need **10 shards** at the best case and ~20 at 50k checks/s, plus headroom for hot shards, failover and peaks — the reason this design is distributed rather than a single box.

**Memory.** Each client's state is tiny: a token count and a last-refill timestamp, call it ~100 bytes with key overhead. Even 100M live clients is only **~10&nbsp;GB**, ~1&nbsp;GB per shard, and idle keys expire themselves. State is cheap; the ops rate is the constraint.

**Latency.** A Redis op is sub-millisecond, but a fresh TCP handshake is 20–50&nbsp;ms and a cross-region round trip is tens of ms — so most of the 10&nbsp;ms budget is spent on the network, not the store, which tells you where to optimise.

## Core entities
<!--meta block=entities-->

Three entities, and a single flow through them:

- **Rule** — a policy: how many requests per window, which clients it covers, which endpoints. Example: "authenticated users get 1000 requests/hour"; "the search endpoint allows 10/minute per IP."
- **Client** — the thing being limited: a user ID, an IP, an API key, or a combination. Each carries the rate-limiting state that tracks its usage against the rules.
- **Request** — an incoming call carrying the client's identity, the endpoint hit, and a timestamp; it is what gets evaluated.

The flow is always the same: a request arrives, the client is identified, the applicable rules are looked up, usage is checked, and the request is allowed or denied.

## The interface
<!--meta block=interface-->

The core is one predicate, plus the shape of the rejection it produces. The call takes a client identifier and a rule identifier and returns the verdict together with the numbers the caller needs to build response headers:

One rule per call is deliberate: composition lives in the gateway, not in the predicate. The gateway resolves every rule that matches the caller — a per-user quota, a per-IP ceiling, a per-endpoint burst cap — calls the check once per rule, and denies as soon as one denies, which is how the most-restrictive rule wins without the check ever needing to rank rules. The headers then report the tightest of the surviving budgets, so a client backs off to the limit that will actually stop it.

```http summary="The check, and the 429 it produces"
isRequestAllowed(clientId, ruleId)
  → { passes: boolean, remaining: number, resetTime: timestamp }

# on a deny, the gateway returns:
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1640995200
Retry-After: 60
Content-Type: application/json

{ "error": "Rate limit exceeded",
  "message": "Limit of 100 requests/minute reached. Try again in 60s." }
```

The `X-RateLimit-*` headers turn a blunt rejection into a contract: a well-behaved client reads `Retry-After` and backs off instead of hammering the door. The design chooses to [fail fast](../principles/fail-fast.md) rather than queue overflow — queuing an interactive request burns memory, makes latency unpredictable, and invites users to retry a call they think stalled, piling on more load. Queuing only earns its place in batch systems that can tolerate the wait.

## How the system is built
<!--meta block=architecture-->

The limiter lives at the [API gateway](../patterns/distributed/routing/api-gateway.md), not embedded in each service and not in a separate hop of its own. The gateway already terminates every request, so it can enforce limits with no extra network call, and it can see everything it needs to identify a caller inside the HTTP request itself — the `Authorization` JWT (JSON Web Token) for a user ID, `X-Forwarded-For` for an IP, `X-API-Key` for a developer key — without a database lookup that would blow the latency budget. Each gateway extracts the identifier, hashes it to pick a Redis shard, and runs a [token-bucket](../patterns/distributed/resilience/token-bucket.md) check against the shared state there. Redis is what makes the count global: keeping bucket state in a gateway's own memory would let Alice's 50 requests to gateway A and 50 to gateway B each look like 50, and the limit would quietly leak.

```mermaid caption="Every request is identified, routed to exactly one shard by a hash of the client id, and allowed or denied by an atomic token-bucket check on that shard."
flowchart TB
    Client["Client request"]:::ext -->|"HTTP + auth headers"| GW["API gateway · reads JWT / IP / API-key"]
    GW -->|"hash(id) picks shard, consume 1"| Redis[("Redis shard · token bucket in Lua")]
    Redis -->|"remaining tokens"| GW
    GW -->|"allow"| Backend["Backend service"]:::ext
    GW -->|"deny"| Reject["429 + X-RateLimit headers"]
    Redis -.->|"master to replica"| Rep[("Replica · auto-failover")]
    classDef ext stroke-dasharray:4 4;
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Choosing the counting algorithm

Four algorithms trade accuracy against memory. A **fixed-window counter** — one bucket per minute — is trivial but has an ugly boundary: 100 requests at 12:00:59 plus 100 at 12:01:00 is 200 in two seconds, double the intended rate. A **sliding-window log** stores every request's timestamp and is exact, but a 1000/min user needs 1000 stored timestamps, which does not survive millions of users. A **sliding-window counter** keeps just the current and previous window's counts and weights them by how far into the window you are — cheap and much smoother, at the cost of assuming traffic is evenly spread. The chosen one is the **token bucket**: each client holds a bucket of up to N tokens that refills at a steady rate; a request spends one token, an empty bucket is a reject. It captures both dimensions of real traffic — the refill rate caps the sustained load, the bucket depth allows a burst — while storing only two numbers per client. Stripe uses this shape for its API. Its state is exactly `(tokens, last_refill)`, and tokens are computed lazily from elapsed time rather than ticked by a timer.

### 2 · One honest count without a race

Sharing bucket state in Redis is the easy half. The trap is the read-modify-write. If a gateway does `HMGET` to read the count, computes the refill in application code, then writes it back, two simultaneous requests for the same client can both read the same starting count, both decide a token is free, and both write — over-admitting when only one slot existed. Wrapping the writes in `MULTI/EXEC` does not save you, because the read that the decision hinges on happened outside the transaction. That gap is a [race condition](../hazards/race-condition.md). The fix is to widen the atomic boundary to cover the whole sequence: push read, refill-calculation, and write into a single Redis **Lua script** that runs atomically on the shard. Redis's [shared, in-memory store](../patterns/caching/distributed-cache.md) is a good fit here precisely because its single-threaded execution makes such a script indivisible, its ops are sub-millisecond, and an `EXPIRE` on each key reclaims idle buckets for free.

```lua summary="The atomic token-bucket check, as one Lua script"
-- KEYS[1] = "alice:bucket"; ARGV = now, refill_rate, capacity, cost, ttl
local now, refill_rate, capacity, cost, ttl = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local s      = redis.call('HMGET', KEYS[1], 'tokens', 'last_refill')
local tokens = tonumber(s[1]) or capacity          -- cold start: full bucket
local last   = tonumber(s[2]) or now
tokens = math.min(capacity, tokens + (now - last) * refill_rate)
if tokens < cost then
  return {0, tokens}                                -- deny, state untouched
end
tokens = tokens - cost
redis.call('HSET', KEYS[1], 'tokens', tokens, 'last_refill', now)
redis.call('EXPIRE', KEYS[1], ttl)
return {1, tokens}                                  -- allow, tokens remaining
```

`now` comes from the calling gateway, so clock skew between gateways shifts the refill; keep gateway clocks synced or accept that skew.

```mermaid caption="Why does an application-side HMGET-then-HSET over-admit under two gateways, and how does one atomic Lua script close the window? The decision must live inside the same indivisible step as the write."
sequenceDiagram
    autonumber
    participant A as Gateway A
    participant B as Gateway B
    participant R as Redis shard (alice:bucket)
    alt read-modify-write in app code
        A->>R: HMGET tokens (= 1)
        B->>R: HMGET tokens (= 1)
        A->>R: HSET tokens = 0
        B->>R: HSET tokens = 0
        Note over R: both admitted — one slot over-sold
    else one Lua script per shard (chosen)
        A->>R: EVAL check-and-spend
        R-->>A: allow, 0 left
        B->>R: EVAL check-and-spend
        R-->>B: deny, 0 left
    end
```

### 3 · Scaling writes to a million a second

One Redis instance tops out near 50k–100k checks/second, an order of magnitude short of the target, so the store has to be sharded. The one non-negotiable is that a given client always lands on the same shard — split a client's state across two shards and neither shard's count means anything. [Consistent hashing](../patterns/distributed/routing/consistent-hashing.md) on the identifier (user ID, IP, or API key) gives exactly that: each client maps to one shard, load spreads evenly, and adding a shard only remaps a slice of keys. In production this is usually [Redis Cluster](../patterns/distributed/routing/sharding.md), which hashes keys across 16,384 slots and places `alice:bucket` on the right node automatically, using a fixed slot table that cluster-aware clients hold and refresh on MOVED redirects; resharding moves slots, not ring arcs. Per the sizing, 10 shards cover 1M checks/s at ~100k each and ~20 at 50k each; add headroom for hot shards and failover, and the token-bucket logic itself does not change — only where its state lives.

### 4 · Surviving a shard failure

Sharding turns every shard into a single point of failure for the clients it holds: lose one and those clients go uncovered, and if they retry hard, an unprotected backend can cascade. There are two options for a check that cannot reach its shard. **Fail-open** admits the request — good when availability of the API matters more than the limit. **Fail-closed** rejects it — chosen here, because a rate-limiter outage tends to coincide with a traffic spike, which is exactly when protection matters most; better to shed some load briefly than to let a viral surge flatten the databases. Prevention beats both: run each shard as a master with [replicas](../patterns/distributed/coordination/replication.md) that sync continuously, and let Redis Cluster auto-promote a replica on failure — a gap of about 1–2 seconds once the cluster node timeout is tuned short; detection waits on that timeout, and writes the replica had not yet received are lost. The cost is extra infrastructure and a little replication lag, which eventual consistency here tolerates.

```mermaid caption="What happens to a check when its shard is down, and what keeps that window short?"
flowchart TB
    GW["Gateway"] -->|"check for client"| Shard["Shard master"]
    Shard -.->|"fails"| Down{"shard reachable?"}
    Down -->|"no, fail-closed (chosen)"| Rej["Reject request"]
    Down -->|"no, fail-open (rejected)"| Adm["Admit request"]
    Shard -->|"sync continuously"| Rep["Replica"]
    Rep -->|"auto-promoted, typically 1-2 s"| Shard
```

### 5 · Shaving the network cost

Every check is a round trip, and the round trip — not the Redis op — is where the milliseconds go. Two optimisations do most of the work. **Connection pooling** keeps a warm set of TCP connections from each gateway to Redis so no request pays the 20–50&nbsp;ms handshake; it is a classic [object pool](../patterns/gof/extra/object-pool.md), and most Redis clients do it for you once tuned to the request volume. **Geographic distribution** is the bigger win: put gateways and their Redis clusters in the same region as the users, so a Tokyo request does not cross an ocean to a Virginia shard. Cross-region consistency gets fuzzier, but eventual consistency is acceptable for rate limiting, and the latency saved is large. Local caching of counts, pipelining, and request batching exist too, but they are rarely worth their staleness risk once pooling and locality are in place.

### 6 · Hot keys, viral content, and abuse

A single client throwing tens of thousands of requests a second at one shard is a [hot key](../hazards/hot-key.md) — sometimes a legitimate analytics pipeline or an over-eager mobile refresh loop, often a bot or a DDoS. Legitimate high-volume clients are handled by encouraging client-side throttling that respects the response headers, letting them batch operations into fewer calls, and offering premium tiers with higher limits on dedicated capacity. Abusive traffic gets a blunter tool: a client that trips its limit repeatedly (say ten times in a minute) is dropped onto a blocklist — cheap to store on a shard and checked only on a cache miss — and outright floods are best absorbed upstream by a DDoS layer such as Cloudflare or AWS Shield before they ever reach the limiter. Legitimate IP sharing (corporate NATs (network address translation), public WiFi) should be planned for up front with generous IP limits that lean on authenticated user limits, rather than patched after a false positive. Finally, limits should be reconfigurable without a redeploy — a launch may need a temporary bump — and a push-based config channel beats polling because a change takes effect in seconds instead of a poll interval later.

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- An allow/deny verdict in under 10&nbsp;ms with no per-request database call, at 1M req/s across ~10 sharded Redis instances.
- The token bucket absorbs legitimate bursts while capping the sustained rate, matching how real API traffic actually arrives.
- The atomic Lua check keeps a client's count correct on its shard whichever gateway serves the request, so concurrent requests cannot both take the last token; cross-region drift and failover state loss still apply.

### What it gives up
<!--meta polarity=con-->

- Fail-closed drops legitimate requests during a shard-and-replica outage rather than risk flooding the backend — availability of the limiter is chosen over availability of the API.
- Eventual consistency across regions lets a client briefly exceed its limit at the edges; strict global counting is deliberately not attempted.
- Every check is a network round trip to shared state, so Redis is both the throughput ceiling and a standing operational burden to shard, replicate, and monitor.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — explains one algorithm clearly (token bucket is enough), places the limiter sensibly at the API gateway, names Redis as the shared-state store, and recognises that scaling means sharding Redis, with a rough sense of how.
- **Senior** — argues the algorithm trade-offs and justifies the choice, knows the store ops must be atomic and reaches for a Lua script over plain `MULTI/EXEC`, brings up consistent hashing, Redis Cluster, and connection pooling unprompted, and weighs fail-open against fail-closed while flagging hot keys and latency.
- **Staff+** — moves through the algorithm quickly to spend time on production reality: multi-region deployment and cross-geo consistency, observability on the limiter's own success rate and latency, canary and gradual rollout of rule changes, and the failure modes that only show up at scale.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Race Condition](../hazards/race-condition.md) — The HMGET-then-HSET gap over-admits; one Lua script folds the check and the write into one atomic step.
- [Hot Key](../hazards/hot-key.md) — One client at tens of thousands of requests a second saturates a single shard; header-aware client throttling and a blocklist contain it.

**Demonstrates**

- [Token Bucket](../patterns/distributed/resilience/token-bucket.md) — the chosen counting algorithm — a per-client bucket that refills at a steady rate and admits a burst up to its depth
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — the design is a distributed instantiation of the rate-limiter pattern — quota, window, 429, fail-fast
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — the limiter is enforced at the gateway that already terminates every request, adding no extra hop
- [Distributed Cache](../patterns/caching/distributed-cache.md) — Redis holds the shared bucket state so every gateway sees one global count
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — hashes each client id to a fixed shard so its state never splits across nodes
- [Sharding](../patterns/distributed/routing/sharding.md) — splits ~2M bucket ops/second across roughly ten Redis nodes to clear the single-instance ceiling
- [Replication](../patterns/distributed/coordination/replication.md) — each shard runs a master with syncing replicas that auto-promote on failure rather than uncovering its clients
- [Object Pool](../patterns/gof/extra/object-pool.md) — connection pooling reuses warm Transmission Control Protocol (TCP) connections to Redis so no check pays the 20-50 ms handshake

<!-- relationships:end -->
