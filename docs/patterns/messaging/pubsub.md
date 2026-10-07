---
title: Publish-Subscribe
description: Publishers and subscribers never know about each other
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling, asynchrony]
status: stable
aliases: [pub/sub]
solves: [every time another team needs to know about orders I have to edit and redeploy my service, my checkout function has a hard-coded list of six other services to notify, one non-essential downstream being down fails the whole request, I do not know who needs to react to this event and I do not want to have to know, the notify step keeps growing and now it is the slowest part of my request]
favourite: true
---

# Publish-Subscribe

Publishers broadcast to a topic and subscribers listen to it, but neither ever holds a reference to the other — decoupled in identity, in number, and in time.

## What it is
<!--meta block=description-->

A publisher that calls each interested service waits on all of them and must know every address. Publish-subscribe has it announce an event to a named topic instead, and a broker delivers a copy to every subscriber. The publisher holds no addresses and does not wait, adding a consumer needs no publisher change, and with durable subscriptions consumers need not be online. The cost is that who consumes an event moves from code into topic names, schemas and configuration.

## Explained
<!--meta block=explain-->

Publish-subscribe lets a service announce an event to a named topic and leaves delivery to a broker that hands a copy to every subscriber. The publisher holds no addresses, does not wait for answers and, with durable subscriptions, does not need the consumers to be up, so you add an eleventh consumer without touching it. Choose it over direct calls when the set of consumers is unknown or growing, and use a [queue](message-queue.md) instead when each message needs just one worker.

- **Dual write.** Publishing and the database write are two steps, so a crash between loses an event; use an outbox table in the same transaction.
- **Dropped messages.** A non-durable subscription loses messages while nobody listens and tells the publisher nothing, so make it durable when loss matters.
- **Schema drift.** A renamed field breaks consumers the publisher cannot list, so version the topic schema and check compatibility before release.

**Example.** A signup service publishes user.signed_up at 50 a second. Three consumers need it: email, customer relationship management (CRM) and fraud. Called directly, they take 100, 150 and 250 ms, so signup waits 500 ms, and a CRM outage fails the signup. Published to a topic, signup returns after one publish, and a durable CRM subscription catches up after its outage. A fourth consumer, analytics, subscribes next month with no change to the publisher, and deliveries rise from 150 to 200 a second. The cost is that nothing in the signup code now says who consumes the event, so keep a list of subscribers.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one announcement reach services the publisher has never heard of? Step 1 addresses the topic and nothing else; each subscription holds its own copy, so a fourth subscriber joins at step 2 without step 1 changing."
flowchart LR
    Pub["Order Service"]
    subgraph Brk["Broker — neither side holds a reference to the other"]
        Topic[("order.placed topic")]
        SubP[("Payments subscription")]
        SubS[("Stock subscription")]
        SubA[("Analytics subscription")]
    end
    Pay["Payments Service"]:::ext
    Stock["Stock Service"]:::ext
    Anl["Analytics Service"]:::ext
    Pub -->|"1 publish order.placed"| Topic
    Topic -->|"2 one copy per subscription"| SubP
    Topic -->|"2"| SubS
    Topic -->|"2"| SubA
    SubP -->|"3 deliver, then ack"| Pay
    SubS -->|"3"| Stock
    SubA -->|"3"| Anl
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Topic-based vs. [content-based](./content-based-router.md)** — Subscribe to a named channel, or subscribe with a predicate over message content and let the broker filter — content-based is more expressive but costs the broker more to evaluate.
- **Broker-mediated vs. broker-less** — A central broker matches and routes messages, or publishers and subscribers discover each other directly over multicast — broker-less removes a hop but pushes discovery and fan-out onto every node.
- **Durable vs. ephemeral subscriptions** — A durable subscription is remembered and replayed from where a subscriber left off, even after downtime; an ephemeral one only sees messages published while it's connected.
- **[Competing Consumers](./competing-consumers.md) groups** — Group subscribers so the topic still broadcasts once per group, but only one member within a group handles each message — broadcast and load-sharing at the same time.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Publishers and subscribers are decoupled** in space and synchronization, and in time when subscriptions are durable: neither needs the other to exist or respond, or to run at the same moment.
- **New subscribers attach without any change** to the publisher or its deploy.
- **Broadcast to an unknown or changing number** of listeners is a first-class operation, not a loop over a hard-coded list.
- **A broker can buffer, batch, and smooth bursts** that would overload a direct caller, when subscriptions are durable, though each subscriber still receives its own full copy of the burst.

### Cons
<!--meta polarity=con-->

- **Delivery guarantees** — at-least-once delivery, ordering and exactly-once effects — are now the system's problem, not one function call's: an [outbox](../distributed/coordination/outbox.md) makes publishing atomic with the write, an [inbox](../distributed/coordination/inbox.md) dedupes on receipt, and ordering holds only per key or partition.
- **Consumers are hidden** — who consumes a topic and why lives in configuration and tribal knowledge, not in code a compiler can check.
- **Debugging a request means tracing across processes** and topics instead of stepping through a call stack — carry a [correlation identifier](./correlation-identifier.md) on every message so the hops can be stitched back into one story.
- **The broker is critical infrastructure** — its availability, throughput, and retention now bound the whole system.
- **A message published to a non-durable subscription** while nobody is listening is dropped, and the publisher is never told — make the subscription durable when the loss would matter.
- **Every subscriber decodes the publisher's** payload, so a field the publisher renames breaks consumers it cannot enumerate — version the topic's schema and check compatibility before the producer ships, because you will not find out from a build failure.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **An unknown or growing number** of services need to react to the same event.
- **You want to add consumers without redeploying** or even informing the producer.
- **Producer and consumers run in different processes**, services, or teams and shouldn't share a deploy.

### Avoid when
<!--meta polarity=avoid-->

- **There's exactly one consumer and it lives in-process** — a direct call or [Observer](../gof/behavioral/observer.md) is simpler and traceable.
- **The workflow needs a response before continuing** — publishing is one-directional and carries no return channel, so a synchronous answer needs a request-reply arrangement instead.
- **Each message must go** to exactly one of several workers, not to all of them — that's [Message Queue](./message-queue.md) semantics, not broadcast.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal in-memory broker"
type Handler<T> = (payload: T) => void;

class Broker {
  private topics = new Map<string, Set<Handler<unknown>>>();

  subscribe<T>(topic: string, handler: Handler<T>): () => void {
    const handlers = this.topics.get(topic) ?? new Set();
    handlers.add(handler as Handler<unknown>);
    this.topics.set(topic, handlers);
    return () => handlers.delete(handler as Handler<unknown>);
  }

  publish<T>(topic: string, payload: T): void {
    for (const handler of this.topics.get(topic) ?? []) {
      handler(payload); // synchronous in-process call: the publisher waits, and a throwing handler stops delivery; a real broker decouples this
    }
  }
}

const bus = new Broker();
const unsubscribe = bus.subscribe<string>("order.placed", (id) =>
  console.log(`ship ${id}`),
);
bus.publish("order.placed", "order-42");
```

## In the wild
<!--meta block=wild-->

- **Apache Kafka** — Publishers append to a partitioned topic; each consumer group tracks its own offset, so groups read independently and can replay. Retention is bounded by retention.ms or retention.bytes, and ordering holds within a partition, not across the topic. {#wild-kafka}
- **MQ Telemetry Transport (MQTT)** — A lightweight pub/sub protocol for the Internet of Things (IoT): subscribers match topic filters with the + and # wildcards, three Quality of Service (QoS) levels trade delivery guarantee for overhead, and a retained message gives a new subscriber the last value on a topic immediately. {#wild-mqtt}
- **Google Cloud Pub/Sub** — Publishers write to a topic and each subscription gets an independent copy of the stream; a per-message ackDeadline governs redelivery, unacked messages are retained up to the configured window, and a dead-letter topic catches messages that exceed a max delivery attempts. {#wild-gcp-pubsub}
- **Amazon Simple Notification Service (SNS)** — Publish to a topic and SNS pushes each message to every subscription: Simple Queue Service (SQS) queues, Lambda functions, HTTP/S endpoints or email. Per-subscription filter policies match message attributes so a subscriber only receives matching messages, and undeliverable messages go to a redrive dead-letter queue. Standard topics favour throughput with best-effort ordering; first in, first out (FIFO) topics give strict ordering and deduplication at a lower per-topic throughput cap (check current quotas). {#wild-sns}
- **Amazon EventBridge** — The routing-heavy end of the same idea: producers put events on a bus and subscribers are rules rather than subscriptions, matching on the content of the event and fanning each match out to its own targets. It buys content-based routing and filtering across producers that speak different shapes, at the cost of the wiring living in rule definitions rather than in either side's code. {#wild-eventbridge}
- **NATS** — Subject-based publish and subscribe with wildcard subscriptions, deliberately kept small and in-memory by default; durable streams are an opt-in layer on top rather than the baseline. {#wild-nats}
- **ZeroMQ** — The brokerless form: a socket library with a publish/subscribe socket type, so fan-out happens between peers with no server in the middle — and with no broker there is no durability, no replay and no backpressure but the socket's own. {#wild-zeromq}
- **Azure Web PubSub** — Publish and subscribe carried over WebSocket connections to browser and mobile clients, so the fan-out reaches end users directly instead of stopping at the service boundary. {#wild-azure-web-pubsub}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Subscription durability** — Whether the broker remembers a subscriber position across disconnects (durable) or delivers only while connected (ephemeral).
- **Retention window** — How long the broker keeps published messages available for replay or a late subscriber before discarding them; size it above the longest subscriber outage you accept, then check storage use against the broker storage signal.
- **Message time-to-live** — The age past which an undelivered message is discarded rather than held for a lagging consumer.
- **Acknowledgement deadline** — How long a subscriber has to acknowledge (ack) a delivered message before the broker redelivers it.
- **Per-subscription concurrency / consumer-group size** — How many consumers share one subscription to spread its load.
- **Max delivery attempts and retry backoff** — How many times, and how far apart, the broker redelivers an unacknowledged message before it moves to the dead-letter destination.

### Signals to watch
<!--meta polarity=signal-->

- **Per-subscription backlog / consumer lag** — Messages published but not yet consumed by a given subscription; the first number to alert on for each consumer.
- **Oldest unacknowledged message age** — How long the slowest subscription has fallen behind the head of the topic; alert when it approaches the retention window or the message time-to-live, because past that point messages are lost.
- **Redelivery / negative-ack rate** — Messages redelivered after a missed or negative ack, signaling failing or slow handlers.
- **Broker storage for retained messages** — Disk used by the retention window; a stuck durable subscription holds messages back, so disk use keeps growing.
- **Dead-letter queue depth and growth rate** — Messages parked after exceeding the attempt limit; a rising count points to a poison message or a failing handler.

### Failure modes under load
<!--meta polarity=failure-->

- **Slow or offline subscriber pins retention** — A durable subscription that stops consuming holds the retention floor; the broker cannot discard messages and disk fills.
- **Fan-out amplification** — One published message multiplies into a delivery per subscription; a publish burst hits every subscriber at once; cap per-subscription buffers or delivery rates, and size broker capacity as subscribers times publish rate.
- **Retention expiry data loss** — A subscriber down longer than the retention window permanently loses the messages published while it was gone.
- **Silent drop to an absent ephemeral subscriber** — A message published while nothing is listening on a non-durable subscription is discarded, and the publisher gets no signal that anything was missed.
- **Duplicate or reordered delivery** — At-least-once redelivery double-applies non-idempotent handlers, and ordering is not preserved across partitions, where the broker splits a topic into them.

### Readiness checklist
<!--meta polarity=check-->

- Subscribers are idempotent (handling a message twice changes nothing), because at-least-once delivery means duplicates.
- Per-subscription lag and backlog are monitored and alerted
- The retention window exceeds the longest tolerable subscriber downtime
- Each subscription durability (durable vs. ephemeral) is a deliberate choice
- Messages that go stale carry a relevance timestamp, and consumers check it before acting
- Every subscription has a dead-letter destination and an attempt limit, so one poison message cannot park it
- Each topic has a documented, versioned message schema

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Streaming](../../themes/streaming.md) — Fan a stream out to many subscribers {#fluency-streaming}
- [Real-Time Updates](../../themes/realtime-updates.md) — Broadcast updates to connected servers via a broker {#fluency-realtime-updates}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Competing Consumers](./competing-consumers.md) — Fan out to groups, share within a group
- [Domain Event](../ddd/domain-event.md) — Publish domain events to interested parties
- [Wire Tap](./wire-tap.md) — An extra subscriber can observe the flow without the others noticing
- [Correlation Identifier](./correlation-identifier.md) — Carry a correlation id on every message, so a request can still be followed across the hops the topic decoupled
- [Dead Letter Channel](./dead-letter-channel.md) — A subscription needs an attempt cap and somewhere for the poison message to go
- [Outbox](../distributed/coordination/outbox.md) — The outbox makes publishing atomic with the write
- [Inbox](../distributed/coordination/inbox.md) — The inbox makes receiving atomic with processing
- [Long Polling](./long-polling.md) — A parked long-poll request is one kind of subscriber waiting on a topic.
- [Server-Sent Events](./server-sent-events.md) — An open server-sent events (SSE) stream is a push channel from a topic to a browser.
- [WebSocket](./websocket.md) — A WebSocket is the last hop that delivers a topic's events to a client.
- [Event-Carried State Transfer](./event-carried-state-transfer.md) — A topic carrying full state lets consumers build replicas.
- [Idempotency](./idempotency.md) — Redelivery after a missed acknowledgement means every subscriber must tolerate a repeat.

**Specializes**

- [Observer](../gof/behavioral/observer.md) — Pub/Sub is Observer across process boundaries

**Part of**

- [Event-Driven Architecture](../architecture/eda.md) — Event-driven systems are wired with pub/sub

**Often confused with**

- [Producer-Consumer](../concurrency/producer-consumer.md) — One-to-one hand-off vs. broadcast
- [Message Queue](./message-queue.md) — Broadcast to many vs. one consumer per message
- [Fan-Out](./fan-out.md) — Pub/sub is how you wire it; fan-out is the one-to-many delivery shape it produces.
- [Recipient List](./recipient-list.md) — Subscribers choose what they receive; with a recipient list the sender computes the list.

**Exposed to**

- [Poison Message](../../hazards/poison-message.md) — Can fall into poison message when a subscriber that keeps failing on one event redelivers it without end

**Demonstrated by**

- [WhatsApp](../../designs/whatsapp.md) — decoupling publishers from subscribers is exactly what lets message routing scale across hundreds of independent chat servers
- [Facebook Live Comments](../../designs/fb-live-comments.md) — one comment published to a channel reaches every server holding a subscriber, decoupling the writer from an unknown, churning set of readers
- [Online Chess](../../designs/online-chess.md) — decoupling the claiming worker from the connection-holding node through a channel is publish/subscribe doing exactly its job
- [Dropbox](../../designs/dropbox.md) — sync is a publish/subscribe fan-out of change events to every device subscribed to a user's folder
- [ChatGPT](../../designs/chatgpt.md) — decoupling token producers (workers) from consumers (connection-holding instances) through a keyed channel is publish/subscribe fanout
- [Online Auction](../../designs/online-auction.md) — coordinating real-time bid updates across many servers is a direct pub/sub deployment
- [Robinhood](../../designs/robinhood.md) — publishers and the server-sent events (SSE)-fronting subscribers stay decoupled per symbol channel, with subscriptions tracking live demand
- [CamelCamelCamel](../../designs/camelcamelcamel.md) — fanning price-change events out to independent notification consumers over a topic is publish/subscribe at work

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — A managed topic is this pattern as a product.
- [Message brokers & streams](../../comparisons/message-brokers.md) — The brokers that give you fan-out, compared on filtering, replay and ops burden.

<!-- relationships:end -->
