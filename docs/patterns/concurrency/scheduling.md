---
title: Scheduling
description: Run work at a chosen time or interval instead of the moment it is requested
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, asynchrony, resource-management]
status: stable
aliases: [job scheduling]
solves: [this report needs to run every night at 2am without anyone kicking it off, "we need to retry the failed payment in five minutes, not right now", a burst of work should be spread over the next hour instead of firing all at once, "some jobs must run later, after a delay, not the instant they are requested", cleanup should happen on a fixed interval no matter what else is going on]
---

# Scheduling

A scheduler decouples when work runs from when it is requested — holding jobs and releasing them at a fixed time, on a repeating interval, or after a delay — so periodic, deferred, retried, and time-spread work all have one home.

## What it is
<!--meta block=description-->

Not all work should run the moment it is requested: some is periodic, some deferred, some must be spread out. A scheduler stores each job, usually in a queue sorted by due time, and releases it at a fixed time, on an interval or after a delay. A timer ticks, the scheduler wakes, and due jobs go to a worker. The request and the run are decoupled.

## Explained
<!--meta block=explain-->

Scheduling runs a job at a chosen time or on a repeating interval, from a store that remembers what is due, so work happens without a person starting it. Choose it over a loop that sleeps inside your service when jobs must survive a restart, run once even with several copies of the service, or be changed without a deploy.

- **Clock pitfalls** Local clocks skip or repeat an hour at daylight-saving changes; store times in UTC and decide what a local-time job does.
- **Lost or doubled runs** Memory-only jobs vanish at restart, and two copies can both fire; use durable storage, one leader or lock, and safe-to-repeat jobs.
- **Herds** Many jobs at midnight arrive together; add a random delay to each.
- **Overlap** A job still running when the next is due needs a rule: skip the new run, queue it or cancel the old one.

**Example.** A report job runs daily at 02:30 local time. On the spring day the clock jumps from 02:00 to 03:00, so 02:30 never happens and the report is skipped. On the autumn day 02:30 happens twice and the report goes out twice. The service also runs on 3 copies, and each fires the job at 02:30, so three reports are sent unless one copy holds a lock. If 500 jobs each need 2 s of CPU on 4 cores, firing them all at midnight is 500 x 2 / 4 = 250 s of saturation. A random delay of up to 10 minutes spreads them out, at the cost of runs that no longer start exactly on time.

## How it works
<!--meta block=structure-->

```mermaid caption="What happens between the request and the run? Step 2 is the whole difference — the job is written down instead of executed, and only the tick at step 3 decides its moment has come, which is why the store has to outlive a restart."
flowchart LR
    App["Application"]:::ext
    subgraph Sched["One component owns the clock"]
        S["Scheduler loop"]
        J[("Job store, sorted by due time")]
    end
    Q[("Work queue")]
    W["Worker"]
    App -->|"1 submit a job with its due time"| S
    S -->|"2 store it, do not run it"| J
    S -->|"3 on each tick, take what is now due"| J
    S -->|"4 release the due jobs"| Q
    Q -->|"5 a worker picks one up and runs it"| W
    W -->|"6 report the outcome, or ask to run again later"| S
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Cron / calendar schedules** — Fire at fixed recurring wall-clock times — "every day at 2am", "the first of the month". Expressive for human-meaningful cadences, but the place where timezone and daylight-saving pitfalls live.
- **Delay queues** — Run a job after N seconds rather than at a named time — a message becomes visible only once its visibility timeout or delay elapses. Ideal for "retry in five minutes" and deferred side effects.
- **Interval / rate schedules** — Fire every N units — every 30 seconds, every hour — measured from the last run rather than a calendar. Simpler than cron when you only care about cadence, not a specific clock time.
- **Distributed scheduling with a [single leader](../distributed/coordination/leader-election.md)** — Across replicas, elect one node (or hold a lock) so a scheduled job fires exactly once instead of once per replica. The cost of running the scheduler in more than one process.
- **Durable [workflow schedulers](../distributed/coordination/workflow-orchestration.md)** — Beyond a plain timer: multi-step, retried, resumable workflows whose state and pending timers survive a restart. Heavier to operate, but the only option when a delayed step must not be lost.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Work runs at the right time** with no human kicking it off.
- **Defers and smooths load** — bursts can be spread over time instead of firing at once.
- **Enables retries-with-backoff and durable multi-step workflows**.
- **Decouples the request from its execution** — the caller returns immediately.

### Cons
<!--meta polarity=con-->

- **Clock, timezone, and daylight-saving pitfalls** — the same schedule can skip or double a run.
- **Missed or duplicate runs** when a node dies or clocks skew across replicas.
- **Needs durable storage**, or queued jobs vanish on a restart.
- **Running it across replicas** needs [leader election](../distributed/coordination/leader-election.md) or a lock to fire once.
- **Jobs sharing one instant** cause a [thundering herd](../../hazards/thundering-herd.md), like at midnight.
- **Overlapping runs force a policy** — when a run is still going as the next one is due, let them overlap, skip the new one, or cancel the old — and a job that slowly grows past its interval starts running against itself before anyone picks one.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Work is periodic** (a nightly report, an hourly cleanup) and should fire on a cadence.
- **Work is deferred or retried later** — "do this in five minutes", not right now.
- **You need durable, resumable multi-step workflows** whose timers survive a restart.
- **You want to spread a burst of work** over time instead of firing it all at once.

### Avoid when
<!--meta polarity=avoid-->

- **The work must run immediately and synchronously** in the request path.
- **A plain event trigger already does the job** — react to the event, don't schedule.
- **The operational weight of a durable scheduler** isn't worth it for a trivial one-off timer.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a tiny delay scheduler"
type Job = { dueAt: number; task: () => void };

class DelayScheduler {
  private jobs: Job[] = [];          // kept sorted by dueAt (a heap in real code)
  private timer: ReturnType<typeof setTimeout> | null = null;

  // Schedule `task` to run after `delayMs`.
  schedule(task: () => void, delayMs: number): void {
    this.jobs.push({ dueAt: Date.now() + delayMs, task });
    this.jobs.sort((a, b) => a.dueAt - b.dueAt);
    this.arm();                      // re-arm for the new earliest job
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const next = this.jobs[0];
    if (!next) return;
    const wait = Math.max(0, next.dueAt - Date.now());
    this.timer = setTimeout(() => this.fireDue(), wait);
  }

  private fireDue(): void {
    const now = Date.now();
    while (this.jobs.length && this.jobs[0].dueAt <= now) {
      this.jobs.shift()!.task();     // hand the due job to its worker
    }
    this.arm();                      // schedule the next tick
  }
}
```

## In the wild
<!--meta block=wild-->

- **cron & Kubernetes CronJob** — Unix cron runs commands on a calendar schedule; Kubernetes CronJob does the same for containers, creating a Job per scheduled tick. {#wild-cron}
- **Quartz Scheduler** — A Java job-scheduling library with cron triggers, misfire handling, and a clustered mode that coordinates nodes so a job fires once. {#wild-quartz}
- **Celery beat** — The scheduler process for Celery that enqueues periodic tasks onto the task queue on an interval or crontab schedule. {#wild-celery-beat}
- **Temporal** — A durable workflow engine whose timers, retries, and long-running multi-step workflows survive process restarts — widely used to orchestrate pipeline and agent steps. {#wild-temporal}
- **Apache Airflow** — Schedules and orchestrates directed acyclic graphs (DAGs) of data tasks on time or dataset triggers, with retries and backfills. {#wild-airflow}
- **Amazon EventBridge Scheduler** — A managed service that invokes targets on cron or rate schedules, or once at a future moment, at scale. {#wild-eventbridge-scheduler}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **tick / poll interval** — how often the scheduler checks for due jobs
- **max concurrency** — how many due jobs may run at once
- **retry policy** — max attempts and backoff for failed jobs
- **jitter** — random spread added to shared schedules to avoid a herd

### Signals to watch
<!--meta polarity=signal-->

- **scheduling lag** — gap between a job's due time and when it actually ran
- **due-queue depth** — jobs past due and waiting for a worker
- **missed / duplicate run count** — runs skipped after a crash or fired twice across replicas

### Failure modes under load
<!--meta polarity=failure-->

- **missed runs after a crash** — jobs vanish on restart without a durable store
- **duplicate runs** — every replica fires the same job without leader election or a lock
- **thundering herd** — many jobs share one instant (e.g. midnight) and stampede the system
- **clock skew** — drift between nodes fires jobs early or late

### Readiness checklist
<!--meta polarity=check-->

- persist jobs durably so restarts don't drop them
- make handlers idempotent — runs can duplicate
- add jitter to schedules many jobs share
- single-fire across replicas via a leader or lock
- alert on scheduling lag

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Gen AI at Scale](../../themes/genai-scale.md) — Push bulk generation into off-peak windows and retry flaky calls later {#fluency-genai-scale}
- [Operating a Live System](../../themes/operating-a-live-system.md) — Maintenance on a clock rather than in a calendar {#fluency-operating-a-live-system}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Retry with Backoff](../distributed/resilience/retry-backoff.md) — A scheduler is what re-runs a failed job later, on a backoff
- [Producer-Consumer](./producer-consumer.md) — The scheduler produces due jobs onto a queue that workers drain
- [Leader Election](../distributed/coordination/leader-election.md) — Elect one leader so a scheduled job fires once, not once per replica
- [Sweeper](../distributed/coordination/sweeper.md) — one of the most common jobs on a schedule is the sweep for work that failed by not happening
- [Big Compute](../architecture/big-compute.md) — Job schedulers are the control point of a big compute cluster.

**Prevents**

- [Starvation](../../hazards/starvation.md) — Aging and fair scheduling promote work that has waited

**Demonstrated by**

- [Job Scheduler](../../designs/job-scheduler.md) — one-off future dates and repeating cadences both reduce to the same question — what is due in the next window
- [Online Auction](../../designs/online-auction.md) — A scheduler that reschedules on each bid is the precise alternative to a periodic sweep

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — A managed broker holds the message until its scheduled time, so no scheduler process of yours has to stay alive to fire it.
- [Compute](../../capabilities/compute.md) — A managed scheduler is the cron table sold as a service.

<!-- relationships:end -->
