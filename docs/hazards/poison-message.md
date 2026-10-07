---
title: Poison Message
description: "One message that always fails its consumer is redelivered forever, blocking the queue or burning capacity"
area: hazards
owner: Oleksandr Derechei
tags: [messaging, error-handling]
status: stable
aliases: [poison pill, poisoned message, stuck message]
solves: [one message keeps failing with the same error every few seconds and the queue behind it is not moving, the oldest message in the queue gets older while the worker logs the same exception again and again, a consumer crashes or runs out of memory each time it picks up one particular message, retries never end for one bad message and they keep using worker capacity that good messages need]
---

# Poison Message

A poison message is one message that fails its consumer every time it is tried, so the broker redelivers it forever and it blocks the queue or burns capacity on attempts that cannot succeed.

## What it is
<!--meta block=description-->

A poison message is a message whose content, not the moment, makes processing fail, such as a malformed date or a missing field. You see one message id fail with the same exception every few seconds, while the oldest-message age climbs and, in a worker pool, depth barely moves. The defining trait is that retrying is the wrong response: the fault is permanent, and nothing in the system says when to stop.

## Explained
<!--meta block=explain-->

A poison message is a message that fails its consumer every time because of its content, not because of timing. A date the parser rejects or a field the code assumes is there makes the consumer throw, the broker sees no acknowledgement, and it delivers the message again. A failure from a brief outage clears on retry, but this one never does. In an ordered queue or a single partition, everything behind it waits. In a pool of workers, each retry takes a worker and calls any dependency again. The worst form crashes the consumer process, so it cannot count attempts itself. Decide where the retry stops. Count deliveries outside the consumer, and after 3 to 5 attempts move the message with its error to a dead letter channel so the main queue moves on. Send errors that can never succeed, like parse failures, there on the first try, and retry only the transient ones with backoff. Validate at the producer, and alert on the oldest-message age.

**Example.** A payments queue handles 400 messages a second. A message arrives with an amount field of null, and the consumer throws on it. With no attempt limit, the broker redelivers it every 5 s, and in an ordered partition 400 messages a second pile up behind it, so after 10 minutes 240,000 are waiting. With a limit of 5 attempts, the fifth fails at 20 s and the message is parked by about 25 s, so the backlog is at most 10,000, and an alert on the dead letter depth pages the owner. A consumer that classifies the null as a validation error skips the retries and parks it on the first try.

## How it happens
<!--meta block=causes-->

It starts with a default that is right most of the time. A message fails, so it goes back on the queue and is tried again, because most failures are a brief outage. Nothing in that loop tells a permanent failure from a brief one, so a message that can never succeed is retried at the same pace as one that will succeed in a second. Each pass costs a delivery, a log entry and a worker's time.

```mermaid caption="Why one bad message never leaves: each failed attempt returns it to the queue, and nothing counts the attempts or tells a permanent failure from a transient one."
flowchart LR
    Q["Queue"] -->|"deliver"| C["Consumer"]
    C -->|"throws, no ack"| R["Broker requeues"]
    R -->|"redeliver at once"| Q
    C -->|"same error each time"| L["Error log fills"]
    Q -.->|"behind it, waiting"| M["Healthy messages"]
```

- Retry on every error with no limit, so a permanent failure and a transient one get the same treatment forever.
- No way to classify errors, such as a malformed payload that fails parsing every time, so nothing routes unretryable ones aside.
- Messages accepted without checks at the producer or the edge, so a bad payload enters the queue with no schema or type validation.
- A schema or code change on one side of the queue that makes old messages unreadable, or new ones unreadable to old consumers during a rollout.
- A broker that does not count deliveries or offers no way to move a message aside, so the consumer has no attempt number to act on. Kafka keeps no delivery count, so the consumer must track attempts itself.
- A consumer that is crashed by the message, for example by running out of memory, so no code runs that could give up on it.
- Ordered delivery from a single partition or queue, where the consumer cannot skip the failing message without breaking the order.

## What it costs
<!--meta block=cost-->

- **Everything behind it waits.** In an ordered queue or a Kafka partition, the consumer cannot move past the failing message, so a single bad record turns into a full stop for that stream.
- **Capacity burns on a guaranteed failure.** Each redelivery uses a worker, a database call or an API call, and the retries compete with good messages for the same capacity.
- **The logs and alerts drown.** The same exception repeats thousands of times, which hides other errors and fills log storage.
- **Retries multiply the load on dependencies.** If the failing handler calls another service first, each attempt hits it again, and the poison message adds to a [retry storm](./retry-storm.md).
- **The backlog keeps growing.** Producers keep writing while the stream is stuck, and an [unbounded queue](./unbounded-queue.md) fills memory or disk until it fails too.
- **Recovery needs a person** to read why it fails, fix the code or data and replay in order, or discard and risk losing a real order.

One bad message makes a small, fixable fault in a payload into an outage of the whole stream, and that outage lasts as long as it takes someone to notice. The oldest-message age is the number that shows it early, because in a worker pool the depth can look normal.

## Getting out
<!--meta block=mitigation-->

Count attempts and stop at a limit. Keep the delivery count outside the consumer process, because a consumer that crashes cannot count for itself. A broker such as SQS counts deliveries; Kafka keeps no per-message count, so the consumer or its framework tracks attempts and publishes to a dead-letter topic. After a small number of tries, 3 to 5 is common, move the message to a [dead letter channel](../patterns/messaging/dead-letter-channel.md) together with the error and the attempt count. The main queue moves on, and the message waits in a place built for a person to inspect. SQS (Simple Queue Service) redrive policies, RabbitMQ dead-letter exchanges and Kafka dead-letter topics each give the message somewhere to go.

Then tell the two kinds of failure apart. A parse or validation error is permanent, so send it to the dead letter channel on the first attempt, with no retries. A timeout or a 503 from a dependency is transient, so retry it with [backoff](../patterns/distributed/resilience/retry-backoff.md) before giving up. Where order must hold, a stream can pause the one key that failed and carry on with others, rather than stop everything.

Prevent the next one. Validate against a schema where the message enters, so bad data is refused at the producer and never reaches the queue. Version message formats and keep old readers working through a rollout. Alert on the dead letter channel's depth and on the age of the oldest message in the main queue, so a person learns of the first poison message in minutes. Set the age alert at a small multiple of the normal processing time plus queue wait, read from last week's baseline, and page on any dead letter depth above 0. The longest a bad message can block the queue is the attempt limit times the delay between attempts, so choose the limit to stay inside that alert. Give the dead letter channel an owner and keep its retention longer than the on-call triage window, so a message does not expire unseen. After the fix, replay the dead letters into the main queue, and make the consumer [idempotent](../patterns/messaging/idempotency.md) so a replayed message that half succeeded before cannot apply twice.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Unbounded Queue](./unbounded-queue.md) — The backlog behind a stuck message grows until an unbounded queue fills memory.
- [Retry Storm](./retry-storm.md) — Each redelivery repeats calls to a dependency and adds to a retry storm.

**Often confused with**

- [Head-of-Line Blocking](./head-of-line-blocking.md) — A poison message is one common cause of a stuck queue head.

**Mitigated by**

- [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) — Move the message aside after a few attempts so the queue moves on.
- [Idempotency](../patterns/messaging/idempotency.md) — Replaying dead letters after the fix needs consumers that can take a message twice.
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — Retry only transient failures, with backoff, and stop at a limit.

**Threatens**

- [Message Queue](../patterns/messaging/message-queue.md) — Any queue with redelivery and no attempt limit can hold one.
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — Each redelivery ties up a worker and repeats the failure
- [Sequential Convoy](../patterns/messaging/sequential-convoy.md) — Ordered processing makes one bad message block every message behind it
- [Publish-Subscribe](../patterns/messaging/pubsub.md) — A subscriber that keeps failing on one event redelivers it without end
- [Polling Consumer](../patterns/messaging/polling-consumer.md) — The polling loop redelivers it after every failed attempt.

<!-- relationships:end -->
