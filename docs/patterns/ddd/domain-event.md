---
title: Domain Event
description: Something meaningful that happened in the domain
area: ddd
owner: Oleksandr Derechei
tags: [domain-modeling, decoupling, immutability]
status: stable
solves: [every time we add a notification I have to edit the checkout code again, "my save method now sends email, updates search, and calls three APIs before returning", the transaction times out because committing also has to wait on a third-party call, the business asked what happened to this order last month and all I have is its current state, two teams both need to know when a payment clears and I call each one by hand]
---

# Domain Event

A fact the domain has already produced — past tense, immutable once raised, and readable by whichever services or contexts care that it happened.

## What it is
<!--meta block=description-->

If an aggregate calls the logger, the cache and every other interested part itself, its transaction swells and each new listener means editing it again. A domain event is a fact that already happened, named in the past tense, such as OrderShipped. The owner records it and publishes it without knowing who listens. Once raised it never changes, and it carries enough data to be understood alone (a thin event trades that for a callback).

## Explained
<!--meta block=explain-->

A domain event is a record that something already happened, named in the past tense, such as OrderShipped, which the owner of the change publishes without knowing who listens. Without it, the owner calls every listener itself and each new one means editing it. Choose it when a change should cause work the owner has no business knowing about, and skip it when a listener in another process must succeed or fail together with the change, because you cannot add that all-or-nothing guarantee afterwards.

- **Delivery** Publish before commit and a rollback leaves a false fact; after commit, a crash loses it. An outbox in the same transaction closes both.
- **Repeat handling** Delivery is at least once, so each handler must give the same result for a repeat, usually by remembering event ids.
- **Contract** A published shape is a contract: add fields, never change them, and let readers ignore unknown fields.

**Example.** Orders marks order 4417 shipped and, in the same transaction, saves an outbox row holding event e-91, OrderShipped for order 4417. A relay that polls once a second publishes it, then crashes before marking the row sent, so it publishes e-91 again. The email handler stores the ids it has seen and skips the second copy, so the customer gets one email. Without the outbox, a crash between the commit and the publish would leave a shipped order with no email and no record. The cost is delay: the email lags the change by about 1 s, longer after a relay crash.

## How it works
<!--meta block=structure-->

```mermaid caption="The aggregate records the event as a side effect of its own behavior; a dispatcher notifies subscribers once the change has committed."
flowchart LR
    Cmd["Command"] -->|"handled by"| Agg["Aggregate"]
    Agg -->|"raises"| Evt["Domain Event, immutable"]
    Evt -->|"appended to"| Log["Uncommitted events"]
    Log -->|"after commit"| Disp["Dispatcher"]
    Disp -->|"notifies"| Sub["Subscribers"]
```

## Variations
<!--meta block=variations-->

- **Notification event (thin)** — Carries only an id and an event type; subscribers call back for the details. Cheap to version, at the cost of a round trip.
- **Event-carried state transfer (fat)** — Carries the full data a subscriber needs to act, so it never has to call back the source at all — decoupled at runtime, but the payload duplicates state and now has its own schema to maintain.
- **[Event Sourcing](../architecture/event-sourcing.md)** — Stop treating the event as a side notification and make it the system of record — the aggregate's current state is only ever a fold over its own event history.
- **Domain event vs. integration event** — Publish a separate versioned integration event built from the domain event, so renaming an internal field never breaks another team.
- **Dispatch timing** — Hand the collected events to in-process handlers just ahead of the commit and their work joins the same transaction, so a handler that throws takes the change down with it: atomic, and coupled again in exchange. An event that leaves the process cannot do that: it waits for the commit, and its reaction lands afterwards or not at all.
- **In-process by default** — Inside one bounded context a domain event can be a plain value object. It becomes an integration event, with a stable versioned public shape, once it crosses to another team's context.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Names the fact that occurred**, so behavior is modeled around what happened rather than requests.
- **Decouples the aggregate** that raises the event from every consumer that reacts to it.
- **New reactions plug in as new subscribers** — the code that raised the event never changes.
- **A persisted stream of them** doubles as an audit trail of what happened and when.

### Cons
<!--meta polarity=con-->

- **Easy to leak persistence-model shape into the event**, coupling subscribers to internals.
- **Delivery and ordering guarantees become the caller's problem** the moment events leave the process.
- **Consumers outside the transaction react after the commit**, so the system is [eventually consistent](../../themes/consistency-and-replication.md), unless an in-process handler runs just before commit.
- **A published event's shape is a contract forever**; schema evolution has to be versioned, not edited.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **An aggregate's state change should trigger side effects** that aggregate shouldn't know about.
- **Multiple parts of the system**, or multiple bounded contexts, need to react to the same occurrence.
- **You want a durable, replayable record** of what happened, not just the current state.

### Avoid when
<!--meta polarity=avoid-->

- **The reaction is purely local and synchronous** — a direct method call is simpler and easier to trace.
- **A subscriber in another process must react** inside the same transaction as the change — once the event leaves the process that atomicity is gone.
- **The "event" is really just an internal** implementation detail nobody outside needs to know about.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an aggregate recording an event"
interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
}

class OrderShipped implements DomainEvent {
  readonly type = "OrderShipped";
  readonly occurredAt = new Date();
  constructor(readonly orderId: string, readonly trackingCode: string) {}
}

class Order {
  private events: DomainEvent[] = [];
  private status: "pending" | "shipped" = "pending";

  constructor(private readonly id: string) {}

  ship(trackingCode: string): void {
    if (this.status === "shipped") return; // no double-shipping
    this.status = "shipped";
    this.events.push(new OrderShipped(this.id, trackingCode));
  }

  // The repository saves the aggregate and these events to an outbox table in one transaction; a relay publishes them.
  pullEvents(): DomainEvent[] {
    const pending = this.events;
    this.events = [];
    return pending;
  }
}
```

## In the wild
<!--meta block=wild-->

- **Axon Framework** — Aggregates publish domain events onto an EventBus; handlers annotated @EventHandler subscribe, and event-sourced aggregates rebuild state by replaying the stream. {#wild-axon-framework}
- **Spring Data @DomainEvents** — An aggregate root extending AbstractAggregateRoot collects events via registerEvent(); when it is saved through a Spring Data repository, methods annotated @DomainEvents are published and @AfterDomainEventPublication clears the pending list. {#wild-spring-data-domain-events}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Payload strategy: thin vs fat** — A thin event carries an id and type and makes subscribers call back; a fat one carries the data they need, trading schema surface for a round trip.
- **Dispatch timing** — Whether in-process handlers run inside the raising transaction, dispatch right after it commits, or ride an outbox written in that same transaction and relayed. Determines whether handler side effects roll back with the aggregate, and whether a rollback can leave a phantom event or a commit can lose one.
- **Event schema version** — An explicit version on the published shape so consumers tolerate change. An unversioned public event cannot evolve without breaking subscribers.
- **Partition or ordering key** — For events that cross the process on a partitioned transport, the key they are partitioned by, which decides what ordering guarantee consumers actually receive.

### Signals to watch
<!--meta polarity=signal-->

- **Dispatch lag** — Time between the commit and the event reaching subscribers — the width of the eventual-consistency window.
- **Failed-handler and dead-letter count** — Events whose handlers threw and were parked or retried. A rising count means a consumer cannot keep up or cannot parse the shape.
- **Consumer backlog** — Undelivered or unprocessed events queued for a subscriber, showing whether reactions are keeping pace with emissions.

### Failure modes under load
<!--meta polarity=failure-->

- **Phantom or lost event** — Dispatch is not tied to the commit, so a rollback leaves a published fact or a crash loses one — subscribers act on something that never durably happened.
- **Schema break** — A published event shape is a contract. An edited or removed field silently breaks every subscriber still deserializing the old shape.
- **Non-idempotent consumer under redelivery** — At-least-once delivery redelivers on failure or timeout, and a handler that is not idempotent double-applies its effect. Fix: record the event id with the effect in one transaction and skip an id already seen.

### Readiness checklist
<!--meta polarity=check-->

- Choose dispatch timing deliberately: run an in-process handler inside the raising transaction when its side effects should roll back with the aggregate, and put anything that must survive the commit or leave the process through an outbox written in that same transaction.
- Version the public event shape and keep changes additive; treat a field change as a new version.
- Make every consumer idempotent, because at-least-once delivery will redeliver.
- Carry the domain fact, not persistence-model fields, so subscribers do not couple to internals.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Event Storming](../../themes/event-storming.md) — The note on the wall, in the past tense {#fluency-event-storming}
- [Event Modeling](../../themes/event-modeling.md) — The fact recorded once the command is accepted {#fluency-event-modeling}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Event-Driven Architecture](../architecture/eda.md) — Domain events are the currency of event-driven architecture (EDA)
- [Saga](../distributed/coordination/saga.md) — Choreographed sagas react to domain events
- [Aggregate](./aggregate.md) — Aggregates emit domain events on change
- [Event Sourcing](../architecture/event-sourcing.md) — Persist the events the domain emits
- [Publish-Subscribe](../messaging/pubsub.md) — Publish domain events to interested parties
- [Bounded Context](./bounded-context.md) — Crossing a context boundary makes it an integration event
- [Outbox](../distributed/coordination/outbox.md) — Write the event in the same transaction as the state change, so a crash cannot lose it and a rollback cannot leave it.

**Part of**

- [Event Sourcing](../architecture/event-sourcing.md) — The log is a sequence of domain events

**Often confused with**

- [Event-Carried State Transfer](../messaging/event-carried-state-transfer.md) — An event that carries enough data for consumers to keep a local copy is this pattern.

<!-- relationships:end -->
