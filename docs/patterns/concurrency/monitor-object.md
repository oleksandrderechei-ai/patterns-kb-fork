---
title: Monitor Object
description: Synchronizes access to an object's own methods
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, state-management, encapsulation]
status: stable
aliases: [monitor]
solves: [two threads update the same counter and the total comes out wrong, I keep forgetting to grab the lock before touching this object and it corrupts randomly, my thread burns CPU spinning in a loop waiting for the queue to have something in it, the locking code is copy-pasted at every call site and one of them forgets to release, "I need a thread to sleep until the state is actually ready, not just take turns"]
---

# Monitor Object

Wraps an object's private state behind a single lock and a set of condition variables, so only one thread ever runs its methods at a time — and a thread that finds the state not yet ready blocks on that condition instead of spinning or retrying.

## What it is
<!--meta block=description-->

A bare lock gives exclusion but says nothing about waiting for the right state, so callers poll or scatter signals across the code. A monitor object keeps one lock and its conditions inside the object. Only one thread runs its methods at a time. A method that finds the state not ready waits, which frees the lock, until another method signals a change.

## Explained
<!--meta block=explain-->

A monitor ties one lock and its waiting areas to an object, so only one thread at a time runs any of the object's methods and callers never lock anything themselves. A method that cannot proceed, such as taking from an empty queue, waits on a condition. It releases the lock while it sleeps, and another method wakes it when the state changes. Choose it over locks scattered through calling code when the object's fields must stay consistent with each other, because the rule lives in one place. Choose a [read-write lock](rw-lock.md) instead when reads are most of the traffic.

- **One lock for all** One lock serializes every method, even those touching separate data; split the object into parts that each have their own monitor.
- **Wrong thread wakes** Different reasons to wait sharing one waiting area wake the wrong thread; keep one condition per reason.
- **Nested deadlock** Calling another object monitor while holding your own lock can deadlock; call out after you release.
- **Spurious wakeups** A thread can return from wait() unsignalled, so recheck the condition in a loop, never an if.

**Example.** A buffer holds one item. Consumers C1 and C2 wait on it, empty, in the same waiting area. Producer P1 puts an item and wakes C1. Before C1 runs, P2 tries to put, finds it full and waits in the same area. C1 takes the item and wakes one waiter; if it picks C2, C2 sees an empty buffer and sleeps again, while P2 sleeps with room available. Nobody is left to wake it, so the program stalls with no error. Waking everyone fixes it but runs all threads for every change. One condition for not-full and another for not-empty fixes it at the price of two conditions to maintain.

## How it works
<!--meta block=structure-->

```mermaid caption="How do two threads share one buffer without either caller managing a lock? Both enter through the same guarded methods, so step 2 gives exclusion and steps 3 and 6 give \"wait until ready\" — properties of the object rather than a rule every call site has to remember."
flowchart LR
    T1["Consumer thread"]:::ext
    T2["Producer thread"]:::ext
    subgraph Mon["One object owns the lock, the waiting room and the data"]
        M["Guarded methods: put(), take()"]
        L[("Lock and condition wait set")]
        S[("Shared state, the buffer")]
    end
    T1 -->|"1 call take()"| M
    M -->|"2 acquire the lock, or queue behind the holder"| L
    M -->|"3 nothing to take: release the lock and sleep"| L
    T2 -->|"4 call put(item)"| M
    M -->|"5 change the buffer under the lock"| S
    M -->|"6 wake a sleeper, then release the lock"| L
    L -->|"7 sleeper reacquires and re-checks the buffer"| M
    M -->|"8 return the item"| T1
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="A consumer finds the buffer empty and waits, releasing the lock. A producer acquires the lock, adds an item, and signals — waking the consumer to reacquire the lock and proceed."
sequenceDiagram
    autonumber
    participant P as Producer
    participant Buf as Monitor, lock plus state
    participant C as Consumer
    C->>Buf: take(), acquire lock
    Note over Buf: buffer empty, C calls wait(), lock released
    P->>Buf: put(item), acquire lock, notify()
    Buf-->>C: signal, C wakes and reacquires lock
    alt predicate holds, item present
        C->>Buf: remove item, release lock
    else spurious or stolen wakeup
        C--xBuf: still empty, wait() again
    end
```

## Variations
<!--meta block=variations-->

- **Intrinsic vs. explicit locks** — Java's `synchronized` makes every object a built-in monitor with one implicit lock; `java.util.concurrent.locks.Lock` plus `Condition` makes the lock and conditions explicit and allows several conditions per lock. The idea comes from Hoare and Brinch Hansen's monitors in the 1970s.
- **Signal vs. broadcast** — `notify()` wakes exactly one waiting thread; `notifyAll()` wakes them all so each can recheck its own condition. `notify()` is cheaper; `notifyAll()` is safer when several conditions share one wait set.
- **Signal-and-wait vs. signal-and-continue** — The original blocking form hands the monitor straight to the thread it woke, so its condition is still true when it resumes. Mainstream runtimes use the nonblocking form: the signaller keeps the lock and carries on, and the woken thread must re-acquire it, by which time another thread may have taken what it was woken for. That, more than spurious wakeups, is why the wait belongs in a loop. A signal is a hint, never a promise about the state.
- **Multiple condition variables** — One lock can guard several named conditions — not full and not empty on a bounded buffer — so producers and consumers don't wake the wrong kind of waiter unnecessarily.
- **[Read-Write Lock](./rw-lock.md)** — Splits the single exclusive lock into a shared read mode and an exclusive write mode, letting many readers through at once — a finer-grained monitor for read-heavy state.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Packages the lock with the state it protects**, so synchronization can't be bypassed as long as the state stays private to the object's guarded methods.
- **Threads block on a precise condition** instead of busy-polling or backing off and retrying.
- **Built into mainstream languages** — Java's `synchronized`/`wait`/`notify`, C#'s `lock`/`Monitor` — with no library needed.
- **Simpler to reason about than raw semaphores**: no separate counting variable to keep in sync with the data.

### Cons
<!--meta polarity=con-->

- **One lock per object serializes every method**, even ones touching disjoint parts of the state.
- **Wrong waiter may wake** — `notify()` can do this when several conditions share one wait set; `notifyAll()` trades that bug for wasted wakeups.
- **Calling another object's monitor method** while holding your own lock invites the nested monitor problem and [deadlock](../../hazards/deadlock.md).
- **Confined to one process's address space** — doesn't extend across machines or even separate processes.
- **Every wait must recheck its condition** in a loop: after a signal another thread may take the state first, and spurious wakeups are also allowed.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple threads share mutable state** that needs both exclusion and "wait until ready" semantics — a bounded queue, connection pool, or work queue.
- **You want the synchronization to live inside** the object, invisible to callers, rather than scattered across every call site.
- **The language gives you a monitor for free**, and the state is naturally owned by one object.

### Avoid when
<!--meta polarity=avoid-->

- **The state isn't actually shared or mutable** — there's nothing to protect.
- **Access is overwhelmingly reads with rare writes** — a [Read-Write Lock](./rw-lock.md) lets readers run concurrently instead of serializing behind one lock.
- **You'd rather avoid shared state and locking altogether** — the [Actor Model](./actor-model.md) replaces both with message passing between isolated actors.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a bounded buffer as a monitor"

// BoundedBuffer is a monitor: one lock, two conditions, all guarding items. Build both conds with sync.NewCond(&b.mu); a zero value would panic on a nil Cond.
type BoundedBuffer struct {
	mu       sync.Mutex
	notFull  *sync.Cond
	notEmpty *sync.Cond
	items    []int
	capacity int
}

func (b *BoundedBuffer) Put(item int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for len(b.items) == b.capacity {
		b.notFull.Wait() // releases the lock, parks, reacquires on wake
	}
	b.items = append(b.items, item)
	b.notEmpty.Signal()
}

func (b *BoundedBuffer) Take() (item int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for len(b.items) == 0 { // a loop, not an if: recheck after every wake
		b.notEmpty.Wait()
	}
	item, b.items = b.items[0], b.items[1:]
	b.notFull.Signal()
	return
}
```

## In the wild
<!--meta block=wild-->

- **Java synchronized / wait / notify** — Every Java object carries an intrinsic lock and a wait set, making the monitor a language feature rather than a library. wait() releases the lock and suspends; notify()/notifyAll() wake waiters; the guard must be re-tested in a while loop because of spurious wakeups. {#wild-java-synchronized}
- **C# lock / System.Threading.Monitor** — The lock keyword compiles to Monitor.Enter/Exit wrapped in try/finally, and Monitor.Wait, Pulse, and PulseAll supply the condition-variable half. A thread must own the monitor before it may Wait or Pulse. {#wild-csharp-monitor}
- **Python threading.Condition** — Bundles a Lock (or RLock) with wait/notify so a bounded buffer can block until it is not-full or not-empty. wait() releases and later re-acquires the lock, and the docs steer callers to the while-predicate idiom over a bare notify_all(). {#wild-python-condition}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Signaling policy** — Wake one waiter or all: notify()/signal() versus notifyAll()/signalAll(). Signal-one is cheaper and safe only when every waiter is interchangeable on the same condition; otherwise signal-all avoids wrong-waiter stalls.
- **Wait timeout** — Object.wait(ms) and Condition.await(time) bound how long a thread blocks on a condition, turning an indefinite wait into one that can time out and recover. Work out the timeout from the caller's deadline minus the expected hold time; on timeout re-test the guard and return an error, never assume the condition holds.

### Signals to watch
<!--meta polarity=signal-->

- **Lock contention** — Time threads spend blocked entering the monitor. High contention turns the guarded section into a serialization bottleneck. Compare p99 time blocked entering the monitor with the critical-section length; contention is high when waiting exceeds holding.
- **Waiting-thread count** — How many threads are parked on the condition. A queue that never drains points at a missed or too-narrow wakeup. Alert when waiters stay above zero while the guard is true for longer than the p99 wait.

### Failure modes under load
<!--meta polarity=failure-->

- **Lost wakeup** — notify() on a wait set shared by several conditions wakes the wrong waiter, or a waiter tests its guard outside the lock, leaving a thread parked while work is available. A guard re-tested in a loop under the lock makes signal-before-wait harmless.
- **Spurious wakeup** — A thread can return from wait() without being signaled; testing the guard with if instead of a while loop lets it proceed on a false premise.
- **Nested-monitor deadlock** — Holding one monitor while waiting on another, in inconsistent order across threads, deadlocks the set. Confirm with a thread dump showing a cycle of lock holders; fix by consistent lock order or by releasing before the nested call.

### Readiness checklist
<!--meta polarity=check-->

- Always re-check the guard in a while loop around wait(), never a single if.
- Prefer notifyAll unless every waiter is provably interchangeable on one condition.
- Acquire multiple monitors in a globally consistent order to avoid deadlock.
- Keep the guarded critical section short; it serializes every thread that touches the monitor.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Guard shared state with one lock and wait on conditions. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Producer-Consumer](./producer-consumer.md) — A monitor with not-full and not-empty conditions is the standard in-process bounded buffer
- [Read-Write Lock](./rw-lock.md) — A monitor can guard its state with a read-write lock, so read-only methods run in parallel

**Alternative to**

- [Actor Model](./actor-model.md) — Message-passing vs. shared-state locking
- [Thread Confinement](./thread-confinement.md) — Guard the shared state with a lock, rather than partitioning it away
- [Lock-Free](./lock-free.md) — A mutex is simpler and correct by inspection; go lock-free only when contention proves it necessary
- [Active Object](./active-object.md) — The monitor makes callers run the method under a lock, where an active object runs it for them

**Composed of**

- [Mutex](./mutex.md) — Builds a lock and condition waits into the object, so callers never take the lock themselves

**Often confused with**

- [Semaphore](./semaphore.md) — A monitor is mutual exclusion for one; a semaphore counts N permits

**Prevents**

- [Race Condition](../../hazards/race-condition.md) — Serialize the check and the act under one lock so they can't interleave

**Exposed to**

- [Deadlock](../../hazards/deadlock.md) — Can fall into deadlock when nested monitor calls take locks in whatever order the call chain dictates
- [Priority Inversion](../../hazards/priority-inversion.md) — Can fall into priority inversion when a monitor lock shared across priorities is where the inversion forms

**Demonstrated by**

- [File System](../../designs/file-system.md) — a synchronized-method wrapper around the mutable tree is the canonical Monitor Object
- [Logging Service](../../designs/logging-service.md) — an object encapsulating its own lock around its critical section is the monitor object pattern
- [Inventory Management](../../designs/inventory-management.md) — the Warehouse is a textbook monitor — every public method, read or write, runs under the object's own mutex
- [BookMyShow](../../designs/bookmyshow.md) — the per-showtime synchronized object is a textbook monitor guarding its seat state
- [Rate Limiter](../../designs/design-rate-limiter.md) — guarding a shared object's whole state transition behind its own lock is the Monitor Object pattern

<!-- relationships:end -->
