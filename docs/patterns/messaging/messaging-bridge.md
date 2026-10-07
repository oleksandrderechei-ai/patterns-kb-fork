---
title: Messaging Bridge
description: Relays messages between two brokers that cannot talk to each other
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling]
status: stable
aliases: [queue bridge, broker bridge]
solves: [we acquired a company and their queues cannot talk to ours, a legacy on-premises system needs to send work to a new cloud service, moving every endpoint to the new broker in one weekend is too risky, we would have to bolt http endpoints onto two working systems just to connect them]
---

# Messaging Bridge

A component connected to two messaging infrastructures at once, pulling from one and pushing to the other with the payload untouched — so two systems integrate without either of them learning that the other exists.

## What it is
<!--meta block=description-->

Two message brokers that cannot hear each other, one from an acquisition or an older on-premises system, still need to exchange messages. A messaging bridge is a process holding a connection to each broker. It receives from a queue on one side and sends to a queue on the other, leaving the payload and both systems untouched. A bridged route offers only the features both brokers share.

## Explained
<!--meta block=explain-->

A messaging bridge is a process that holds a connection to two separate message brokers, receives from a queue on one and sends to a queue on the other, and leaves the payload untouched. Neither existing system changes, because each sees an ordinary local queue. Because the transfer is queue to queue, you keep durable at-least-once delivery, where bolting HTTP onto both sides would trade it for a synchronous call over a link that drops. Choose it when two systems already talk by messages on brokers that cannot talk to each other and changing either is expensive.

- **Feature intersection.** The route offers only what both brokers support, and each limit clamps to the smaller, so check message sizes first.
- **Double delivery.** No transaction spans two brokers, so a crash between send and settle delivers twice; make the receiver safe to run twice.
- **Outage dead-lettering.** A retry count dead-letters good messages during an outage, so pause forwarding with a circuit breaker instead.

**Example.** A bridge relays 200 messages a second from an on-premises broker to a cloud broker. The cloud side goes down for 10 minutes, which is 200 x 600 = 120,000 messages. With a 5-attempt retry limit, each message burns its attempts in seconds and the lot is dead-lettered. With a breaker, forwarding pauses, the source queue holds all 120,000, and they drain when the far side returns. A message of 100 KB can never cross a 64 KB route, so check sizes before you rely on the bridge.

## How it works
<!--meta block=structure-->

```mermaid caption="How do two brokers that cannot see each other exchange a message? Only the bridge spans the boundary — steps 1 and 4 are exactly what each system already did, which is what makes this an integration you can add without a rewrite."
flowchart LR
    S["Sender — unchanged"]
    subgraph IA["Infrastructure A"]
        QA[("Bridging queue")]
    end
    BR["Bridge"]
    subgraph IB["Infrastructure B"]
        QB[("Shadow queue")]
    end
    R["Receiver — unchanged"]:::ext
    S -->|"1 send to a local destination"| QA
    QA -->|"2 receive"| BR
    BR -->|"3 send, payload untouched"| QB
    QB -->|"4 consume as usual"| R
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="There is no transaction spanning two brokers, so the relay is a receive-send-settle with a gap in the middle. A crash inside that gap delivers twice, which is why the bridge is an at-least-once channel and the receiver must be idempotent."
sequenceDiagram
    autonumber
    participant QA as Queue A
    participant BR as Bridge
    participant QB as Queue B
    BR->>QA: receive, lock not deleted
    QA-->>BR: message
    BR->>QB: send
    alt send acknowledged
        QB-->>BR: ack
        BR->>QA: settle, remove from A
    else ack lost after B accepted it
        BR->>QA: lock expires, message redelivered
        BR->>QB: send again — duplicate on B
        Note over BR,QB: dedupe by message id on the receiving side
    end
```

## Variations
<!--meta block=variations-->

- **Single bridging queue** — One designated queue on each side carries everything bound for the other system, and senders are configured to use it as the destination for those message types. The least infrastructure to create, at the cost that senders now know a bridge exists — they are addressing the crossing point rather than the recipient.
- **Shadow queues** — Each destination queue on one side gets a mirror queue on the other, and the bridge forwards between each pair. Senders address what looks like a local destination and stay entirely unaware of the crossing, which is what you want for a migration; you pay for it in queues to create and keep in step.
- **Bridging a system with no broker** — Where one side has no messaging infrastructure at all and cannot be modified, give it one: use [Change Data Capture](../distributed/coordination/change-data-capture.md) to push its committed changes into a dedicated queue table, and let the bridge forward from there. The legacy system keeps writing to its database and unknowingly becomes a producer.
- **Scaled-out bridge** — Run several bridge instances as [Competing Consumers](./competing-consumers.md) on the source queue when one cannot meet the throughput or availability target. Ordering across the boundary goes with it, so this is only safe where the receiving side does not depend on message order.
- **Translating bridge** — A bridge that also reshapes the payload has become a [Message Translator](./message-translator.md), and it is worth naming the moment it happens: the pure bridge can be proven correct by inspection because it changes nothing, and a translating one now owns schema compatibility between two systems that never agreed on one.
- **Bidirectional bridge** — Two relays, one per direction. Stamp a header on each forwarded message and skip stamped ones, or messages ping-pong between the brokers forever.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Neither system needs changes to talk across**, provided the receiver already tolerates duplicates; a non-idempotent receiver must change, or the bridge must deduplicate. Otherwise the integration is additive.
- **The channel stays asynchronous and durable end** to end. An unreachable far side means the source queue grows, not that a caller fails, until that queue's own quota or retention limit is reached.
- **Migration becomes incremental**. Endpoints move broker one at a time on their own schedule, and the bridge covers the gap for as long as it takes.
- **It survives a flaky link**. Geo-distributed systems on an unreliable connection tolerate the outage as backlog rather than as errors, for as long as the source queue can hold the backlog.

### Cons
<!--meta polarity=con-->

- **The route offers only what both sides support**. Advanced features on either broker are unavailable across it, and every limit clamps to the smaller of the two.
- **There is no transaction** across two brokers, so relaying is at-least-once and duplicates are normal. The bridge must carry the source message id unchanged so the receiver can deduplicate, and must deduplicate itself if either side relies on a distributed transaction.
- **The usual retry policy is actively wrong here**. Counting attempts and dead-lettering at the limit condemns perfectly good messages during an infrastructure outage, so pause forwarding with a [Circuit Breaker](../distributed/resilience/circuit-breaker.md) instead of burning through the retry budget.
- **It is a new component** on a path that had none — one more thing to deploy, monitor, scale and page someone about.
- **Ordering is not preserved** once you scale the bridge out, and often not even before that.
- **It hides the coupling rather than removing it**. Two systems now depend on each other through a component neither team owns, and nothing in either codebase says so.
- **Outage and bad message look alike**. A breaker trips on failures across many messages. One message failing while others pass is a poison message: dead-letter it, or it blocks the route behind it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Two systems already communicate** by messages, on infrastructures that cannot talk to each other.
- **Modifying either system is expensive** or off the table — a legacy application, a vendor product, a team with no capacity.
- **You are extending an on-premises system** with cloud-hosted components and do not want a synchronous dependency between them.
- **Migrating brokers in place** — you need both to work during the transition rather than after it.

### Avoid when
<!--meta polarity=avoid-->

- **The integration is genuinely synchronous** and the caller needs an answer now. A bridge makes the round trip slower and the failure modes stranger.
- **Either side depends on a broker feature** the other lacks — ordering, sessions, transactions, large payloads. The bridge cannot manufacture it.
- **The data volume exceeds what messaging can carry** economically, or the payloads are large enough that a [Claim Check](./claim-check.md) is the real answer.
- **Security or privacy requirements make an intermediary** that reads every message unacceptable.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — relay one direction, settling only after the far side accepts"
type Envelope = { id: string; body: Uint8Array; headers: Record<string, string> }
interface Source {
  receive(): Promise<{ message: Envelope; settle(): Promise<void>; abandon(): Promise<void>; deadLetter(): Promise<void> } | null>
}
interface Destination { send(m: Envelope): Promise<void> }
declare function isRejected(err: unknown): boolean   // true when the far side refuses this one message (too large, malformed)

// Pausing beats retrying here: during an infrastructure outage every message
// looks poisonous, and a per-message attempt counter would dead-letter the lot.
interface Breaker { allows(): boolean; onSuccess(): void; onFailure(): void }

async function relay(source: Source, destination: Destination, breaker: Breaker) {
  for (;;) {
    if (!breaker.allows()) return   // paused; the source queue absorbs the backlog, and a scheduler re-runs relay once the breaker's reset timeout lets it probe
    const delivery = await source.receive()
    if (!delivery) return   // queue empty; the scheduler calls relay again
    try {
      // The payload crosses untouched — the bridge carries, it does not translate.
      await destination.send(delivery.message)
      breaker.onSuccess()
      // Settle last. A crash before this point redelivers, which is the
      // duplicate the receiving side is expected to absorb.
      await delivery.settle()
    } catch (err) {
      // A rejection of this one message goes to the dead-letter queue; only a link failure counts toward the breaker.
      if (isRejected(err)) { await delivery.deadLetter(); continue }
      breaker.onFailure()
      await delivery.abandon()
      return
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **Apache Camel** — An integration framework whose components cover many brokers, so a route consuming from one and producing to another is a bridge expressed in a few lines — and the same route file is where the migration path lives while endpoints move. {#wild-apache-camel}
- **RabbitMQ Shovel** — A plugin that continuously moves messages from a source queue to a destination, including to a different Advanced Message Queuing Protocol (AMQP) broker, reconnecting on its own when a link drops. {#wild-rabbitmq-shovel}
- **NServiceBus Messaging Bridge** — Ships this pattern as a named feature: endpoints on different transports exchange messages through a bridge configured with both, and the endpoints themselves are unchanged. {#wild-nservicebus-bridge}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Prefetch and batch size** — How many messages the bridge holds in flight. Larger raises throughput and widens the window in which a crash redelivers.
- **Circuit-breaker thresholds** — How many consecutive send failures pause forwarding, and how long before it probes the far side again.
- **Bridge instance count** — Scaling out with competing consumers buys throughput and gives up ordering across the boundary.
- **Maximum relayed message size** — Clamp it to the smaller of the two infrastructures at the bridge, so an oversized message fails at the crossing rather than deep on the far side.
- **Source queue quota and message lifetime** — Size it as send rate x longest outage you must ride out, as in the explain example (200 x 600 = 120,000 messages). Alert on depth well before the quota.

### Signals to watch
<!--meta polarity=signal-->

- **Source queue depth and its rate of change** — A growing backlog is how a far-side outage announces itself, since nothing else errors.
- **Relay latency, receive to settle** — The end-to-end cost the bridge adds, and the first thing to rise when either broker degrades.
- **Duplicate rate at the receiver** — The cost of at-least-once delivery, counted. A sudden jump often means the settle path is failing more often than the send path; a larger prefetch widens the redelivery window and raises it too.
- **Circuit-breaker state transitions** — Frequent opening and closing means the thresholds are chasing a partly-degraded far side rather than a clean outage.

### Failure modes under load
<!--meta polarity=failure-->

- **Retry policy condemns healthy messages** — During an infrastructure outage every message fails for the same external reason, so an attempt counter dead-letters the entire backlog.
- **Size limit discovered in production** — The larger infrastructure accepts a message the smaller one rejects, and it fails after the sender already considers it delivered.
- **Silent duplicate application** — A crash between send and settle redelivers, and a non-idempotent receiver applies the change twice.
- **Unbounded backlog during a long outage** — The source queue absorbs everything until it hits its own quota, and then the sender starts failing too.
- **Poison message trips the breaker** — One message the far side rejects for its own fault, such as oversize or malformed, counts as a link failure, opens the breaker and blocks every message behind it. Dead-letter per-message rejections; pause only on link failure.
- **Relay loop on a two-way bridge** — A forwarded message is bridged back and forth between the brokers. Stamp relayed messages with a header and skip stamped ones.

### Readiness checklist
<!--meta polarity=check-->

- The receiving side is idempotent, because relaying across two brokers is at-least-once.
- Forwarding pauses on infrastructure failure instead of exhausting a per-message retry budget.
- The route is documented as the intersection of both feature sets, with limits clamped to the smaller.
- Source queue depth is alerted on, since a far-side outage produces no other error.
- Ordering guarantees across the bridge are stated explicitly, especially before scaling it out.
- Both halves of a bidirectional bridge are monitored, not just the busier one.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Relay messages between two different brokers so both halves can talk. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Circuit Breaker](../distributed/resilience/circuit-breaker.md) — Pause forwarding during an infrastructure outage instead of burning the retry budget
- [Change Data Capture](../distributed/coordination/change-data-capture.md) — Gives a system with no broker a queue to be bridged from
- [Strangler Fig](../distributed/coordination/strangler-fig.md) — Keeps old and new halves talking while endpoints move broker one at a time

**Requires**

- [Idempotency](./idempotency.md) — Relaying across two brokers has no shared transaction, so duplicates are normal

**Often confused with**

- [Message Translator](./message-translator.md) — A bridge carries the payload untouched; the moment it reshapes it, it is a translator

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that connects two messaging systems as a ready-made building block.

<!-- relationships:end -->
