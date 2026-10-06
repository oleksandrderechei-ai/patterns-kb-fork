---
title: Lock-Free
description: Update shared memory with an atomic retry loop instead of a lock
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, throughput]
status: stable
aliases: [non-blocking, non-blocking algorithm]
solves: [a hot counter is contended by every thread and the mutex is the bottleneck, my worker threads spend more time waiting for the lock than doing work, one thread being descheduled while holding the lock stalls everything behind it, I need a queue several threads can push to without any of them blocking, "profiling shows almost all the time in lock acquisition, not in the critical section"]
---

# Lock-Free

Many threads update the same word of memory by reading it, computing a new value, and committing with one atomic instruction that lands only if nobody else wrote first.

## What it is
<!--meta block=description-->

A lock turns progress into the property of whoever holds it: if the holder is paused mid-update, every other thread queues behind it. Lock-free code avoids the lock. A thread reads a shared word, computes the new value, and commits with one atomic compare-and-swap instruction that writes only if the word is unchanged. If it lost a race, it re-reads and tries again.

## Explained
<!--meta block=explain-->

Lock-free code changes shared data with an atomic compare-and-swap: you read the current value, compute the new one, and ask the CPU to store it only if the value is still what you read. If another thread got there first, the swap fails and you retry. No thread holds a lock, so a paused or killed thread never blocks the others, and the system as a whole keeps moving. Choose it over a lock-based [monitor object](monitor-object.md) for a counter, stack or queue on a hot path that cannot afford a thread sleeping while it holds a lock, and only when the whole change fits in one word of memory.

- **ABA problem** A value that goes A to B and back to A passes the check wrongly; attach a counter that only goes up.
- **Memory reclamation** You cannot free a node another thread may still read; use hazard pointers, epoch-based reclamation or a garbage-collected language.
- **Contention** Under heavy contention retries can lose to a mutex, so measure at your real thread count.
- **Memory ordering** Ordering bugs appear on only some CPUs; use the language atomics with explicit ordering.

**Example.** Eight threads add to one shared counter in a tight loop. With a mutex, the OS pauses the thread that holds the lock for 10 ms, and the other seven wait the full 10 ms doing nothing. With compare-and-swap, a paused thread holds nothing, so the other seven keep counting. The cost shows in the worst case: if all eight read the same value and swap at once, one wins and seven fail and redo the work, and the cache line bounces between cores. If that repeats every round, most attempts fail. For a plain counter, fetch-and-add does the job with no failures, and so does one counter per thread added up at the end.

## How it works
<!--meta block=structure-->

```mermaid caption="How do many threads update one word without any of them holding a lock? Steps 2 and 3 run with nothing held, and step 4 is the only moment that can change the word — one instruction that either applies whole or does nothing at all."
flowchart LR
    Read["Read the shared word"]
    Compute["Compute the new value from it"]
    subgraph Atomic["One atomic instruction"]
        CAS{"Word still holds what you read?"}
        Word[("Shared word")]
    end
    Done["Committed — your value is visible"]
    Word -->|"1 load current value"| Read
    Read -->|"2 old value in hand"| Compute
    Compute -->|"3 offer old and new"| CAS
    CAS -->|"4 compare, write if unchanged"| Word
    Word -->|"5 applied"| Done
    CAS -->|"6 changed: nothing written"| Read
```

```mermaid caption="What happens to the loser of a race? B's swap is rejected because the word no longer holds what B read, so B recomputes from 8 and commits 9 — no update is lost, and neither thread ever waits for the other."
sequenceDiagram
    participant A as Thread A
    participant W as Shared word, starts at 7
    participant B as Thread B
    A->>W: read 7
    B->>W: read 7
    A->>W: swap 7 for 8
    W-->>A: applied, word is 8
    B->>W: swap 7 for 8
    W-->>B: rejected, word is 8
    B->>W: read 8
    B->>W: swap 8 for 9
    W-->>B: applied, word is 9
```

## Variations
<!--meta block=variations-->

- **Compare-and-swap retry loop** — The general shape: load the current value, compute a replacement from it, swap it in only if the load is still current, and start over on rejection. It closes the read-modify-write [race condition](../../hazards/race-condition.md) without a lock, and most lock-free structures are built from it.
- **Atomic counters and fetch-and-add** — When the new value depends only on the old one by a fixed amount, the hardware does the whole read-modify-write in one instruction and there is no loop to retry. An atomic increment cannot fail, so contention costs you waiting for the cache line and never recomputation you throw away — reach for it before the general loop whenever the update is plain arithmetic, a bit set, or a bit clear.
- **Lock-free queues and stacks** — The same swap applied to a link pointer builds whole containers: the Treiber stack points a new node at the current head and swaps the head to it, and the Michael–Scott queue does the equivalent at both ends with a two-step append that any thread can finish on the owner's behalf. That helping step is what keeps the structure moving when a producer stalls mid-insert.
- **Wait-free, lock-free, obstruction-free** — Three progress guarantees, strongest first. Wait-free means every thread completes in a bounded number of its own steps, so no thread can be starved. Lock-free means some thread always completes, which permits an unlucky thread to retry forever while others make progress. Obstruction-free means only that a thread completes if it eventually runs without interference. Most published algorithms, and most of what a library gives you, are lock-free rather than wait-free — check which one you were sold before you promise a latency bound.
- **Publish by pointer swap** — Build the new version of a structure off to one side where no other thread can see it, then swap one pointer to make the whole thing visible at once — [Copy-on-Write](./copy-on-write.md) published atomically. Readers need no lock, only an acquire load of the pointer, because they only ever see a complete version, old or new, and writers serialize on that single swap. Knowing when the old version is safe to free is the memory reclamation problem.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No thread can stall another by being descheduled** — the system keeps advancing even when the scheduler stops a thread mid-operation.
- **Nothing is acquired**, so there is no acquisition order to get wrong and no [deadlock](../../hazards/deadlock.md) to design against.
- **On a lightly contended word**, one atomic instruction replaces an acquire-and-release pair that costs more than the update it guards.
- **Usable where blocking is forbidden** — an audio callback or a signal handler cannot wait on a mutex, but it can complete an atomic operation.

### Cons
<!--meta polarity=con-->

- **The ABA problem**: a word that changes to something else and back reads as untouched, so the swap succeeds on a value whose meaning has moved. Tag the pointer with a counter that only increments, or protect it with a hazard pointer.
- **Memory reclamation is the hard part**. You cannot free a node while another thread may still be reading it, so a lock-free container needs epoch-based reclamation, hazard pointers, or a garbage collector that solves it for you.
- **Under heavy write contention** the retry loop can be slower than a mutex: every attempt drags the cache line to another core, and losers burn CPU retrying instead of parking.
- **Lock-free is a progress guarantee**, not a speed guarantee. It promises the system as a whole advances; it promises nothing about any individual thread's latency, and nothing about being faster than a lock.
- **Correctness depends on memory ordering**. Compiler and CPU both reorder around ordinary loads and stores, so each operation needs the right acquire, release or sequentially-consistent annotation — and the bugs appear only on some hardware, under some load.
- **The atomicity covers one word** — two adjacent ones where the hardware offers a double-width swap, and no more. An invariant spanning independent locations still needs a lock, or a whole new version published behind a single pointer.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A small piece of shared state** — a counter, a flag, a queue head — is touched by many threads, and profiling puts the time in lock acquisition rather than in the critical section.
- **No participant may block**: an audio or control loop, a signal handler, an interrupt path, or any code that must not call into the scheduler. A deadline holds only with a wait-free operation or a bounded retry; a plain lock-free loop gives no latency bound.
- **One slow thread** must not be able to freeze the rest — a pipeline stage that stalls should cost its own work, not everybody's.
- **A tested library already offers the structure** you need — a concurrent queue, an atomic counter, an atomic reference. Using one is the normal way to adopt this pattern.

### Avoid when
<!--meta polarity=avoid-->

- **Most of the time**. A [Monitor Object](./monitor-object.md) is correct by inspection, reviewable by anyone on the team, and frequently faster — take it unless you can name the reason it fails you.
- **The update spans more than one location**, or the critical section calls anything that waits. Neither fits in a single atomic instruction. Allocate a node before the swap, as the Treiber stack does, never inside the retried step.
- **Contention is heavy and nearly every operation writes**: the losers spin and the cache line ping-pongs between cores, where a lock would have parked them cheaply.
- **You would be writing the algorithm yourself** for anything past a counter or a flag, without a memory model in your head and a stress test on real hardware. Take the library's version.
- **The state can be partitioned instead** — [Thread Confinement](./thread-confinement.md) removes the sharing rather than making it cheaper, and unshared state needs no atomics at all.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a retry loop over one word of shared memory"
// One word of shared memory. Nothing else is shared.
var slot atomic.Int64

// Read, compute, commit-if-unchanged. Nothing is held between the steps, so a
// goroutine descheduled here blocks nobody: it just loses the next swap.
func applyAtomically(update func(seen int64) int64) int64 {
	for {
		seen := slot.Load()
		next := update(seen)
		// CompareAndSwap writes next only if the slot still holds seen.
		if slot.CompareAndSwap(seen, next) {
			return next
		}
		// Someone committed first, so next was computed from a value that
		// no longer exists. Discard it and read the new one.
	}
}

// The loop is the general shape. For plain arithmetic skip it: Add is one
// hardware instruction that cannot fail.
func increment() { slot.Add(1) }
```

## In the wild
<!--meta block=wild-->

- **java.util.concurrent.atomic** — `AtomicInteger`, `AtomicLong` and `AtomicReference` expose the hardware directly: `compareAndSet(expect, update)` is the swap, and `getAndIncrement()` is the unconditional fetch-and-add that needs no retry loop. The package also ships `AtomicStampedReference`, which carries an integer stamp alongside the reference precisely so an equality check cannot be fooled by a value that leaves and comes back. {#wild-jdk-atomic}
- **Java ConcurrentLinkedQueue** — An unbounded thread-safe queue whose documentation names its source algorithm: the non-blocking concurrent queue of Michael and Scott. Producers and consumers advance the head and tail pointers with atomic swaps, so no operation blocks another, and the garbage collector handles the node reclamation a manual implementation would have to solve for itself. {#wild-jdk-concurrent-linked-queue}
- **C++ std::atomic** — `compare_exchange_strong` and `compare_exchange_weak` are the swap, each taking a memory ordering as an argument so the barrier is stated rather than assumed; the weak form may fail spuriously and is meant to sit inside a retry loop. `is_lock_free()` answers the question the type alone cannot: whether the target CPU handles this width atomically, or the library falls back to a hidden lock. {#wild-cpp-std-atomic}
- **LMAX Disruptor** — A ring buffer for handing events between threads in which a producer claims a slot by advancing a shared sequence counter with an atomic swap instead of taking a lock. Its sequence fields are padded so that two counters never share a cache line, which is the concern that dominates once the swap itself is cheap. {#wild-lmax-disruptor}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **memory ordering per operation** — Each atomic read, write and swap carries the ordering it needs — relaxed, acquire/release, or sequentially consistent (`std::memory_order` in C++, the access mode of a `VarHandle` in Java). Weaker orderings let the compiler and CPU reorder more and cost less; they are also where the bugs live, so weaken one only when you can say what it still guarantees.
- **backoff between failed attempts** — Whether a losing thread retries immediately, issues a spin-wait hint first (`Thread.onSpinWait()`), or backs off for a growing interval. Immediate retry is fastest when contention is light and is exactly what collapses throughput when it is not.
- **padding and alignment of the contended word** — Two counters that land on one cache line are contended as if they were one variable, whatever the code says. Padding each to its own line trades memory for the coherence traffic it removes.
- **the reclamation scheme** — For any structure that frees nodes: hazard pointers, epoch-based reclamation, or a garbage collector. This decides more about the implementation than the swap does, so choose it before writing the algorithm rather than after.

### Signals to watch
<!--meta polarity=signal-->

- **retries per successful operation** — Count failed swaps against completed ones. Near zero means the optimistic bet is paying; a rising ratio means threads are now spending their time recomputing values they will throw away.
- **throughput against thread count** — Plot completed operations as you add threads. A curve that flattens and then falls is the contention signature, and it is the measurement that decides between this and a lock.
- **cache misses on the contended line** — CPU performance counters attribute coherence traffic to the hot address. Misses climbing while the retry count stays flat points at false sharing rather than at real contention.
- **retired-but-not-yet-freed nodes** — In a hazard-pointer or epoch scheme, the depth of the pending-reclamation list. It should oscillate around a bound; a monotonic climb means some thread is not letting the epoch advance.

### Failure modes under load
<!--meta polarity=failure-->

- **retry collapse under write contention** — Every attempt pulls the cache line to a different core, so more threads produce more failed swaps rather than more work. Throughput falls as you add threads, and the profile shows the CPUs fully busy while completed operations sink well below the single-thread rate.
- **false sharing** — An unrelated variable sharing the cache line makes an uncontended word behave like a contended one. It looks like inexplicable contention on a value only one thread writes.
- **reclamation stall** — In an epoch scheme, one thread parked inside a read section pins the epoch, so nothing retired after it can be freed; a held hazard pointer pins only the node it names. Memory grows steadily under load and the process is killed for its footprint, not for anything the algorithm did wrong.
- **starvation of one thread** — Lock-free guarantees that some thread completes, not that yours does. Under sustained load a slow or unlucky thread can lose every race, which an aggregate throughput number hides completely — watch the tail latency, not the mean.

### Readiness checklist
<!--meta polarity=check-->

- Use a library structure wherever one exists, and hand-roll only past a counter or a flag — with a stress test on the hardware you ship on.
- Benchmark against a plain mutex at the real thread count before adopting; the lock wins often enough that skipping this step is how the slower option gets shipped.
- Choose the reclamation scheme before writing the algorithm, and know which thread is allowed to free a node.
- Prove the ABA case impossible, or carry a monotonic tag or a hazard pointer that makes it so.
- State the ordering on every atomic operation and justify any that is weaker than sequentially consistent where it is written.
- Bound the retry loop with a backoff, so contention degrades throughput smoothly instead of collapsing it.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Update shared memory with an atomic retry loop instead of a lock. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Copy-on-Write](./copy-on-write.md) — The pointer swap that publishes a new copy is a single atomic compare-and-swap
- [Ring Buffer](./ring-buffer.md) — Lock-free queues often use a ring as their storage

**Alternative to**

- [Monitor Object](./monitor-object.md) — One lock across the critical section, or no lock and a retry loop
- [Mutex](./mutex.md) — Updates shared data with atomic operations and no lock, so no caller waits for a lock holder
- [Thread Confinement](./thread-confinement.md) — Makes the shared word cheap to update; confinement removes the sharing so no atomics are needed

**Often confused with**

- [Conditional Write](../distributed/coordination/conditional-write.md) — Same compare-and-swap idea at a different scope: a word in memory, not a row in a store
- [Optimistic Concurrency Control](../distributed/coordination/optimistic-concurrency-control.md) — The same read-verify-retry shape, but within one process and over a single word

**Prevents**

- [Deadlock](../../hazards/deadlock.md) — No locks are held, so no cycle of waiters can form

**Exposed to**

- [Premature Optimization](../../hazards/premature-optimization.md) — Can fall into premature optimization when complex lock-free structures are built for a contention nobody measured

<!-- relationships:end -->
