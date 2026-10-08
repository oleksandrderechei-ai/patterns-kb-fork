---
title: Web-Queue-Worker
description: "A web front end, a queue, and a worker that does the slow half"
area: architecture
owner: Oleksandr Derechei
tags: [messaging, asynchrony, decoupling]
status: stable
solves: [generating the report ties up the web request until the browser times out, our upload endpoint holds a thread for two minutes while it transcodes, page loads get slow whenever a big background job is running, adding more web servers does nothing for the long jobs, we need somewhere sensible to run nightly batch work]
---

# Web-Queue-Worker

Puts a queue between a stateless web front end and a back-end worker, so a request that starts a long job answers immediately and the slow work runs on machines you can scale on its own.

## What it is
<!--meta block=description-->

A request that renders a video or calls three slow services holds a web thread for minutes, and 20 ms requests queue behind it. Split the application in two along the axis of time. A web front end answers requests quickly and writes slow jobs onto a queue, and a worker takes them off when it has room. Each half scales on its own rule.

## Explained
<!--meta block=explain-->

Web-queue-worker splits an application by speed. A web front end answers requests quickly. When a request needs slow work, it writes a job onto a queue and returns at once, and a separate worker takes jobs off the queue when it has room. Both halves are stateless, with session state in a shared cache, so any instance can serve any request and a restart loses no session state. The queue is the one new moving part, so choose it over one process doing everything when some requests take seconds or minutes while most take milliseconds, and over [microservices](microservices.md) when one team owns a simple domain. The worker is optional, and when the slow work already sits behind a function boundary, adding it later is a move, not a rewrite.

- **Answers are no longer immediate.** Give every job a status the client can poll.
- **Job row and message can split.** A crash between them loses the job, so commit both with an [outbox](../distributed/coordination/outbox.md).
- **At-least-once delivery.** A worker that charges a card must recognise a job it already ran, for instance by job ID.
- **Backlog can outlive retention.** Watch the backlog against the queue's retention window.

**Example.** A web front end has 100 threads and serves 20 ms requests. Report exports take 90 s, and at peak 2 a second arrive for 60 s. Done inside requests, 2 a second for 90 s each is 180 threads of demand against 100, so the pool is full from about 50 s in and later requests fail. With a queue, the front end returns a job ID in 20 ms. The 120 jobs go to 20 worker slots, which finish them in 120 divided by 20, times 90 s, so 540 s, or 9 minutes. The cost is that a customer waits up to 9 minutes and polls the status, and a worker that crashes mid-job runs it again.

## How it works
<!--meta block=structure-->

```mermaid caption="What does the browser wait for? Step 5 only — the queue accepting the job. Steps 6 and 7 run on the worker's own clock and its own machines, so a ten-minute render never occupies a web thread."
flowchart LR
    Client["Browser or app"]
    subgraph FEU["Front-end scaling unit"]
        Web["Web tier — stateless"]
    end
    Cache[("Session + hot data cache")]
    Q[("Queue")]
    subgraph BEU["Worker scaling unit"]
        Worker["Worker — stateless"]
    end
    DB[("Database")]
    Client -->|"1 request"| Web
    Web -->|"2 session state, kept out of memory"| Cache
    Web -->|"3 short reads and writes"| DB
    Web -->|"4 enqueue the slow job"| Q
    Web -->|"5 accepted, here is a status link"| Client
    Q -->|"6 dequeue when a slot is free"| Worker
    Worker -->|"7 write the result"| DB
```

```mermaid caption="The row and the message are two writes, and a crash between them leaves a job nobody will ever run. Committing them together is what closes that window."
sequenceDiagram
    autonumber
    participant C as Client
    participant W as Web tier
    participant DB as Database
    participant Q as Queue
    participant K as Worker
    C->>W: POST /reports
    W->>DB: insert report row, state = queued
    alt enqueue succeeds
        W->>Q: enqueue job
        W-->>C: 202 Accepted + status URL
        Q->>K: deliver when a slot frees
        K->>DB: write result, state = done
    else crash after the row, before the enqueue
        W--xQ: message never sent
        Note over DB,K: the row stays queued forever, and nothing is retrying it
    end
```

## Variations
<!--meta block=variations-->

- **Queue as a shock absorber** — Size the worker pool for the average rate rather than the peak and let the queue hold the difference — [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md). A spike then costs a longer wait instead of a wall of errors, provided the backlog drains before anyone gives up.
- **[Competing Consumers](../messaging/competing-consumers.md) on one queue** — Run many identical workers against the same queue and let each take the next free message. Throughput scales by adding workers, and no dispatcher has to decide who gets what.
- **Timer-driven worker** — Trigger the worker on a schedule instead of on a message when the work is a nightly rebuild or an hourly reconciliation. See [Scheduling](../concurrency/scheduling.md) for the trigger side; the rest of the shape is unchanged.
- **Telling the client the answer** — Return a status URL the client polls, or push a notification when the job finishes — [Asynchronous Request-Reply](../distributed/routing/async-request-reply.md). Polling is trivial to build and wastes requests; a push needs a connection you keep open and a fallback for when it drops.
- **Separate lanes per job class** — Give the nightly export its own queue and its own workers rather than sharing with interactive jobs. One eight-hour job on a shared queue occupies slots that password-reset emails were waiting for, and the symptom looks like an email outage.
- **Enqueue inside the transaction** — Write the outgoing message to a table in the same transaction as the state change and let a relay publish it — the [Outbox](../distributed/coordination/outbox.md). It costs a relay and a table, and it removes the one failure that leaves a row waiting on a job that was never queued.
- **Front end with no worker** — Not every application has long-running work, and not every write needs the queue. Let the front end read and write directly on the fast paths and reserve the queue for work that is genuinely resource-intensive; routing everything through it adds a hop and a consistency window for nothing.
- **A store per kind of data** — The front end's session state, the worker's job records and the reporting history have different access shapes, and one database chosen for all three fits none of them well. Give each the store its access pattern asks for. The cost is a second technology to operate, back up and staff, which is why this waits until one of the three is actually hurting.
- **Swap, don't overwrite** — Deploy the new version alongside the running one, check it, then move traffic across in one step — [Blue-Green Deployment](../distributed/routing/blue-green-deployment.md). Going back is another swap rather than another deploy, which is what makes a bad release a two-minute problem. Size for it: both versions run at once during the switch.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Two components and one queue** — a new engineer can hold the whole architecture in their head on the first day.
- **Front end and worker scale on separate signals**, so request rate and job backlog stop competing for the same machines.
- **A slow or failing job** no longer holds a web thread, so page latency stays flat while the backlog drains.
- **The queue absorbs spikes**: arrivals above what the worker pool can process become a longer wait rather than a wall of errors.
- **A worker crash returns the message to the queue** after the lease expires, so the job is retried without custom code, provided the handler is idempotent.

### Cons
<!--meta polarity=con-->

- **Both halves grow into monoliths** unless someone keeps pruning them. This is the defining risk of the style, and nothing in the shape prevents it.
- **Shared code modules** and a shared schema between front end and worker recreate exactly the coupling the queue was there to remove.
- **The answer is no longer immediate**, so every long job needs a state for "still running" and a way for the client to find out how it went.
- **Writing the row** and sending the message are two operations. A crash between them leaves work that will never run, and only committing them together closes the gap.
- **Delivery is at-least-once in practice**, so a worker that charges a card or sends an email has to recognise a job it has already run.
- **The queue is a component** with its own failure modes and its own bill. A backlog that outgrows the retention window drops work silently, which is worse than the synchronous timeout it replaced.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Some requests trigger work measured** in seconds or minutes — encoding, rendering, report generation, a call to a slow third party.
- **The domain is simple enough** that one team owns all of it, and you want the smallest architecture that survives real traffic.
- **You run batch or scheduled work** and have nowhere sensible to put it.
- **Load arrives in spikes**, and you would rather queue the peak than provision for it.

### Avoid when
<!--meta polarity=avoid-->

- **Every operation is fast**, and the queue would add a hop and a consistency window for nothing.
- **The caller genuinely needs the result** in the same response and cannot be given a status link.
- **Several teams already block each other** at release time — the split you need is by capability, which is [Microservices](./microservices.md), not by fast and slow.
- **The work is a continuous stream** that has to be handled as it arrives rather than as discrete jobs; that is [Event-Driven Architecture](./eda.md) territory.

Answers the [Busy Front End](../../hazards/busy-front-end.md) smell — background work stuffed into request threads, where it competes with the users who are waiting.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the endpoint returns in milliseconds; the worker takes the minutes"
// FRONT END — accept, record, enqueue, answer. No rendering happens here.
app.post("/reports", async (req, res) => {
  const jobId = crypto.randomUUID();
  await db.insert("reports", { id: jobId, state: "queued", spec: req.body });
  await queue.send({ jobId });                 // crash between insert and send orphans the row: see the outbox
  res.status(202)
     .location(`/reports/${jobId}`)            // where the client checks back
     .json({ jobId, state: "queued" });
});

// The client polls this; it is a cheap read, not a wait.
app.get("/reports/:id", async (req, res) => {
  const row = await db.find("reports", req.params.id);
  res.json({ jobId: row.id, state: row.state, url: row.resultUrl ?? null });
});

// WORKER — a separate process on separate machines, scaled on backlog.
for await (const msg of queue.receive({ concurrency: 4 })) {
  const row = await db.find("reports", msg.jobId);
  if (row.state === "done") { await msg.ack(); continue; }  // no-op once done; concurrent duplicates need a claim step

  try {
    // renew the message lease while this runs, or a slow job is redelivered to a second worker
    const url = await renderReport(row.spec);   // minutes, and nobody is holding a socket
    await db.update("reports", row.id, { state: "done", resultUrl: url });
    await msg.ack();
  } catch (err) {
    await db.update("reports", row.id, { state: "failed", error: String(err) });
    await msg.nack();                           // back to the queue, then to the dead-letter queue
  }
}
```

## In the wild
<!--meta block=wild-->

- **Celery** — The Python task queue: decorate a function as a task, call it with `.delay()`, and the message goes to a broker such as RabbitMQ or Redis while separate worker processes execute it. `celery beat` covers the scheduled half of the style, firing periodic tasks onto the same queues. {#wild-celery}
- **Sidekiq** — Ruby background job processing on Redis. `perform_async` enqueues from the web process, worker processes run jobs with a configurable concurrency, and a job that keeps raising is retried on a backoff schedule before it is parked in the dead set for a human to look at. {#wild-sidekiq}
- **BullMQ** — A Node job queue on Redis: a `Queue` produces jobs and a `Worker` consumes them at a set concurrency, with delayed jobs, repeatable jobs on a cron expression, and a failed set for the ones that exhausted their attempts. {#wild-bullmq}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Worker concurrency** — How many jobs one worker instance runs at once. Raise it until CPU, memory or a connection pool saturates before the slots do. Total slots needed is about arrival rate times mean job duration.
- **Message lease (visibility timeout)** — How long a message stays invisible after a worker takes it. Set it above the job p99 duration plus the worst pause, or renew it by heartbeat. Shorter, and a second worker starts the same job while the first is still running.
- **Autoscaling target on backlog** — Scale workers on queue depth or backlog per worker, not on CPU. A worker blocked on a slow third party shows almost no CPU while the backlog is growing.
- **Max delivery attempts and dead-letter destination** — How many times a failing message is retried and where it goes afterwards. Delay each retry, and keep attempts times (lease plus backoff) inside the retention window. Without a terminus, one bad message recirculates forever and consumes a slot each time.
- **Prefetch or batch size** — How many messages a worker holds at once. A large prefetch smooths throughput and makes a crash return a larger clump of work for redelivery.

### Signals to watch
<!--meta polarity=signal-->

- **Queue depth and age of the oldest message** — Depth tells you the backlog; age tells you how long the unluckiest job has waited. Age is the one that maps to a promise you made a user.
- **Front-end p99 latency** — It should stay flat while the backlog grows. The moment it tracks the backlog, work has leaked back into the request path.
- **Job duration distribution** — The p50 and p99 of processing time, which is what the lease and the autoscaling target both have to be sized from.
- **Workers busy versus idle** — The share of slots occupied. Consistently full slots with a growing backlog means the pool is undersized; consistently idle means you are paying for capacity the queue never uses.
- **Dead-letter count** — Messages that exhausted their attempts. A rising count is work silently not happening, and nobody upstream gets an error about it.

### Failure modes under load
<!--meta polarity=failure-->

- **Backlog outgrows the drain rate** — Arrivals exceed processing long enough that the wait crosses what users tolerate. If it crosses the retention window, messages are dropped with no error anywhere.
- **Duplicate execution after a lease expiry** — A job runs longer than its lease, the message becomes visible again, and a second worker starts it while the first is still going. The user sees two emails or two charges.
- **Poison message** — One message fails on every attempt and cycles through retries, occupying a slot each pass until something sends it to the dead-letter queue.
- **Starvation by a heavy job class** — A long batch export fills every worker slot, and the two-second jobs sharing that queue wait behind it. The symptom looks like an outage in the small jobs.
- **Orphaned rows from the split write** — The front end committed the row and crashed before the enqueue, so a job sits in the queued state with nothing scheduled to run it. It surfaces as work that quietly never happened.

### Readiness checklist
<!--meta polarity=check-->

- Handlers are idempotent — a repeat delivery of the same job id changes nothing
- Every queue has a dead-letter destination and an alert on its depth
- The message lease exceeds the p99 job duration, or the worker renews it while running
- Workers autoscale on backlog rather than on CPU
- Session state and job state live outside the process, so any instance can be replaced mid-flight
- Jobs longer than the lease are checkpointed or split, so a restart does not repeat an hour of work
- The front end and the worker share no code module and no schema they both write
- Hot write tables partition on a key that spreads writes, so one job class cannot serialize behind a hot row range.
- A sweeper re-enqueues rows still queued past an age set from the slowest normal queue wait (oldest-message age).

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Twelve-Factor](../../themes/twelve-factor.md) — Long work as its own process type {#fluency-twelve-factor}
- [Architecture Styles](../../themes/architecture-styles.md) — Put the slow work behind a queue {#fluency-architecture-styles}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md) — The queue is not just a hand-off; it absorbs bursts so the worker keeps a steady rate under a spiky front end.
- [Outbox](../distributed/coordination/outbox.md) — Closes the gap where the front end commits to the database and then fails before enqueuing, leaving work nobody will do.
- [Stateless Service](../distributed/routing/stateless-service.md) — Both halves keep no per-client state, so either can be scaled or replaced without draining anything first.
- [Asynchronous Request-Reply](../distributed/routing/async-request-reply.md) — The front end answers 202 with a status link, so the caller can still learn when the queued job finished.
- [Blue-Green Deployment](../distributed/routing/blue-green-deployment.md) — Front end and worker ship as one unit, so validate the new pair beside the running one and switch once it passes.
- [Competing Consumers](../messaging/competing-consumers.md) — Scaling the worker means several instances pulling from one queue; each message goes to one worker at a time and may be redelivered.

**Alternative to**

- [Microservices](./microservices.md) — When the domain outgrows two components and teams need to ship on their own schedule, this is the next step.
- [Event-Driven Architecture](./eda.md) — Discrete jobs behind one queue fit here; a continuous stream handled as it arrives is Event-Driven Architecture.

**Prevents**

- [Busy Front End](../../hazards/busy-front-end.md) — The slow half of the work moves to a worker tier behind a queue, so the front end only answers requests

<!-- relationships:end -->
