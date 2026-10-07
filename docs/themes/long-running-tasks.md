---
title: Long-Running Tasks
description: Moving slow work off the request path onto durable queues and workers
area: themes-data
owner: Oleksandr Derechei
tags: [messaging, asynchrony, throughput]
status: stable
aliases: [async jobs, background jobs]
---

# Long-Running Tasks

Work that's too slow to finish inside a request — transcoding a video, generating a report, sending a bulk campaign — accepted immediately with a job id and processed in the background by a pool of workers draining a durable queue. This theme is that pipeline, plus the failure handling that at-least-once processing demands.

## The question
<!--meta block=description-->

A profile fetch returns in 100 ms, but an annual PDF report takes close to a minute, past the 30 to 60 seconds most load balancers allow, and a user who sees a spinner retries and doubles the load. Split acceptance from processing: record a job, return an id at once, and let separate workers drain a durable queue. That buys redelivery, poison messages and backlogs, which the patterns here contain.

## Explained
<!--meta block=explain-->

When work takes longer than a web request can wait, accept the request, record a job, return a job id in milliseconds, and let a separate pool of workers take jobs from a durable [queue](../patterns/messaging/message-queue.md) (a list of jobs that survives a crash) and do them at their own pace. Without this, load balancers cut a request off after 30 to 60 seconds, and a user staring at a spinner clicks retry, which doubles the work. The work is not done when the call returns, so show job status and let users poll it. Choose this for genuinely slow work, and keep fast queries synchronous. Several workers pulling from one queue are [competing consumers](../patterns/messaging/competing-consumers.md), and the arrangement as a whole is [web-queue-worker](../patterns/architecture/web-queue-worker.md).

- **Twice-run jobs.** A worker can die mid-job, so the queue redelivers on lease expiry; give each job the same effect however often it runs (\[idempotency\](../patterns/messaging/idempotency.md)).
- **Poison messages.** A message that always fails retries forever, so move it to a \[dead-letter channel\](../patterns/messaging/dead-letter-channel.md) after a few attempts, with growing delays between them.
- **Backlog.** Spikes grow the queue faster than workers; cap length at drain rate times longest acceptable wait, and refuse new work with a clear error.

**Example.** An annual report takes 45 s to build, and the load balancer cuts requests at 30 s. The API now answers in 50 ms with a job id. 4 workers finish 4 reports per 45 s, about 5.3 a minute. At 9:00, 200 users click at once, so the backlog takes 200 / 5.3, about 38 minutes, to drain. With 12 workers it is 16 a minute and 12.5 minutes. One corrupt account fails 3 times, then goes to the dead-letter queue instead of looping. The queue is capped at 500 jobs, a 94-minute wait at 5.3 a minute, so set the cap from the longest wait users accept; the 501st request is refused.

## The tradespace
<!--meta block=tradespace-->

What you buy is decoupling: fast responses, fault isolation (a worker crashing on one job does not take down the API), and web servers and workers that scale on their own curves. What you pay is that the work is not done when the call returns. The system is eventually consistent, so a user may see old state until processing finishes. You also take on a queue to operate, job status to store and expose, and new metrics to watch: queue depth, the age of the oldest job, the dead-letter count and the age of the oldest in-progress claim. Async is not optional for slow work; what you choose is how much failure handling to build, because a naive queue-and-worker setup has sharp edges. Two more come from the order work is taken. A plain queue treats every job as equal, so a [Priority Queue](../patterns/messaging/priority-queue.md) lets urgent jobs go first at the price of starving the low class. And adding workers breaks per-entity ordering, so a [Sequential Convoy](../patterns/messaging/sequential-convoy.md) keeps each key's messages in order while different keys still run in parallel. Accepting a job is two writes, the job record and the enqueue; write them together, or have a sweeper re-enqueue records stuck in accepted. The [Job Scheduler](../designs/job-scheduler.md) case study works at-least-once firing through, and [LeetCode](../designs/leetcode.md) runs untrusted submissions as queued jobs.

A worker can die mid-job, so redelivery has to be at-least-once (a job is delivered one or more times). The same job can therefore run twice, so the work has to be idempotent. Some messages fail no matter how many times you retry; left alone they retry forever and can crash a whole worker fleet, so they need somewhere else to go. And demand does not respect your worker count: a spike can grow the queue faster than you can add capacity, so intake needs a way to push back. The choice of queue and worker runtime is secondary: Redis with Bull, Simple Queue Service (SQS), RabbitMQ or Kafka; plain servers, serverless functions or containers. It usually matters less than getting the failure handling right. Kafka is a partitioned log, so retries and dead-lettering are yours to build; see [Streaming](./streaming.md).

```mermaid caption="The web tier accepts and returns a job id immediately; workers drain a durable queue, completed jobs update status, poison messages divert to a dead-letter channel, and a backed-up queue pushes back on intake."
flowchart LR
    C["Client"] -->|"request"| W["Web tier: validate, enqueue, return job id"]
    W -->|"job id (ms)"| C
    W -->|"enqueue job"| Q[("Durable queue")]
    Q -->|"deliver job"| P["Worker pool drains at its own pace"]
    P -->|"succeeds"| S["Store result, mark job complete"]
    P -->|"keeps failing"| DL[("Dead-letter channel")]
    Q -.->|"depth too high"| B["Backpressure: reject new work"]
```

## Patterns that run work in the background
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Message Queue](../patterns/messaging/message-queue.md) {#tour-message-queue}

The durable buffer at the center of the pattern. The web tier enqueues a job — typically just an id, with the payload stored elsewhere — and returns immediately; the queue holds it safely until a worker is ready, so nothing is lost if a worker crashes between accept and process. It's what lets acceptance and processing run at their own independent rates.

### [Polling Consumer](../patterns/messaging/polling-consumer.md) {#tour-polling-consumer}

The consumer asks the queue for the next message only when it is free, so it sets its own pace and a burst waits in the queue.

### [Competing Consumers](../patterns/messaging/competing-consumers.md) {#tour-competing-consumers}

The [worker pool](../patterns/concurrency/thread-pool.md) that drains the queue. Point several identical, stateless workers at the same queue and let the broker hand each job to whichever is free; the broker hides a claimed job from the other workers while it is held, but if the claim lapses it redelivers, so one job can still run twice (see Idempotency below). Adding capacity for a backlog — month-end reports, a transcoding surge — becomes a deployment decision, not a code change.

### [Priority Queue](../patterns/messaging/priority-queue.md) {#tour-priority-queue}

A plain queue treats every item as equal, so a reset email waits behind ten thousand exports. The producer classifies each message and consumers take the urgent class first, with each class drained by its own pool of workers.

### [Idempotency](../patterns/messaging/idempotency.md) {#tour-idempotency}

The safety net for at-least-once processing. A worker can finish a job and die before reporting success, so the queue redelivers and a second worker re-runs it; without care that means two charges or two emails. An idempotency key per logical job — checked before the irreversible action — makes a redelivered job a no-op, provided the key is claimed atomically with the action and kept at least as long as the longest redelivery window, and is the same mechanism that collapses an impatient user's triple-click into one piece of work.

### [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) {#tour-load-leveling}

The queue framed as a shock absorber, not just a mailbox. Arrival is bursty; worker capacity — database throughput, a rate-limited downstream, a fixed pool — is comparatively fixed. Putting the queue between them turns a spike that would topple the workers into a managed backlog that drains over the following minutes, trading instant handling for reliable eventual handling.

### [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) {#tour-dead-letter-channel}

The escape hatch for jobs that will never succeed. A malformed payload or a code bug fails on every retry; left in place it wastes worker cycles, and a poison message can crash instance after instance. After a bounded number of attempts, route it to a separate channel where it can be inspected and replayed once fixed — keeping healthy work flowing past it.

### [Sequential Convoy](../patterns/messaging/sequential-convoy.md) {#tour-sequential-convoy}

Parallel consumers destroy order, since two workers can take consecutive events for one order at the same moment. Routing each entity's events to one consumer at a time restores the order and still scales across keys, though one hot key is limited to a single consumer, and a poison message then blocks its whole group, so it needs a dead-letter route.

### [Backpressure](../patterns/concurrency/backpressure.md) {#tour-backpressure}

The valve on intake. When a spike outpaces the workers, the queue can grow to millions of pending jobs, memory climbs, and wait times stretch to hours. Backpressure sets a depth limit and returns an immediate "system busy" rather than silently accepting work that can't be done in time — usually paired with [autoscaling](../patterns/distributed/routing/autoscaling.md) workers on queue depth, since by the time central processing unit (CPU) looks high the queue is already backed up. Set the depth limit from the drain rate times the longest wait a user accepts, and scale workers when the age of the oldest job passes a target.

### [Sweeper](../patterns/distributed/coordination/sweeper.md) {#tour-sweeper}

The recovery pass for the failure nothing reports. A worker that dies between claiming a job and finishing it throws no error. Where the queue has no lease timeout, or jobs are claimed by a status flag, nothing is redelivered either: the retry never fires, the dead-letter channel never sees it, and the job sits marked in-progress while its caller waits. A sweeper runs on a clock asking one question, which claims are older than the lease allows, and hands each answer back to the queue for another worker to take. Set the lease longer than the slowest job, or have the worker renew it while it works, or a live job is handed out twice.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Strategy | Reach for |
| --- | --- | --- |
| To move slow work off the request path so the API returns fast | Accept and defer | [Message Queue](../patterns/messaging/message-queue.md) |
| Urgent jobs stuck behind a flood of low-value work | Serve the urgent class first | [Priority Queue](../patterns/messaging/priority-queue.md) |
| To drain a backlog faster by adding capacity | Parallelize workers | [Competing Consumers](../patterns/messaging/competing-consumers.md) |
| To absorb bursts without toppling the workers | Buffer the rate mismatch | [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) |
| To stop a message that always fails from blocking or crashing workers | Quarantine after N attempts | [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) |
| To keep a traffic spike from growing the queue unbounded | Push back on intake | [Backpressure](../patterns/concurrency/backpressure.md) |
| One customer's jobs in order without dropping to a single worker | Order per key | [Sequential Convoy](../patterns/messaging/sequential-convoy.md) |
| Redelivered or duplicate jobs to stay correct | Same effect on every attempt | [Idempotency](../patterns/messaging/idempotency.md) |
| Jobs stuck in-progress after a worker died without reporting | Reclaim stale claims | [Sweeper](../patterns/distributed/coordination/sweeper.md) |
| Workers that set their own pace instead of being pushed work | Pull when free | [Polling Consumer](../patterns/messaging/polling-consumer.md) |

## Related areas
<!--meta block=siblings-->

- [Handling Spikes](./spike-handling.md) — A burst that outpaces the workers is a spike; load leveling and backpressure are how a queue turns one into a backlog instead of an outage.
- [Resilience](./resilience.md) — Redelivery, dead-lettering, idempotency, and backpressure are the resilience patterns that keep an async pipeline correct when workers and dependencies fail.
- [Streaming](./streaming.md) — Both push work through queues, but streaming keeps an unbounded, ordered flow moving continuously where this theme processes discrete jobs to completion.
