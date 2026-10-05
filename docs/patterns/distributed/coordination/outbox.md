---
title: Outbox
description: Writes the event and the state change in one local transaction
area: distributed-data
owner: Oleksandr Derechei
tags: [messaging, decoupling]
status: stable
aliases: [transactional outbox]
solves: [my database commit succeeded but the event never reached the broker, the broker was down for a second and we silently lost the notification, "I published a message and then the transaction rolled back, so downstream believes something that never happened", other services are missing updates and I cannot tell which ones got dropped, I need the write and the message to happen together but they are two different systems]
favourite: true
---

# Outbox

Commits the state change and the event that announces it in a single local transaction, then hands the event to a relay that publishes it at least once — so the write and its notification can never drift apart, even if the broker is unreachable at the moment of commit.

## What it is
<!--meta block=description-->

A service's database and its message broker share no transaction, so saving a change and announcing it can fail apart: the event is lost or announces something rolled back. An outbox is a table in the service's own database. The service writes the message in the same transaction as the change, and a relay publishes it afterwards, retrying until it lands.

## Explained
<!--meta block=explain-->

An outbox is a table in your own database where you write the message to be sent in the same transaction as the change it announces. A separate relay process then reads unsent rows, publishes them to the broker, and marks them sent, retrying until they land. Without it you face two bad branches: commit and then publish, and a crash between them loses the message with no error anywhere; publish and then commit, and a rollback announces something that never happened. Choose it over publishing straight from the request handler when a lost message is a correctness bug, because a database row can be retried for hours while a handler gets one attempt.

- **At-least-once delivery.** A relay that dies after publishing but before marking publishes again. Give every message an id so consumers skip repeats.
- **Growing table.** It sits on the write path. Delete sent rows and index the unsent ones.
- **Order per key only.** Pick the key, such as the order id, on purpose.

**Example.** A service takes 200 orders a second. For order 8812 it inserts the order row and an outbox row, with its own message id 55021, in one transaction. A relay polls every 500 ms for up to 100 unsent rows, publishes them and marks them sent. That ceiling is 200 rows a second, the write rate, so a burst grows the backlog; size batch or interval for peak load. If it crashes after publishing but before marking, it publishes message 55021 again on restart, and the consumer skips that id as already handled. The table gains 17.3 million rows a day, so a nightly job deletes sent rows older than a day, or the poll scans dead rows.

## How it works
<!--meta block=structure-->

```mermaid caption="How does the order's event reach another service without a distributed transaction? Steps 1 and 2 commit together or not at all; the relay picks up from there, and marks the row only once the broker has taken it — which is why a crash between 4 and 6 delivers twice."
flowchart LR
    Svc["Order Service"]
    subgraph Tx["One atomic transaction"]
        Orders[("Orders table")]
        Outbox[("Outbox table")]
    end
    Relay["Relay"]
    Broker[("Broker")]:::ext
    Consumer["Shipping Service"]:::ext
    Svc -->|"1 write order"| Orders
    Svc -->|"2 insert event"| Outbox
    Relay -->|"3 read unpublished"| Outbox
    Relay -->|"4 publish"| Broker
    Broker -->|"5 deliver"| Consumer
    Relay -->|"6 mark published"| Outbox
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The service's write and its event commit together, in the same local transaction. A relay, running independently, drains the outbox to the broker and only then marks each row done."
sequenceDiagram
    autonumber
    participant Svc as Service
    participant DB as Local database
    participant Rel as Relay
    participant MQ as Broker
    Svc->>DB: insert business row + outbox row, one transaction
    DB-->>Svc: commit
    Rel->>DB: poll unpublished outbox rows
    alt broker reachable
        Rel->>MQ: publish message
        MQ-->>Rel: ack
        Rel->>DB: mark row published
    else broker down or crash before ack
        Rel--xMQ: publish fails
        Note over Rel,DB: row stays unpublished, retried next poll
    end
```

## Variations
<!--meta block=variations-->

- **Polling relay** — A process periodically queries the outbox for unpublished rows and publishes them, marking or deleting each row once the broker has taken it. It sees only committed rows, so a rolled-back write publishes nothing. Scanning in timestamp and sequence order gives write order only per aggregate key, and a transaction that commits late can still be passed over. Simple to build and reason about, at the cost of polling latency and steady read load on the table.
- **Transaction log tailing ([change data capture (CDC)](./change-data-capture.md))** — A connector like Debezium tails the database's [write-ahead log](./write-ahead-log.md) or binlog directly and turns each outbox insert into a broker message with no polling and near-zero added latency.
- **[Event Sourcing](../../architecture/event-sourcing.md)** — When every write is already an appended event, the event store doubles as the outbox — there's no separate table, because the write is the thing to publish.
- **Shared vs. per-aggregate outbox table** — One outbox table serves the whole service, or each aggregate gets its own — the latter isolates hot tables and lets ordering guarantees stay scoped to one aggregate's stream.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Solves the dual-write problem** with a single local ACID transaction — no distributed transaction coordinator needed.
- **Gives at-least-once delivery** while the relay runs and unpublished rows are kept: a broker outage at commit time loses nothing, only delays it.
- **Recovery is just retrying unpublished rows** — no special failure-handling logic in the request path.
- **Works with any relational database and any broker**; it's a pattern, not a product.

### Cons
<!--meta polarity=con-->

- **Adds a table**, a relay process, and one more moving part to deploy and monitor.
- **Delivers at-least-once, not exactly-once** — consumers must dedupe or tolerate replays.
- **Polling relays add publish latency** and steady read load — shorten the interval only as far as the table can carry it, or move to log tailing and accept operating the connector.
- **The outbox table grows unbounded** without its own archiving or cleanup job.
- **Ordering survives only as wide** as the key the relay scans and the broker groups by: one global stream serialises aggregates that have nothing to do with each other, and a per-row key drops the sequence you wanted — choose the aggregate key deliberately and pay for it in per-key throughput.
- **A row the broker keeps rejecting stalls its key** in an ordered relay: cap retries, park the row as failed and alert, and decide whether later rows for that key wait.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A service must update** its own data and reliably announce that change to other services or a broker.
- **You need at-least-once delivery** that survives a crash or a broker outage right after commit.
- **The database and the message** broker are separate systems with no shared transaction between them.

### Avoid when
<!--meta polarity=avoid-->

- **Nothing outside the service's own** transaction needs to know about the change.
- **An occasional missed notification** is acceptable and the extra table and relay aren't worth running.
- **Delivery volume and stakes** are low enough that a direct, synchronous call is simpler and fast enough.
- **The log or event store** is already the source of truth: prefer [event sourcing](../../architecture/event-sourcing.md) when every write is an appended event, or [change data capture](./change-data-capture.md) alone when a connector can read the database log without a table.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the order and the message about it, in one commit"
// One transaction, two rows: the change, and the message announcing it.
await db.transaction(async (tx) => {
  await tx.orders.insert(order);
  await tx.outbox.insert({
    topic: "order.placed",
    payload: JSON.stringify(order),
    published: false,
  });
});                       // both rows land, or neither does

// Elsewhere, on its own schedule: deliver whatever has not gone yet.
for (const row of await db.outbox.unpublished(100)) {
  await broker.publish(row.topic, row.payload);
  await db.outbox.markPublished(row.id);   // crash here and it is sent again
}
```

```typescript summary="TypeScript — a flow transition, its webhook event, and a relay"
// Same local transaction: flow state change + outbox row
async function clearFlow(tx: Transaction, flowId: string, personaId: string) {
  await tx.query(
    "update flow set state = $1 where id = $2",
    ["cleared", flowId],
  );
  // outbox also has a seq bigserial column the database assigns; the UUID id gives no write order.
  await tx.query(
    `insert into outbox (id, flow_id, topic, payload, published)
     values ($1, $2, $3, $4, false)`,
    [randomUUID(), flowId, "persona.cleared",
     JSON.stringify({ flowId, personaId, state: "cleared" })],
  );
  // Both rows commit together, or neither does. Nothing can leave the
  // flow cleared while the client is never told.
}

// Relay: runs independently, drains unpublished rows.
// One transaction, so the row claim (for update skip locked) holds until
// the rows are marked; a second relay instance skips the claimed rows.
async function relayOnce(db: Db, webhooks: WebhookSender) {
  await db.transaction(async (tx) => {
    const rows = await tx.query(
      `select * from outbox where published = false
       order by seq limit 100 for update skip locked`,
    );
    for (const row of rows) {
      await webhooks.deliver(row.topic, row.payload);
      await tx.query(
        "update outbox set published = true where id = $1",
        [row.id],
      );
    }
  });
}
```

## In the wild
<!--meta block=wild-->

- **Debezium** — Its Outbox Event Router SMT (io.debezium.transforms.outbox.EventRouter) tails the database WAL/binlog and expands each outbox insert into a broker message, routing on the aggregatetype column and using aggregateid as the Kafka key so per-aggregate ordering is preserved — no polling, near-zero added latency. {#wild-debezium}
- **Amazon DynamoDB Streams** — AWS documents this as the change-data-capture route to the same guarantee: enable streams on the table and the item-level change carries the event itself, so there is no second table to keep in step. The stream records those changes as a time-ordered sequence, and a Lambda function polls it and forwards each new record to a Simple Queue Service (SQS) queue for the consuming service. {#wild-dynamodb-streams}
- **MassTransit** — The .NET messaging library ships a transactional outbox: AddEntityFrameworkOutbox persists messages in an OutboxMessage table inside the same EF Core SaveChanges as the business write, and a delivery service sweeps and publishes them, with duplicate-detection to guard replays. {#wild-masstransit}
- **CAP** — Writes published events into a table inside the same database transaction as the business change, then relays them to the broker and tracks delivery — including the consumer-side received table that makes redelivery idempotent. {#wild-cap}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Relay poll interval** — For a polling relay, how often it scans for unpublished rows. Shorter cuts publish latency but raises steady read load on the outbox table; log-tailing (CDC) sidesteps the tradeoff entirely.
- **Fetch batch size** — Rows drained per relay iteration (the LIMIT in the poll query). Larger batches amortize round-trips but hold locks longer and enlarge the replay window on a mid-batch crash.
- **Ordering and dedup keys on the published message** — The key the broker orders within (SQS first in, first out (FIFO) MessageGroupId, a Kafka partition key) and the key it dedupes on (SQS FIFO MessageDeduplicationId, deduplicated over a 5-minute interval). Scope the group too wide and unrelated aggregates queue behind each other; too narrow and per-aggregate order is lost. After the 5-minute window the broker dedupes nothing, so consumer-side dedupe still applies.
- **Cleanup / retention cadence** — How aggressively a job deletes or archives already-published rows, which sets the steady-state size of the table the relay polls. Keep whatever window your replay and audit stories actually need, and no more.
- **Delivery retry / backoff** — How the relay retries a row the broker rejected before moving on, and how long it backs off, so a broker blip does not spin the relay hot.

### Signals to watch
<!--meta polarity=signal-->

- **Outbox backlog depth** — Count of rows with published = false. Steady growth means the relay is not keeping up with write volume.
- **Publish lag** — Time between a row insert and its mark-published. The end-to-end latency other services see; dominated by poll interval for a polling relay.
- **Outbox table size / dead-row count** — Total rows and un-vacuumed published rows. Rising size signals the cleanup job is behind and poll scans are getting more expensive.
- **Broker delivery error rate** — Failed publishes per interval. A sustained rise is what precedes an exploding backlog.

### Failure modes under load
<!--meta polarity=failure-->

- **Relay falls behind** — Write bursts outrun the relay and backlog grows without bound; downstream services see ever-later events. Scale the relay or shard the outbox by aggregate.
- **Duplicate delivery** — The relay crashes after publishing but before marking the row published; on restart it republishes. At-least-once is inherent — consumers must dedupe.
- **Table bloat stalls polling** — Cleanup lags and the poll query scans millions of published rows, driving its own latency up and worsening the backlog it was meant to drain.
- **Concurrent relays double-publish** — Scaled out for throughput, two relay instances select the same unpublished rows in the same window and both deliver them, so the duplicate rate rises exactly when volume does.

### Readiness checklist
<!--meta polarity=check-->

- A partial index on published = false keeps the poll query fast as the table grows
- The relay scans in sequence order and publishes with the aggregate key as the ordering key, so write order holds per key only; a transaction that commits late can still be passed over, so consumers tolerate a gap or a reorder
- The cleanup job is itself monitored — a silently dead one looks exactly like a healthy one until the poll slows down
- Consumers dedupe on message id — the pattern is at-least-once, never exactly-once
- Only one relay can claim a given row (SKIP LOCKED, lease, or single instance)
- Backlog depth and publish lag are monitored with an alert on sustained growth

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Consistency & Replication](../../../themes/consistency-and-replication.md) — Make the event and the write atomic {#fluency-consistency-and-replication}
- [Multi-Step Processes](../../../themes/multi-step-processes.md) — Emit step events atomically with the state change {#fluency-multi-step-processes}
- [Microservices Design](../../../themes/microservices-design.md) — Commit the state change and its event together {#fluency-microservices-design}
- [Data Platform](../../../themes/data-platform.md) — Close the gap between the store and the broker {#fluency-data-platform}

<!-- fluency:end -->

## Check yourself
<!--meta block=selfcheck-->

> **Which failure does the outbox remove?**
>
> The dual write, where the database commits but the broker publish is lost, see [pro 1](outbox.md#tradeoffs-pro-1).

> **Why must consumers of an outbox be idempotent?**
>
> Delivery is at least once, so a relay retry can replay an event, see [con 2](outbox.md#tradeoffs-con-2).

> **What grows without bound if you forget it?**
>
> The outbox table, unless a job archives or deletes published rows, see [con 4](outbox.md#tradeoffs-con-4).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Event Sourcing](../../architecture/event-sourcing.md) — Append the event, publish reliably
- [Saga](./saga.md) — Publish each saga step reliably via the outbox
- [Message Queue](../../messaging/message-queue.md) — A relay drains the outbox to the broker
- [Claim Check](../../messaging/claim-check.md) — Relay the reference, not the payload
- [Minimize Coordination](../../../principles/minimize-coordination.md) — The outbox removes the coordination a dual write would otherwise need
- [Functional Partitioning](../routing/functional-partitioning.md) — Publishing across a functional boundary is the case it exists for: two stores, one atomic write
- [Web-Queue-Worker](../../architecture/web-queue-worker.md) — The front-end-writes-then-enqueues sequence is the classic place this gap opens.
- [Publish-Subscribe](../../messaging/pubsub.md) — The outbox makes publishing atomic with the write
- [CQRS](../../architecture/cqrs.md) — The relay that drains an outbox is how a command query responsibility segregation (CQRS) read model stays fed without a lost event
- [Event-Carried State Transfer](../../messaging/event-carried-state-transfer.md) — An outbox is the safe way to emit state-carrying events.

**Alternative to**

- [Change Data Capture](./change-data-capture.md) — Write events transactionally to a table instead of tailing the database log

**Requires**

- [Idempotency](../../messaging/idempotency.md) — Delivery is at least once, so consumers must dedupe the replayed messages the relay can send twice

**Often confused with**

- [Inbox](./inbox.md) — Opposite direction: outbox publishes reliably, inbox receives reliably

**Prevents**

- [Dual-Write Inconsistency](../../../hazards/dual-write-inconsistency.md) — Removes the second write, so nothing is lost in the gap
- [Distributed Monolith](../../../hazards/distributed-monolith.md) — Publishing atomically with the state change lets a caller send an event instead of waiting on a synchronous call, so the chain can go.

**Exposed to**

- [Retry Storm](../../../hazards/retry-storm.md) — Can fall into retry storm when a relay that republishes after a failure floods a recovering broker

**Demonstrated by**

- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — committing a know your customer (KYC) flow's state transition and its client webhook event in one transaction, so a crash can never separate what happened from what the client is told
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — a case study where the pattern's guarantee is kept without its table — an append-only record with a client-visible flag and a per-flow cursor is the relay's whole queue

**Implemented by**

- [Messaging & Eventing](../../../capabilities/messaging.md) — Change data capture can read the outbox table and publish its rows, so you do not write the relay.

<!-- relationships:end -->
