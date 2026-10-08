---
title: Thread Pool
description: Reuses a fixed set of worker threads
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, resource-management, throughput]
status: stable
aliases: [worker pool, executor]
solves: [spawning a thread per request works fine until traffic doubles and the box falls over, my process has thousands of threads and spends more time switching than working, memory blows up under load because every in-flight request carries its own stack, I need a hard ceiling on how much work runs at once instead of one per arrival, creating and tearing down a thread costs more than the tiny job I run on it]
---

# Thread Pool

Reuses a fixed set of worker threads to run a stream of tasks, so the cost of spinning up and tearing down a thread is paid once instead of on every request — and the number of threads running at once stays bounded no matter how much work arrives.

## What it is
<!--meta block=description-->

Starting a thread for every request costs a stack and scheduler time, and under load it means thousands of threads thrashing. A thread pool keeps a fixed set of workers alive in front of a task queue. Each worker takes a task, runs it to the end and loops back for another. Pool size sets real parallelism, and the queue absorbs bursts.

## Explained
<!--meta block=explain-->

A thread pool keeps a fixed set of worker threads that take tasks from a queue and run them one after another. You skip the cost of starting a thread for every task, and you cap how many tasks run at once, so a burst of requests waits in the queue instead of becoming a burst of threads. Choose it over a new thread per task when tasks are short and many.

- **Sizing** For CPU-bound work use about one thread per core; for waiting work use cores x (1 + wait / work), measured on your tasks.
- **Blocked workers** One blocking task holds a worker for its whole wait and starves the queue; give blocking work its own pool.
- **Hidden overload** An unbounded queue hides overload as memory growth; bound it and decide what a full queue does with a new task.
- **Leftover state** Thread-local data or an uncaught exception can carry into the next task; clear thread-locals and catch errors inside each task.

**Example.** An 8-core machine runs tasks that spend 90 ms waiting on a network call and 10 ms on the CPU. A pool of 8 threads finishes 8 / 0.1 s = 80 tasks a second. If 200 arrive each second, the queue grows by 120 a second and, unbounded, exhausts memory. The size rule gives 8 x (1 + 90 / 10) = 88 threads, which raises the ceiling to 8 / 0.01 s = 800 tasks a second, so 200 a second no longer queues; check that the downstream can take 88 calls at once. With the 8-thread pool and a queue bound of 1,000, rejection starts after about 8 s, so callers see "busy" instead of silent growth.

## How it works
<!--meta block=structure-->

```mermaid caption="What stops a burst of requests from becoming a burst of threads? Step 1 puts the task in the queue instead of on a new thread, and step 6 sends the same worker back for the next one — so the number of live threads stays whatever the pool was sized to."
flowchart LR
    C["Caller"]
    subgraph Pool["The pool — a fixed crew behind one queue"]
        Q[("Task queue, bounded")]
        W1["Worker 1"]
        W2["Workers 2..N"]
    end
    H["Handle the caller keeps"]
    C -->|"1 submit a task"| Q
    C -->|"2 carry on holding a handle"| H
    Q -->|"3 a free worker takes the next task"| W1
    Q -->|"4 the rest wait their turn"| W2
    W1 -->|"5 result completes the handle"| H
    W1 -.->|"6 worker loops back for more"| Q
```

## Variations
<!--meta block=variations-->

- **Fixed-size pool** — N threads created up front and reused for the life of the process. The simplest and most predictable default, as in the Java Executors fixed-pool factory.
- **Cached / elastic pool** — Grows as demand rises and retires idle threads after a timeout, trading a hard resource ceiling for lower latency under bursty, uneven load. The cap is optional: Java's cached executor sets none, so a burst can become a thread explosion unless you bound it.
- **Work-stealing pool** — Each worker owns its own task deque and steals from a busy neighbor's when its own is empty, instead of every thread contending on one shared queue — how `ForkJoinPool`-style runtimes scale many small, unevenly sized tasks.
- **[Bulkhead](../distributed/resilience/bulkhead.md) pools** — One dedicated pool per tenant, endpoint, or workload type instead of a single shared pool, so a caller that saturates its own pool can't starve every other caller's threads too.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Amortizes thread creation cost** — threads are built once and reused across many tasks.
- **Bounds live concurrency to a known number** — live threads are capped, protecting the scheduler and stack memory; queue memory is protected only if the queue is bounded too.
- **The queue absorbs bursts** instead of turning every spike into more live threads.
- **One number** — pool size — is a single, tunable knob for real parallelism.

### Cons
<!--meta polarity=con-->

- **Sizing is genuinely hard**: too few threads underuses the hardware, too many causes context-switch thrashing.
- **One long-running or blocking task** can occupy a worker indefinitely and starve every other queued task.
- **An [unbounded queue](../../hazards/unbounded-queue.md) hides [backpressure](./backpressure.md)** — tasks pile up in memory instead of the caller ever seeing "busy."
- **Tasks share threads**, so leftover thread-local state or an uncaught exception in one task can bleed into the next.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Many short, similar units of work** — requests, jobs, callbacks arrive as a stream to run concurrently.
- **Creating a thread per task** would be measurably expensive relative to the task itself.
- **You need a hard, known ceiling** on how many threads can be running at once.

### Avoid when
<!--meta polarity=avoid-->

- **Tasks block indefinitely** or run for a very long time — they'll occupy a worker and starve the rest of the queue.
- **The runtime already gives you a cheaper** concurrency unit — an event loop, a coroutine, or a lightweight actor — where dedicating an OS thread per unit of work is overkill.
- **The workload is purely CPU-bound** and what you actually want is one thread per core, not a generically sized pool.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a fixed pool of workers in front of a bounded queue"

// Pool keeps size workers alive in front of a bounded queue. Close: close(queue), wg.Wait().
type Pool struct {
	queue chan func()
	wg    sync.WaitGroup
}

func NewPool(size, queueLen int) *Pool {
	p := &Pool{queue: make(chan func(), queueLen)}
	for i := 0; i < size; i++ { // workers are built once, up front
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			for task := range p.queue { // run a task, loop back for the next
				task()
			}
		}()
	}
	return p
}

// Submit queues a task, or says "busy" instead of letting the queue grow.
func (p *Pool) Submit(task func()) error {
	select {
	case p.queue <- task:
		return nil
	default:
		return errors.New("queue full")
	}
}
```

## In the wild
<!--meta block=wild-->

- **java.util.concurrent.ExecutorService** — ThreadPoolExecutor and the Executors factory methods are the canonical fixed, cached, and work-stealing pools on the Java virtual machine (JVM). ThreadPoolExecutor exposes every knob directly — corePoolSize, maximumPoolSize, keepAliveTime, the BlockingQueue you hand it, and a pluggable RejectedExecutionHandler — which is why careful teams construct it explicitly rather than use Executors.newFixedThreadPool, whose convenience hides an unbounded queue. {#wild-java-executorservice}
- **.NET ThreadPool** — The runtime keeps a managed, self-tuning pool of workers that backs Task.Run and async continuations, so user code rarely creates threads directly. It adjusts worker count with a hill-climbing heuristic and injects threads beyond the minimum only at a deliberately slow rate — so ThreadPool.SetMinThreads is the standard operational fix when bursts of blocking work make requests stall waiting for thread injection. {#wild-dotnet-threadpool}
- **libuv** — Node.js offloads filesystem, DNS lookups, and CPU-heavy crypto such as pbkdf2 to libuv's fixed-size worker pool so blocking calls never stall the event loop. The pool defaults to just 4 threads, sized once at startup via the UV_THREADPOOL_SIZE environment variable — the classic symptom of leaving it alone is fs and dns latency spiking together the moment a fifth blocking call queues. {#wild-libuv}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **pool size** — the real parallelism dial (corePoolSize/maximumPoolSize in JVM terms): near core count for CPU-bound work; for IO-bound work threads = cores x (1 + wait / compute), with both times measured under real load, not guessed
- **queue bound** — an unbounded queue converts overload into silent memory growth and latency; a bounded one converts it into visible backpressure the caller must handle
- **rejection policy** — what happens when the queue is full — throw, block the submitter, run on the caller's thread, or drop; each pushes the pain to a different place, and the default was chosen for you
- **idle keep-alive** — how long an elastic pool retains an idle worker before retiring it; too short and every burst re-pays thread creation, too long and the pool never shrinks
- **core vs max with a bounded queue** — threads above core start only after the queue is full, so raising maximumPoolSize alone changes nothing while the queue has room; tune core, max and queue bound together

### Signals to watch
<!--meta polarity=signal-->

- **queue depth** — a burst that drains is fine; sustained growth means arrival rate exceeds service rate and latency is compounding
- **time-in-queue** — the wait a task suffers before it even starts — under saturation it dwarfs execution time, and callers feel the sum
- **active workers vs. pool size** — pinned at max for minutes is saturation; near zero with a deep queue means workers are blocked, not busy
- **rejection count** — every rejection is load the pool refused; a count that is always zero may just mean the queue is unbounded

### Failure modes under load
<!--meta polarity=failure-->

- **pool-induced deadlock** — a task submits sub-tasks to the same pool and blocks waiting for them; once every worker is waiting, nothing can ever run
- **blocked-worker starvation** — a few tasks stuck on slow I/O occupy all workers — throughput collapses to zero while the CPU sits idle
- **unbounded-queue creep** — the pool looks healthy while the queue grows for hours; the symptom finally surfaces as memory exhaustion or timeouts far downstream
- **cross-task contamination** — leftover thread-local state or an uncaught exception from one task poisons the worker the next task inherits

### Readiness checklist
<!--meta polarity=check-->

- bound the queue and pick the rejection policy deliberately — the default is a decision either way
- never block inside a task on work submitted to the same pool; give nested work its own pool or a work-stealing design
- name every pool so it is identifiable in thread dumps and metrics
- wrap tasks with a catch-all handler so one failure cannot silently kill or poison a worker
- reset or avoid thread-local state between tasks — workers are shared, their memory is not private

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Run tasks on a fixed set of workers instead of one thread per task. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Bulkhead](../distributed/resilience/bulkhead.md) — Separate pools are a common bulkhead
- [Producer-Consumer](./producer-consumer.md) — A pool of consumers drains the queue
- [Future / Promise](./future-promise.md) — Submitting work returns a future
- [Semaphore](./semaphore.md) — The pool's size limit is a counting semaphore over its workers
- [Reactor](./reactor.md) — A pool absorbs handler work so the event loop never blocks
- [Fork-Join](./fork-join.md) — A fork-join pool is a thread pool tuned for many small tasks that wait for each other
- [Proactor](./proactor.md) — A pool of workers can drain a proactor's completion queue
- [Backpressure](./backpressure.md) — A bounded queue in front of the pool rejects or parks submitters instead of growing
- [Splitter](../messaging/splitter.md) — A split is a common source of the many small tasks a pool drains.

**Alternative to**

- [Barrier](./barrier.md) — Use a barrier instead when the same threads must all finish one phase before any starts the next

**Variant of**

- [Object Pool](../gof/extra/object-pool.md) — A thread pool is an object pool of workers

**Prevents**

- [Resource Leak](../../hazards/resource-leak.md) — Bounded, reused workers with lifecycle management instead of leak-prone ad-hoc threads

**Exposed to**

- [Busy Front End](../../hazards/busy-front-end.md) — Can fall into busy front end when background jobs sharing the request pool or the same cores starve request handling
- [Connection-Pool Exhaustion](../../hazards/connection-pool-exhaustion.md) — Can fall into connection pool exhaustion when a bounded pool with an unbounded wait hangs requests silently
- [Noisy Neighbour](../../hazards/noisy-neighbour.md) — Can fall into noisy neighbour when one shared pool lets a slow or heavy task class take every worker
- [Synchronous I/O](../../hazards/synchronous-io.md) — Can fall into synchronous io when a fixed pool of worker threads runs out when each one parks on a blocking call
- [Unbounded Queue](../../hazards/unbounded-queue.md) — Can fall into unbounded queue when a work queue with no limit hides overload until the heap is exhausted
- [Starvation](../../hazards/starvation.md) — Can fall into starvation when long or blocking tasks hold every worker

**Demonstrated by**

- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — Separate pools per dependency are how a bulkhead is built in practice

<!-- relationships:end -->
