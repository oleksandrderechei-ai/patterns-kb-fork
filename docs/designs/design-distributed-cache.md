---
title: Distributed Cache
description: Spread an in-memory key-value store across many nodes so it holds 1TB at 100k req/s in under 10ms
area: designs-foundational
owner: Oleksandr Derechei
tags: [caching, availability, latency, resource-management]
status: stable
aliases: [cache cluster, distributed KV cache]
solves: [my single cache server has run out of memory and the working set no longer fits on one box, one node holds a viral item and melts under read traffic while the rest of the fleet sits idle, every time I add a cache node almost every key moves and my hit rate falls off a cliff, I need sub-10ms key lookups but a single machine cannot absorb a hundred thousand requests a second, expired entries pile up in memory because nothing removes them until someone happens to read them]
favourite: true
---

# Distributed Cache

A distributed cache stores key-value pairs in memory across many machines so it can hold far more data — and serve far more traffic — than any single node could. The design starts as a one-box hash table and grows outward: partition the keyspace across a fleet, replicate each shard for survival, and shave every millisecond off the path a client takes to reach the right node. It is the reference build of the [distributed-cache](../patterns/caching/distributed-cache.md) pattern.

## Understanding the problem
<!--meta block=description-->

A distributed cache answers get, set and delete from memory in single-digit milliseconds, with an optional time-to-live, in front of data that belongs to a database. That makes the cache free to lose data and never free to be slow. This page walks through splitting the keyspace, replication, eviction without a read lock, hot keys, deletes that stick across copies, and network cost.

## Explained
<!--meta block=explain-->

A distributed cache spreads an in-memory key-value store over many machines, so each machine holds a slice of the data and answers from memory in under 10 ms. The caller's own library hashes the key to find the owning machine, using a ring so adding or losing a machine moves only a small share of keys, not nearly all of them. Size it by memory, not request rate: memory sets the machine count, and the hit ratio, the share of reads answered from the cache, sets the load on the database behind it. Do not build durability or strong consistency, because the database holds the real data; that is why losing the last unshipped writes in a failover is a price, not a bug.

- **Replica memory.** A second copy of each slice doubles the memory bill, so keep one only if the database cannot absorb a refill burst.
- **Zombie deletes.** A failover can bring back a deleted key, so give every key a time-to-live as the backstop.
- **Hot key.** One viral key lands on one machine, so copy only that key to several machines and let one client refill it.

**Example.** You need 1 TB at 100,000 requests a second. A machine with 32 GB of RAM offers about 24 GB usable, so 1,024 / 24 is about 43 machines, rounded to 50. By request rate you would need only 8, so memory decides. Each of the 50 serves about 2,000 requests a second. A 95% hit ratio sends 5,000 misses a second to the database; 90% sends 10,000, double. One extra copy per slice makes it about 100 machines. Adding a machine to the ring moves about 1/51 of the keys, about 20 GB, which arrives as misses refilled from the database.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Set, get, and delete a value by key.
2. Attach an optional time-to-live (TTL) per key so entries expire on their own.
3. Evict on a Least-Recently-Used (LRU) policy once the cache is full.

Out of scope: a user-configurable cache size, and alternative eviction policies (LFU (least frequently used), FIFO (first in, first out), custom) — worth naming to the interviewer, but LRU is the one to build.

### Non-functional
<!--meta requirement=nfr-->

- **Availability** — highly available, with [eventual consistency](../themes/consistency-and-replication.md) accepted; a slightly stale read beats a failed one.
- **Latency** — under 10&nbsp;ms for get and set.
- **Scale** — up to 1&nbsp;TB of data and a peak of 100k requests/second.
- **Restart safety** — a restart must not empty the whole cache at once and send every request to the database in the same second.
- **Hot keys** — one key a thousand times hotter than the rest must not saturate the machine that owns it.

Explicitly not in scope: durability across restarts, strong consistency, rich queries, and transactions — a cache, not a database.

## Right-sizing: how many nodes?
<!--meta block=sizing-->

The arithmetic settles one question: how many machines, and what decides it. Two estimates — one from how much data must fit, one from how many requests must be served — disagree by six times. Memory wins, which means the fleet is bought by the gigabyte and the spare request capacity comes free. Everything else on this page is about not wasting that memory.

**The problem:** 1&nbsp;TB of cached data answered at 100k req/s in under 10&nbsp;ms, where the authoritative copy of every value lives in someone else's store. **The shape:** synchronous request/response — every call is a blocking dependency inside somebody else's request, so nothing may be deferred to a worker; the one asynchronous element is replication, and it is asynchronous precisely to keep it off this path. **The stores:** two — the fleet's own memory, which is the data and is deliberately not durable, and a small membership store holding the ring and who is alive, which is the only state whose loss would confuse the cluster rather than merely empty it.

**Required capabilities:**

- In-memory keyed store with O(1) get, set and delete — the whole product, and the reason the answer is not a database. → functional requirement (FR): get/set/delete; non-functional requirement (NFR): latency.
- Per-key expiry plus an eviction policy under a hard memory ceiling — memory is finite and the ceiling must be enforced by the cache, not discovered by the kernel. → FR: TTL; FR: eviction.
- Client-side routing table over the keyspace — a lookup hop to find the owner would be a third of the latency budget spent on addressing. → NFR: latency.
- Membership with failure detection — the ring is only correct while the fleet agrees on who is in it. → NFR: availability.
- Asynchronous replication of each shard — a node's death must not be its data's death, and a replica acknowledgement must not be on the write path. → NFR: availability; latency.
- Pooled long-lived connections — a handshake per request is a tail-latency generator, not a feature. → NFR: latency.
- Per-node hit ratio, eviction rate and p99 telemetry — the cache's value is a ratio, and an unmeasured ratio is an unmanaged bill. → NFR: scale.

**The numbers:**

- By storage: a 32&nbsp;GB-RAM instance leaves roughly 24&nbsp;GB usable once process and OS overhead are subtracted; 1024&nbsp;GB ÷ 24&nbsp;GB ≈ 43, rounded up for headroom to **~50 nodes**. → NFR: scale.
- By throughput: take ~20,000 req/s as what one node sustains before latency degrades (assumed — it moves with value size and instance type); 100,000 ÷ 20,000 = 5 as a floor, padded for spikes and in-flight failures to **~8 nodes**. → NFR: scale.
- The binding constraint is memory, and by six times. Fifty nodes serve 100k req/s at **~2k req/s each**, a tenth of what a node can do — so "add nodes for throughput" is the wrong instinct here, and CPU headroom is something this design already owns. → NFR: scale.
- Replication factor: keeping one copy of every shard doubles the memory bill to **~100 nodes, 2&nbsp;TB of RAM**. It is the single largest cost decision on the page, and it buys availability rather than capacity. → NFR: availability.
- Network: 100k req/s × ~1&nbsp;KB average value ≈ **100&nbsp;MB/s ≈ 0.8&nbsp;Gbit/s** across the fleet, which is nothing. One node at 20k req/s of 10&nbsp;KB values is **200&nbsp;MB/s ≈ 1.6&nbsp;Gbit/s**, which saturates a card long before the CPU notices — value size, not request rate, decides whether the network binds. → NFR: latency.
- Hit-ratio economics: at 100k req/s, a 95% hit ratio leaves **5k misses/s** on the source of truth and 90% leaves **10k/s**. Five points of hit ratio doubles the load on the database this cache exists to protect, so memory is bought in hit-ratio units, not gigabytes. → NFR: scale.
- Bookkeeping: 1&nbsp;TB at ~1&nbsp;KB values is **~1 billion entries**, each carrying a hash slot, two list pointers and an expiry — assume 50 to 100 bytes, so **5 to 10 percent of the fleet's RAM** is overhead before the allocator's own rounding. Small values make this ratio much worse, which is why a cache of 50-byte counters is a different sizing exercise. → NFR: scale.
- Rebalance cost: adding one node to a 50-node ring moves about 1/51 of the keyspace ≈ **20&nbsp;GB**, which arrives as misses refilled from the source of truth rather than as a copy between nodes — a temporary 2% dent in the hit ratio, not an outage. → NFR: scale.

**Verdict per candidate:**

- Event-driven or [write-behind](../patterns/caching/write-behind.md) core — **rejected**: every call is a blocking dependency of someone else's request, and a queued cache read has already missed its budget. → NFR: latency.
- Synchronous request/response — **adopted**: read, answer, done, with replication the only thing allowed to happen afterwards. → NFR: latency.
- Sizing by storage — **adopted** as the binding estimate: 50 nodes covers the request rate as a side effect. Sizing by throughput — **rejected**: 8 nodes hold under a fifth of the working set and evict the rest continuously. → NFR: scale.
- Consistent hashing, computed client-side — **adopted**: it survives the fleet changing size and doubles as the routing table, removing a hop. → NFR: scale; latency.
- Modulus sharding — **rejected**: one node added or lost remaps nearly every key, so the whole tier misses at once (dive 1). → NFR: scale.
- Central proxy or routing tier — **deferred**: client-side routing is free today; the trigger is clients in three languages, or a socket count no client library can pool sanely. → NFR: latency.
- Asynchronous replication, one copy per shard — **adopted**: staying available through a node loss needs a copy to promote, and that copy must not sit on the write path. → NFR: availability.
- Synchronous replication — **rejected**: it puts a replica's latency inside a 10&nbsp;ms budget to buy a consistency guarantee the requirements traded away. → NFR: latency.
- No replication, refill on loss — **rejected**, and not obviously: losing one node's 20&nbsp;GB costs about two points of hit ratio and sends its share of misses at the source of truth in one burst. It is the cheaper answer only when the origin can absorb that herd, which is exactly what a cache exists to avoid. → NFR: availability.
- Durability across restarts — **rejected**: the authoritative copy is elsewhere, and a cache that persists is a database with worse guarantees and a slower write path. → NFR: latency.
- Quorum writes or consensus — **rejected**: it prices a strong-consistency guarantee that is explicitly out of scope, in latency the budget cannot pay. → NFR: latency.
- Sampled approximate LRU under a memory ceiling — **adopted**: exact LRU makes every read a write to a shared list, which is a lock in the hot path (dive 3). → FR: eviction; NFR: latency.
- Lazy expiry plus sampled active expiry — **adopted**: reads catch what they touch and a background pass catches what nobody touches. A full periodic sweep — **rejected**: scanning a billion keys to reclaim a few thousand. → FR: TTL.
- Dedicated hot-key tier — **deferred**: uniform sharding holds while traffic follows keys; the trigger is one shard's request rate running several times the fleet median (dive 4). Until then, NFR 5 is met by hand: copy the one named key under `key#1…key#3`, found by the client-side count-min sketch (both in dive 4). → NFR: scale.
- Near-cache inside the client process — **deferred**: it removes the network entirely for a tiny hot set, and adds a second staleness window nobody can invalidate; the trigger is a hot set small enough to fit in an application's heap. → NFR: latency.
- Cross-region replication — **rejected**: a remote cache is refilled from a local source of truth more cheaply than it is shipped over a wide area network (WAN), and a stale cross-region copy is the worst of both. → NFR: availability.

**When this stops being right.** The hit ratio wears out first, and it wears out quietly. As the working set grows past provisioned memory the cache begins evicting entries that are still wanted, so each eviction becomes a future miss, and misses land on the source of truth out of all proportion to the memory shortfall — five points of hit ratio is double the database load. The signal: eviction rate per node plotted with hit ratio, both of which move well before the cache's own latency does, because an evicting cache is still fast at being wrong. Exits in adoption order: raise the memory ceiling on the existing instances; add nodes, which the ring makes a ~20&nbsp;GB refill rather than a remap; split by workload class so one team's churn cannot evict another team's hot set; then spill cold entries to local solid-state drive (SSD), trading a millisecond for an order of magnitude more bytes per pound. → NFR: scale.

## Core entities
<!--meta block=entities-->

The domain is as thin as it gets — **keys** and **values** — but the storage representation carries the extra facts that make the requirements work:

- **Key** — the opaque string a caller hands in; also what the client hashes to find the owning node, which is why key naming is a routing decision and not only a naming one.
- **Value** — stored not bare but as a `(value, expiry)` pair, so a read can check the TTL before returning and a missing entry is distinguishable from a stored null.
- **Entry** — internally each pair is wrapped in a doubly linked-list node so recency order can be maintained in O(1). An implementation detail, not part of the API contract, and the place the per-entry overhead in Right-sizing is spent.
- **Member** — one cache node as the cluster sees it: an address, a health state, and the ring positions it owns. It is the only entity the fleet has to agree on, which is why it lives in the membership store rather than in any node's memory.

## The interface
<!--meta block=interface-->

Three operations, one per functional requirement. Real clusters speak a compact binary protocol over pooled TCP connections rather than HTTP, but the surface reads the same:

```http summary="API — set, get, delete"
POST /{key}
{ "value": "…", "ttl_seconds": 3600 }   # ttl optional
→ 200 OK

GET /{key}
→ 200 { "value": "…" }               # 404 if absent or expired

DELETE /{key}
→ 204 No Content

POST /mget                              # one round trip, many keys
{ "keys": ["a", "b", "c"] }
→ 200 { "a": "…", "c": "…" }         # absent keys simply missing

POST /{key}?if_absent=true              # set-if-absent
{ "value": "…", "ttl_seconds": 30 }
→ 200 OK if set, 409 Conflict if the key already exists   # the single-flight lock of dive 4
```

A miss and a stored empty value must be different answers. Collapsing them is the classic way a cache turns into an outage: the caller cannot tell "not cached" from "cached as nothing", so it either re-queries the database for every legitimately empty result or caches a null and never notices the real value arriving. The distinction is also what makes negative caching possible — storing "this key does not exist" for a short TTL, the cheapest defence against a scan of keys that will never hit.

Two additions earn their place beyond the three primitives. A multi-key read folds many lookups into one round trip, which matters because at 10&nbsp;ms the network dominates and a page needing thirty values should not pay thirty latencies. And a **set-if-absent** — write only when the key is unset, with a TTL — is the primitive that lets one client claim the right to refill a key while the others wait, so a popular miss becomes one database query instead of a thousand (dive 4). Without it, single-flight needs a coordinator the cache was supposed to replace.

The TTL is a caller-facing contract, not an implementation detail. It bounds how wrong a value may be, which means it is also the only correctness lever most callers get: a value that must never be more than a minute out of date carries a 60-second TTL and does not need an invalidation protocol at all. Deleting is the other lever, and the one with sharp edges — see dive 5.

## How the system is built
<!--meta block=architecture-->

Start at the node, then multiply it. A single node is two data structures working together: a **hash table** for O(1) lookup by key, and a **doubly linked list** that orders entries by recency so the least-recently-used one is always at the tail, ready to evict. Following the simplest-thing-first instinct of [Keep It Simple, Stupid (KISS)](../principles/kiss.md), get, set and delete are built and made correct on one box before any distribution is added — the cluster is this node, sharded and replicated.

TTL needs two mechanisms, because either alone leaks. Lazy expiry is free — a read checks the timestamp and drops the entry if it is stale — but an entry nobody reads is an entry nobody expires, so untouched keys squat in memory until they are evicted for being old rather than for being dead. A background [janitor](../patterns/distributed/coordination/sweeper.md) closes that gap by sampling keys that carry TTLs and reclaiming the expired ones; how often it runs trades CPU against memory, and it is the first knob to turn when memory is tight but the hit ratio is fine.

Multiplied out, the cluster is ~50 such nodes and one shared fact: who owns what. A client library hashes each key onto a consistent-hash ring, sends the request over a pooled connection straight to the owner, and every shard streams asynchronously to a replica. The membership store holds the ring and each member's health, and it is the only thing the fleet must agree on — which is why it holds kilobytes and never sits on the request path.

```mermaid caption="Where does one request go? The client hashes locally and talks straight to the owner; the membership store is read to learn the ring, never per request, and a miss is the caller's problem to refill from the origin."
flowchart TB
    Client["Client library · consistent-hashing"] -->|"hash(key) picks owner"| Owner["Cache node · 1 of ~50"]
    Client -->|"watch ring + health"| Members[("Membership store")]
    Owner -->|"O(1) get / set / delete"| Store[("Hash table + LRU list")]
    Owner -.->|"async replicate · replication"| Rep[("Replica shard")]
    Janitor["TTL janitor · sweeper"] -->|"sample and reclaim expired"| Store
    Owner -->|"miss"| Origin["Source of truth"]:::ext
    classDef ext stroke-dasharray:4 4;
```

```python summary="Pseudocode — the O(1) LRU node"
class Entry:  # key, value, expiry — one link in the LRU list

get(key):
    node = table[key]
    if node.expiry and now() > node.expiry:
        evict(node); return MISS
    move_to_front(node)          # O(1): mark most-recently-used
    return node.value

set(key, value, ttl):
    node = table.get(key) or Entry(key)
    node.value  = value
    node.expiry = now() + ttl if ttl else None
    move_to_front(node)
    table[key] = node
    while used_memory > ceiling:
        evict(tail.prev)         # O(1): drop least-recently-used
```

### Components & communication {#architecture-h3-1}

- **Client library** — where requests enter: it hashes the key onto the ring, picks the owner, and sends get/set/delete over a pooled connection. Holding the routing table is what makes a cache hit exactly one network hop.
- **Cache node** — one of ~50 members, each owning a set of ring arcs; serves the three primitives from its own hash table and LRU list, and enforces its memory ceiling by evicting from the tail.
- **Hash table + LRU list** — the storage inside a node: the table answers by key in O(1), the list keeps recency order in O(1), and every Entry carries its expiry so a read can refuse a stale value.
- **Replica shard** — an asynchronous copy of an owner's arcs on another member, kept warm for promotion rather than for reads (dive 2).
- **TTL janitor** — a background pass that samples keys with expiries and reclaims the dead ones, so memory is not held by entries nobody will read again.
- **Membership store** — the ring and each member's health; clients watch it for changes and nothing reads it per request. Given, not built: any small coordination service does this job.

### Where each requirement lands {#architecture-h3-2}

- Set, get and delete a value by key — Client library (hash → owner) → Cache node → Hash table, with the write mirrored to the Replica shard afterwards. → FR: get/set/delete.
- Attach an optional TTL — the expiry is stored on the Entry, checked by Cache node on every read, and reclaimed in the background by the TTL janitor. → FR: TTL.
- Evict on an LRU policy once full — Cache node drops from the tail of the LRU list whenever used memory crosses the ceiling. → FR: eviction.

## Deep dives
<!--meta block=deepdives-->

Six questions decide this design. How do you split a billion keys across fifty machines so that adding a machine does not move all of them? What happens the moment one machine dies? How do you stay inside the memory you paid for without slowing every read down? What do you do about the one key everybody wants? How do you make a deletion stick when there are copies? And where do the last few milliseconds actually go?

### 1 · Splitting the keyspace so it survives resizing → NFR: scale

**Choose the placement function for what happens when the fleet changes size, not for how evenly it spreads — every candidate spreads evenly, and only some survive a node being added.** One node holds neither 1&nbsp;TB nor 100k req/s, so keys must be [sharded](../patterns/distributed/routing/sharding.md); the question is only by what rule.

- **Modulus — `hash(key) % N`.** Perfectly uniform and catastrophic under change: move from 50 nodes to 51 and the divisor changes for every key, so almost the entire cache misses at once and the source of truth takes 100k req/s it has never seen. Rejected on the first capacity change, which is to say on the first good day.
- **An explicit slot map.** Fix a large number of slots, assign slots to nodes in a table, and move slots by hand. It gives exact control and makes rebalancing a deliberate act, at the cost of a table every client must agree on and an operator who must maintain it. Reasonable, and more machinery than this design needs.
- **[Consistent hashing](../patterns/distributed/routing/consistent-hashing.md) (chosen).** Place nodes and keys on a circular keyspace with the same hash function and give each key to the first node clockwise. Adding or removing a node remaps only the keys in that node's arc — about 1/51 of them, the ~20&nbsp;GB priced in Right-sizing — while every other key keeps its owner. Rendezvous hashing gets the same property by a different route; either is fine, and the ring is the one most client libraries already implement.

Two details make it work in practice. A node placed once on the ring owns one arbitrary arc, and arbitrary arcs are uneven — so each node is placed many times under names built from its own name (virtual nodes), which averages the arcs out and lets a bigger instance own proportionally more of the ring. And because the ring is a pure function of the member list, the client computes ownership locally: routing costs no round trip, and the membership store is read when the fleet changes rather than when a key is fetched. The cost is that every client must see the same member list, which is why membership is the one thing this design coordinates.

```mermaid caption="What moves when a node joins? Only the keys in the arc the newcomer takes over — every other key keeps its owner, which is the whole reason the modulus was rejected."
flowchart LR
    Key["key 'user:42'"] -->|"hash to a ring position"| Ring["Consistent-hash ring · virtual nodes"]
    Ring -->|"first node clockwise"| A["Node A · owns arc 1"]
    Ring --> B["Node B · owns arc 2"]
    Ring --> C["Node C · owns arc 3"]
    New["Node D joins"] -.->|"takes one slice of arc 2 only"| B
```

### 2 · When a node dies: replicate, or just refill? → NFR: availability

**Keeping a second copy of every shard is not obviously right for a cache, because the data can always be fetched again — the argument is about what the refill does to the system underneath.** Losing one node of fifty drops the fleet's hit ratio by roughly two points and sends that shard's entire miss stream at the source of truth in the same second.

- **No replication — refill from the origin.** The cheapest answer, and the one that outsources the failure: the ring closes over the dead node's arc, the new owner holds none of those keys, and the database absorbs a [herd](../hazards/thundering-herd.md) of misses for as long as the refill takes. Acceptable when the origin is over-provisioned; unacceptable when the cache exists because it is not.
- **Synchronous replication.** The write blocks until the replica acknowledges, which buys a strong-consistency guarantee this design explicitly does not need and puts another machine's latency inside a 10&nbsp;ms budget. Wrong trade for a cache.
- **Asynchronous replication (chosen).** The owner answers immediately and ships the write to its replica in the background, so the latency budget is untouched and a promotion has a warm copy to work with. The price is a window in which the last unacknowledged writes are lost on failover — acceptable exactly because the source of truth still has them. Redis works this way by default, and its `WAIT` command lets a caller demand replica acknowledgement for the individual writes where it matters.
- **Peer-to-peer.** Drop the owner/replica distinction: every node owns some ranges and replicates others, gossiping updates around. It scales furthest and removes the single-writer per shard, at the cost of conflict handling nobody wants inside a cache. The Cassandra-shaped answer, and more machinery than this problem asks for.

Failover has one edge worth stating unprompted: a promoted replica can resurrect data. If a delete was applied to the owner and not yet shipped when the owner died, the replica still holds the old value, so promotion brings a deleted key back to life with a full TTL ahead of it. Nothing in the cache can prevent this — the fix is at the caller, which either keeps TTLs short enough to bound the resurrection or writes values whose key carries a version (dive 5). The two windows are one: whatever replication lag you accept is both how much data a failover loses and how long a deleted key can come back for.

```mermaid caption="What does a failover cost? Exactly the writes that had not shipped when the owner died — the replica serves everything else, so the origin sees a trickle instead of a shard's worth of misses."
sequenceDiagram
    autonumber
    participant C as Client library
    participant O as Cache node
    participant R as Replica shard
    participant D as Source of truth
    C->>O: SET user:42
    O-->>C: 200 OK
    O--)R: replicate in background
    Note over O,R: owner dies before the last writes ship
    C->>R: SET/GET after promotion
    R-->>C: MISS — the unshipped writes are gone
    C->>D: refill from the origin
```

### 3 · Living inside the memory budget → FR: eviction; NFR: latency

**A cache is a fixed amount of memory pretending to be an unbounded map, and the eviction policy is where the pretence is maintained — cheaply, or on the hot path.** The textbook LRU is exact: every read moves an entry to the head of a shared list. That is a write on every read, and under concurrency a write to shared structure is a lock.

- **Exact LRU.** Correct ordering, O(1) per operation, and a single mutable list every reader must touch. On one thread it is perfect; across cores it turns the read path into a contention point for the sake of an ordering nobody inspects.
- **Sampled approximate LRU (chosen).** Do not maintain a global order at all: on eviction, sample a handful of candidate keys and drop the one with the oldest access stamp. The result is almost the same victim for a fraction of the bookkeeping, which is why Redis approximates LRU rather than implementing it exactly. The cost is admitted: occasionally a slightly-less-cold entry is evicted, and replaying your own traffic against exact LRU shows how much the hit ratio differs.
- **Frequency-based eviction.** LRU has one bad day — a scan. Reading a million keys once evicts the entire working set in favour of data nobody will ask for again, and a frequency-based policy resists it by preferring entries that have been popular rather than recent. Worth naming as the swap to make when the workload is scan-heavy; LRU is the right default for read-mostly traffic with a stable hot set.

Then there is the memory the cache does not think it is using. An allocator that carves memory into fixed size classes — memcached's slabs being the clearest example — can hold free space in the wrong class, so a workload whose value sizes drift strands memory it cannot reuse without a restart. Per-entry overhead compounds the same way: at ~1&nbsp;KB values the tenth of RAM spent on hash slots, list pointers and expiries is a rounding error, and at 50-byte values it is most of the machine. Set the ceiling on resident memory rather than on the sum of stored values, and leave room above it — a cache whose memory the operating system reclaims does not degrade, it stops.

Expiry is the other half of the budget, and it needs both mechanisms. Lazy expiry, checked on read, is free and incomplete: a key nobody reads is a key nobody expires. The janitor closes the gap by sampling keys with TTLs, deleting the expired ones and going round again while the expired fraction of the sample stays high — cheap when there is nothing to do, self-accelerating when there is. Run it too rarely and dead entries evict live ones; too often and it competes with the traffic for the same cores.

### 4 · The key that does not spread → NFR: latency; scale

**Sharding assumes traffic follows keys, and one [hot key](../hazards/hot-key.md) is the case where it does not: a viral post or a flash-sale counter puts a whole product's traffic on one of fifty nodes.** It is usually a property of how the cache is used rather than of the cache, which is exactly why a strong answer raises it before being asked.

- **Hot reads — spread the copies, not the node.** Vertically scaling the owning node buys a little and wastes the other 49. Fanning out works: read replicas of that shard, a separate tier for known-hot keys, or — simplest — keeping several copies of the value under names built from the key (`key#1…key#3`) so readers pick one at random and the load divides by three. The general read-side story is the [Scaling Reads](../themes/scaling-reads.md) theme.
- **Hot writes — coalesce before you split.** Copies must converge, so splitting a hot write across suffixes means reconciling on read. [Batching](../patterns/concurrency/batching.md) at the client is the cheaper first move: fold a thousand increments a second into one flush and the shard sees one write instead of a thousand, at the cost of a flush interval's worth of staleness. See [Scaling Writes](../themes/scaling-writes.md).
- **Stampede on expiry.** A hot key's TTL is a scheduled outage: the moment it expires, every request for it misses at once and they all go to the source of truth — a [stampede](../hazards/cache-stampede.md) whose size is the key's popularity. Jitter TTLs so hot keys do not expire together, and let one client claim the refill with a set-if-absent lock while the others wait or serve the previous value; the origin then sees one query per expiry rather than thousands. Set the lock's TTL longer than the origin's slowest refill so a crashed holder frees the key, and give waiters a timeout after which they serve the previous value or read through.
- **Detection before mitigation.** None of the above can be applied to a key nobody has identified, and exact per-key counters at 100k req/s cost more than the traffic they measure. Sample the request stream or keep an approximate frequency structure such as a [count-min sketch](../patterns/distributed/coordination/count-min-sketch.md) on the client, which names the heavy hitters in fixed memory and is wrong only in the direction of over-counting.

Every one of these is a special case bolted onto an otherwise uniform scheme, and that is the honest summary: uniform sharding is simple everywhere and wrong in one place, and the fix is per-key machinery to maintain, monitor and eventually retire when the key goes cold. Take the simplicity, know the exception, and keep the detection running so the exception is found by a dashboard rather than by a pager.

```mermaid caption="How does one expiry avoid becoming a thousand database queries? A set-if-absent lock elects one refiller; everyone else waits on the key they were already asking for."
sequenceDiagram
    autonumber
    participant M as Many clients
    participant K as Cache node
    participant D as Source of truth
    Note over M,K: the hot key's TTL expires
    M->>K: N concurrent GETs — all miss
    M->>K: SET-IF-ABSENT refill lock
    K-->>M: one winner, others refused
    M->>D: winner queries the origin once
    M->>K: winner SETs the value with jittered TTL
    K-->>M: waiters read the fresh value
```

### 5 · Making a delete stick → FR: delete; NFR: availability

**A cache with one copy has no invalidation problem; this one has replicas, client pools and possibly a near-cache, so "delete" means "delete everywhere, eventually" — and eventually is a number somebody has to choose.** Deletion is the only operation here where the eventual-consistency licence in the requirements has teeth.

- **Explicit delete on write.** Whoever updates the source of truth deletes the key, so the next read refills it. Simple and correct while there is one copy; with an asynchronous replica it opens the resurrection window from dive 2, and with a client-side near-cache it does not reach the copy that matters at all.
- **Short TTL instead of deletion.** Let staleness expire rather than chasing it. It needs no invalidation path, costs a lower hit ratio (every key is refetched on its TTL whether or not it changed), and bounds wrongness by a number the caller picked — which is often exactly the trade a cache should make.
- **Versioned keys (chosen where identity allows it).** Put the version of the underlying data in the key — `user:42:v7` — so an update writes a new key and never has to delete the old one, which ages out on its own. Invalidation stops being a distributed operation and becomes a naming convention; the cost is that the caller must know the version before it reads, which only works when the version is cheap to obtain.

Two consequences are worth carrying away. A delete that is lost — dropped by an asynchronous replica, or applied to a node that then failed over — leaves a value that will be served confidently until its TTL runs out, so every key wants a TTL even when the design intends to delete it explicitly; the TTL is the backstop for the invalidation that did not arrive. And the same reasoning is why a near-cache inside the application is deferred rather than adopted: it is the fastest layer in the system and the one no delete can reach.

### 6 · Where the last milliseconds go → NFR: latency

**At one node, latency is the O(1) lookup and there is nothing to discuss; across fifty, it is entirely a networking problem — how many round trips a request costs and what makes the slow ones slow.** A memory lookup is on the order of a hundred nanoseconds and a round trip inside a datacentre is closer to half a millisecond, so the budget is spent before the cache does any work.

- **Remove the hop.** Client-side consistent hashing means the request goes straight to the owner instead of asking a router where to go — one round trip instead of two, and the single largest saving on this list (dive 1).
- **Remove the handshake.** A fresh TCP connection costs a round trip before the first byte, and Transport Layer Security (TLS) costs more; an [object pool](../patterns/gof/extra/object-pool.md) of long-lived connections amortises that to nothing. This is usually what pins p99: the median request reuses a warm connection and the unlucky one opens a new one.
- **Remove the round trips you cannot remove one at a time.** Multi-key reads and pipelining fold thirty lookups into one network cost — with the caveat that a pooled connection carrying a pipeline has head-of-line blocking, so one very large value in the batch delays everything behind it.

Two tail-latency sources deserve naming because an average hides both. A node that executes commands on a single thread is fast until one command is not O(1): a request touching a large collection or enumerating keys blocks every other client for its duration, which is why such commands are banned from production paths rather than merely discouraged. And the caller's timeout is part of this design — set it near the budget rather than at ten times it, and treat a timeout as a miss. A slow cache must fail open and let the request reach the source of truth, because a cache outage that becomes an application outage has inverted the point of the tier.

## Limitations & trade-offs
<!--meta block=tradeoffs-->

**The biggest flaw, named first: the design is uniform everywhere, and traffic is not — one hot key lands wholly on one node and has to be answered with per-key machinery bolted onto the side.** That exception is the price of a scheme that is otherwise a hash function and a ring.

### Strengths
<!--meta polarity=pro-->

- **Resizing is cheap by construction.** The ring moves one arc when a node joins or leaves — ~20&nbsp;GB of refill, not a fleet-wide remap (see dive 1).
- **Routing costs no round trip.** The client computes the owner locally, so a cache hit is one hop and one memory lookup (see dive 6).
- **Lookups are O(1).** Get, set and delete are constant-time on the node, and eviction costs a fixed sample size (dive 3), so latency does not drift as the cache fills.
- **A node's death is a trickle, not a herd.** The replica serves everything that shipped, so the source of truth never sees a shard's worth of misses at once (see dive 2).
- Sizing is settled by one estimate — memory — and the request capacity comes free with it.
- The only agreed-on state is the member list, so the fleet coordinates kilobytes rather than terabytes.

### Risks
<!--meta polarity=con-->

- **A failover loses the writes that had not shipped.** The same window resurrects deletes that had not shipped, so a deleted key can come back with a full TTL (see dive 2).
- **Replication doubles the memory bill.** Availability here is bought with RAM — ~100 nodes instead of ~50 — and RAM is the whole cost of the system.
- **Nothing survives a restart.** A node that comes back is empty, and its share of traffic goes to the source of truth until the working set refills.
- **The hit ratio is a cliff, not a slope.** From 95% to 90% doubles origin load because the miss rate is small; the effect is a ratio, not a threshold (see Right-sizing).
- Approximate LRU occasionally evicts an entry a stricter policy would have kept, and a scan can still flush the hot set (see dive 3).
- More moving parts to operate: the ring, replication lag, the janitor's CPU and the memory ceiling all misbehave under load in different ways.
- A near-cache in the client would be the fastest layer and the one no invalidation can reach, which is why it stays deferred (see dive 5).

## What's expected at each level
<!--meta block=levels-->

### Mid-level {#levels-h3-1}

- Reaches the hash table plus doubly linked list pairing and can say why each half is needed.
- Keeps get, set, delete and eviction all O(1), and says where the constant-time claim would break.
- Stores the expiry with the value and checks it on read, rather than trusting a background job.
- Recognises that one box runs out and sketches replication and sharding as the next moves.

### Senior {#levels-h3-2}

- Runs both capacity estimates and states which one binds, instead of picking a node count.
- Rejects the modulus on what happens when the fleet resizes, not on distribution quality.
- Argues replication modes against the stated non-functionals and lands on asynchronous with the loss window named.
- Raises hot keys unprompted and separates the read fix from the write fix.
- Puts the routing table in the client and says which round trip that removes.

### Staff+ {#levels-h3-3}

- Prices the hit ratio against origin load, and treats memory as bought in hit-ratio units.
- Names the failover resurrection of a lost delete, and makes a TTL the backstop for it.
- Explains why exact LRU is refused — a write on every read — and what the sampled version gives up.
- Prices the deferred exits against their triggers: a proxy tier on client sprawl, a hot-key tier on shard skew, a near-cache only where staleness is affordable.
- Defends uniform sharding as the design's biggest flaw, chosen deliberately, and keeps hot-key detection running so the exception is found before it pages.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Hot Key](../hazards/hot-key.md) — One viral key's traffic lands on the single node that owns it; key#N copies and a client-side count-min sketch find and spread it.
- [Cache Stampede](../hazards/cache-stampede.md) — A hot key's expiry sends every reader to the origin at once; jittered TTLs and a set-if-absent refill lock turn it into one query.

**Demonstrates**

- [Distributed Cache](../patterns/caching/distributed-cache.md) — the whole system is an in-memory key-value store spread across a ~50-node fleet
- [Sharding](../patterns/distributed/routing/sharding.md) — 1TB and 100k req/s exceed one node, so the keyspace is partitioned across the fleet
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — keys sit on a hash ring so adding or removing a node remaps only one arc, not the whole cache
- [Replication](../patterns/distributed/coordination/replication.md) — each shard streams asynchronously to a replica so a lost node is not lost data
- [Batching](../patterns/concurrency/batching.md) — clients coalesce many operations — and hot-key writes — into a single network call
- [Object Pool](../patterns/gof/extra/object-pool.md) — long-lived Transmission Control Protocol (TCP) connections are pooled so no request pays a fresh handshake
- [Keep It Simple (KISS)](../principles/kiss.md) — the single-node get/set/delete is built and made correct before any distribution is layered on
- [Sweeper](../patterns/distributed/coordination/sweeper.md) — a background janitor samples keys carrying time to lives (TTLs) and reclaims the expired ones, because lazy expiry never touches a key nobody reads
- [Count-Min Sketch](../patterns/distributed/coordination/count-min-sketch.md) — hot keys are found by an approximate frequency structure on the client, since exact per-key counters at 100k req/s cost more than the traffic they measure

<!-- relationships:end -->
