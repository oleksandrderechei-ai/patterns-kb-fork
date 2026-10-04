---
title: Sequential Convoy
description: Keeps order inside each group while groups run in parallel
area: messaging
owner: Oleksandr Derechei
tags: [messaging, throughput]
status: stable
aliases: [message sessions, session-based ordering]
solves: [two workers processed the same order's updates out of sequence and corrupted it, i need one customer's messages in order but cannot afford a single consumer, adding consumers to the queue broke the ordering our state machine depends on, one stuck message is blocking every other customer's work]
---

# Sequential Convoy

Partitions a stream by a category key and hands each category to exactly one consumer at a time, so ordering is enforced per group instead of across the whole queue — and the number of groups becomes the unit of parallelism.

## What it is
<!--meta block=description-->

A sequential convoy keeps related messages in order while unrelated ones run in parallel. Each message carries a key naming its group, and only one consumer works on a group at a time, in arrival order. It fits when order matters per entity, such as one order's events, and a single consumer cannot scale.

## Explained
<!--meta block=explain-->

A sequential convoy keeps related messages in order while unrelated ones run in parallel. You stamp each message with a key naming its group, such as an order id, and the broker lets only one consumer work on a group at a time, in arrival order, while other consumers take other groups. Choose it over a single consumer, which keeps order but cannot scale, and over competing consumers, which scale but let two workers apply consecutive events of one order at the same time.

- **Key choice.** The key sets both order and parallelism. Pick the smallest entity whose events must be ordered: too wide makes one lane.
- **Poison message.** A message that always fails blocks its group. Count attempts and move it to a dead-letter queue (a side queue).
- **Lock timing.** Too short a lock redelivers work in progress; too long freezes the group behind a dead consumer. Renew while the handler works.

**Example.** An order produces 4 events: created, item added, item amended, cancelled. Each takes 100 ms to handle, so one group moves at most 10 messages a second. With 8 consumers each holding one group, you handle up to 80 a second across 8 orders, and each order stays in sequence. Competing consumers could apply amended before added. The cost: if the amended event always fails, with 5 attempts it holds that order for 5 x 100 ms = 0.5 s before it goes to the dead-letter queue, and cancelled waits behind it. Keying by customer instead of order would put a customer with 50 orders in one lane.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one entity's ordering survive parallel consumers? Messages from every group are interleaved in the same queue; the lock at step 2 is what turns that interleaving back into three independent ordered lanes."
flowchart LR
    P["Producer"]
    subgraph B["Broker — one queue, partitioned by category key"]
        GA[("Group A, FIFO")]
        GB[("Group B, FIFO")]
        GC[("Group C, FIFO")]
    end
    CA["Consumer holding A"]
    CB["Consumer holding B"]
    CC["Consumer holding C"]
    P -->|"1 stamp the category key"| B
    GA -->|"2 exclusive lock, in order"| CA
    GB -->|"2 exclusive lock, in order"| CB
    GC -->|"2 exclusive lock, in order"| CC
```

```mermaid caption="The lock is the whole mechanism, and its duration is the tuning knob. Too short and a slow handler loses its group mid-flight, so the messages come back; too long and a dead consumer holds its group hostage until the lease runs out."
sequenceDiagram
    autonumber
    participant P as Producer
    participant B as Broker
    participant C1 as Consumer 1
    participant C2 as Consumer 2
    P->>B: create(order-7), addTx(order-7), amendTx(order-7)
    C1->>B: accept group order-7
    B-->>C1: exclusive lock granted
    C2->>B: accept group order-7
    B-->>C2: refused, already locked
    C2->>B: accept group order-9
    B-->>C2: lock granted, runs in parallel
    alt consumer 1 stalls past the lock duration
        B-->>B: lock expires, messages redelivered
        Note over B,C2: another consumer may reprocess — handlers must be idempotent
    end
```

## Variations
<!--meta block=variations-->

- **Broker-native sessions** — The broker owns the grouping and the locking: the producer sets a session identifier, and accepting a session grants an exclusive lease plus in-order delivery. The least code and the strongest guarantee, and it constrains your broker choice — not every queue offers session-level locking, and on some it sits behind a higher service tier.
- **Partitioned log** — A log broker hashes the key to a partition and assigns each partition to one consumer, so per-key ordering falls out of the same rebalancing machinery that gives you scale. Ordering then holds per partition rather than per key, which means two keys landing in one partition also share a lane.
- **Consumer-side coordination** — Where the broker has no notion of groups, the consumer takes a [Distributed Lock](../distributed/coordination/distributed-lock.md) on the key before handling a message and releases it after. It works, and it moves every hard part — lease expiry, fencing, duplicate suppression — into your code, where the failure modes are duplicates, skipped messages and out-of-order execution.
- **Serial-to-parallel transition** — A first queue is drained strictly in order by one processor that de-batches each item, stamps the category key, and forwards to a second, key-partitioned queue where consumers fan out. It is how you get from an inherently ordered source to parallel processing, and that first stage becomes the ceiling on the whole pipeline, because everything downstream waits behind it.
- **Sequence numbers over arrival order** — Rather than trusting arrival order, the producer numbers each message within its category and the consumer verifies the run. Worth adding when variable latency between producer and broker can reorder messages before the broker's ordering ever applies — an end-of-sequence flag on the last message also lets the consumer know the run is complete.
- **Bracketed batches** — Where strict ordering costs more throughput than it is worth, mark a run with an explicit start and end message, or sort by timestamp inside a window and process the window in parallel. You give up per-message ordering and keep the property that actually mattered, which was that the run is applied as a unit.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Ordering stops being a scaling ceiling**. Throughput grows with the number of active groups, which for per-entity keys is effectively unbounded.
- **Whole classes of defect never get written**. No two workers touch one entity at once, so the race conditions, out-of-order state mutations and reordering buffers that ordering bugs usually attract simply do not arise.
- **Producers stay ignorant of consumers**. They stamp a key and enqueue; consumer count, placement and identity change underneath without them.
- **The blast radius of a stuck message** is one group rather than the whole queue.

### Cons
<!--meta polarity=con-->

- **Per-group throughput is capped** by single-message latency, because the lane is serial by construction. Cutting handler time is the only lever that raises that ceiling.
- **A poison message blocks its group** until something removes it, so delivery-attempt counting and a dead-letter path are mandatory rather than optional.
- **Lock duration is a two-sided mistake**. Too short redelivers work a slow handler was still doing; too long freezes a group behind a consumer that has already died.
- **A wrong key silently corrupts a group**. Nothing rejects a misrouted message, so producer-side key assignment needs validating and, where the consequence is severe, checking again at the consumer.
- **Operations gain a second dimension**. You now watch how many groups are active and how deep each one is, not just total queue depth — and dead-lettered groups need their own investigate-and-replay workflow.
- **Cost tracks active groups**. Each locked group is a concurrent consumer, so a spike in distinct keys is a spike in compute even when total volume has not moved.
- **Every group depends on one broker**, whose availability is the ceiling on the guarantee the pattern advertises.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Messages arrive in a meaningful order**, and applying them out of that order produces a wrong result rather than a slow one.
- **The stream splits into independent categories** — per order, per account, per device — with no cross-category dependency.
- **There are far more categories** than consumers, so per-group serialization still leaves plenty of parallelism on the table.
- **You already run competing consumers** and have found the ordering hole the hard way.

### Avoid when
<!--meta polarity=avoid-->

- **Ordering does not matter**. Competing consumers gives the same throughput with none of the locking, monitoring or poison-message coupling.
- **Volume is extreme** — millions of messages a minute — and the serial-per-group constraint caps you below the target.
- **The natural key yields very few groups**, because parallelism is then bounded by that count no matter how many consumers you run.
- **The handlers can be made commutative** or idempotent instead. Making order irrelevant is a stronger result than enforcing it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — accept a group, hold it, renew the lease while handling"
type Message = { categoryKey: string; sequence: number; body: unknown }
interface GroupLease {
  next(): Promise<Message | null>   // strictly in enqueue order
  complete(m: Message): Promise<void>
  deadLetter(m: Message, reason: string): Promise<void>
  renew(): Promise<void>            // push the lease out while still working
  close(): Promise<void>
}
// Blocks until some unlocked group is available, then leases it exclusively.
interface SessionBroker { acceptAnyGroup(): Promise<GroupLease | null> }
const MAX_ATTEMPTS = 5

async function runOneGroup(broker: SessionBroker, handle: (m: Message) => Promise<void>) {
  const lease = await broker.acceptAnyGroup()
  if (!lease) return
  try {
    for (let message = await lease.next(); message; message = await lease.next()) {
      // Renew before the slow part, not after: an expired lease hands this
      // group to another consumer and the message is delivered twice.
      await lease.renew()
      for (let attempt = 1; ; attempt++) {
        try { await handle(message); await lease.complete(message); break }
        catch (err) {
          // Nothing behind this message can move until it leaves: bound the retries.
          if (attempt >= MAX_ATTEMPTS) { await lease.deadLetter(message, String(err)); break }
        }
      }
    }
  } finally { await lease.close() }
}
```

## In the wild
<!--meta block=wild-->

- **Azure Service Bus message sessions** — The producer sets a `SessionId` on the message and the broker groups every message sharing it into one logical session; a consumer that accepts the session holds an exclusive lock on it and receives its messages in first in, first out (FIFO) order, while other consumers accept other sessions concurrently. {#wild-service-bus-sessions}
- **Apache Kafka partitions** — The same guarantee from a log: records carrying the same key hash to the same partition, ordering is guaranteed within a partition, and each partition is assigned to exactly one consumer in a group — so ordering holds per partition rather than per key, and two keys sharing a partition share a lane. {#wild-kafka-partitions}
- **Amazon Simple Queue Service (SQS) FIFO queues** — A message group id plays the category-key role: SQS delivers messages within one group in order and to one consumer at a time, and delivers different groups in parallel. {#wild-sqs-fifo}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Category key** — The unit of both ordering and parallelism. Too coarse caps concurrency at the number of keys; too fine orders what never needed it.
- **Session lock duration** — Set it above the worst expected handler time, and renew mid-handler for long operations.
- **Max concurrent sessions per consumer** — Caps how many groups one instance holds at once, which is what bounds its memory and its connection use.
- **Max delivery attempts** — How long a failing message may block its group before it is dead-lettered.

### Signals to watch
<!--meta polarity=signal-->

- **Active session count** — The real parallelism, and the number consumer scaling should track.
- **Per-session backlog depth** — Aggregate queue depth looks healthy while one category starves — only the per-session number shows it.
- **Session lock renewals and expiries** — Rising expiries mean the lock duration is below actual handler time, and every expiry is a redelivery.
- **Dead-lettered messages by category** — A cluster in one category usually means bad data for one entity rather than a broken handler.

### Failure modes under load
<!--meta polarity=failure-->

- **One group stalls, the rest look fine** — A poison message holds its lane while aggregate metrics stay green — this is why per-session depth is the signal that matters.
- **Lock expiry storms under load** — Handlers slow down, locks start expiring, redelivered messages add load, and handlers slow further.
- **Session count spike becomes a cost spike** — Each active group is a concurrent consumer, so a burst of distinct keys multiplies compute even at flat message volume.
- **Duplicate application after a redelivery** — An expired lock hands the group on mid-message, so a non-idempotent handler applies the same change twice.

### Readiness checklist
<!--meta polarity=check-->

- The category key is the smallest entity whose events genuinely depend on each other.
- Handlers are idempotent, because lock expiry redelivers.
- A dead-letter path exists and someone is paged when a group stops moving.
- Lock duration is measured against p99 handler time, not guessed.
- Producers are validated to set the key, and the consumer rejects an implausible one.
- Dashboards show active sessions and per-session depth, not just total queue depth.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Long-Running Tasks](../../themes/long-running-tasks.md) — Process each entity's messages in order while different entities run in parallel. {#fluency-long-running-tasks}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Competing Consumers](./competing-consumers.md) — Restores the per-entity ordering that parallel consumers give away
- [Distributed Lock](../distributed/coordination/distributed-lock.md) — Where the broker has no sessions, lock on the category key yourself
- [Priority Queue](./priority-queue.md) — Sessions inside a priority level, so ordering holds within each class

**Alternative to**

- [Resequencer](./resequencer.md) — Avoids disorder up front by letting one consumer at a time work on each key's messages

**Requires**

- [Dead Letter Channel](./dead-letter-channel.md) — A poison message blocks its whole ordered group, so it needs somewhere to go

**Prevents**

- [Race Condition](../../hazards/race-condition.md) — One consumer per group at a time removes the concurrent-update race entirely
- [Head-of-Line Blocking](../../hazards/head-of-line-blocking.md) — The convoy is the answer to an ordered lane whose head can block everything.

**Exposed to**

- [Poison Message](../../hazards/poison-message.md) — Can fall into poison message when ordered processing makes one bad message block every message behind it

**Demonstrated by**

- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — a know your customer (KYC) flow's results are delivered one lane per flow — a delivery_cursor row per flow keeps the queue parallel across flows while each flow is single-file
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — a case study that prices the lane as well as praising it: ordering is bought with head-of-line blocking, bounded by the lane's own attempt budget

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — First in, first out (FIFO) message groups and broker sessions keep one related run in order while others proceed in parallel.
- [Message brokers & streams](../../comparisons/message-brokers.md) — How far each broker's ordering reaches decides how you key a convoy.

<!-- relationships:end -->
