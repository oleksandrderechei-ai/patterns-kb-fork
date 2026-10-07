---
title: Polling Consumer
description: Pulls the next message from a channel when it has capacity
area: messaging
owner: Oleksandr Derechei
tags: [messaging, backpressure, asynchrony]
status: stable
aliases: [pull consumer]
solves: [A burst of messages floods my worker because the broker pushes faster than it can finish, I want my worker to take the next job only when it is free, My consumer sits behind a firewall and nothing can call into it, "I need to control exactly when my consumer reads, for a batch window or a rate limit"]
---

# Polling Consumer

A consumer that asks the channel for the next message when it has capacity, instead of waiting for the channel to hand messages to it.

## What it is
<!--meta block=description-->

A consumer that is pushed messages as fast as they arrive can be flooded when it is slow or busy, and it has no say in when work starts. A **polling consumer** reverses that. It asks the channel for the next message when it has capacity, processes it, then asks again. The consumer sets its own pace, so a burst waits in the queue instead of overloading the worker.

## Explained
<!--meta block=explain-->

A polling consumer asks the channel for the next message when it is ready, instead of waiting to be handed one. It loops: ask, receive a message or an empty answer, process, acknowledge, ask again. Because it fetches only with spare capacity, a burst waits in the queue instead of flooding the worker. Choose it over an event-driven consumer, which the broker pushes messages to, when each message is heavy work, the pace must be controlled, or nothing can push to you. Choose push when delay in milliseconds matters more than pace. A push consumer with no limit on unacknowledged messages piles them into its own memory. See [long polling](./long-polling.md) for the variant that cuts empty asks.

- **Empty polls waste calls.** Each empty answer costs a call and maybe money; back off when idle or hold the request open.
- **Delay up to one interval.** A message waits for the next poll; shorten the interval or use long polling.
- **You own the loop.** Crashes, slow messages and shutdown are yours; use a framework poller and make the handler idempotent (safe to run twice).

**Example.** A queue gets a burst of 600 image jobs, each taking 2 s. Four pollers take one job each, so work runs at 2 jobs a second and the queue drains in 300 s, with 4 images in memory. A push consumer with no limit on unacknowledged messages would take all 600 at once and hold 600 x 8 MB = 4.8 GB. The cost shows when idle: four pollers asking every second make 4 empty calls a second all night. Holding each request open for 20 s cuts that to 0.2 calls a second, with the same 2 s of work once a job arrives.

## How it works
<!--meta block=structure-->

```mermaid caption="Who decides when work starts? The consumer. Step 2 happens only when the loop has capacity, so a burst of step 1 grows the queue, not the worker, and the acknowledgement at step 5 is what lets the queue forget the message."
flowchart LR
    Prod["Producers"]:::ext
    Q[("Queue")]
    subgraph CW["Consumer"]
        Loop["Poll loop"]
        Work["Handler"]
    end
    Prod -->|"1 send, any rate"| Q
    Loop -->|"2 ask for one message"| Q
    Q -->|"3 one message, or empty"| Loop
    Loop -->|"4 process"| Work
    Work -->|"5 acknowledge"| Q
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What if the consumer dies mid-message? The queue never saw an acknowledgement, so after a timeout it offers the message again. The cost is that a message can be handled twice, which is why the handler must be safe to repeat."
sequenceDiagram
    autonumber
    participant C as Polling consumer
    participant Q as Queue
    C->>Q: poll
    Q-->>C: message m1, hidden from others for 30 s
    Note over C: handler crashes before acknowledging
    Note over Q: 30 s pass, m1 becomes visible again
    C->>Q: poll
    Q-->>C: message m1 again
    C->>Q: acknowledge m1
```

The loop has four decisions to make. How many messages to ask for at once, what to do when the answer is empty, how long a received message stays hidden from other consumers before it is offered again, and when to stop. An empty answer should not lead straight to another poll: back off, or ask the channel to hold the request open until a message arrives, as [long polling](./long-polling.md) does.

Scaling is adding more pollers on the same queue, which then work as [competing consumers](./competing-consumers.md). Each message goes to one of them, and the hidden-for-a-while rule keeps two pollers from working the same message at the same time, as long as handling finishes inside the hide time.

## Variations
<!--meta block=variations-->

- **Fixed-interval poll** — Asks once every N seconds, whatever the answer. It is the simplest loop, and it adds up to one interval of delay while making calls that are often empty.
- **[Long polling](./long-polling.md)** — The request stays open at the broker until a message arrives or a wait limit passes. Delay falls to near zero and empty calls fall sharply, at the price of an open connection per poller.
- **Backoff polling** — The wait grows after each empty answer and resets when a message arrives. An idle system stays cheap, and the first message after a quiet spell is delayed by up to the longest wait.
- **Batch poll** — Asks for up to N messages in one call. It cuts calls per message, and a crash mid-batch means the whole batch is offered again.
- **Polling a plain resource** — The same loop applied to a directory, a table or a web endpoint that offers no push. The consumer remembers what it has seen so a changed or unchanged resource is told apart.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The consumer sets its own pace** — it asks only when it has capacity, so a burst queues at the broker instead of in the worker.
- **Backpressure comes without extra parts** — a slow consumer simply asks less often, and nothing is dropped.
- **Scaling is adding pollers** — each takes its own share of the queue, and none needs to be told about the others.
- **It needs only outbound connections** — a consumer behind a firewall or on a laptop can pull when nothing can push to it.
- **Pausing and shutdown are easy** — stop asking, finish the current message and exit.

### Cons
<!--meta polarity=con-->

- **Delay up to one interval**, so a message waits for the next poll. Use long polling when delay matters.
- **Empty polls cost calls** and often money. Back off when the answer is empty, and ask for batches under load.
- **You own the loop.** Crashes, slow messages, acknowledgement timeouts and shutdown are yours to handle, so use a framework's poller where one exists.
- **A message can be delivered twice** when a consumer dies before it acknowledges. Make the handler [idempotent](./idempotency.md).
- **A bad message can loop forever**, being polled, failing and offered again. Cap attempts and move it to a [dead-letter channel](./dead-letter-channel.md).

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Each message takes real work**, and you want to hold the number in flight to what the consumer can finish.
- **The consumer has to control timing**, such as a batch window, a rate limit on a downstream call or a maintenance pause.
- **Nothing can push to the consumer**, because of a firewall, a serverless limit or a source that only supports reads.

### Avoid when
<!--meta polarity=avoid-->

- **A message must reach the consumer within milliseconds**, and the delay and empty calls of polling matter more than pace control.
- **The broker already pushes with a flow-control window** that gives the same pace control, with less code in your loop.
- **Volume is low and bursty**, so most polls are empty and an event-driven trigger would cost less.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — ask for one message, process it, acknowledge, back off when the queue is empty"
async function pollLoop(queue: Queue, handle: (m: Message) => Promise<void>, signal: AbortSignal) {
  let idleMs = 100;                                   // grows while the queue is empty

  while (!signal.aborted) {
    const msg = await queue.receive({ hideForMs: 30_000 }); // hidden from others while we work
    if (!msg) {
      await sleep(idleMs);
      idleMs = Math.min(idleMs * 2, 5_000);           // back off, capped at 5 s
      continue;
    }
    idleMs = 100;                                     // work arrived, reset the wait

    try {
      await handle(msg);
      await queue.acknowledge(msg);                   // only now does the queue forget it
    } catch (err) {
      // no acknowledgement: the queue offers it again after the 30 s hide time
      console.error("handler failed", msg.id, msg.receiveCount, err); // past the attempt cap, send it to the dead-letter channel
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **Amazon SQS** — Consumers pull with ReceiveMessage. WaitTimeSeconds turns the call into a long poll, and a received message stays hidden for its visibility timeout until the consumer deletes it. {#wild-sqs-receive}
- **Apache Kafka consumer** — A consumer pulls batches of records by calling poll() in a loop. max.poll.records caps the batch, and a consumer that is too slow between calls is removed from its group. {#wild-kafka-poll}
- **Spring Integration poller** — A PollingConsumer endpoint, configured with a poller, asks a pollable channel for a message on a schedule and passes it to a handler. {#wild-spring-integration-poller}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Poll interval or wait time** — How often to ask, or how long a long poll waits. Sets the delay a message can suffer against the number of empty calls.
- **Batch size** — Messages taken per poll, such as max.poll.records in Kafka. Larger batches cut calls and make a crash redo more work.
- **Visibility or acknowledgement timeout** — How long a received message stays hidden before it is offered again; this page calls it the hide time, SQS the visibility timeout. Set it above the tail of measured handling time with some margin, or have the consumer extend it while it works.
- **Number of pollers** — Concurrent loops on the same queue. It sets throughput and the load on the downstream system. Start from arrival rate times handling time, cap it at what the downstream system takes, and check it against the age of the oldest message.
- **Idle backoff cap** — The longest wait between polls on an empty queue. It bounds both idle cost and first-message delay.

### Signals to watch
<!--meta polarity=signal-->

- **Queue depth and age of the oldest message** — Depth shows backlog and age shows how late the consumers are. Age is the one tied to a promise to users.
- **Empty poll ratio** — Share of polls that return nothing. A high value at steady state means wasted calls.
- **Handling time against the timeout** — The tail of processing time compared with the hide time. A tail near the limit predicts duplicate handling.
- **Redelivery count** — How many times messages are offered again. A rise means crashes, timeouts or a bad message.

### Failure modes under load
<!--meta polarity=failure-->

- **Duplicate handling** — Handling outlasts the hide time, so the queue offers the message to a second poller while the first is still working.
- **Poison message loop** — A message that always fails is polled, fails and returns forever, taking a poller slot each time.
- **Group removal** — On a pull system with membership such as Kafka, a consumer that waits too long between polls is dropped from its group and its work moves to the others (a rebalance). In Kafka the limit is `max.poll.interval.ms`; lower max.poll.records or the handling time to stay under it.
- **Poll storm** — Many pollers on a tiny interval hit an empty queue or a rate-limited API with a constant flood of calls. Pollers that back off in step retry together; add random jitter to the wait.

### Readiness checklist
<!--meta polarity=check-->

- The handler is safe to run twice on the same message
- The hide or acknowledgement timeout exceeds the slowest handling time, or the handler extends it while working
- Failed messages stop after a set number of attempts and land in a dead-letter channel
- Idle polling backs off or uses a long poll
- Shutdown finishes the current message before exit

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Long-Running Tasks](../../themes/long-running-tasks.md) — Pull the next message only when ready, so the consumer sets the pace. {#fluency-long-running-tasks}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Message Queue](./message-queue.md) — Asks the queue for the next message when it has capacity
- [Backpressure](../concurrency/backpressure.md) — Pulling only when ready makes the consumer set the pace, so a slow consumer is never flooded
- [Competing Consumers](./competing-consumers.md) — Several polling consumers can pull from one queue, each taking the next message when free
- [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md) — A burst waits in the queue while the consumer drains it at a steady rate
- [Dead Letter Channel](./dead-letter-channel.md) — Failed messages stop after a set number of attempts and land here, so a bad message stops taking a poller slot.
- [Idempotency](./idempotency.md) — A message can be handled twice when the consumer dies before acknowledging, so the handler must tolerate a repeat.

**Often confused with**

- [Long Polling](./long-polling.md) — Pulls from a queue at its own pace and may get nothing back at once; long polling is one request held open until data arrives, and is also a way to run this loop.

**Exposed to**

- [Poison Message](../../hazards/poison-message.md) — A message that always fails is polled, fails and returns forever, taking a poller slot each time.

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that pulls messages on a schedule as a ready-made building block.

<!-- relationships:end -->
