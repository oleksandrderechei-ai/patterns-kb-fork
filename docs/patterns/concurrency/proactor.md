---
title: Proactor
description: "Start the I/O, let the system finish it, and run your handler on the result"
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, asynchrony, throughput]
status: stable
aliases: [asynchronous completion dispatch]
solves: [copying a large file or buffer on my event loop stalls every other connection, readiness notifications still leave the actual read and write for my thread to do, "regular files always report ready, so my event loop cannot wait on disk reads", I want many disk and network operations in flight without one thread waiting on each]
---

# Proactor

Start an I/O operation and hand it to the system with a buffer and a handler; the system does the work, and a loop calls your handler once the operation has finished.

## What it is
<!--meta block=description-->

A server that copies a large file on its loop thread stops serving everyone else while the copy runs. A proactor starts the operation and returns at once. The operating system performs the read or write into your buffer and posts a completion event. A dispatcher takes events off a queue and calls the handler with the finished result, so the handler never does the I/O itself.

## Explained
<!--meta block=explain-->

A proactor starts an I/O operation and gives the system a buffer to fill. The system does the read or write itself, then queues a completion event, and one loop takes the event and calls your handler with the finished result. The handler gets the data, not permission to go and fetch it. A [reactor](./reactor.md) works the other way round: it is told a socket is ready and must do the read itself. Choose a proactor over a reactor when the platform has true asynchronous I/O, such as Windows completion ports or Linux io_uring, or when you read files, which a readiness check cannot wait on.

- **Buffer lifetime.** A buffer freed before its completion arrives corrupts data. Tie its lifetime to the handler, or use a buffer pool.
- **Platform differences.** Completion ports, io_uring and POSIX AIO behave differently. Use a library that wraps them behind one interface.
- **Pinned memory.** Every posted read keeps its buffer reserved while the connection idles. Cap operations in flight and size buffers to a typical message.

**Example.** A server holds 10,000 idle connections and posts one 4 KB read on each, so 10,000 x 4 KB = 40 MB sits pinned before a byte arrives. A reactor would hold none, and borrow one shared buffer only when a socket turns ready. In return, with a kernel proactor a 64 MB file send costs the loop only the submit and the completion handler, because the system does the copy; a reactor that read the file itself would block for that copy. To save memory, cap reads in flight and read into pooled buffers; posting only on active connections first needs a readiness check, which brings a reactor back.

## How it works
<!--meta block=structure-->

```mermaid caption="Who does the I/O? Step 2 gives the work and the buffer to the system, and step 5 is the whole contract: the handler runs after the data is already in the buffer, not when the data is merely ready."
flowchart LR
    I["Initiator: your code"]
    subgraph OS["Asynchronous operation processor (the system)"]
        P["Performs the read or write"]
        CQ[("Completion queue")]
    end
    D["Completion dispatcher: one loop"]
    H["Completion handler"]
    I -->|"1 start read, give a buffer and a handler"| P
    I -.->|"2 return at once, do other work"| I
    P -->|"3 fill the buffer"| CQ
    CQ -->|"4 take a finished event"| D
    D -->|"5 call the handler with the result"| H
    H -->|"6 start the next operation"| P
```

```mermaid caption="The handler is called after the bytes are in the buffer. Compare a reactor, which is told the socket is readable and must call read itself."
sequenceDiagram
    participant A as Your code
    participant S as System
    participant L as Dispatcher loop
    participant H as Handler
    A->>S: async_read(buffer, handler)
    A->>A: return at once
    S->>S: read bytes into the buffer
    S->>L: completion event, 512 bytes
    L->>H: handler(buffer, 512 bytes)
    H->>S: async_read(buffer, handler)
```

## Variations
<!--meta block=variations-->

- **Kernel proactor** — The operating system itself runs the operation and posts completions: Windows I/O completion ports and Linux `io_uring`. No thread of yours waits during the I/O.
- **Emulated proactor** — A library keeps an event loop on readiness underneath, does the read when the socket is ready, and then calls your handler with the data. Callers see completions, though a [reactor](./reactor.md) does the work.
- **Reactor vs. proactor** — A reactor says "this descriptor is ready, read it yourself". A proactor says "your read has finished, here is the data". The reactor suits readiness-based systems, and the proactor suits platforms with real asynchronous I/O.
- **Pooled completion handlers** — Several threads wait on one completion queue and any of them runs the next handler. It uses many cores, but one connection's handlers can then run on different threads, so guard shared state or give each connection a serial queue.
- **Batched submission** — Many operations go to the system in one call and completions come back in a batch. It cuts system calls when each operation is small.
- **Completion as a future** — The completion fulfils a [future or promise](./future-promise.md), so callers write `await` instead of a handler.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **With a kernel proactor the loop never copies bytes** — the system does the read or write, so one large transfer does not stall other connections; an emulated proactor still copies on the loop.
- **Works for files too** — a regular file is always ready to a readiness check, but a kernel asynchronous read runs in the background; an emulation on hidden threads only moves the blocking off the loop.
- **Handlers get finished results** — code reads as handle-the-data, with no read-until-would-block loop to write.
- **Many operations in flight at once** — the system can order disk and network work itself, which suits high-throughput servers.

### Cons
<!--meta polarity=con-->

- **Buffers must outlive the operation** — freeing or reusing one before its completion corrupts data; tie buffer lifetime to the handler or use a pool.
- **Platform APIs differ** — completion ports, `io_uring` and POSIX AIO behave differently, so use a library that hides the difference.
- **Pre-posted reads pin memory** — each idle connection holds a buffer; cap in-flight operations and size buffers to the usual message.
- **Control flow is split across handlers** — a failure in step three is far from the code that started step one; use futures and structured logs with an operation id.
- **Cancel does not stop the operation** — a cancelled operation still completes and may write into its buffer until then; wait for that completion before freeing the buffer or closing the handle, and give every operation a deadline.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Your platform has real asynchronous I/O** — Windows completion ports, Linux `io_uring`.
- **You move large buffers or files** — copying on the loop would stall every other connection.
- **You want many requests in flight to the disk or network** and the system should schedule them.

### Avoid when
<!--meta polarity=avoid-->

- **Your platform only offers readiness checks** and you would be building an emulation — a [reactor](./reactor.md) is simpler and does the same job.
- **Memory is tight and connections are many and idle** — a buffer per pre-posted read adds up fast.
- **Your runtime already hides the loop** — goroutines or an `async` runtime give you the benefit without writing handlers.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a toy proactor: goroutines stand in for the operating system"
type completion struct {
	buf     []byte
	n       int
	err     error
	handler func(buf []byte, n int, err error)
}

var completions = make(chan completion, 128) // the completion queue

// asyncRead starts the read and returns at once. The goroutine plays the
// system: it does the I/O into buf, then posts a completion event.
func asyncRead(r io.Reader, buf []byte, h func([]byte, int, error)) {
	go func() {
		n, err := r.Read(buf)
		completions <- completion{buf, n, err, h}
	}()
}

// dispatch is the one loop. It never reads; it only calls handlers
// with results that already exist.
func dispatch() {
	for c := range completions {
		c.handler(c.buf, c.n, c.err)
	}
}

// asyncRead(conn, make([]byte, 4096), func(buf []byte, n int, err error) {
//     if err == nil { process(buf[:n]) } // data is here; buf is ours again
// })
//
// Real code adds: a semaphore capping asyncRead calls in flight (a full
// queue blocks the goroutines, it does not drop events), a closed flag for
// finished connections, and a worker pool for heavy handler work.
```

## In the wild
<!--meta block=wild-->

- **Windows I/O completion ports** — The kernel proactor on Windows. You associate a handle with a port by `CreateIoCompletionPort`, start overlapped operations, and threads take finished ones with `GetQueuedCompletionStatus`. {#wild-windows-iocp}
- **Linux io_uring** — A submission queue and a completion queue shared with the kernel. You queue many operations at once, and the kernel posts a completion entry for each as it finishes. {#wild-linux-io-uring}
- **Boost.Asio** — The C++ library whose design follows this pattern: you call `async_read` with a handler. It uses native completions on Windows; on Linux it emulates them over readiness (epoll) by default, with `io_uring` an opt-in (`BOOST_ASIO_HAS_IO_URING`). {#wild-boost-asio}
- **POSIX AIO** — The portable C interface `aio_read` and `aio_write`, with completion by signal or thread callback. Support and speed differ by system. {#wild-posix-aio}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **operations in flight** — How many reads and writes are posted at once. It sets pinned memory and how well the system can order the work.
- **buffer size and pool** — Size to the usual message, and reuse buffers from a pool instead of allocating per operation.
- **completion threads** — How many threads wait on the completion queue. On Windows the port's concurrency value is the number allowed to run at once.
- **queue depth** — On `io_uring`, the number of entries you ask for when creating the ring. It bounds the operations submitted before completions are drained, and the completion ring defaults to twice that number (`io_uring_setup(2)`).

### Signals to watch
<!--meta polarity=signal-->

- **operations in flight** — Posted but not completed. A count that climbs without bound means completions are not keeping up.
- **completion latency** — Time from start to completion event, as a distribution. The tail shows slow disks or a deep queue.
- **handler time** — How long each completion handler runs. A slow handler delays every completion behind it on that loop.
- **pinned buffer memory** — Posted buffers multiplied by buffer size. It is the standing memory cost of idle connections.

### Failure modes under load
<!--meta polarity=failure-->

- **buffer reused too early** — Code frees or rewrites a buffer before its completion arrives, and the system writes into memory you no longer own.
- **completion queue overflow** — Completions arrive faster than the loop drains them. On `io_uring` the completion ring can overflow when in-flight operations exceed its size, so keep them below it.
- **blocked handler** — A handler that blocks holds up every completion behind it, which looks like a latency spike with no error.
- **cancel races** — A completion can arrive after you cancelled or closed a handle, so handlers must tolerate results for dead connections.

### Readiness checklist
<!--meta polarity=check-->

- every buffer outlives its operation, and ownership is clear in the handler
- the number of operations in flight has a hard cap
- handlers never block and move heavy work to a worker pool
- a completion for a closed or cancelled connection is handled
- errors are reported through the handler result, with an operation id in the log

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Start I/O and get called back with the finished result. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Future / Promise](./future-promise.md) — The completion of an operation can be exposed as a future that resolves with its result
- [Thread Pool](./thread-pool.md) — Completion handlers run on a small pool of threads that take events off the queue

**Alternative to**

- [Reactor](./reactor.md) — The operating system finishes the I/O first, and the handler receives the finished result

**Prevents**

- [Synchronous I/O](../../hazards/synchronous-io.md) — Starts the operation and returns at once, so no thread waits while the I/O runs

<!-- relationships:end -->
