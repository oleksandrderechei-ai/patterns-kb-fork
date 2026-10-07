---
title: Splitter
description: Breaks one message into many for individual processing
area: messaging
owner: Oleksandr Derechei
tags: [messaging, batching]
status: stable
solves: [one bad row in the batch file fails the entire upload, I have to retry all five thousand records just because record three hundred blew up, the nightly batch file takes an hour because one process handles its rows one by one, every step in my pipeline must loop over a message's items itself before doing its work, different items in the same payload need to go to different places but they arrive as one blob]
---

# Splitter

Breaks one composite message into a sequence of individual messages, each carrying a single item, so downstream steps can process, route, or scale on them independently.

## What it is
<!--meta block=description-->

A splitter takes one message that holds many items, such as a file of records or an order with line items, and emits one message per item, each stamped with the parent id, its position and the total. Downstream steps handle one item, so items advance, retry and scale independently instead of failing as one batch.

## Explained
<!--meta block=explain-->

A splitter takes one message holding many items, such as a file of records, and sends one message per item, each stamped with the parent id, its position and the total. Downstream steps are written for one item, so they run, scale and fail per item instead of looping over a batch. Choose it when the unit a message carries is not the unit your logic handles, and independence per item matters more than all-or-nothing handling. Keep the batch whole when a rule holds only across the full set, such as a ledger that must balance.

- **No all-or-nothing.** Some items succeed and some fail. Track each item outcome and decide up front whether to undo the successes.
- **Volume.** Message count and overhead multiply by the item count, so split only as far as the work needs.
- **Lost grouping.** Order and grouping vanish unless each fragment carries parent id, position and total. The total tells an aggregator when all pieces have finished.
- **Duplicates.** At-least-once delivery repeats fragments. Count distinct positions, not arrivals, or the total proves nothing.

**Example.** A nightly file holds 12,000 records, and validating one takes 40 ms. One consumer working through the file takes 12,000 x 40 ms = 480 s. Split into 12,000 messages and read by 8 consumers, it takes about 60 s at best, plus per-message broker and serialization cost. Each message carries file id f-7, its position and the total, 12,000. Three records fail validation. The aggregator counts distinct positions: 11,997 successes plus 3 failures equals the total, so it reports the file as finished with 3 rejects. A deadline reports any missing fragment as lost. Without the total, nothing could tell a finished file from a lost message.

## How it works
<!--meta block=structure-->

```mermaid caption="Once the batch is gone, what still says these three messages belong together? Only the stamp applied at steps 3–5 — the parent id, the sequence and the total — which is why a fragment emitted without it can be processed at step 6 but never counted or recombined."
flowchart LR
    Prod["Order Service"]:::ext
    In[("Order channel")]
    SP["Splitter"]
    subgraph Grp["One correlation group: parent id, sequence, total"]
        F1["Line 1 of 3"]
        F2["Line 2 of 3"]
        F3["Line 3 of 3"]
    end
    Work["Line workers"]:::ext
    Prod -->|"1 one order, three lines"| In
    In -->|"2 receive composite"| SP
    SP -->|"3 stamp and emit"| F1
    SP -->|"4 stamp and emit"| F2
    SP -->|"5 stamp and emit"| F3
    F1 -->|"6 processed alone"| Work
    F2 -->|"6"| Work
    F3 -->|"6"| Work
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Static split** — Breaks a message into a fixed, known set of parts — header vs. body, metadata vs. payload — where the shape of the split is decided at design time, not from the data.
- **Iterative split** — Iterates a repeating field — an array, a list of XML elements — and emits one message per element. The common case for orders, batch files, and CSV rows.
- **Recursive split** — Splits a composite that itself contains nested composites, recursing until only atomic messages remain — a folder into files, then a file into records.
- **[Correlated split](./aggregator.md)** — Stamps every fragment with a correlation id, sequence number, and total count so a paired Aggregator can recombine results once every fragment has returned.
- **[Fan-out split](./scatter-gather.md)** — The scatter half of Scatter-Gather — the split feeds a [recipient list](./recipient-list.md) or router that sends each fragment to a different endpoint for parallel processing.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Lets every downstream endpoint stay simple** — built for one item, not a batch.
- **Enables per-item parallelism**, so a slow or heavy batch scales across a [worker pool](../concurrency/thread-pool.md).
- **Isolates failure** — one bad item errors alone instead of failing the entire batch.
- **Different fragments can be routed** to different endpoints based on their own content.

### Cons
<!--meta polarity=con-->

- **Multiplies message volume and the per-message overhead** — headers, serialization, broker load.
- **Drops ordering and grouping** unless a correlation id and sequence are carried through, and honored, downstream.
- **Needs a paired Aggregator**, or equivalent tracking, to know when all fragments have completed.
- **Partial failure across fragments** creates a "some succeeded, some didn't" state that must be handled explicitly, not ignored.
- **Crash mid-split or redelivery of the parent** leaves a partial or duplicate fan-out, so make the split restartable and dedupe on parent id plus position.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **An inbound message is a batch** or composite, and downstream logic is written to handle one item at a time.
- **The elements can be processed**, scaled, or retried independently of one another.
- **Different elements need different routing** or handling based on their own content.

### Avoid when
<!--meta polarity=avoid-->

- **The message is already a single atomic unit** — there is nothing meaningful to split. If it is only too big for the broker, use [claim-check](./claim-check.md). If the whole message goes to many endpoints, use [recipient-list](./recipient-list.md).
- **Processing must stay strictly ordered or transactional** across the whole batch, with no way to reconcile pieces later.
- **The elements aren't independent** — splitting would break an invariant that only holds across the full set, like a balanced double-entry ledger.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — splitting an order into per-item messages"
interface OrderMessage {
  orderId: string;
  items: { sku: string; qty: number }[];
}

interface ItemMessage {
  correlationId: string; // ties each fragment back to the order
  sequence: number;
  total: number;
  sku: string;
  qty: number;
}

function splitOrder(msg: OrderMessage): ItemMessage[] {
  return msg.items.map((item, i) => ({
    correlationId: msg.orderId,
    sequence: i,
    total: msg.items.length,
    sku: item.sku,
    qty: item.qty,
  }));
}

// Each fragment can now be routed, processed, or scaled independently.
for (const fragment of splitOrder(order)) {
  channel.send(fragment);
}
```

## In the wild
<!--meta block=wild-->

- **Apache Camel split()** — Its split() enterprise integration pattern (EIP) turns one exchange carrying a collection into one exchange per element; parallelProcessing fans them across a thread pool, streaming() avoids loading the whole body, and each fragment gets CamelSplitIndex and CamelSplitSize headers plus an optional aggregationStrategy to recombine. {#wild-apache-camel-split}
- **AWS Step Functions Map state** — A Map state runs the same sub-workflow once per array element; MaxConcurrency caps the parallel branches, a tolerated-failure threshold decides how many item failures fail the whole map, and Distributed Map mode scales to large datasets read from Simple Storage Service (S3). {#wild-aws-step-functions-map}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Per-split parallelism** — Whether fragments are processed sequentially or dispatched in parallel across a worker pool. Parallel dispatch breaks arrival order, so keep one partition or key per correlation id when order matters.
- **Batch / chunk size** — For a very large composite, how many elements go into each emitted message rather than one per element. Start at one per message and raise it only while per-message overhead outweighs the per-item work.
- **Fragment size limit** — The broker per-message size ceiling each fragment must fit under after the split.

### Signals to watch
<!--meta polarity=signal-->

- **Fan-out amplification factor** — Fragments emitted per input message; the volume multiplier the downstream channel must absorb.
- **Downstream backlog after split** — Queue depth on the fragment channel, which spikes when one large composite explodes into many messages. Alert when depth keeps rising instead of draining between splits.
- **Per-fragment failure rate** — Fragments that error on their own, indicating a partial-batch condition to reconcile.
- **Open groups at the aggregator** — Count and age of parent ids holding fewer fragments than their total. A group older than the processing deadline means a lost fragment.

### Failure modes under load
<!--meta polarity=failure-->

- **Volume explosion** — One large composite emits thousands of fragments at once, flooding the downstream channel and broker.
- **Lost grouping** — Fragments without a correlation id, sequence, and total cannot be recombined or counted for completion; the aggregator never knows when all N have arrived.
- **Partial batch failure** — Some fragments succeed and some fail, leaving a half-processed batch that must be reconciled, not ignored.

### Readiness checklist
<!--meta polarity=check-->

- Each fragment carries a correlation id, sequence number, and total count for recombination
- The fragment channel and its workers are sized for the post-split volume multiplier
- Partial-failure handling is defined — retry the fragment or reconcile the batch
- If order matters, sequence numbers are honored downstream, not assumed

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Turn a message holding many elements into one message per element. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Aggregator](./aggregator.md) — Split out, process, then recombine
- [Correlation Identifier](./correlation-identifier.md) — Each fragment carries the parent id, sequence number and total count
- [Message Router](./message-router.md) — The split feeds a router that sends each fragment to its endpoint
- [Recipient List](./recipient-list.md) — The split commonly feeds a recipient list or a router
- [Resequencer](./resequencer.md) — A splitter numbers its parts so a resequencer can rebuild their order
- [Competing Consumers](./competing-consumers.md) — Fragments are one-item messages that a consumer pool drains in parallel.
- [Dead Letter Channel](./dead-letter-channel.md) — A fragment that fails every attempt is diverted, not left to stall the batch.
- [Backpressure](../concurrency/backpressure.md) — Bounds how fast a large split can flood the fragment channel.
- [Thread Pool](../concurrency/thread-pool.md) — Per-split parallelism runs the fragments on a fixed worker pool.

**Alternative to**

- [Claim Check](./claim-check.md) — Chunk an oversized payload down to size vs. offload it whole and pass the claim

**Part of**

- [Scatter-Gather](./scatter-gather.md) — Scatter fans out, gather aggregates

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that splits one message into many as a ready-made building block.

<!-- relationships:end -->
