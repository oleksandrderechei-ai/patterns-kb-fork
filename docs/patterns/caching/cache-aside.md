---
title: Cache-Aside
description: "The app checks the cache first, fills it on a miss"
area: caching
owner: Oleksandr Derechei
tags: [caching, read-optimization, latency]
status: stable
aliases: [lazy loading, look-aside cache]
solves: [the same database query runs on every request for data that barely ever changes, my database is falling over from thousands of identical reads a second, I put Redis in front of Postgres but I have no idea where the loading logic should live, I updated a database row and my cache kept serving the old value for ten minutes, I do not want to preload everything into memory when only a handful of records ever get read]
---

# Cache-Aside

On every read the application checks the cache first — a hit returns straight away, and only a miss sends it to the source of truth, whose value it then writes back into the cache for next time.

## What it is
<!--meta block=description-->

A generic cache such as Redis does not know what an order is, how to load one, or when its copy has gone stale. In cache-aside your code does all of that. On a read it checks the cache, and on a miss it loads from the database and stores the value. On a write it updates the database and deletes the cached key.

## Explained
<!--meta block=explain-->

Cache-aside, also called lazy loading, keeps a copy of hot data in a fast key-value store (the cache) and leaves your code in charge of it. On a read you check the cache first. On a miss you load the value from the database, store it in the cache and return it. On a write you update the database and delete the cached key, so the next read reloads it. A hit costs one memory lookup instead of a query, entries exist only for data actually requested, and if the cache is down you read the database directly, slower but correct. Choose it over [read-through](read-through.md), where the cache library loads misses for you, when you use a plain store such as Redis or Memcached that knows nothing about your tables.

- **Stale window.** A reader can get the old value after the write, or refill it after the delete, so keep expiries short.
- **Stampede on expiry.** A popular key expiring makes readers miss together, so let one reload while others wait, or spread expiries.
- **Repeated read steps.** Every read site repeats check, load and store, so keep them in one helper.

**Example.** A product page takes 2,000 reads a second and the database handles 500 queries a second. At a 95% hit ratio only 100 reads a second reach the database. One hot product draws 1,000 of the 2,000 reads a second. When its entry expires and a reload takes 50 ms, about 50 readers miss together and send 50 identical queries at once. Letting one reload while the rest wait turns that into 1 query. The cost shows after a price change: if the database write succeeds but the delete fails, readers see the old price until the 300 s TTL ends.

## How it works
<!--meta block=structure-->

```mermaid caption="Who puts the value in the cache? The application does. Steps 4–6 run only on a miss, and there is no arrow from the cache to the database — the cache never loads anything by itself, so it needs to know nothing about your schema."
flowchart LR
    Caller["Request handler"]:::ext
    subgraph Own["The app owns the fill"]
        App["Application code"]
        Cache[("Cache")]
    end
    DB[("Database")]
    Caller -->|"1 get user 42"| App
    App -->|"2 look up user:42"| Cache
    Cache -->|"3 hit — value, done"| App
    App -->|"4 miss — read the row"| DB
    DB -->|"5 row"| App
    App -->|"6 set user:42 with a TTL"| Cache
    App -->|"7 answer"| Caller
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="On a miss the app reads through to the store and fills the cache itself; on a hit the database is never touched."
sequenceDiagram
    autonumber
    participant App
    participant Cache
    participant DB as Data store
    App->>Cache: get(key)
    alt hit
        Cache-->>App: value
    else miss
        Cache--xApp: not found
        App->>DB: read(key)
        DB-->>App: value
        App->>Cache: set(key, value)
    end
```

## Variations
<!--meta block=variations-->

- **[Read-Through](./read-through.md)** — The cache library itself loads on a miss instead of the app doing it — same effect, opposite owner of the fetch logic.
- **Write-invalidate on update** — A write deletes the cache key rather than updating it, so the next read repopulates from the source of truth instead of risking a bad overwrite.
- **TTL / lazy expiration** — Entries expire after a fixed time-to-live in addition to (or instead of) explicit invalidation, bounding staleness cheaply when writes are hard to track.
- **Negative caching** — Cache a "not found" marker too, so repeated lookups for a key that doesn't exist don't hit the database on every single request. Give the marker a short TTL and delete it when the key is created.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The cache holds only data** that's actually been requested, so it stays small and relevant.
- **A generic key-value cache** needs zero knowledge of the backing store or domain model.
- **A cache outage degrades gracefully** — reads fall through to the source, slower but correct, as long as the source can carry the full read rate. In the explain example, 2,000 reads a second would hit a database that handles 500.
- **The read path is simple to reason about**: check, miss, load, populate, return.

### Cons
<!--meta polarity=con-->

- **Repeated read logic** — every call site that reads must repeat the check-miss-load-populate logic, or share a helper that does.
- **Slow first read after eviction** — the first reader pays the full latency of the source, the "cache penalty."
- **There's a stale window** between a write to the source and the cache entry being invalidated, and a failed delete or a late refill stretches it to the TTL.
- **No built-in protection** against a [hot key](../../hazards/hot-key.md) expiring under load and a herd of misses hitting the source at once.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Reads vastly outnumber writes** and the same keys get requested repeatedly.
- **Access is sparse or unpredictable**, so pre-warming or caching everything would waste memory.
- **You're using a generic cache** that has no knowledge of your data model or loading logic.

### Avoid when
<!--meta polarity=avoid-->

- **Data changes so often** the hit rate would stay low anyway — caching adds complexity for little gain.
- **Every read needs a guarantee** of the freshest value — the cache can be stale between a write and its invalidation.
- **The loading and invalidation logic** belongs with the storage layer itself — reach for [Read-Through](./read-through.md) instead.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a cache-aside read and write path"
async function getUser(id: string): Promise<User> {
  // a cache error here should be caught and fall through to db; stampede guard omitted
  const cached = await cache.get<User | typeof NOT_FOUND>(`user:${id}`);
  if (cached === NOT_FOUND) throw new NotFoundError(id); // cached not-found
  if (cached !== null) return cached; // hit, database untouched

  const user = await db.query<User>(
    "SELECT * FROM users WHERE id = $1", [id],
  );
  if (user === null) {
    await cache.set(`user:${id}`, NOT_FOUND, { ttlSeconds: 30 });
    throw new NotFoundError(id);
  }

  await cache.set(`user:${id}`, user, { ttlSeconds: 300 });
  return user;
}

async function updateUser(id: string, patch: Partial<User>): Promise<void> {
  await db.update("users", id, patch);
  await cache.delete(`user:${id}`); // invalidate, next read repopulates
}
```

## In the wild
<!--meta block=wild-->

- **Memcached** — A deliberately dumb key-value store with no loader concept: the app checks it with get, falls through to the source on a miss, and populates by hand with set; its slab allocator and -m memory ceiling drive least recently used (LRU) eviction once full. {#wild-memcached}
- **Redis** — The default read-cache in front of a relational database, where application code owns the GET, the fallback query, the SET (usually with an EXPIRE for its TTL), and the DEL on write; maxmemory with an LRU or least frequently used (LFU) maxmemory-policy bounds its footprint. {#wild-redis}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Entry TTL** — Time-to-live per key bounds how long a stale value can serve after the source changes; a shorter TTL trades hit rate for freshness.
- **Negative-cache TTL** — A separate, usually shorter lifetime for cached not-found markers, so repeated lookups for an absent key don't round-trip the store every time.
- **Eviction policy and memory cap** — The memory ceiling and reclaim policy — LRU or LFU via Redis maxmemory-policy, or the -m limit on Memcached — decide which keys are dropped once the cache fills.
- **Serialization format** — How values are encoded before the SET; a compact encoding shrinks memory and network cost but adds CPU on every populate.

### Signals to watch
<!--meta polarity=signal-->

- **Hit ratio** — Hits over total lookups; a falling ratio means the working set no longer fits or the TTL is too short to pay off.
- **Source read rate on miss** — Queries per second reaching the backing store; a spike reveals mass evictions or a stale-key stampede.
- **Eviction rate** — Keys evicted per second; sustained eviction means the cache is undersized for its working set.
- **Read latency p99** — Tail latency separates cheap hits from the full source round trip a miss pays.

### Failure modes under load
<!--meta polarity=failure-->

- **Stale read after write** — Between a source write and the cache invalidation, readers see the old value; a crash between the two steps can leave it stale until the TTL fires.
- **Thundering herd on hot-key expiry** — A popular key expires and every concurrent reader misses at once, all hitting the source together; cache-aside has no built-in coalescing; mitigate with one reloader per key or a jittered TTL (see check 5).
- **Cache-penalty latency spike** — The first reader after an eviction pays the full source latency; a wave of evictions surfaces as a tail-latency spike.
- **Unbounded growth** — Without a memory cap and eviction policy, populated entries accumulate until the cache exhausts memory.

### Readiness checklist
<!--meta polarity=check-->

- Every write path invalidates or overwrites the cache key it touches
- A TTL backs every entry even where explicit invalidation already exists
- An eviction policy and memory cap are set so the cache cannot grow unbounded
- The read path degrades to a direct source read when the cache is unavailable
- Hot keys have stampede protection — coalescing, jittered TTL, or a lock — where a miss storm is unacceptable

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [System Design Interview](../../themes/system-design-interview.md) — Serve hot reads from memory {#fluency-system-design-interview}
- [Handling Spikes](../../themes/spike-handling.md) — Take read pressure off the origin {#fluency-spike-handling}
- [Performance](../../themes/performance.md) — The default read-cache strategy {#fluency-performance}
- [Scaling Reads](../../themes/scaling-reads.md) — Serve hot reads from an in-memory cache {#fluency-scaling-reads}
- [Caching](../../themes/caching.md) — The default read-cache strategy {#fluency-caching}

<!-- fluency:end -->

## Check yourself
<!--meta block=selfcheck-->

> **What stays stale after a write, and for how long?**
>
> The cache entry, from the write to the source until it is invalidated or expires, see [con 3](cache-aside.md#tradeoffs-con-3).

> **What happens when a hot key expires under load?**
>
> Many readers miss at once and all hit the source, because the pattern has no herd protection, see [con 4](cache-aside.md#tradeoffs-con-4).

> **Why does a cache outage degrade gracefully here?**
>
> Reads fall through to the source, slower but still correct, see [pro 3](cache-aside.md#tradeoffs-pro-3).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [CDN](../distributed/routing/cdn.md) — The edge caches; origin fills on a miss
- [Bloom Filter](../distributed/coordination/bloom-filter.md) — Skip a lookup the filter says will miss
- [Distributed Cache](./distributed-cache.md) — The shared store cache-aside usually runs against
- [Index Table](../distributed/coordination/index-table.md) — The same bargain at a different layer: a copy built from its source that can lag it
- [External Configuration Store](../distributed/coordination/external-configuration-store.md) — The caching layer a configuration client puts in front of a remote store
- [Refresh-Ahead](./refresh-ahead.md) — Add refresh-ahead when one expiring hot key would send a burst of misses to the source
- [Content Enricher](../messaging/content-enricher.md) — Each lookup an enricher makes is a read worth caching, so most messages skip the data source

**Alternative to**

- [Read-Through](./read-through.md) — App fills the cache vs. the cache fills itself
- [Write-Through](./write-through.md) — Invalidate and reload on the next read, accepting a stale window vs. write both stores now

**Often confused with**

- [Materialized View](../distributed/coordination/materialized-view.md) — Lazy cache vs. eagerly-maintained projection

**Prevents**

- [No Caching](../../hazards/no-caching.md) — The usual first answer when the same unchanged value is fetched on every request
- [Stale Cache](../../hazards/stale-cache.md) — Delete the key on write so the next read reloads; a late refill can still re-cache the old value until the TTL ends

**Exposed to**

- [Cache Stampede](../../hazards/cache-stampede.md) — Can fall into cache stampede when a miss makes each caller rebuild the value, so concurrent misses on a hot key all hit the source
- [Dual-Write Inconsistency](../../hazards/dual-write-inconsistency.md) — Can fall into dual write inconsistency when the app updates the store and then the cache with separate calls, so a failed second call leaves a stale entry
- [Hot Key](../../hazards/hot-key.md) — Can fall into hot key when one popular key lives on a single cache node, and every reader goes to it
- [Race Condition](../../hazards/race-condition.md) — Can fall into race condition when a read that reloaded an old value can re-cache it just after a write's invalidation
- [Thundering Herd](../../hazards/thundering-herd.md) — Can fall into thundering herd when entries written together expire together, so every miss recomputes at once
- [Metastable Failure](../../hazards/metastable-failure.md) — Can fall into metastable failure when a cold cache after a flush sends every read to the database, which can then never refill it

**Demonstrated by**

- [Bitly](../../designs/bitly.md) — Bitly caches short-code → long-URL lookups to serve ~600k reads/sec from memory
- [Top-K](../../designs/top-k.md) — a read-heavy ranking is absorbed almost entirely by an application-managed cache in front of the database
- [Metrics & Monitoring](../../designs/metrics-monitoring.md) — hot, repeatedly-requested panels are served from cache with misses falling through to the store
- [Facebook News Feed](../../designs/fb-news-feed.md) — read-heavy, rarely-edited posts are the ideal cache-aside workload, misses falling through to the key-value store
- [Instagram](../../designs/instagram.md) — feed hydration reads the cache first and populates it on miss, the defining cache-aside loop
- [Facebook Post Search](../../designs/fb-post-search.md) — identical, non-personalized queries make cache-aside the lever that keeps repeated searches off the index
- [Google News](../../designs/google-news.md) — reading the hot feed from memory and only touching the database on a miss is the cache-aside read path in its plain form
- [Gopuff](../../designs/gopuff.md) — inventory is read from cache first, populated on miss, and invalidated on write — the canonical cache-aside loop
- [YouTube](../../designs/youtube.md) — populating the cache on a miss to shield a hot database read path is precisely cache-aside

**Implemented by**

- [Databases](../../capabilities/databases.md) — Managed in-memory caches give you the store; you still write the load-on-miss logic.
- [Key-value & cache stores](../../comparisons/key-value-stores.md) — Which store suits the cache role, and which does more than cache.

<!-- relationships:end -->
