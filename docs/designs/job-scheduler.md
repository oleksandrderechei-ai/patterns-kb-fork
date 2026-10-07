---
title: Job Scheduler
description: "Fire 10k jobs a second within two seconds of their scheduled time, at least once, even when workers crash mid-run"
area: designs-advanced
owner: Oleksandr Derechei
tags: [scalability, asynchrony, durability, latency]
status: stable
aliases: [task scheduler, cron service, distributed scheduler]
solves: [I need to run thousands of tasks at exact future times and they keep firing a minute or two late, my recurring reminders work but finding which ones are due right now means scanning every row, when a worker crashes mid-task nobody retries the work and it silently never runs, a flaky task got retried and the same email went out to the customer three times, all of this hour's writes pile onto one database partition and it falls over under load]
---

# Job Scheduler

A job scheduler stores what to run and when, then makes sure each job fires close to its scheduled time — under heavy load and through worker failure. A task is the reusable unit of work ("send an email"); a job is one scheduled instance of it. The whole design turns on two separations: keeping durable job definitions apart from their execution instances, and keeping the durable database poll apart from precise, queue-driven execution.

## Understanding the problem
<!--meta block=description-->

A job scheduler runs each job at its appointed time, at a future date or on a repeating cadence, behind reminders, nightly batches and maintenance sweeps. Jobs must fire close to their due time at high volume, and each must run at least once even when its machine dies mid-job.

## Explained
<!--meta block=explain-->

A job scheduler runs each job within 2 seconds of its due time and at least once, even when a worker dies mid-run. Two moves do it. Every due run is stored as its own row, apart from the job's definition, in a table split by hour. A cheap database check every 5 minutes copies the coming runs into a queue that hides each message until its due second. Workers pull from that queue, and a message a crashed worker never confirmed becomes visible again. Choose this over one loop that polls the database every 2 seconds, which sweeps tens of thousands of rows each time. Failed runs retry after 5, 25 and 125 seconds, then go to a dead-letter queue.

- **Double runs.** A run can happen twice, so make each task safe to repeat, such as setting a value, not adding to it.
- **Hot partition.** One hour of rows lands on a single partition, so spread those writes across several.
- **Queue dependency.** A managed queue does the delay and retry for you, so a self-hosted version must build both.

**Example.** At 10,000 runs a second, each 5-minute check loads 10,000 times 300 s, which is 3 million messages of about 200 bytes, so about 600 MB. A run due at 10:03:20 is read at 10:00 and queued with a 200 s delay. At 10:03:20 a worker takes it, and at 10:03:21 the worker crashes before confirming. The message becomes visible again and another worker runs it. The cost is a possible double run, so a money transfer in that task would pay twice unless it carries an idempotency key, a unique label that makes the second attempt a no-op.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Schedule a job to run immediately, at a future date, or on a recurring schedule (a CRON expression such as `0 10 * * *`).
2. Monitor the status of one's own jobs — which have run, which are pending, which failed.

Out of scope: cancelling and rescheduling jobs, security-policy enforcement, and CI/CD (continuous integration and continuous delivery)-style pipelines — named explicitly so the core stays narrow.

### Non-functional
<!--meta requirement=nfr-->

- **Precision** — a job fires within 2&nbsp;seconds of its scheduled time.
- **Durability** — **at-least-once** execution; a job is never silently dropped, even if a worker crashes.
- **Availability** — favoured over strict consistency; a briefly stale status view is fine, a missed run is not.
- **Scale** — up to **10k jobs/sec** at execution time.

## Right-sizing
<!--meta block=sizing-->

**Throughput.** The target is 10k executions/sec at peak. Creates run lower — a recurring job is written once but fires many times — so the execution path, not the create path, sets the budget.

**Queue depth.** If the scheduler looks 5&nbsp;minutes ahead, a full window holds 10k/sec × 300&nbsp;s ≈ **3&nbsp;million** in-flight jobs. Each queued message is an id, an execution time and a little metadata, about 200 bytes, so the window is about **600&nbsp;MB**. Per-message size is far under a managed queue's size cap, and the window fits its throughput.

**Write budget.** 10k execution rows a second, plus status updates on each. A single database partition sustains only so many writes per second (on DynamoDB, ~1,000 write units), so an hour of executions cannot land on one partition — the spread across partitions is a design constraint, not an afterthought.

**Retention.** Executions accumulate forever if untouched; age rows past ~a year into cheap [object storage](../patterns/distributed/routing/object-storage.md) so the hot tables stay small.

## Core entities
<!--meta block=entities-->

Four conceptual entities, with a fifth that the storage model forces into the open:

- **Task** — the reusable definition of work ("send an email"), parameterised and carrying no schedule of its own.
- **Job** — one task bound to a schedule and a set of parameters; the thing a user actually creates ("send email to john<!-- -->@example.com every Friday at 10:00").
- **Schedule** — either a one-shot `DATE` or a recurring `CRON` expression; it decides when a job's next run is due.
- **Execution** — a single due run of a job at one instant, with its own `status` and `attempt` count. It is what workers actually process, and separating it from the job definition is the pivotal modelling call (see below).
- **User** — owns jobs and queries their status.

## The interface
<!--meta block=interface-->

Two operations cover both functional requirements — one to schedule, one to observe:

```http summary="HTTP — schedule a job and query status"
POST /jobs
{ "task_id": "send_email",
  "schedule": "0 10 * * *",
  "parameters": { "to": "john@example.com", "subject": "Daily Report" } }
→ 202 { "job_id": "job_8f21" }        # stored PENDING, first execution enqueued

GET /jobs?user_id={id}&status={status}&start_time={t0}&end_time={t1}
→ 200 Execution[]                            # this user's executions, filtered and paged
```

Create returns **202 Accepted**, not 200: the job is durably recorded, but its actual run happens later and asynchronously.

## How the system is built
<!--meta block=architecture-->

The store is a horizontally scalable key-value database (DynamoDB, or Cassandra for open-source shops) rather than a relational one — there are few relationships and no need for strong consistency, so easy partitioning matters more than joins. The pivotal move is to **split the job definition from its execution instances**, exactly as a calendar keeps a recurring event separate from each occurrence. A **Jobs table** holds the definition (partitioned by `job_id`: `user_id`, `task_id`, `schedule`, `parameters`). An **Executions table** holds one row per due run, partitioned by a `time_bucket` — the execution time rounded down to the hour, `(t // 3600) * 3600` — with the exact `execution_time` plus `job_id` as the sort key. Bucketing by hour means "what's due soon?" touches only one or two partitions instead of scanning every CRON expression in the system. When a recurring job's run completes, the scheduler writes its next execution row; the definition never changes.

Reads come in two shapes. Workers ask "which executions are due in the next few minutes and still `PENDING`?" — served straight off the time-bucketed partition. Users ask "how are my jobs doing?" — served by a global secondary index on the Executions table keyed by `user_id` then `execution_time`, so per-user listing, filtering and paging never scan the base table. Execution then runs in two phases, described in the deep dives: a low-frequency database poll feeds a [delay queue](../patterns/messaging/message-queue.md), and a fleet of workers pulls jobs off it as they come due.

```mermaid caption="The scheduler poll (every 5 min, low database load) is decoupled from execution (workers drain the queue as fast as jobs become visible). Near-term jobs skip the poll and go straight to the queue."
flowchart TB
    Client["Client"]
    API["Job service"]
    Jobs[("Jobs table · definitions")]
    Execs[("Executions table · instances")]
    Cron["Scheduler · polls every 5 min"]
    Queue["Delay queue · SQS"]
    Workers["Worker fleet"]
    DLQ["Dead-letter queue"]
    Client -->|"POST /jobs"| API
    API -->|"write definition"| Jobs
    API -->|"write first execution"| Execs
    API -.->|"due in under 5 min"| Queue
    Cron -->|"read due executions"| Execs
    Cron -->|"enqueue with delay"| Queue
    Queue -->|"visible at run time"| Workers
    Workers -->|"execute + update status"| Execs
    Workers -.->|"retries exhausted"| DLQ
    Client -->|"GET /jobs?status"| API
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Firing within two seconds — the two-phase scheduler

In a single-loop design, the poll frequency is the precision ceiling: poll every two minutes and jobs land up to two minutes late. Polling every two seconds to hit the target is worse than it sounds — at 10k/sec each query would sweep ~20k rows across a two-second window, and even an indexed read of that size, plus network and serialisation, can burn hundreds of milliseconds and keep the database under constant heavy load. So split the concern in two. **Phase one** polls the Executions table every few minutes for everything due in the next ~5 minutes — cheap, infrequent, database-friendly. **Phase two** hands those jobs to a queue that only makes each one visible at its exact run time; workers pull and execute the instant it appears. The poll cadence no longer caps precision.

The queue's one hard requirement is delayed visibility. A strictly-ordered log like Kafka fails here: a newly created urgent job would queue behind everything already buffered and miss its window. Three options deliver deferred delivery. A **Redis sorted set** scores entries by timestamp and pops those with `score < now` — sub-millisecond, but you build retries, failure handling and replication yourself. **RabbitMQ** can fake it with per-message TTL (time to live) plus a dead-letter exchange, but high availability needs quorum queues and the TTL trick is fiddly. **Simple Queue Service (SQS)** wins for a managed stack: `DelaySeconds` gives native per-message delay (capped at 15 minutes, which comfortably covers the 5-minute lookahead), visibility timeouts recover from worker failure, and it auto-scales across availability zones. Jobs created with under 5 minutes of lead time skip the poll entirely and go straight to the queue with the right delay. Workers form a pool of [competing consumers](../patterns/messaging/competing-consumers.md), each message handled by exactly one of them. The lookahead must be longer than the poll interval, up to the 15-minute DelaySeconds cap, so one missed poll drops nothing. The poller marks each row as queued as it enqueues it, so an overlapping window never enqueues a row twice.

The two phases meet at a queue that holds each job invisible until its run time.

```mermaid caption="How does a job fire at its exact time when the database is only polled every few minutes?"
sequenceDiagram
    participant Sch as Scheduler
    participant Ex as Executions table
    participant Q as Queue (SQS)
    participant W as Worker
    Sch->>Ex: poll every few minutes, due in next ~5 min
    Ex-->>Sch: due executions
    Sch->>Q: enqueue, visible only at run time
    Q-->>W: message becomes visible at run time
    W->>W: execute the job
```

### 2 · Scaling the pipeline to 10k jobs a second

Work left to right and fix bottlenecks one at a time. **Creates** peak below 10k/sec (recurring jobs write once, fire often); the [stateless service](../patterns/distributed/routing/stateless-service.md) tier scales out and the database absorbs the writes directly, so a buffering queue in front of creation is tempting but usually over-engineering — keep it simple until the write path actually strains. **The Jobs table** scales cleanly: partitioned by `job_id`, writes spread evenly. **The Executions table** is the real hazard: partitioning by hourly `time_bucket` concentrates a whole hour of writes on a single partition — a classic [hot partition](../hazards/hot-key.md). The fix is [write sharding](../patterns/distributed/routing/sharding.md): append a random suffix to the key (`time_bucket#shard_3`) to fan writes across N partitions, and have the poller query all shards for a bucket in parallel. Old executions age out to object storage after ~a year.

The queue side barely needs attention — 3 million messages a window at a couple hundred bytes each is well within a standard SQS (Simple Queue Service) queue's throughput, and it distributes across consumers automatically, so extra queues would only ever be for functional separation (priority, job type), not scaling. That leaves the **workers**. Serverless functions auto-scale instantly and suit short jobs, but cold starts can blow the 2-second budget and cost more at steady high volume. Long-lived containers on Elastic Container Service (ECS) or Kubernetes are more cost-effective for a predictable 10k/sec load and hold state between runs; the price is more operational overhead. Containers win here — with [autoscaling](../patterns/distributed/routing/autoscaling.md) driven by queue depth, a pre-warmed baseline pool for steady load, and spot instances to trim cost.

### 3 · Running each job at least once

At-least-once means two failure modes must both be caught. A **visible failure** — a bug or bad parameters — surfaces as an exception: wrap the task, log it, mark the execution `RETRYING` with its attempt count, and re-enqueue with [exponential backoff](../patterns/distributed/resilience/retry-backoff.md) (5s, 25s, 125s) by raising `DelaySeconds` per attempt. After a bounded number of tries the row goes `FAILED` and the message lands in a [dead-letter queue](../patterns/messaging/dead-letter-channel.md) for inspection rather than looping forever. An **invisible failure** — the worker itself dies before reporting anything — is harder, because nothing raises. Polling health-check endpoints does not scale to thousands of workers and invents its own single point of failure. A database lease works: a worker writes its id and an expiry onto the execution and renews it while running, so an expired lease lets another worker retry — but at 10k/sec each run still live needs a renewal write at least once per 5-second lease, on top of its start and finish writes, so write load grows with run length, plus clock-skew and partition edge cases. The cleanest answer reuses the queue's own [lease](../patterns/distributed/coordination/distributed-lock.md) semantics: an SQS message goes invisible when received and reappears automatically if the worker never deletes it, and a periodic `ChangeMessageVisibility` heartbeat extends ownership for long jobs — recovery in ~30 seconds with no extra infrastructure.

At-least-once has a corollary the caller must honour: because a job can run more than once, task code has to be [idempotent](../patterns/messaging/idempotency.md). Executing blindly is dangerous — a retried money transfer moves funds twice. A deduplication table keyed by `job_id` + execution time works but adds a read-before-write and needs pruning. Best is to design the task so repetition is harmless: use an idempotency key with conditional operations ("set the counter to X", not "increment"; check a "welcome email sent" flag before sending), pushing the guarantee down into the work itself.

```mermaid caption="What states does one execution move through under at-least-once? Both a crash and an exception route back through Retrying; the two finished states are Done and the dead-lettered Failed."
stateDiagram-v2
    [*] --> Pending: execution row written
    Pending --> Running: worker pulls from delay queue
    Running --> Done: task succeeds
    Running --> Retrying: throws, or lease expires (worker died)
    Retrying --> Running: re-enqueued with backoff
    Retrying --> Failed: attempts exhausted
    Done --> [*]
    Failed --> [*]: moved to dead-letter queue
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Precision decoupled from database load: an infrequent poll feeds a delay queue, so 2-second firing survives 10k jobs/sec.
- "What's due soon?" and "how are my jobs?" are both cheap — one via time-bucketed partitions, the other via a per-user index.
- Worker crashes self-heal: an unacknowledged message reappears, and bounded backoff plus a dead-letter queue contain poison jobs.

### What it gives up
<!--meta polarity=con-->

- At-least-once pushes idempotency onto every task author; a non-idempotent job will eventually double-execute.
- The hourly execution partition is a hot spot that only write-sharding tames — and sharding then forces fan-out reads across every shard.
- Leaning on a managed queue (SQS `DelaySeconds`, visibility timeouts) buys simplicity at the cost of portability; a self-hosted stack must rebuild delay, retries and leasing by hand.
- Late recovery. A run recovered after a crash fires about 30 seconds after it was lost, and a retry waits 5, 25 or 125 seconds. The 2-second bound covers first attempts only.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a coherent high-level design with a clean data model, and sensible responses when prompted on durability, precise timing, and retries. Reaching every answer unaided is not expected; collaborating toward reasonable ones is.
- **Senior** — drives the conversation through two deep dives, and articulates the need for a two-phase scheduler (database poll plus delay queue) unprompted — even if choosing Redis or another queue over SQS. Surfaces "what if a worker dies mid-job?" without being asked.
- **Staff+** — moves briskly through setup and high-level design to spend the time leading deep dives, names the hot-partition and idempotency bottlenecks early, and justifies each trade-off from hands-on experience with the tech.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Hot Key](../hazards/hot-key.md) — the current hour's execution partition takes every write for that hour until it is suffix-sharded

**Demonstrates**

- [Message Queue](../patterns/messaging/message-queue.md) — a delay queue makes each job visible only at its exact run time, decoupling the durable database poll from precise execution
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — a fleet of interchangeable workers drains the shared queue, each job handled by exactly one of them
- [Idempotency](../patterns/messaging/idempotency.md) — at-least-once delivery forces task code to be safe to run more than once via idempotency keys and conditional writes
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — failed executions are re-enqueued with growing DelaySeconds (5s, 25s, 125s) before being given up on
- [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) — jobs that exhaust their retry budget move to a dead-letter queue instead of looping forever
- [Sharding](../patterns/distributed/routing/sharding.md) — write-sharding the hot hourly execution partition fans a whole hour of writes across many partitions
- [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) — each in-flight job is leased via Simple Queue Service (SQS) visibility timeout plus a heartbeat, so a crashed worker's job auto-releases
- [Autoscaling](../patterns/distributed/routing/autoscaling.md) — the worker pool scales on queue depth, with a pre-warmed baseline and spot instances for spikes
- [Scheduling](../patterns/concurrency/scheduling.md) — a job runs at its appointed time or on its CRON cadence rather than when it was submitted, which is the entire surface of the design
- [Object Storage](../patterns/distributed/routing/object-storage.md) — Execution rows older than about a year age into cheap object storage so the hot tables stay small
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — The create path is a stateless tier that scales out while the database absorbs the writes directly

<!-- relationships:end -->
