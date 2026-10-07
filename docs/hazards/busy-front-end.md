---
title: Busy Front End
description: Background work on the threads meant to answer requests
area: hazards
owner: Oleksandr Derechei
tags: [performance, isolation, resource-management, throughput]
status: stable
aliases: [background work on the web tier]
solves: [a trivial endpoint got slow whenever people upload files, we moved the heavy work to a background thread and the server still fell over, one expensive operation drags down every other route on the tier, background jobs vanish when we deploy, CPU pins at 100 percent and every response slows together]
---

# Busy Front End

A request-handling tier runs heavy work in the background so that the request can return quickly. The request does return quickly, and the work keeps consuming the same processor, memory and bandwidth the tier needs to answer everyone else — so unrelated, cheap requests slow down for reasons their own code cannot explain.

## What it is
<!--meta block=description-->

A busy front end is a request-serving process that also does heavy lifting, such as resizing images or running imports, on threads beside the ones answering requests. You recognize it by collateral damage: a trivial endpoint slows in step with how often the expensive one is called, and failures are generic capacity errors. The defining trait is that the work still competes for the same processor and memory, with nothing limiting how many jobs start.

## Explained
<!--meta block=explain-->

A busy front end is a web tier that also does heavy work itself, such as resizing images or running imports, on background threads started beside the ones answering requests. Starting the work on a thread frees the caller at once, which looks like offloading, but the work still uses the same processor and memory as every other request. Nothing caps how many such jobs run together, so their number follows how many users ask. A job held only in memory is also lost when the process restarts, though the caller was told it was accepted. Choose a separate worker tier over more front-end servers, because more servers add capacity only in step with their count and leave the coupling in place. The front end writes the job to a queue ([queue-based load leveling](../patterns/distributed/resilience/load-leveling.md)) and returns, and workers drain it at a rate they can sustain. If the work must stay in-process, give it a small fixed pool of its own.

- **Later results** Work finishes after the reply, so the caller must poll or be notified of the result.
- **Unbounded queue** An uncapped queue only moves the overload, so cap it and reject at the front door.

**Example.** A front end with 8 cores handles 400 profile requests a second at 5 ms each, so 2 cores. Each photo upload also starts a thread that spends 2 s of processor time resizing. At 3 uploads a second that is 6 cores, so the 8 cores are fully used and any extra work makes profile calls wait. Move resizing to 6 worker cores, which finish 3 jobs a second, behind a queue capped at 100 jobs. A 10 s burst of 6 uploads a second adds 60 jobs and drains 30, so 30 wait, well under the cap, and the last one finishes about 10 s late. Profile latency stays flat.

## How it happens
<!--meta block=causes-->

```mermaid caption="Step 2 is the illusion: the caller is released while the work at step 3 continues on the machine. Nothing bounds how many such jobs run at once, so the cheap request at step 4 competes with all of them and degrades for reasons its own code cannot show."
flowchart TB
    A["Expensive request"] -->|"1 · start a background thread"| B["Front-end process"]
    A -->|"2 · return immediately"| C["Caller — looks fast"]
    B -->|"3 · heavy work keeps running"| D["Shared CPU, memory, bandwidth"]
    E["Cheap unrelated request"] -->|"4 · needs the same resources"| D
    D -->|"5 · demand exceeds the host"| F["Every route slows together"]
```

- **Returning early is mistaken for offloading.** Moving the work off the request thread solves a real problem, since the caller no longer waits, and is read as having solved the resource problem too, which it never touched.
- **Presentation and processing share one deployable.** When the tier that speaks to clients also holds the business logic, there is no other place for heavy work to go, and putting it on a thread is the only separation available.
- **Nothing caps how many jobs run at once.** One background job per request means the concurrency of the heavy work is set by arrival rate, which users choose, not capacity planning.
- **Threads are treated as free.** Each one costs a stack, a scheduling slot and its share of the processor, so spawning per request degrades into contention and, past the runtime's limit, into failures to start a thread at all.
- **Scaling out the wrong tier hides it for a release.** Adding front-end instances buys headroom proportional to the added machines, so the fix looks to work while leaving the coupling — and the bill — exactly where it was.

## What it costs
<!--meta block=cost-->

- **Cheap requests pay for expensive ones.** Latency on an endpoint that does almost nothing is set by whatever else the tier happens to be running.
- **The load is unbounded by construction.** Concurrency of the background work follows the arrival rate, so a burst of expensive requests pushes resource use past what anyone sized.
- **The two workloads cannot be scaled apart.** Serving more users and doing more heavy work need different amounts of different resources, and one deployable forces you to buy both whenever you need either.
- **Failures are opaque and generic.** What surfaces is timeouts and capacity errors across every route, so an incident starts by investigating the endpoints that are slow rather than the one that is guilty.
- **In-process work is lost when the process dies.** A background job holds no record outside the memory running it, so a deploy, a crash or an autoscaler scaling in discards work the caller was already told had been accepted.

## Getting out
<!--meta block=mitigation-->

Move the work off the machine, not just off the thread. The front end records the job and returns; a separate worker tier picks it up and does it. **[Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md)** is the shape: the queue absorbs the burst, and the workers drain it at whatever rate they can sustain, so a spike of requests becomes a steady flow of work. That also fixes the durability hole: a queued job survives the process that accepted it, which an in-memory thread does not. Before moving anything, attribute processor and thread time per route, and compare latency on a cheap endpoint with the call rate of the heavy one, so the guilty endpoint is named.

Size the two tiers independently once they are apart. **[Competing Consumers](../patterns/messaging/competing-consumers.md)** lets you add workers against queue depth without touching the request path, so throughput on the heavy work becomes a dial rather than a consequence of how many front ends you happen to be running. Depth usually rises before latency does, so scale on it, allowing for worker start-up time. This does mean the work now takes longer end to end than it did when it ran locally: you have traded completion time for isolation, and callers need an honest way to learn the outcome, since the response no longer carries it.

Where the work genuinely must stay in-process, at least bound it. A **[Bulkhead](../patterns/distributed/resilience/bulkhead.md)** (a separate, fixed-size pool for the heavy work) means saturating it costs you that pool and not the workers answering requests: the expensive operation degrades, everything else keeps its latency. Sizing that pool is the whole decision, and it has to be small enough that the leftover capacity still serves the request path under peak. Cap the pool at the total cores minus what the request path measurably uses at peak.

Adding a queue relocates the failure rather than removing it, so decide in advance what happens when the workers cannot keep up. Depth grows without limit unless something stops it, which is [Unbounded Queue](./unbounded-queue.md) in a new place; cap it and reject at the front door instead. Choose the cap as the longest acceptable wait times the drain rate; in the example, a cap of 100 at 3 jobs a second means the last job waits about 33 s. Scale workers out when depth divided by the per-worker rate exceeds that wait. Decide too whose work gets dropped first: separating the queues by class, or holding a rate limit on the cheapest tier of caller, is what keeps a flood of low-value jobs from displacing the ones that matter. And make redelivery safe: a queue that guarantees delivery at least once will eventually hand the same job to two workers.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Unbounded Queue](./unbounded-queue.md) — A queue added to relieve the front end grows without limit unless it is capped and rejects at the front door

**Mitigated by**

- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — Queue the heavy job and let a separate tier drain it at a rate it can sustain
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — Scale the workers against queue depth, independently of how many front ends are running
- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — Where the work must stay in-process, a separate fixed pool keeps it from taking the request workers
- [Web-Queue-Worker](../patterns/architecture/web-queue-worker.md) — Put the heavy job on workers that drain a queue, away from the threads that answer users
- [Asynchronous Request-Reply](../patterns/distributed/routing/async-request-reply.md) — Give callers a handle to poll or a callback, since the response no longer carries the outcome

**Threatens**

- [Thread Pool](../patterns/concurrency/thread-pool.md) — Background jobs sharing the request pool or the same cores starve request handling
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — A gateway that transforms payloads itself spends the tier's cores on that work

<!-- relationships:end -->
