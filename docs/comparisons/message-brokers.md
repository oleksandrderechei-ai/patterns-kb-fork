---
title: Message brokers & streams
description: "Kafka, RabbitMQ, NATS, Pulsar, Redpanda and the managed queues — consumed or replayed decides it"
area: comparisons
owner: Oleksandr Derechei
tags: [messaging, asynchrony, cloud]
status: stable
aliases: [kafka, rabbitmq, nats, pulsar, redpanda, sqs, sns, kinesis]
solves: [I cannot tell whether a simple queue is enough or we need a log that keeps events, we don't want to operate a broker cluster ourselves, our queue library locks us into one cloud, consumers need to replay events from last week but they are already gone, the team wants a heavy event streaming cluster and I cannot tell whether we need it]
---

# Message brokers & streams

The brokers you can run and the services that rent you the same shapes, compared on what outlives the version numbers: consumed or replayed, how it scales, what it costs to operate, and its license.

## What this compares
<!--meta block=description-->

Several products hide behind the words "we need a queue". Kafka, RabbitMQ, NATS, Pulsar and Redpanda are brokers you install and operate; SQS (Simple Queue Service), Service Bus and Pub/Sub rent you the same shapes. A queue deletes a message on acknowledgement, and a log keeps records for a retention window. Pick the queue, then need replay, and the records were acknowledged away. The rest is degree: routing, operational attention, protocols and ownership.
## Explained
<!--meta block=explain-->

A message broker is a middleman that holds messages so the sender and the receiver need not be running at the same moment. One distinction decides most of the choice. A queue gives each message to one consumer and deletes it once handled, so it holds work. A log keeps records for a retention window and gives each reader its own position, so a consumer written next month can start from the beginning. Start with no broker: at a few thousand jobs a day, a job table in the database you already run commits with your business data. Then default to your cloud's own queue, and leave it only when you must replay records already read, or run the same design on another cloud. Choose a log when several teams read the same records at their own pace.

- **Delivery is at least once** Write every consumer to survive seeing a message twice.
- **A log orders only inside one partition** Choose the key and the partition count before traffic grows.
- **Self-hosting adds operating work** Start on the managed version.

**Example.** A topic has 6 partitions, and each consumer handles 1,500 messages a second. Six consumers, one per partition, handle 9,000 a second. At 6,000 a second, 4 consumers are enough. When traffic reaches 12,000, you need 8 consumers, but only 6 can read, because a partition has one reader in a group, so 2 sit idle and the ceiling stays at 9,000. The fix is more partitions, chosen before you need them, since changing the count later reshuffles which key goes where.

## The contenders
<!--meta block=contenders-->

- **Apache Kafka** — A partitioned, append-only log under Apache-2.0, from the Apache Software Foundation. Records outlive the read for the whole retention window and each consumer group holds its own offsets, so replay is routine; KRaft replaced ZooKeeper. Rent it as Amazon Managed Streaming for Apache Kafka (MSK), Confluent Cloud or Google's managed Kafka.
- **RabbitMQ** — The classic AMQP (Advanced Message Queuing Protocol) broker under MPL-2.0, owned by Broadcom since the VMware acquisition. Messages sit in queues and vanish on acknowledgement, and exchanges route on binding keys and headers before a message lands. It also speaks MQTT (Message Queuing Telemetry Transport) and STOMP; rent it as Amazon MQ.
- **NATS** — A small pub/sub core under Apache-2.0, hosted by the CNCF (Cloud Native Computing Foundation) — the 2025 Synadia trademark dispute settled with it staying Apache-2.0 under CNCF. The core server is one binary that stores nothing; JetStream adds durable streams and replay. No hyperscaler sells it.
- **The cloud's own services** — AWS splits the job across SQS (queues), SNS (Simple Notification Service) (fan-out), EventBridge (routing) and Kinesis Data Streams (logs); Azure across Service Bus, Event Grid and Event Hubs; Google Cloud combines queue and log in Pub/Sub. All are proprietary, billed by usage, and leave you no cluster to patch.
- **Redpanda** — The Kafka API without the JVM (Java virtual machine): one C++ binary, no ZooKeeper, and existing Kafka clients connect unchanged. It ships under the Business Source License, converting to Apache-2.0 four years after each release — read that clause before you sell what you build on it.
- **Apache Pulsar** — An Apache-2.0 broker that separates serving from storage: brokers stay stateless and segments live in BookKeeper, so retention grows without the serving tier. Multi-tenancy and geo-replication are built in, paid for with a second distributed system to operate.

## How they compare
<!--meta block=matrix-->

| Criterion | Kafka | RabbitMQ | NATS | Cloud-native services |
| --- | --- | --- | --- | --- |
| After a consumer reads it | Kept for the retention window; replay any time | Deleted on acknowledgement | Core drops it; JetStream keeps it | SQS and Service Bus delete; Kinesis, Event Hubs and Pub/Sub keep |
| Adding throughput | More partitions; a group cannot exceed them | More consumers on one queue | More subscribers, or a queue group | More consumers, shards or throughput units |
| Ordering | Per partition, never across the topic | Per queue, one consumer only | Per subject in JetStream | SQS first in, first out (FIFO) groups; Pub/Sub ordering keys |
| Delivery guarantee | At least once; exactly-once only inside Kafka | At least once; missed acks redeliver | At most once in core, at least once in JetStream | At least once |
| Running it yourself | A JVM cluster, disks and rebalances | A modest cluster; quorum queues for durability | One small binary | Nothing — that is the purchase |
| Routing done by the broker | None; consumers filter | Exchanges match binding keys and headers | Subject wildcards | EventBridge and Event Grid rules; SNS filter policies |
| Client protocols | The Kafka protocol, implemented by many vendors | AMQP, MQTT, STOMP | Its own, clients for most languages | Vendor SDKs; Event Hubs speaks Kafka too |
| License and owner | Apache-2.0, Apache Software Foundation | MPL-2.0, Broadcom | Apache-2.0, CNCF | Proprietary, one vendor each |

## Choosing between them
<!--meta block=choosing-->

Start by running no broker. At a few thousand jobs a day, a job table in the database you already have commits with the business data and adds nothing to your on-call rotation. Move off it when polling latency or lock contention shows in your metrics.

Default to your cloud's own queue next. SQS, Service Bus and Pub/Sub give you [competing consumers](../patterns/messaging/competing-consumers.md), dead-letter destinations and retries as configuration. Leave that default for two reasons: you must replay records a consumer has read, or you must run the same design on another cloud.

Choose Kafka when the log is the integration backbone — several teams reading the same records at their own pace, replay treated as routine. Budget people before machines: start on a managed Kafka, and self-host when the invoice beats an operator's salary.

Choose RabbitMQ when routing beats volume. Binding keys, header matching and per-queue policies rewire who receives what without redeploying producers, which is worth more than partitions at thousands of messages a second rather than millions.

Choose NATS when footprint and latency dominate — edge nodes, service meshes, request-reply between services. The server costs so little that you can put one in every cluster, and you enable JetStream only where a message must survive a restart.

Choose Redpanda for the Kafka API without a JVM cluster, accepting its Business Source License. Choose Pulsar when tenants must stay isolated in one platform or regions must replicate without you writing the mirroring, and staff for BookKeeper.

Whatever you pick, write every consumer to survive seeing a message twice — that decision outlives the broker you chose it for.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Specializes**

- [Messaging & Eventing](../capabilities/messaging.md) — The capability page names the four shapes; this one picks the product that gives you them.

**Implements**

- [Message Queue](../patterns/messaging/message-queue.md) — Every product compared here sells this pattern; the page is about which one to run.
- [Publish-Subscribe](../patterns/messaging/pubsub.md) — Fan-out is table stakes in all of them — the comparison is where the filtering happens.
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — Queue-shaped contenders scale this way; log-shaped ones cap it at the partition count.
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — The buffer between producer and consumer is what you are choosing a product for.
- [Sequential Convoy](../patterns/messaging/sequential-convoy.md) — Each broker scopes ordering differently: per partition, per queue or per message group.

<!-- relationships:end -->
