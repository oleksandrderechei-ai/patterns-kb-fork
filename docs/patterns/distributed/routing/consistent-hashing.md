---
title: Consistent Hashing
description: Distributes keys so adding a node reshuffles the least
area: distributed-scale
owner: Oleksandr Derechei
tags: [partitioning, load-balancing]
status: stable
aliases: [hash ring, ring hashing]
solves: [adding one cache node made the entire cache go cold, our hit rate collapses every time the cluster is resized, going from eight nodes to nine moved almost every key to a different machine, we cannot add a machine without a maintenance window to reshuffle all the data, losing one node dumped its entire share of traffic onto a single neighbour]
---

# Consistent Hashing

Maps nodes and keys onto the same ring so that adding, removing, or resizing a node remaps only a thin slice of the keyspace — never all of it.

## What it is
<!--meta block=description-->

**Consistent hashing** puts nodes and keys on one fixed circle, and a key belongs to the first node found walking clockwise. Adding or removing a node then moves only the keys beside it. The usual hash(key) mod N ties every key to the node count, so one added node moves almost every key and a cache goes cold.

## Explained
<!--meta block=explain-->

Consistent hashing decides which node stores a key in a way that moves only a small share of keys when nodes join or leave. Hash the nodes and the keys onto the same circle, and give a key to the first node you meet walking clockwise. A node that joins or leaves affects only the keys next to it. Without it, the usual rule, hash(key) mod N, ties every key's home to the node count N. Add one node and N changes, so almost every key moves, and a cache with a million entries goes cold on an ordinary deploy. Choose it over mod N whenever nodes come and go, and keep mod N when the count never changes.

- **Uneven slices.** One point per node gives uneven slices, so give each node many virtual points on the circle, keeping the count modest.
- **Shared view.** Two nodes with different views of the circle disagree on an owner, so spread membership changes reliably.
- **Hot keys.** One very popular key still overloads its single owner, so copy or split hot keys.

**Example.** A cache of 1,000,000 keys runs on 10 nodes and grows to 11. With mod N, a key stays only if its hash gives the same answer mod 10 and mod 11, about 1 key in 11, so roughly 909,000 keys move and the cache goes cold. With the circle, only the new node's slice moves, so roughly 91,000 keys, provided the slices are even. With 100 points per node they are close to even, the circle holds 1,100 points, and each lookup is a binary search of about 10 steps instead of one mod. With one point each, the new node's slice could be far larger or smaller. That is the cost.

## How it works
<!--meta block=structure-->

```mermaid caption="Which node owns a given key? Keys and nodes hash onto the same ring, so a key belongs to the first node clockwise of it — and a node joining takes only the arc in front of it."
flowchart LR
    Client["Client or router"]
    subgraph Ring["One hash ring, shared by keys and nodes"]
        P(["key hash lands here"])
        A[("Node A")]
        B[("Node B")]
        C[("Node C")]
    end
    Client -->|"1 hash the key onto the ring"| P
    P -->|"2 walk clockwise"| B
    B -->|"3 owns the key: read and write here"| Client
    B -->|"4 replicas take the next positions"| C
    C -->|"ring order, wraps to"| A
    A -->|"ring order, continues to"| P
```

## Variations
<!--meta block=variations-->

- **Virtual nodes (vnodes)** — Each physical node is hashed to dozens or hundreds of ring points instead of one, spreading its load across many neighbors and bounding the blast radius of any single node's churn.
- **Bounded-load consistent hashing** — Caps any node at roughly (1 + ε) times the average load; requests that would push it past the cap fall through to the next node on the ring, trading a pure single-hash lookup for a fairness guarantee.
- **Rendezvous (highest random weight) hashing** — Skips the ring entirely: compute a weight per node per key and take the highest. No sorted structure to maintain, and membership changes remap just as few keys. But every lookup weighs the key against every member, so the cost grows with the cluster instead of staying logarithmic, unless you layer a hierarchy over it.
- **Jump consistent hash** — A tiny, allocation-free function that maps a key to a bucket index in O(log n) time with no stored ring — at the cost of only supporting removal from the end of the bucket list, not from the middle.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **With an even spread, one node joining or leaving** remaps about 1/N of keys, not the whole keyspace.
- **Lets a cluster scale horizontally** without a coordinated full re-shard.
- **Underpins distributed caches**, DHTs (distributed hash tables), and sharded databases at large scale.
- **With enough virtual nodes**, load spreads far more evenly than with one point per node, though not perfectly.

### Cons
<!--meta polarity=con-->

- **One ring point per node gives uneven load**; fixing it with vnodes adds memory and lookup cost.
- **Ring lookup** is O(log n) against a sorted structure, slower than O(1) modulo hashing, and each membership change rebuilds that structure.
- **Every node needs a consistent** view of ring membership — a stale view means two nodes disagree about who owns a key.
- **Doesn't fix hot-key skew**: one very popular key still overloads whichever single node owns it.
- **More vnodes per machine means more ring neighbours.** The same number of simultaneous node failures then leaves more ranges unavailable, and ring-wide repair grows with the token count. Production rings keep the count modest and place tokens deliberately.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Nodes come and go** — scaling, failures, rolling deploys — and you need placement to survive that.
- **Minimizing data movement** or cache invalidation on membership change matters.
- **Building a [distributed cache](../../caching/distributed-cache.md), a DHT, a sharded store, or a load balancer** that should stick clients to backends.

### Avoid when
<!--meta polarity=avoid-->

- **The node count is fixed** and essentially never changes — a static mod-N hash is simpler and needs no ring bookkeeping.
- **Strict, real-time load balancing** matters more than minimal movement — pair with a bounded-load variant or a dedicated load balancer instead.
- **A small**, centralized directory of key-to-node assignments is simpler than propagating ring membership everywhere.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a ring with virtual nodes"
class HashRing {
  private ring = new Map<number, string>(); // ring position -> node id
  private positions: number[] = [];
  private readonly vnodes = 100;
  addNode(node: string): void {
    for (let i = 0; i < this.vnodes; i++) this.ring.set(hash(`${node}#${i}`), node);
    this.reindex();
  }
  removeNode(node: string): void {
    for (let i = 0; i < this.vnodes; i++) this.ring.delete(hash(`${node}#${i}`));
    this.reindex();
  }

  private reindex(): void {
    this.positions = [...this.ring.keys()].sort((a, b) => a - b);
  }

  getNode(key: string): string {
    const h = hash(key);
    // Binary search for the first position >= h: about log2(n) steps
    let lo = 0, hi = this.positions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.positions[mid] >= h) hi = mid; else lo = mid + 1;
    }
    const pos = this.positions[lo === this.positions.length ? 0 : lo]; // wrap past the end
    return this.ring.get(pos)!;
  }
}
```

## In the wild
<!--meta block=wild-->

- **Apache Cassandra** — Places data on a token ring; the num_tokens setting gives each node many virtual nodes so ownership and churn spread across neighbours, and the replication factor places copies on the next nodes clockwise. {#wild-cassandra}
- **Amazon Dynamo** — The 2007 Amazon paper that brought the ring plus virtual nodes into mainstream practice, pairing it with quorum replication and gossip-based membership; the design line behind Cassandra and Riak. {#wild-dynamo}
- **Ketama** — The consistent-hashing scheme most memcached clients implement to pick a server; it hashes each server to many points on the ring so adding or removing one server reshuffles only its share of keys, not the whole cache. {#wild-ketama}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Virtual nodes per physical node** — How many ring points (tokens) each node owns; more evens out load but adds ring metadata and lookup cost. Tune against the ratio of maximum to mean per-node load: raise the count only until that ratio meets your target.
- **Replication factor** — How many distinct physical nodes, found by walking clockwise and skipping points of a node already chosen, hold a copy of each key. Pick it from the failures you must survive.
- **Bounded-load factor** — If using the bounded-load variant, the cap of (1 + epsilon) times average load before a node overflows to the next on the ring. A smaller epsilon evens load more but sends more requests to overflow nodes; watch the ratio of maximum to mean load.
- **Hash function** — The function mapping keys and nodes onto the ring; it must spread inputs uniformly or the ring is skewed from the start.

### Signals to watch
<!--meta polarity=signal-->

- **Per-node load distribution** — How evenly keys and request volume spread across nodes — the thing vnodes exist to flatten.
- **Data movement on membership change** — The fraction of keys that remap when a node joins or leaves.
- **Hot-key / hot-partition rate** — Request rate concentrated on a single key or partition regardless of ring balance.
- **Ring-membership convergence** — How long nodes take to agree on the current ring, and how many hold a divergent view.

### Failure modes under load
<!--meta polarity=failure-->

- **Uneven load from too few vnodes** — One physical node owns an oversized arc and runs hot while others idle.
- **Stale ring view** — Nodes disagree on who owns a key, so requests are misrouted or a key is briefly double-owned during churn.
- **Hot key** — A single very popular key overloads whichever node owns it, which balancing across the ring cannot fix.
- **Correlated churn** — Losing or adding several nodes at once still moves a large slice of keys, cooling caches.

### Readiness checklist
<!--meta polarity=check-->

- Virtual-node count tuned for even distribution against ring metadata and lookup overhead.
- Membership propagation (e.g. gossip) tested for convergence time under node churn.
- Per-node load distribution monitored, not assumed uniform.
- Hot-key mitigation — extra replication or a front cache — in place for known skewed keys.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [System Design Interview](../../../themes/system-design-interview.md) — Pick a shard with minimal reshuffle {#fluency-system-design-interview}
- [Performance](../../../themes/performance.md) — Route to the node that already has the data warm {#fluency-performance}
- [Scalability](../../../themes/scalability.md) — Place partitions with minimal reshuffle {#fluency-scalability}
- [Real-Time Updates](../../../themes/realtime-updates.md) — Assign each connection to an owning server {#fluency-realtime-updates}

<!-- fluency:end -->

## Check yourself
<!--meta block=selfcheck-->

> **Why does one ring point per node give uneven load?**
>
> Arcs between random points differ in length, and virtual nodes fix it at a memory and lookup cost, see [con 1](consistent-hashing.md#tradeoffs-con-1).

> **What goes wrong when two nodes hold different ring views?**
>
> They disagree about who owns a key, see [con 3](consistent-hashing.md#tradeoffs-con-3).

> **When is plain mod-N hashing the better choice?**
>
> When the node count is fixed and never changes, see [avoid 1](consistent-hashing.md#usage-avoid-1).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Load Balancer](./load-balancer.md) — Hash to pin a client to an instance
- [Replication](../coordination/replication.md) — Place primary and replicas around the ring
- [CDN](./cdn.md) — Edge nodes are chosen by hashing
- [Gossip Protocol](../coordination/gossip-protocol.md) — Gossip membership feeds the hash ring
- [Distributed Cache](../../caching/distributed-cache.md) — Picks the owning cache node in a clustered cache
- [Partition Around Limits](../../../principles/partition-around-limits.md) — Consistent hashing is what makes partition count cheap to change
- [Sharding](./sharding.md) — Consistent hashing is how shards are placed
- [Sticky Session](./sticky-session.md) — A ring over client or session keys gives sticky routing without a per-client table.

**Prevents**

- [Hot Partition](../../../hazards/hot-partition.md) — Spreads ranges evenly so no node inherits the whole tail

**Exposed to**

- [Hot Key](../../../hazards/hot-key.md) — Can fall into hot key when placement by hash balances key count, not traffic

**Demonstrated by**

- [Distributed Cache](../../../designs/design-distributed-cache.md) — demonstrates the ring both distributing keys evenly and doubling as a client-side routing table
- [Distributed Rate Limiter](../../../designs/distributed-rate-limiter.md) — keeps one client pinned to one node while spreading load, and limits key remapping when shards are added
- [Tinder](../../../designs/tinder.md) — consistent hashing keeps related swipes co-located as the Redis cluster scales horizontally
- [Facebook Live Comments](../../../designs/fb-live-comments.md) — hashing viewers by video id routes a stable subset of connections to each server and tolerates servers joining and leaving
- [Google Docs](../../../designs/google-docs.md) — hash(documentId) maps keys onto a ring of nodes, keeping churn minimal when membership changes
- [Online Chess](../../../designs/online-chess.md) — routing hundreds of thousands of stateful sessions with minimal reshuffling on scale-up or failure is exactly the job consistent hashing exists for
- [Uber](../../../designs/uber.md) — A ring keeps most keys in place when a node is added or removed

**Implemented by**

- [Key-value & cache stores](../../../comparisons/key-value-stores.md) — Cassandra's token ring and the Ketama scheme in memcached clients are this pattern as shipped; DynamoDB repartitions for you and never exposes the ring.

<!-- relationships:end -->
