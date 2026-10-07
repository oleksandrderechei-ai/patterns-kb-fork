---
title: Write-Behind
description: "Writes hit the cache now, the store catches up later"
area: caching
owner: Oleksandr Derechei
tags: [caching, throughput, batching, durability]
status: stable
aliases: [write-back]
solves: [every button click waits for a database commit before the UI responds, my database is drowning in millions of tiny single-row inserts, a view counter fires thousands of times a second and I am writing every single increment to disk, traffic spiked and writes backed up because the store cannot ingest that fast, I overwrite the same record fifty times a minute and only the last value actually matters]
---

# Write-Behind

Writes hit the cache and return immediately, while the matching update to the backing store is queued and flushed asynchronously — the store catches up on its own schedule, not the caller's.

## What it is
<!--meta block=description-->

A write-through cache pays the database's full latency on every write, and under heavy write volume the database becomes the bottleneck first. A write-behind cache, also called write-back, updates its own memory, answers the caller at once and saves to the database later, on a timer or when a batch fills.

## Explained
<!--meta block=explain-->

A write-behind cache, also called write-back, accepts a write into its own memory, answers the caller at once and saves it to the database later, on a timer, when a batch fills or when the entry is evicted. Until the save, the cache holds the most current copy. Writes run at memory speed, a flood of writes smooths into a steady trickle, and several writes to the same key before a save collapse into one database write of the last value. Choose it over [write-through](write-through.md), which saves to the database before answering, when write volume is the bottleneck and the database cannot take small writes fast enough.

- **Unsaved data dies with the process.** Keep the queue on disk or replicated, and use write-through for data that must be safe at once.
- **Direct readers see old values.** Readers that go straight to the database see old data until the save, so send reads through the cache.
- **The saver needs its own care.** Retry in order per key and alert when the backlog grows.
- **Cache and database disagree.** Cap how long an entry may stay unsaved.

**Example.** A game takes 5,000 score updates a second on 500 hot players, and the database handles 1,000 writes a second. Written straight through, it would be 5 times over capacity. A write-behind cache that saves every 2 s collects 10,000 updates per flush, collapses them to the last value for each of the 500 players and sends 500 writes, which is 250 a second. The cost is a crash: everything since the last flush is gone, up to 2 s of updates, and more while a flush is slow or failing, so keep the queue on disk if losing that is not acceptable.

## How it works
<!--meta block=structure-->

```mermaid caption="How long does the data live only in memory? From step 3 to step 6. Everything sitting in the subgraph has been acknowledged to the caller but not written down, so a crash there erases it — flush interval times write rate is the size of that loss."
flowchart LR
    App["Application code"]:::ext
    Cache[("Cache")]
    subgraph Window["Acknowledged, not yet durable"]
        Queue[("Dirty-write queue")]
    end
    Flusher["Flusher"]
    Store[("Database")]
    App -->|"1 write price:42"| Cache
    Cache -->|"2 queue it, coalesced by key"| Queue
    Cache -->|"3 ack — before anything is durable"| App
    Flusher -->|"4 drain on a timer or a full batch"| Queue
    Flusher -->|"5 one batched write"| Store
    Store -->|"6 durable — the window closes"| Flusher
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Why does the client get its ack before durability, and what is at risk if the cache crashes before the queue flushes to the store?"
sequenceDiagram
    autonumber
    participant C as Client
    participant Ca as Cache
    participant Q as Write queue
    participant DB as Store
    C->>Ca: write(key, value)
    Ca->>Q: enqueue, coalesced by key
    Ca-->>C: ack, before durability
    alt flush succeeds
        Q->>DB: flush batch, later
        DB-->>Q: ack, now durable
    else cache crashes before flush
        Q--xDB: unflushed writes lost
    end
```

## Variations
<!--meta block=variations-->

- **Time-based flush** — Drain the queue every N milliseconds regardless of size. Data waits at most N while the store accepts writes; during an outage the wait grows.
- **Size- or count-based flush** — Flush once the dirty set reaches a threshold, so the store sees fewer, larger, more efficient writes under sustained load.
- **Write coalescing** — Multiple writes to the same key before a flush collapse into one — the store only ever sees the final value, never the intermediates.
- **Durable write queue** — Back the pending-writes queue with disk or replication so a cache crash doesn't silently drop unflushed data — trades some latency back for safety.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Write latency is cache-speed** — with a memory-only queue; a durable queue adds its own disk or replication latency, though not the store's.
- **Absorbs write bursts**, smoothing spiky load into a steady trickle to the store.
- **Coalescing collapses repeated writes** to a [hot key](../../hazards/hot-key.md) into a single store write.
- **Frees the store to batch writes**, which pays when its per-call overhead dominates, as with a network round trip or a transaction commit.

### Cons
<!--meta polarity=con-->

- **A crash between ack and flush loses data**, unless the queue itself is durable.
- **Readers that bypass the cache** and hit the store directly see stale values until flush.
- **The flush pipeline needs its own retry**, ordering, and failure handling.
- **The system of record briefly disagrees with itself** — harder to reason about and debug.
- **A slow or down store fills the pending queue** — once it is full the cache must block writers or shed load.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Write volume is high** and the store's latency or throughput is the bottleneck.
- **Losing the very latest writes** on a crash is tolerable, or the cache is itself durable.
- **Writes to the same keys repeat often**, so coalescing before flush pays off; a coalesce ratio near 1 means no gain over write-through.

### Avoid when
<!--meta polarity=avoid-->

- **Every write must be durable** the instant it's acknowledged — ledgers, audited transactions.
- **Readers elsewhere in the system** need the store itself to be immediately consistent.
- **The write volume doesn't justify the risk** — a plain [Write-Through](./write-through.md) cache is safer and simpler.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal write-behind cache"
interface Store<K, V> { save(key: K, value: V): Promise<void>; }

class WriteBehindCache<K, V> {
  private data = new Map<K, V>();
  private dirty = new Set<K>();
  private flushing = false;

  constructor(private readonly store: Store<K, V>, flushMs = 2_000) {
    setInterval(() => this.flush(), flushMs);
  }

  write(key: K, value: V): void {
    this.data.set(key, value);
    this.dirty.add(key);        // acknowledged now, not yet in the store
  }

  read(key: K): V | undefined {
    return this.data.get(key);  // cache is the record until flush runs
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;            // no overlapping flushes
    this.flushing = true;
    try {
      await Promise.allSettled([...this.dirty].map(async (k) => {
        const v = this.data.get(k)!;
        await this.store.save(k, v);
        if (this.data.get(k) === v) this.dirty.delete(k); // only a saved key leaves dirty
      }));                                 // a failed save stays in dirty and retries next tick
    } finally { this.flushing = false; }
  }
}
```

## In the wild
<!--meta block=wild-->

- **Linux page cache** — A write() returns as soon as the page is marked dirty in memory; kernel writeback (flusher) threads drain dirty pages to disk later, tuned by vm.dirty_ratio and vm.dirty_writeback_centisecs, unless fsync forces the flush sooner. {#wild-linux-page-cache}
- **CPU write-back caches** — A store marks the cache line dirty and main memory is updated only when the line is evicted or a coherence protocol like MESI demands it, collapsing repeated writes to one address into a single memory write. {#wild-cpu-writeback-cache}
- **Hazelcast MapStore (write-behind mode)** — With write-delay-seconds set above zero, the distributed IMap acks put() immediately and batches entries to the MapStore on that delay; write-coalescing merges repeated writes to a key and write-batch-size groups them. {#wild-hazelcast-mapstore}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Flush interval / write delay** — How long acked writes wait in the queue before draining to the store; a longer delay coalesces more but widens the loss window (Hazelcast MapStore write-delay-seconds).
- **Batch size** — The dirty-set count that triggers a flush regardless of time, so the store sees fewer, larger writes under sustained load.
- **Queue capacity** — The bound on pending unflushed writes; when full the cache must block writers or shed load, capping how far the store can fall behind.
- **Queue durability** — Whether the pending-writes queue is memory-only or persisted and replicated (disk or a write-ahead log); durability trades write latency back for crash safety.
- **Flush retry and ordering** — How failed store writes are retried and kept in order, so a transient store outage doesn't drop or reorder queued writes.

### Signals to watch
<!--meta polarity=signal-->

- **Queue depth** — Unflushed entries waiting to drain; a steadily rising depth means the store can't keep up and the loss window is growing.
- **Flush throughput and latency** — How many entries a drain moves and how long it takes; falling throughput against a rising queue signals the store is the bottleneck.
- **Flush failure rate** — Store writes that error and re-queue; sustained failures mean acked data is stuck in a volatile queue and at risk.
- **Coalesce ratio** — Writes accepted versus writes actually sent to the store; a high ratio confirms hot-key coalescing pays off, a low one means little gain over write-through.

### Failure modes under load
<!--meta polarity=failure-->

- **Data loss on crash before flush** — Anything acked but not yet drained lives only in the cache; a crash erases it unless the queue is durable.
- **Queue overflow under sustained write load** — If writes arrive faster than flushes drain for long enough, the bounded queue fills and the cache must block writers or drop data.
- **Stale reads straight from the store** — A reader that bypasses the cache and hits the store directly sees pre-flush values; the record disagrees with itself until the drain.
- **Flush-failure backlog** — A store outage stalls draining; the queue grows and the loss window widens until the store recovers or the queue overflows.

### Readiness checklist
<!--meta polarity=check-->

- The maximum data-loss window (flush interval times write rate, in updates) is written down and accepted, or the queue is durable
- The pending-writes queue is bounded with a defined full behavior — block writers or shed load
- Flush failures retry with write ordering preserved and are never silently dropped
- Queue depth and flush-failure rate are alerted on before the queue saturates
- Readers that must see committed data go through the cache, not the store, until the flush completes

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Performance](../../themes/performance.md) — Make writes feel instant {#fluency-performance}
- [Caching](../../themes/caching.md) — Make writes feel instant {#fluency-caching}

<!-- fluency:end -->

## Check yourself
<!--meta block=selfcheck-->

> **What do you lose if the cache crashes after acknowledging a write?**
>
> Writes not yet flushed, unless the queue itself is durable, see [con 1](write-behind.md#tradeoffs-con-1).

> **Which readers see stale data, and until when?**
>
> Those that bypass the cache and read the store directly, until the next flush, see [con 2](write-behind.md#tradeoffs-con-2).

> **When is write-through the better choice?**
>
> When every write must be durable the moment it is acknowledged, see [avoid 1](write-behind.md#usage-avoid-1).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Batching](../concurrency/batching.md) — Queued writes are flushed as a batch to cut round-trips to the store

**Alternative to**

- [Write-Through](./write-through.md) — Write now, consistent vs. write later, faster

**Demonstrated by**

- [Strava](../../designs/strava.md) — the on-device buffer is write-behind moved onto the client — acknowledge to the athlete now, reconcile with the server later
- [YouTube](../../designs/youtube.md) — A view counter is the write-behind shape at its purest: lossy-tolerant, batched, hot

<!-- relationships:end -->
