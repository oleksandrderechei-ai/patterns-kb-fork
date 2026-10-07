---
title: Synchronous I/O
description: "A thread sits blocked while I/O completes, doing no work"
area: hazards
owner: Oleksandr Derechei
tags: [performance, asynchrony, throughput, resource-management]
status: stable
aliases: [blocking I/O, blocking calls]
solves: [requests queue while the CPU sits nearly idle, every worker thread is parked on the same call in the thread dump, adding more threads is the only thing that helps and it stops helping, a slow dependency turns into timeouts on unrelated endpoints, the server reports it is out of capacity on a machine that is not busy]
---

# Synchronous I/O

A thread issues an I/O call and then waits, holding its stack and its memory but consuming no processor, until the answer arrives. The work the machine could be doing meanwhile is not done, and the number of requests the process can have in flight is capped by how many threads it can afford rather than by how much work it can do.

## What it is
<!--meta block=description-->

Synchronous I/O blocks the calling thread until a read, a remote call or a queue take completes, and the thread can serve no one else meanwhile. You see a saturated system that is not busy: CPU stays low, requests queue, and a thread dump shows nearly every worker parked on the same call. The defining trait is that the waiting, not the work, uses up the threads, so one blocking call inside a library makes a whole async path blocking.

## Explained
<!--meta block=explain-->

Synchronous I/O makes the calling thread wait, doing nothing, until a read, a remote call or a queue message completes, and the thread cannot serve anyone else meanwhile. That is fine when waits are microseconds and callers few. When waits reach milliseconds and callers reach thousands, you run out of threads long before you run out of processor, so the system is saturated but not busy. The request must wait for its answer, but the thread need not. For waits that reach milliseconds, choose non-blocking calls over a bigger pool, since each thread costs memory and scheduling and a larger pool only moves the ceiling; measure first for very short calls. A [reactor](../patterns/concurrency/reactor.md) (a few threads waiting on many sources, handling each event as it is ready) can hold tens of thousands of open calls on a handful of workers, given small per-call state and enough memory. A [future](../patterns/concurrency/future-promise.md) names the pending answer. Run unavoidable blocking libraries on a separate bounded pool, a [bulkhead](../patterns/distributed/resilience/bulkhead.md), so they cannot stall the event thread.

- **Clarity.** Straight-line code becomes continuations and stack traces stop showing the path, so carry a correlation id explicitly.
- **Moved bottleneck.** Unblocked threads send more concurrent calls downstream, so cap in-flight calls and set a deadline on each.

**Example.** A service has 200 request threads, and each request blocks 200 ms on a database call. It finishes 200 / 0.2 = 1,000 requests a second. Traffic reaches 1,200 a second, which needs 240 threads, so requests queue while the processor sits near 5%, since the 200 ms is almost all waiting. If the database slows to 1 s, capacity falls to 200 a second. With non-blocking calls on 4 event threads, 240 calls in flight are just 240 small records, and the threads stay free. The database now receives all 1,200 a second, so cap it.

## How it happens
<!--meta block=causes-->

```mermaid caption="Each worker is held for the whole round-trip at step 2–3, so the pool empties long before the machine is busy. Arrivals then queue for a thread rather than for work, and the failure at step 6 is a wait for capacity that exists but is parked."
flowchart TB
    A["Arriving requests"] -->|"1 · take a worker"| B["Worker thread pool<br/>fixed size"]
    B -->|"2 · issue the call and block"| C["Remote store or service"]
    C -->|"3 · answer, tens of ms later"| B
    B -->|"4 · worker freed"| D["Response"]
    A -->|"5 · no worker left"| E["Request queue grows"]
    E -->|"6 · wait exceeds the limit"| F["Timeouts, while the processor idles"]
```

- **It is the obvious way to write it.** Call, get an answer, use the answer — the code reads top to bottom and matches how the operation is described. The asynchronous version says the same thing with more ceremony, and nothing in the source hints at what the blocking version costs under load.
- **The result is genuinely needed next.** Where the following line depends on the value, waiting feels not merely simplest but mandatory — and the distinction that matters, between this request waiting and this thread waiting, is invisible from inside the function.
- **The library offers nothing else.** A dependency exposing only blocking calls forces its callers to block, whatever the surrounding code intended.
- **A blocking call hides inside an asynchronous one.** A method whose signature promises not to block can still perform synchronous I/O internally, so a single such link makes the whole chain above it synchronous while its callers still believe otherwise.
- **Small waits are assumed to stay small.** A call that was a local file read or an in-memory lookup when it was written keeps its blocking shape after the thing it reads moves behind a network, where the wait is three orders of magnitude longer.

## What it costs
<!--meta block=cost-->

- **Concurrency is capped by threads, not by work.** The number of requests the process can have in flight equals the number of workers, so a wait of tens of milliseconds sets a ceiling on throughput that spare processor alone cannot lift; only more threads or non-blocking calls do.
- **The machine idles while the queue grows.** Utilization stays low and requests still time out. The system looks under-loaded exactly as it fails.
- **Each blocked worker holds memory it is not using.** Its stack stays allocated for the whole wait, so raising the pool size to compensate buys concurrency in exchange for footprint and for scheduler time spent switching between threads that are all doing nothing.
- **It couples your availability to theirs.** A dependency that slows down exhausts your workers, so its latency becomes your outage, and each blocked worker may also hold a connection or lock. This is the mechanism behind [Cascading Failure](./cascading-failure.md).
- **The collapse is a cliff.** While a worker is free, latency is the dependency's latency; once the last one is taken, every arrival waits for a whole round-trip before it even starts, and response time steps up by a multiple rather than drifting.
- **No deadline, no recovery.** A blocking call with no deadline turns a slow dependency into a permanent worker leak: the thread never returns.

## Getting out
<!--meta block=mitigation-->

Stop conflating the request waiting with the thread waiting. The request must wait for its answer; the thread need not, and releasing it is the whole of the fix. Where the runtime offers a non-blocking version of the call, take it — the operation is registered, the worker goes back to the pool, and the continuation runs when the answer arrives, so one worker can carry many requests in flight. A **[Future / Promise](../patterns/concurrency/future-promise.md)** is how that pending answer is named and composed while the thread that asked for it is somewhere else.

Underneath, this is the **[Reactor](../patterns/concurrency/reactor.md)**: a small number of threads waiting on many I/O sources at once and dispatching each event as it becomes ready, instead of one thread per outstanding operation. It is what lets a process hold tens of thousands of open calls on a handful of workers. The price is real — the linear story becomes a set of continuations, stack traces stop describing the call path, and any genuinely blocking work dropped into an event-loop thread stalls every request that thread was carrying, not just its own.

Wrapping a blocking call in an asynchronous signature does not remove the block; it moves it to another thread, and that thread is now blocked instead. Done deliberately — on a bounded pool kept separate from the request path — it is a reasonable containment for a library you cannot change, and it is a form of [Bulkhead](../patterns/distributed/resilience/bulkhead.md): the blocking work can exhaust its own pool without touching the workers answering requests. Done accidentally, it adds a hop and a context switch to buy nothing.

Not every call should change. An operation that is genuinely short and uncontended can cost more to dispatch and re-synchronize than it costs to wait for, so measure before converting; the rule holds wherever waits are long or callers many; short uncontended calls are the exception. Measure wait time against dispatch overhead and how often the call blocks a worker. And expect the bottleneck to move rather than vanish: unblocking the threads raises how many requests reach the dependency at once, which turns a thread-starved caller into a saturated store or a throttled downstream. Pair the change with a limit on concurrent calls and a deadline on each one.

To confirm it, take a thread dump and look for workers parked on one call, and watch pool queue depth and pool-wait time while CPU stays low. Size the cap on in-flight calls as concurrency = throughput x latency, as in the worked example; give a bulkhead pool the same sizing, bound its queue and reject on overflow. [Reactor](../patterns/concurrency/reactor.md) reports that a handle is ready and you do the read; [Proactor](../patterns/concurrency/proactor.md) reports that the operation has finished.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Cascading Failure](./cascading-failure.md) — Exhausted workers turn a slow dependency's latency into the caller's outage, which then spreads upstream

**Mitigated by**

- [Reactor](../patterns/concurrency/reactor.md) — A few threads wait on many I/O sources at once, so concurrency stops being capped by thread count
- [Future / Promise](../patterns/concurrency/future-promise.md) — Name the pending answer so the request can wait without its thread waiting too
- [Proactor](../patterns/concurrency/proactor.md) — Starting I/O without waiting for it keeps the loop thread free to serve other work
- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — Blocking calls that exhaust a pool are what the compartment contains

**Threatens**

- [Thread Pool](../patterns/concurrency/thread-pool.md) — A fixed pool of worker threads runs out when each one parks on a blocking call
- [Active Object](../patterns/concurrency/active-object.md) — A scheduler thread that blocks on one call stalls every queued method request
- [Scatter-Gather](../patterns/messaging/scatter-gather.md) — The gather step ties up a thread per outstanding branch while it waits for replies

<!-- relationships:end -->
