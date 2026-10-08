---
title: Barrier
description: "Every thread waits at a point until all have arrived, then all continue together"
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, throughput]
status: stable
aliases: [cyclic barrier, rendezvous]
solves: ["workers read partial results from a round that has not finished, so every phase mixes old and new data", I need all workers to finish step one before any of them starts step two, my parallel loop gives wrong answers because the next round starts before the last one ends, "threads work in rounds and I restart them every round, which costs too much"]
---

# Barrier

A meeting point for a fixed group of threads: each one waits there until all have arrived, then all continue together.

## What it is
<!--meta block=description-->

A job split across workers often runs in phases, and phase two needs every worker's phase-one result. With no stopping point, a fast worker starts phase two and reads data a slow worker has not written yet, so the output is wrong and nothing reports an error. A barrier holds each arriving thread until a set number have arrived, then releases them all at once. No thread starts the next phase before every thread has finished the last.

## Explained
<!--meta block=explain-->

A barrier is a meeting point for a fixed group of threads. Each thread that reaches it waits, and when the last one arrives all of them continue together. Without it, a fast thread starts the next phase and reads results a slow thread has not written yet, which gives wrong output with no error. Choose it over ending and restarting the threads when the same group repeats the phase many times, because the threads and their local state stay alive. Choose a [semaphore](./semaphore.md) instead when you only cap how many threads enter, not when they all move on together.

- **Slowest thread sets the pace.** Every other thread idles until it arrives. Cut the work into smaller equal chunks so arrivals bunch up.
- **A missing thread hangs the rest.** One crash leaves the others parked forever. Use a timed wait and treat a timeout as a broken barrier.
- **Fixed party count.** A wrong count hangs the group or releases it early. Use a phaser-style barrier when threads join or leave.

**Example.** Eight threads run a simulation with 10 ms of work per step each. One thread gets a heavier slice and needs 40 ms. A barrier holds the other seven for 30 ms every step, so a step takes 40 ms and the group does 110 ms of work in 8 x 40 = 320 ms of thread time, about 34% busy. Spreading the heavy slice's extra 30 ms evenly over all eight threads brings each step to about 14 ms (110 / 8 = 13.75) and the busy share above 90%. The cost is more code to split and merge the slice, and a second barrier if the merge must finish before the next step starts.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a group of threads stay in step? Steps 2 and 3 are the whole pattern: every arrival is counted and parked, and only the last arrival in step 4 opens the gate for all of them."
flowchart LR
    W["Worker threads"]
    subgraph B["The barrier"]
        C[("Arrived count, out of N")]
        P[("Parked threads")]
    end
    N["Next phase"]
    W -->|"1 finish this phase's work"| C
    C -->|"2 count below N: park the thread"| P
    C -->|"3 count reaches N: last arrival"| P
    P -->|"4 release every parked thread together"| W
    W -->|"5 start the next phase"| N
    N -->|"6 reach the barrier again"| C
```

```mermaid caption="Three workers finish at different times. A and B park on arrival, and C, the slowest, opens the gate for all three."
sequenceDiagram
    participant A as Worker A
    participant B as Worker B
    participant C as Worker C
    participant X as Barrier
    A->>X: wait()
    Note over A,X: A parks, 1 of 3
    B->>X: wait()
    Note over B,X: B parks, 2 of 3
    C->>X: wait()
    Note over C,X: C is the third arrival
    X-->>A: released
    X-->>B: released
    X-->>C: released
    Note over A,C: all three start the next phase
```

## Variations
<!--meta block=variations-->

- **Cyclic barrier** — The barrier resets after each release, so the same group reuses it for every phase of a loop. Java names it `CyclicBarrier`, and the reset needs a generation count so a fast thread cannot lap the slow ones.
- **One-shot latch** — Waiters block until a count of events reaches zero, and the counting threads do not wait for each other, so a latch is a neighbour of the barrier rather than a form of it. Java's `CountDownLatch` opens once only; Go's `sync.WaitGroup` can be reused once its count returns to zero.
- **Barrier action** — One piece of code runs exactly once when the last thread arrives and before anyone is released. It suits merging the phase's partial results.
- **Phaser** — The number of parties can change between phases, so threads may join or leave. Java's `Phaser` lets parties join and leave between phases; C++20's `std::barrier` lets a thread leave with `arrive_and_drop` but not join.
- **Combining-tree barrier** — Arrivals are counted up a tree of small counters instead of one shared counter, which removes the hot spot when hundreds of threads arrive together.
- **Async barrier** — A task awaits the barrier instead of blocking a thread, so a runtime with few threads can hold thousands of waiting tasks.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Phases cannot overlap** — no thread reads a neighbour's result before it is written, so phase-by-phase algorithms need no per-item locks. Writes made before the barrier are visible to every thread after it, so plain reads in the next phase are safe.
- **Threads stay alive between phases** — the same workers and their local state run every round, with no spawn and join cost each time.
- **One mechanism for all workers** — the code states the dependency as a single call, which is easier to check than flags and polling.
- **No polling** — a parked thread sleeps until the last arrival, so a blocking barrier costs no CPU while it waits. A spinning barrier trades CPU for faster wake-up, and spinning with more threads than cores stalls; OpenMP exposes the choice as `OMP_WAIT_POLICY` (`ACTIVE` or `PASSIVE`).

### Cons
<!--meta polarity=con-->

- **The slowest thread sets the pace** — every other thread idles until it arrives; split the work into smaller equal chunks so arrivals bunch up.
- **A thread that never arrives hangs the rest** — one crash or early return leaves N-1 threads parked; use a timed wait and a broken-barrier signal.
- **The party count is fixed** — a wrong count, or a thread added later, hangs or releases too early; a phaser-style barrier lets the count change.
- **Every phase ends in a full stop** — each barrier is a synchronization point where nothing runs ahead, so use as few as the algorithm needs.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Your threads work in lock-step rounds** — a simulation step, a solver iteration, a map pass then a reduce pass.
- **Each phase reads what every thread wrote in the last one** — a grid update that needs the neighbours' new values.
- **The same group runs many rounds** — respawning threads each round costs more than parking them.

### Avoid when
<!--meta polarity=avoid-->

- **The work splits once and merges once** — [fork-join](./fork-join.md) waits at the end only, with no repeated stop.
- **Work items are independent** — a [thread pool](./thread-pool.md) with a queue keeps every thread busy and needs no meeting point.
- **Thread speeds differ a lot** — the fast threads spend most of each round idle; give the slow thread less work or drop the barrier.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a reusable barrier built on a condition variable"
var ErrBroken = errors.New("barrier broken")

type Barrier struct {
	mu      sync.Mutex
	cond    *sync.Cond
	parties int  // N threads that must arrive
	waiting int  // how many have arrived this round
	gen     int  // round number, so a fast thread cannot lap the others
	broken  bool // set by Break; every Wait then fails
}

func (b *Barrier) Wait() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.broken {
		return ErrBroken
	}
	gen := b.gen
	b.waiting++
	if b.waiting == b.parties { // last arrival opens the gate
		b.waiting = 0
		b.gen++
		b.cond.Broadcast()
		return nil
	}
	for gen == b.gen && !b.broken {
		b.cond.Wait() // re-check: a wake-up can come with no Broadcast
	}
	if gen == b.gen {
		return ErrBroken
	}
	return nil
}

// Break fails every waiter at once: call it from a timer for a timeout, or from a worker that crashes.
func (b *Barrier) Break() {
	b.mu.Lock()
	b.broken = true
	b.cond.Broadcast()
	b.mu.Unlock()
}

// NewBarrier sets cond = sync.NewCond(&b.mu). Each worker calls Wait() once per step.
```

## In the wild
<!--meta block=wild-->

- **Java CyclicBarrier** — In `java.util.concurrent`: threads call `await`, an optional action runs once when the last one arrives, and the barrier resets for the next round. A timeout or interrupt breaks it for every waiter. `Phaser` in the same package lets the party count change. {#wild-java-cyclicbarrier}
- **POSIX pthread_barrier_t** — The C barrier: `pthread_barrier_init` takes the thread count and `pthread_barrier_wait` blocks. Exactly one waiter gets the return value `PTHREAD_BARRIER_SERIAL_THREAD`, which suits a once-per-round merge. {#wild-pthread-barrier}
- **C++20 std::barrier** — A reusable barrier with a completion function that runs once per phase. `std::latch` is the one-shot form. {#wild-cpp-std-barrier}
- **Python threading.Barrier** — Takes a party count and an optional timeout. `abort` or a timeout puts it in a broken state, and waiters then raise `BrokenBarrierError`. {#wild-python-threading-barrier}
- **OpenMP barrier** — The `#pragma omp barrier` directive holds every thread of a parallel region until all arrive. Many worksharing constructs also end with an implicit barrier. {#wild-openmp-barrier}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **party count** — How many threads must arrive. It must equal the number of threads that really call the barrier each round.
- **wait timeout** — How long a thread waits before it treats the barrier as broken. Without one, a missing thread hangs the group. Set it to a multiple of the round duration (signal 3) seen in a normal run. When it fires, break the barrier so every waiter fails together, then stop the round instead of retrying.
- **work chunk size** — How finely each phase is split across threads. Smaller chunks narrow the gap between first and last arrival.
- **barrier action** — Code that runs once per round when the last thread arrives. Keep it short, because every thread waits for it.

### Signals to watch
<!--meta polarity=signal-->

- **arrival spread** — The time between the first and the last arrival each round. A wide spread is idle time you pay for.
- **wait time per thread** — How long each thread parks per round. A thread that never waits is the straggler.
- **round duration** — Time from release to release. It tracks the slowest thread and should be steady.
- **idle share** — Parked time divided by total thread time. A high share means the barrier costs more than it protects.

### Failure modes under load
<!--meta polarity=failure-->

- **straggler** — One slow thread, from a heavy slice, a page fault or a descheduled core, stretches every round for all threads.
- **missing arrival** — A thread that crashed or returned early leaves the others parked. The service looks frozen with no error.
- **wrong party count** — Too high and the group hangs. Too low and the barrier opens before the last thread has finished.
- **barrier inside a lock** — A thread that waits at the barrier while holding a lock another worker needs will deadlock the group.

### Readiness checklist
<!--meta polarity=check-->

- the party count equals the real number of threads on every code path, including error paths
- a thread that fails still breaks or leaves the barrier, so the others do not wait forever
- waits use a timeout and the timeout is handled
- no lock is held while waiting at the barrier
- a test with one deliberately slow thread shows the round time and the idle share you expect

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Hold every thread at a point until all have arrived before any goes on. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Mutex](./mutex.md) — A barrier is built from a counter guarded by a lock plus a way to wait for it
- [MapReduce](../distributed/coordination/mapreduce.md) — Holds every reducer until every map task has finished

**Alternative to**

- [Fork-Join](./fork-join.md) — Keeps the same threads alive across phases and makes each wait for the others at the end of a phase
- [Thread Pool](./thread-pool.md) — Independent items on a queue keep every thread busy with no meeting point; a barrier holds all threads at each phase end

**Prevents**

- [Race Condition](../../hazards/race-condition.md) — No thread starts a phase before every thread has finished the last, so none reads data another has not yet written

<!-- relationships:end -->
