---
title: Ring Buffer
description: "A fixed array used as a circle, with a write position that chases a read position, so a queue never allocates"
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, throughput, latency]
status: stable
aliases: [circular buffer, circular queue, ring queue]
solves: [my queue allocates on every message and the garbage collector pauses show up in tail latency, a burst of input makes my queue grow until memory runs out, I only need the newest N items and old ones should fall away, a producer and consumer exchange data at high rate and locks slow both]
---

# Ring Buffer

A fixed-size array used as a circular queue: the producer writes at the head, the consumer reads at the tail, and both indices wrap to the start when they reach the end.

## What it is
<!--meta block=description-->

A growing queue allocates, copies and pauses the garbage collector, and an unbounded one hides overload. A ring buffer fixes the capacity up front. Two indices chase each other around one array, a write advances the head, a read advances the tail, and nothing moves in memory. When the ring is full you must decide: block, reject or overwrite the oldest.

## Explained
<!--meta block=explain-->

A ring buffer is a fixed array used as a queue. A write stores at the head index and advances it, a read takes from the tail index and advances it, and both indices wrap to zero at the end of the array. Nothing is allocated or copied after startup, and memory is bounded by the size you chose. When the ring is full you must pick a policy: block the writer, reject the write or overwrite the oldest value. Choose it over a linked or growing queue when allocation or garbage collection shows in your latency tail, or when only the newest items matter. With one writer per index, a [lock-free](./lock-free.md) version needs no lock.

- **Capacity guess.** Size it as items arriving in a burst minus items drained in it, plus headroom. Too small drops or stalls.
- **Full has no free answer.** Blocking, rejecting and overwriting each lose something. Choose the policy deliberately.
- **Subtle lock-free code.** Memory ordering must make the slot write visible before the index write. Use a tested library.
- **False sharing.** Head and tail on one cache line make two cores fight over it. Pad them apart.

**Example.** A driver receives packets in bursts of 2,000 at 100,000 a second, so a burst lasts 20 ms. If the consumer drains nothing during the burst, all 2,000 must fit. A ring of 4,096 slots absorbs the burst with 2,096 slots to spare and never allocates. A ring of 1,024 slots overflows in the first burst and loses 976 packets under a reject policy. Doubling to 8,192 slots costs 16 KB more at 4 bytes a slot, and buys room for longer bursts. You must measure the burst up front, since the size cannot grow later.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a fixed array behave as an endless queue? Steps 2 and 5 are the wrap, and the full test at step 1 is the policy decision."
flowchart LR
    P["Producer"]
    subgraph RB["Ring buffer, N slots"]
        H[("Head: next write slot")]
        A[("Slots 0 to N-1")]
        T[("Tail: next read slot")]
    end
    C["Consumer"]
    P -->|"1 full? apply policy"| H
    H -->|"2 write slot, head = (head+1) mod N"| A
    A -->|"3 slot holds a value"| T
    C -->|"4 empty? wait or return"| T
    T -->|"5 read slot, tail = (tail+1) mod N"| A
    A -->|"6 value returned"| C
```

```mermaid caption="A ring of 4 slots fills and wraps. The fourth write fills it, a read frees slot 0, and the next write reuses that slot with no allocation."
sequenceDiagram
    participant P as Producer
    participant R as Ring (4 slots)
    participant C as Consumer
    P->>R: write a, b, c, d
    Note over R: slots 0-3 full, head wraps to 0
    P->>R: write e
    Note over P,R: full: block, reject or overwrite oldest
    C->>R: read
    R-->>C: a (slot 0)
    P->>R: write e
    Note over R: e lands in slot 0, reused
```

## Variations
<!--meta block=variations-->

- **Block when full** — The producer waits for a free slot. You get backpressure and lose nothing, and a stuck consumer stalls the producer.
- **Overwrite oldest** — A full ring drops its oldest value to take the new one. It fits logs and sensor samples where fresh data beats complete data. The producer then also moves the tail, which breaks the one-writer-per-index rule, so it needs a compare-and-swap on the tail or a lock.
- **Reject when full** — The write returns an error and the caller decides. It makes overload visible at the edge.
- **Single producer, single consumer** — Each index has one writer, so two atomics and no lock are enough. It is usually the cheapest form once head and tail sit on separate cache lines, and the one most lock-free rings use.
- **Multi-producer** — Writers claim a slot with an atomic counter, write it, then set that slot's ready flag or sequence number so readers see only finished slots. The counter is a contention point, and one writer that stalls after claiming holds back every later slot.
- **Power-of-two size** — With N a power of two, `index & (N-1)` replaces the modulo. It is a standard trick for hot rings.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No allocation after startup** — the array is allocated once, so a write is a store and an index bump, with no garbage collection pressure. This holds while slots hold values; a ring of pointers still allocates each item.
- **Bounded memory by construction** — the capacity is a number you chose, so overload cannot grow the heap.
- **Cache friendly** — values sit next to each other in one array, so sequential reads stay in cache.
- **Lock-free for one producer and one consumer** — each index has one writer, so two atomic variables are enough.

### Cons
<!--meta polarity=con-->

- **Capacity is a guess** — too small drops or stalls under a burst, too large hides lag, so size it as items arriving in a burst minus items drained in it, plus headroom.
- **Full has no free answer** — blocking, rejecting and overwriting each lose something, so pick the policy on purpose.
- **A lock-free ring is subtle** — the index writes need correct memory ordering, so use a tested library.
- **False sharing slows it** — head and tail on one cache line make two cores fight, so pad them apart.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A producer and a consumer pass data at high rate** and allocation or garbage collection shows in the latency tail.
- **You need a bounded queue with a known memory ceiling**, such as in a driver, an audio path or a logger.
- **Only the newest N items matter**, such as the last 1,000 log lines or the last second of samples.
- **One producer and one consumer** let you skip locks.

### Avoid when
<!--meta polarity=avoid-->

- **The queue must grow without limit** — a ring has a fixed size, so use an unbounded list and watch its depth.
- **Items vary widely in size** — fixed slots waste space, so store pointers or use a byte-ring with lengths.
- **Many producers and many consumers share it** and you cannot use a tested library — a [mutex](./mutex.md)-guarded queue is easier to get right.
- **Throughput is low** — a plain [producer-consumer](./producer-consumer.md) queue is enough, and simpler.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a single-producer, single-consumer ring with power-of-two masking"
type Ring struct {
	buf        []int
	mask       uint64        // len(buf)-1; len must be a power of two
	head, tail atomic.Uint64 // head: producer only; tail: consumer only; pad onto separate cache lines in production
}

func NewRing(n int) *Ring { // n must be a power of two
	return &Ring{buf: make([]int, n), mask: uint64(n - 1)}
}
// Put is called by one goroutine only. It returns false when the ring is full.
func (r *Ring) Put(v int) bool {
	h := r.head.Load()
	// counters run free: h-t == len means full, h == t means empty
	if h-r.tail.Load() == uint64(len(r.buf)) {
		return false // full: reject policy
	}
	r.buf[h&r.mask] = v // write the slot first...
	r.head.Store(h + 1) // ...then publish it; Go atomics are sequentially consistent, so the slot write is visible first
	return true
}

// Get is called by one goroutine only. It returns false when the ring is empty.
func (r *Ring) Get() (int, bool) {
	t := r.tail.Load()
	if t == r.head.Load() {
		return 0, false
	}
	v := r.buf[t&r.mask]
	r.tail.Store(t + 1) // free the slot for the producer
	return v, true
}
```

## In the wild
<!--meta block=wild-->

- **LMAX Disruptor** — A Java library built around a pre-allocated ring of entries, with sequence numbers claimed by producers and read by consumers. It was built for low-latency trading. {#wild-lmax-disruptor}
- **Linux kfifo** — The kernel helper for a fixed-size FIFO over a circular buffer, used by drivers to pass bytes between a producer and a consumer. {#wild-linux-kfifo}
- **Linux io_uring** — Application and kernel share a submission ring and a completion ring, so many requests and results cross per system call, and none need a call when kernel-side polling is on. {#wild-linux-io-uring}

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Streaming](../../themes/streaming.md) — Hold the queue between a producer and a consumer in a fixed circular array. {#fluency-streaming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Lock-Free](./lock-free.md) — One producer and one consumer let the two indices be atomics with no lock
- [Backpressure](./backpressure.md) — The full-ring policy of blocking or rejecting is where backpressure is applied

**Specializes**

- [Producer-Consumer](./producer-consumer.md) — A fixed circular array is the bounded queue between producer and consumer

**Prevents**

- [Unbounded Queue](../../hazards/unbounded-queue.md) — A fixed capacity rules out unbounded growth, at the cost of a policy for a full ring

<!-- relationships:end -->
