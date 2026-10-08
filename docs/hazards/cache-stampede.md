---
title: Cache Stampede
description: A popular key expires and a herd of misses hits the source at once
area: hazards
owner: Oleksandr Derechei
tags: [caching, latency, throughput]
status: stable
aliases: [dogpile, single-flight]
solves: [one popular entry expires and hundreds of identical queries hit the database at once, traffic is flat but the database sees a burst of duplicate reads on a regular clock, many requests rebuild the same expensive value in parallel, database load spikes every few minutes matching our expiry time]
favourite: true
---

# Cache Stampede

A single hot cache entry expires, and the flood of concurrent requests that all miss at the same instant stampede straight through to the source of truth — turning one query into thousands and overwhelming the very database the cache was there to protect.

## What it is
<!--meta block=description-->

A cache stampede, or dogpile, happens when one heavily read cache entry expires and every request that wanted it misses at once, so all fall through to the source and rebuild the same value in parallel. You recognize it by a source that idles behind a cache with a 99% hit rate, then spikes when a hot key's time to live runs out. The cache did what it was told; the failure is the brief absence of a hot entry.

## Explained
<!--meta block=explain-->

A cache stampede is a crowd of identical requests that all hit the database at once because a popular cached value has just expired. The cache served the key at a 99% hit rate, so the database was sized for a trickle, and then the entry's time to live ran out and every request for that key missed together. It gets worse by itself: the slower the database gets, the longer the entry stays missing and the more requests pile on. Fixed expiry times on busy keys, and many keys sharing one expiry after a restart or flush, make it recur on a clock. Choose protection built into the cache layer over asking each caller to behave. Let only the first miss rebuild the value while the rest wait for its result ([request coalescing](../patterns/distributed/resilience/request-coalescing.md)). Serve the old value while that rebuild runs, reload hot keys shortly before they expire, and add a random few seconds to each expiry.

- **Stale reads.** Serving the old value during a rebuild shows slightly stale data, so bound it to a few seconds.
- **Lock risk.** A crashed rebuilder can block the key forever, so cap the lock near the rebuild time and let the next miss take over.

**Example.** A product page key is read 2,000 times a second and rebuilt by a 3 s query. The database handles about 50 such queries a second, so 150 in 3 s. When the 60 s expiry hits, every read in the next 3 s misses and starts a query: 2,000 times 3 is 6,000 identical queries, 40 times capacity, and unrelated pages slow down too. With one rebuilder for the whole fleet, 1 query runs and the other readers wait for it. With the old value served as well, they get the 60-second-old value at once. Price changes can show up 3 s late.

## How it happens
<!--meta block=causes-->

```mermaid caption="The herd is created by the gap between one entry expiring and any single request refilling it — every request that arrives in that gap misses."
flowchart TB
    A["Hot key cached with a fixed TTL"] -->|"TTL elapses, entry evicted"| B["Key goes cold"]
    B -->|"gap before any refill"| C["N concurrent requests all miss"]
    C -->|"no coordination between callers"| D["Every miss queries the source"]
    D -->|"duplicates not suppressed"| E["One query becomes thousands at once"]
    E -->|"source overloaded"| F["Latency climbs for everyone"]
```

- A fixed TTL on a popular key: the busier the key, the more requests land in the refill gap the instant it expires.
- [Cache-aside](../patterns/caching/cache-aside.md) reads with no coordination — each caller that misses independently loads and repopulates, so nothing suppresses the duplicates.
- Synchronized expiry: many keys sharing the same TTL, so a crowd of entries goes cold together.
- A source expensive enough that rebuilding one value is slow, widening the window in which still more requests pile up behind the first.
- A cache flushed or restarted at once, so every entry is cold together (a cold-cache stampede after a deploy or scale-up).

## What it costs
<!--meta block=cost-->

- **The source takes the full unshielded load.** The database is sized for the post-cache trickle, but a stampede hands it the hot key's full read rate, with no warning.
- **The work is almost entirely wasted.** Thousands of requests compute the identical value at the same time; all but one of those computations is redundant.
- **It cascades.** A saturated source slows every query routed through it, not just the [hot key](./hot-key.md)'s — so an expiry on one entry degrades unrelated traffic and can tip into a broader outage.
- **It recurs on a clock.** Left unaddressed, the stampede repeats every time that key's TTL elapses, making it a predictable, self-inflicted load spike rather than a one-off.

## How to avoid it
<!--meta block=mitigation-->

Three moves defuse it. **[Request coalescing](../patterns/distributed/resilience/request-coalescing.md)** (single-flight): when several requests miss the same key, let only the first rebuild the value while the rest wait for its result, which collapses the herd into one source query. Inside one process that still leaves one query per app instance, so use a shared lock or lease, capped near the rebuild time, to get one per key. **Proactive refresh** (cache warming): reload a hot key in the background shortly before its TTL runs out, so the entry is rarely absent under load, provided the refresh succeeds. It cannot help a cold cache after a flush or deploy, so warm the hot keys first. Serving the old value during the rebuild, bounded to seconds, covers the gap. A short jitter added to TTLs desynchronizes many keys that would expire together; it does nothing for one hot key's single expiry. Watch for source query rate spiking at TTL boundaries and for several in-flight loads of one key.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Thundering Herd](./thundering-herd.md) — The general form: any crowd released at once, not only cache missers
- [Hot Key](./hot-key.md) — A stampede is a hot entry vanishing and every reader rebuilding it; a hot key is that entry overloading its node
- [Metastable Failure](./metastable-failure.md) — A stampede that saturates the source can keep the cache from refilling, so the overload outlives its trigger

**Mitigated by**

- [Refresh-Ahead](../patterns/caching/refresh-ahead.md) — Reload the hot key before its time to live (TTL) expires, so it never goes cold under load
- [Read-Through](../patterns/caching/read-through.md) — One load path per key lets the cache coalesce concurrent misses into a single fetch
- [Request Coalescing](../patterns/distributed/resilience/request-coalescing.md) — Bound the recomputation to a single in-flight call, so only one miss reaches the source

**Threatens**

- [Cache-Aside](../patterns/caching/cache-aside.md) — A miss makes each caller rebuild the value, so concurrent misses on a hot key all hit the source
- [Bitly](../designs/bitly.md) — A design where one expiry puts every edge miss on a single row.
- [Google News](../designs/google-news.md) — A design whose TTL baseline expires a hot region's feed at once; CDC precompute removes the expiry.
- [Gopuff](../designs/gopuff.md) — A design whose ramp-written availability entries share a 60 s TTL and expire together.

<!-- relationships:end -->
