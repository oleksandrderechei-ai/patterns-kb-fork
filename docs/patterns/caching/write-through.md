---
title: Write-Through
description: "Writes hit the cache and the store together, synchronously"
area: caching
owner: Oleksandr Derechei
tags: [caching, durability]
status: stable
aliases: [write-through cache]
solves: ["a user saves a change, the page reloads, and the old value comes back", "I save to the database and then clear the cache as two separate steps, and they keep racing each other", "the process died between the database write and the invalidation, so the stale value stuck around until the TTL", someone added a third place that writes this record and forgot to bust the cache, the first read after every save is slow because nothing warm is sitting in memory yet]
---

# Write-Through

Every write updates the cache and the backing store together, in the same synchronous call, so a read that follows a write can never see a stale value.

## What it is
<!--meta block=description-->

When you update the database and then separately delete or update the cache, a crash between the two steps leaves the cache holding a value the database has moved past. A write-through cache sits in the write path. It saves to the database first, waits for it to accept, then updates its own entry and reports success.

## Explained
<!--meta block=explain-->

A write-through cache sits in the write path: it saves the value to the database, waits until the database accepts it, then updates its own entry and tells the caller it is done. A write is not done until the cache and the database agree, so a read right after a write never sees the old value, and you write no separate invalidation step. Choose it over [cache-aside](cache-aside.md), where you update the database and then delete the cached key as two steps a crash can split, when reads far outnumber writes and stale data after a write is not acceptable. Its opposite is write-behind, which trades that safety for write speed.

- **Every write pays both.** Each write waits for the database plus the cache update; for bursts use write-behind and accept unsaved data.
- **Unread keys fill the cache.** Skip caching keys written once and never read, and let a later read load them.
- **Two places must succeed.** Save to the database first and cache only after that works. If the cache update fails, delete the key.

**Example.** A profile service takes 10,000 reads and 100 writes a second. A database write takes 8 ms and a cache update 1 ms, so each write takes 9 ms. A user renames their account and reloads: the cache already holds the new name. With cache-aside, a crash between the write and the delete would show the old name until the 300 s expiry. The cost: if 90 of the 100 writes a second go to accounts nobody reads soon, each spends 1 ms on a cache update nobody uses and takes cache space. Write those straight to the database and let a later read load them. Write-through has the same gap if the cache update is lost; delete the key.

## How it works
<!--meta block=structure-->

```mermaid caption="When is a write finished? Not before step 3. The cache refuses to update its own entry until the database has taken the value, so a write that failed to persist never leaves a fresh-looking copy behind — and the reader at step 6 gets an entry that is warm by construction."
flowchart LR
    App["Application code"]:::ext
    subgraph Sync["One write call — the store goes first"]
        Cache[("Cache")]
        Store[("Database")]
    end
    Reader["Next reader"]:::ext
    App -->|"1 set price:42"| Cache
    Cache -->|"2 persist, and wait"| Store
    Store -->|"3 durable ack"| Cache
    Cache -->|"4 update the entry"| Cache
    Cache -->|"5 ack — now it is saved"| App
    Reader -->|"6 read hits the warm entry"| Cache
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Why does the store go first: how does store-first ordering keep a value that failed to persist from ever sitting in the cache?"
sequenceDiagram
    autonumber
    participant C as Client
    participant Ca as Cache
    participant St as Store
    C->>Ca: write(key, value)
    Ca->>St: write(key, value)
    alt store persists
        St-->>Ca: ack, durable
        Ca->>Ca: update entry
        Ca-->>C: ack
    else store write fails
        St--xCa: error
        Ca-->>C: error, entry not updated
    end
```

## Variations
<!--meta block=variations-->

- **Store-then-cache vs. cache-then-store ordering** — Persist to the store first and only then update the cache, or update the cache first and write through behind it. Store-first never lets a value that failed to persist sit in the cache. Cache-first leaves a value that never persisted readable if the store write fails, so it needs rollback.
- **[Paired with Read-Through](./read-through.md)** — Misses on the read side fault through the same cache into the store, so both directions treat the cache as the single authoritative front door.
- **Selective write-through (write-around for cold keys)** — Skip caching keys that are unlikely to be read again and let a later read fault them in — avoids spending the cache-write cost on data that's never reused.
- **[Replicated](../distributed/coordination/replication.md) / distributed write-through** — In a clustered cache, the node taking the write must also propagate it (or an invalidation) to peer nodes before acking — more write latency in exchange for cluster-wide consistency.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Cache and store agree after each write** — while every write goes through the cache and both steps succeed, a read right after a write sees the fresh value; a failed cache step or a write that bypasses the cache breaks that.
- **Removes the cold-read penalty**: data is warm in the cache the instant it's written.
- **Simplifies the read path** — reads can trust the cache with no invalidate-then-fetch races.
- **A failed persist is caught synchronously**, at the write call, not discovered later.

### Cons
<!--meta polarity=con-->

- **Every write pays the store's** latency plus the cache update, in sequence: 8 ms + 1 ms = 9 ms in the example.
- **Write-heavy, rarely-read keys** still get cached, wasting space on data nobody reads back.
- **Cache and store must both succeed** — if the cache update fails or two writers race on one key, the cache can keep the older value, so evict the key on failure or write with retry or rollback.
- **Does nothing for write throughput** — for that, look at Write-Behind instead.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Reads vastly outnumber writes** and stale data right after a write is unacceptable.
- **A cache miss is expensive** — a slow recompute or a cold store hit — so keeping the cache warm on write matters.
- **You need read-your-writes consistency** without bolting on separate invalidation logic.

### Avoid when
<!--meta polarity=avoid-->

- **Writes are frequent or bursty** and write latency has to stay low — see [Write-Behind](./write-behind.md).
- **Most written keys** are rarely or never read back — caching them on write is wasted work.
- **The backing store already** serves fast, consistent reads on its own — caching adds no value.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal write-through cache"
interface Store<K, V> {
  read(key: K): Promise<V | undefined>;
  write(key: K, value: V): Promise<void>;
}

class WriteThroughCache<K, V> {
  private cache = new Map<K, V>();

  constructor(private readonly store: Store<K, V>) {}

  async get(key: K): Promise<V | undefined> {
    if (this.cache.has(key)) return this.cache.get(key);
    const value = await this.store.read(key);
    if (value !== undefined) this.cache.set(key, value);
    return value;
  }

  async set(key: K, value: V): Promise<void> {
    await this.store.write(key, value); // durable first
    this.cache.set(key, value);         // only cache once persisted
  }
}
```

## In the wild
<!--meta block=wild-->

- **Hazelcast MapStore** — Configured in write-through mode (write-delay-seconds of zero), the distributed IMap persists each entry through the MapStore to the backing store synchronously before put() returns to the caller. {#wild-hazelcast-mapstore}
- **Ehcache CacheLoaderWriter** — The same CacheLoaderWriter that loads on a miss also writes through on put and delete, persisting to the system of record before the cache entry is considered updated. {#wild-ehcache-writer}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Write ordering (store-first vs. cache-first)** — Persist to the store then update the cache, or the reverse; store-first ensures a value that failed to persist never sits in the cache.
- **Entry time to live (TTL)** — A backstop lifetime even for write-populated entries, so a cached value can't outlive its usefulness if an out-of-band change bypasses the write path.
- **Write-around threshold** — A rule for which keys skip the cache on write — cold, write-once keys — letting a later read fault them in instead of spending the cache-write cost on data never read back.
- **Propagation before ack** — In a clustered cache, whether the write (or an invalidation) reaches peer nodes before the write is acknowledged — cluster-wide consistency for more write latency.

### Signals to watch
<!--meta polarity=signal-->

- **Write latency p99** — The tail of the write path: the store round trip plus the cache update, so any store slowdown shows here.
- **Write error rate** — Writes where the store or cache update failed; write-through catches a failed persist synchronously, so this reflects real durability failures.
- **Post-write hit ratio** — How often written keys are actually read back; a low ratio means write-through is caching data nobody reads, wasting space.
- **Cache-store divergence** — Sampled comparisons of cache versus store values; near zero when every write uses the cache. Non-zero means a partial write or a bypass.

### Failure modes under load
<!--meta polarity=failure-->

- **Partial write splits cache and store** — Store succeeds but the cache update fails: the cache keeps the old value while the store holds the new one. Delete the key so the next read loads fresh, and log it.
- **Write latency dominated by a slow store** — Every write waits on the store's full round trip; a slow or overloaded store makes all writes slow, with no throughput relief.
- **Cache pollution by write-once keys** — Keys written and never read still occupy cache space, evicting hotter entries and lowering the overall hit rate.
- **Out-of-band store change goes unseen** — A value changed directly in the store, bypassing the write-through path, leaves the cache confidently serving a stale copy until its TTL.

### Readiness checklist
<!--meta polarity=check-->

- Write ordering is store-first so an unpersisted value never lands in the cache
- A partial-failure path — retry or rollback — reconciles cache and store when one side fails
- Every entry carries a TTL backstop in case an out-of-band change bypasses the write path
- Write-once and cold keys are written around the cache rather than polluting it
- Write latency p99 is monitored, since it tracks the backing store's own write latency

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Caching](../../themes/caching.md) — Keep the cache and store in lockstep {#fluency-caching}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Read-Through](./read-through.md) — Read-through paired with write-through keeps sync

**Alternative to**

- [Write-Behind](./write-behind.md) — Write now, consistent vs. write later, faster
- [Cache-Aside](./cache-aside.md) — Every write pays for the cache and the gap closes; cache-aside keeps writes cheap and lives with the window

**Prevents**

- [Stale Cache](../../hazards/stale-cache.md) — Write the cache and store together, so a read after a write can't be stale

**Exposed to**

- [Dual-Write Inconsistency](../../hazards/dual-write-inconsistency.md) — Can fall into dual write inconsistency when the cache and store are written by two calls with no shared transaction

**Implemented by**

- [Databases](../../capabilities/databases.md) — Some caches write every update through to the database before returning.

<!-- relationships:end -->
