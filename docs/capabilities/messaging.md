---
title: Messaging & Eventing
description: "Queues, topics, event buses and streams — a queue is consumed, a stream is replayed"
area: capabilities
owner: Oleksandr Derechei
tags: [messaging, decoupling, asynchrony, cloud]
status: stable
aliases: [message brokers, eventing, queues and topics]
solves: [I know the AWS queue service but not what it is called on Azure or Google Cloud, we cannot rebuild our report data because the queue deleted every message once it was read, the same order got processed twice even though the broker is fully managed, publishes started failing because the payload outgrew the message size limit, our messaging bill went up in step with every subscriber we added]
---

# Messaging & Eventing

Four shapes of managed messaging — queue, topic, event bus and stream — what each one is actually for, what every cloud calls it, and why a queue is consumed while a stream is only read.

## What the cloud gives you here
<!--meta block=description-->

Every cloud sells the same job here: a durable place to put a message, so the sender and the receiver need not be healthy at the same instant. It comes as a queue, a topic, an event bus or a stream. A queue is consumed and a stream is read, and picking the wrong one is the afternoon you find you cannot replay history.

## Explained
<!--meta block=explain-->

A managed messaging service is a durable place to put a message, so the sender and the receiver need not be healthy at the same moment. Choose on one question first: will a reader you have not met yet need these records? If so, take a stream, an ordered log that readers move through at their own pace, because queue messages are deleted once handled and a stream keeps them. The retention window is the hard edge of how far back you can replay. If not, use a queue for a task with one owner or a topic for an announcement with many listeners.

- **Duplicates are normal** Delivery is at least once, so check a deduplication key against a store you own, because a broker's own window is short.
- **Strict ordering lowers throughput** Require it per key, never globally.
- **Fan-out bills per delivery** One event to twenty subscriptions costs twenty, so let consumers pull from one stream instead.
- **No broker joins your database transaction** Write the message into your own database in the same commit and send it from there.

**Example.** An order service emits 1,000 events a day. A month later, analytics wants the last 30 days. Through a queue, every event was deleted once handled, so it gets 0 events. Through a stream with 7 days of retention it gets 7,000. With 30 days of retention it gets all 30,000. The cost is storage for 30,000 events, plus a consumer that must tolerate seeing any of them twice. Without a deduplication key, a crash before the consumer saves its position counts some orders twice.

## The capabilities
<!--meta block=capabilities-->

- **[Point-to-point queue](../patterns/messaging/message-queue.md)** — A durable line of work items where each message goes to exactly one consumer and is deleted when that consumer acknowledges it. Reach for it when the message is a task with an owner: adding consumers divides the backlog rather than duplicating the work.
- **[Publish-subscribe topic](../patterns/messaging/pubsub.md)** — A named channel that copies every published message to every subscription attached to it. Reach for it when the message is an announcement rather than a task, and the publisher must not learn who is listening.
- **[Event bus with content routing](../patterns/messaging/content-based-router.md)** — A topic with a matching engine in front of it: rules read fields inside the message and decide which targets receive it. It turns wiring a new consumer into a configuration change instead of a deploy of the publisher, and it is where the provider's own events — a file landed, a machine started — are published for you to subscribe to.
- **Append-only stream with replay** — An ordered log of records, partitioned for throughput and retained for a fixed window, where every reader tracks its own position. Reach for it when a second reader may appear later, because the record survives being read and a consumer built next month can start from the beginning.
- **Lease-based redelivery** — The broker hands a message to one consumer and hides it for a lease; when no acknowledgement arrives before the lease expires, the message returns to the queue. This is where at-least-once comes from, and why a consumer that finishes its work and then dies will see the same message a second time.
- **[Dead-letter destination](../patterns/messaging/dead-letter-channel.md)** — A separate queue or topic that receives a message once delivery has failed a set number of times. It stops one poison message from blocking the consumer forever, and it puts the failure somewhere you can read it.
- **[Subscription filters](../patterns/messaging/message-router.md)** — A predicate attached to a subscription so the broker delivers only the messages that match it. It moves the if-statement out of your consumer and into the broker, which cuts both the delivery bill and the wasted invocations.
- **Ordering and deduplication modes** — An opt-in mode that delivers messages in order within one key, partition or session, and discards a republished duplicate inside a short window. Both are scoped rather than absolute: order holds inside a partition and never across the service, and the deduplication window is bounded, from 5 minutes on SQS (Simple Queue Service) FIFO (first in, first out) to a configurable 7 days at most on Service Bus.
- **Delayed and scheduled delivery** — Publishing a message now that becomes visible to consumers only after a delay or at a chosen time. It covers retry backoff, reminders and anything else where the work is known but not yet due, with no scheduler of your own to run.
- **Managed Kafka** — The Kafka protocol operated for you, so existing Kafka clients, connectors and stream-processing jobs keep working unchanged. Reach for it when your portability requirement is the client library rather than the service, and accept that the topic and partition layout stays your problem.
- **Stateful workflow orchestration** — A managed state machine that calls services in order, waits, retries and runs compensating steps, with the position of every run persisted for you. Reach for it when the coordination itself has to survive a restart — it is where a [saga](../patterns/distributed/coordination/saga.md) becomes a definition the provider runs rather than retry code in your service.
- **Device-facing MQTT broker** — A broker speaking MQTT (Message Queuing Telemetry Transport) over long-lived connections, sized for many small, intermittently connected clients rather than a few servers. It carries a per-device identity and per-device credentials, which is the part you would otherwise build and rotate yourself.

## What each cloud calls it
<!--meta block=mapping-->

| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Point-to-point queue | Amazon SQS | Azure Queue Storage | Pub/Sub with one pull subscription; Cloud Tasks for HTTP task dispatch | [RabbitMQ](../comparisons/message-brokers.md) |
| Publish-subscribe fan-out | Amazon SNS | Azure Service Bus topics | Pub/Sub | RabbitMQ, NATS |
| Event bus with content routing | Amazon EventBridge | Azure Event Grid | Eventarc | RabbitMQ topic exchanges |
| Append-only stream with replay | Amazon Kinesis Data Streams | Azure Event Hubs | Pub/Sub | Apache Kafka |
| Dead-letter destination | SQS and SNS dead-letter queues | Service Bus dead-letter queue | Pub/Sub dead-letter topic | RabbitMQ dead-letter exchanges |
| Ordered delivery | SQS FIFO queues | Service Bus sessions | Pub/Sub ordering keys | Kafka partitions |
| Filtering on the subscription | SNS filter policies | Service Bus subscription rules | Pub/Sub subscription filters | RabbitMQ bindings |
| Delayed and scheduled delivery | SQS delay queues and message timers | Service Bus scheduled messages | Cloud Tasks schedule time | Apache ActiveMQ Artemis scheduled messages |
| Delivery to an HTTP endpoint you own | EventBridge API destinations | Event Grid webhook subscriptions | Pub/Sub push subscriptions | no direct open-source equivalent |
| Enterprise broker: sessions, transactions, Java Message Service (JMS) | Amazon MQ | Azure Service Bus | no first-party equivalent | Apache ActiveMQ Artemis |
| Managed Kafka | Amazon MSK | Event Hubs Kafka endpoint | Managed Service for Apache Kafka | Apache Kafka |
| Stateful workflow orchestration | AWS Step Functions | Azure Durable Functions, Logic Apps | Workflows | [Temporal](../comparisons/workflow-orchestrators.md), Airflow |
| Device-facing MQTT broker | AWS IoT Core | Azure IoT Hub | no first-party equivalent | Eclipse Mosquitto, EMQX |
| Mobile push notification | Amazon SNS mobile push | Azure Notification Hubs | Firebase Cloud Messaging | no direct open-source equivalent |
| Transactional email | Amazon SES | Azure Communication Services | no first-party equivalent | Postfix |
| Message routing and transformation flows | AWS Step Functions, Amazon EventBridge Pipes | Azure Logic Apps | Application Integration | Apache Camel, Spring Integration |
| Change data capture | DynamoDB Streams | Azure Cosmos DB change feed | Datastream | Debezium |
| Event store database | no first-party equivalent | no first-party equivalent | no first-party equivalent | KurrentDB (source-available) |
| Schema registry | AWS Glue Schema Registry | Azure Schema Registry in Event Hubs | Pub/Sub schemas | Apicurio Registry |

## Choosing between them
<!--meta block=choosing-->

Ask one question before you read a single product name: will a reader you have not met yet need these records? If it might, you need a stream, because retention plus a per-reader offset is the only arrangement that lets a consumer written later start from the beginning. If it will not, ask the second question instead — is this message a task with exactly one owner, or an announcement with an audience?

| If you need… | Choose | Because |
| --- | --- | --- |
| Each job done once, by whichever worker is free | Queue | The acknowledgement deletes the message, so [competing consumers](../patterns/messaging/competing-consumers.md) divide the backlog instead of repeating it |
| Several unrelated services to react to one fact | Topic | Every subscription gets its own copy, and the publisher never learns who is listening |
| To route on what is inside the message | Event bus | The matching rules live in the bus, so a new consumer is configuration rather than a publisher deploy |
| To feed history into a consumer that does not exist yet | Stream | Records survive being read, and each reader keeps its own position in the log |
| To absorb a burst your database cannot take | Queue in front of the workers | [Load leveling](../patterns/distributed/resilience/load-leveling.md) stops arrival rate and processing rate from being the same number |
| Per-customer order, at volume | Stream partitioned by customer | Order is guaranteed inside a partition, so partitioning by the key you care about is the only version that scales |
| Somewhere for messages that keep failing | Dead-letter destination | One poison message stops blocking the consumer and becomes a thing you can inspect and replay |

The broker gives you at-least-once and you still owe idempotency. A consumer that completes its work and dies before acknowledging will be handed the same message again, and buying the queue instead of running it moves that redelivery into someone else's operations rather than out of your data. Give every message a stable key, record the keys you have already applied, and check that record before you act — a broker's own deduplication window is bounded, from 5 minutes on SQS FIFO to 7 days at most on Service Bus, and your retries, replays and redeployments do not respect it.

The adjacent debt is the write. No broker joins your database transaction, so a state change plus a publish is two operations that can disagree: commit the row, crash before the publish, and nothing downstream ever hears about it. Write the event into your own database in the same commit and relay it from there — that is the [outbox](../patterns/distributed/coordination/outbox.md), and this capability is the clearest case on the site of a managed service that implements several patterns for you and leaves the adjacent one entirely yours.

Then watch the depth. A managed queue will accept far more than your consumers can drain and bill you for the storage, so the buffer that was protecting you becomes an [unbounded queue](../hazards/unbounded-queue.md) with an hour of latency in it; alarm on queue depth and oldest-message age, not on error rate, and apply [backpressure](../patterns/concurrency/backpressure.md) at the producer when depth stops falling. The drain is the other half: a backlog released after an outage arrives as fast as your consumers can pull it, which is a [thundering herd](../hazards/thundering-herd.md) aimed at whatever those consumers call next.

## What does not port
<!--meta block=portability-->

- **Maximum message size differs by an order of magnitude**: one service's ceiling is measured in hundreds of kilobytes and another's in megabytes, so a payload that publishes today can fail after a port with nothing else changed. Put the body in object storage and send the key — the [claim check](../patterns/messaging/claim-check.md) is not an optimisation here, it is what keeps the design movable.
- **Ordering is a mode with a ceiling, not a flag**: ordered and session-based delivery mean a distinct queue type or an ordering key set at publish time, and they carry throughput limits the unordered path does not have. Turning one on for an existing deployment is often a new resource and a cutover rather than a setting you flip.
- **Retention sets your maximum replay**: a stream keeps records for a window measured in days, and extending it is a billed option rather than a free setting. That number is your replay horizon, so pick it deliberately and land a copy in object storage if you need history beyond it.
- **Dead-lettering is automatic on some services and wiring on others**: some brokers give you the dead-letter destination and the retry count by default, while elsewhere you create the target and attach a policy, and a queue with no policy retries a poison message forever. Check which one you have before the first poison message, because otherwise you find out from a stuck consumer.
- **Lease semantics and in-flight limits differ**: how many messages one consumer may hold unacknowledged, how long the lease lasts, and whether you can extend it mid-job all vary. A long job under a short lease is the classic import — the message is redelivered while the first consumer is still working, and the work runs twice.
- **Fan-out is billed per delivery**: per-message pricing multiplies by subscriber count, so one event across twenty subscriptions is twenty billable deliveries and twenty invocations. Where consumers can pull instead, one stream with independent readers costs a fraction of the same [fan-out](../patterns/messaging/fan-out.md) expressed as subscriptions.
- **One provider's topic is another's stream**: some clouds sell publish-subscribe and streaming as two services with different pricing and different replay behaviour, and others fold both into one. Map on the two properties that decide your design — is the record deleted on acknowledgement, and does each reader keep an offset — never on the name.
- **Exactly-once is always scoped**: where a provider offers it, the guarantee holds inside a window, a partition or a single subscription, and it says nothing about the side effects your consumer performs against other systems. Read the scope, then write the consumer as though the guarantee were not there.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Generalizes**

- [Message brokers & streams](../comparisons/message-brokers.md) — The product decision inside this capability: which broker or stream to actually run.
- [Workflow orchestrators](../comparisons/workflow-orchestrators.md) — The orchestration slice of this capability, product by product.

**Requires**

- [Idempotency](../patterns/messaging/idempotency.md) — Managed brokers deliver at least once; deduplication stays yours to write.

**Implements**

- [Message Queue](../patterns/messaging/message-queue.md) — Managed queues are this pattern with the broker operated for you.
- [Publish-Subscribe](../patterns/messaging/pubsub.md) — Topics and subscriptions, with fan-out handled by the broker.
- [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) — A dead-letter queue or topic is configuration, not code, on managed brokers.
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — Consumer groups and visibility timeouts implement the competition for you.
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — A queue between producer and consumer is what the managed service is for.
- [Fan-Out](../patterns/messaging/fan-out.md) — A topic delivers one publish to every subscriber, which is this pattern as a hosted primitive.
- [Content-Based Router](../patterns/messaging/content-based-router.md) — An event bus matches the message body against rules and picks the destination for you.
- [Sequential Convoy](../patterns/messaging/sequential-convoy.md) — First in, first out (FIFO) message groups and broker sessions keep one related run in order while others proceed in parallel.
- [Scheduling](../patterns/concurrency/scheduling.md) — Delay and schedule fields on a message move the timer into the broker.
- [Event-Driven Architecture](../patterns/architecture/eda.md) — An event bus carries the events and routes them to consumers for you.
- [Producer-Consumer](../patterns/concurrency/producer-consumer.md) — A managed queue is the buffer between the producers and the consumers.
- [Message Router](../patterns/messaging/message-router.md) — A subscription filter makes the broker deliver only the messages that match.
- [Splitter](../patterns/messaging/splitter.md) — Integration flows and the Apache Camel library cover the step that splits one message into many.
- [Aggregator](../patterns/messaging/aggregator.md) — Integration flows and the Apache Camel library cover the step that combines related messages into one.
- [Scatter-Gather](../patterns/messaging/scatter-gather.md) — Integration flows and the Apache Camel library cover the step that sends a request to several parties and collects the replies.
- [Content Enricher](../patterns/messaging/content-enricher.md) — Integration flows and the Apache Camel library cover the step that adds data to a message in flight.
- [Message Translator](../patterns/messaging/message-translator.md) — Integration flows and the Apache Camel library cover the step that converts a message between formats.
- [Wire Tap](../patterns/messaging/wire-tap.md) — Integration flows and the Apache Camel library cover the step that copies messages to a side channel.
- [Recipient List](../patterns/messaging/recipient-list.md) — Integration flows and the Apache Camel library cover the step that sends a message to a computed list of recipients.
- [Routing Slip](../patterns/messaging/routing-slip.md) — Integration flows and the Apache Camel library cover the step that sends a message along a route it carries.
- [Resequencer](../patterns/messaging/resequencer.md) — Integration flows and the Apache Camel library cover the step that restores the order of out-of-order messages.
- [Polling Consumer](../patterns/messaging/polling-consumer.md) — Integration flows and the Apache Camel library cover the step that pulls messages on a schedule.
- [Messaging Bridge](../patterns/messaging/messaging-bridge.md) — Integration flows and the Apache Camel library cover the step that connects two messaging systems.
- [Outbox](../patterns/distributed/coordination/outbox.md) — Change feeds and Debezium read committed rows and publish them, which is the relay half of this pattern.
- [Event Sourcing](../patterns/architecture/event-sourcing.md) — An event store database keeps the append-only log of events per entity.
- [Message Encoding](../patterns/messaging/message-encoding.md) — A schema registry holds the versioned schemas producers and consumers encode against.

<!-- relationships:end -->
