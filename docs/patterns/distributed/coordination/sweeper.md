---
title: Sweeper
description: Scans on a clock for work that failed by not happening
area: distributed-coordination
owner: Oleksandr Derechei
tags: [resilience, lifecycle, error-handling, resource-management]
status: stable
aliases: [reaper, janitor, scavenger, expiry sweep]
solves: [a worker died holding a task and nothing ever picks it up again, abandoned checkouts keep seats locked forever, a request got stuck halfway and nobody was ever told, rows pile up in a pending state and no one notices until a customer complains, expired reservations only get cleaned up when someone happens to load the page]
favourite: true
---

# Sweeper

A job that runs on a clock and queries for records sitting in a state they should have left by now — a lease whose holder died, a task that exhausted its retries, an item past its deadline — then drives each one back onto a legal path: reclaimed, escalated, or expired.

## What it is
<!--meta block=description-->

A worker that dies mid-task sends nothing, so no event announces the failure and the task sits marked in progress. A sweeper is a small scheduled job that queries for records that should have moved on by now and applies one fix to each: hand the task back, give up and tell a person, or release what it holds.

## Explained
<!--meta block=explain-->

A sweeper is a small job that runs every minute or so and asks one question: which records should have moved on by now and have not? It does one thing to each row it finds, such as handing the task back to another worker, giving up on it and telling a person, or releasing what it holds. It exists because a worker that dies mid-task sends nothing, so no event ever announces the failure. Choose it only when something must actively happen at the deadline. If you only need to know whether a record is still valid, check on read or let the store expire it with a time to live, and keep correctness off a background job.

- **Falls behind when busy.** Cap rows per run and let a backlog drain over several runs.
- **Silent death.** Record a heartbeat after each run and alert when it stops.
- **The limit is a bind.** Too short kills slow work, too long strands resources. Compute it from measured worker time.
- **Races live workers.** Guard updates with a conditional write and make sweeps safe to repeat, so it never steals from a live worker.

**Example.** Workers claim jobs by setting locked_at, and the p99 job takes 90 s. You set the limit at 5 minutes and the sweeper runs every 60 s. A worker dies at 10:00:00 holding job 41. The sweeper first sees it past the limit at 10:05:00 to 10:06:00 and runs UPDATE ... WHERE locked_by = the worker it saw, which changes 1 row, so another worker takes the job. The customer waits up to 6 minutes, the cost of the limit. A limit of 60 s would have stolen jobs from healthy workers that were only slow.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a task whose worker died ever move again, when nothing raised an error? A clock-driven pass goes looking for it, and step 4's update is conditional on what step 3 read, so a worker that is merely slow keeps its task."
flowchart LR
    Clock["Scheduler, every 30s"]
    subgraph Single["One runner at a time"]
        Lock[("Leader lock")]
        Sweep["Sweeper"]
    end
    Tasks[("Task table")]
    Worker["Task worker"]
    Op["Operator"]:::ext
    Clock -->|"1 fire the tick"| Sweep
    Sweep -->|"2 hold the lock"| Lock
    Sweep -->|"3 select rows past their deadline"| Tasks
    Sweep -->|"4 guarded update: hand back or mark dead"| Tasks
    Sweep -->|"5 escalate what is dead"| Op
    Worker -->|"6 claim the handed-back task"| Tasks
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="One job, one clock, three predicates: what has been held too long, what has failed too often, and what has waited past its deadline — each with a different resolution."
flowchart LR
    CLK["Clock — every N seconds"] --> S["Sweeper"]
    S -->|"indexed query per predicate"| DB[("Records with state + timestamps")]
    S -->|"lease expired"| R["Reclaim — back to pending"]
    S -->|"attempts exhausted"| D["Escalate — dead state, alert, notify"]
    S -->|"past deadline"| E["Expire — release the resource"]
    R --> DB
    D --> DB
    E --> DB
```

## Variations
<!--meta block=variations-->

- **Lease reclaim** — Find claims whose holder stopped renewing — `status = 'processing' AND locked_at < now() - lease` — and return them to the pending pool for another worker. The most common form, and the one that makes an at-least-once queue survive worker crashes. Pair it with a guarded update so a slow-but-alive holder's later write lands on zero rows instead of double-applying.
- **Deadline and service-level agreement (SLA) escalation** — Find records sitting in one state past the time the business promised, and escalate rather than retry: alert an operator, surface it in a support view, emit a failure event to the customer. Distinct from reclaim because the resolution is telling a human, not re-running a machine.
- **Retry exhaustion** — Find work whose attempts exceeded budget and park it in a dead state — inspectable, re-runnable once the cause is fixed, never silently dropped. This is the [dead-letter channel](../../messaging/dead-letter-channel.md) implemented as a table plus a sweep, for systems with no broker to provide one.
- **Orphan collection** — Find records whose counterpart never arrived: an upload row with no blob, a blob with no row, a reservation whose payment never came. Usually a two-sided query with a grace period long enough that in-flight work is never mistaken for an orphan.
- **Lazy expiry instead of a sweep** — No job at all: store the expiry timestamp, and treat the record as expired the next time anything reads it. Correctness stops depending on a job running on time, and the cost moves into every read path. The right default when nothing needs to happen at the moment of expiry — but it leaves the resource nominally held until someone looks, so it cannot free capacity on its own.
- **Self-expiring records** — Let the store do it: a TTL on the key, a visibility timeout on the message, a session-bound ephemeral node. Zero code and no timing dependency, at the cost of needing a store that offers it and giving up any hook at the moment of expiry — nobody is told, nothing is escalated.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Catches the one failure class nothing else reports** — the crash, the abandonment, the callback that never came. Without it those records sit forever.
- **One place owns** "what should have happened by now", instead of a timer scattered into every component that could stall.
- **Its resolutions can be actions** — notify the customer, page an operator, release a hundred rows at once — which a passive expiry check can never do.
- **Needs no new infrastructure**: an indexed query on a schedule, running against data the system already stores.
- **Inspectable and reusable** — the query that finds stuck work is the same one support runs to answer "why is this stuck?", and it doubles as an alerting signal.

### Cons
<!--meta polarity=con-->

- **Correctness starts depending** on a job running on time — a lagging or dead sweep leaves resources held, and sweeps fall behind exactly when the system is busiest.
- **It races the live workers it inspects**: without a guarded, idempotent update it will steal a task from a slow-but-healthy holder, or escalate the same record twice.
- **Polling cost scales with table size**, not with the amount of stuck work — an unindexed predicate turns into a full scan on a timer.
- **It is usually a singleton**, so it needs a lock or [leader election](./leader-election.md) to avoid running N times — and a sweeper that dies quietly fails silently, which raises the question of who sweeps the sweeper.
- **The staleness threshold is a tuning bind**: too aggressive kills work that was merely slow, too lax leaves resources stranded past the point anyone cares — compute it from measured worker duration at the p99, and let a live worker renew its lease rather than race the clock.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The failure mode is silence** — a worker crashed mid-task, a human abandoned a flow, a vendor callback never arrived.
- **Something must actively happen at the deadline**: a customer told, an operator paged, a queue of held resources released.
- **Work is claimed under a lease** — the lease can outlive the process holding it, and an unreclaimed claim blocks progress.
- **An SLA is promised per state**, and a breach has to reach somebody rather than sit in a table.
- **The store cannot expire records itself** — a relational system of record with no TTL, holding the queue as a table.

### Avoid when
<!--meta polarity=avoid-->

- **A check at read time would do** — if the only question is "is this still valid?", answer it on read and skip the job entirely.
- **The store can expire** the record itself and nobody needs to be told: a TTL, a visibility timeout, or a session-bound node is free and never falls behind.
- **Correctness cannot tolerate the sweep being late** — prefer a self-expiring lease, and fence the resource so a stale holder's write is rejected.
- **The predicate cannot be indexed**, and the sweep would scan a large hot table on every tick.
- **You would be adding** it to paper over work that silently fails — fix the reporting path first, or the sweeper becomes the place bugs go to hide.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — every 30 seconds, hand back the tasks whose worker went quiet"
const LEASE_MS = 60_000;   // a claim not renewed within a minute is presumed dead

async function sweepOnce() {
  const stale = await tasks.find({
    status: "processing",
    lockedBefore: Date.now() - LEASE_MS,
  });

  for (const task of stale) {
    // Hands it back only if nothing changed since we read it — so a slow
    // worker that is still alive keeps the task it is working on.
    await tasks.releaseIfUnchanged(task);
  }
}

setInterval(sweepOnce, 30_000);
```

```typescript summary="TypeScript — one tick, three predicates, every write guarded"
const LEASE_MS = 60_000, MAX_ATTEMPTS = 5; // a claim unrenewed for LEASE_MS is presumed dead

async function sweepOnce(db: Db, notify: Notifier): Promise<void> {
  // 1 · Reclaim expired leases. The guard is `locked_at = seen`: if the holder
  //     renewed since this row was selected, the update hits 0 rows and the
  //     healthy worker keeps its task.
  const stale = await db.query(
    `SELECT id, locked_by, locked_at FROM task
      WHERE status = 'processing' AND locked_at < now() - $1::interval`, [`${LEASE_MS} ms`]);
  for (const t of stale.rows) await db.query(
    `UPDATE task SET status = 'pending', locked_by = NULL, locked_at = NULL
      WHERE id = $1 AND locked_by = $2 AND locked_at = $3`,
    [t.id, t.locked_by, t.locked_at]);
  // 2 · Escalate exhausted work to the dead state, once. The status guard
  //     makes a second sweep (or a second sweeper) a no-op.
  const dead = await db.query(
    `UPDATE task SET status = 'dead' WHERE status = 'pending' AND attempts >= $1
      RETURNING id, flow_id`, [MAX_ATTEMPTS]);
  for (const t of dead.rows) await notify.operator(t);   // only newly-dead rows return
  // 3 · Breach the SLA out loud. `escalated_at IS NULL` is the idempotency key:
  //     stamped in the same statement, the customer is told exactly once.
  const overdue = await db.query(
    `UPDATE flow SET escalated_at = now()
      WHERE escalated_at IS NULL AND state = $1 AND entered_state_at < now() - $2::interval
      RETURNING id`, ['awaiting_submission', '48 hours']);
  for (const f of overdue.rows) await notify.customer(f);
}
// Run it under a lock so N replicas do not sweep N times.
setInterval(() => withLeaderLock('sweeper', () => sweepOnce(db, notify)), 30_000);
```

## In the wild
<!--meta block=wild-->

- **Redis** — A key with a TTL is removed two ways at once — lazily, when a read touches an already-expired key, and by a background cycle that repeatedly samples keys from the set carrying an expiry and deletes the ones that have passed; without the active sweep, keys nobody ever reads again would hold memory forever. {#wild-redis-active-expiry}
- **PostgreSQL autovacuum** — The autovacuum launcher wakes on a timer and starts workers against tables that have accumulated enough dead row versions, reclaiming the space left by UPDATE and DELETE once no live transaction can still see it — a scheduled scan for state everyone has finished with, and one that famously falls behind under heavy write load. {#wild-postgres-autovacuum}
- **Kubernetes TTL-after-finished controller** — A Job that sets .spec.ttlSecondsAfterFinished is deleted, along with the pods it owns, once that long has elapsed since it completed or failed — and the documentation is explicit that cleanup happens some time after the TTL rather than at it, which is the sweeper's timing bargain stated in the API. {#wild-kubernetes-ttl-after-finished}
- **Amazon Simple Storage Service (S3) lifecycle rules** — A multipart upload that is never completed or aborted leaves its uploaded parts in the bucket — billed, and invisible to an ordinary object listing — and the AbortIncompleteMultipartUpload lifecycle action is a scheduled sweep that reclaims them a configured number of days after the upload was initiated: orphan collection with a grace period. {#wild-s3-abort-incomplete-multipart-upload}
- **Django clearsessions** — Django's database and file session backends never purge a session once it expires; the docs say plainly that expired records accumulate and it is your job to run the django-admin clearsessions management command regularly, typically from cron — the sweeper shipped as a command because the store cannot expire the row itself. {#wild-django-clearsessions}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **sweep interval** — how often the tick fires — it sets the worst-case delay between a deadline passing and anything happening, and it bounds how much work one tick must absorb; it has to stay comfortably above the tick's own runtime or ticks overlap
- **staleness threshold** — the interval in the predicate that decides when work is presumed abandoned — a lease age, an SLA window, an orphan grace period; compute it from measured worker duration at the p99, so the threshold sits above the work you expect rather than on top of it
- **rows per tick** — the cap on how many matches one pass resolves — it bounds transaction size and lock footprint so a backlog drains over several ticks instead of one long write that blocks the live workers the sweep exists to help
- **retry budget** — how many attempts a record may burn before the sweep parks it in a dead state instead of reclaiming it again — the dial between rescuing transient failures and letting a poison record cycle forever
- **leader-lock TTL** — how long the singleton runner's own lock lives before another replica may take the sweep — too short and two sweepers overlap on the same rows, too long and a crashed sweeper leaves nothing swept for that duration

### Signals to watch
<!--meta polarity=signal-->

- **tick duration against the interval** — how long one pass takes as a fraction of its period; as it approaches the interval the sweep is one busy hour away from overlapping ticks and a growing backlog
- **backlog matching the predicate** — the count of records currently past the staleness threshold, measured by running the select without acting — sustained growth means the sweep is not clearing what accumulates
- **age past deadline at resolution** — now() minus the deadline at the moment a record is actually acted on — this is the delay the customer or the held resource experienced, and it diverges from the interval as soon as sweeps run late
- **guarded writes that affect zero rows** — the share of updates that matched nothing because the holder moved on between select and update — the sweeper losing its race with live workers, and a rising rate says the staleness threshold is too aggressive
- **time since the last completed sweep** — the heartbeat stamped at the end of a successful pass; the only observable that catches a sweeper that stopped, since its failure is itself a non-event

### Failure modes under load
<!--meta polarity=failure-->

- **the sweep falls behind when it matters most** — the scan and its writes take longest exactly when the table is largest and the database busiest, so ticks queue or overlap and leases expire unreclaimed — the pattern degrades in proportion to the damage
- **unindexed predicate turns into a scan** — cost tracks table size rather than the amount of stuck work; a tick that was free at ten thousand rows saturates the database at ten million and competes with the very workers it is meant to unblock
- **mass false reclaim** — under load healthy workers slow past the staleness threshold, and one tick returns a wave of live tasks to the pending pool; guarded writes stop the theft, but the duplicate work and the re-queued rows still land mid-incident
- **backlog flush after downtime** — the first tick after the sweeper was stopped for an hour matches everything that piled up at once — one oversized transaction, a wave of dead-lettering, and an escalation storm to customers or an on-call operator in a single burst
- **silent death** — the sweeper stops and nothing reports it, because noticing non-events is precisely the job it was doing; the symptoms surface hours later as stuck records and capacity nobody released

### Readiness checklist
<!--meta polarity=check-->

- Keep in the sweeper only what needs an action at the deadline — if the question is merely whether a record is still valid, answer it on read or let the store expire it
- Confirm the staleness predicate is index-backed at the table size you expect in a year, not the size it is today
- Guard every write on the values the row was selected with, so a slow-but-alive holder's row updates zero rows instead of being robbed
- Make each resolution idempotent — stamp the escalated-at or dead marker in the same statement that selects the row, so a second pass is a no-op
- Run it as a singleton under a lock or leader election, and still stay correct if two instances run anyway
- The cap was chosen by draining a real backlog and counting the ticks it took, and somebody accepted that number
- Emit a heartbeat on successful completion and alert on its absence, and rehearse the first tick after an outage — including how many notifications it would send

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Long-Running Tasks](../../../themes/long-running-tasks.md) — Reclaim work whose worker died without saying so {#fluency-long-running-tasks}
- [Operating a Live System](../../../themes/operating-a-live-system.md) — Find the work that failed by never happening {#fluency-operating-a-live-system}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Scheduling](../../concurrency/scheduling.md) — the clock that runs it — interval or cron, with leader election so it fires once across replicas
- [Distributed Lock](./distributed-lock.md) — a lease with a time to live (TTL) is what makes an abandoned claim detectable; the sweeper is what acts on the expiry
- [Dead Letter Channel](../../messaging/dead-letter-channel.md) — where work that exhausted its retries is parked — the sweeper is what decides it is exhausted
- [Timeout / Deadline](../resilience/timeout-deadline.md) — the deadline is the line; the sweeper is what enforces it when the call simply never returns
- [Leader Election](./leader-election.md) — the sweep is a singleton: elect one runner, or N replicas escalate the same row N times
- [Saga](./saga.md) — A stalled saga step is the canonical non-event: the sweep enforces the deadline the flow cannot enforce for itself
- [Object Storage](../routing/object-storage.md) — Orphan collection across a row and its blob is the two-sided sweep, with a grace period long enough for a slow upload
- [Design for Self-Healing](../../../principles/self-healing.md) — Sweeping heals the failures that nothing reported

**Alternative to**

- [Conditional Write](./conditional-write.md) — check-and-act on read leaves no timing dependency; a sweep is for when something must actively happen at the deadline
- [Workflow Orchestration](./workflow-orchestration.md) — A durable timer inside an orchestration engine does the same job with no scan, once you already run the engine

**Prevents**

- [Dual-Write Inconsistency](../../../hazards/dual-write-inconsistency.md) — A scheduled scan finds writes that never landed on one side and repairs the drift

**Demonstrated by**

- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — a long-running know your customer (KYC) flow where every failure is silence — a dead worker, an onboardee who never uploaded, a vendor that never called back
- [BookMyShow](../../../designs/bookmyshow.md) — seat holds expire on a clock: the sweep is what makes an abandoned checkout release inventory instead of stranding it
- [Gopuff](../../../designs/gopuff.md) — reserved inventory in a delivery network is reclaimed by one indexed sweep on held_until rather than by whoever notices
- [Distributed Cache](../../../designs/design-distributed-cache.md) — a cache fleet needs an active pass as well as read-time checks, or dead entries evict live ones
- [YouTube](../../../designs/youtube.md) — A video stuck mid-pipeline emits no event; the sweep is what notices
- [Robinhood](../../../designs/robinhood.md) — a submission that succeeded while its follow-up write did not announces nothing — only a scan finds it
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — the component that makes silence actionable: it turns a passed deadline into a terminal, an escalation or a caveat rather than a wait

**Implemented by**

- [Compute](../../../capabilities/compute.md) — A managed scheduler runs the sweep job on a cron schedule.

<!-- relationships:end -->
