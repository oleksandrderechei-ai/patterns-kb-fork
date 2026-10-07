---
title: In-Process Cache
description: "Cache in the app's own memory — fastest, but each instance has its own copy"
area: caching
owner: Oleksandr Derechei
tags: [caching, latency, read-optimization]
status: stable
aliases: [local cache, near cache, L1 cache]
solves: [calling the shared cache for the same config on every request adds latency, I need sub-millisecond reads for a tiny lookup table every request touches, one hugely popular key keeps overloading a single cache node, reading a feature flag costs a network hop even though the value changes twice a month, when the shared cache tier goes down every request falls all the way through to the database]
---

# In-Process Cache

Keeps cached data inside the application process's own memory, so a hit needs no network hop at all — the fastest cache there is — at the cost of each instance holding its own, potentially divergent, copy.

## What it is
<!--meta block=description-->

Paying a network hop to a shared cache for settings, flags or a small lookup table on every request is pure overhead. An in-process cache keeps those values in a map inside your running application's own memory. A hit is a plain memory read, with no network call and no conversion to bytes.

## Explained
<!--meta block=explain-->

An in-process cache keeps values in a map inside your application's own memory. It is the fastest cache by a wide margin, because it removes the one cost even a [distributed cache](distributed-cache.md) cannot avoid: the round trip to reach it. Choose it over a shared cache for small, hot, mostly-read data, such as settings, feature flags or a lookup table, where even one network hop dominates the request. It is a targeted optimisation, not the default, and a natural first layer in front of a shared cache for the very hottest keys.

- **Copies disagree.** Each copy holds its own entry, so set the expiry (TTL) to the disagreement you accept, or use a shared cache if none.
- **Memory multiplies.** Every copy stores the same data, so cap the size and drop the least recently used entries first.
- **Cold start.** A restart or new copy starts empty, so load the keys that matter before it takes traffic.

**Example.** Twenty copies of a service each hold the same 500 feature flags of 1 KB, so 500 KB per copy and 10 MB in all. A request checks 50 flags. From memory that costs microseconds; at about 0.5 ms per shared-cache hop it would cost 25 ms. The TTL is 60 s. You switch a flag off at 12:00:00, and some copies keep serving the old value until 12:01:00. If that minute is too long, a 5 s TTL narrows it, and the price is 12 times as many reloads: 2,000 a second across the fleet (20 × 500 ÷ 5 s) against about 167 at 60 s.

## How it works
<!--meta block=structure-->

```mermaid caption="What does \"in the process\" actually cost? Steps 1 to 4 never leave the machine, which is why a hit is nearly free — but instance 2 filled its copy earlier and keeps answering v6 until step 6, because nothing carries a change from one process to the other."
flowchart LR
    H1["Request handler 1"]
    H2["Request handler 2"]
    subgraph P1["Instance 1's process — its own copy"]
        C1[("Local map, flags at v7")]
    end
    subgraph P2["Instance 2's process — a separate copy"]
        C2[("Local map, flags at v6")]
    end
    Src[("Source of truth, now at v7")]:::ext
    H1 -->|"1 look up flags, miss"| C1
    C1 -->|"2 load"| Src
    Src -->|"3 v7, stored locally"| C1
    H1 -->|"4 every later read: memory only, no network"| C1
    H2 -->|"5 hit, and it is still v6"| C2
    C2 -.->|"6 reloads only when its own TTL expires"| Src
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Bounded with eviction** — A size cap plus an eviction policy (usually LRU) keeps the cache from growing without bound and consuming the process's heap — the common form for anything but a tiny fixed table.
- **TTL-based expiry** — Each entry expires after a set time so the local copy can't drift too far from the source; the shorter the TTL, the narrower the cross-instance inconsistency window.
- **Near cache (L1 in front of L2)** — The in-process cache fronts a shared [distributed cache](../../designs/design-distributed-cache.md): it absorbs the hottest reads locally and defers everything else to the shared tier, cutting network hops for the keys that matter most.
- **Invalidation by broadcast** — To fight divergence, a write publishes an invalidation (e.g. over a pub/sub channel) that every instance listens for and applies to its local copy — buying tighter consistency at the cost of more moving parts.
- **Server-assisted invalidation** — Let the data store drive it instead of building the [fan-out](../messaging/fan-out.md) yourself. The server tracks which keys each client has read and invalidates only the clients holding a copy. Redis ships this as client-side caching with tracking. The cost is server memory, one key set per client; a broadcast mode exists for when that costs more than the extra messages.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The fastest cache possible**: a hit is an in-memory lookup with no network hop and no serialization.
- **No extra infrastructure** — it's a library or a plain map, with nothing new to deploy or operate.
- **No shared-cache dependency in the read path**, so cached keys keep serving through a shared-cache outage until their TTL ends; a miss still needs the source.
- **An effective L1 in front** of a shared cache, soaking up the hottest keys before they leave the process.

### Cons
<!--meta polarity=con-->

- **Each instance has its own copy**, so instances can serve different values for the same key.
- **The same data is duplicated across every instance**, wasting memory at scale.
- **Cold on every restart** — a restart or newly-scaled instance starts with an empty cache, so a deploy re-warms from scratch.
- **Invalidating a change across all instances** is genuinely hard — there's no single copy to update.
- **Shared references** — a caller that mutates a cached object changes it for every reader in that process, so store immutable values or copy on read.
- **Heap pressure** — cached objects live in the application heap, so a large cache raises garbage-collection time and slows every request in the process.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Small, hot, read-mostly data** — config, feature flags, a lookup table — is needed on nearly every request.
- **You need the lowest latency possible** and can't spare even a shared-cache network hop.
- **You want an L1** in front of a distributed cache to shield the hottest keys from the network.

### Avoid when
<!--meta polarity=avoid-->

- **The data changes often** and must read consistently across all instances — divergence will bite.
- **The working set is large**; duplicating it in every instance wastes memory a shared cache would pool.
- **You run many instances** and the memory duplication outweighs the latency you'd save.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a TTL cache with a size cap, living in the process's own memory"
// A plain Map in the app's own memory — no network hop on a hit.
// Each instance holds its own copy, so entries can diverge across the fleet.
type Entry<V> = { value: V; expiresAt: number };
const store = new Map<string, Entry<unknown>>();
const maxEntries = 1000; // illustrative cap; size it from your heap budget

function get<V>(key: string): V | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) { store.delete(key); return undefined; }  // TTL expiry
  return e.value as V;
}

function set<V>(key: string, value: V, ttlMs: number): void {
  // evict the oldest-inserted key; expired keys also leave only when read, the cap bounds the rest
  if (!store.has(key) && store.size >= maxEntries) store.delete(store.keys().next().value as string);
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

```

## In the wild
<!--meta block=wild-->

- **Caffeine** — A high-performance in-process caching library for Java with size- and time-based eviction. {#wild-caffeine}
- **Guava Cache** — Google Guava's in-memory LoadingCache, a common in-process cache in Java apps. {#wild-guava-cache}
- **Ehcache** — A widely-used Java virtual machine (JVM) in-process cache, often fronting a distributed tier as a near cache. {#wild-ehcache}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Maximum size or weight** — The entry count, or weighted capacity, at which eviction begins — maximumSize and maximumWeight in Caffeine and Guava Cache
- **Expiry policy** — Time-to-live measured after write or after last access: expireAfterWrite bounds how stale a value can get, expireAfterAccess reclaims memory held by keys nobody reads any more
- **Eviction algorithm** — What is dropped at capacity — least-recently-used, least-frequently-used, or the W-TinyLFU admission policy Caffeine uses
- **Background refresh window** — Whether an ageing entry is reloaded in the background on access instead of being evicted and reloaded in the request — refreshAfterWrite; asynchronous in Caffeine, and in Guava Cache only if the loader's reload is overridden to run asynchronously
- **Share of the heap budgeted to the cache** — How much process memory the cache may hold before it competes with request handling and pushes the collector

### Signals to watch
<!--meta polarity=signal-->

- **Hit ratio** — Share of lookups served without a load; below the level that justifies the memory it occupies, the cache is pure overhead
- **Eviction rate** — How fast entries are dropped at capacity — a climbing rate means the working set no longer fits the bound you set
- **Load latency and concurrent loads** — How long a miss takes and how many loads run at once, which is what a miss actually costs a request
- **Heap occupancy and collector pressure** — Memory held by cached objects and the collection time attributable to it; an over-large cache shows up as garbage collection before it shows up as a cache problem

### Failure modes under load
<!--meta polarity=failure-->

- **Instances answer the same question differently** — With no shared copy, one instance picks up a change while the others keep serving their own entry until it expires
- **Fleet-wide cold start on deploy** — A rolling restart empties every cache at once, so the source sees a miss storm shaped exactly like the rollout
- **Unbounded growth exhausts the heap** — A cache with no size bound behaves as a memory leak and surfaces as collector thrash or an out-of-memory failure
- **The working set is paid for once per instance** — Every instance holds the same entries, so memory cost scales with instance count rather than with the data
- **Concurrent misses each start their own load** — Without coalescing, several threads missing on the same key at the same moment all load it independently

### Readiness checklist
<!--meta polarity=check-->

- Bound every cache by size or weight — an unbounded map is a leak, not a cache
- Set an expiry that matches how stale the value may safely be, since expiry is the only invalidation you get for free
- Coalesce concurrent misses so one load serves every waiter in the process
- Decide what a divergent read costs before caching anything that changes; if it matters, keep the data in the shared tier
- Export hit ratio, eviction count and load latency — an unmeasured local cache hides both its value and its staleness
- Stagger restarts so the whole fleet does not cold-start onto the source at the same moment

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Caching](../../themes/caching.md) — Fastest placement: the app's own memory {#fluency-caching}
- [Health Modeling](../../themes/health-modeling.md) — Keep health probes from becoming the load {#fluency-health-modeling}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Vertical Partitioning](../distributed/routing/vertical-partitioning.md) — Caching an entity works far better once the constantly-changing fields have been split away from the stable ones

**Alternative to**

- [Distributed Cache](./distributed-cache.md) — Local to one instance, no network hop but per-instance copies
- [Identity Map](../enterprise/identity-map.md) — A cache serves repeat reads over time and does not guarantee one object per row.

**Often confused with**

- [Client-Side Cache](./client-side-cache.md) — Both keep a copy next to the reader; this one lives inside one server process and serves only that instance's callers, not the user's device

**Prevents**

- [Hot Key](../../hazards/hot-key.md) — A local fallback cache keeps the hottest key in the app's own memory

**Exposed to**

- [Premature Optimization](../../hazards/premature-optimization.md) — Can fall into premature optimization when a hand-rolled cache adds staleness and invalidation to a path that was fast enough

**Demonstrated by**

- [Gopuff](../../designs/gopuff.md) — a slow-changing reference table cached inside the service process is a classic in-process cache

<!-- relationships:end -->
