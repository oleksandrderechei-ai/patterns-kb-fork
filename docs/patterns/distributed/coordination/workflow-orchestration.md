---
title: Workflow Orchestration
description: Run a long multi-step process as durable code that survives crashes by replaying its history
area: distributed-coordination
owner: Oleksandr Derechei
tags: [coordination, state-management, error-handling]
status: stable
aliases: [durable execution, process manager, orchestrator, scheduler agent supervisor]
solves: [a multi-step process keeps half-completing when a server crashes partway through, "I am hand-rolling retries, timeouts, and persisted state for a long-running workflow", coordinating steps across several services by hand is error-prone and I cannot see where a run is stuck, my process needs to pause for days waiting on a human or a webhook and then continue, the recovery logic for a crashed batch job is scattered across cron scripts and manual runbooks]
favourite: true
---

# Workflow Orchestration

An engine runs a long-running, multi-step process as durable code, persisting the result of every step so that a crash resumes from where it left off — by replaying the recorded history rather than starting over. The engine owns state, retries, timeouts, and compensation; you write the happy path.

## What it is
<!--meta block=description-->

A server that charges the card, reserves stock and books a courier can restart halfway, and nothing remembers what already ran. A workflow engine saves the result of every step as it finishes. A new worker then replays the code, finished steps return their saved results, and the process continues, so no recorded step is lost or repeated.

## Explained
<!--meta block=explain-->

A workflow engine runs a long, multi-step process as code and saves the result of every step as it finishes. If a worker crashes or is redeployed halfway, a new worker reruns the code from the top, each finished step returns its saved result instead of running again, and the process carries on from the crash point. No step is lost and a recorded step never repeats; the step in flight at the crash can run again, so make it idempotent. Waiting for a human or a partner holds no worker or thread, because between steps the process is just a stored record. Choose it when many flows share the same needs for saved progress, retries and timers, and you would otherwise build them around every process. For a few simple flows, a state machine saved in your own database is cheaper.

- **Deterministic code.** Replay needs the same answers every time, so keep clocks, random numbers and network calls inside steps and replay-test in CI.
- **Deploys break live runs.** A changed flow shape fails runs in progress, so version it and keep the old path until they end.
- **One more system.** You run another distributed system, or pay a managed service for it.

**Example.** An order flow charges the card, reserves stock, books a courier, waits for the warehouse and emails the customer. A worker crashes at 14:03 after the reserve step. At 14:03:05 another worker replays the code: the charge and reserve return their saved results, and booking the courier runs next, so the card is not charged again. The warehouse confirmation arrives 2 days later, and nothing runs while waiting. On day 1 you deploy a new fraud-check step before the charge. Runs already in progress lack it in their history and fail replay, so you keep the old path for 2 days until they finish.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a five-step order survive the machine running it being restarted? Each step's result lands in the history before the workflow asks for the next one, so whoever picks the job up reads what is already done."
flowchart LR
    WF["Workflow code"]
    subgraph Eng["Durable state the engine owns"]
        Engine["Engine"]
        Hist[("Event history")]
    end
    Queue[("Task queue")]
    Worker["Activity worker"]
    Card["Payment service"]:::ext
    WF -->|"1 ask for the next step"| Engine
    Engine -->|"2 enqueue task"| Queue
    Worker -->|"3 poll task"| Queue
    Worker -->|"4 charge the card"| Card
    Worker -->|"5 report result"| Engine
    Engine -->|"6 append result"| Hist
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The engine records every step's result to a durable history. Workflow code holds no side effects; those live in activities. A crashed workflow resumes by replaying that history, so completed steps are returned from the record instead of re-executed."
flowchart TB
    WF["Workflow: ordered steps as code"] -->|"await next step"| ENG["Engine schedules the step"]
    ENG -->|"dispatch activity"| ACT["Activity worker runs the side effect"]
    ACT -->|"records result"| HIST[("Durable event history")]
    HIST -->|"drives the next step"| WF
    HIST -.->|"on crash / redeploy"| REPLAY["Replay from history: completed steps return cached results"]
    REPLAY -.->|"resume at the crash point"| WF
```

## Variations
<!--meta block=variations-->

- **Durable execution (code-first)** — The workflow is authored as ordinary imperative code — awaits, loops, conditionals — and the engine rebuilds state by deterministically replaying that code against the recorded history. You get real language control flow for free; the price is that the workflow body must stay deterministic, with all wall-clock time, randomness, and I/O pushed into activities.
- **Declarative state machine (config-first)** — The workflow is described as a state machine, or a graph with branches and loops, in JSON, YAML, or a DSL (domain-specific language), and the engine tracks each execution's position server-side and continues from it. This buys a visualizable diagram and simpler operations, at the cost of expressiveness; logic sometimes has to be contorted to fit the state-machine model.
- **Signals and durable timers** — A workflow can block on an external event — a human approval, a webhook callback — or on a wall-clock timer, and wait days or months holding only persisted state, with no live thread or worker memory consumed while it waits. The engine rehydrates the execution when the event or timer fires.
- **Continue-as-New** — For workflows that loop indefinitely or accumulate a large history, the execution periodically snapshots its current state into a fresh run seeded with an empty history. This caps replay cost and keeps the persisted history from growing past the engine's size limit.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **You write the happy path**; the engine owns retries, timeouts, persisted progress, and crash recovery, so system plumbing stops leaking into business logic.
- **A crash resumes exactly where it left off** — recorded steps return from history instead of re-running, and only the step in flight can run again, so give it an idempotency key.
- **A workflow can wait days** or months for an external event on persisted state alone, without holding a thread or burning resources while it waits.
- **The recorded history is a full audit trail**: you can see precisely which step a stuck process is blocked on, instead of reverse-engineering it from scattered logs.

### Cons
<!--meta polarity=con-->

- **It is another distributed system** to operate or pay for — the engine, its history store, and worker pools all have to be run and monitored.
- **Code-first engines demand deterministic workflow code**; a stray timestamp, random number, or direct network call in the workflow body breaks replay on recovery — keep all three inside activities, and replay-test the workflow in CI (continuous integration) so the contract is enforced by something other than review.
- **The entire execution history is persisted for replay**, so a long-running or looping workflow can hit history-size limits unless it snapshots with Continue-as-New.
- **It is overkill for a single-step job** — every step pays round-trips through the engine plus a history write, which does not pay off for high-frequency trivial work.
- **A deploy that changes** a workflow's shape can wedge any in-flight execution whose recorded history no longer matches the code replaying it. Version or patch the change and keep the old path until the last old run drains, which on a month-long flow means a month of both.
- **Activities run at least once** — not exactly once, so every side-effecting step needs an idempotency key or a dedupe check downstream.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A logical operation spans several** flaky services and must complete fully or unwind — and a crash mid-flow must neither lose nor repeat a step.
- **The process is long-running**: it waits on a human, a webhook, or a timer for anything from minutes to months before it can continue.
- **You catch yourself hand-building durable progress**, a poller with locking, retries, timeouts, and compensation around a multi-step flow.

### Avoid when
<!--meta polarity=avoid-->

- **The work is a single step** — resize an image, send one email — where a plain [message queue](../../messaging/message-queue.md) already gives you retries and durability.
- **The client waits synchronously** for the result and latency is tight; the engine's scheduling and history writes add overhead a hot path can't spare.
- **The operations are high-frequency and low-value** — per-step round-trips through the engine plus a history write don't pay off across millions of trivial calls.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the hand-rolled version: one row, one tick per finished step"
const steps = ["charge", "reserve", "ship", "notify"] as const;

// Called on a schedule, or whenever the job is nudged. Safe to call again
// after a crash; the step in flight may repeat, so run() must be
// idempotent, and concurrent calls need a lock.
async function advance(jobId: string) {
  const job = await jobs.load(jobId);      // progress lives in the database
  for (const step of steps) {
    if (job.done.includes(step)) continue; // already recorded, skipped
    await run(step, job);
    await jobs.markDone(jobId, step);      // written down before moving on
  }
}
// A crash anywhere loses at most the step in flight, and the next call
// picks up from the last tick. An engine gives you this, plus the timers,
// the retries and the poller you would otherwise write around it.
```

```typescript summary="TypeScript — a durable KYC flow that survives a crash by replaying its history"
// The workflow reads like the happy path. The engine records each
// activity's result to history, so a crash replays this function and
// the completed steps return their recorded result instead of
// re-submitting anything to a vendor. A deploy that reorders or adds
// steps needs versioning.
const { verifyIdentity, screenSanctions, notifyClient } =
  proxyActivities<Activities>({
    startToCloseTimeout: "10 minutes",
    retry: { maximumAttempts: 5 }, // retries are the engine's job, not yours
  });

export async function personaFlow(
  flowId: string,
  personaId: string,
): Promise<FlowState> {
  const id = await verifyIdentity(flowId, personaId);      // recorded
  if (!id.ok) return "rejected";       // terminal — nothing to unwind

  const screen = await screenSanctions(flowId, personaId); // recorded
  if (screen.hit) return "rejected";

  await notifyClient(flowId, "cleared");                   // recorded
  return "cleared";
}

```

## In the wild
<!--meta block=wild-->

- **Temporal** — A durable execution engine and a 2019 open-source fork of Uber's Cadence: you write the workflow as ordinary code, and it reconstructs state by deterministically replaying that code against a recorded event history, resuming at the last completed step. Per-activity timeouts and retry policies, Signals for external events, and Continue-as-New for long loops are built in. {#wild-temporal}
- **AWS Step Functions** — A managed, serverless orchestrator: the workflow is a JSON/ASL state machine of Task, Wait, Choice, and Catch states, and the service tracks each execution's position server-side. Standard workflows cap execution duration at one year and inter-state payloads at 256 KB. {#wild-aws-step-functions}
- **Azure Durable Functions** — An extension to Azure Functions for durable orchestrations: an orchestrator function awaits activity functions, and the framework replays the orchestrator against its execution history to rebuild state after a restart — the code-first replay model on a serverless platform. {#wild-azure-durable-functions}
- **Netflix Conductor** — An open-source orchestration engine originally built at Netflix that runs JSON-defined workflows of tasks against a pool of workers, tracking each execution's state so it can be resumed and inspected. {#wild-netflix-conductor}
- **Apache Airflow** — Schedules DAG-style batch workflows authored as Python DAGs. Built for scheduled extract, transform, load (ETL) pipelines rather than event-driven, long-running, user-facing processes — the canonical tool when the shape is a batch DAG rather than a per-request durable flow. {#wild-apache-airflow}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **activity timeout & retry policy** — the start-to-close timeout bounding how long one step may run, plus the retry policy (max attempts, backoff) before the step is treated as failed. Too generous and a hung step stalls the whole workflow; too tight and a slow-but-healthy step is retried needlessly
- **snapshot cadence against the history ceiling** — engines persist the full event history for replay and enforce a ceiling on its size, often with a maximum execution age alongside it. How many iterations or signals you let accumulate before snapshotting into a fresh run sets both the headroom you keep and the replay work a recovery has to do
- **worker concurrency per task queue** — how many workflow and activity tasks a worker pool polls and runs at once. Too low and tasks queue behind busy workers; too high and the activities overrun the downstream services they call
- **activity heartbeat interval** — for a long-running activity, how often it reports liveness so the engine can tell a slow step from a dead worker and reschedule promptly instead of waiting out the full timeout

### Signals to watch
<!--meta polarity=signal-->

- **workflow start-to-close latency** — end-to-end time from an execution starting to completing. A lengthening tail means steps are stalling or retrying, not that throughput merely dropped
- **activity failure & retry rate** — failures and retries attributed to each activity type. A spike isolates the one flaky downstream dragging workflows into long retry loops
- **task-queue backlog / schedule-to-start latency** — how long tasks wait before a worker picks them up. Sustained growth means the worker pool is undersized for the arrival rate
- **open workflow count and age** — how many executions are in flight and how old the oldest is. A growing tail of long-lived, un-advancing workflows points at stuck steps or a signal that never arrived

### Failure modes under load
<!--meta polarity=failure-->

- **non-deterministic code breaks replay** — a timestamp, random value, or direct network call in the workflow body (rather than in an activity) makes replay diverge from recorded history, and the execution wedges or errors on recovery
- **poison activity retries forever** — a step that deterministically fails is retried under its policy without end, pinning workers and never advancing; without a max-attempts cap or a compensation branch it silently stalls the workflow
- **history outgrows its limit** — a long loop or a firehose of signals inflates the event history until it hits the engine's size ceiling and the execution can no longer progress. Continue-as-New is the release valve
- **worker starvation on a backed-up task queue** — a burst of workflows or slow activities saturates the worker pool; new tasks pile up and schedule-to-start latency climbs while nothing is technically failing

### Readiness checklist
<!--meta polarity=check-->

- Workflow code is deterministic — all wall-clock time, randomness, and I/O live in activities, so replay reproduces the same decisions
- A step that always fails was run end to end, so somebody has watched where it stops instead of assuming it does
- Activities are idempotent and keyed, so a retry after an unacknowledged success does not double-charge or double-send
- Changes to running workflows are versioned or patched, so a deploy does not break in-flight executions' replay
- A long-running execution was replayed at its worst-case history size, so the recovery cost is measured rather than assumed

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Multi-Step Processes](../../../themes/multi-step-processes.md) — Run the steps as durable, replayable code {#fluency-multi-step-processes}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Saga](./saga.md) — An orchestrator is the durable engine that runs a saga's steps and compensations
- [Compensating Transaction](../resilience/compensating-transaction.md) — The engine owns compensation: persisting, ordering and retrying each undo step
- [Big Data](../../architecture/big-data.md) — The analytical pipeline is the recurring flow: read the sources, transform, load the store, refresh the dashboard

**Alternative to**

- [Sweeper](./sweeper.md) — The engine's durable timers and retries replace the hand-rolled scan for work that stalled
- [Asynchronous Request-Reply](../routing/async-request-reply.md) — Reach for it once the work has meaningful intermediate steps that must be resumed and unwound
- [AI Agent](../../architecture/ai-agent.md) — Deterministic and reproducible, which the loop is not — choose it whenever the order is knowable
- [Routing Slip](../../messaging/routing-slip.md) — A central coordinator drives each step and records its state, which a slip leaves to the processors

**Often confused with**

- [Container Orchestration](./container-orchestration.md) — This orchestrates the steps of a business process; container orchestration orchestrates the machines those steps run on.

**Demonstrated by**

- [Uber](../../../designs/uber.md) — a long-running process with timeouts, retries and human-in-the-loop waits is the textbook durable-execution use case
- [YouTube](../../../designs/youtube.md) — coordinating a multi-stage transcode directed acyclic graph (DAG) with fan-out and retries is the orchestrator's core job
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — a know your customer (KYC) flow whose steps run minutes to hours, orchestrated as a persisted state machine plus task queue — the hand-rolled end of the same pattern a workflow engine packages
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — durable orchestration built from two tables, with the engine named as a deferred exit priced against handing over the history

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Step Functions and Durable Functions persist each step, so a crash resumes instead of restarting.
- [Workflow orchestrators](../../../comparisons/workflow-orchestrators.md) — The engines that make a long process durable, argued one against another.

<!-- relationships:end -->
