---
title: Read-Write Lock
description: "Many readers, or one writer — never both"
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, state-management, read-optimization, throughput]
status: stable
aliases: [RWLock, shared-exclusive lock, readers-writer lock]
solves: [my config is read by every request and they all queue up behind one lock, threads that only look at the data are blocking each other for no reason, profiling says my cache lookups spend most of their time waiting to acquire a mutex, adding more cores does nothing for a workload that is almost entirely reads, the data changes once an hour but I pay full serialization on every single read]
---

# Read-Write Lock

Lets any number of threads read shared data at once, but the instant one needs to write, every reader and every other writer is forced to wait — reads scale for free, writes stay exclusive and safe.

## What it is
<!--meta block=description-->

A plain mutex lets one thread in at a time, so threads that only read, and cannot conflict, still wait for each other. A read-write lock has two modes. Any number of readers hold it together, but a writer waits for every reader to leave and then holds it alone. It tracks readers and writers separately, so fairness and upgrades become design decisions.

## Explained
<!--meta block=explain-->

A read-write lock lets any number of readers hold it at the same time, but lets a writer hold it only alone. Readers do not exclude each other, so a read-heavy structure can serve many threads in parallel, while a writer still sees nothing half-changed. Choose it over a plain mutex when reads far outnumber writes and each read holds the lock long enough that serializing them hurts.

- **Slower acquire** Tracking readers costs more than a mutex; for a few-instruction critical section or half reads and half writes, a plain mutex wins.
- **Starved writers** Under reader preference, constant readers can keep a writer waiting forever; use a fair lock where new readers queue once a writer waits.
- **No in-place upgrade** Upgrading a read hold deadlocks; release the read, take the write lock, and recheck the data.

**Example.** A cache scan takes 2 ms and 8 threads scan at once. A mutex makes them take turns, so the last one finishes at 16 ms. With 8 free cores, a read-write lock lets all 8 run together and finish in about 2 ms. A writer arrives once a second and holds the lock for 5 ms. If the lock prefers readers and scans overlap with no gap, the writer waits forever. A fair lock makes new readers wait once the writer is queued, so the writer waits at most 2 ms for scans already running. The cost is that those readers pause for the writer's 5 ms.

## How it works
<!--meta block=structure-->

```mermaid caption="Who is allowed inside at the same time? Steps 1 to 4 let readers share, because looking cannot break an invariant, and steps 5 to 7 make the writer wait for an empty room — so the only threads that take turns are the ones that would genuinely conflict."
flowchart LR
    R1["Reader thread"]:::ext
    R2["Reader thread"]:::ext
    W["Writer thread"]:::ext
    subgraph Lk["One lock, two modes"]
        G["Acquisition logic"]
        C[("Reader count and writer flag")]
    end
    D[("Shared data: cache, config, routing table")]
    R1 -->|"1 ask in read mode"| G
    G -->|"2 no writer holds it, so count the reader in"| C
    R2 -->|"3 ask in read mode too, admitted alongside"| G
    R1 -->|"4 both read at once, neither waits"| D
    W -->|"5 ask in write mode"| G
    G -->|"6 wait for the count to reach zero, then raise the flag"| C
    W -->|"7 change the data with nobody else inside"| D
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Two readers hold the lock together. A waiting writer blocks until both release, then gets the lock exclusively."
sequenceDiagram
    autonumber
    participant R1 as Reader 1
    participant R2 as Reader 2
    participant L as RWLock
    participant W as Writer
    R1->>L: acquireRead
    L-->>R1: granted, readers 1
    R2->>L: acquireRead
    L-->>R2: granted, readers 2
    W->>L: acquireWrite
    Note over W: blocked while readers active
    alt writer-preference
        R1->>L: acquireRead again
        L--xR1: refused, writer waiting
    else reader-preference
        R1->>L: acquireRead again
        L-->>R1: granted, writer starves
    end
    R1->>L: releaseRead
    R2->>L: releaseRead
    L-->>W: granted, exclusive
```

## Variations
<!--meta block=variations-->

- **Reader-preference vs. writer-preference** — Decide who wins when both roles are waiting. Naive reader-preference lets a steady stream of readers starve a writer indefinitely; writer-preference flips the risk onto readers instead.
- **Fair / ticket-queued** — Queue read and write requests in arrival order so neither role starves the other, at the cost of extra bookkeeping and slightly lower peak read throughput.
- **Upgradeable read lock** — Lets a thread already holding a read lock promote to a write lock without releasing it first, closing the gap where another writer could sneak in between release and re-acquire. Such locks usually admit only one upgrader at a time, and the Java lock named under wild supports no upgrade.
- **Recursive (reentrant) read-write lock** — Allows the same thread to re-acquire a mode it already holds — needed when locked code calls other locked code — but doubles the accounting and can [deadlock](../../hazards/deadlock.md) if reentry rules aren't precise.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Concurrent readers run in parallel** instead of queuing behind one another, when each read holds the lock long enough to outweigh the acquire cost.
- **Writes stay fully exclusive**, so invariants hold exactly as they would under a plain mutex.
- **Natural drop-in for read-heavy data** — data that's read far more often than it's written, such as caches, config, routing tables.
- **Separates read and write contention**, making which one is the bottleneck visible and tunable.

### Cons
<!--meta polarity=con-->

- **More overhead per acquisition than a plain mutex** — tracking a reader count and a wait queue costs cycles a simple lock doesn't pay.
- **Naive implementations starve writers under constant read traffic**, or starve readers under writer-preference.
- **Not reentrant by default**; recursive acquisition needs deliberate support and can deadlock if mishandled.
- **On workloads where reads and writes** are roughly balanced, the bookkeeping outweighs any parallelism gained.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Reads vastly outnumber writes** on the same shared structure.
- **Read operations hold the lock long enough** that serializing them under a plain mutex would bottleneck throughput.
- **Readers need only a consistent view of the data**, and no read has to be ordered against one particular write.

### Avoid when
<!--meta polarity=avoid-->

- **Reads and writes arrive at roughly similar rates** — the extra bookkeeping isn't repaid, use a plain mutex.
- **Critical sections are so short** that lock overhead itself dominates, not contention.
- **Writes are frequent** enough that readers rarely overlap anyway, so there's little concurrency left to win back.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a cache behind a read-write lock"

// Read far more often than written, so a RWMutex.
type Cache struct {
	mu   sync.RWMutex
	data map[string]int
}

// Get takes the shared mode: any number of readers hold it at once.
// Never call it while holding RLock: a queued writer blocks the second RLock.
func (c *Cache) Get(key string) (int, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.data[key]
	return v, ok
}

// A read hold cannot upgrade in place: two readers trying it deadlock.
// Release, take the write lock (exclusive: it waits for every reader to
// leave), and recheck what another writer may have set.
func (c *Cache) GetOrLoad(key string, load func() int) int {
	if v, ok := c.Get(key); ok {
		return v
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.data[key]; !ok { // the recheck
		c.data[key] = load() // runs under the write lock and blocks every reader: keep it fast
	}
	return c.data[key]
}
```

## In the wild
<!--meta block=wild-->

- **Go sync.RWMutex** — Many concurrent RLock holders or one Lock holder, implemented over runtime semaphores. A blocked writer stops new readers from acquiring, which bounds writer starvation but means a goroutine must never recursively RLock while a writer waits, or it deadlocks. {#wild-go-sync-rwmutex}
- **java.util.concurrent.locks.ReentrantReadWriteLock** — Adds reentrancy and an optional fairness flag in the constructor, and supports downgrading from the write lock to the read lock. Upgrading read to write is not supported and deadlocks; readLock() and writeLock() expose the two halves. {#wild-java-reentrant-rwlock}
- **POSIX pthread_rwlock** — The pthreads reader-writer primitive: pthread_rwlock_rdlock, wrlock, and unlock. glibc prefers readers by default; PTHREAD_RWLOCK_PREFER_WRITER_NONRECURSIVE_NP via pthread_rwlockattr_setkind_np favors writers. ISO C has no equivalent; C11 threads.h ships only mutexes and condition variables. {#wild-pthread-rwlock}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Fairness / preference policy** — Reader-preference, writer-preference, or fair first in, first out (FIFO) ordering. ReentrantReadWriteLock takes a fair boolean; glibc pthread_rwlock defaults to reader preference and switches via pthread_rwlockattr_setkind_np.
- **Acquire timeout** — A tryLock with a timeout bounds how long a thread waits for the lock instead of blocking indefinitely.
- **Reentrancy** — Whether a thread may re-acquire a lock it already holds. ReentrantReadWriteLock allows it and supports downgrade (hold write, take read, release write) but not upgrade.

### Signals to watch
<!--meta polarity=signal-->

- **Read/write ratio** — The fraction of acquisitions that are writes; count read and write acquisitions per interval. A read-write lock only pays off when reads dominate and critical sections are non-trivial; the break-even depends on hold time, so benchmark both locks under the real mix.
- **Writer wait time** — How long writers block behind active readers. Growing values point to starvation, long read holds or queued writers; compare with lock hold time.
- **Lock hold time** — How long critical sections hold the lock and how long threads sit queued behind it.

### Failure modes under load
<!--meta polarity=failure-->

- **Writer starvation** — Under reader preference, a steady stream of overlapping readers can keep a writer waiting indefinitely.
- **Upgrade deadlock** — Two readers that each try to upgrade to the write lock deadlock, since each waits for the other to release its read lock.
- **Worse than a mutex** — When writes are frequent or critical sections are tiny, the extra bookkeeping of a read-write lock costs more than a plain mutex.

### Readiness checklist
<!--meta polarity=check-->

- Measure the read/write ratio first; a plain mutex often wins unless reads clearly dominate.
- Choose the fairness or preference policy deliberately to bound writer (or reader) starvation.
- Never upgrade a read lock to a write lock; release and re-acquire, or use a lock that supports it.
- Keep critical sections short; the write lock serializes every thread.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Allow many simultaneous readers or one writer, never both. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Monitor Object](./monitor-object.md) — A monitor can guard its state with a read-write lock instead of a mutex, so read-only methods run together

**Alternative to**

- [Copy-on-Write](./copy-on-write.md) — A copy-on-write structure removes the read lock altogether, at the cost of copying on write

**Variant of**

- [Mutex](./mutex.md) — Lets many readers hold the lock together and gives a writer exclusive access

**Prevents**

- [Race Condition](../../hazards/race-condition.md) — An exclusive write lock stops a writer racing concurrent readers or writers

**Exposed to**

- [Starvation](../../hazards/starvation.md) — Can fall into starvation when a stream of readers can keep a writer out indefinitely
- [Priority Inversion](../../hazards/priority-inversion.md) — Can fall into priority inversion when a low-priority reader or writer holding the lock blocks a high-priority task
- [Deadlock](../../hazards/deadlock.md) — Can fall into deadlock when two readers both try to upgrade to the write lock, or a reader re-acquires while a writer waits

**Demonstrated by**

- [File System](../../designs/file-system.md) — read-heavy tree traversal is exactly where separating shared reads from exclusive writes earns its keep
- [Parking Lot](../../designs/parking-lot.md) — Parking Lot names a read-write lock as the step after one coarse lock: many entrances search while claiming stays exclusive.

<!-- relationships:end -->
