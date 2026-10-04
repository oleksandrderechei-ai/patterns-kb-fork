---
title: CQRS
description: Separate models for reading and for writing
area: architecture
owner: Oleksandr Derechei
tags: [data-modeling, read-optimization]
status: stable
aliases: [command-query-responsibility-segregation]
solves: [the dashboard query joins nine tables and times out, my entity class has grown thirty read-only helper fields for one report screen, reads are ninety-nine percent of my traffic but I have to scale the write database to keep up, every new report forces me to reshape the model that guards my business rules, the ORM mapping that keeps writes safe makes every list page painfully slow]
---

# CQRS

Splits the model that handles writes from the model that serves reads, so each side can be shaped, scaled, and evolved to fit what it actually does.

## What it is
<!--meta block=description-->

CQRS (Command Query Responsibility Segregation) splits the model that changes state from the model that answers questions about it. One class asked to guard your rules and also serve every screen does both badly. The two models need not share a schema or a database, only a way for a change on one side to reach the other. Greg Young named it, extending the older rule that a method either changes state or reports it.

## Explained
<!--meta block=explain-->

CQRS gives changes and questions separate models. A command model changes state and enforces your rules, and one or more query models are built from those changes and shaped for each screen or report. Choose it over a single model plus a read replica (a copy used only for reads) when you have real rules on the write side facing heavy reads of very different shapes. On a plain create-read-update-delete app it is only extra work.

- **The query side lags.** A user can write and read the old value, so show a pending state or send read-your-own-writes to the command model.
- **Unrebuildable read model.** Make the code that builds it safe to replay and able to restart from the start.
- **Lost events.** One lost event leaves the query model wrong for good, so publish through an \[outbox\](../distributed/coordination/outbox.md) and watch the lag.

**Example.** A shop takes 50 orders a second and serves 2,000 order-list views a second, a 40-to-1 skew. The command side keeps orders normalised across 5 tables to guard stock. The query side keeps one flat row per order, so a list view is a single lookup instead of a 5-table join. The row appears about 200 ms after the order, so a customer redirected to the list at 50 ms would not see it. The checkout response carries the new order, and the page shows it as pending. A full rebuild from 20 million events at 10,000 a second takes 2,000 seconds, about 33 minutes.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does stale data come from? Step 2 has committed before step 4 has run, so a step 5 query arriving in that window returns the old row. The gap between 3 and 4 is the lag you have to budget for."
flowchart LR
    C["Client"]
    Proj["Projector"]
    subgraph W["Write side — guards the invariants"]
        CH["Command handler"]
        WM[("Write store")]
    end
    subgraph R["Read side — one model per query shape"]
        RM[("Read model")]
        QH["Query handler"]
    end
    C -->|"1 command"| CH
    CH -->|"2 validate, commit"| WM
    WM -->|"3 event or change feed"| Proj
    Proj -->|"4 apply, denormalised"| RM
    C -->|"5 query"| QH
    QH -->|"6 single lookup"| RM
```

## Variations
<!--meta block=variations-->

- **Single-store CQRS** — Separate command and query model classes over one shared database. It is the simplest form, and it avoids [eventual consistency](../../themes/consistency-and-replication.md) only while the read model updates in the same transaction as the write; an asynchronous projection brings the lag back.
- **[Materialized View](../distributed/coordination/materialized-view.md)** — The read side is a precomputed, denormalized projection held in a store shaped for its query — a dedicated read database or search index.
- **[Event Sourcing](./event-sourcing.md)** — The write side persists a stream of domain events rather than current state; read models are projections built by replaying that stream. A common pairing, not a requirement.
- **Task-based commands** — Commands are named for user intent (`ApproveOrder`, not `UpdateOrder`), keeping the write model's invariants explicit instead of exposing raw field setters.
- **Synchronous vs asynchronous projection** — Update the read model in the write transaction for read-your-own-writes, or publish and project later for independent scaling at the cost of lag.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Read and write sides scale** and are optimized independently — vital when reads vastly outnumber writes.
- **Query models are shaped** for the screen or report they serve, without compromise joins or ORM (object-relational mapper) gymnastics.
- **The write model stays focused on protecting invariants**, not on shaping output for consumers.
- **New read views can be added**, or rebuilt from scratch, without touching write-side logic.

### Cons
<!--meta polarity=con-->

- **Two models**, sometimes two stores, to build, deploy and keep in sync.
- **Sync between write** and read side is often eventually consistent, so a read right after a write can be stale.
- **Debugging spans two models** instead of one, making it harder to trace a value back to what wrote it.
- **Overkill for a small create, read, update, delete (CRUD)** app with no meaningful asymmetry between how it's written and how it's read.
- **Rebuilding or reshaping a read model** replays the full history; the example takes about 33 minutes for 20 million events.
- **Projections must tolerate duplicate and out-of-order events**, so each handler needs idempotency and per-aggregate ordering.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Read and write workloads have very different shapes**, volumes, or scaling needs.
- **Queries don't fit the write model**: dashboards, search and reports don't map onto the write model's structure.
- **You want to add new read views** without destabilizing the code that enforces write-side invariants.

### Avoid when
<!--meta polarity=avoid-->

- **The domain is simple CRUD** with no real divergence between how it's written and how it's read.
- **The team can't absorb** the operational cost of a second model, or of eventual consistency.
- **A single well-designed model plus** a couple of read-only projections already covers the need.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — split command and query paths"
// Write side: a command mutates state and enforces invariants
interface PlaceOrder { customerId: string; items: string[]; }

class OrderCommandHandler {
  constructor(private readonly db: Database) {}

  async handle(cmd: PlaceOrder): Promise<void> {
    const order = Order.create(cmd.customerId, cmd.items); // enforces invariants
    // One transaction: the order and its event commit together or not at all.
    // A relay (not shown) reads unsent outbox rows and publishes them to the bus.
    await this.db.transaction(async (tx) => {
      await tx.orders.save(order);
      await tx.outbox.insert({ type: "OrderPlaced", orderId: order.id, items: cmd.items });
    });
  }
}

// Read side: a denormalized projection kept up to date by events
class OrderSummaryProjector {
  constructor(private readonly view: OrderSummaryStore) {}

  async on(event: { type: "OrderPlaced"; orderId: string; items: string[] }) {
    await this.view.upsert(event.orderId, { itemCount: event.items.length, status: "placed" });
  }
}

// Query side: reads the shaped view directly, no write model involved
async function getOrderSummary(orderId: string, view: OrderSummaryStore) {
  return view.findById(orderId);
}
```

## In the wild
<!--meta block=wild-->

- **Axon Framework** — A Java framework built explicitly around CQRS: command handlers on aggregates raise events, while tracking event processors maintain query projections and can be reset to replay the event store and rebuild a projection from scratch. {#wild-axon}
- **Marten** — A .NET library over PostgreSQL that persists events in the write store and maintains read-side projections either inline in the write transaction or asynchronously via a background daemon that can rebuild a projection by replaying the event log. {#wild-marten}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Projection batch size and poll interval** — How many events a projector applies per pass and how often it wakes to look for more. Larger batches raise throughput but widen the read side's lag behind the write side. Size the batch so one pass finishes inside the staleness budget at the peak event rate, and compare lag and backlog depth before and after each change.
- **Read-model rebuild** — The ability to drop a projection and replay it from the write store or event log. Rebuild cost grows with history volume, so it must be planned, not discovered under fire.
- **Staleness budget** — The maximum read-after-write lag a query is allowed to show before it must block, retry, or fall back to the write model. Work it out from the longest user flow that reads after its own write and the p99 projection lag; choose block, retry or fall back per query.
- **Read-side replicas and indexing** — Number of read replicas and the indexes on the query store, scaled and shaped independently of the write store to match the read workload.
- **Command idempotency key** — The dedup key that lets a retried command be recognized and applied once. Stale reads (failure 3) provoke retries.

### Signals to watch
<!--meta polarity=signal-->

- **Projection lag** — Gap between the latest committed write and what the read model reflects — measured as events pending or seconds behind.
- **Projection backlog depth** — Count of events queued for a projector but not yet applied; a rising backlog predicts lag.
- **Command-handler p99 latency** — Tail latency of the write path, watched separately from read latency since the two scale under different pressure.
- **Rebuild duration** — Wall-clock time to replay and rebuild a projection from scratch — the number that decides whether a rebuild is a routine op or an outage. Compare it with the staleness budget; a rebuild longer than the budget needs a parallel build and a swap, not an in-place drop.

### Failure modes under load
<!--meta polarity=failure-->

- **Projection lag blows out** — Lag grows for as long as the write rate exceeds projector throughput, so read models fall behind and users see stale data; alert on it.
- **Poison event stalls the projector** — One un-applicable event at the head of an ordered stream blocks every projection behind it until it is skipped or dead-lettered. Dead-letter it with the event id and error, alert on any entry, and replay after a fix; skipping an ordered event can leave the view diverged.
- **Read-after-write anomaly** — A user writes, immediately reads, and does not see their own change — driving confused retries and duplicate submits.
- **Permanent write/read divergence** — If the command and its event are not persisted atomically, a crash between them leaves the read model wrong forever, not just late.

### Readiness checklist
<!--meta polarity=check-->

- Staleness budget is documented, and eventual consistency is made visible in the UI (a processing state) rather than hidden.
- Every projection is rebuildable from the write side, and the rebuild has been run and timed against production-scale history.
- Projectors are idempotent — applying the same event twice leaves the read model identical.
- Command-to-event persistence is atomic (single transaction or an outbox) so the read model cannot diverge permanently.
- Projection lag is monitored with an alert threshold, and poison events dead-letter instead of halting the stream.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Scalability](../../themes/scalability.md) — Scale reads and writes independently {#fluency-scalability}
- [Scaling Writes](../../themes/scaling-writes.md) — Give writes their own model and store {#fluency-scaling-writes}
- [Event Storming](../../themes/event-storming.md) — Read models for the questions the wall raised {#fluency-event-storming}
- [Event Modeling](../../themes/event-modeling.md) — Why the write lane and the read lane differ {#fluency-event-modeling}

<!-- fluency:end -->

## Check yourself
<!--meta block=selfcheck-->

> **What does a reader see right after a write?**
>
> Often a stale value, because the read side catches up eventually, see [con 2](cqrs.md#tradeoffs-con-2).

> **Why is CQRS overkill for a small CRUD app?**
>
> Two models cost more to build and keep in sync than the asymmetry between reads and writes repays, see [con 4](cqrs.md#tradeoffs-con-4).

> **What does the split buy on the read side?**
>
> Query models shaped for the screen they serve, added or rebuilt without touching write logic, see [pro 4](cqrs.md#tradeoffs-pro-4).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Event Sourcing](./event-sourcing.md) — Often paired: write events, project read models
- [Materialized View](../distributed/coordination/materialized-view.md) — The read side is a materialized projection
- [Saga](../distributed/coordination/saga.md) — Sagas often drive read-model updates
- [Minimize Coordination](../../principles/minimize-coordination.md) — Splitting the two paths removes the contention between them
- [Vertical Slice](./vertical-slice.md) — A slice layout makes separate read and write models the cheap default
- [Outbox](../distributed/coordination/outbox.md) — Publishes each change in the same transaction through an outbox so the query model never misses an event

**Composed of**

- [Materialized View](../distributed/coordination/materialized-view.md) — The read model is a materialized view

**Often confused with**

- [Event Sourcing](./event-sourcing.md) — Separate read/write models vs. store events — distinct ideas
- [Command-Query Separation](../../principles/command-query-separation.md) — Command query responsibility segregation (CQRS) lifts command-query separation from methods to models and services.

**Prevents**

- [Monolithic Persistence](../../hazards/monolithic-persistence.md) — Separates the read model from the write store, so one engine no longer serves both shapes
- [Partial Object](../../hazards/partial-object.md) — A read shaped for a screen stops being the domain type, so the domain type keeps its invariants

**Exposed to**

- [Golden Hammer](../../hazards/golden-hammer.md) — Can fall into golden hammer when the read and write split gets adopted by habit in simple create-read-update-delete apps

**Demonstrated by**

- [Ad Click Aggregator](../../designs/ad-click-aggregator.md) — a bursty write model and a query-optimised read model are kept fully apart, scaled on their own terms
- [Metrics & Monitoring](../../designs/metrics-monitoring.md) — constant writes and sporadic expensive reads are physically separated so a query storm can't stall ingestion

<!-- relationships:end -->
