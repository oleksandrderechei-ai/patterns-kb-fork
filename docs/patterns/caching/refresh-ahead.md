---
title: Refresh-Ahead
description: Proactively refreshes hot entries before they expire
area: caching
owner: Oleksandr Derechei
tags: [caching, latency, read-optimization]
status: stable
aliases: [refresh-ahead cache, proactive cache refresh]
solves: [my latency graph has a sawtooth spike exactly on the expiry boundary every few minutes, one unlucky user every five minutes pays a two second query while everyone else gets an instant response, "the moment the homepage entry expires, a thousand requests hit the database at the same instant", I would rather hand back a slightly old value than make anyone wait for the reload, the source is fine with a steady trickle of queries but falls over when they all arrive together]
---

# Refresh-Ahead

Before a hot key's time to live (TTL) runs out, a background reload fetches its value from the source and swaps it in — so the entry never actually goes stale under load, and no reader ever pays for the refresh.

## What it is
<!--meta block=description-->

Under a plain expiry time, the busiest keys expire under load, and every reader arriving during the reload misses together and queries the database. Refresh-ahead reloads a hot entry in the background shortly before it expires. Readers keep getting the old value until the new one lands, so none of them waits on a reload.

## Explained
<!--meta block=explain-->

Refresh-ahead watches the remaining lifetime of an entry and, once it drops below a threshold, reloads the value from the source in the background, then swaps it in with a new lifetime. Without it, a busy key expires under load and the next reader waits for the database while every reader arriving meanwhile misses too (a stampede). Choose it over plain expiry (a TTL, a fixed lifetime per entry) with load-on-miss when a few keys are read constantly and expiry itself is what hurts. It is an add-on to a [read-through](read-through.md) or [cache-aside](cache-aside.md) layer, using the same load path, started by a read that finds the entry near expiry (or by a timer) instead of a miss. Skip it when traffic per key is thin, because each early reload then fetches data nobody reads.

- **Reloads burst together.** Keys loaded at the same moment expire together, so give each key a random reload point.
- **Needs a notion of hot keys.** Count reads and refresh only keys above a limit, or you reload data nobody asks for.
- **Failed reloads hide.** A reload that keeps failing leaves old data that looks fresh, so alert on failures and value age.

**Example.** One key is read 500 times a second, has a 60 s lifetime and takes 200 ms to load. With plain expiry, 500 x 0.2 = 100 readers miss at the moment it expires and send 100 queries. With a reload once 20% of the lifetime remains (at 48 s), the first read after that starts 1 reload, and readers keep getting the old value for those 200 ms: 1 query, no waiting. The cost shows when 2,000 keys were loaded in the same second, as after a deploy. They all cross the line together, so a random point between 10% and 20% remaining spreads the 2,000 reloads over 6 s, about 330 a second.

## How it works
<!--meta block=structure-->

```mermaid caption="Why does a hot key never make a reader wait? Step 2 answers from the value that is still there, before step 4 has even started — and if that reload fails, the old entry keeps serving until its TTL genuinely runs out."
flowchart LR
    App["Reader"]
    subgraph Win["Refresh window — the last fifth of the TTL"]
        Entry[("Cache entry, TTL running down")]
        Ref["Background refresher"]
    end
    Src[("Source of record")]:::ext
    App -->|"1 get(key)"| Entry
    Entry -->|"2 old value, served immediately"| App
    Entry -->|"3 inside the window, so trigger"| Ref
    Ref -->|"4 reload(key), off the request path"| Src
    Src -->|"5 fresh value"| Ref
    Ref -->|"6 swap in, TTL reset"| Entry
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What happens on a read as a hot key nears expiry: return untouched, trigger a background reload, and what if that reload fails?"
sequenceDiagram
    autonumber
    participant App
    participant Cache
    participant Source
    App->>Cache: get(key)
    alt TTL above threshold
        Cache-->>App: cached value, untouched
    else TTL below threshold
        Cache-->>App: cached value, still fresh
        Cache->>Source: reload(key), in background
        alt reload succeeds
            Source-->>Cache: fresh value, entry swapped
        else reload fails
            Source--xCache: error, keep old entry until it expires
        end
    end
```

## Variations
<!--meta block=variations-->

- **Layered on [Read-Through](./read-through.md)** — The common form: reuse a read-through cache's existing load path, but trigger it from a background check instead of waiting for a miss to happen.
- **Threshold-triggered refresh** — A read that lands once remaining TTL falls below a percentage of the original — say 10-20% — kicks off an async reload; the read itself is never blocked by it.
- **Scheduled background refresh** — A per-key or per-shard timer reloads on a fixed cadence, independent of traffic, so a quiet key stays fresh; it needs an idle cutoff, or cold keys reload forever.
- **Hot-key gating** — Refresh only keys whose access frequency crosses a threshold; refreshing every entry blanket-style wastes load on data nobody's reading anymore.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Busy keys stay warm under load** — as long as each reload finishes before the old value expires; readers never wait on it.
- **Prevents the [hot-key](../../hazards/hot-key.md) stampede** — provided the key is read inside the refresh window and reloads succeed; cold-start misses still stampede.
- **Reload latency happens off the request path**, so a slow source never shows up as user-facing latency.
- **Falls back to a plain TTL for free** — a key that cools off just expires normally, no extra teardown needed.

### Cons
<!--meta polarity=con-->

- **Proactive reloads do real work, sometimes wasted** — a key refreshed once and never read again costs a load for nothing.
- **Needs bookkeeping a plain cache doesn't have:** which keys are hot, and how much TTL each has left.
- **A reload that keeps failing** can leave the cache serving old data that looks perfectly fresh, unless failures are surfaced.
- **Threshold and hotness cutoffs are tuning knobs**, not defaults that suit every workload.
- **Single-flight is per process** — with N app instances, each reloads the same hot key once, so source load grows N times unless one shared refresher or a lock holds it to one.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A known set of keys** is read constantly enough that an expiry-triggered miss would be visible latency or a stampede risk.
- **The source absorbs a steady** trickle of proactive reloads more easily than a burst of simultaneous misses at expiry.
- **You can identify "hot" cheaply** enough to gate refreshes to the keys that are actually worth it.

### Avoid when
<!--meta polarity=avoid-->

- **Traffic per key is sparse or unpredictable** — most proactive reloads would refresh data no one is about to read; plain [Read-Through](./read-through.md) is enough.
- **Data changes rarely** and the existing TTL is already generous relative to load on the source.
- **A brief staleness window during the reload** is unacceptable — the old value keeps serving until the new one lands.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal refresh-ahead cache"
interface Entry<V> { value: V; ttlMs: number; expiresAt: number; }

class RefreshAheadCache<K, V> {
  private store = new Map<K, Entry<V>>();
  private inFlight = new Set<K>();
  constructor(
    private readonly load: (key: K) => Promise<V>,
    private readonly ttlMs = 60_000,
    private readonly refreshBelow = 0.2, // reload once at most 20% of TTL remains
  ) {}
  async get(key: K): Promise<V> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return this.populate(key); // cold or expired: block, never serve past TTL
    const left = entry.expiresAt - Date.now();
    if (left < entry.ttlMs * this.refreshBelow * (0.5 + Math.random() / 2)) this.refresh(key); // jitter: reload at 10-20% remaining, fire-and-forget
    return entry.value;                           // always served from cache
  }
  private async populate(key: K): Promise<V> {
    const value = await this.load(key);
    this.store.set(key, { value, ttlMs: this.ttlMs, expiresAt: Date.now() + this.ttlMs });
    return value;
  }
  private refresh(key: K): void {
    if (this.inFlight.has(key)) return;            // single-flight, no dupes
    this.inFlight.add(key);
    this.populate(key).catch(err => console.error("refresh failed", key, err)).finally(() => this.inFlight.delete(key)); // surface failures; the old entry keeps serving until expiresAt
  }
}
```

## In the wild
<!--meta block=wild-->

- **Caffeine refreshAfterWrite** — Once an entry passes the configured refresh duration, the next access schedules an asynchronous reload while the previous value keeps serving; only that first requester triggers it, and a failed reload retains the old value. {#wild-caffeine-refresh}
- **Oracle Coherence refresh-ahead** — A refresh-ahead-factor between 0 and 1 sets how far before expiry an accessed entry is asynchronously reloaded from the CacheStore — the configuration the pattern is named after. {#wild-coherence-refresh-ahead}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Refresh threshold** — The remaining-TTL fraction (or absolute lead time) at which an accessed entry triggers a background reload; Caffeine's refreshAfterWrite and Coherence's refresh-ahead-factor set this.
- **Base TTL / expiry** — The full lifetime that refresh-ahead only preempts; a key that stops being read still expires normally once its TTL runs out.
- **Hot-key gate** — The access-frequency cutoff that decides which keys earn a proactive reload; refreshing every key blanket-style wastes load on data nobody is reading.
- **Refresh single-flight** — Whether a key already refreshing suppresses a second trigger, so one hot key can't launch several overlapping reloads.

### Signals to watch
<!--meta polarity=signal-->

- **Proactive refresh rate** — Background reloads per second; if it dwarfs actual reads, the hot-key gate is too loose and load is being wasted.
- **Refresh failure rate** — Background reloads that error; these are dangerous because a failed refresh can leave a stale value serving as if fresh.
- **Served-value age** — How old the currently-served value is relative to its TTL; a rising age despite refreshes hints they are failing or lagging.
- **Residual miss rate on hot keys** — Misses that still reach the blocking load path for keys meant to be hot; a nonzero rate means the threshold is too tight to preempt expiry.

### Failure modes under load
<!--meta polarity=failure-->

- **Silent staleness on repeated refresh failure** — A reload that keeps failing leaves the old value serving with the look of freshness; unless refresh errors are surfaced it goes unnoticed.
- **Wasted reloads on cooling keys** — A key refreshed once and never read again costs a load; a loose hot-key gate multiplies this across the keyspace.
- **Refresh storm on the source** — If many hot keys cross the threshold together — say all written at the same instant — their background reloads can burst the source, the very stampede refresh-ahead was meant to avoid.
- **Overlapping reloads for one key** — Without single-flight, a hot key read repeatedly inside the threshold window can launch several concurrent reloads, multiplying source load.

### Readiness checklist
<!--meta polarity=check-->

- Refreshes are gated to genuinely hot keys, not applied blanket across the keyspace
- A refresh already in flight for a key suppresses duplicate reloads (single-flight)
- Refresh failures are surfaced so a stale value can't serve indefinitely looking fresh
- The base TTL still expires cooled-off keys so hot-key bookkeeping doesn't grow unbounded
- Refresh triggers are jittered so many hot keys don't reload the source in the same instant

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Caching](../../themes/caching.md) — Reload hot keys before they expire {#fluency-caching}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Read-Through](./read-through.md) — Refresh hot keys before they expire
- [Cache-Aside](./cache-aside.md) — Cache-aside reloads on a miss, and refresh-ahead reloads hot keys before they expire so readers skip the miss

**Alternative to**

- [Request Coalescing](../distributed/resilience/request-coalescing.md) — Guard the gap when it opens, rather than refreshing early to avoid it

**Prevents**

- [Cache Stampede](../../hazards/cache-stampede.md) — Reload the hot key before its time to live (TTL) expires, so it never goes cold under load
- [Stale Cache](../../hazards/stale-cache.md) — Background refresh keeps the entry close to the source, bounding the stale window

**Demonstrated by**

- [Top-K](../../designs/top-k.md) — the leaderboard stays permanently warm by proactively refreshing on a cadence ahead of time to live (TTL) expiry, avoiding cold-miss stampedes

<!-- relationships:end -->
