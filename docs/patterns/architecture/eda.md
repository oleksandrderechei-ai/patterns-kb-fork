---
title: Event-Driven Architecture
description: "Components react to events, not direct calls"
area: architecture
owner: Oleksandr Derechei
tags: [event-driven, decoupling, asynchrony]
status: stable
aliases: [EDA, event-driven]
solves: [every time somebody wants to react to a signup I have to edit the signup code, my checkout call blocks for eight seconds waiting on the email service, one team keeps asking us to add just one more call to their new service, a downstream service went down and took our order flow with it, the order function calls fourteen other services and I am scared to touch it]
---

# Event-Driven Architecture

Components communicate by producing and reacting to events — facts about something that already happened — instead of calling each other directly, so publishers and subscribers can be built, deployed, and scaled independently.

## What it is
<!--meta block=description-->

A service that calls its collaborators directly must know their addresses and wait for their replies, so one slow dependent stalls it. Instead, a component announces that something happened, such as an order was placed, and carries on. Other components subscribe to the kinds of event they care about and react on their own time. The producer never calls a consumer.

## Explained
<!--meta block=explain-->

A producer announces a fact and carries on; consumers react on their own time. Choose it over direct calls at the boundaries between services owned by different teams that react to the same facts: you add a reaction without editing the producer, and a slow or dead consumer cannot stall it. Inside one team's synchronous flow it mostly trades a readable call stack for distributed debugging, because the decoupling buys little when one team owns both sides.

- **Write and publish can split.** Write the event in the same transaction and publish from there, as in an \[outbox\](../distributed/coordination/outbox.md).
- **Redelivery.** Record each event ID in the same commit as the change; for an outside call like email, pass it as the idempotency key.
- **No call stack.** Stamp one correlation ID on every event and trace on it.
- **Open payload.** Every subscriber can read it, so decide what goes in as a disclosure choice.

**Example.** An order service publishes OrderPlaced to three consumers: email, inventory and analytics. Email is down for 2 hours while 30 orders a minute arrive, so 3,600 events wait in the queue, and email sends them all when it returns. The order service never noticed. The broker redelivers one event because inventory took longer than its 30-second acknowledgement window, and stock drops by 2 instead of 1. The fix is a table of processed event IDs, written in the same commit as the stock change. The cost is that an unsent email is now found by searching three systems.

## How it works
<!--meta block=structure-->

```mermaid caption="What does the checkout thread wait for? Step 2 only — the broker acknowledging the event. Steps 3 to 5 run on each consumer's own clock against its own offset, which is why a consumer that is down delays nobody and catches up later."
flowchart LR
    Checkout["Checkout service"]
    Orders[("Orders table")]
    subgraph Seam["The broker — neither side knows the other"]
        Topic[("orders topic, retained")]
        DLQ[("Dead-letter queue")]
    end
    Billing["Billing consumer"]
    Warehouse["Warehouse consumer"]
    Analytics["Analytics consumer"]:::ext
    Checkout -->|"1 commit order"| Orders
    Checkout -->|"2 publish OrderPlaced"| Topic
    Topic -->|"3 read at own offset"| Billing
    Topic -->|"4 read at own offset"| Warehouse
    Billing -->|"5 commit offset"| Topic
    Billing -.->|"after N failed retries"| DLQ
    Topic -.->|"subscribes later, replays"| Analytics
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Choreography vs. orchestration** — In choreography every service reacts to events on its own, with no central controller. In orchestration a coordinator — often a saga — tells each participant what to do next. Pure EDA favors choreography; orchestration returns when a business process needs an explicit, auditable sequence.
- **Who owns a multi-step flow** — Choosing between choreography and orchestration also decides who holds the flow's state. Under choreography nobody does, so there is nothing to restart and a broken sequence is found by reconciliation rather than by an alert, which makes it a common source of quiet inconsistency unless a correlation ID and a timeout watcher make stuck flows visible. A coordinator holds that state and can retry or compensate from it, but its own outage stops every flow passing through it.
- **Event notification vs. event-carried state transfer** — A thin event says only "this changed, go fetch details," forcing consumers to call back for the rest. A fat event carries the full new state so consumers never need to. Fatter events cut coupling further but risk staleness and duplicated data across services.
- **[Domain Event](../ddd/domain-event.md) vocabulary** — The events themselves are named and shaped as business facts, not technical deltas — `OrderPlaced`, not `RowUpdated`. This is the vocabulary EDA is built out of.
- **[Publish-Subscribe](../messaging/pubsub.md) transport** — The wiring mechanism underneath: producers publish to a topic, consumers subscribe to it, and a broker handles [fan-out](../messaging/fan-out.md), buffering, and delivery — Kafka, SNS (Simple Notification Service)/SQS, RabbitMQ, EventBridge.
- **[Event Sourcing](./event-sourcing.md) persistence** — Instead of just reacting to events in flight, the event stream itself becomes the system of record — current state is rebuilt by replaying it. A natural, but optional, pairing with EDA.
- **Push subscription vs. durable log** — A push broker tracks subscriptions and delivers each event to each subscriber. Whether a missed event survives depends on the queue behind the subscriber: a topic with no queue drops it, a durable per-consumer queue keeps it until acknowledged, and a durable log appends events in order and keeps them after reading. Log consumers hold their own read position and can rewind, so a log lets a consumer resume after an outage, read history as a new consumer, or reprocess after fixing a bug.
- **How much the consumer has to remember** — Consumers sit on a ladder of increasing state. The simplest reacts to one event and acts. The next correlates a few events by identifier and keeps what it learned from the earlier ones. Above that, a consumer looks for patterns across a series — a moving average over a time window crossing a threshold. At the top, a stream processor transforms the whole flow for a downstream subsystem. Each rung costs more state to hold and more care when an instance dies mid-window.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Producers and consumers** are decoupled in time, space, and identity — add a reaction without touching the source.
- **Consumers scale, deploy** independently of the producer and of each other, and fail independently as long as each has its own subscription or group and a dead-letter queue.
- **Survives partial outages**: a down consumer doesn't block the producer, and queued events catch it up later, provided the outage is shorter than broker retention.
- **Models the domain** as a stream of things that happened, which often matches how the business actually thinks.

### Cons
<!--meta polarity=con-->

- **Hard to trace**: one business flow scatters across independently-deployed handlers with no single call stack.
- **Stale reads everywhere** — [eventual consistency](../../themes/consistency-and-replication.md) is pervasive: consumers see stale state, and races between events are subtle.
- **Debugging and testing require standing** up or simulating a broker; "where did this event come from" often means grepping logs across services.
- **Needs real operational discipline**: schema versioning, idempotent consumers, dead-letter queues, and a plan for duplicate or out-of-order delivery.
- **Open subscription cuts both ways**: whatever a producer publishes is readable by everything attached to the channel, including handlers it was never written for, so what goes into the payload is a disclosure decision and not only a schema one.
- **Ordering holds only per partition or key**, so an event can overtake its predecessor on another. Consumers that need A before B must share a key or tolerate B arriving first.
- **Event granularity has a cost** in both directions and no default. Too fine, and the volume saturates the system and makes the overall flow impossible to follow — worst when a change has to be rolled back. Too coarse, and every consumer wakes up for events it does not care about. Calibrate by asking whether a consumer must open the payload to decide how to respond: if a compliance check publishes only `Compliant` and `NonCompliant`, subscribers filter by event type instead of by inspection.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple, independently-owned parts of the system** need to react to the same fact without the producer knowing who they are.
- **Producers and consumers must be deployed**, scaled, and evolved on separate schedules.
- **The domain is naturally** a stream of things that happened — orders placed, payments captured, inventory changed.

### Avoid when
<!--meta polarity=avoid-->

- **A handful of services** run one synchronous business transaction and the caller needs an immediate, consistent answer.
- **The team can't yet operate** and monitor a broker, retries, and dead-letter handling.
- **There is exactly one consumer** that will ever care — a direct call is simpler and easier to trace.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal in-process event bus"
type Events = {
  OrderPlaced: { orderId: string; total: number };
};

class EventBus<E extends Record<string, unknown>> {
  private handlers = new Map<keyof E, Set<(payload: any) => void>>();

  on<K extends keyof E>(type: K, handler: (payload: E[K]) => void): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler); // unsubscribe
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    // producer never learns who ran, or how many
    for (const handler of this.handlers.get(type) ?? []) handler(payload);
  }
}

const bus = new EventBus<Events>();
bus.on("OrderPlaced", (e) => chargeCard(e.orderId, e.total));
bus.on("OrderPlaced", (e) => notifyWarehouse(e.orderId));

bus.emit("OrderPlaced", { orderId: "o-42", total: 4999 });
```

## In the wild
<!--meta block=wild-->

- **Apache Kafka** — A durable, partitioned commit log where many independent consumer groups read the same stream at their own pace; parallelism is bounded by partition count, ordering is guaranteed only within a partition, and consumers can rewind to any retained offset to replay. {#wild-kafka}
- **AWS EventBridge** — Routes events from producers to any number of subscribed targets using content-based rule matching, with no producer-side knowledge of consumers; failed deliveries can be retried and sent to a dead-letter queue. {#wild-eventbridge}
- **RabbitMQ** — Brokers messages through exchanges that fan a published event out to whatever queues have bound to it by routing key; consumers acknowledge messages and unacked ones are redelivered. {#wild-rabbitmq}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Partition / consumer-group parallelism** — Per-topic throughput is capped by partition count; add partitions and consumers to scale out. Ordering holds only within a partition, so key-to-partition mapping must stay stable. Raising the count later remaps keys, so size it up front from target throughput divided by per-consumer rate, with headroom.
- **Delivery semantics and ack mode** — At-least-once vs at-most-once, manual vs automatic acknowledgement. Chooses which side of the duplicate-versus-loss tradeoff the system lives on.
- **Retry policy and dead-letter queue** — Max attempts, backoff schedule, and the destination where a message that keeps failing is parked instead of blocking the stream. Size the retry window from the longest transient outage you accept, then park the message with its error and original headers kept for replay.
- **Event retention** — How long the broker keeps events (log retention or queue time to live (TTL)), which bounds how far a new or lagging consumer can rewind and replay.
- **Consumer prefetch / max in-flight** — Number of unacknowledged messages a consumer buffers at once — the dial between throughput and memory pressure per consumer.

### Signals to watch
<!--meta polarity=signal-->

- **Consumer lag** — Offset gap between the latest produced event and the last one a consumer group has committed. Shows directly that consumers are falling behind; pair it with end-to-end latency, because a stuck poison message can hide behind a flat lag.
- **Dead-letter queue depth** — Count of messages that exhausted their retries. A non-zero and rising DLQ is a stuck workflow, not noise.
- **End-to-end latency** — Time from an event being produced to it being processed — what users feel through an event-driven flow.
- **Redelivery / duplicate rate** — How often the same message is delivered more than once, which tells you how hard your idempotency layer is working.

### Failure modes under load
<!--meta polarity=failure-->

- **Consumer lag grows unbounded** — Producers outpace consumers; the backlog climbs, latency stretches, and if it crosses the retention window unread events are silently dropped.
- **Poison message** — A message that always fails cycles through retries, either blocking its partition or flooding the dead-letter queue. Park it in the dead-letter queue after the retry limit with its error attached, then replay it once the consumer is fixed.
- **Duplicate processing** — At-least-once redelivery double-applies side effects — a second charge, a second email — whenever a consumer is not idempotent.
- **Out-of-order delivery** — Retries and cross-partition fan-out mean events arrive in a different order than they happened, breaking handlers that assumed sequence.

### Readiness checklist
<!--meta polarity=check-->

- Consumers are idempotent — a dedup key or processed-id table makes redelivery a no-op.
- Every subscription has a dead-letter queue with an alert on its depth.
- Consumer lag is monitored per group with a threshold that pages before retention is breached.
- Event schemas are versioned with a compatibility policy, and consumers tolerate unknown fields.
- Retention is set long enough to survive the longest expected consumer outage or replay.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Architecture Styles](../../themes/architecture-styles.md) — Producers assert facts, consumers react on their own clock {#fluency-architecture-styles}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Domain Event](../ddd/domain-event.md) — Domain events are the currency of event-driven architecture (EDA)
- [Event Sourcing](./event-sourcing.md) — Sourced events can also drive reactions
- [Design for Evolution](../../principles/design-for-evolution.md) — Events let new behaviour attach without editing what emits them

**Alternative to**

- [Web-Queue-Worker](./web-queue-worker.md) — A continuous stream handled as it arrives fits here; discrete slow jobs behind one queue are Web-Queue-Worker.

**Composed of**

- [Publish-Subscribe](../messaging/pubsub.md) — Event-driven systems are wired with pub/sub

**Exposed to**

- [Dual-Write Inconsistency](../../hazards/dual-write-inconsistency.md) — Publishing the event and writing the state are two calls, and one can fail

**Demonstrated by**

- [CamelCamelCamel](../../designs/camelcamelcamel.md) — replacing full-table poll scans with per-event who-cares reaction is the event-driven shift that meets the sub-hour alert service level agreement (SLA)

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Managed event buses give you the delivery and routing, and you write the producers and consumers.

<!-- relationships:end -->
