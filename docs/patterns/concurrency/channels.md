---
title: Channels
description: "A typed pipe between goroutines or threads: one side sends, the other receives, and a full or empty pipe makes the sender or receiver wait"
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, asynchrony, backpressure]
status: stable
solves: [two stages of my pipeline run at different speeds and the fast one fills memory, I share a variable between threads and keep fighting over who may read it, my worker goroutine waits forever for data that never comes and never exits, "one thread must wait for data, a timeout or a stop signal, whichever comes first"]
---

# Channels

A typed, blocking pipe that passes values between concurrent tasks, so tasks hand data over instead of sharing memory and locking it.

## What it is
<!--meta block=description-->

Two tasks that share a variable need a lock and a rule about who reads when. A channel replaces the shared variable with a handover. One task sends a value into a typed pipe, another receives it, and ownership of the value moves with it. A channel with a fixed buffer also makes a fast sender wait for a slow receiver.

## Explained
<!--meta block=explain-->

A channel is a typed pipe between concurrent tasks. One task sends a value, another receives it, and ownership of the value moves with it, so the tasks share no variable and need no lock around one. A channel with a fixed buffer also blocks a fast sender when the buffer is full, which gives you backpressure (a slow consumer slowing its producer) without extra code. Choose it over a [mutex](./mutex.md) when data flows from stage to stage, and over a [message queue](../messaging/message-queue.md) when both ends live in one process and you do not need the messages to survive a restart. It is the [producer-consumer](./producer-consumer.md) queue with the waiting built in.

- **Leaked waiters.** A task blocked on a channel nobody reads or closes never ends. Give every sender and receiver a done signal.
- **Shared again by pointer.** Sending a pointer shares the data it points to. Stop using the value after you send it.
- **Handover cost.** Each send is a queue hop, far above a function call. Pass batches, not single small values.

**Example.** A producer makes 1,000 values a second and the consumer handles 400. With a buffer of 100, the buffer fills in about 0.17 seconds, because it gains 600 values a second. From then on each send waits for a receive, and the producer runs at 400 a second with memory fixed at 100 values. Without the bound, the backlog would grow by 600 values a second, about 36,000 a minute. The cost is that the producer now stalls, so give it other work or a drop policy if it must not wait.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a value cross from one task to another? Steps 1 to 3 are the handover, and the full-buffer branch at step 2 is what slows a fast sender to the receiver's pace."
flowchart LR
    S["Sender task"]
    subgraph CH["Channel"]
        B[("Buffer of N slots")]
    end
    R["Receiver task"]
    X["Close signal"]
    S -->|"1 send value"| B
    B -->|"2 buffer full: sender waits"| S
    B -->|"3 receive value"| R
    S -->|"4 close when done"| X
    X -->|"5 receiver sees end of stream"| R
```

```mermaid caption="A sender outruns its receiver. With a buffer of 2, the third send waits until the receiver takes a value."
sequenceDiagram
    participant S as Sender
    participant C as Channel (2 slots)
    participant R as Receiver
    S->>C: send 1
    S->>C: send 2
    S->>C: send 3
    Note over S,C: buffer full, sender waits
    R->>C: receive
    C-->>R: 1
    Note over S,C: a slot is free, send 3 completes
    R->>C: receive
    C-->>R: 2
```

## Variations
<!--meta block=variations-->

- **Unbuffered channel** — The sender waits until a receiver is ready, so every send is also a synchronization point. It is the strictest form of handover.
- **Buffered channel** — A fixed number of slots lets the sender run ahead by that many values. The size is your backpressure budget. Size it to the burst you must absorb: the rate gap times the burst length (at a 600-a-second gap, 100 slots absorb about 0.17 s). A larger buffer only delays the stall, adds latency and hides a slow consumer.
- **Select over several channels** — A task waits on many channels at once (Go's `select`) and takes one that is ready. When several are ready, Go picks one at random, so do not rely on order. A nil channel is never ready, which switches its case off. It lets one task combine data, a timeout and a cancel signal.
- **Fan-out and fan-in** — Many workers read one channel, or many senders write one channel. It spreads work or merges results without a lock.
- **Done channel** — A channel that is only closed, never sent on, tells every listener to stop. It gives a pipeline one clean way to shut down.
- **[Producer-Consumer](./producer-consumer.md) queue** — A channel is that pattern with the bounded queue and the waiting built in.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Handover replaces sharing** — the receiver owns the value after the receive, so there is no data to lock.
- **A bounded channel gives backpressure from its buffer limit** — a fast sender waits instead of filling memory, so the producer stalls; give it other work or a drop policy.
- **Select composes waits** — one loop handles data, a deadline and a cancel in a few lines.
- **Closing signals the end** — the receiver learns the stream is over without a sentinel value.

### Cons
<!--meta polarity=con-->

- **A send to nobody blocks forever** — a goroutine left waiting on a channel nobody reads leaks; give every sender a way to stop.
- **Passing a pointer shares it again** — the lock-free guarantee holds only if the sender stops using the value.
- **Closing from the wrong side crashes** — in Go, sending on a closed channel or closing one twice panics, so one owner closes: the sender, or with many senders a coordinator that closes after all of them finish. Receives on a closed channel drain what is buffered, then return the zero value at once; check the second result, `ok`, to tell the two apart.
- **Each handover costs a queue hop** — a channel is slower than a plain function call, so do not pass tiny values one by one.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Stages of a pipeline pass values to each other** and each stage runs at its own speed.
- **A fast producer must be slowed to match its consumer** without a hand-written lock and counter.
- **One task must wait on data, a timeout and a cancel signal** together.
- **You want ownership to move with the data** instead of guarding a shared structure.

### Avoid when
<!--meta polarity=avoid-->

- **Several tasks update one shared value** — a [mutex](./mutex.md) around the value is simpler than a channel to an owner task.
- **The call is on the hot path and takes nanoseconds** — a handover costs more than the work.
- **You need delivery across machines or restarts** — a channel is in memory, so use a [message queue](../messaging/message-queue.md).

## Code sketch
<!--meta block=sketch-->

```go summary="Go — a two-stage pipeline over bounded channels, with a done channel for shutdown"
// stage runs f over each input; the bounded output makes it wait for the next stage.
func stage(done <-chan struct{}, in <-chan int, f func(int) int) <-chan int {
	out := make(chan int, 4) // producer waits when 4 are unread
	go func() {
		defer close(out) // tells the next stage the stream is over
		for v := range in { // ends when the upstream closes
			select {
			case out <- f(v):
			case <-done: // consumer gave up: stop sending
				return
			}
		}
	}()
	return out
}

func main() {
	done := make(chan struct{})
	defer close(done)
	src := make(chan int)
	go func() {
		defer close(src)
		for i := 1; i <= 5; i++ {
			select {
			case src <- i:
			case <-done:
				return // consumer quit: stop instead of leaking
			}
		}
	}()
	for v := range stage(done, src, func(x int) int { return x * x }) {
		fmt.Println(v) // 1 4 9 16 25
	}
}
```

## In the wild
<!--meta block=wild-->

- **Go channels** — Built into the language: \`make(chan T, n)\` creates a typed channel with a buffer of n, and \`select\` waits on several. {#wild-go-chan}
- **Rust std::sync::mpsc** — A multi-producer, single-consumer channel in the standard library, with a bounded form from \`sync_channel\`. {#wild-rust-mpsc}
- **Kotlin coroutine Channel** — A channel in kotlinx.coroutines whose send and receive suspend a coroutine instead of blocking a thread. {#wild-kotlin-channel}

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Pass values between tasks through a bounded channel instead of sharing memory. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Producer-Consumer](./producer-consumer.md) — A bounded channel is the queue between producer and consumer, with the waiting built in
- [Backpressure](./backpressure.md) — A full buffer blocks the sender, so a slow receiver slows a fast sender
- [Actor Model](./actor-model.md) — An actor's mailbox is a channel, and a select over channels builds actor-like loops
- [Thread Confinement](./thread-confinement.md) — A channel hands the confined value from one owning task to the next, so one task holds it at a time

**Alternative to**

- [Mutex](./mutex.md) — Passes ownership of a value instead of sharing it under a lock
- [Message Queue](../messaging/message-queue.md) — Moves values between tasks inside one process, with no persistence

**Exposed to**

- [Unbounded Queue](../../hazards/unbounded-queue.md) — Can fall into unbounded queue when a channel with an unlimited buffer removes the backpressure the channel would otherwise give
- [Deadlock](../../hazards/deadlock.md) — Can fall into deadlock when two tasks each wait to send to the other on unbuffered channels, or a sender waits on a channel nobody reads

<!-- relationships:end -->
