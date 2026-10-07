---
title: No Caching
description: The same unchanged data is fetched from scratch on every request
area: hazards
owner: Oleksandr Derechei
tags: [performance, latency, throughput]
status: stable
aliases: [cacheless read path]
solves: [the same query runs a quarter of a million times an hour, the database is busy answering a question that has not changed all day, load on the store grows with visitors instead of with edits, we are billed per call to a service that returns the same answer every time, throughput plateaus at the database while the app servers idle]
---

# No Caching

Every request pays the full price of an answer that has not changed since the last request asked for it — the same row read, the same remote call made, the same result computed, thousands of times over. Nothing is wrong with any single request; the waste is only visible in the aggregate.

## What it is
<!--meta block=description-->

No caching is a system that recomputes or re-fetches the same unchanged answer for every request that asks. Each call is correct, and each is work already done. You recognise it when reads far outnumber writes yet the source is hit on every read: one query dominates the statistics, and the dependency's traffic tracks your request rate, not how often the data changes. Light traffic often hides it, so it usually surfaces under concurrency or when a metered bill arrives.

## Explained
<!--meta block=explain-->

No caching means the system recomputes or re-fetches the same unchanged answer for every request that asks for it. Load on the database or remote service then tracks how many people ask, not how often the answer changes, so a growing audience becomes growth in the one resource that is hardest to add. Every reader also pays the full round trip. It stays invisible at low traffic, because a direct read is one line and always correct. Choose a cache for answers that are read far more often than they change and whose readers can live with being slightly behind. The usual start is [cache-aside](../patterns/caching/cache-aside.md): look in the cache, and on a miss fetch from the source and store the value for the next reader. A cache that is down must not take the read path with it, so fall back to the source, but cap how much traffic falls through.

- **Staleness.** The copy can lag the source, so set expiry from what readers tolerate, or invalidate on change and keep expiry as the backstop.
- **Expiry stampede.** A popular entry expiring sends everyone to the source at once; use a per-key lock so one reloads, or refresh before expiry.

**Example.** A shipping-rates query takes 5 ms and runs on every page view, 800 times a second. The database allows 1,000 queries a second, so this one table uses 80% of it, and the answer changes about 10 times a day. You add a 60 s copy in each of 20 app servers, so 20 queries a minute replace 48,000. The cost is that a rate change can take up to 60 s to show. At expiry, up to 20 servers can reload together, so allow one reload per server. Expect a hit rate near 99.9% (20 loads against 48,000 reads a minute); a far lower value means the key or the expiry is wrong.

## How it happens
<!--meta block=causes-->

- **Not caching is simpler, and works.** A direct read is one line, always correct, and adequate at the load the system had when it was written. A cache adds a second copy of the truth and a question about how long it may lag — real complexity, in exchange for a benefit nobody is feeling yet.
- **Correctness anxiety wins the argument.** The fear of serving something out of date is concrete and easy to picture, while the cost of not caching is diffuse and shows up as a bill or a saturation curve. So the safe-sounding choice is made without pricing the alternative.
- **The environment changed underneath the design.** Code carried over from a setting where the data was local and the hardware was generous keeps assuming a cheap read after the store has moved across a network and behind a quota.
- **The available caching layer goes unnoticed.** Caching is thought of as a server the team must run, so the ones that need no server — validators and freshness headers on an HTTP response, an edge tier already in the path, the process's own memory — are never considered.
- **Nobody knows the read-to-write ratio.** Without instrumentation that says which answers are requested repeatedly and how rarely they change, the case for a cache cannot be made with a number, so it is made with an opinion and loses.

## What it costs
<!--meta block=cost-->

- **Every reader pays the slowest path.** Response time includes the full round-trip to the source on every single request, so the floor under your latency is the source's latency — no matter how often the answer was identical.
- **The source scales with traffic instead of with change.** Load on the store or the dependency is a function of how many people ask, not of how often the answer moves, so growth in readers turns directly into growth in a resource that is usually the hardest one to add.
- **Contention arrives before capacity does.** Repeated reads occupy connections, locks and buffer space that concurrent writes need, so the write path slows down because of read volume it has nothing to do with.
- **Metered and quota-bound dependencies punish it directly.** Where a downstream service charges per call or throttles past a rate, uncached repetition converts into money and into rejections that look like the dependency failing.
- **The ceiling is lower than the hardware suggests.** Throughput plateaus at the source's limit while the tier in front still has spare capacity, so scaling that tier buys little until the source gives.

## Getting out
<!--meta block=mitigation-->

Start with what the data does rather than with a cache product. Answers that are read far more often than they change, and whose readers can live with being a little behind, are the candidates; everything else is not. The usual first move is **[Cache-Aside](../patterns/caching/cache-aside.md)** — look in the cache, and on a miss fetch from the source and put the value there for the next reader — which keeps the source of truth exactly where it was and leaves the read path obviously correct on a cold start. Where you would rather the caller not see the miss at all, **[Read-Through](../patterns/caching/read-through.md)** moves that fetch behind the cache's own interface, at the cost of a component that now needs to know how to load.

Then decide where the copy lives, because that choice sets both the saving and the exposure. Keeping it in the process is the fastest possible hit and gives every instance its own copy to keep consistent; a shared cache tier trades a network hop for one answer the whole fleet agrees on; a **[content delivery network (CDN)](../patterns/distributed/routing/cdn.md)** or a **[Client-Side Cache](../patterns/caching/client-side-cache.md)** stops the request before it reaches you at all, which is the largest saving available for answers that are the same for every reader and the hardest to invalidate once it is out there. Caching partially is legitimate: hold the static bulk of an object and fetch only the field that moves.

Adding a cache installs new failure modes, so adopt their counters at the same time. A second copy of the truth can be wrong — that is [Stale Cache](./stale-cache.md), and it is bounded by an expiry chosen from what the reader tolerates, not from what feels safe. Ask the data owner for the longest lag they accept, or measure how often each key is written and set the expiry to a fraction of that interval. A popular entry expiring under load sends every reader to the source at once — that is a [Cache Stampede](./cache-stampede.md), countered by collapsing the concurrent misses into one load or refreshing before expiry. And an unreachable cache must degrade to the source rather than to an error, with a limit on how much of that traffic is allowed through, since a cold cache in front of a busy source is the outage the cache existed to prevent. Size that limit from the source's spare capacity (its capacity minus its steady load) and enforce it by capping concurrent loads.

Instrument the thing before and after. Hit rate, and the ratio of reads to writes per key, are what tell you whether an entry earns its place and what its expiry should be; without them, expiries get tuned by anecdote and the cache slowly becomes a second database nobody trusts. Expect the bottleneck to move rather than disappear — relieving the store commonly reveals that the tier in front of it was never sized for the throughput it can now sustain. Scale that tier next. Cache a not-found answer briefly, so keys that do not exist stop reaching the source on every read.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Mitigated by**

- [Cache-Aside](../patterns/caching/cache-aside.md) — Check the cache first and fill it on a miss, leaving the source of truth exactly where it was
- [Read-Through](../patterns/caching/read-through.md) — Put the load behind the cache so the read path never sees the miss
- [Client-Side Cache](../patterns/caching/client-side-cache.md) — The cheapest hit is the request never sent, when the answer can live on the device that asked
- [CDN](../patterns/distributed/routing/cdn.md) — Serve the repeated read from the edge, so popularity stops translating into origin load
- [Distributed Cache](../patterns/caching/distributed-cache.md) — A shared tier trades a network hop for one answer the whole fleet agrees on
- [In-Process Cache](../patterns/caching/in-process-cache.md) — The fastest placement, with a separate copy in every instance

<!-- relationships:end -->
