---
title: Semaphore
description: Cap how many threads may hold a resource at once with N permits
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, resource-management, throughput, backpressure]
status: stable
aliases: [counting semaphore]
solves: ["I need to let only N callers into this section at once, not just one", too many threads pile onto the database or API connection pool at the same time, I want to bound in-flight work to a fixed resource or memory budget, the downstream API starts failing whenever all our workers call it at the same moment, a batch job opens more database connections than the server allows and everything stalls]
---

# Semaphore

A counter of N permits that bounds concurrent access to a resource: every acquire takes a permit and blocks when none are left, every release returns one and wakes a waiting thread.

## What it is
<!--meta block=description-->

Some resources are scarce: a downstream API tolerates ten concurrent callers, a pool holds ten connections for a thousand requests. A semaphore is a counter of N permits. acquire takes one, and at zero it parks the caller. release returns one and wakes a waiter. It makes the ceiling explicit, so the next caller waits instead of overrunning the resource.

## Explained
<!--meta block=explain-->

A semaphore is a counter of permits. A thread takes one permit before using a limited resource and gives it back afterwards, and when the count is zero the next thread waits. It caps how many threads use something at once without caring which threads they are. Choose it over a mutex (a lock for one thread at a time) when more than one user at a time is fine but the number has a ceiling, such as 10 concurrent calls to a vendor API or 20 database connections.

- **Leaked permits** A permit not returned is gone for good; release it in a finally block so an exception cannot skip it.
- **Endless waits** A plain acquire waits forever; use a timed acquire and fail fast with an error.
- **Permission, not an object** Keep a pool behind it if callers need an actual connection.
- **No owner** Any thread can release a permit it never took; release only what you acquired, and count carefully when permits vary in size.

**Example.** A vendor API allows 10 concurrent calls, and your service has 50 request threads. A semaphore of 10 lets 10 calls run and makes the other 40 wait. Each call takes 200 ms, so you can make at most 10 / 0.2 = 50 calls a second. Now a call throws an exception and the code skips the release. After 10 such failures all permits are gone, and every later request waits forever while monitoring shows no errors. A release in a finally block fixes the leak, and a 1 s timed acquire turns any remaining stall into a fast error. The cost is that some callers get that error instead of waiting.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a cap of five stop the sixth caller? Steps 2 and 3 are the whole pattern: the count is positive, so you take one and go, or it is zero, so you wait until step 7 gives you the permit somebody else returned."
flowchart LR
    T["Caller threads"]
    subgraph Gate["One count decides how many may be inside"]
        S["Semaphore"]
        C[("Permit count")]
        Q[("Wait queue")]
    end
    R["Scarce resource"]:::ext
    T -->|"1 acquire"| S
    S -->|"2 a permit is free: take one"| C
    S -->|"3 none free: park the caller"| Q
    S -->|"4 permit granted, proceed"| T
    T -->|"5 use the resource, N at a time"| R
    T -->|"6 release when done"| S
    S -->|"7 hand the permit to a waiter"| Q
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="acquire takes a permit or blocks at zero; release returns one and wakes a parked waiter, which re-checks and proceeds."
flowchart TB
    A["acquire()"] -->|"request permit"| C{"permits > 0?"}
    C -->|"yes"| E["take permit, enter section"]
    C -->|"no"| P["park in wait queue"]
    E -->|"work done"| R["release()"]
    R -->|"return permit"| C
    R -->|"wake one waiter"| P
    P -.->|"resumes, re-checks"| C
```

## Variations
<!--meta block=variations-->

- **Counting semaphore** — The general form: N permits let up to N threads hold a resource at once. This is the default you reach for when the cap is greater than one — throttling concurrent operations without dedicating a worker per slot. Dijkstra invented the primitive in the early 1960s and named the two operations P and V, which POSIX spells `sem_wait` and `sem_post`.
- **Binary semaphore (N = 1)** — A single permit makes it behave like a lock. The difference from a mutex is ownership: a semaphore records no holder, so any thread may release it — useful for signalling between threads (one waits, another posts), but a poor fit for mutual exclusion, where you want only the acquirer to release and want reentrancy.
- **Permits as a budget** — Instead of one-permit-per-caller, one permit represents one unit of a divisible resource — a megabyte, a byte of bandwidth, a token. A caller acquires as many permits as it will use and releases exactly that many, so aggregate consumption is bounded even though each operation's size varies.
- **Timed / try-acquire** — Rather than block forever, acquire with a timeout (or a non-blocking attempt) and fail when no permit arrives in time. Essential on request paths: it converts an indefinite hang into a fast, visible rejection the caller can turn into a 503 or a retry.
- **Fair vs. barging** — When a permit frees, does the longest-waiting thread get it (FIFO (first in, first out) fairness) or may a newly arriving thread barge in ahead of the queue? Barging gives higher throughput; strict fairness prevents a waiter from being starved indefinitely under heavy contention, at some cost in throughput.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One explicit number caps concurrency or consumption** — a single dial for how much of a scarce resource is in use at once.
- **Bounds in-flight work independent of thread count** — any thread may hold a permit, so you throttle load without dedicating a worker per unit.
- **Blocking is OS-efficient** — a waiter parks and is woken on release, with no spin-polling or sleep-and-retry.
- **Permits-as-a-budget generalizes past counts** — the same primitive throttles megabytes of memory or bandwidth, not just how many operations run.

### Cons
<!--meta polarity=con-->

- **A leaked permit never comes back** — miss the release on an exception and the ceiling ratchets down until the semaphore deadlocks at zero.
- **A bare acquire blocks forever** — on a request path a starved caller waits indefinitely, so users see timeouts while monitoring shows no errors; a timed acquire is needed to [fail fast](../../principles/fail-fast.md).
- **It grants permission**, not objects — a semaphore says "there is room" but hands out no connection or buffer; when callers need the actual resource you still need a pool behind it.
- **No ownership or reentrancy** (a thread re-taking what it already holds) — unlike a mutex, any thread can release a permit it never took, so a double-release or a wrong initial count silently lifts the real ceiling above the intended one.
- **Counting is manual for variable-size budgets** — the caller must acquire and release exactly the right number of permits, and an off-by-one in that arithmetic is a slow [resource leak](../../hazards/resource-leak.md).

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need to let at most N callers** into a section at once — more than one, but still bounded — such as capping concurrent calls to a downstream that sheds load past a threshold.
- **You're bounding total consumption of a divisible resource** — megabytes of buffer, in-flight bytes, disk I/O — where each operation uses a variable amount.
- **You want to throttle in-flight work** without a fixed [worker pool](./thread-pool.md) — any thread can hold a permit, so the cap rides on top of whatever concurrency you already have.

### Avoid when
<!--meta polarity=avoid-->

- **The limit is one** and you want plain mutual exclusion — a lock or monitor states that intent more clearly and gives you ownership and reentrancy.
- **Callers need the actual resource object**, not just permission — a connection, a GPU handle — where a blocking-queue resource pool that dispenses the objects fits better.
- **You need to wait until a specific state** holds, not merely for a free slot — that is condition-variable territory, handled by a [monitor object](./monitor-object.md).
- **The real limit is a rate, not concurrency** — a semaphore caps calls in flight, so throughput is permits divided by latency; for calls per second use a [rate limiter](../distributed/resilience/rate-limiter.md), and to isolate one downstream from another a [bulkhead](../distributed/resilience/bulkhead.md).

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a counting semaphore gating outbound calls"

// A buffered channel is a counting semaphore: its capacity is the permit
// count, a send takes a permit, and a receive returns one.
type Semaphore chan struct{}

var ErrBusy = errors.New("no permit in time")

// Acquire waits for a free slot, but only up to the timeout: a plain wait
// would hang a request forever, a timed one turns the hang into an error.
func (s Semaphore) Acquire(timeout time.Duration) error {
	select {
	case s <- struct{}{}: // a slot was free, or one freed while we waited
		return nil
	case <-time.After(timeout):
		return ErrBusy
	}
}

// A surplus Release blocks forever on the empty channel; Java and Python
// semaphores instead silently raise the count, except BoundedSemaphore.
func (s Semaphore) Release() { <-s }

// Cap calls to a fragile downstream at 5 at a time.
var gate = make(Semaphore, 5)

func callDownstream() error {
	if err := gate.Acquire(time.Second); err != nil {
		return err
	}
	defer gate.Release() // always release, even if the call panics
	return nil           // ... the downstream call goes here
}
```

## In the wild
<!--meta block=wild-->

- **Java java.util.concurrent.Semaphore** — The canonical counting semaphore on the Java virtual machine (JVM): constructed with a permit count, acquire()/release() move the counter, tryAcquire(timeout, unit) fails instead of blocking forever, and a boolean fairness argument switches wake order from barging to FIFO. acquire(n)/release(n) take several permits at once for the budget idiom, and any thread may release. {#wild-java-semaphore}
- **Python threading.Semaphore / asyncio.Semaphore** — Bound concurrent work in either threaded or async code; both act as context managers (with / async with) so the permit is released even on exception. BoundedSemaphore raises if released more times than acquired, catching the double-release miscount that silently raises the ceiling. {#wild-python-semaphore}
- **Go buffered channel as a counting semaphore** — A buffered channel of capacity N is the idiomatic counting semaphore — send an empty struct to take a slot, receive to release; a full channel blocks the sender until a slot frees. The golang.org/x/sync/semaphore package adds a weighted variant whose Acquire(ctx, n) requests several units at once for the budget idiom. {#wild-go-chan-semaphore}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **permit count** — the ceiling itself — how many callers may hold a permit at once; size it to what the protected resource absorbs, not to how many threads might ask; start from the downstream's documented concurrency limit, else call rate x call latency (the explain example's 10 / 0.2), then load-test until shed or error rate rises
- **fairness mode** — FIFO queueing versus barging — fair ordering stops long waiters being overtaken, barging gives higher throughput under contention; java.util.concurrent.Semaphore takes it as a constructor flag
- **acquire timeout** — how long a caller waits before giving up — an untimed acquire waits forever, a timed try-acquire turns a saturated resource into a fast, visible failure the caller can handle; keep it below the caller's own deadline (the sketch uses 1 s)
- **permits per operation** — when a permit is a unit of a divisible budget rather than a slot, how many units one operation claims — the unit sets the granularity of the cap and how much it over- or under-counts

### Signals to watch
<!--meta polarity=signal-->

- **permits available** — the live count against the initial one — sustained zero means the limit, or the resource behind it, is the bottleneck
- **waiters parked** — how many callers are blocked in acquire right now — a queue that never empties is demand the ceiling is refusing
- **acquire wait time** — the wait before a permit is granted, as a distribution — the tail is what users feel, the mean hides it
- **acquire timeout rate** — how often a timed acquire gives up empty-handed — this is the load the cap is shedding, and it belongs on a dashboard
- **permits available at idle** — once traffic goes quiet the count should equal its initial value; lower is a leaked permit, higher is a double release or miscount

### Failure modes under load
<!--meta polarity=failure-->

- **permit leak** — a release missed on an exception path ratchets the ceiling down over time until every acquire blocks — it presents as a slow hang, not as an error
- **unbounded queueing** — under saturation an untimed acquire parks callers indefinitely: users see client-side timeouts while the service itself reports no failures at all
- **a ceiling that protects nothing** — set above what the downstream tolerates, the cap admits load that gets shed anyway — the dial looks configured and changes nothing; the count is per process, so N replicas multiply the ceiling on the downstream by N: divide the downstream's capacity by the instance count
- **waiter starvation** — with barging, a steady stream of new arrivals can keep earlier waiters parked — mean acquire time moves little while the p99 and max wait grow far beyond it
- **budget arithmetic drift** — in budget mode, claiming fewer permits than an operation consumes lets real usage exceed the budget; releasing fewer than claimed leaks capacity a little at a time

### Readiness checklist
<!--meta polarity=check-->

- every acquire has a matching release in a finally block or scope guard, on every error path as well as the happy one
- acquires on a request path are timed, with a timeout shorter than the caller's own deadline
- the permit count is worked out from what the protected resource tolerates, and that reasoning is recorded next to the number
- permits available and acquire wait time are exported as metrics, with an alert on sustained saturation
- behaviour at the limit — queue, reject, or degrade — is decided, tested, and visible to the caller
- a load test confirms permits available returns to the initial count after the load stops

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Allow only N threads at a time into a resource. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Thread Pool](./thread-pool.md) — A pool bounds concurrency; a counting semaphore is the primitive that does the bounding
- [Bulkhead](../distributed/resilience/bulkhead.md) — One permit budget per remote service is how a semaphore becomes a bulkhead

**Often confused with**

- [Monitor Object](./monitor-object.md) — A binary semaphore (one permit) is a lock — but a counting semaphore admits N, not one
- [Mutex](./mutex.md) — Counts permits with no owner, so any thread may release and many may hold at once

**Prevents**

- [Unbounded Queue](../../hazards/unbounded-queue.md) — Bounds in-flight work at the permit count; waiters still queue unless acquire is timed or the caller count is capped
- [Resource Leak](../../hazards/resource-leak.md) — Only with release in a finally block and a timed acquire; without them a leaked permit drains the semaphore itself
- [Thundering Herd](../../hazards/thundering-herd.md) — Throttles a released crowd to N at a time rather than eliminating it; the rest wait their turn

**Exposed to**

- [Connection-Pool Exhaustion](../../hazards/connection-pool-exhaustion.md) — Can fall into connection pool exhaustion when a counted permit with no acquire timeout parks callers behind slow holders

<!-- relationships:end -->
