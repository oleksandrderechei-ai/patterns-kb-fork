---
title: Event-Carried State Transfer
description: "Events carry the data consumers need, so each keeps a local copy and never calls the owner back; Fowler's name for it"
area: messaging
owner: Oleksandr Derechei
tags: [event-driven, decoupling, availability]
status: stable
aliases: [ECST, state transfer event, fat event]
solves: ["every service calls the customer service to read data, so when it is down they all fail", after each change event our consumers call back for the data and flood the owning service, checkout needs product and customer data but must still work while the other service restarts, one service joins its tables with another team data and needs a fast local copy kept in sync]
---

# Event-Carried State Transfer

Event-carried state transfer puts the changed data inside the event, so each consumer keeps its own copy and never calls the owning service to ask for it.

## What it is
<!--meta block=description-->

When every consumer calls the owner back for the data it needs, the owner's outage or read load reaches all of them. Event-carried state transfer puts the changed data inside the event: the owner publishes the new state on every change, and each consumer applies it to a local table and reads its own copy. The cost is a copy that is always a little behind, so the owner can fail without stopping the consumers.

## Explained
<!--meta block=explain-->

Event-carried state transfer puts the changed data inside the event. The service that owns a record publishes the new state on every change, and each consumer applies it to its own local table and reads from that table later, so it does not call the owner for routine reads. Martin Fowler named it as one of four meanings of event-driven. Choose it over event notification, where the event only says that something changed, when consumers must keep working while the owner is down, or when callbacks would hit the owner several times harder than the writes do.

- **Lag.** Copies run behind, so use it only where seconds of lag are fine and ask the owner for the cases that are not.
- **Repeats and disorder.** Events can repeat or arrive out of order, so carry a version number and ignore any event that is not newer.
- **Public contract.** Version the event, send only needed fields, publish delete events and keep sensitive fields out.
- **New consumers.** They need the history, so keep a compacted topic (a log that keeps only the latest event per key) or republish a snapshot.

**Example.** A catalogue service has 2 million products, and the cart, search and pricing services each need name and price. Each change publishes one 400-byte event with the full record and version. With callbacks, a nightly import of 500,000 changes makes 3 consumers call the catalogue 1.5 million times. With state transfer, the import is 500,000 events and zero calls, though each copy lags while its consumer drains them. When the catalogue is down for 20 minutes, the cart still shows prices from its copy. The cost: with 2 s of lag, a price changed 1 s ago still shows the old value in the cart, so checkout rechecks the price with the owner.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a consumer get data without asking the owner? The owner saves at 1 and publishes the full record at 2, the topic delivers it at 3, the consumer stores it in its own table at 4, and every later read at 5 stays inside the consumer."
flowchart LR
    subgraph Own["Customer service"]
        DB[("Customers table")]
    end
    T["customer-changed topic"]
    subgraph Con["Order service"]
        R[("Local customer copy")]
        L["Order logic"]
    end
    DB -->|"1 save, version 8"| DB
    DB -->|"2 publish full record"| T
    T -->|"3 deliver event"| R
    R -->|"4 upsert if newer"| R
    L -->|"5 read local copy"| R
```

1. The owner commits a change to its own table. The record gets a version number.
2. The owner publishes an event with the whole record or the fields consumers need, plus the version. Use the [outbox](../distributed/coordination/outbox.md) so the save and the publish cannot disagree.
3. The topic delivers the event to every subscriber, in the order of the record's key.
4. The consumer upserts the record into its table, and ignores any event whose version is not newer than the stored one.
5. Business logic reads the local table. The owner is not called, so its outage does not stop the consumer.

```mermaid caption="What goes wrong when events arrive twice or out of order, and what the version check does about it. The older event 7 arrives after 8, and the consumer drops it instead of overwriting newer data."
sequenceDiagram
    autonumber
    participant O as Owner
    participant C as Consumer
    O->>C: customer 42, version 7, address Oak St
    Note over C: stored version 7
    O->>C: customer 42, version 8, address Elm St
    Note over C: stored version 8
    O-->>C: redelivery of version 7
    Note over C: 7 is not newer than 8, ignore
```

## Variations
<!--meta block=variations-->

- **Full-state event** — each event holds the whole record, so the consumer needs no earlier event to make sense of it. Events are larger, and a missed event heals at the next one for the same key. A record that is not changed again stays wrong until a resync.
- **Delta event** — the event holds only the changed fields. It is smaller, but a consumer that misses one is wrong until a resync, so it needs ordered, gap-free delivery.
- **Compacted topic as the snapshot** — a log that keeps only the latest event per key doubles as the full dataset, so a new consumer reads it from the start to build its copy. Kafka log compaction does this. It works only with full-state events; with delta events compaction drops the earlier changes and the rebuilt copy is wrong. Older events for a key stay until compaction runs, so the version check still applies.
- **Subset of fields** — the event carries only what consumers need, which keeps private fields inside the owner and shrinks the contract. The cost is a new event version each time a consumer needs one more field.
- **Event notification plus fetch** — the event carries an id and the consumer calls back. This is the opposite choice, used when data is large or sensitive, at the price of the callback coupling.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Owner outage does not reach consumers** — they read local data, so a down or slow owner stops new updates but not existing reads.
- **No read traffic back to the owner** — a burst of changes does not become a burst of callbacks, so the owner is sized for writes plus a few fresh reads and snapshot republishes, not for every consumer read.
- **Fast local reads** — a consumer joins the data with its own tables in one query instead of a network call.
- **Easy to add a consumer** — a new team subscribes and builds its copy, and the owner changes nothing as long as the copy needs only the current fields and history is still retained; otherwise it republishes a snapshot.

### Cons
<!--meta polarity=con-->

- **Replicas are stale** — a consumer sees a change after the event arrives, so each consumer must accept that delay or ask the owner for the cases that cannot.
- **The event is a public contract** — every field in it is read by someone, so a rename or a removed field needs versioning and a migration.
- **Data is copied everywhere** — each copy is storage to pay for, and a privacy deletion has to reach every consumer through a delete event.
- **Order and duplicates matter** — a redelivered or reordered event can overwrite newer data, so you add a version check and a consumer that tolerates repeats.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Consumers must work when the owner is down** — the cart shows product prices and the order shows customer addresses from the copy while the owner restarts; a step that needs the latest value still waits for the owner.
- **Many consumers read the same data often** — callbacks would put the owner under load several times the write rate.
- **Consumers can accept seconds of lag** — a copy a second behind is fine for shipping addresses and display names.

### Avoid when
<!--meta polarity=avoid-->

- **A consumer must see the latest value** — a stock count or balance checked at the moment of purchase should ask the owner, or use a [conditional write](../distributed/coordination/conditional-write.md) against it.
- **Only a few consumers need an occasional field** — an event that names the changed record, with a fetch on demand, is smaller and easier to change.
- **The data is sensitive or very large** — copying it widens the exposure and the storage bill, so share a reference and fetch under the owner's access control.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a consumer that keeps a local customer copy and ignores stale or repeated events"
type CustomerChanged = {
  type: "customer-changed" | "customer-deleted";
  id: string;
  version: number;          // the owner's counter for this record
  name?: string;            // a change event carries the full state (name and address)
  address?: string;
};

type Copy = { version: number; deleted: boolean; name?: string; address?: string };
const customers = new Map<string, Copy>();

export function onCustomerEvent(e: CustomerChanged) {
  const current = customers.get(e.id);
  if (current && e.version <= current.version) return;   // stale or duplicate, even after a delete
  if (e.type === "customer-deleted") {
    // keep a tombstone with the delete's version; purge it only after the longest redelivery delay
    customers.set(e.id, { version: e.version, deleted: true });
    return;
  }
  customers.set(e.id, { version: e.version, deleted: false, name: e.name!, address: e.address! });
}

// Order service reads its own copy, never the customer service.
export function shippingAddress(customerId: string) {
  const c = customers.get(customerId);
  return c && !c.deleted ? c.address : undefined;   // undefined: not replicated yet or deleted; retry or fetch from the owner
}
```

## In the wild
<!--meta block=wild-->

- **Martin Fowler, What do you mean by Event-Driven?** — The 2017 article that names event-carried state transfer and sets it against event notification, event sourcing and command query responsibility segregation (CQRS). {#wild-fowler}
- **Apache Kafka log compaction** — A topic can keep the latest record per key, so a compacted topic holds the current state of every entity and a new consumer can build a full copy from it. {#wild-kafka-compaction}
- **Debezium change events** — Change events from a database carry the row state before and after the change, so consumers can build local copies from them. {#wild-debezium}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **event contents** — Which fields go in the event. Fewer fields mean a smaller contract and less private data copied, but more versions when consumers need more.
- **partition key** — Use the entity id as the key so all events for one record are ordered and a version check can work.
- **retention or compaction** — How long events stay available. A compacted topic lets a new consumer build a full copy, but only with full-state events; plain time-based retention does not. Set it longer than the longest consumer outage or rebuild you accept, and keep delete tombstones for the same window.
- **version field** — A per-record counter or timestamp the consumer compares to drop stale and repeated events. Take it from the single writer for each record (a row version or sequence), not from consumer or wall clocks, which can skew and reject real updates.

### Signals to watch
<!--meta polarity=signal-->

- **consumer lag** — How far the consumer is behind the topic; it is the staleness of the local copy. Alert when it nears the seconds of lag the consumers accepted, not at a fixed number.
- **stale events dropped** — A rising count means reordering or redelivery, and shows the version check is working.
- **copy age at read time** — How old the record a decision used was, for the decisions that care.
- **deserialisation or schema errors** — A spike after a release shows an event change that a consumer cannot read.

### Failure modes under load
<!--meta polarity=failure-->

- **older event overwrites newer** — Without a version check, a redelivered or reordered event rolls the local copy back.
- **new consumer has no history** — Retention dropped old events, so the new copy starts empty or partial until you republish a snapshot. When joining a snapshot to the live stream, record its version or offset, start the live read from there and let the version check absorb the overlap.
- **schema change breaks readers** — The owner renames a field and consumers fail or store nulls, because the event is a shared contract.
- **deleted data lives on** — A delete is never sent or never applied, so a copy keeps data that must be gone. Applying a delete by removing the row is also a hole: an older event arriving later brings the record back, so keep a versioned tombstone until retention passes.

### Readiness checklist
<!--meta polarity=check-->

- Every event carries the record id and a version
- The event is published through an outbox so the save and the event cannot disagree
- Consumers ignore events that are not newer and tolerate repeats
- A new consumer can build its copy from a compacted topic or a snapshot
- Delete events exist and consumers apply them
- Decisions that need the latest value read from the owner

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Microservices Design](../../themes/microservices-design.md) — Events carry the data so consumers keep a local copy {#fluency-microservices-design}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Publish-Subscribe](./pubsub.md) — The topic delivers the full-state events to every consumer that keeps a copy.
- [Outbox](../distributed/coordination/outbox.md) — Publish the state event through an outbox so the save and the event cannot disagree.
- [Idempotency](./idempotency.md) — Consumers must tolerate repeats and stale versions when applying state events.
- [Materialized View](../distributed/coordination/materialized-view.md) — The events are one way to feed a local view of the owner's data.

**Alternative to**

- [Event Sourcing](../architecture/event-sourcing.md) — Here the owner keeps its table and events are copies sent out, not the record of truth.
- [Content Enricher](./content-enricher.md) — Puts the needed data in the event itself, so a consumer needs no lookup

**Often confused with**

- [Domain Event](../ddd/domain-event.md) — A domain event may carry only an id; this pattern puts the data in the event so consumers keep a copy.

<!-- relationships:end -->
