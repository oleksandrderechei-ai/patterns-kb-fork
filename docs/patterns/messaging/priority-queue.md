---
title: Priority Queue
description: "Serves queued work by importance, not by arrival order"
area: messaging
owner: Oleksandr Derechei
tags: [messaging, latency, resource-management, throughput]
status: stable
aliases: [priority messaging]
solves: [our biggest customer's jobs sit behind a backlog of free-tier work, urgent requests wait in the same line as overnight batch jobs and miss their deadline, we promised premium users faster processing but everything goes through one queue, a flood of low-value work is starving the work that actually matters]
---

# Priority Queue

Classifies each unit of queued work by how much it matters, and serves the important classes first — so a promise made to one caller survives a flood of work from another.

## What it is
<!--meta block=description-->

A priority queue serves urgent messages before the rest: the producer classifies each message, and consumers take the urgent class first. Only the order changes, not the work. It stops a password reset waiting behind thousands of exports. It reorders an overload and does not shrink it, so it needs buffering underneath.

## Explained
<!--meta block=explain-->

A priority queue serves urgent messages before the rest: the producer marks each message urgent or deferrable, and consumers take the urgent class first. The work stays the same; only the order it is offered in changes. You build it as one queue with a priority field, which needs a broker that sorts, or as one queue per class, which every broker supports and which lets each class have its own consumers. Choose it over a plain queue when a password reset must not wait behind 10,000 report exports. Priority reorders an overload and does not shrink it, so keep a buffering queue underneath if arrivals can exceed what consumers drain.

- **Starvation.** Under steady urgent load a shared pool never reaches the low queue. Promote aging messages or reserve capacity for the low class.
- **Priority inflation.** Every caller will mark its work urgent. Keep a written rule for each class and a time target for the urgent one.
- **Queue count.** Queues multiply with classes, so use two or three.

**Example.** Ten workers finish 10 one-second jobs a second. Password resets (high) arrive at 4 a second and exports (low) at 8 a second, 12 in all, so the pool is 2 a second short. Resets are served at once and exports get the other 6 a second, so the export backlog grows by 2 a second: 1,200 waiting after 10 minutes. Priority did not remove the overload; it chose who waits. Promoting exports that waited over 60 s only moves the shortfall onto the resets. Adding 2 workers closes the gap, since 12 workers finish 12 a second, and then aging bounds the export wait.

## How it works
<!--meta block=structure-->

```mermaid caption="How does an urgent request overtake a backlog of batch work? The producer decides the class at step 1 — everything after that is routing and capacity, which is why the classification rule is the part worth arguing about."
flowchart LR
    P["Producer"]
    subgraph Q["One queue per class"]
        QH[("High")]
        QL[("Low")]
    end
    CH["Consumers, high"]
    CL["Consumers, low"]
    D["Downstream service"]:::ext
    P -->|"1 classify, then route"| QH
    P -->|"1 classify, then route"| QL
    QH -->|"2 dedicated capacity"| CH
    QL -->|"3 whatever is left"| CL
    CH -->|"4 process"| D
    CL -->|"4 process"| D
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The shared-pool variant, and its cost. Strict preemption is what makes the high-priority promise unconditional, and it is the same property that can leave the low queue unserved for as long as high-priority work keeps arriving."
sequenceDiagram
    autonumber
    participant P as Producer
    participant QH as High queue
    participant QL as Low queue
    participant W as Shared consumer pool
    P->>QL: enqueue 5,000 batch jobs
    P->>QH: enqueue 1 urgent job
    W->>QH: poll high first
    QH-->>W: urgent job
    W->>QH: poll high again
    alt high queue empty
        W->>QL: poll low
        QL-->>W: batch job
    else high queue still filling
        Note over W,QL: low queue is never polled — starvation
    end
```

## Variations
<!--meta block=variations-->

- **Single queue, priority field** — Every message goes to one channel carrying a priority value, and the broker orders by it. The least infrastructure to run and the least routing to reason about — but it depends entirely on the broker supporting priority ordering, and it gives you no way to size capacity per class, because there is only one queue to consume.
- **Queue per class, dedicated pools** — One queue per priority level, each with its own consumers, sized or tiered independently. Pick this when the classes have separate performance targets that must be met independently, or when fault isolation matters and a problem draining one class must not touch another.
- **Queue per class, shared pool** — One pool serves every queue, draining the highest class first and dropping to the next only when the higher ones are empty. Simplest to configure and monitor, and the right shape when the tasks are similar in kind — at the price of starvation, which is not a bug in the implementation but the behaviour you asked for.
- **Aging** — Raise a message's priority as it waits, so low-priority work eventually reaches the front instead of being deferred forever. This is the standard counter to starvation, and it needs a broker that lets you change a queued message's priority — where it does not, the same effect comes from a sweeper that re-enqueues aged messages into a higher class.
- **[Competing Consumers](./competing-consumers.md) per class** — Each pool is itself a set of interchangeable workers on one queue, so a class scales horizontally within its own lane. Priority decides which lane is served; competing consumers decides how wide each lane is.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Differentiated service levels become enforceable**. Faster handling for one client class is guaranteed by the routing, provided urgent arrivals stay within the capacity serving that class.
- **Critical work stops sharing a fate** with bulk work. A batch flood delays the batch queue; with dedicated pools, or a shared pool with spare consumers, the urgent queue does not notice.
- **Reliability and performance effort can be concentrated**. You can afford to over-provision, monitor tightly and alert aggressively on one class rather than on everything.
- **With dedicated pools**, each class is a separate blast radius — a poison message or a stuck consumer in one lane leaves the others draining.

### Cons
<!--meta polarity=con-->

- **Starvation is built in**. Under sustained high-priority load a strictly preemptive shared pool can defer low-priority work indefinitely, so you need aging or a reserved slice of capacity to bound the wait.
- **It does not absorb bursts**. Reordering an overload still leaves an overload; pair it with load leveling or the whole system falls behind in priority order.
- **Each queue costs money and attention**. A managed broker bills per request and a self-run one costs operating time; either way the bill and the dashboard grow with the number of classes.
- **The classification rule becomes a permanent argument**. Every caller believes their work is urgent, and a priority field that everyone sets to high is a plain queue with extra steps.
- **Static pool sizing decays**. Consumers should scale on the depth of the queue they serve; a pool sized for last quarter's mix silently misses this quarter's target.
- **Ordering within a class is not guaranteed** once several consumers share it. Where it must be, you need [Sequential Convoy](./sequential-convoy.md) inside the priority level.
- **Priority is not preemptive**. It orders only what is still queued. In-flight jobs and a consumer's prefetch buffer are not overtaken, so keep jobs short and prefetch small.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You owe different clients different** service-level guarantees, and the paying tier must see better latency than the free one.
- **The workload mixes genuinely urgent tasks** with genuinely deferrable ones, and today they share a channel.
- **A named target exists for the urgent class** — "processed within ten seconds" — so you can tell whether the pattern is working.
- **Background work can be scheduled** into quiet periods rather than competing for consumers at peak.

### Avoid when
<!--meta polarity=avoid-->

- **All the work is equally important**. A single queue with enough consumers is cheaper to run and easier to reason about.
- **The real problem is capacity, not ordering**. If every class is missing its target, priority just chooses who finds out last.
- **Nobody will own the classification**. Without a rule someone enforces, priority drifts to uniform and you have paid for queues you do not use.
- **Low-priority work has a hard deadline too**. Strict preemption cannot promise both, and you need reserved capacity per class instead.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a shared pool that drains high before low, with aging to bound the wait"
type Job = { id: string; enqueuedAt: number }
const AGING_THRESHOLD_MS = 60_000
interface Queue { receive(): Promise<Job | null>; send(job: Job): Promise<void> }

// One pass of the shared-pool loop: always offer the high queue first, and
// only fall through to low when high has nothing left to give.
async function drainOnce(high: Queue, low: Queue): Promise<Job | null> {
  const urgent = await high.receive()
  if (urgent) return urgent
  return low.receive()
}

// The counter-move to starvation: anything that has waited past the threshold
// is promoted. The worst case is bounded only while this runs on a timer and
// high has spare capacity. receive() removes the job, so re-sending a young one
// puts it behind younger ones and a crash between the two calls loses it; a real
// broker needs a peek, or an ack after the send.
async function promoteAged(low: Queue, high: Queue, now: number): Promise<number> {
  let promoted = 0
  for (;;) {
    const job = await low.receive()
    if (!job) return promoted
    if (now - job.enqueuedAt < AGING_THRESHOLD_MS) {
      await low.send(job)
      return promoted
    }
    await high.send(job)
    promoted += 1
  }
}
```

## In the wild
<!--meta block=wild-->

- **RabbitMQ priority queues** — A queue declared with `x-max-priority` orders messages by the priority set on each publish — the single-queue variant, and its documentation is explicit that priority is best-effort and higher priority levels cost more CPU and memory. {#wild-rabbitmq-priority}
- **Celery** — Routes tasks to named queues and starts workers bound to specific queues, which is how the multiple-queue, multiple-pool topology is normally built in Python — dedicated workers for a high queue, separate ones for bulk work. {#wild-celery-routing}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Number of priority classes** — Each class is another queue to pay for, monitor and staff. Start at two or three; add another only when a class has its own written target.
- **Consumers per class** — Size each pool against its own class target, and scale it on that queue depth rather than a fixed count.
- **Aging threshold** — How long low-priority work may wait before it is promoted; this bounds the starvation window. Set it below the low class's own deadline minus its processing time; with no deadline, pick the longest wait the business accepts and tune it against oldest-message age.
- **Poll ratio for a shared pool** — Strict preemption is the simple setting; serving low every Nth poll trades the hard guarantee for a floor under low-priority throughput.

### Signals to watch
<!--meta polarity=signal-->

- **Age of the oldest message per class** — The number that says whether the high-priority promise is being kept, and the first place starvation shows. Alert before it reaches the class target; for the low class, age past the aging threshold means promotion is failing.
- **Queue depth per class** — Depth diverging between classes means the pool sizing no longer matches the mix.
- **End-to-end latency percentiles per class** — Track them separately, because a blended percentile hides exactly the difference the pattern exists to create.
- **Share of traffic marked high priority** — Climbing toward everything means the classification has stopped meaning anything.

### Failure modes under load
<!--meta polarity=failure-->

- **Low-priority starvation** — Sustained high-priority load with a strictly preemptive pool leaves the low queue unserved indefinitely.
- **Priority inflation** — Every caller marks their work urgent, and the system degrades to a single queue with extra infrastructure.
- **Overload arrives in priority order** — When arrival exceeds capacity, priority only decides who falls behind last — every class still falls behind.
- **Idle dedicated capacity** — Dedicated pools cannot lend each other workers, so the high pool sits idle while the low queue backs up.

### Readiness checklist
<!--meta polarity=check-->

- Each class has a named, measurable target rather than a relative label.
- Someone owns the classification rule and can refuse a request to mark work urgent.
- Starvation is bounded by aging or reserved capacity, not left to load.
- Pools scale on the depth of the queue they serve.
- Load leveling is in place if arrival rate can exceed drain rate.
- Per-class latency and oldest-message age are on a dashboard, not computed on request.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Long-Running Tasks](../../themes/long-running-tasks.md) — Let urgent work jump ahead of a backlog of bulk work. {#fluency-long-running-tasks}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md) — Leveling buffers the burst, priority decides who gets served out of it first
- [Competing Consumers](./competing-consumers.md) — Each priority class is drained by its own pool of interchangeable workers
- [Rate Limiter](../distributed/resilience/rate-limiter.md) — Limit the low classes first, so shedding load costs the cheapest work
- [Sequential Convoy](./sequential-convoy.md) — Keep per-entity order inside a class when the class alone is not enough
- [Bulkhead](../distributed/resilience/bulkhead.md) — Dedicated pools per class are bulkheads: a stuck lane cannot drain the others, at the cost of idle capacity.

**Variant of**

- [Message Queue](./message-queue.md) — A queue whose service order is business importance rather than arrival

**Often confused with**

- [Priority Inversion](../../hazards/priority-inversion.md) — A priority queue avoids the shared lock but starvation can still follow.

**Prevents**

- [Head-of-Line Blocking](../../hazards/head-of-line-blocking.md) — A priority lane stops a stuck bulk item from blocking urgent work.

**Exposed to**

- [Starvation](../../hazards/starvation.md) — Can fall into starvation when low-priority items are never served while high-priority work keeps arriving

**Demonstrated by**

- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — live flows and the recurring recheck batch share one task table, so recheck tasks claim from a separately sized pool — reserved capacity per class, because the batch's jurisdiction cadence is a deadline too
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — the case for reserved capacity over strict preemption, argued from the low-priority class having a deadline of its own

<!-- relationships:end -->
