---
title: Active Object
description: "A call becomes a queued request that the object's own thread runs, and the caller gets a future back"
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, asynchrony, isolation]
status: stable
solves: [every caller waits while one slow method runs on a shared object, I need all changes to the state of an object to happen on one thread without locks, a method call should return at once and give me the result later, many threads call one device or file handle and the calls must run in order]
---

# Active Object

An object that owns a thread and a queue: callers invoke its methods, the calls are queued as requests, and the object's thread runs them one at a time while each caller gets a future back.

## What it is
<!--meta block=description-->

A caller that invokes a slow method on a shared object blocks until it finishes, and the object needs a lock so two callers do not corrupt its state. An active object decouples the call from the run. The call becomes a queued request, a private thread runs requests one at a time, and the caller gets a future (a handle to a result that is not ready yet) at once.

## Explained
<!--meta block=explain-->

An active object gives an object its own thread of control. A caller invokes a method, the proxy wraps the call as a request, puts it on a queue and returns a [future](./future-promise.md) at once, and a scheduler thread inside the object runs the requests one at a time against private state. That state needs no lock, and no caller waits for a slow method. Choose it over a [mutex](./mutex.md) when callers must not block on the object, and over the [actor model](./actor-model.md) when you want ordinary typed method calls and futures rather than untyped messages sent to an address.

- **Queue hop.** Every call pays an enqueue and a thread switch, microseconds instead of nanoseconds. Keep tiny hot methods out of it.
- **Head-of-line blocking.** One slow request delays every request behind it. Run slow I/O on another executor.
- **Hidden overload.** An unbounded queue grows while latency climbs. Bound it and choose what a full queue does.

**Example.** A logger object writes to disk in 5 ms, so its thread serves at most 200 writes a second. Callers call it 500 times a second in total. Each call costs the caller roughly 1 microsecond on a typical machine, because it only enqueues. The queue grows by 300 requests a second. With a bound of 1,000 it fills in about 3 seconds, and callers then block or get a rejection. The cost is that you now own an overload policy, which a plain lock would have hidden behind slow callers.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a call reach the object's thread without blocking the caller? Steps 1 and 2 return at once, and the scheduler in steps 3 to 5 is the only code that touches the state."
flowchart LR
    C["Caller threads"]
    subgraph AO["Active object"]
        P["Proxy"]
        Q[("Request queue")]
        S["Scheduler thread"]
        ST[("Private state")]
    end
    F["Future"]
    C -->|"1 call method()"| P
    P -->|"2 enqueue request, return future"| Q
    S -->|"3 dequeue next request"| Q
    S -->|"4 run it on the state"| ST
    S -->|"5 set result"| F
    C -->|"6 get result later"| F
```

```mermaid caption="Two callers invoke the object at once. Both return immediately, and the scheduler runs their requests in arrival order, so the state is never touched by two threads."
sequenceDiagram
    participant A as Caller A
    participant P as Proxy
    participant S as Scheduler
    participant B as Caller B
    A->>P: write("x")
    P-->>A: future A
    B->>P: write("y")
    P-->>B: future B
    S->>S: run request A
    S-->>A: future A resolved
    S->>S: run request B
    S-->>B: future B resolved
```

## Variations
<!--meta block=variations-->

- **Method request object** — Each call is packaged as a command object that holds its arguments and a slot for its future. The scheduler can then reorder, merge or drop requests before it runs them.
- **Priority scheduler** — The queue is ordered by priority or deadline instead of arrival. Urgent calls jump ahead, and a low-priority request can starve unless you age it.
- **Guarded requests** — A request carries a guard, and the scheduler skips it until the guard is true, for example a buffer-not-full check. It replaces the condition variables of a [monitor object](./monitor-object.md).
- **One thread, many objects** — Several active objects share one scheduler thread or a small pool, so ten thousand objects do not cost ten thousand threads.
- **Fire and forget** — The proxy returns nothing and the caller never waits. It suits logging and notifications, and failures then need a separate channel.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Callers do not wait for the method to run** — a call costs an enqueue until the bounded queue is full, and a slow method delays only its own result.
- **No lock around the state** — one thread touches it, so the body of every method reads as single-threaded code.
- **Callers see a plain method API** — the proxy hides the queue and the thread, so callers keep ordinary typed calls and futures.
- **Order is explicit** — requests run in queue order, which gives a clear place to add priorities or batching.

### Cons
<!--meta polarity=con-->

- **One slow request delays all the ones behind it** — the thread runs one at a time, which is [head-of-line blocking](../../hazards/head-of-line-blocking.md), so put slow I/O on another executor.
- **An unbounded queue hides overload** — memory grows while latency climbs, so bound the queue and decide what a full queue does.
- **Each call pays a queue hop and a thread switch** — a call that was 50 ns becomes microseconds, so do not use it for tiny hot methods.
- **Stack traces stop at the proxy** — the failure surfaces on the future, so log the request origin when you enqueue.
- **A request that waits on a future from its own object deadlocks** — the scheduler thread waits for itself, so chain with callbacks or return the future instead.
- **A crashed scheduler strands queued futures** — catch exceptions in the loop and resolve each future with the error, and decide on close whether pending requests drain or are cancelled.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Many callers share one stateful object** and a slow method must not block them.
- **The object wraps a resource that wants one writer**, such as a file, a device or a connection.
- **Callers need a result later**, and a future fits better than a callback.
- **You want lock-free object code** and can pay one queue hop per call.

### Avoid when
<!--meta polarity=avoid-->

- **A method is a few instructions long** — a [mutex](./mutex.md) costs far less than a queue hop and a thread switch.
- **Callers need the answer before they continue** — a synchronous call through a queue only adds latency.
- **Each caller can own its data** — [thread confinement](./thread-confinement.md) needs no queue at all.
- **You need addressable, supervised, distributed workers** — the [actor model](./actor-model.md) gives you addresses and failure handling.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a counter object whose goroutine owns the state and returns futures"
var errFull = errors.New("queue full")

type req struct {
	delta int
	reply chan int // the future: resolved once, read once
}
type Counter struct{ in chan req }

func NewCounter() *Counter {
	c := &Counter{in: make(chan req, 64)} // bounded queue
	go func() {
		n := 0 // private state: one goroutine owns it, so no lock
		for r := range c.in {
			n += r.delta
			r.reply <- n
		}
	}()
	return c
}

// Add returns at once; the caller reads the future when it needs the value.
func (c *Counter) Add(d int) (<-chan int, error) {
	r := req{delta: d, reply: make(chan int, 1)}
	select {
	case c.in <- r:
		return r.reply, nil
	default:
		return nil, errFull // bounded: a full queue rejects; a plain send would block
	}
}

// Close stops the goroutine after queued requests drain; Add after Close panics.
func (c *Counter) Close() { close(c.in) }

func main() {
	c := NewCounter()
	defer c.Close()
	f1, _ := c.Add(1) // both enqueue without waiting
	f2, _ := c.Add(10)
	fmt.Println(<-f1, <-f2) // 1 11
}
```

## In the wild
<!--meta block=wild-->

- **ACE (Adaptive Communication Environment)** — The C++ framework from Douglas Schmidt. It ships an activation queue and method request classes that implement the pattern. {#wild-ace}

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Hand method calls to one owning thread through a queue and get futures back. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Future / Promise](./future-promise.md) — Each call returns a future (a handle to a result that is not ready yet) that the scheduler thread resolves

**Alternative to**

- [Actor Model](./actor-model.md) — Both give state one owning thread; this one exposes ordinary typed method calls and futures
- [Mutex](./mutex.md) — Moves the shared state behind a queue and one thread, so callers never block on a lock
- [Monitor Object](./monitor-object.md) — Adds a queue and a thread, so callers return at once instead of waiting inside the lock
- [Thread Confinement](./thread-confinement.md) — Confines state to one thread and lets callers reach it through a queued request

**Exposed to**

- [Synchronous I/O](../../hazards/synchronous-io.md) — Can fall into synchronous io when a scheduler thread that blocks on one call stalls every queued method request
- [Head-of-Line Blocking](../../hazards/head-of-line-blocking.md) — One slow request on the single scheduler thread holds every queued request behind it
- [Unbounded Queue](../../hazards/unbounded-queue.md) — An unbounded request queue turns overload into growing memory and latency

<!-- relationships:end -->
