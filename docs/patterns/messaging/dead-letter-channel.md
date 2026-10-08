---
title: Dead Letter Channel
description: "Undeliverable messages land somewhere visible, not lost"
area: messaging
owner: Oleksandr Derechei
tags: [messaging, error-handling, isolation]
status: stable
aliases: [DLQ, dead letter queue]
solves: [one malformed message keeps getting redelivered and nothing behind it ever moves, my consumer crash-loops on the same record forever and I have to purge the whole queue, messages that fail just vanish and we only find out weeks later from an angry customer, I have no idea which orders failed to process or why, a single record with a bad schema takes down the worker every time it restarts]
favourite: true
---

# Dead Letter Channel

Undeliverable messages are diverted to a channel of their own instead of vanishing silently or jamming the queue behind them — so a human, or an automated remediation, can see exactly what failed and why.

## What it is
<!--meta block=description-->

A **dead-letter channel** is a side channel for a message the system cannot deliver or process: retries ran out, its time-to-live expired, a queue limit was hit, or a consumer rejected it. The message is not deleted. It leaves the main path with its failure reason, so the main channel keeps moving and a person can inspect it and, once the cause is fixed, replay it. Brokers such as SQS (Simple Queue Service) and RabbitMQ do the routing natively.

## Explained
<!--meta block=explain-->

A dead-letter channel is a side queue that receives a message the consumer cannot process after a set number of attempts, so the main queue keeps moving and the failed message is kept, with its error, for a person to inspect. Without it you have two bad options: drop the message and learn of it from an angry customer, or retry it forever while every message behind it waits. Choose it when some failures are permanent, such as a field the consumer cannot read, and silent loss is not acceptable.

- **Unwatched queue.** A side queue nobody watches only hides the loss, so name an owner and alert on depth and oldest-message age.
- **Blind replay.** Replaying before finding the cause fails again, so fix it first and make consumers safe to run twice.
- **Early dumping.** With no retry stage or a limit of one, messages that would have worked land there; cap attempts above one, add a delay.

**Example.** One consumer reads 200 orders a minute. One order has a date it cannot parse. Retried in place forever, it blocks the queue, and after 1 hour 12,000 orders are waiting behind it. With a cap of 5 attempts, the bad order moves to the dead-letter queue after the fifth failure, within seconds if retries have no delay between them, and the other 200 a minute keep flowing. The cost is the follow-up: an alert fires when the side queue holds anything older than 15 minutes, someone fixes the date handling, and replays that one order.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does a message go that will never process? Step 4 takes it out of the hot path instead of dropping it, so the queue keeps moving and the message is still there at step 5 for someone to fix."
flowchart LR
    P["Producer"]:::ext
    subgraph Hot["The hot path — one message must not block it"]
        Q[("Main channel")]
        C["Consumer"]
    end
    D["Downstream"]:::ext
    DLQ[("Dead letter channel")]
    OP["Operator"]:::ext
    P -->|"1 send"| Q
    Q -->|"2 deliver"| C
    C -->|"3 processed"| D
    C -->|"4 after N attempts, divert with the failure reason"| DLQ
    DLQ -->|"5 alert and inspect"| OP
    OP -->|"6 fix the cause, replay"| Q
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **[Retry with Backoff](../distributed/resilience/retry-backoff.md), then dead-letter** — Exhaust a bounded retry policy first, so only failures that survive every attempt get diverted — the two patterns are almost always paired, one absorbing transient errors, the other catching what's left.
- **Per-reason quarantine** — Route to separate dead-letter channels by failure category — schema violation, business rule, timeout — so each category gets its own remediation path instead of one undifferentiated pile.
- **Broker-native redrive** — SQS redrive policies (after a receive count) and RabbitMQ's `x-dead-letter-exchange` (on rejection, TTL expiry, a full queue or a delivery limit) move a message automatically, with no application code involved. Kafka has no broker feature: its dead-letter topic is a convention that the consumer or Kafka Connect writes to.
- **[Idempotent](./idempotency.md) replay** — Tag messages with an idempotency key before requeueing a fixed dead letter, so resubmitting it into the main channel can't cause a duplicate side effect if it was partially processed the first time.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Undeliverable messages stay visible and inspectable instead** of being silently dropped.
- **Keeps the main channel flowing** — with a bounded retry in front, one poison message can't block every message behind it (ordered groups aside).
- **Gives operators a concrete replay point**: once the cause is fixed and consumers are idempotent, requeue the message.
- **Concentrates failure signal in one place**, which makes alerting and metrics straightforward.

### Cons
<!--meta polarity=con-->

- **Another channel to monitor** — dead letters that nobody watches just accumulate and go stale. Alert on depth and on the age of the oldest message, or you have moved the loss rather than stopped it.
- **No ordering guarantee** once a message is pulled from the main flow and replayed later — if order carries meaning, quarantine the whole key rather than the one message.
- **Blind replay without root-cause analysis** just reproduces the same failure a second time.
- **Adds moving parts**: routing rules, a retention policy, and a remediation process someone must own.
- **Replaying a message that was half processed** the first time re-applies its side effects — the replay path needs [idempotent](./idempotency.md) consumers before it is safe to use.
- **Without a bounded** [retry](../distributed/resilience/retry-backoff.md) in front of it, the channel fills with messages that would have succeeded on the next attempt, and the real permanent failures are lost in the noise.
- **A cap on receives counts every receive** — not only failures, so a visibility timeout shorter than the processing time can send healthy messages to the dead-letter channel.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Consumers can permanently fail on some messages** — malformed payloads, unknown message types, schema drift.
- **One bad message must not be allowed** to block or repeatedly crash the consumer behind it.
- **Failures need to be visible** to a human or an alerting system, not silently discarded.

### Avoid when
<!--meta polarity=avoid-->

- **Every failure is genuinely transient** and a bounded [retry](../distributed/resilience/retry-backoff.md) already resolves it.
- **There's no process or owner** to triage the channel — it just becomes a silent graveyard.
- **Occasional message loss is acceptable and cheaper** than building the remediation tooling.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — parking a KYC task that ran out of attempts"
interface Task {
  id: string;
  flowId: string;
  type: "verify_id" | "check_list" | "deliver_webhook";
  attempts: number;
}

const MAX_ATTEMPTS = 5;

async function runTask(task: Task): Promise<void> {
  try {
    await handle(task);                          // e.g. call idVendor
    await tasks.complete(task.id);
  } catch (err) {
    if (task.attempts >= MAX_ATTEMPTS) {
      // 'dead' is a parking state, not a delete: the row keeps its flow_id,
      // attempts and last error, so it is re-runnable once the cause is fixed.
      // run park, transition, alert and outbox in one transaction, or make each idempotent,
      // so a crash between them cannot leave a parked task on a live flow
      await tasks.park(task.id, { reason: String(err), at: new Date() });
      await flows.transition(task.flowId, "dead");
      await alerts.operator(`task ${task.id} dead on flow ${task.flowId}`);
      if (task.type !== "deliver_webhook") {     // don't dead-letter a dead letter
        await outbox.append(task.flowId, { type: "verification.failed" });
      }
    } else {
      await tasks.retryLater(task.id);           // back to pending with backoff; this bumps task.attempts, which the cap above reads
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **Amazon SQS redrive policy** — A source queue names a dead-letter queue and a maxReceiveCount in its redrive policy; once a message has been received that many times without being deleted, SQS moves it to the DLQ automatically. A redrive-to-source action moves messages back after the cause is fixed. {#wild-sqs-redrive}
- **RabbitMQ dead-letter exchanges** — The x-dead-letter-exchange argument (with an optional x-dead-letter-routing-key) republishes a message to a separate exchange when any of the four dead-letter triggers fires: rejection with requeue=false, message TTL expiry, exceeding the queue length limit, or a quorum queue returning it more times than its delivery limit. {#wild-rabbitmq-dlx}
- **Kafka Connect** — Setting `errors.tolerance=all` with `errors.deadletterqueue.topic.name` routes a sink connector's records that fail conversion or transformation to a dead-letter topic instead of failing the task; `errors.deadletterqueue.context.headers.enable` adds headers describing the failure to each dead-lettered record. Source connectors have no dead-letter topic. {#wild-kafka-connect-dlq}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Max delivery attempts** — The receive or redelivery count after which a message is diverted to the dead-letter channel instead of being retried again (SQS maxReceiveCount, broker delivery-limit). There is no universal default: pick a count whose retries, with the delay between them, outlast the transient outages you expect, so only persistent failures reach the channel.
- **Dead-letter retention** — How long a dead letter is kept before the broker deletes it (SQS MessageRetentionPeriod, RabbitMQ x-message-ttl). On brokers that keep the original enqueue time (SQS standard queues do; FIFO queues restart the clock), the clock counts from when the message first entered the source queue, not from when it arrived here.
- **Redrive / replay policy** — The mechanism and batch size for moving messages back to the source once the cause is fixed (SQS redrive-to-source). Size the batch and rate to leave headroom over live traffic, and ramp up while watching replay success rate and consumer lag.
- **Per-reason routing** — Whether all failures land in one channel or in separate channels by category — schema violation, business rule, timeout — each with its own remediation path. Each extra channel needs its own alert and owner, so split only where remediation differs.

### Signals to watch
<!--meta polarity=signal-->

- **Dead-letter depth** — Message count in the channel — the headline health signal; sustained growth means failures are accumulating faster than they are triaged.
- **Age of oldest dead letter** — How long the oldest quarantined message has waited — a proxy for triage backlog and for retention running out.
- **Dead-letter arrival rate** — Messages entering the channel per interval; a sharp spike points to a systemic cause — a bad deploy, a schema change, a downstream outage.
- **Replay success rate** — How many redriven messages complete on the second pass; a low rate says the root cause was not actually fixed.

### Failure modes under load
<!--meta polarity=failure-->

- **Unwatched channel** — Dead letters nobody monitors accumulate silently and are deleted where a retention period or TTL expires — data loss that surfaces only when someone reports a missing record.
- **Retention shorter than triage** — A retention window below the realistic time-to-fix deletes quarantined messages before the cause is diagnosed and they can be replayed.
- **Blind replay reproduces failure** — Requeueing without root-cause analysis sends the same message straight back through the same failure and into the dead-letter channel again.
- **Duplicate side effects on replay** — Replaying a message that was partially processed the first time re-applies its side effects unless the consumer is idempotent.
- **Redrive storm** — Replaying a large backlog in one batch pushes the whole accumulated failure period back through the consumers at once, on top of live traffic.

### Readiness checklist
<!--meta polarity=check-->

- Depth and oldest-message age are alerted on, and the alert has a named owner
- The retention window was compared against your measured time-to-diagnose — and where the expiry clock counts from the original enqueue time, against the source queue's retention too
- Consumers on the replay path are idempotent, verified by replaying the same message twice
- Failure context — reason, attempt count, timestamp — travels with each dead-lettered message
- A replay has been rehearsed outside an incident, so nobody first learns the redrive command during one
- Bounded retries run in front of the channel, so only failures that survive every attempt arrive

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Resilience](../../themes/resilience.md) — Quarantine what can't be processed {#fluency-resilience}
- [Long-Running Tasks](../../themes/long-running-tasks.md) — Quarantine messages that keep failing {#fluency-long-running-tasks}
- [Data Platform](../../themes/data-platform.md) — Park the message that will never succeed {#fluency-data-platform}
- [Operating a Live System](../../themes/operating-a-live-system.md) — A manual operation designed for on purpose {#fluency-operating-a-live-system}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Retry with Backoff](../distributed/resilience/retry-backoff.md) — Exhausted retries go to the dead-letter channel
- [Idempotency](./idempotency.md) — Dedupe redeliveries; divert true failures
- [Sweeper](../distributed/coordination/sweeper.md) — without a broker to provide one, the dead state is a column and a sweep is what moves work into it
- [Content-Based Router](./content-based-router.md) — The default branch of a router: unmatched or malformed messages land here
- [Fail Fast](../../principles/fail-fast.md) — Gives the fast failure somewhere visible to land
- [Publish-Subscribe](./pubsub.md) — Each subscription gets its own dead-letter destination, not one shared per topic
- [Competing Consumers](./competing-consumers.md) — The cap is what stops a poison message circulating through the whole pool
- [Message Encoding](./message-encoding.md) — An undecodable payload is the most common thing a dead-letter channel catches
- [Message Router](./message-router.md) — Unroutable messages arrive from the router's no-match path.
- [Message Translator](./message-translator.md) — Unconvertible messages arrive here from a translator.
- [Splitter](./splitter.md) — Isolated per-item failures from a split are what it receives.
- [Recipient List](./recipient-list.md) — A recipient list's empty result is a message nobody will see, so it lands here.
- [Resequencer](./resequencer.md) — A gap that never fills lands here, so the resequencer can release the rest
- [Polling Consumer](./polling-consumer.md) — A polling consumer is where the redelivery loop starts; this channel catches the message at the attempt cap.
- [Content Enricher](./content-enricher.md) — Messages an enricher cannot complete arrive here
- [Routing Slip](./routing-slip.md) — A slip route's failed step is a source of dead letters
- [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md) — A leveling queue's redelivery loop ends here once a message reaches its attempt cap.
- [Message brokers & streams](../../comparisons/message-brokers.md) — Every broker compared on message-brokers needs a dead-letter destination for messages that keep failing.

**Enables**

- [Sequential Convoy](./sequential-convoy.md) — Somewhere for the message that is holding up an entire ordered group

**Requires**

- [Message Queue](./message-queue.md) — Needs a queue to divert to, since it is a side queue for messages that keep failing

**Prevents**

- [Poison Message](../../hazards/poison-message.md) — The dead letter channel exists to hold the messages that always fail.
- [Head-of-Line Blocking](../../hazards/head-of-line-blocking.md) — A dead-letter channel moves a repeatedly failing head aside so the lane keeps moving.

**Demonstrated by**

- [Web Crawler](../../designs/web-crawler.md) — messages that repeatedly fail are shunted aside so they stop blocking the pipeline
- [Job Scheduler](../../designs/job-scheduler.md) — poison jobs are quarantined for inspection so the main execution pipeline keeps flowing
- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — isolating exhausted vendor calls and failed webhook deliveries per branch in a persona-verification saga
- [YouTube](../../designs/youtube.md) — The poison transcode job is the classic dead-letter case
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — dead-lettering applied at three scales — a task, a single batch member, and a whole delivery lane

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Managed brokers ship this as a per-queue setting.

<!-- relationships:end -->
