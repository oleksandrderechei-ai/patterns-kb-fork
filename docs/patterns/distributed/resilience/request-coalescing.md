---
title: Request Coalescing
description: Collapses concurrent identical requests into one in-flight call
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, latency, throughput]
status: stable
aliases: [single-flight, request collapsing, duplicate suppression]
solves: [hundreds of requests hit the database for the same row the moment the cache entry expires, the same expensive query runs many times in parallel because every caller missed at once, our origin sees a burst of identical reads even though the cache hit rate looks fine, one popular key going cold takes the backend down with it]
---

# Request Coalescing

When several callers ask for the same thing at the same time, only the first is allowed to do the work — the rest wait on the answer it is already fetching, so N simultaneous requests cost the backend exactly one.

## What it is
<!--meta block=description-->

When a popular cache entry expires, hundreds of requests miss at once and each asks the database for the same row. Request coalescing lets the first caller start the fetch and register it under its key. Callers who arrive while it runs wait for that result, so one backend call serves them all. A cache alone cannot close this gap, because no answer is stored yet.

## Explained
<!--meta block=explain-->

Request coalescing makes callers who ask for the same thing at the same moment share one call, so a burst of identical requests costs the backend one request, not hundreds. The first caller starts the fetch and records it under its key. Everyone who arrives while it runs waits for that result instead of starting their own. The record is removed when the fetch ends, on failure as well as success, or the next caller inherits an error that is not its own. Choose it over a bigger cache or a longer expiry when the damage comes from many identical requests at one instant (a cache stampede), because a cache only helps once the first answer is stored.

- **Shared fate.** Give the fetch a timeout. A late caller waits only for the rest of the fetch, but a hung fetch holds every waiter.
- **Key is a safety boundary.** Include tenant, language and permissions in it, or you serve one user another's data.
- **One process only.** Many copies of your service still make one call each, so share the gate if that is too many.

**Example.** A product cache entry expires and 500 requests arrive in the next 50 ms. The query takes 200 ms. Without coalescing, 500 identical queries hit the database at once. With it, the first request starts one query at 0 ms, the other 499 wait on it, and all 500 get their answer at 200 ms. The late arrival at 50 ms waits 150 ms. Behind a balancer sit 10 copies of the service, each with its own record, so the database still sees 10 queries, not 1. If the one query fails, all 500 requests fail with it.

## How it works
<!--meta block=structure-->

```mermaid caption="Three callers want key K at once. Step 5 happens once because step 4 is atomic — B and C find A's claim instead of making their own — and step 7 fans the single result back out."
flowchart LR
    C1["Caller A"] -->|"1 ask for key K"| G["Coalescer"]
    C2["Caller B"] -->|"2 ask for key K"| G
    C3["Caller C"] -->|"3 ask for key K"| G
    subgraph atomic["One atomic check-and-insert"]
      G -->|"4 claim K, or find the claim"| M[("In-flight map: key to promise")]
    end
    G -->|"5 first claimant only"| O[("Origin")]
    O -->|"6 one result"| G
    G -->|"7 the same result to all three"| C1
```

The subgraph is what carries the guarantee. If looking the key up and inserting your own promise are two separate steps, two callers can both pass the lookup before either inserts, the origin sees two calls, and the pattern degrades to no pattern at all under exactly the load it was added for.

```mermaid caption="The failure branch is where the pattern is usually got wrong. B shares A's fate, and the claim must be released on rejection as well as on success — otherwise the next caller waits on a promise that has already failed."
sequenceDiagram
    participant A as Caller A
    participant B as Caller B
    participant G as Coalescer
    participant O as Origin
    A->>G: get(K)
    G->>G: miss, so claim K
    G->>O: fetch K
    B->>G: get(K)
    G->>G: hit, so wait on A's claim
    O--xG: times out
    G->>G: release the claim on K
    G-->>A: error
    G-->>B: the same error
```

## Variations
<!--meta block=variations-->

- **In-process single-flight** — One map per instance from key to in-flight promise, with the check-and-insert guarded as one atomic step and no coordination. It costs nothing to operate and removes duplicate work inside a process, but a fleet of N instances still sends up to N concurrent calls to the origin. This is the default, and it is usually enough.
- **Cross-process coalescing** — The gate moves to a shared store: whoever wins a short-lived lock does the fetch and publishes the result, and the losers poll or subscribe for it. Origin concurrency falls to one across the whole fleet, at the price of a network round-trip on every call. Set the lock lease a little above the origin's p99 so a dead holder frees the key, and cap how long losers wait before they fetch for themselves.
- **Serve-stale-and-refresh** — Waiters are handed the expired value immediately while exactly one refresh runs behind them. Nobody blocks, so head-of-line latency disappears, and the cost is that callers knowingly read data that is a little out of date.
- **Windowed batching of adjacent keys** — A short window collects different keys and issues one multi-get instead of collapsing identical ones. That is [batching](../../concurrency/batching.md) rather than coalescing — it trades a small fixed latency for far fewer round-trips — and the two compose: collapse the duplicates, then batch what remains.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Bounds origin concurrency per key** at one, so a burst of identical misses costs a single backend call rather than hundreds.
- **Needs no coordination in its common form** — a map and a lock inside one process, with nothing extra to deploy or operate.
- **Protects the origin without asking callers to behave**, so it still holds when a new client ships without the retry discipline everyone assumed.

### Cons
<!--meta polarity=con-->

- **Waiters share the leader's fate**: one slow or failed fetch becomes slow or failed for everyone attached to it.
- **A caller arriving late** may read data fetched before it asked, and a slow or hung fetch holds it until the fetch ends.
- **The key is a correctness boundary**. Omit the tenant, the locale or the permission scope and one caller is served another's data.
- **Deduplication is only as wide as the map**, so on a large fleet the origin still sees roughly one call per instance unless the gate is shared.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Many callers want the same expensive thing** at the same moment — a [hot key](../../../hazards/hot-key.md) expiring, a cold start, a cache flush.
- **The origin is the scarce resource** and duplicate work is what exhausts it, rather than genuine distinct demand.
- **The answer is shareable between those callers** without a further authorization check.

### Avoid when
<!--meta polarity=avoid-->

- **The requests are not truly identical** — anything varying by caller, tenant or permission must not share one result.
- **The work has side effects**. Collapsing two writes into one silently drops the second, which is a correctness bug rather than an optimization.
- **Every caller needs its own freshest read**, as in a compare-and-set loop that must observe the newest value.
- **A caller has just written and must read its own write back**, because the joined fetch may have started before the write.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a single-flight gate over any async loader"
/* One entry per key while a fetch is running. In a single-threaded runtime the
 * get-then-set below cannot interleave, which is what makes it atomic here; the
 * same two lines in a threaded language need a per-key lock or computeIfAbsent. */
export function coalesce<T>(load: (key: string) => Promise<T>) {
  const inFlight = new Map<string, Promise<T>>();

  return function get(key: string): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing;           // someone is already fetching this

    const call = load(key).finally(() => {
      // Release on rejection too, or the next caller waits on a dead promise.
      inFlight.delete(key);
    });

    inFlight.set(key, call);
    return call;
  };
}

// 800 concurrent misses on one key produce exactly one loadUser call.
const getUser = coalesce(loadUser);
await Promise.all(Array.from({ length: 800 }, () => getUser("u-42")));

// A caller that times out or aborts leaves; the leader's load keeps running for the rest.
// Return structuredClone(result) or a frozen value.
function follow<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const leave = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error("follower timeout")), ms);
    signal?.addEventListener("abort", () => rej(signal.reason), { once: true });
  });
  return Promise.race([p, leave]).finally(() => clearTimeout(t));
}

```

## In the wild
<!--meta block=wild-->

- **Go singleflight** — The `golang.org/x/sync/singleflight` package: `Group.Do` runs one call per key at a time and gives every concurrent caller of that key the leader's result and error, plus a shared flag. `Forget` drops a key so the next call starts fresh; `DoChan` returns a channel, so a caller can stop waiting on its own timeout. {#wild-go-singleflight}
- **Varnish Cache** — Concurrent requests for an object that is being fetched from the backend wait on that single fetch rather than each going to the origin. {#wild-varnish-coalescing}
- **NGINX proxy cache lock** — With `proxy_cache_lock on`, only one request populates a missing cache element and the others wait for it or time out. `proxy_cache_lock_timeout` defaults to 5 s; when it expires, the waiting request goes to the upstream but its response is not cached. {#wild-nginx-cache-lock}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Coalescing key** — What makes two requests identical: path, parameters, tenant, auth scope. Too loose merges requests that differ; too tight merges nothing.
- **Follower wait timeout** — How long a waiting caller gives the leader before it makes its own call or fails. Start near the leader's p99 latency plus a margin, and let a follower fall back or fail fast rather than wait without bound.
- **Result retention** — Drop the result at once (pure single-flight) or keep it a short time. Retention turns coalescing into a cache and brings staleness.
- **Error sharing** — Whether followers receive the leader's failure or retry on their own. Sharing a failure fails everyone together.
- **Scope** — Within one process, or across a fleet through a lock in a shared cache. Per-process coalescing still sends one call per instance.
- **Lock lease and poll interval** — For a shared lock, set the lease a little above the leader's p99 so a dead holder frees the key. Too short duplicates the fetch; too long stalls the fleet. Add jitter to waiter polls so they do not wake together.

### Signals to watch
<!--meta polarity=signal-->

- **Coalesce ratio** — Followers served per leader call. Near 1 means the key rarely repeats and the machinery pays nothing.
- **Backend request rate against client request rate** — The gap between them is the load removed from the origin.
- **Follower wait time** — The p99 wait against the leader's latency. A follower waits no longer than the leader; a longer wait points to a faulty timeout or wake-up path.
- **In-flight keys** — Count of open leaders. Growth with no matching completions points to stuck calls.

### Failure modes under load
<!--meta polarity=failure-->

- **Key omits identity** — Requests that differ by user or tenant share a key, so one person gets another's response.
- **One slow leader holds everyone** — Every follower waits on a single stuck call, so a single slow request stalls a whole group of callers.
- **Leader failure fans out** — One error returns to every follower at once, so a transient fault looks like a wide outage.
- **Cancelled leader cancels followers** — The leader's caller gives up, and the shared call dies with it for callers that were still waiting.
- **Shared result mutated** — One caller edits the returned object that all callers hold, and the others see the edit.

### Readiness checklist
<!--meta polarity=check-->

- The key includes everything that changes the response, including identity and tenant
- Each follower has its own timeout and cancellation
- A caller that cancels does not cancel the shared call for the rest
- Returned results are copied or treated as read-only
- A test with N concurrent callers makes exactly one backend call
- The coalesce ratio is exported as a metric

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Handling Spikes](../../../themes/spike-handling.md) — Collapse concurrent identical requests into one call to the origin. {#fluency-spike-handling}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Read-Through](../../caching/read-through.md) — The cache that owns the miss path is the natural place to put the gate
- [Batching](../../concurrency/batching.md) — Collapse the duplicates first, then batch the distinct keys that remain
- [Timeout / Deadline](./timeout-deadline.md) — A bound on the shared call is what stops one hung fetch hanging every waiter
- [Load Shedding](./load-shedding.md) — Both bound what reaches the origin — one by removing duplicates, the other by refusing excess
- [Distributed Lock](../coordination/distributed-lock.md) — Cross-process coalescing: the winner of a short-lived lock does the fetch, so the fleet makes one origin call.

**Alternative to**

- [Refresh-Ahead](../../caching/refresh-ahead.md) — Refresh before expiry so the gap never opens, rather than guarding the gap when it does

**Often confused with**

- [Hedged Request](./hedged-request.md) — Coalescing merges many identical requests into one, which is the opposite move.

**Prevents**

- [Cache Stampede](../../../hazards/cache-stampede.md) — Collapsing the concurrent misses is what stops one expiry becoming a herd of identical queries
- [Thundering Herd](../../../hazards/thundering-herd.md) — The waiters released together share one call instead of each making their own
- [Metastable Failure](../../../hazards/metastable-failure.md) — Coalescing blunts the cold-cache load that sustains a metastable overload.

<!-- relationships:end -->
