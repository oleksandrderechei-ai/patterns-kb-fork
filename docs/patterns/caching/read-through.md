---
title: Read-Through
description: "The cache loads on a miss, the app never sees the gap"
area: caching
owner: Oleksandr Derechei
tags: [caching, read-optimization, encapsulation, latency]
status: stable
solves: [six different services each wrote their own check-then-load-then-store dance and they have all drifted apart, half the codebase expires this cached data after five minutes and the other half after an hour, "someone fetched a record and forgot to put it back in memory, so it was slow forever and nobody noticed", when a hot key expires a hundred requests all pile onto the database at the same instant, I want callers to just ask for the value without knowing whether it came from memory or the database]
---

# Read-Through

On a cache miss, the cache reaches into the backing store itself, loads the value, populates the entry, and hands it back — the application only ever calls `get()` and never sees the gap underneath.

## What it is
<!--meta block=description-->

Against a plain cache, every caller runs its own check, load and store steps, and the copies drift apart with different TTLs, forgotten stores and double loads. A read-through cache does the loading itself. You call one get, and on a miss the cache runs a loader you gave it, stores the result and returns it.

## Explained
<!--meta block=explain-->

A read-through cache loads missing values itself. You call one get(key): on a hit it returns the value, and on a miss it runs a loader function bound to the backing store, stores the result and returns it. Your callers never branch on hit or miss, so the check, load and store steps live in one place instead of drifting apart across call sites with different TTLs. Because the cache owns the load, callers that ask for the same missing key can wait for one load, and a key known to be absent can be cached so repeat lookups stop hitting the store. Choose it over [cache-aside](cache-aside.md) when many call sites share one loading rule; keep the fill in your own code where callers need different fallbacks.

- **Slow miss.** The reader waits for the load, so reload hot keys shortly before they expire.
- **Shared slow load.** All waiters share one load, so cap the loader with a timeout.
- **Reads only.** Pair it with a write rule or the cache goes stale.
- **Coupled to the loader.** The cache must be wired to a loader function or data source, tighter than a plain key-value store.

**Example.** User 42 is read 7,500 times a second, and loading it from the database takes 40 ms. When its entry expires, 7,500 x 0.04 = 300 readers arrive during the load. A plain cache sends 300 identical queries. A read-through cache with waiting sends 1 and hands the result to all 300. The cost is a wait: readers wait up to 40 ms, about 20 ms on average if they arrive evenly. If the database stalls, they wait for the loader timeout, say 2 s, and then fail together. Reloading the key at second 290 of a 300 s TTL lets most readers skip the wait, but a stalled store fails that reload too.

## How it works
<!--meta block=structure-->

```mermaid caption="Who fills the cache? The cache does, through the loader wired into it. The application makes one call and never branches. Steps 3–6 all happen inside the box, so when the cache coalesces loads, a thousand simultaneous misses for one key share a single trip to the store."
flowchart LR
    App["Application code"]:::ext
    subgraph Owned["One get() — the cache owns the fill"]
        Cache[("Cache")]
        Loader["Bound loader"]
    end
    Store[("Backing store")]
    App -->|"1 get user:42"| Cache
    Cache -->|"2 hit — value, done"| App
    Cache -->|"3 miss — one load per key"| Loader
    Loader -->|"4 read the row"| Store
    Store -->|"5 row"| Loader
    Loader -->|"6 populate with a TTL"| Cache
    Cache -->|"7 the same call returns the value"| App
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="How is a read served: a cache hit that skips the store, a miss that loads behind the scenes, and a backing load that fails?"
sequenceDiagram
    autonumber
    participant App
    participant Cache
    participant Store
    App->>Cache: get(key)
    alt entry cached (hit)
        Cache-->>App: value, store untouched
    else missing (miss)
        Cache->>Store: load(key)
        alt load succeeds
            Store-->>Cache: value from source
            Cache->>Cache: populate entry
            Cache-->>App: value
        else load fails
            Store--xCache: error
            Cache-->>App: error, entry left empty
        end
    end
```

## Variations
<!--meta block=variations-->

- **Synchronous load** — The cache blocks the caller until the loader returns. Simplest to reason about, but every concurrent caller on a miss waits for the same round trip.
- **[Request coalescing](../distributed/resilience/request-coalescing.md) / single-flight** — Concurrent misses for the same key share one in-flight load instead of each triggering its own call. The first caller loads; the rest await that same promise. A failed or timed-out load fails every waiter, so decide whether to cache the failure briefly.
- **Negative caching** — Cache a short-lived "not found" marker for missing keys, so a flood of lookups for absent data doesn't repeatedly round-trip the store.
- **[Refresh-Ahead](./refresh-ahead.md)** — Instead of waiting for a miss, proactively reload a [hot key](../../hazards/hot-key.md) shortly before its entry expires, so the read-through load path stays cold for busy keys.
- **Multi-level read-through** — A local [in-process cache](./in-process-cache.md) is itself read-through to a shared remote cache, which is read-through to the store — each tier only loads from the one behind it.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Application code just calls** `get()` — no miss-handling branch scattered across callers.
- **Loading and population logic lives in one place**, so TTLs, serialization, and coalescing stay consistent for everyone.
- **Can collapse concurrent misses** into a single backing call, shielding the store from thundering herds.
- **Callers never talk to the store directly**, so the store's shape can change behind the loader.

### Cons
<!--meta polarity=con-->

- **Needs a cache** that supports a bound loader function — harder to bolt onto an existing dumb cache.
- **Cold reads are slow** — a cold cache or an evicted hot key makes the next read wait for the full synchronous load, 40 ms in the explain example.
- **Ties the cache to one backing store's shape**, which is awkward when different callers want different fallback logic.
- **Solves reads only** — writes still need a paired strategy or the cache goes stale silently.
- **The load happens inside** `get()`, so nothing at the call site shows a read reached the store. A latency regression looks like a slow cache until you read the cache's own hit and load statistics.
- **Single-flight is per process**, so a fleet of N instances sends up to N loads per expiry; reaching one load needs a shared tier or a lock.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple services or call sites** currently duplicate their own check-cache-else-load-else-populate logic.
- **Callers should be shielded entirely** from cache misses and the loading mechanics behind them.
- **The backing store benefits** from load coalescing under bursts of concurrent reads for the same key.

### Avoid when
<!--meta polarity=avoid-->

- **Different callers need genuinely different** loading or fallback logic for the same key — [Cache-Aside](./cache-aside.md) keeps that control in application code.
- **Writes are frequent and must be reflected immediately** — pair with [Write-Through](./write-through.md) rather than leaving reads stale.
- **You don't control the cache** client closely enough to wire in a loader function.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a coalescing read-through cache"
class ReadThroughCache<K, V> {
  private entries = new Map<K, V>();
  private inFlight = new Map<K, Promise<V>>();

  constructor(
    private readonly loader: (key: K) => Promise<V>,
    private readonly ttlMs = 30_000,
    private readonly timeoutMs = 2_000,
  ) {}

  async get(key: K): Promise<V> {
    const hit = this.entries.get(key);
    if (hit !== undefined) return hit;          // no store call

    const pending = this.inFlight.get(key);
    if (pending) return pending;                 // coalesce concurrent misses

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("loader timeout")), this.timeoutMs);
    });
    const load = Promise.race([this.loader(key), timeout])
      .then((value) => {
        this.entries.set(key, value);
        setTimeout(() => this.entries.delete(key), this.ttlMs);
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
        this.inFlight.delete(key);   // success and failure: a rejection is not cached
      });
    this.inFlight.set(key, load);
    return load;
  }
}

// Caller never branches on hit vs. miss
const users = new ReadThroughCache((id: string) => db.findUser(id));
const u = await users.get("42");
```

## In the wild
<!--meta block=wild-->

- **Caffeine (LoadingCache)** — Built from a CacheLoader, its LoadingCache computes absent entries inside get(), collapses concurrent misses for the same key into a single load, and exposes hit, miss, and load-failure counts once recordStats() is enabled. {#wild-caffeine}
- **Guava CacheLoader** — A CacheBuilder plus a CacheLoader yields a LoadingCache whose get() loads and populates missing entries transparently; getAll can batch-load, and expireAfterWrite and maximumSize bound each entry. {#wild-guava-cache}
- **Ehcache CacheLoaderWriter** — Registering a CacheLoaderWriter makes the cache read from the system of record on a miss (and write through on put), so application code only ever calls get() and put(). {#wild-ehcache}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Entry TTL (expire-after-write)** — How long a loaded value stays valid before the next read reloads it; Caffeine's expireAfterWrite and Guava's expireAfterWrite set this directly.
- **Maximum size or weight** — The entry or memory ceiling that bounds the cache; Caffeine's maximumSize or maximumWeight decides when least-used entries are evicted.
- **Loader timeout** — A bound on how long the caller blocks waiting for the loader; without it a slow source stalls every coalesced waiter on that key.
- **Coalescing / single-flight** — Whether concurrent misses for one key share a single in-flight load; that collapse is what shields the store from a stampede.
- **Negative-cache TTL** — A short lifetime for cached not-found results, so a flood of lookups for an absent key doesn't repeatedly hit the store.

### Signals to watch
<!--meta polarity=signal-->

- **Hit ratio** — Hits over total gets; the complement, loads over gets, is the miss ratio. Caffeine and Guava expose hitRate and missRate directly once recordStats is enabled.
- **Load latency** — Time the loader takes; its p99 is the latency a miss adds to a read, and a rising trend means the store is struggling.
- **Load failure rate** — Loader calls that throw; a spike means the backing store is failing and misses are turning into errors for callers.
- **In-flight load count** — Concurrent loads outstanding; if coalescing works this stays near the number of distinct hot keys, not the request rate.

### Failure modes under load
<!--meta polarity=failure-->

- **Synchronous load penalty on cold or evicted key** — A miss blocks the caller for the full loader round trip; a cold start or a wave of evictions makes many reads pay it at once.
- **Loader failure surfaces to callers** — Because the cache owns the load, a failing backing store turns into exceptions on get(); without negative caching those failures repeat every request.
- **Stale reads with no write path** — Read-through solves reads only; if writes don't invalidate or write through, entries serve old values silently until the TTL.
- **Coalesced waiters stall on one slow load** — When concurrent misses collapse into a single load and that load hangs, every waiter on the key hangs with it.

### Readiness checklist
<!--meta polarity=check-->

- The loader has a timeout so a slow source can't stall every waiter on a key
- Concurrent misses coalesce (single-flight) where the store can't absorb a stampede
- A write strategy — write-through or invalidation — is paired so reads don't serve stale data forever
- Loader exceptions are surfaced, retried, or negatively cached, never silently swallowed
- Cache stats (hit rate, load penalty, load-failure rate) are exported to monitoring

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Performance](../../themes/performance.md) — Cache reads transparently {#fluency-performance}
- [Caching](../../themes/caching.md) — Let the cache own the miss path {#fluency-caching}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Replication](../distributed/coordination/replication.md) — Read replicas serve cached-style reads
- [Write-Through](./write-through.md) — Read-through paired with write-through keeps sync
- [Refresh-Ahead](./refresh-ahead.md) — Refresh hot keys before they expire
- [Request Coalescing](../distributed/resilience/request-coalescing.md) — One load path per key is what makes collapsing concurrent misses possible at all

**Alternative to**

- [Cache-Aside](./cache-aside.md) — App fills the cache vs. the cache fills itself

**Prevents**

- [Cache Stampede](../../hazards/cache-stampede.md) — One load path per key lets the cache coalesce concurrent misses into a single fetch
- [No Caching](../../hazards/no-caching.md) — Removes the repeated source read without every caller having to implement the fill

**Exposed to**

- [Stale Cache](../../hazards/stale-cache.md) — Can fall into stale cache when a cached entry has no knowledge of writes made elsewhere
- [Hot Key](../../hazards/hot-key.md) — Can fall into hot key when an evicted or expired hot key sends every reader to one synchronous load on the source

**Demonstrated by**

- [Ticketmaster](../../designs/ticketmaster.md) — the hot event page is the archetypal read-through workload — high-read, low-change data fronted by a cache keyed by id

**Implemented by**

- [Databases](../../capabilities/databases.md) — Some caches load from the database on a miss so your code never does.

<!-- relationships:end -->
