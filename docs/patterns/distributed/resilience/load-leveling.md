---
title: Queue-Based Load Leveling
description: A queue absorbs bursts so consumers work at their own pace
area: distributed-resilience
owner: Oleksandr Derechei
tags: [messaging, decoupling, throughput, backpressure]
status: stable
aliases: [queue-based load leveling]
solves: [traffic spikes for ten minutes and my service falls over even though it could handle the volume overall, a marketing email goes out and the whole site melts for an hour, my workers cannot keep up at peak but sit idle the rest of the day, the database only writes so fast but requests arrive in huge bursts, when the image processor is down every incoming upload is just lost]
favourite: true
---

# Queue-Based Load Leveling

A queue sits between producers and consumers, absorbing a sudden burst of requests so the consumer can keep draining it at a steady, sustainable pace instead of buckling under the spike.

## What it is
<!--meta block=description-->

A burst of ten minutes' traffic arriving in one minute exhausts threads and connections, though the database could finish the work if it were spread out. Queue-based load leveling puts a durable queue between callers and workers. A caller writes the request and gets a receipt, and workers take the next one when free, so arrival rate and processing rate stop being the same number.

## Explained
<!--meta block=explain-->

Queue-based load leveling puts a durable waiting line between the callers who send work and the workers who do it, so a burst no longer has to be handled the moment it arrives. A caller writes its request to the queue and gets a receipt. Workers take the next one when free. The line changes when the work happens, never how much there is, so the workers' speed still sets total throughput. Order processing, webhook receivers and log ingestion all work this way. Choose it over a [rate limiter](rate-limiter.md) when you want to keep every request and the caller does not need the result now. A limiter drops the excess, and a queue holds it.

- **Receipt, not result.** Give callers a way to ask later how the work went.
- **Critical store.** The queue holds your work, so plan its capacity and durability.
- **Overload only delays.** Cap the depth and refuse above it.
- **Redelivery and order.** Make workers safe to repeat, and send related messages to one worker with a shared key.

**Example.** A campaign email sends 60,000 signups in 10 minutes, which is 100 a second. The database accepts 20 writes a second. Without a queue, 80 a second wait in held threads until the service runs out and fails. With a queue, all 60,000 are accepted and each caller gets a receipt at once. After the burst, 48,000 are still waiting and the workers need 40 more minutes to drain them, so the last customer's confirmation arrives about 50 minutes in. That wait is the cost. Add workers and a database that takes 100 writes a second, and the line stays near empty.

## How it works
<!--meta block=structure-->

```mermaid caption="How does ten minutes of traffic arriving in one reach a consumer whose ceiling does not move? Steps 1–3 are the whole happy path: the burst becomes queue depth rather than load, and a worker takes the next message only when it is free to. The dotted edges are the two ways out — at its bound the buffer refuses the producer instead of growing without limit, and a message that exhausts its redeliveries moves aside so it cannot block the ones behind it."
flowchart LR
    Prod["Producer — API or webhook receiver"]
    Q[("Durable work buffer — bounded depth")]
    subgraph Level["Fixed capacity — drains only as fast as the ceiling allows"]
        Worker["Consumer workers"]
        Sink[("Rate-limited vendor or write-bound store")]:::ext
    end
    DLQ[("Dead-letter queue")]
    Prod -->|"1 enqueue, get a receipt back"| Q
    Q -->|"2 hand the next message to a free worker"| Worker
    Worker -->|"3 do the work inside the ceiling"| Sink
    Q -.->|"buffer at its bound: refuse, 429 + Retry-After"| Prod
    Worker -.->|"redelivery limit hit"| DLQ
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="How does a burst reach a fixed-rate consumer without loss — and what happens when the buffer itself fills? The queue absorbs the backlog; a bounded queue sheds only once it is full."
sequenceDiagram
    autonumber
    participant P as Producer
    participant Q as Bounded Queue
    participant C as Consumer
    Note over P: burst arrives faster than C drains
    alt backlog below capacity
        P->>Q: enqueue message
        Q-->>P: accepted
    else queue full
        P--xQ: enqueue rejected
        Q-->>P: backpressure / 429
    end
    loop drain at a sustainable pace
        C->>Q: dequeue next
        Q-->>C: message
    end
```

## Variations
<!--meta block=variations-->

- **Bounded queue** — Cap the queue's depth and reject or redirect once full, so an [unbounded backlog](../../../hazards/unbounded-queue.md) can't itself become the outage.
- **[Competing Consumers](../../messaging/competing-consumers.md)** — Run several consumer instances draining the same queue in parallel, raising throughput without changing the producer side at all.
- **[Autoscaling](../routing/autoscaling.md)** — Scale the number of consumers to queue depth, so the backlog itself is the signal that drives added capacity.
- **[Priority queue](../../messaging/priority-queue.md)** — Give latency-sensitive messages a lane that skips the backlog, while bulk or best-effort work waits behind it.
- **[Dead-letter queue](../../messaging/dead-letter-channel.md)** — Move a message aside after it fails processing repeatedly, so one poison message can't block everything behind it.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Smooths bursty, unpredictable traffic** into a steady load the consumer can actually sustain.
- **Producers and consumers scale, deploy, and fail independently** — the queue is the only coupling.
- **A durable queue survives a consumer outage**; work waits instead of being dropped.
- **Simple to reason about** — one component, the queue, does all of the leveling.

### Cons
<!--meta polarity=con-->

- **Introduces asynchrony** — a caller can no longer assume an immediate result, so every caller needs a receipt and a way to ask later how the work went.
- **The queue becomes a critical, stateful dependency** that needs its own capacity and durability planning.
- **Under sustained overload** an unbounded backlog just delays the failure instead of preventing it — bound the depth and shed above it with a [rate limiter](./rate-limiter.md), or push the refusal upstream as [backpressure](../../concurrency/backpressure.md).
- **Consumers must tolerate redelivery** — they must be [idempotent](../../messaging/idempotency.md), since most queues redeliver a message on a failed or timed-out ack.
- **Ordering is not free**: several consumers draining one queue finish out of order, so work that depends on sequence needs a partition key that pins related messages to one consumer — and that key caps how far you can parallelize.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Arrival rate spikes far above the average**, while consumer capacity is comparatively fixed.
- **The work can be processed asynchronously** — the caller doesn't need the result inline.
- **You'd rather buffer legitimate traffic** through a spike than shed or reject it.

### Avoid when
<!--meta polarity=avoid-->

- **Callers need a synchronous response** and can't tolerate queueing delay.
- **Load is steady and predictable** — a queue adds a component for no leveling benefit.
- **The real constraint is capacity itself, not smoothing** — pair with [Autoscaling](../routing/autoscaling.md) to actually add throughput.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a bounded queue ahead of a rate-limited vendor"
interface Task { id: string; flowId: string; personaId: string; type: "verify_id"; }

class LevelingQueue {
  private buffer: Task[] = [];
  constructor(private readonly maxDepth = 10_000) {}

  enqueue(task: Task): void {
    if (this.buffer.length >= this.maxDepth) throw new Error("queue full — shed this request");
    this.buffer.push(task); // absorbs the burst, doesn't process it
  }
  dequeue(): Task | undefined { return this.buffer.shift(); }
}

// Producer: a client onboards a batch of personas. Accept, enqueue, answer now.
async function startVerification(queue: LevelingQueue, personaId: string) {
  const flowId = crypto.randomUUID();
  queue.enqueue({ id: crypto.randomUUID(), flowId, personaId, type: "verify_id" });
  return { flowId, state: "pending" }; // the vendor call happens later
}

// Consumer: the ceiling is idVendor's rate limit, not this system's capacity.
async function idWorker(queue: LevelingQueue, permitsPerSecond: number) {
  const intervalMs = 1000 / permitsPerSecond;
  while (true) {
    const task = queue.dequeue();
    if (!task) { await sleep(50); continue; }
    await idVendor.verify(task.flowId, task.personaId);
    await sleep(intervalMs); // steady pace, independent of arrival rate
  }
}
```

## In the wild
<!--meta block=wild-->

- **Amazon Simple Queue Service (SQS)** — The canonical buffer in front of workers: producers enqueue and return while consumers drain at their own rate. A VisibilityTimeout hides an in-flight message during processing, and a redrive policy with maxReceiveCount routes repeat failures to a dead-letter queue; standard queues are at-least-once, so consumers must be idempotent. {#wild-amazon-sqs}
- **Apache Kafka** — A durable, replayable partitioned log absorbs ingestion bursts while a consumer group reads at its own pace. Offsets track progress and enable replay, retention (by time or size) bounds how long messages persist, and consumer lag — log-end offset minus committed offset — is the backlog measure. {#wild-kafka}
- **Celery** — A Python web request hands a task to a broker (Redis or RabbitMQ) and responds immediately; worker processes pick it up later. Workers prefetch tasks by a configurable multiplier, acks_late redelivers a task if the worker crashes mid-run, and time limits bound how long any one task may run. {#wild-celery}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Queue depth bound** — The backlog after which the producer sheds or redirects, so the buffer cannot itself become the outage.
- **Consumer concurrency** — How many consumers drain the queue in parallel — the only dial on this page that changes sustained throughput.
- **Visibility / ack timeout** — How long a dequeued message stays hidden from other consumers before it is redelivered (SQS VisibilityTimeout, ack deadline).
- **Batch / prefetch size** — How many messages a consumer takes per fetch (SQS max messages, Kafka max.poll.records, Celery prefetch multiplier). Bigger batches raise throughput and put more work at risk on a crash.
- **Dead-letter policy** — How many failed deliveries a message gets before it is moved aside (maxReceiveCount, redrive), so one poison message cannot hold up the queue behind it.
- **Retention and storage** — How long the broker keeps a message and how much it will hold — the real limit on how long consumers may be down before work is lost.

### Signals to watch
<!--meta polarity=signal-->

- **Backlog depth** — Messages waiting, per queue. Rising depth means consumers are behind arrivals right now.
- **Age of oldest message** — How long the head of the queue has waited (ApproximateAgeOfOldestMessage, consumer lag in time). This, not depth, is the latency a caller feels.
- **Enqueue rate against dequeue rate** — Sustained divergence is overload the buffer is only postponing.
- **Dead-letter depth** — Messages that exhausted their deliveries. A rising count is a poison message or a broken consumer path, never routine.
- **Redelivery rate** — How often messages come back for another attempt — the load consumers are re-doing, and the pressure on their idempotency.

### Failure modes under load
<!--meta polarity=failure-->

- **Backlog only delays the failure** — Under sustained overload an unbounded queue grows, adds latency to everything behind it, and can exhaust broker storage instead of preventing the outage.
- **Redelivery double-processing** — A failed or timed-out ack redelivers, so a consumer that is not idempotent does the same work twice — a second charge, a second email.
- **Visibility timeout mistuned** — Set below real processing time it hands a live message to a second consumer; set far above it, a crashed consumer leaves its message untouched for that whole window.
- **Poison message with no dead-letter** — A message that always fails retries forever and, on an ordered partition, blocks everything behind it.
- **Recovery slower than the outage** — A backlog built over an hour needs consumer headroom above arrival rate to clear. At exactly arrival rate it never drains, and the queue stays full long after the spike has passed.

### Readiness checklist
<!--meta polarity=check-->

- Consumers were tested by delivering the same message twice on purpose, and the second delivery changed nothing
- The full-queue path has an answer a caller can act on — a rejection with a retry hint, not a timeout
- Alerts fire on the age of the oldest message as well as depth; depth alone is normal at peak and fatal when consumers are stopped
- The dead-letter queue has an owner and a route back into processing, so parked messages are read rather than counted
- Broker retention and storage were sized for the longest consumer outage the team is prepared to survive
- A drill filled the queue to its bound and drained it, and the drain rate cleared the backlog inside the time the business expects
- Every caller has a documented route to the outcome — a status record, a callback or a poll — because the API is no longer synchronous

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Handling Spikes](../../../themes/spike-handling.md) — Absorb the burst in a queue, so consumers meet it at their own pace instead of falling over in it. {#fluency-spike-handling}
- [Scaling Writes](../../../themes/scaling-writes.md) — Buffer write bursts in a queue to smooth load, so the store sees a steady rate rather than a spike. {#fluency-scaling-writes}
- [Long-Running Tasks](../../../themes/long-running-tasks.md) — Absorb bursts so workers aren't overwhelmed — what grows under pressure is the backlog, not the failure count. {#fluency-long-running-tasks}
- [Workload Composition](../../../themes/workload-composition.md) — Return to the caller before the write lands {#fluency-workload-composition}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Autoscaling](../routing/autoscaling.md) — Level with a queue while capacity catches up
- [Competing Consumers](../../messaging/competing-consumers.md) — Many consumers drain the leveling queue
- [Batching](../../concurrency/batching.md) — The buffered work drains in batches to cut per-item overhead
- [Asynchronous Request-Reply](../routing/async-request-reply.md) — A 202 with a status resource is how the caller is told its request is buffered rather than done
- [Web-Queue-Worker](../../architecture/web-queue-worker.md) — The web-queue-worker shape is load levelling promoted to the architecture of the whole application.
- [Priority Queue](../../messaging/priority-queue.md) — Add priority classes when the buffered work is not all worth the same
- [Polling Consumer](../../messaging/polling-consumer.md) — The steady drain rate of a polling consumer is what levels the load

**Alternative to**

- [Backpressure](../../concurrency/backpressure.md) — Absorb the burst vs. signal senders to slow down
- [Rate Limiter](./rate-limiter.md) — Shed excess vs. buffer it
- [Load Shedding](./load-shedding.md) — Absorb the burst when the work is deferrable, rather than refusing it outright

**Has variant**

- [Leaky Bucket](./leaky-bucket.md) — Leaky bucket adds a fixed output rate and a bounded queue to the idea of a queue between sender and worker.

**Requires**

- [Idempotency](../../messaging/idempotency.md) — At-least-once redelivery makes consumer idempotency mandatory

**Composed of**

- [Message Queue](../../messaging/message-queue.md) — A queue is what levels the load

**Prevents**

- [Noisy Neighbour](../../../hazards/noisy-neighbour.md) — Bursts hit the shared resource directly when nothing absorbs them
- [Thundering Herd](../../../hazards/thundering-herd.md) — Buffers a concurrency spike the consumer cannot take at once
- [Busy Front End](../../../hazards/busy-front-end.md) — Moves resource-hungry work off the tier answering requests, and flattens the spike on the way

**Exposed to**

- [Unbounded Queue](../../../hazards/unbounded-queue.md) — Its buffer absorbs bursts, so with no depth cap it can grow until memory runs out.

**Demonstrated by**

- [Ad Click Aggregator](../../../designs/ad-click-aggregator.md) — a durable queue between producer and consumer absorbs bursts and decouples ingest from processing
- [Metrics & Monitoring](../../../designs/metrics-monitoring.md) — it is textbook queue-based load leveling shielding a backend from ingest spikes
- [Facebook Post Search](../../../designs/fb-post-search.md) — the design uses a queue to level a spiky 10k-post/sec write load against finite ingestion capacity
- [Uber](../../../designs/uber.md) — putting a buffer between a spiky producer and a fixed-capacity consumer is precisely queue-based load leveling
- [LeetCode](../../../designs/leetcode.md) — a queue between the application programming interface (API) and the workers smooths a traffic burst into steady downstream throughput
- [ChatGPT](../../../designs/chatgpt.md) — a spiky producer feeding a scarce, steady-throughput consumer through a buffer is the textbook case for queue-based load leveling
- [Ticketmaster](../../../designs/ticketmaster.md) — the waiting queue turns a traffic frenzy into a steady trickle the booking path can survive — queue-based load levelling
- [Online Auction](../../../designs/online-auction.md) — the end-of-sale bidding spike is the canonical burst that load leveling smooths into a flat consumption rate
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — queueing persona-check requests ahead of two vendors whose rate limits, not this system's own capacity, set the throughput ceiling
- [YouTube](../../../designs/youtube.md) — A transcode fleet sized to the mean is what the levelling queue buys
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — a queue that absorbs bursts, drawn together with the admission control that handles the overload it cannot

**Implemented by**

- [Messaging & Eventing](../../../capabilities/messaging.md) — The canonical reason to put a managed queue in the path.
- [Message brokers & streams](../../../comparisons/message-brokers.md) — Which buffer product to put between producer and consumer.

<!-- relationships:end -->
