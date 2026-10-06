---
title: Reactor
description: One loop dispatches events to their handlers
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, asynchrony]
status: stable
aliases: [event loop]
solves: [my server falls over at a few thousand connections even though they are mostly idle, almost all my threads are parked waiting on a socket and doing nothing, every open connection costs a megabyte of stack and memory is what runs out first, the machine burns its CPU on context switches rather than on my actual work, I want to watch a pile of sockets and timers in one place without a thread for each]
---

# Reactor

A single event loop watches every open socket, timer, and signal at once, and the instant one is ready it dispatches straight to the handler that registered for it — no thread parked per connection, no one blocked waiting.

## What it is
<!--meta block=description-->

Giving every connection its own thread means thousands of idle threads, each costing memory and context switches. A reactor is one event loop that asks the operating system which of many registered sources, such as sockets and timers, are ready. It calls the matching handler for each one in turn. One thread serves tens of thousands of connections, but a handler that blocks stalls all of them.

## Explained
<!--meta block=explain-->

A reactor is one loop that waits on many connections at once, asks the operating system which of them are ready (through select, poll, epoll or kqueue), and calls a short handler for each ready one. One thread serves thousands of connections, because a connection that is idle costs a table entry, not a sleeping thread. Choose it over one thread per connection when you hold many connections that are mostly quiet, such as chat, proxies and push servers.

- **Slow handlers** One slow handler freezes every connection on the loop; keep handlers short and send heavy work to a worker pool.
- **One core per loop** Run one loop per core and spread connections across them.
- **Callback code** Callbacks are harder to follow than straight-line code; use async and await where your language has them.
- **Non-blocking calls only** Every call in the path must be non-blocking, so pick non-blocking libraries from the start.

**Example.** A chat server holds 10,000 connections. With one thread each and a 1 MB stack, that is about 10 GB of reserved stack address space, plus scheduler cost. A reactor serves them with one thread. Each message takes a 0.05 ms handler, so one loop handles at most about 20,000 messages a second, before read and write call costs. Now one handler runs a 200 ms blocking database query: for those 200 ms, all 10,000 connections get nothing, and you see a pause with no error. Handing that query to a worker pool and replying when it finishes keeps the loop moving. The cost is code split into two parts, the request and the reply, that you must now connect.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one thread serve thousands of connections? Step 2 waits once for all of them instead of once per thread, so the loop spends CPU only on the sources that are actually ready — and step 7 is the whole contract, because a handler that does not return quickly holds up every other connection."
flowchart LR
    Cl["Sockets, timers, signals"]:::ext
    DM["Demultiplexer, epoll/kqueue"]
    Reg[("Registration table, source to handler")]
    subgraph Loop["One thread: wait once, dispatch each, repeat"]
        EL["Event loop"]
        H["Handlers"]
    end
    Cl -->|"1 data arrives, a timer fires"| DM
    EL -->|"2 block here until anything is ready"| DM
    DM -->|"3 wake with the list of ready sources"| EL
    Reg -->|"4 look up who registered for each one"| EL
    EL -->|"5 call each handler in turn"| H
    H -->|"6 read or write, then return"| Cl
    H -->|"7 control back, block again"| EL
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Single-threaded reactor** — One loop runs both the demultiplexing (waiting on the OS for ready sources) and every handler. Simplest, no locking for loop-owned state, but a slow handler stalls all other connections. Doug Schmidt formalized the pattern in the ACE framework in the mid-1990s.
- **[Worker-pool](./thread-pool.md) reactor** — The loop only demultiplexes and dispatches; the actual handler work runs on a bounded thread or task pool, so one slow handler no longer blocks ingestion of new events. Handlers now run off the loop, so shared state needs locks or per-connection serialization, and replies must be ordered per connection.
- **Multi-reactor (thread-per-core)** — Run N independent loops, each pinned to a core and owning its own slice of connections, sharing little (such as the listening socket); the shape behind nginx workers and modern thread-per-core servers.
- **Reactor vs. Proactor** — Reactor notifies "this descriptor is ready, go read it yourself"; Proactor notifies "your read already completed, here's the data" — the OS or an async layer performs the I/O, as in Windows IOCP.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No thread-per-connection overhead** — one loop scales to tens of thousands of idle sockets, within the file-descriptor limit and while handlers stay short.
- **No locking inside the loop**: handlers on the same thread never race each other, while state stays confined to that loop. Sharing across loops or pool workers needs locks or message passing.
- **Low, predictable memory footprint per connection** compared to a parked thread and stack.
- **Dispatch order within the loop is explicit** and easy to reason about.

### Cons
<!--meta polarity=con-->

- **A single [blocking](../../hazards/synchronous-io.md) or CPU-heavy handler** stalls every other event on that loop.
- **One loop uses one core** — real parallelism needs multiple reactor instances.
- **Callback-driven control flow** is harder to step through than straight-line, blocking code.
- **Every handler must be written non-blocking**, which pushes async style through the whole call chain.
- **Partial reads and writes** leave a per-connection state machine to maintain, with buffered output and fairness across connections.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You're serving many concurrent, mostly-idle I/O connections** — sockets, pipes, timers.
- **Thread-per-connection overhead** (memory, context switches) is the actual bottleneck.
- **Work is I/O-bound** and can be expressed as short, non-blocking handlers.

### Avoid when
<!--meta polarity=avoid-->

- **The workload is CPU-bound** — a reactor's single loop just serializes the crunching.
- **Your runtime already gives you cheap, preemptible concurrency** (lightweight threads, coroutines) — reintroducing an explicit loop adds complexity for no gain.
- **You depend on libraries that only offer** blocking calls and can't be made async or offloaded to a pool.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal single-threaded reactor"
type Handler = (fd: number) => void;

class Reactor {
  private handlers = new Map<number, Handler>();

  register(fd: number, handler: Handler): void {
    this.handlers.set(fd, handler);
  }

  unregister(fd: number): void {
    this.handlers.delete(fd);
  }

  // The loop: block until the OS says something is ready,
  // then dispatch each ready fd to its handler. A handler
  // must never block — that stalls every other connection.
  // Real epoll/kqueue keeps the registered set in the kernel (register would call epoll_ctl); rebuilding the key list each pass is for illustration only.
  // A handler reads until the call would block (EAGAIN), then returns. Heavy work goes to a worker pool; its result is registered back on the loop as a new event.
  run(): void {
    while (true) {
      const ready = demultiplex([...this.handlers.keys()]); // epoll/kqueue
      for (const fd of ready) {
        this.handlers.get(fd)?.(fd);
      }
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **nginx** — Each worker process runs its own epoll (Linux) or kqueue (BSD) event loop over thousands of connections, which is why it serves idle keep-alives so cheaply. worker_processes (often auto) sets one loop per core and worker_connections caps sockets per worker. {#wild-nginx}
- **Node.js / libuv** — A single-threaded event loop over libuv demultiplexes socket, timer, and completion events and dispatches each to its JavaScript callback. Blocking or CPU-heavy work must go to worker_threads or the libuv thread pool (UV_THREADPOOL_SIZE, default 4). {#wild-nodejs-libuv}
- **Redis** — A single-threaded loop processes every command in turn, which is why commands are atomic and why one slow command (such as KEYS on a large keyspace) stalls the server. Redis 6 added io-threads that parallelize socket read/write while command execution stays single-threaded. {#wild-redis}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Loop / worker count** — Event loops per process, usually one per core (nginx worker_processes auto). A single loop uses only one core no matter how many connections it holds.
- **Max connections per loop** — nginx worker_connections and the OS file-descriptor limit cap how many sockets one loop can multiplex.
- **Offload thread-pool size** — Blocking or CPU-heavy work must move off the loop to a pool, such as libuv UV_THREADPOOL_SIZE (default 4); the pool size caps concurrent offloaded work.
- **Demultiplexer wait timeout** — The epoll or kqueue wait timeout bounds how long the loop sleeps before it wakes to service timers.

### Signals to watch
<!--meta polarity=signal-->

- **Event-loop lag** — How late scheduled callbacks fire, measurable with Node perf_hooks monitorEventLoopDelay. Rising lag means the loop is saturated or blocked.
- **Connections per worker** — Active sockets each loop is multiplexing.
- **Handler execution time** — Time spent inside a single callback. Any long one delays every other event on that loop.

### Failure modes under load
<!--meta polarity=failure-->

- **Blocked event loop** — One synchronous, blocking, or CPU-heavy callback freezes every connection on that loop until it returns.
- **Single-core ceiling** — A lone loop cannot use more than one core, so throughput caps there unless work is sharded across loops or processes.
- **Event backlog** — If handlers cannot keep pace with arrivals, the ready-event queue and socket buffers grow, adding latency to everything.

### Readiness checklist
<!--meta polarity=check-->

- Never block the loop; offload blocking I/O and CPU-heavy work to a thread pool or separate process.
- Run one loop per core to use all cores.
- Bound accepted connections per loop within the file-descriptor limit.
- Monitor event-loop lag as the primary saturation signal.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Streaming](../../themes/streaming.md) — Event-loop dispatch for non-blocking streams {#fluency-streaming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Future / Promise](./future-promise.md) — Non-blocking calls complete via callbacks/futures
- [Thread Pool](./thread-pool.md) — The loop only dispatches; slow handlers run on a bounded worker pool
- [Thread Confinement](./thread-confinement.md) — One loop owns the state it touches, so no handler needs a lock
- [Backpressure](./backpressure.md) — Stop watching a socket for readability until its handler drains

**Alternative to**

- [Proactor](./proactor.md) — A reactor is told a channel is ready, and the handler then does the read or write itself

**Prevents**

- [Synchronous I/O](../../hazards/synchronous-io.md) — The structural answer to threads parked one per outstanding call

<!-- relationships:end -->
