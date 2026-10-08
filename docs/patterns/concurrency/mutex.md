---
title: Mutex
description: "One thread at a time holds the lock, so shared data is never seen half-changed"
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, state-management, isolation]
status: stable
aliases: [mutual exclusion lock, lock]
solves: [two threads update the same counter and some updates silently disappear, a shared value comes out different on every run of the same program, one thread reads a record while another is half-way through changing it, I need only one thread inside this block of code at a time]
---

# Mutex

A lock with one owner at a time: a thread locks it before it touches shared data and unlocks it after, and every other thread that asks in between waits.

## What it is
<!--meta block=description-->

Two threads that each read a counter, add one and write it back can both read 7 and both write 8, so one increment vanishes and nothing reports an error. A mutex closes the gap: a thread locks it before it touches the shared data, unlocks it after, and any thread that asks in between waits. Only one thread is inside the guarded section, so a change of several steps looks like one step to everyone else.

## Explained
<!--meta block=explain-->

A mutex is a lock with one owner at a time. A thread locks it before it reads or changes shared data and unlocks it afterwards, and unlock makes every write made inside the section visible to the next thread that locks. Choose it over a [read-write lock](./rw-lock.md) when writes are common or the guarded section is a few instructions, and over [lock-free](./lock-free.md) code when you want logic a reviewer can check by reading it.

- **Waiting.** One slow holder stalls every other thread. Keep the guarded section to a few instructions and do slow work outside it.
- **Deadlock.** Two threads that take two locks in opposite order wait for each other forever. Take locks in one fixed order everywhere.
- **Forgotten unlock.** An early return or a panic that skips the unlock hangs every later caller. Unlock in a defer or finally block.
- **No reentry.** In Go, locking twice from one goroutine hangs it. Split the work into a locked outer call and an unlocked helper.

**Example.** Eight threads each run a request that holds one lock for 2 ms. The lock lets one request in at a time, so the section serves at most 1 / 0.002 = 500 requests a second, however many cores you add. A request that does a 50 ms network call inside the lock holds it for about 52 ms, so the section serves about 19 a second, ignoring wake-up time, and the other seven threads sit idle. Moving the call outside the lock, and holding it only for the 2 ms update, restores 500 a second. The cost is that you must copy the data out first and accept that it may change before you use the copy.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one lock keep two threads apart? Steps 2 and 3 are the whole pattern: the first thread to find the lock free takes it, and the second parks until step 6 hands it over."
flowchart LR
    T["Threads"]
    subgraph Guard["One owner at a time"]
        M["Mutex"]
        L[("Lock state: free or held")]
        Q[("Wait queue")]
    end
    D[("Shared data")]
    T -->|"1 lock()"| M
    M -->|"2 free: mark held, let the thread in"| L
    M -->|"3 held: park the thread"| Q
    T -->|"4 read and change the data"| D
    T -->|"5 unlock()"| M
    M -->|"6 wake the first waiter"| Q
```

```mermaid caption="Thread B asks for the lock while A holds it. B parks until A unlocks, so B never sees the data half-changed."
sequenceDiagram
    participant A as Thread A
    participant M as Mutex
    participant B as Thread B
    A->>M: lock()
    M-->>A: granted
    B->>M: lock()
    Note over B,M: B parks, the lock is held
    A->>A: read, change, write the data
    A->>M: unlock()
    M-->>B: granted, B wakes
    B->>B: read, change, write the data
    B->>M: unlock()
```

## Variations
<!--meta block=variations-->

- **Spinlock** — A waiting thread loops on the lock flag instead of sleeping. It wins when the hold is shorter than a context switch, and it burns a whole core when the hold is long. Kernel code uses it where the holder cannot sleep, such as an interrupt handler.
- **Reentrant mutex** — The thread that holds the lock may lock it again, and the lock counts the depth. It lets a method call another locked method, and it hides designs where lock scope is unclear.
- **Try-lock and timed lock** — Ask for the lock and give up at once or after a deadline. A request path turns a stuck holder into a fast error instead of a hang.
- **Striped locks** — Many mutexes each guard one slice of the data, chosen by key hash. Two threads that touch different slices no longer wait for each other.
- **[Read-Write Lock](./rw-lock.md) split** — Readers share the lock and a writer takes it alone. It pays off when reads far outnumber writes and each read is long.
- **[Monitor Object](./monitor-object.md)** — The mutex and its data live inside one object, with condition variables for waiting on a state. Every public method takes the lock for you.
- **Adaptive mutex** — A waiting thread spins briefly in case the holder is about to release, then sleeps. It avoids a context switch for short holds and a burned core for long ones.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Correct by reading it** — you can check the guarded section line by line, with no memory-ordering rules to reason about.
- **Every multi-step change becomes one step** — no other thread sees a half-updated invariant inside the section.
- **Waiting is cheap for the CPU** — a blocked thread sleeps and is woken on unlock, with no polling; each wake-up costs a context switch, so very short holds can favour a spinlock.
- **Built into most languages** — a standard library type with known behaviour, tooling and profilers.

### Cons
<!--meta polarity=con-->

- **One slow holder stalls everyone** — a hold of 2 ms caps the section at 500 entries a second, so keep it short and do slow work outside.
- **Two locks can deadlock** — threads that take two locks in opposite order wait for each other forever; take locks in one fixed order.
- **A skipped unlock hangs every later caller** — an early return or panic leaves the lock held, so unlock in a defer or finally block.
- **It does not scale with cores** — more threads on one hot lock mean more waiting, so split the data across several locks or confine it to one thread.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several threads change the same value** and the change takes more than one step.
- **The guarded section is short** — a map update, a counter, a swap of two fields.
- **You want code a reviewer can verify** by reading it, not by proving a memory model.

### Avoid when
<!--meta polarity=avoid-->

- **Reads outnumber writes by a wide margin** and each read is long — a [read-write lock](./rw-lock.md) lets the readers run together.
- **Each thread can own its data** — [thread confinement](./thread-confinement.md) needs no lock at all.
- **You hold the lock across slow I/O or a network call** — every other thread waits for that call; copy the data out and release first.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a counter guarded by a sync.Mutex"

type Counter struct {
	mu sync.Mutex // guards n and nothing else
	n  int
}

func (c *Counter) Inc() {
	c.mu.Lock()
	defer c.mu.Unlock() // runs on every exit path, panics included
	c.n++               // read, add, write: no other goroutine sees it half-done
}

func (c *Counter) Value() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// Two goroutines calling c.Inc() a million times each: Value() is always
// 2000000. Without mu the total is often lower; go test -race reports the
// unguarded version.
```

## In the wild
<!--meta block=wild-->

- **Go sync.Mutex** — The standard-library lock in Go: `Lock` and `Unlock`, plus `TryLock` since Go 1.18. It is not reentrant, and the usual shape is `Lock` followed at once by `defer Unlock`. {#wild-go-sync-mutex}
- **POSIX pthread_mutex_t** — The C lock behind most Unix threading: `pthread_mutex_lock`, `pthread_mutex_trylock` and `pthread_mutex_unlock`. A mutex attribute can make it recursive. {#wild-pthread-mutex}
- **C++ std::mutex** — Locked through a guard such as `std::lock_guard`, which unlocks when it leaves scope. `std::scoped_lock` takes several mutexes at once without deadlocking. {#wild-cpp-std-mutex}
- **Java ReentrantLock** — A reentrant lock in `java.util.concurrent.locks` with `tryLock` and timed waits. The `synchronized` keyword is the built-in form of the same idea. {#wild-java-reentrantlock}
- **Rust std::sync::Mutex** — The data lives inside the mutex, so you cannot reach it without the lock. The guard unlocks on drop, and a holder that panics poisons the lock for later callers. {#wild-rust-mutex}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **critical section size** — The work done while the lock is held. It sets the throughput ceiling: at most 1 / hold time entries a second on that lock.
- **lock granularity** — One lock for all the data, or striped locks each guarding a slice. Finer locks cut waiting and raise the chance of taking two in the wrong order.
- **try-lock or timed lock** — Whether a caller waits forever or gives up after a deadline. A deadline turns a stuck holder into a visible error; set it near the p99 of lock hold time plus a margin, and count every timeout.
- **mutex profile fraction** — In Go, `runtime.SetMutexProfileFraction` turns on sampling of lock contention for the profiler.

### Signals to watch
<!--meta polarity=signal-->

- **lock wait time** — How long threads wait to acquire it, as a distribution. The tail is what users feel.
- **lock hold time** — How long the holder keeps it. A rising hold time usually means slow work crept into the section.
- **threads waiting** — How many threads are parked on the lock right now. A queue that does not drain means the lock is the bottleneck.
- **CPU idle while throughput is flat** — Many cores idle and requests slow means threads are queued on a lock, not short of compute.

### Failure modes under load
<!--meta polarity=failure-->

- **lock convoy** — Threads line up behind one hot lock and each wakes only to wait again. Where each wake-up costs more than the work it does, throughput falls below what one thread alone achieves.
- **deadlock** — Two threads each hold one lock and wait for the other. They stop with no error; if every thread is caught CPU drops to zero, otherwise only those requests hang. A thread dump shows who waits on what.
- **lock held across I/O** — A slow disk or network call inside the section stalls every other thread for its whole length.
- **holder dies without unlocking** — A skipped unlock leaves the lock held, and every later caller hangs. It reads as a freeze, not a crash.
- **priority inversion** — A low-priority holder is preempted while a high-priority thread waits for its lock. It shows as a slow high-priority path with an idle lock holder; priority inheritance (`PTHREAD_PRIO_INHERIT` in POSIX) lifts the holder.

### Readiness checklist
<!--meta polarity=check-->

- every lock is released on every exit path, with a defer, finally or scope guard
- no network or disk call runs while a lock is held
- all code takes multiple locks in one documented order
- each lock has a comment naming the data it guards
- a stress test with the race detector or thread sanitizer passes with many more threads than cores

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Guard shared data with a lock so one thread at a time changes it. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Barrier](./barrier.md) — A lock guards the arrival count of a barrier
- [Copy-on-Write](./copy-on-write.md) — Copy-on-write readers never take the mutex; only writers do, around clone-and-publish

**Alternative to**

- [Active Object](./active-object.md) — Locks the data directly, which is cheaper per call but makes every caller wait
- [Channels](./channels.md) — Guards a shared value in place, which is simpler when many tasks update one value
- [Lock-Free](./lock-free.md) — Simple to reason about, at the price of making every caller wait while another holds it
- [Thread Confinement](./thread-confinement.md) — Shares one value among threads and guards it with a lock

**Has variant**

- [Read-Write Lock](./rw-lock.md) — The plain exclusive lock, which admits one thread at a time whether it reads or writes

**Part of**

- [Monitor Object](./monitor-object.md) — The lock that a monitor holds around each method call

**Often confused with**

- [Semaphore](./semaphore.md) — Has an owner: the thread that locked it must unlock it, and it admits one thread

**Prevents**

- [Race Condition](../../hazards/race-condition.md) — Lets one thread at a time change the shared data

**Exposed to**

- [Deadlock](../../hazards/deadlock.md) — Can fall into deadlock when two tasks taking two mutexes in different orders wait on each other forever
- [Priority Inversion](../../hazards/priority-inversion.md) — Can fall into priority inversion when a low-priority holder is preempted by unrelated work while a high-priority task waits

<!-- relationships:end -->
