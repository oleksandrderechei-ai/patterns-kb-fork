---
title: Stale Cache
description: "Reads hit the cache while writes hit the store, so the cache serves old data"
area: hazards
owner: Oleksandr Derechei
tags: [caching, data-access]
status: stable
aliases: [cache inconsistency, stale read]
solves: [users see old data after an update until the entry expires, we write to the database but reads keep serving the previous value, a price change took ten minutes to show up on the site, the cached copy and the source of truth disagree]
---

# Stale Cache

Because most systems read from the cache but write to the store, every write opens a window in which the cache still holds — and keeps serving — the value the source of truth has already moved past.

## What it is
<!--meta block=description-->

A stale cache is a cached copy that no longer matches the source of truth while reads keep being served from it. Systems read from the cache but write to the store, so every write leaves the copy wrong until it is invalidated or expires. Nothing raises an error, so monitors stay green and the first signal is a user insisting they already changed something.

## Explained
<!--meta block=explain-->

A stale cache is a cache holding a copy that no longer matches the source, while reads keep being served from the copy. Writes go to the store and reads come from the cache, so a write leaves the cached copy wrong until something deletes it or it expires. No error is raised and no alarm fires, so the first signal is a user insisting they already changed something. This is a trade you bought, not a defect: serving the truth on every read is too expensive, so ask how wrong each kind of data may be. A feed can lag minutes, a price or a permission cannot. Write that budget down per kind of data, because one global expiry treats them all alike. Delete the cached key in the same code path that writes to the store, as [cache-aside](../patterns/caching/cache-aside.md) does, so the next read reloads the current value. Keep a short expiry as a backstop for a missed delete and for a reader who re-cached the old value just before the write.

- **Hit rate.** Each tightening of expiry lowers hit rate and raises source load, so tighten only where staleness does harm.
- **Reload after write.** The first read after every write misses and pays the full fetch.

**Example.** A product price falls from 20 to 15 at 12:00. The page is read 100 times a second and cached for 10 minutes, so about 60,000 reads show 20 until 12:10 while checkout charges 15. Deleting the key on every price write cuts that to the reads that land before the write is seen. A 60 s expiry caps the damage from a missed delete or a reader who re-cached the old value at 6,000 reads, at the cost of 10 times as many reloads from expiry alone.

## How it happens
<!--meta block=causes-->

```mermaid caption="The staleness window is the gap between a write to the store and the cached copy being invalidated or aging out."
flowchart TB
    A["Write updates the source of truth"] -->|"cache key left untouched"| B["Cache still holds the previous value"]
    B -->|"read path checks cache first"| C["Reads keep hitting the cache"]
    C -->|"until invalidation or TTL expiry"| D["Old value served — the staleness window"]
```

- Read-cache, write-store asymmetry: reads and writes take different paths, so a write never touches the cached copy unless something explicitly invalidates it.
- No invalidation on write: the store is updated but the cache key is left in place, so it keeps serving the old value until its TTL (time to live) runs out.
- Long TTLs chosen for hit rate: the longer an entry is allowed to live, the wider the window in which it can be wrong.
- Multiple cache layers or replicas: a client cache, a CDN (content delivery network), and a [shared cache](../patterns/caching/distributed-cache.md) each hold their own copy, and they expire on their own schedules.

## What it costs
<!--meta block=cost-->

- **Users see the wrong thing, confidently.** A stale read looks exactly like a fresh one — there's no error, so a user acts on data that's already changed underneath them.
- **The impact scales with how much staleness hurts.** A slightly old profile photo is harmless; a stale price, permission, or account balance can be a correctness or safety problem.
- **It's inconsistent across readers.** One user hits a freshly-invalidated key and sees the new value while another still hits a cached copy and sees the old one, which is confusing and hard to reproduce.
- **Tightening it isn't free.** Cutting the window means invalidating aggressively or shortening TTLs, both of which trade away the hit rate the cache was there to provide.

## How to avoid it
<!--meta block=mitigation-->

There's no perfect fix — how much staleness is acceptable is a per-datum judgment. The strongest option is to **invalidate on write**: when the store changes, delete (or update) the cached key in the same path, so the next read misses and reloads the current value. Where a bounded lag is fine, a **short TTL** caps how long any entry can be wrong. And in many cases the honest answer is to **accept [eventual consistency](../themes/consistency-and-replication.md)** — decide the stale window is harmless for this data (a feed, a metric, a profile image) and document it — rather than pay for a guarantee the use case doesn't need. Writing through the cache synchronously removes the window entirely at the cost of write latency. Dropping the cache instead is [no caching](./no-caching.md): every read hits the source again.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Mitigated by**

- [Write-Through](../patterns/caching/write-through.md) — Write the cache and store together, so a read after a write can't be stale
- [Refresh-Ahead](../patterns/caching/refresh-ahead.md) — Background refresh keeps the entry close to the source, bounding the stale window
- [Cache-Aside](../patterns/caching/cache-aside.md) — Delete the key on write so the next read reloads; a late refill can still re-cache the old value until the TTL ends

**Threatens**

- [CDN](../patterns/distributed/routing/cdn.md) — Edge copies outlive the origin's change until expiry or purge
- [Client-Side Cache](../patterns/caching/client-side-cache.md) — Copies on devices cannot be invalidated centrally
- [Read-Through](../patterns/caching/read-through.md) — A cached entry has no knowledge of writes made elsewhere
- [Distributed Cache](../patterns/caching/distributed-cache.md) — Every instance reads the same stale entry, so the error is fleet-wide

<!-- relationships:end -->
