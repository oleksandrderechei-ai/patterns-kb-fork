---
title: Inbox
description: "Persists a received message and applies its effects in one local transaction, then acknowledges safely"
area: distributed-data
owner: Oleksandr Derechei
tags: [messaging, decoupling]
status: stable
aliases: [idempotent receiver, transactional inbox, received event log, inbound outbox]
solves: [I received a message but my database commit rolled back and I cannot tell if I already processed it, a message arrived twice and both times updated my state so now I have duplicate orders, "my service crashed mid-process and the message came again, and I cannot tell what I already applied", the broker confirmed delivery but my write failed and now I have lost or orphaned messages, I need recording a message as received and applying its change to succeed or fail together]
favourite: true
---

# Inbox

The receiving half of the dual-write problem, closed by making the record of a message and the work it asks for a single commit. The acknowledgement waits for that commit, so a crash costs a redelivery — which the record recognises — rather than a lost or doubled effect.

## What it is
<!--meta block=description-->

A service's database and its message broker share no transaction, so a crash between doing the work and acknowledging a message either loses it or runs the work twice. An inbox is a table in the service's own database. The service saves the message id and the work in one transaction and acknowledges only after commit, so a redelivery is recognised and skipped.

## Explained
<!--meta block=explain-->

An inbox is a table in your service's own database that records each message you have received, written in the same transaction as the work the message asks for. You acknowledge the message to the broker only after that transaction commits. If you crash before the commit, the broker sends the message again and the work happens once. If you crash after the commit but before the acknowledgement, the resend finds its id already in the table and is skipped. Choose it when the sender promises at-least-once delivery (it may send twice but not lose a message) and a repeat effect, such as a second shipment, is costly. The broker's own dedup window does not cover a crash between the effect and the acknowledgement.

- **Handlers can still run twice.** Make them safe to repeat, and test with a staged duplicate.
- **The table grows.** Delete rows once the dedup window has passed.
- **Sender-supplied ids.** Reject two different bodies under one id, or the second is silently dropped.

**Example.** Message m-901 says order 55 is paid. Your handler inserts m-901 into the inbox and marks order 55 paid in one transaction, commits, then crashes before acknowledging. The broker sends m-901 again, the insert hits the unique id and is skipped, and the handler acknowledges without a second shipment. At 100 messages a second and a 7-day dedup window, the table holds up to 60.5 million rows, so a nightly job deletes rows older than 7 days.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a message the broker may deliver twice land its effect once? Steps 2 and 3 commit together or not at all, and the acknowledgement in step 4 only goes out after they do."
flowchart LR
    Broker[("Broker")]:::ext
    Svc["Consumer service"]
    subgraph Tx["One atomic transaction"]
        Inbox[("Inbox table")]
        Orders[("Orders table")]
    end
    Cleanup["Cleanup job"]
    Broker -->|"1 deliver"| Svc
    Svc -->|"2 record message id"| Inbox
    Svc -->|"3 apply the effect"| Orders
    Svc -->|"4 ack, only after commit"| Broker
    Cleanup -->|"5 age out old rows"| Inbox
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Crash before the ack and the broker redelivers; the inbox row marks the duplicate, and the service acknowledges without re-applying anything."
sequenceDiagram
    autonumber
    participant MB as Broker
    participant Svc as Service
    participant DB as Local database
    MB->>Svc: deliver message (at-least-once)
    alt message id not seen before
        Svc->>DB: insert inbox row + business row, one transaction
        DB-->>Svc: commit
        Svc->>MB: ack message
    else duplicate message id
        Svc->>MB: ack, skip re-processing
    end
    Note over Svc,MB: crash before ack? message stays unacknowledged at the broker
    MB->>Svc: redeliver after visibility window
    Svc->>DB: message id already recorded
    Svc->>MB: ack, effects already applied
```

## Variations
<!--meta block=variations-->

- **Synchronous processing** — The handler processes the message immediately, inside the same request. The message and result commit together. Fast and simple, but if processing is slow it blocks the connection and handler timeouts become hazardous.
- **Deferred processing** — The handler writes the message to the inbox and returns immediately, delegating processing to a background job. The inbox row tracks progress; the job polls for unprocessed rows and applies them. Decouples latency and reduces timeout risk.
- **Per-aggregate inbox** — Each aggregate (domain object) gets its own inbox table instead of a shared one. This partitions dedup and polling and keeps hot tables from blocking each other; it does not order messages, so ordering still comes from the broker.
- **[CDC (Change Data Capture)](./change-data-capture.md)** — A tool like Debezium tails the database's [write-ahead log](./write-ahead-log.md) and turns each inbox insert into a message to a processing topic or trigger, eliminating the processing poll.
- **Broker-side deduplication** — Some brokers drop the duplicate for you inside a window — SQS (Simple Queue Service) FIFO (first in, first out) queues deduplicate on a message deduplication id over a five-minute interval. That covers a publisher that retried its send, but not a redelivery hours later and not a crash between applying the effect and acknowledging, so it narrows the receiver's job without removing it.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Solves the dual-write problem** from the receiving side with a single local ACID transaction — no distributed transaction coordinator needed.
- **Guarantees at-least-once reception**: acknowledging only after the commit means a crash between receipt and acknowledgement leads to redelivery, not loss, provided the broker retries unacknowledged messages.
- **A redelivered message is recognised** inside the retention window by its recorded id and skipped, so effects committed in that transaction land once even while the broker keeps retrying; effects outside it, such as a call to another service, still need idempotent handling.
- **Works with any relational database and any broker**; it's a pattern, not a product.

### Cons
<!--meta polarity=con-->

- **Adds a table**, a cleanup job, and one more moving part to deploy and monitor.
- **Delivery stays at-least-once**; it is the effect the pattern lands exactly once. The handler still runs on a message it has seen before, so idempotent handling is a requirement of the pattern, not an optional extra.
- **Deferred processing buys timeout safety** with a poller that adds latency and steady read load — shorten its interval only as far as the table can carry it, or tail the log instead and accept operating the connector.
- **The inbox table grows unbounded** without its own archiving or cleanup job.
- **The dedup key has to be the sender's**, so you inherit whatever it guarantees — if two distinct messages can share an id, the second is dropped in silence. Assert uniqueness at the boundary, and key on a compound the sender cannot collide (flow, step, request id).

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A service must receive** and reliably process messages from a broker or event stream.
- **A lost message or a repeated effect** costs you, and your handlers can be made safe to repeat.
- **The database and the message** broker are separate systems with no shared transaction between them.

### Avoid when
<!--meta polarity=avoid-->

- **Your handler's effects are already** idempotent (e.g., reads, cache invalidations, queries with deduplication built in) and losing a message is acceptable.
- **Broker connectivity is always reliable** and an occasional missed message is acceptable.
- **The extra table and cleanup/poller** complexity outweigh the reliability benefit for your domain and scale.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the note and the work in one save, then the ack"
// inbox has a unique index on the sender's message id.
async function onMessage(msg: Message) {
  await db.transaction(async (tx) => {
    const first = await tx.inbox.insertIfNew(msg.id);
    if (!first) return;                  // seen before — do nothing at all
    await tx.orders.markPaid(msg.orderId);   // the work, same commit
  });

  // Only now. Crash before this line and the sender simply sends again,
  // the note is already there, and the order is not marked paid twice.
  await msg.ack();
}
```

```typescript summary="TypeScript — deduping a vendor callback on the sender's request id"
// inbox has a unique index on (flow_id, step, provider_request_id).
// The collision — not a preceding SELECT — is what makes this safe when
// two copies of the same callback arrive at once.
async function onVendorCallback(tx: Transaction, cb: VendorCallback) {
  const claimed = await tx.query(
    `insert into inbox (flow_id, step, provider_request_id, payload, received_at)
     values ($1, $2, $3, $4, now())
     on conflict (flow_id, step, provider_request_id) do nothing
     returning flow_id`,
    [cb.flowId, cb.step, cb.providerRequestId, JSON.stringify(cb)],
  );
  if (claimed.rows.length === 0) return;   // duplicate — no-op

  // Same transaction as the claim: dedupe key, flow transition and
  // client webhook event commit together, or none of them do.
  await tx.query("update flow set state = $1 where id = $2",
    [nextState(cb), cb.flowId]);
  await tx.query(
    `insert into outbox (id, flow_id, topic, payload, published)
     values ($1, $2, $3, $4, false)`,
    [randomUUID(), cb.flowId, `persona.${cb.step}`, JSON.stringify(cb.result)],
  );
}
// Commit first, then ack. Crash before the ack? The vendor retries, the
// insert collides, and the flow does not advance twice.
async function onDelivery(db: Db, d: Delivery<VendorCallback>) {
  await db.transaction((tx) => onVendorCallback(tx, d.body));
  await d.ack();
}
// cleanupInbox: delete inbox rows older than the deduplication window.
```

## In the wild
<!--meta block=wild-->

- **MassTransit** — The .NET messaging library ships the inbox as part of its transactional outbox: one AddEntityFrameworkOutbox call installs both sides, and received MessageIds land in an InboxState table so a message the broker redelivers inside the duplicate-detection window is recognised as already handled instead of being run again. {#wild-masstransit}
- **Amazon SQS FIFO queues** — Deduplication moved to the broker rather than the receiver: a send is dropped if the same message deduplication id arrives within the five-minute deduplication interval, supplied explicitly or computed by SQS as a SHA-256 hash of the message body. It covers a publisher that retried its send; it does not cover a redelivery after the receiver died between applying the effect and acknowledging, which is what the inbox table exists for. {#wild-sqs-fifo}
- **Temporal** — The workflow engine records an activity result exactly once in the workflow event history and retries the activity when a worker fails — but execution itself is at-least-once, and Temporal advises writing activities to be idempotent rather than promising any deduplication of runs. {#wild-temporal}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Handler timeout** — For synchronous processing, how long the broker waits before timing out and redelivering. Set it from the slowest handler runs you measure plus headroom, then check the broker redelivery rate after each change. Too short causes false redeliveries; too long risks a dropped connection. Deferred processing sidesteps this entirely.
- **Broker visibility window** — How long the broker hides a received message before auto-redelivering if not acknowledged. Must be longer than handler latency + ack latency. Shorter windows create thrashing; longer windows tolerate brief outages.
- **Processor poll interval** — For deferred processing, how often the background job scans for unprocessed rows. Shorter cuts end-to-end latency but raises steady read load; CDC sidesteps polling entirely.
- **Dedup retention window** — How long a processed row is kept before a job deletes or archives it, which is exactly how late a duplicate can arrive and still be caught. Set it from the broker's maximum redelivery age, not from a round number of days.

### Signals to watch
<!--meta polarity=signal-->

- **Inbox backlog depth** — Count of rows with processed = false, which exist only in deferred processing; synchronous rows are written already processed. Alert on the age of the oldest unprocessed row against your processing-latency target, not on count alone. Steady growth means the processor is not keeping up or handlers are failing.
- **Processing latency** — Time between message arrival and processed = true. The end-to-end latency; dominated by handler latency and the processor poll interval.
- **Handler error rate** — Failed processing attempts per interval. Rising errors stall the inbox and leave messages unacknowledged.
- **Broker redelivery rate** — Messages the broker redelivered due to unacknowledged or visibility window timeout. High redelivery creates duplicate-detection pressure on the inbox and its handlers.

### Failure modes under load
<!--meta polarity=failure-->

- **Handler timeout cascade** — Slow processing → visibility window expires → broker redelivers → duplicate processing pressure → handler slower → more timeouts. Deferred processing breaks this cycle.
- **Inbox backlog starvation** — Handler failures or a rejecting downstream service stall processing: in synchronous mode messages stay unacknowledged and broker redelivery pressure mounts; in deferred mode unprocessed rows pile up in the table.
- **Idempotency key collision** — Two different messages carry the same id, from a flaw in the sender's key generation, and the second is dropped with no error. A duplicate arriving after its row was cleaned up re-applies its effect just as silently.
- **Table bloat stalls polling** — Cleanup lags and the poll query scans millions of processed rows, driving its own latency up and worsening the backlog it was meant to drain.

### Readiness checklist
<!--meta polarity=check-->

- Handlers are demonstrably idempotent — same message id produces same result, no matter how many times delivered
- A partial index on processed = false keeps the processor's poll query fast as the table grows
- The cleanup job is itself monitored — a silently dead one looks exactly like a healthy one until the poll slows down
- A handler that overruns the window has been exercised — the redelivery it causes lands on the dedup key rather than on a second effect
- Inbox backlog depth and processing latency are monitored with alerts on sustained growth or degradation
- The dedup key is the sender's, and something at the boundary rejects a message whose key repeats with a different body

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Consistency & Replication](../../../themes/consistency-and-replication.md) — Make the receipt and the write atomic {#fluency-consistency-and-replication}
- [Multi-Step Processes](../../../themes/multi-step-processes.md) — Apply a received step exactly once {#fluency-multi-step-processes}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Message Queue](../../messaging/message-queue.md) — Source of messages; broker must support acknowledgement
- [Saga](./saga.md) — Receive saga steps reliably via the inbox
- [Publish-Subscribe](../../messaging/pubsub.md) — The inbox makes receiving atomic with processing

**Requires**

- [Idempotency](../../messaging/idempotency.md) — A handler must be safe to repeat, since duplicate delivery is inherent

**Often confused with**

- [Outbox](./outbox.md) — Opposite direction: outbox publishes reliably, inbox receives reliably

**Prevents**

- [Dual-Write Inconsistency](../../../hazards/dual-write-inconsistency.md) — Recording the message and applying its effect in one local transaction leaves no gap between the two

**Demonstrated by**

- [WhatsApp](../../../designs/whatsapp.md) — a durable holding queue that outlives a disconnected consumer until it acks is the pattern's whole purpose
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — a know your customer (KYC) flow deduping vendor callbacks on the sender's request id in the same transaction as the effect, closing the duplicate-that-arrives-first window
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — the receive-side guard generalised past callbacks: one row per batch member, so a redelivered batch applies only what it still owes

<!-- relationships:end -->
