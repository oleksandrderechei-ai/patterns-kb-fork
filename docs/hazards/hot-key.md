---
title: Hot Key
description: One key draws so much traffic it overloads the single node that owns it
area: hazards
owner: Oleksandr Derechei
tags: [caching, load-balancing, throughput]
status: stable
aliases: [celebrity problem, hot key]
solves: [one popular record takes millions of reads while every other key sees a handful, adding cache nodes does not help because the traffic all lands on one of them, a single celebrity account overloads the one node that owns it, load is spread evenly except for the one entry everybody wants]
---

# Hot Key

One cache key is so much more popular than the rest that the single node or shard holding it is swamped — even when the overall hit rate is excellent and the rest of the cluster sits nearly idle.

## What it is
<!--meta block=description-->

A **hot key** is one cache entry that draws far more reads than the rest, so the single node that owns it saturates while its neighbours idle. You recognise it when one node runs hot, latency rises for every key on that node, and adding nodes changes nothing. The defining trait is that it persists until you change how the key is read. A cache stampede is brief and ends when the value reloads.

## Explained
<!--meta block=explain-->

A hot key is one cache entry that gets far more reads than all the others, so the one cache node that owns it saturates while the rest sit idle. Caching works as intended, since every read is served from memory, but a sharded cache places each key on exactly one node by hashing, and hashing balances the number of keys, not the traffic. You meet it with a celebrity profile, a viral post, a global setting or a live scoreboard. Adding cache nodes does nothing, because the hot key still lives on one of them. It differs from a [cache stampede](cache-stampede.md), which is brief and ends when the value is reloaded, while a hot key stays until you change how it is read. The only lever is the read path. Copy the entry onto several nodes and spread reads across the copies. Keep a short-lived copy in each application process for the hottest values. Replication fits read-heavy keys but not one that everyone writes.

- **Staleness.** Every copy must be refreshed or expire, so set the expiry to the staleness you can tolerate.
- **Write fan-out.** Each edit must update every copy; keep the copy count small.

**Example.** A cache cluster has 10 nodes, each good for 100,000 reads a second. One celebrity profile gets 400,000 reads a second, so its owner node is 4 times over its limit while the other 9 nodes sit near idle. You copy the profile under 5 keys on 5 nodes, so each takes 80,000 reads a second. You also add a 2 s copy in each of 200 app servers, so the fleet reads the cache at most 100 times a second. A profile edit now takes up to 2 s to appear.

## How it happens
<!--meta block=causes-->

```mermaid caption="Sharding spreads keys evenly by count, not by traffic — so one very popular key overloads its owner no matter how many nodes exist."
flowchart TB
    A["Access is naturally skewed — a few keys dominate"] -->|"placement ignores popularity"| B["Keys are spread across nodes by hashing"]
    B -->|"one key maps to one owner"| C["The hot key hashes to exactly one node"]
    C -->|"load is never replicated"| D["All of its traffic lands on that single node"]
    D -->|"more nodes don't dilute it"| E["That node saturates while its peers sit idle"]
```

- Naturally skewed popularity: real-world access follows a power law — a celebrity, a viral post, a trending product — where a handful of keys dwarf the rest.
- Key-to-node placement by hashing: a consistent-hashing ring or a sharded cache assigns each key to one owner, and popularity isn't part of that assignment.
- Scaling out doesn't dilute it: adding cache nodes rebalances the key count, but the hot key still lives on exactly one of them, so its load doesn't spread.
- A single logical entity that everyone needs at once — a global config, a live scoreboard, the pinned announcement — read on nearly every request.

## What it costs
<!--meta block=cost-->

- **One node becomes the bottleneck.** The node owning the hot key saturates its CPU or network while the rest of the cluster is nearly idle — capacity that can't be brought to bear on the problem.
- **The blast radius is wider than the key.** A saturated node also serves every other key that hashes to it, so unrelated data behind the same node gets slow or unavailable too.
- **It hides behind good averages.** Cluster-wide hit rate and average latency look healthy; the damage is a tail concentrated on one shard, easy to miss until that shard tips over.
- **Caching alone can't scale past it.** The usual read-scaling move — add cache nodes — does nothing here, so the hot key quietly caps the throughput of an otherwise horizontally-scalable design.

## How to avoid it
<!--meta block=mitigation-->

The fix is to stop routing all of the hot key's traffic to one place. **Replicate the hot entry** across several cache nodes and spread reads over the copies, so the load is shared instead of concentrated. And keep an **in-process local cache** in front of the [shared cache](../patterns/caching/distributed-cache.md) for the very hottest values, so repeated reads are answered from the application's own memory and never leave it. Note that [consistent hashing](../patterns/distributed/routing/consistent-hashing.md), which keeps hit rates high across a changing pool, does not help here — it still sends every request for one key to the same node; spreading the key itself is the move.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Hot Partition](./hot-partition.md) — The storage-tier cousin: a whole shard saturates, not one entry

**Mitigated by**

- [Replication](../patterns/distributed/coordination/replication.md) — Copy the hot entry onto several nodes and spread reads across them
- [In-Process Cache](../patterns/caching/in-process-cache.md) — A local fallback cache keeps the hottest key in the app's own memory, off the shared node
- [Partition Around Limits](../principles/partition-around-limits.md) — A key chosen to distribute is a key that never gets hot

**Threatens**

- [Cache-Aside](../patterns/caching/cache-aside.md) — One popular key lives on a single cache node, and every reader goes to it
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — Placement by hash balances key count, not traffic
- [Sharding](../patterns/distributed/routing/sharding.md) — A sharded cache puts a viral key on exactly one shard
- [Bitly](../designs/bitly.md) — A design where one link carries most of the read load.

<!-- relationships:end -->
