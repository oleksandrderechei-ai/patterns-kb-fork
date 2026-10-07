---
title: Distributed Cache
description: "A shared cache in its own tier, so every app instance sees the same entries"
area: caching
owner: Oleksandr Derechei
tags: [caching, read-optimization, latency]
status: stable
aliases: [external cache, remote cache, shared cache]
solves: [each of my app servers has its own cache and they keep disagreeing, my cache gets wiped every time a server restarts or deploys, I need more cache than fits in one process's memory, every instance I add spends its first minutes warming up its own copy of the same data, I cannot grow the memory available for hot data without also adding application servers]
---

# Distributed Cache

A caching service that runs as its own tier — Redis, Memcached — separate from the application and the database, so every application instance reads and writes the same entries over the network instead of each keeping its own private copy.

## What it is
<!--meta block=description-->

Many application instances that each keep their own cache waste memory on duplicate copies and disagree about the same key. A distributed cache is one separate service, such as Redis or Memcached, that every instance reads before the database. Once any instance fills a key, all the others get a hit, and the cache survives deploys and restarts.

## Explained
<!--meta block=explain-->

A distributed cache is one shared cache tier, such as Redis or Memcached, between the application and the database. Every copy of the application asks the shared tier first over the network, and only a miss falls through to the database, whose value is then written back. Its capacity and lifetime no longer depend on any one process, so it is the usual choice when several copies must agree or the data is too big for one process. Keep data local instead when one copy serves the traffic or the data is tiny.

- **Network cost on every hit.** Each hit pays a round trip plus byte conversion, so keep the few dominant keys in a small local cache.
- **Hot key overloads one node.** One popular key lives on a single node while the rest idle, so cache that key locally too.
- **Every read depends on it.** Give each caller a timeout and a fallback to the database.

**Example.** You run 10 copies of an app and 1,000 hot product keys. With a cache inside each copy, warming takes 10 x 1,000 = 10,000 database loads, and a deploy that replaces every copy repeats them. With a shared cache it takes 1,000 loads, and a deploy takes none. One key draws 20,000 reads a second, but the node holding it handles 15,000, so that node overloads while the others idle. A local copy kept for 1 s inside each of the 10 app copies, each refetching once a second, cuts that key to at most 10 shared reads a second, and the price is a value up to 1 s old.

## How it works
<!--meta block=structure-->

```mermaid caption="Which instance pays for the fill? Only the first one — instance 1 misses at step 1 and populates at step 3, and every instance after it gets that entry back for one network hop instead of a database query."
flowchart LR
    A1["App instance 1"]
    A2["App instance 2"]
    A3["App instance 3"]
    subgraph Tier["Shared cache tier — one network hop from every instance"]
        C[("Cache node holding user:42")]
    end
    DB[("Database")]:::ext
    A1 -->|"1 get(user:42), miss"| C
    A1 -->|"2 load from the source"| DB
    A1 -->|"3 set(user:42) with a TTL"| C
    A2 -->|"4 get(user:42), hit"| C
    A3 -->|"5 same entry, same value"| C
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Single node vs. clustered** — One cache node is simplest; past its capacity or throughput, the cache is sharded across a cluster and clients pick the owning node — commonly by [consistent hashing](../distributed/routing/consistent-hashing.md) so a node change reshuffles the fewest keys.
- **[Replicated](../distributed/coordination/replication.md) for availability** — Each shard keeps replicas so a node failure doesn't cold-start that slice of the cache; when clients may read from replicas, reads of a [hot key](../../hazards/hot-key.md) also spread across copies, at the cost of replica lag.
- **[Near cache](./in-process-cache.md) (L1 + L2)** — A small in-process cache sits in front of the distributed cache: the local copy answers the hottest reads, and the shared tier backs everything else — trading a little cross-instance staleness for fewer network hops.
- **Strategy on top** — The distributed cache is just the store; how reads and writes flow through it is a separate choice — [cache-aside](./cache-aside.md) (app-managed) is the default, [read-through](./read-through.md) / [write-through](./write-through.md) move that logic into the cache layer.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One shared view**: every instance sees the same entries, with no duplicate copies in memory.
- **Outlives the app**: the cache survives instance restarts and deploys, so a rollout does not cold-start it; a restart of a cache node itself does (see production-failure-4).
- **Scales independently**: cache capacity and throughput grow by scaling the cache tier, not the app.
- **Holds far more than one process's heap**, and can be sized and tuned as its own component.

### Cons
<!--meta polarity=con-->

- **Every hit pays a network round trip** — slower than an in-process cache that has no hop at all.
- **It's another component to run, monitor, secure**, and keep available.
- **A single very popular key** still lands on one node, so it can hot-spot even though the cluster looks healthy.
- **Values must be serialized** and deserialized across the wire, adding CPU and latency per operation.
- **The tier is a remote** dependency on the read path, so every caller needs a route that still answers from the source of truth when the cache is slow or unreachable.
- **Stale entries** — a database write does not update the cache, so readers see the old value until the TTL ends or the key is deleted, and a delete racing a fill can restore it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple application instances** need to share one consistent cache instead of each keeping its own.
- **The cache must outlive individual processes** — surviving restarts, deploys, and [autoscaling](../distributed/routing/autoscaling.md).
- **Working set too big for one process** — it is larger than any single process can comfortably hold in memory.
- **You want to scale cache** capacity or throughput independently of the application tier.

### Avoid when
<!--meta polarity=avoid-->

- **A single instance serves the traffic**, or the data is tiny and read on every request — an in-process cache is faster and simpler.
- **You need sub-millisecond reads** and can't afford the network hop.
- **The data is so cheap to recompute** that running a whole cache tier isn't worth the operational cost.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — cache-aside over a shared cache client, reachable by every instance"
// `cache` is a client to a shared tier (e.g. Redis) that every
// app instance connects to — so they all read and write one view.
// helpers assumed: a timeout wrapper and a TTL jitter
async function getUser(id: string): Promise<User> {
  const key = `user:${id}`;
  let hit: string | null = null;
  try {
    hit = await withTimeout(cache.get(key));   // network hop; slow or down counts as a miss
  } catch { /* fall through to the source of truth */ }
  if (hit !== null) return JSON.parse(hit);

  const user = await db.users.findById(id);    // miss → source of truth
  try {
    await withTimeout(cache.set(key, JSON.stringify(user), { ttlSeconds: withJitter(300) })); // jitter spreads expiry
  } catch { /* the read still succeeds */ }
  return user;
}

```

## In the wild
<!--meta block=wild-->

- **Redis** — In-memory key-value store widely deployed as a shared application cache, with clustering and replication. {#wild-redis}
- **Memcached** — A classic multithreaded in-memory cache; clients shard keys across nodes. {#wild-memcached}
- **Hazelcast** — A distributed in-memory data grid used as a clustered cache across application nodes. {#wild-hazelcast}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Per-key time to live (TTL) & eviction policy** — How long entries live and what is dropped at capacity — least recently used (LRU) or least frequently used (LFU), e.g. the Redis maxmemory-policy allkeys-lru
- **Max memory per node** — The per-node memory ceiling at which eviction begins (e.g. Redis maxmemory)
- **Shard count & key routing** — How many nodes and how keys map to them — consistent hashing or a fixed slot map (Redis Cluster uses 16,384 hash slots)
- **Replication mode** — Async primary-to-replica, or Redis WAIT, which blocks until N replicas acknowledge: it narrows the loss window but does not remove it, and costs latency
- **Connection pool size** — Client connections held per node, so a burst does not exhaust the server connection budget

### Signals to watch
<!--meta polarity=signal-->

- **Hit rate** — Fraction of reads served from cache — the number that justifies the cache existing at all
- **Per-node request skew** — Requests per second per node; a spike concentrated on one node is a hot key forming
- **Memory used vs max & eviction rate** — How close each node is to its ceiling and how fast it evicts — rising evictions mean the working set no longer fits
- **p99 read latency** — Tail latency of a cache read; a cache slow at the tail is buying little

### Failure modes under load
<!--meta polarity=failure-->

- **Node loss under async replication** — A node dying before its writes replicate loses those entries, and the load lands on the origin
- **Hot key overloads one node** — A single popular key sends all of its traffic to one node unless replicas serve its reads
- **Stampede on synchronized expiry** — Many keys expiring at the same instant send a herd of misses to the origin at once
- **Cold cache after restart** — A restarted or newly added node serves nothing until it warms, so the origin absorbs the miss storm

### Readiness checklist
<!--meta polarity=check-->

- Set a max-memory ceiling and an eviction policy so a node degrades gracefully instead of running out of memory
- Route keys with consistent hashing or a managed slot map so adding a node reshuffles few keys
- Replicate each shard and enable automatic failover so losing a node does not drop a whole slice
- Mitigate hot keys with a local in-process cache, key replication, or request coalescing
- Add jitter to TTLs and coalesce concurrent misses to avoid a synchronized stampede on the origin
- Size connection pools so a traffic burst cannot exhaust a node connections

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Caching](../../themes/caching.md) — The default placement: a shared cache tier {#fluency-caching}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Cache-Aside](./cache-aside.md) — The app-managed read strategy that typically fronts a shared cache
- [Consistent Hashing](../distributed/routing/consistent-hashing.md) — Spread keys across cache nodes so a node change reshuffles the fewest
- [Prefer Managed Services](../../principles/managed-services.md) — A hosted cache removes the failover you would otherwise own

**Alternative to**

- [In-Process Cache](./in-process-cache.md) — Shared across instances, one network hop away

**Prevents**

- [No Caching](../../hazards/no-caching.md) — A shared cache tier lets every instance reuse one stored answer instead of re-fetching unchanged data

**Exposed to**

- [Hot Key](../../hazards/hot-key.md) — Can fall into hot key when one viral key lives on the single node of the shared tier that owns it
- [Stale Cache](../../hazards/stale-cache.md) — Can fall into stale cache when a database write leaves the shared entry in place, so every instance reads the same old value until expiry or invalidation

**Demonstrated by**

- [Distributed Cache](../../designs/design-distributed-cache.md) — it is the reference worked build of the pattern, from single-node hash table to sharded, replicated cluster
- [Distributed Rate Limiter](../../designs/distributed-rate-limiter.md) — a distributed in-memory store used as the authoritative, sub-millisecond, self-expiring state layer for the whole fleet
- [Facebook Live Comments](../../designs/fb-live-comments.md) — a cache shared across the fleet answers a catch-up read that the connection's original server no longer owns
- [Bitly](../../designs/bitly.md) — A stateless read tier needs its cache in its own tier, or each instance fills it separately
- [YouTube](../../designs/youtube.md) — Hot-video metadata is the uneven-catalogue case a shared cache tier absorbs
- [Facebook Post Search](../../designs/fb-post-search.md) — Because results are not personalised, identical queries share one cached answer within a short staleness budget
- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — Shared state in a cache is what lets N replicas open a breaker together instead of absorbing an outage one by one

**Implemented by**

- [Databases](../../capabilities/databases.md) — Available as a managed service on every cloud.
- [Key-value & cache stores](../../comparisons/key-value-stores.md) — Which cache store to run — Redis, Valkey, Memcached and Dragonfly, licenses included.

<!-- relationships:end -->
