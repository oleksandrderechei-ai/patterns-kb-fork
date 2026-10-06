---
title: Producer-Consumer
description: Decouples generating work from processing it
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, decoupling, backpressure]
status: stable
aliases: [bounded buffer, producer/consumer]
solves: [a burst of uploads floods my database and writes start timing out, my list of pending work keeps growing until the process runs out of memory, the fast part of my code spends all its time waiting on the slow part, I want to keep accepting work while the slow processing catches up, two threads writing to the same list keep corrupting it or losing items]
---

# Producer-Consumer

Decouples generating work from processing it — producers append items to a shared, bounded buffer and consumers drain it independently, so each side runs at its own pace without ever calling the other directly.

## What it is
<!--meta block=description-->

Producers and consumers rarely run at the same speed, so work must wait somewhere between them. Producer-consumer puts a shared buffer there: producers add items, consumers take them, and neither calls the other. The buffer is usually bounded. A producer waits when it is full and a consumer waits when it is empty, so each side runs at its own pace.

## Explained
<!--meta block=explain-->

Producer-consumer puts a queue between code that creates work and code that handles it, so each side runs at its own pace and the creator does not wait for the handler while the queue has room; a full bounded queue blocks, drops or rejects. Producers add items to the queue, and a set of consumers take them out. Choose it over calling the handler directly when work arrives in bursts, when creating is faster than handling, or when several workers should share one stream.

- **Shared queue** Many threads change it; use a ready-made thread-safe blocking queue instead of writing the locks yourself.
- **Full-queue decision** A queue with a size limit must block the producer, drop the item or reject it; pick one on purpose.
- **Hidden growth** A queue without a limit hides growth until memory runs out; set a limit and watch its depth.
- **Sizing** Consumers >= arrival rate x seconds per item, plus headroom; at equal capacity a backlog never clears.

**Example.** Uploads normally arrive at 100 a second and each takes a consumer 50 ms, so one consumer does 20 a second. Eight consumers handle 160 a second, so the normal load fits. A burst of 300 a second for 10 s leaves a backlog of (300 - 160) x 10 = 1,400 items, which fits a queue limit of 2,000. After the burst, the 60 a second of spare capacity clears it in about 23 s. The cost is delay: the last item in the burst waits about 1,400 / 160 = 8.75 s. With five consumers, capacity equals the normal load, so the backlog would never clear.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a fast producer avoid swamping a slow consumer? Neither side ever calls the other — step 2 makes a producer wait while the buffer is full, and step 3 makes a consumer wait while it is empty, so each runs at its own speed."
flowchart LR
    P1["Producer A"]
    P2["Producer B"]
    subgraph Shared["The only thing both sides touch"]
        Q[("Bounded buffer")]
    end
    C1["Consumer A"]
    C2["Consumer B"]
    Sink["Database or downstream call"]:::ext
    P1 -->|"1 enqueue an item"| Q
    P2 -->|"2 enqueue, or wait while full"| Q
    Q -->|"3 take an item, or wait while empty"| C1
    Q -->|"4 take the next item"| C2
    C1 -->|"5 process it"| Sink
    C2 -->|"6 process it"| Sink
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Bounded vs. [unbounded](../../hazards/unbounded-queue.md) buffer** — A bounded buffer caps memory use and forces a policy for what happens when it fills; an unbounded one defers that decision until the process runs out of memory.
- **Multiple producers, multiple consumers** — Any number of producers and consumers can share one buffer if access is synchronized; it scales until contention on the buffer's lock or the consumers' downstream dependency becomes the limit. Dijkstra posed this form in 1965, so the literature still calls it the bounded-buffer problem.
- **[Backpressure](./backpressure.md)** — When the buffer is full, block the producer or reject the insert, which pushes the slowdown back to it; dropping the newest or oldest item is load shedding instead. This choice is the pattern's central design decision.
- **[Message Queue](../messaging/message-queue.md)** — Swap the in-process buffer for a durable, out-of-process queue and the same shape survives a crash and spans separate services.
- **The shape inside other patterns** — A thread pool's work queue, an actor's mailbox, an OS pipe and a streaming pipeline's internal channel are all this shape, so you will meet it inside far more specific-looking patterns.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Decouples producer and consumer rates** — each runs at its own pace.
- **Smooths bursts**: spikes queue up instead of being dropped or blocked, as long as the backlog stays under the queue limit and consumers catch up afterwards.
- **Scales each side independently**: add consumers to drain faster, add producers without touching consumers.
- **A bounded buffer's fullness is a built-in backpressure signal**; an unbounded one gives none until memory runs out.

### Cons
<!--meta polarity=con-->

- **The buffer is shared mutable state** — wrong synchronization causes races, lost wakeups, or deadlock.
- **A bounded buffer forces a full-policy decision** (block, drop, reject) that's easy to get wrong or skip entirely.
- **An unbounded one hides unchecked memory growth** until the process falls over.
- **Adds a moving part** — buffer size, wakeups, queue depth — that must be sized and monitored.
- **Queueing adds delay under load** — as the 8.75 s wait in the example shows; watch queue depth and the age of the oldest item.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Producers and consumers naturally run at different**, variable rates.
- **Work should keep being generated** even while processing catches up, or vice versa.
- **You need to smooth bursty input** before it overwhelms downstream processing.

### Avoid when
<!--meta polarity=avoid-->

- **Work is a one-off**, synchronous call — invoking the consumer directly is simpler and clearer.
- **Strict per-item ordering across producers** is required and the buffer can't preserve it.
- **Producer and consumer speeds are already matched**, so a buffer only adds cost.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — producers and consumers around a bounded channel"

func main() {
	// The buffer is the whole interface: a channel with room for 4 items.
	queue := make(chan int, 4)
	// Producer: the send waits while the buffer is full. That wait is the backpressure.
	var producers sync.WaitGroup
	for p := 0; p < 2; p++ {
		producers.Add(1)
		go func() {
			defer producers.Done()
			for i := 0; i < 50; i++ {
				queue <- i
			}
		}()
	}
	// Close once every producer is finished, so consumers can stop.
	go func() { producers.Wait(); close(queue) }()
	// Consumers: the receive waits while the buffer is empty; the loop ends on close.
	results := make(chan int)
	for c := 0; c < 3; c++ {
		go func() {
			sum := 0
			for item := range queue {
				sum += item
			}
			results <- sum
		}()
	}
	fmt.Println(<-results + <-results + <-results) // 2 x (0+...+49) = 2450
}
```

## In the wild
<!--meta block=wild-->

- **Go channels** — A buffered channel make(chan T, n) is a bounded queue: sends block when full, receives block when empty, close signals no more values, and range drains until closed. The classic bounded-buffer hand-off built into the language. {#wild-go-channels}
- **java.util.concurrent.BlockingQueue** — ArrayBlockingQueue is bounded and array-backed with a single lock; LinkedBlockingQueue uses separate put and take locks for higher throughput and is unbounded unless a capacity is given. put/take block, offer/poll take timeouts. {#wild-java-blockingqueue}
- **Unix pipes** — A shell pipeline gives each stage a fixed-size kernel buffer (64 KB on Linux by default, resizable via fcntl F_SETPIPE_SZ) that stalls the writer when full and the reader when empty; writes up to PIPE_BUF (4096 bytes) are atomic. {#wild-unix-pipes}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Queue capacity** — The bound on the shared buffer. It sets how far producers may run ahead before they block and caps the memory the backlog can consume. Size it to the backlog a burst creates, (burst rate - service rate) x burst duration, within the memory the items can use; start small and watch depth.
- **Consumer pool size** — Number of consumer threads or workers draining the queue. Too few and the queue backs up; too many and they contend or sit idle for work. Start from arrival rate x seconds per item, plus headroom, and confirm against consumer idle time.
- **Full-queue policy** — What an insert does when the buffer is full: block (ArrayBlockingQueue.put), time out (offer with a timeout), or reject the item.
- **Batch / prefetch size** — How many items a consumer takes per wakeup. Batching amortizes lock and wakeup cost against added latency.

### Signals to watch
<!--meta polarity=signal-->

- **Queue depth** — Sustained near-full means consumers are the bottleneck; sustained near-empty means producers are.
- **Producer block time** — Time producers spend blocked on a full queue.
- **Throughput vs consumer idle time** — Items processed per second against the time consumers wait on an empty queue.

### Failure modes under load
<!--meta polarity=failure-->

- **Unbounded queue to OOM** — An unbounded buffer, such as a LinkedBlockingQueue with no capacity, lets a fast producer grow it until the process runs out of memory.
- **Deadlock on shutdown** — Consumers blocked on take() never learn that producers are done unless a shutdown or poison-pill protocol wakes them. With N consumers send N pills or close the channel, and drain pending items first.
- **Consumer starvation** — If every consumer blocks on a downstream dependency while producers keep filling the queue, the whole pipeline stalls. Time-box downstream calls so a stalled dependency frees the consumer.

### Readiness checklist
<!--meta polarity=check-->

- Bound the queue; an unbounded buffer only defers the failure to an OOM.
- Size the pool so consumer capacity exceeds the normal arrival rate, with headroom; equal capacity never clears a backlog.
- Define an explicit shutdown or drain protocol (poison pills or channel close) so blocked consumers exit.
- Instrument queue depth to see which side is the bottleneck.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Streaming](../../themes/streaming.md) — The basic shape of a stream stage {#fluency-streaming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Pipe-and-Filter](../architecture/pipe-filter.md) — Stages are producers and consumers in series
- [Message Queue](../messaging/message-queue.md) — The queue is the buffer between them
- [Thread Pool](./thread-pool.md) — A pool of consumers drains the queue
- [Backpressure](./backpressure.md) — A full buffer must slow the producer
- [Scheduling](./scheduling.md) — A scheduler feeds timed work into the queue the consumers pull from
- [Monitor Object](./monitor-object.md) — In one process the shared buffer is usually a monitor whose conditions gate full and empty
- [Channels](./channels.md) — The pattern is what a channel implements for in-process use
- [Competing Consumers](../messaging/competing-consumers.md) — Many consumers draining one buffer is this pattern scaled out.

**Generalizes**

- [Ring Buffer](./ring-buffer.md) — The pattern allows any queue, and a ring buffer is the allocation-free one

**Often confused with**

- [Publish-Subscribe](../messaging/pubsub.md) — One-to-one hand-off vs. broadcast

**Prevents**

- [Unbounded Queue](../../hazards/unbounded-queue.md) — A bounded blocking queue makes a fast producer wait instead of growing without limit

**Demonstrated by**

- [Elevator](../../designs/elevator.md) — a queue decouples the many request producers from the single consumer that advances the cars, removing shared-set contention
- [Online Auction](../../designs/online-auction.md) — splitting bid acceptance from bid adjudication is what lets an acknowledged bid outlive a crash of whatever judges it

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — A managed queue replaces the in-process buffer when producers and consumers run as separate services.

<!-- relationships:end -->
