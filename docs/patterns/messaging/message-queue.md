---
title: Message Queue
description: "Point-to-point channel, each message consumed once"
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling, asynchrony, durability]
status: stable
aliases: [queue, MQ]
solves: [my API call blocks for 30 seconds waiting on work that could happen later, when the worker box is down the requests that came in are just gone, a traffic spike overwhelmed my processing service and it fell over, work that was accepted right before a crash vanished without a trace, the thing producing work is way faster than the thing doing it]
---

# Message Queue

A point-to-point channel that holds each message until exactly one consumer pulls and processes it — decoupling producer from consumer in both time and pace.

## What it is
<!--meta block=description-->

Without a queue, a producer that calls a slow or down consumer blocks, and a burst becomes failures. A **message queue** is a durable channel between them: the producer adds a message and moves on, and the queue holds it until a consumer takes it. Each message goes to one consumer at a time, and goes out again if it is not acknowledged. A burst becomes a backlog that drains, and stored messages survive a crash.

## Explained
<!--meta block=explain-->

Use a message queue when the caller does not need the answer now. The producer no longer waits for the consumer to be up or fast, a burst becomes a backlog that drains instead of a failure, and a crash between accepting and finishing the work loses nothing once the broker has stored the message, until retention expires it. A queue hands each message to one consumer at a time. Choose a [publish-subscribe](./pubsub.md) topic instead when every interested party needs the message, not just one.

- **Duplicates.** Delivery is at-least-once, so make each handler safe to repeat.
- **Waiting.** Messages wait, so alert on the age of the oldest waiting message.
- **Harder tracing.** The path is indirect, so stamp each message with a correlation id (one token shared by a whole operation).
- **Broker upkeep.** You must run the broker and keep it available.

**Example.** A launch sends 100 signups a second for 60 s, and the email service sends 40 a second. A direct call fails 60 requests a second at once. With a queue, the form answers in milliseconds and the backlog grows by 60 a second: 3,600 messages after the minute. When arrivals fall to 20 a second, the queue drains at 40 - 20 = 20 a second, which takes 180 s. The cost is delay. The last signup of the burst waits behind 3,600 messages at 40 a second, so its email arrives 90 s late.

## How it works
<!--meta block=structure-->

```mermaid caption="How does the work survive a worker that dies mid-job? Step 1 returns as soon as the broker has stored the message; between 2 and 3 the message is hidden from every other consumer, so exactly one worker holds it. If the ack never comes the lease expires and the message goes out again — which is why step 4 can run the same work twice, and why step 5 exists for the message that fails every time."
flowchart LR
    P["Checkout service"]
    subgraph Lease["One in-flight visibility window"]
        Q[("Order queue")]
        C["Fulfilment worker"]
    end
    C2["Second worker"]
    DLQ[("Dead-letter queue")]:::ext
    P -->|"1 enqueue, returns on broker ack"| Q
    Q -->|"2 deliver, hide from others"| C
    C -->|"3 ack, message deleted"| Q
    Q -->|"4 lease expired, no ack"| C2
    Q -->|"5 after N failed attempts"| DLQ
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The producer never waits on the consumer. Delivery is typically at-least-once: a dequeued message stays hidden while a consumer works it, and comes back for redelivery if it's never acknowledged."
sequenceDiagram
    autonumber
    participant P as Producer
    participant Q as Queue
    participant C as Consumer
    P->>Q: enqueue message
    Q-->>P: stored, ack
    C->>Q: poll for next message
    Q->>C: deliver, mark invisible
    alt processed successfully
        C->>Q: ack
        Q->>Q: delete message
    else consumer crashes before ack
        C--xQ: ack never arrives
        Note over Q: visibility timeout expires
        Q->>C: redeliver message
    end
```

## Variations
<!--meta block=variations-->

- **[Competing Consumers](./competing-consumers.md)** — Run a pool of consumer instances against the same queue to scale throughput horizontally — the queue hands any one message to only one of them at a time.
- **Visibility timeout / lease-based redelivery** — A dequeued message is hidden rather than deleted until the consumer acknowledges it; if the lease expires without an ack, another consumer picks it up — the basis of at-least-once delivery.
- **[Dead Letter Channel](./dead-letter-channel.md)** — A message that fails processing past a retry limit is diverted to a separate channel instead of blocking the queue or being redelivered forever.
- **FIFO vs. standard queues** — FIFO (first in, first out) queues keep strict order within a group and drop duplicate sends inside a time window, at the cost of throughput; consumers still need idempotency. Standard queues favor throughput and tolerate occasional reordering or duplicates.
- **[Claim Check](./claim-check.md)** — Store a large payload externally and put only a reference in the message, so broker size limits and throughput aren't spent moving bulk data around.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Decouples producer and consumer lifecycles** — either can be down without losing submitted work.
- **Absorbs bursts**, turning spiky arrival rates into a steady, sustainable consumer load.
- **Consumers scale horizontally against one queue** without any change to producers.
- **Durable persistence protects in-flight work across crashes** and restarts.

### Cons
<!--meta polarity=con-->

- **Introduces a broker as new infrastructure** to run, monitor, and keep highly available.
- **Adds end-to-end latency versus a direct call** — a message waits in the backlog until a consumer is free, and under a burst that wait dominates.
- **At-least-once delivery pushes** [idempotency](./idempotency.md) onto every consumer, or duplicates cause real damage.
- **Flow becomes indirect**: tracing a message's path is harder than following a synchronous call stack.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Producer and consumer run at different speeds**, or shouldn't need to be online at the same time.
- **You need to absorb bursts** and let consumers process at a controlled, sustainable rate.
- **Submitted work must survive** a crash between being accepted and being processed.

### Avoid when
<!--meta polarity=avoid-->

- **The caller needs an immediate, synchronous response** — a queue adds latency instead of removing it.
- **Every interested party must see every message** — that's broadcast, reach for [Publish-Subscribe](./pubsub.md) instead.
- **Producer and consumer are in the same process** — a plain function call or in-memory channel is simpler.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal queue with visibility timeout"
interface Message<T> { id: string; body: T; visibleAt: number } // 0 means visible now

class MessageQueue<T> {
  private messages: Message<T>[] = [];
  private inFlight = new Map<string, Message<T>>();

  enqueue(body: T): void {
    this.messages.push({ id: crypto.randomUUID(), body, visibleAt: 0 });
  }

  dequeue(visibilityMs = 30_000): Message<T> | undefined {
    const now = Date.now();
    for (const [id, m] of this.inFlight) {
      if (m.visibleAt <= now) { // lease expired with no ack: redeliver
        this.inFlight.delete(id);
        this.messages.push(m);
      }
    }
    const msg = this.messages.find((m) => m.visibleAt <= now);
    if (!msg) return undefined;
    this.messages = this.messages.filter((m) => m !== msg);
    msg.visibleAt = now + visibilityMs; // hidden until ack or lease expiry
    this.inFlight.set(msg.id, msg);
    return msg;
  }

  ack(id: string): void {
    this.inFlight.delete(id); // processed successfully, gone for good
  }

  nack(id: string): void {
    const msg = this.inFlight.get(id);
    if (msg) { msg.visibleAt = 0; this.messages.push(msg); } // visible again now
    this.inFlight.delete(id);
  }
}
```

## In the wild
<!--meta block=wild-->

- **RabbitMQ** — Holds each message until the consumer sends basic.ack; basic.qos sets per-consumer prefetch, quorum queues replicate the queue across nodes, and a dead-letter exchange catches rejected or expired messages. {#wild-rabbitmq}
- **Amazon Simple Queue Service (SQS)** — Managed queue with a configurable VisibilityTimeout and MessageRetentionPeriod up to 14 days; a redrive policy dead-letters a message after maxReceiveCount attempts, and FIFO queues add ordering plus dedup within a message group. {#wild-amazon-sqs}
- **Apache ActiveMQ** — A Java Message Service (JMS) broker whose queues give classic point-to-point delivery; a redelivery policy retries with backoff before routing to a dead-letter queue, and the KahaDB store persists messages across restarts. {#wild-activemq}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Visibility timeout (message lease)** — How long a dequeued message stays hidden before redelivery; set above the slowest processing time in consumer metrics, or extend it with a heartbeat (a periodic call that extends the lease). Too long delays recovery after a crash.
- **Consumer prefetch / concurrency** — How many unacknowledged messages one consumer holds in flight; caps memory and spreads load across the pool.
- **Max receive count before dead-lettering** — Number of failed delivery attempts before a message is diverted to a dead-letter channel; pick a count whose total retry delay outlasts a typical transient fault.
- **Message retention / time to live (TTL)** — How long an unconsumed message survives before the broker discards it.
- **Consumer pool size** — Number of competing consumers draining one queue.

### Signals to watch
<!--meta polarity=signal-->

- **Queue depth (backlog)** — Messages waiting to be consumed; the primary saturation signal. Depth divided by dequeue rate is the time to drain.
- **Age of oldest waiting message** — How long the front of the queue has waited to be picked up; set the alert from the latency target of the work.
- **Dead-letter and redelivery rate** — Messages diverted or redelivered per interval; a rise flags poison messages or failing consumers.
- **Enqueue vs. dequeue rate** — Whether consumers are keeping pace with producers.

### Failure modes under load
<!--meta polarity=failure-->

- **Poison message** — A message that always fails is redelivered each cycle and ties up a consumer until it hits the dead-letter threshold.
- **Lease shorter than processing time** — The visibility timeout expires mid-work, a second consumer takes the same message, and it runs twice.
- **Backlog runaway** — Sustained enqueue above consumer capacity grows depth and latency until retention or broker limits discard the oldest messages unprocessed; cap depth or age and slow producers.
- **Duplicate delivery** — At-least-once redelivery double-applies non-idempotent side effects.

### Readiness checklist
<!--meta polarity=check-->

- Consumers are idempotent — dedupe on message id or a key from the work itself, such as an order id
- A dead-letter channel is configured with a bounded retry count
- Visibility timeout exceeds worst-case processing, or the consumer extends the lease with a heartbeat
- Queue depth and oldest-message age are alerted, not just graphed
- Load test confirms consumers drain faster than sustained peak enqueue rate

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [System Design Interview](../../themes/system-design-interview.md) — Decouple services and absorb bursts {#fluency-system-design-interview}
- [Streaming](../../themes/streaming.md) — Buffer and decouple stream stages {#fluency-streaming}
- [Long-Running Tasks](../../themes/long-running-tasks.md) — Hand the work off to a durable queue {#fluency-long-running-tasks}
- [Data Platform](../../themes/data-platform.md) — Work in flight, as distinct from state at rest {#fluency-data-platform}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Outbox](../distributed/coordination/outbox.md) — A relay drains the outbox to the broker
- [Inbox](../distributed/coordination/inbox.md) — Source of messages; broker must support acknowledgement
- [Producer-Consumer](../concurrency/producer-consumer.md) — The queue is the buffer between them
- [Actor Model](../concurrency/actor-model.md) — Each actor has a mailbox queue
- [Claim Check](./claim-check.md) — Keep large payloads out of the queue
- [Message Router](./message-router.md) — Queues are the channels a router reads from and writes to
- [Prefer Managed Services](../../principles/managed-services.md) — A hosted broker is queueing without the operational commitment
- [Polling Consumer](./polling-consumer.md) — A queue holds messages until a polling consumer asks for them
- [Idempotency](./idempotency.md) — At-least-once delivery makes every consumer owe a safe repeat.

**Alternative to**

- [Channels](../concurrency/channels.md) — A message queue survives restarts and spans machines

**Has variant**

- [Priority Queue](./priority-queue.md) — Order by a priority value instead of first-in-first-out

**Enables**

- [Competing Consumers](./competing-consumers.md) — Gives the workers one place to pull from, so capacity grows by starting more copies
- [Dead Letter Channel](./dead-letter-channel.md) — The main queue is what a failed message is moved out of, so it can keep flowing

**Part of**

- [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md) — A queue is what levels the load

**Often confused with**

- [Publish-Subscribe](./pubsub.md) — Broadcast to many vs. one consumer per message

**Prevents**

- [Head-of-Line Blocking](../../hazards/head-of-line-blocking.md) — Competing consumers keep one slow message from stalling the rest.

**Exposed to**

- [Poison Message](../../hazards/poison-message.md) — A queue needs an attempt limit and a dead letter route to survive one.
- [Unbounded Queue](../../hazards/unbounded-queue.md) — Can fall into unbounded queue when a broker queue with no depth or age limit keeps accepting work no one will finish
- [Metastable Failure](../../hazards/metastable-failure.md) — Can fall into metastable failure when a backlog of requests whose callers gave up keeps the consumers busy with worthless work

**Demonstrated by**

- [Metrics & Monitoring](../../designs/metrics-monitoring.md) — the entire write path is a producer feeding a durable log that storage drains at its own pace
- [Facebook News Feed](../../designs/fb-news-feed.md) — the queue decouples a fast post-write from a slow, bursty fan-out, letting the two scale independently
- [Instagram](../../designs/instagram.md) — the async fan-out worker consumes post-created jobs from a queue, decoupling posting from feed propagation
- [Uber](../../designs/uber.md) — a durable queue decouples arrival rate from processing rate and gives at-least-once handoff with no lost work
- [Online Auction](../../designs/online-auction.md) — durable, per-auction-ordered queueing of bids shows a message queue used for both loss-proofing and fair ordering
- [Job Scheduler](../../designs/job-scheduler.md) — the whole precision story rests on a queue that defers message visibility until the scheduled instant
- [Facebook Post Search](../../designs/fb-post-search.md) — a durable log between posting and indexing lets the write return before a single keyword entry is appended
- [Web Crawler](../../designs/web-crawler.md) — two queues separate fetching from parsing, so each stage fails, retries and scales on its own
- [ChatGPT](../../designs/chatgpt.md) — The queue decouples a spiky producer from a fixed-rate consumer, and the design shows what that costs in added latency

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Every cloud sells this outright.
- [Message brokers & streams](../../comparisons/message-brokers.md) — Which broker to actually run — managed queues against Kafka, RabbitMQ, NATS, Pulsar and Redpanda.

<!-- relationships:end -->
