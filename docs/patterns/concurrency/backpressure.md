---
title: Backpressure
description: A slow consumer signals upstream to slow down
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, backpressure, resource-management]
status: stable
aliases: [flow control]
solves: [my consumer falls further behind every minute and the queue never drains, the process gets OOM killed hours after the traffic spike that actually caused it, a fast stage drowns the slow one behind it and the whole pipeline falls over, latency climbs into minutes because items sit in a backlog that keeps growing, I keep raising the queue size and it just delays the crash instead of fixing it]
---

# Backpressure

A slow consumer signals its own saturation back upstream, so the producer throttles, buffers within bounds, or sheds load — instead of blindly burying it.

## What it is
<!--meta block=description-->

A fast stage can bury a slower one behind it, because the gap between their speeds has to go somewhere. Backpressure is a signal that travels against the data flow: the slow consumer tells its feeder to slow down, hold items in a bounded buffer, or drop some. It only works end to end, because one hop that ignores the signal becomes the new place the queue grows.

## Explained
<!--meta block=explain-->

Backpressure makes a fast sender slow down to the speed of a slow receiver. The receiver, or the buffer between them, signals when it is full, and the sender waits, drops work or is refused instead of pushing more. Without it, the buffer grows without limit, memory fills over hours, and the process dies of an out-of-memory crash long after the mismatch began. With it, overload shows up as slowness and memory stays bounded. Choose it over a [load-leveling](../distributed/resilience/load-leveling.md) buffer when the load is sustained and you control the sender, because a buffer only absorbs a short spike. For outside clients, reject traffic over their quota instead.

- **Delay moves to the sender** Give each request a deadline and shed work that misses it.
- **One slow stage slows all before it** Give each stream its own window of in-flight items so a slow stream cannot stall the others.
- **Flapping** A badly tuned loop swings between stopped and flooded; resume at a lower fill level than the one that stopped you.

**Example.** A log reader produces 5,000 events a second and the indexer writes 2,000 a second. With an unbounded queue it grows by 3,000 events a second; at 1 KB each that is 3 MB a second, about 10.8 GB an hour, and the process dies. With a channel bounded at 10,000 events, it fills in about 3.3 s, then the reader waits and runs at 2,000 a second, and memory stays near 10 MB. The cost is delay: an event can wait up to 10,000 / 2,000 = 5 s in the queue. The reader stops when the queue is full and resumes at 5,000, so it does not flap on every slot.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does the speed mismatch between two stages go? Step 4 turns a full buffer into a signal that travels backwards, so the pipeline runs at the pace of step 3 — its slowest stage — instead of growing a queue until the process runs out of memory."
flowchart LR
    Src["Upstream source"]:::ext
    P["Producer stage"]
    subgraph Bnd["Bounded buffer: the limit is the signal"]
        Q[("Queue of fixed capacity")]
    end
    C["Consumer stage"]
    Src -->|"1 work arrives"| P
    P -->|"2 hand each item to the buffer"| Q
    Q -->|"3 consumer takes only what it can process"| C
    Q -->|"4 full: no free slot for the next item"| P
    P -->|"5 wait, drop, or pass the signal further back"| Src
    C -->|"6 a slot frees as work completes"| Q
    Q -->|"7 producer resumes, at the consumer's pace"| P
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="How does a slow consumer's saturation propagate back through the buffer to throttle the producer instead of overflowing?"
sequenceDiagram
    autonumber
    participant P as Producer
    participant B as Bounded buffer
    participant C as Consumer
    P->>B: push item
    alt consumer keeping up
        B->>C: deliver item
        C-->>B: ready for next
    else consumer saturated
        B--xC: cannot deliver, consumer busy
        B-->>P: buffer full, slow down
        Note over P: production throttled until buffer drains
    end
```

## Variations
<!--meta block=variations-->

- **[Producer-Consumer with a bounded queue](./producer-consumer.md)** — The simplest form: the producer blocks (or waits) once the queue hits capacity, and draining it is itself the signal to resume.
- **Credit / window-based flow control** — The receiver advertises how much it can accept — TCP's window, HTTP/2 and gRPC's flow-control credits — and the sender never exceeds that budget.
- **Reactive pull (`request(n)`)** — The consumer explicitly asks for `n` items before the producer emits them, inverting push into a demand-driven pull, as in Reactive Streams.
- **[Load shedding](../distributed/resilience/load-shedding.md) as fallback** — When there is no time to wait for the signal to propagate, drop the oldest or newest items instead of blocking. This is not backpressure itself, since the sender is never told; it trades completeness for a bounded queue.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Keeps memory bounded** — the producer slows instead of a queue growing without limit.
- **Surfaces the pipeline's real throughput** instead of hiding it behind a swelling buffer.
- **Degrades gracefully under sustained load** when every hop propagates the signal and the loop is tuned; see the cons otherwise.
- **Matches the whole pipeline's pace** to its slowest stage instead of its fastest.

### Cons
<!--meta polarity=con-->

- **Only works if every stage** between producer and consumer honors the signal.
- **Pushing a slowdown upstream** can turn one stage's local hiccup into a system-wide one, because each blocked stage holds threads, connections or memory while it waits.
- **Adds latency** — producers now wait or throttle instead of firing and forgetting.
- **Badly tuned feedback loops oscillate** between stopped and flooded, and a cycle of full bounded buffers between stages can [deadlock](../../hazards/deadlock.md).

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Pipeline stages run at inherently different**, variable speeds and the fast one can outrun the slow one.
- **You need bounded memory** and predictable behavior under sustained load, not just short bursts.
- **You control (or can influence) the producer**, so it can actually act on a slow-down signal.

### Avoid when
<!--meta polarity=avoid-->

- **The producer is outside your control**, like external clients — reject over-quota traffic with a [Rate Limiter](../distributed/resilience/rate-limiter.md) instead of asking it to politely slow down.
- **The load is a short, bursty spike** you'd rather absorb — a [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md) buffer can be simpler.
- **The consumer itself is the real bottleneck** — fix that first instead of engineering flow control around it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a bounded channel that pushes back"
class BoundedChannel<T> {
  private readonly buffer: T[] = [];
  private readonly consumers: Array<(item: T) => void> = [];
  private readonly producerWaiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  // Producer blocks once the buffer is full — this IS the backpressure.
  // Sketch only: no close, cancel or timeout on the wait.
  async send(item: T): Promise<void> {
    while (this.buffer.length >= this.capacity) {
      await new Promise<void>((resolve) => this.producerWaiters.push(resolve));
    }
    this.buffer.push(item);
    this.drain();
  }

  // Consumer pulls when ready, never faster than it can process.
  receive(): Promise<T> {
    return new Promise<T>((resolve) => { this.consumers.push(resolve); this.drain(); });
  }

  private drain(): void {
    while (this.buffer.length > 0 && this.consumers.length > 0) {
      this.consumers.shift()!(this.buffer.shift()!);
      this.producerWaiters.shift()?.(); // freed a slot, unblock a producer: resumes at capacity-1, no hysteresis (the explain example resumes lower)
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **TCP receive window** — The receiver advertises how many bytes it can still accept; SO_RCVBUF sizes the buffer and window scaling (RFC 7323) lifts the 64 KB ceiling. A full receiver advertises a zero window that pauses the sender until it drains and sends a window update. {#wild-tcp-window}
- **Reactive Streams** — The request(n) protocol inverts push into demand-driven pull, and a Publisher must never emit more than requested. The interfaces were absorbed into the JDK as java.util.concurrent.Flow in Java 9 and back Project Reactor, RxJava, and Akka Streams. {#wild-reactive-streams}
- **HTTP/2 and gRPC flow control** — Per-stream and per-connection WINDOW_UPDATE frames let one slow stream push back without stalling others on the connection. The initial window defaults to 65535 bytes and is tuned via SETTINGS_INITIAL_WINDOW_SIZE; gRPC rides directly on this mechanism. {#wild-http2-flow-control}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Buffer capacity** — The bound on each in-flight queue. Smaller engages backpressure sooner and keeps memory low; larger absorbs more burst before the producer must slow.
- **Overflow policy** — What a full buffer does: block the producer, drop the oldest, or drop the newest. Reactor onBackpressureBuffer/Drop/Latest and RxJava BackpressureStrategy are named forms of this choice.
- **Demand batch (request(n))** — In pull-based flow control, how many items the consumer requests at once and the low-water mark at which it asks for more. Larger batches amortize signaling; smaller keep latency tight.
- **Receive window / socket buffer** — SO_RCVBUF and the HTTP/2 SETTINGS_INITIAL_WINDOW_SIZE cap how many bytes a sender may keep in flight before waiting for a window update.

### Signals to watch
<!--meta polarity=signal-->

- **Buffer occupancy** — How full each stage buffer runs. Sustained near-capacity means the consumer is the bottleneck.
- **Producer wait time** — Time producers spend blocked or throttled. Rising values mean the slow-down signal is propagating upstream.
- **Consumer lag** — Backlog between what has been produced and what has been consumed, such as Kafka consumer lag.
- **Drop rate** — Under a load-shedding policy, items discarded per second: the running cost of staying alive.

### Failure modes under load
<!--meta polarity=failure-->

- **The hop that ignores the signal** — Any stage with an unbounded buffer that does not propagate backpressure becomes the place the queue grows without limit, ending in an out-of-memory crash.
- **Oscillation or stall** — A badly tuned or laggy feedback loop makes throughput swing between full speed and stalled, or deadlocks when two stages each wait on the other.
- **Head-of-line blocking** — Without per-stream flow control, one slow consumer sharing a channel stalls every other stream on it.

### Readiness checklist
<!--meta polarity=check-->

- Bound every buffer upstream of the slowest stage; an unbounded queue there is where memory grows.
- Verify the signal propagates end to end: pause the consumer in a load test and confirm producer wait time rises at every upstream stage.
- Choose an explicit overflow policy (block, drop-oldest, or drop-newest) for when waiting is unacceptable.
- Instrument queue depth and producer wait time to see backpressure engage before it becomes an OOM.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Streaming](../../themes/streaming.md) — Keep a fast producer from drowning a slow consumer {#fluency-streaming}
- [Handling Spikes](../../themes/spike-handling.md) — Signal upstream to slow down {#fluency-spike-handling}
- [Long-Running Tasks](../../themes/long-running-tasks.md) — Slow intake when the queue backs up {#fluency-long-running-tasks}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Pipe-and-Filter](../architecture/pipe-filter.md) — Slow filters must push back upstream
- [Autoscaling](../distributed/routing/autoscaling.md) — Push back while new capacity spins up
- [Producer-Consumer](./producer-consumer.md) — A full buffer must slow the producer
- [Actor Model](./actor-model.md) — Bounded mailboxes push back
- [Batching](./batching.md) — Batching buffers in-flight items; backpressure is what bounds that buffer
- [Reactor](./reactor.md) — An event loop pushes back by unregistering interest, not by blocking
- [Load Shedding](../distributed/resilience/load-shedding.md) — When the upstream cannot be slowed, refusing at admission is the remaining lever
- [Leaky Bucket](../distributed/resilience/leaky-bucket.md) — A refusal from a bounded queue is one way to signal a sender to slow down.
- [Channels](./channels.md) — A bounded channel is one way to apply it
- [Ring Buffer](./ring-buffer.md) — A bounded ring gives backpressure a visible place to act
- [Polling Consumer](../messaging/polling-consumer.md) — A consumer that pulls at its own pace is the simplest form of backpressure
- [Thread Pool](./thread-pool.md) — A pool's full queue is where the slow-down signal fires
- [WebSocket](../messaging/websocket.md) — A socket's output buffer is where a slow client's lag shows first.
- [Splitter](../messaging/splitter.md) — A splitter is a burst source that needs the bound.

**Alternative to**

- [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md) — Absorb the burst vs. signal senders to slow down

**Often confused with**

- [Rate Limiter](../distributed/resilience/rate-limiter.md) — Reject over-rate vs. ask upstream to slow

**Prevents**

- [Unbounded Queue](../../hazards/unbounded-queue.md) — Signal the producer to slow down before the buffer overflows
- [Noisy Neighbour](../../hazards/noisy-neighbour.md) — Without a slow-down signal a batch job floods a shared pool

**Exposed to**

- [Deadlock](../../hazards/deadlock.md) — Can fall into deadlock when stages joined by full bounded buffers form a cycle and each waits on the other to drain

**Demonstrated by**

- [ChatGPT](../../designs/chatgpt.md) — rejecting overload rather than letting latency and queue depth grow without limit is backpressure applied at system scale
- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — the accept path is coupled to the drain rate: refusing a know your customer (KYC) flow costs the client a retry they can see, accepting it costs them a flow invisible for hours
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — refusal published as a contract term, on the argument that an accepted flow buried in a backlog is a worse failure than a rejected one

<!-- relationships:end -->
