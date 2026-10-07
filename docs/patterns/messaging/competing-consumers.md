---
title: Competing Consumers
description: Many consumers pull from one channel to share load
area: messaging
owner: Oleksandr Derechei
tags: [messaging, load-balancing, throughput]
status: stable
solves: [my backlog keeps growing because one worker cannot drain it fast enough, jobs sit unprocessed for hours before anything gets to them, I need to process more per second but I am not allowed to change the producer, I ran a second copy of my worker and now both grab the same job, traffic doubles at peak and I want to add capacity without a code change]
favourite: true
---

# Competing Consumers

A pool of interchangeable consumers pulls from one shared channel, so a single message goes to one worker at a time and the pool's combined throughput — not any one consumer's — sets the pace.

## What it is
<!--meta block=description-->

Jobs arrive faster than one worker finishes them, so the queue only grows. **Competing consumers** starts several identical, stateless copies of the worker on one channel, and the broker hands each message to whichever copy is free. Delivery is leased: a message left unacknowledged when its lease expires returns for another copy, so delivery is at-least-once. To add capacity you start one more copy, up to the partition count if partitioned. Kafka consumer groups and RabbitMQ work this way.

## Explained
<!--meta block=explain-->

Competing consumers means several identical copies of a worker read one [queue](./message-queue.md), and the broker hands each message to whichever copy is free. Capacity becomes the number of copies you start, and a copy that dies mid-message lets the message go back to the queue for another copy. Choose it over one faster worker when jobs are independent and arrive faster than one process can finish them.

- **Lost order.** Related messages can run on different copies at once; a partition key keeps them together but caps copies at the partition count.
- **Repeat delivery.** A message can arrive twice, so make each handler safe to repeat.
- **Poison messages.** A message that always fails burns capacity, so cap the attempts, then move it to a dead-letter queue.

**Example.** Each job takes 2 s and 4 arrive every second. One worker finishes 0.5 a second, so the backlog grows by 3.5 a second, and after 1 hour 12,600 jobs are waiting. Eight copies finish 4 a second, just matching arrivals, and 10 copies leave 25% headroom for spikes. The cost shows with a malformed job that fails on every try. With no cap it keeps taking 2 s of some worker each time it returns. With a cap of 5 attempts it uses 10 s of worker time in all, then goes to the dead-letter queue for a person to look at.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a queue one worker cannot drain get drained? The queue leases each job to exactly one free worker, so capacity is the number of copies you start rather than a change to the code."
flowchart LR
    Prod["Producer"]:::ext
    Q[("Shared job queue")]
    subgraph Pool["Consumer pool — each job is leased to one member at a time"]
        C1["Worker 1"]
        C2["Worker 2"]
        C3["Worker 3"]
    end
    Prod -->|"1 enqueue job"| Q
    Q -->|"2 lease to whichever worker is free"| C1
    Q -->|"2"| C2
    Q -->|"2"| C3
    C1 -->|"3 process, then ack — the job leaves the queue"| Q
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Static pool** — A fixed number of consumer instances, sized for expected peak load. Simple to operate, wasteful when load is bursty.
- **[Partitioned / keyed consumption](./sequential-convoy.md)** — Messages are hashed to a partition or shard by key, and each partition is owned by exactly one consumer at a time — preserves per-key order while still spreading unrelated keys across the pool (Kafka partitions, Kinesis shards).
- **[Publish-Subscribe](./pubsub.md)** — Layer competing consumers under pub/sub: each subscriber group receives every message once, but the consumers inside a group compete for it — [fan-out](./fan-out.md) across groups, load-sharing within one.
- **Exclusive delivery via lease / visibility timeout** — The broker hides a delivered message from other consumers for a lease window; a consumer that crashes before acking lets it reappear for someone else to pick up.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Scales throughput horizontally** by adding consumer instances, with no producer changes.
- **Consumers hold no state between messages**, so any one can crash; its in-flight message is redelivered, so handlers must be idempotent.
- **The channel itself absorbs load spikes** as a buffer while the pool catches up, until its size or retention limit is reached; wait time grows with depth.
- **Failed processing just means the message goes back** for another consumer to try.

### Cons
<!--meta polarity=con-->

- **No ordering guarantee across the pool** — two related messages can be processed out of sequence by different consumers.
- **Most brokers give at-least-once delivery**, so a redelivered message must be handled safely, not processed twice — that is what [idempotency](./idempotency.md) is for.
- **A poison message that always fails** can bounce between consumers, burning capacity, until an attempt cap sends it to a [dead-letter channel](./dead-letter-channel.md).
- **Uneven message cost, or a large prefetch**, can leave one consumer holding a slow backlog while another sits idle.
- **Restoring order costs parallelism**: a partition key keeps related messages in sequence, and the partition count then becomes the ceiling on how many consumers can work at once.
- **A pool only widens the consumer side**. If the producer's bursts are what hurts, a [leveling queue](../distributed/resilience/load-leveling.md) in front is cheaper than a pool sized for the peak all day.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A single consumer can't keep up** with the rate messages arrive on a channel.
- **The work is naturally parallel** — messages don't depend on each other's outcome.
- **You want to scale processing capacity** by deployment, without touching the producer.

### Avoid when
<!--meta polarity=avoid-->

- **Messages must be processed in strict global order** — a single consumer, or per-key partitioning, fits better.
- **Every consumer needs to see every message** — that's fan-out, not sharing; reach for [Publish-Subscribe](./pubsub.md) instead.
- **Processing isn't safely repeatable** — redelivery under at-least-once delivery will corrupt state.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the whole idea: identical workers, one queue"
async function worker(queue: Queue) {
  while (true) {
    const job = await queue.receive();   // the queue picks one free worker
    if (!job) continue;                  // nothing waiting, ask again (back off or long-poll in practice)
    try {
      await handle(job);
      await queue.ack(job);              // done — it leaves the queue
    } catch {
      await queue.nack(job);             // put it back for a sibling to retry
    }
  }
}

// Capacity is the number of copies you start. Nothing here knows about the others.
for (let i = 0; i < workerCount; i++) worker(jobQueue);
```

```typescript summary="TypeScript — replicas claiming KYC tasks from one Postgres queue"
interface Task { id: string; flowId: string; type: "verify_id" | "check_list"; }
interface TaskQueue {
  claim(leaseMs: number, maxAttempts: number): Promise<Task | null>; // binds $1 and $2
  complete(id: string): Promise<void>;
  release(id: string): Promise<void>; // returns the task for another consumer
}
const claimSql = `
  UPDATE task SET status = 'processing', locked_at = now(), attempts = attempts + 1
  WHERE id = (
    SELECT id FROM task
    WHERE ((status = 'pending' AND run_after <= now())
        OR (status = 'processing' AND locked_at < now() - $1 * interval '1 millisecond')) -- $1 = leaseMs: reclaim an expired lease
      AND attempts < $2   -- $2 = maxAttempts: past the cap, leave the row for a dead-letter sweep
    ORDER BY run_after
    FOR UPDATE SKIP LOCKED       -- the whole pattern: a locked row is invisible
    LIMIT 1)
  RETURNING id, flow_id, type`;

async function runConsumer(queue: TaskQueue, handle: (t: Task) => Promise<void>) {
  while (true) {
    const task = await queue.claim(30_000, 5); // lease 30s, give up after 5 attempts
    if (!task) continue;                    // nothing waiting, poll again (back off or long-poll in practice)
    try { await handle(task); await queue.complete(task.id); } // done — leaves the queue
    catch { await queue.release(task.id); }                    // let a sibling retry it
  }
}
// N interchangeable replicas on the same table — capacity is replica count.
for (let i = 0; i < workerCount; i++) runConsumer(taskQueue, runKycStep);
```

## In the wild
<!--meta block=wild-->

- **Kafka consumer groups** — Partitions are divided among the consumers in a group so exactly one member reads each partition; a rebalance reassigns partitions when a member joins or leaves. The partition count is the hard ceiling on parallelism — consumers beyond it sit idle with nothing assigned. {#wild-kafka-consumer-groups}
- **Celery** — Python workers compete for tasks on a shared RabbitMQ or Redis broker, scaling by adding worker processes or raising --concurrency. worker_prefetch_multiplier controls how many tasks each worker reserves ahead of time, the knob that trades throughput against even distribution. {#wild-celery}
- **Sidekiq** — Ruby workers compete for jobs on shared Redis queues, each process running a pool of threads (concurrency) that pull with BRPOP. Because plain BRPOP removes the job before it is done, an in-flight job is lost if the process is killed; reliable fetch that re-queues interrupted jobs is a Pro/Enterprise feature. {#wild-sidekiq}
- **Amazon SQS** — Many workers poll one queue and each message goes to one worker at a time: a visibility timeout hides an in-flight message from sibling workers while it is processed and redelivers it if it expires first, a Lambda event source mapping polls the queue and invokes functions in batches, and a redrive policy moves a message to a dead-letter queue after maxReceiveCount failed attempts. {#wild-amazon-sqs}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Consumer count / concurrency** — The number of consumer instances or threads pulling from the channel — the primary throughput dial, changed by deployment rather than by code.
- **Prefetch / batch size** — How many unacked messages one consumer holds at a time (RabbitMQ basic.qos prefetch_count, Kafka max.poll.records), trading per-consumer throughput against how evenly work spreads.
- **Visibility timeout / lease** — How long a delivered message is hidden from the rest of the pool before it reappears (SQS VisibilityTimeout). Kafka's dial is different in kind: max.poll.interval.ms is a poll deadline whose breach costs the consumer its whole partition assignment, not one message.
- **Max delivery attempts** — The redelivery count after which a message is diverted to a dead-letter path (SQS maxReceiveCount).
- **Partition / shard count** — In a keyed model, the number of partitions — it fixes the ceiling on how many consumers in a group can work in parallel (Kafka partitions, Kinesis shards).

### Signals to watch
<!--meta polarity=signal-->

- **Queue depth / consumer lag** — Backlog waiting versus drain rate (Kafka consumer-group lag, SQS ApproximateNumberOfMessages) — the headline signal of whether the pool is keeping up.
- **Per-consumer throughput spread** — Distribution of completed work across instances; a wide spread means the sharing is not working, whatever the total says.
- **In-flight / unacked count** — Messages leased but not yet acked — a number that is high and stuck points at slow handlers or leaked leases.
- **Redelivery rate** — How often messages come back after a nack or a lease expiry — a proxy for handler failures and for duplicate work.
- **Dead-letter depth and arrival rate** — Messages that exhausted their attempts; every one is work that silently did not happen.

### Failure modes under load
<!--meta polarity=failure-->

- **Lease shorter than processing** — A visibility timeout below real processing time redelivers the message while the first consumer is still working on it, so two consumers do the same work and both may write.
- **Prefetch starvation** — A prefetch set too high lets one consumer pull the whole backlog into its buffer while its siblings sit idle, so adding instances stops adding throughput.
- **Idle consumers past partition count** — In a keyed model, consumers beyond the partition count get no partition assigned and sit idle no matter how deep the backlog is.
- **Poison message churn** — A message that always fails bounces through the pool, consuming a slot on every pass, until an attempt cap dead-letters it.
- **Rebalance stalls** — A member joining, leaving or missing its poll deadline triggers a reassignment, and consumption on the affected partitions pauses until it settles — frequent restarts turn this into steady-state lost throughput.

### Readiness checklist
<!--meta polarity=check-->

- Handlers are idempotent, and that was tested by replaying the same message rather than assumed
- The lease was set from an observed p99 processing time under load, not from a default
- Work distribution across the pool was watched with a full backlog, not only with an empty one
- A dead-letter path exists with an attempt cap, and its depth is alerted on
- In a keyed model, the partition count is at least the consumer count you plan to run
- Consumers shut down by finishing or releasing the message in hand, so a deploy does not manufacture redeliveries

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Streaming](../../themes/streaming.md) — Scale a stream across parallel workers {#fluency-streaming}
- [Scalability](../../themes/scalability.md) — Scale work across parallel consumers {#fluency-scalability}
- [Long-Running Tasks](../../themes/long-running-tasks.md) — Drain the queue with a pool of workers {#fluency-long-running-tasks}
- [Workload Composition](../../themes/workload-composition.md) — Turn a backlog into throughput by adding workers {#fluency-workload-composition}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md) — Many consumers drain the leveling queue
- [Publish-Subscribe](./pubsub.md) — Fan out to groups, share within a group
- [Idempotency](./idempotency.md) — Parallel consumers must handle redelivery
- [Fan-Out](./fan-out.md) — A queue per fan-out branch, each drained by a pool.
- [Dead Letter Channel](./dead-letter-channel.md) — A message that fails every attempt burns a pool slot on every pass until an attempt cap diverts it
- [Design to Scale Out](../../principles/scale-out.md) — Competing consumers is horizontal scale on the asynchronous path
- [Priority Queue](./priority-queue.md) — Split the pool per class when some work must clear before the rest
- [Sequential Convoy](./sequential-convoy.md) — Partition by category key when scaling out breaks the order a handler depends on
- [Resequencer](./resequencer.md) — Competing consumers give up message order, which a resequencer can rebuild afterwards
- [Polling Consumer](./polling-consumer.md) — Competing consumers often poll, so each worker takes work only when it has capacity
- [Web-Queue-Worker](../architecture/web-queue-worker.md) — The worker tier is the usual home for this: one queue, many identical consumers.
- [Producer-Consumer](../concurrency/producer-consumer.md) — The in-process base shape the competing workers share.
- [Splitter](./splitter.md) — A splitter is what turns one big message into the many that a pool can share.
- [Sweeper](../distributed/coordination/sweeper.md) — When the queue is a table, no broker returns an expired claim; a sweeper does.
- [Backpressure](../concurrency/backpressure.md) — A bigger pool raises the drain rate; backpressure still caps intake when the pool cannot keep up.

**Requires**

- [Message Queue](./message-queue.md) — Needs a queue to read from: the copies of the worker all pull from one shared queue

**Prevents**

- [Busy Front End](../../hazards/busy-front-end.md) — Gives offloaded work a throughput dial that does not touch the request path

**Exposed to**

- [Poison Message](../../hazards/poison-message.md) — Can fall into poison message when each redelivery ties up a worker and repeats the failure

**Demonstrated by**

- [Web Crawler](../../designs/web-crawler.md) — many stateless consumers draw from one queue, balancing load and surviving individual worker crashes
- [Facebook News Feed](../../designs/fb-news-feed.md) — scaling worker count against queue depth is exactly the competing-consumers throughput lever
- [LeetCode](../../designs/leetcode.md) — bursty grading work is spread across many identical workers draining one shared queue
- [YouTube](../../designs/youtube.md) — central processing unit (CPU)-bound transcode work fanned out across many equivalent consumers is the pattern in action
- [ChatGPT](../../designs/chatgpt.md) — pull-based workers draining a single queue is exactly how competing consumers scales throughput across a worker pool
- [Job Scheduler](../../designs/job-scheduler.md) — execution throughput to 10k/sec comes from many consumers pulling off one queue in parallel
- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — Know your customer (KYC) worker pools claiming tasks from a Postgres queue with SKIP LOCKED instead of a broker
- [Instagram](../../designs/instagram.md) — fan-out on write is drained by a worker fleet off one queue, so a millions-of-followers post spreads across machines instead of one
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — a claim whose lease turns a crashed consumer into the same case as an exhausted retry

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — The managed broker handles lease and redelivery.
- [Message brokers & streams](../../comparisons/message-brokers.md) — How each broker product shapes the consumer-scaling story.

<!-- relationships:end -->
