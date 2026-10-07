---
title: Fan-Out
description: "One message in, an independent copy to every consumer"
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling, asynchrony]
status: stable
aliases: [fanout]
solves: [one slow downstream holds up delivering the same event to everything else, "shipping, email, and analytics all need the same order event at once and must not block each other", a consumer that was down loses every message published while it was offline, each service should handle the event at its own speed and retry on its own without touching the others, "I do not want every service to receive every message, only the ones of a certain type"]
---

# Fan-Out

Fan-out delivers a single message as a separate, independent copy to every interested consumer, so each one processes it in parallel at its own pace.

## What it is
<!--meta block=description-->

**Fan-out** replicates one published message into an independent copy for every consumer, and each consumer processes its own copy in parallel, one way, with no reply. The producer emits once and a topic or broker does the multiplying. Direct calls would tie the producer to every consumer's speed and availability, and the slowest would stall the rest. Plain [publish-subscribe](./pubsub.md) decouples the sender; fan-out usually keeps each copy buffered, retried and consumed separately, with a queue per consumer.

## Explained
<!--meta block=explain-->

Fan-out sends one published message to many consumers, each receiving its own copy and acting on it independently. The producer publishes once and does not know who listens, and when each copy sits in its own queue a slow or broken consumer cannot stall the others. Choose it over calling each consumer directly when the consumers are unrelated: total time then follows the slowest branch, not the sum, and you add a consumer without touching the producer. Use a queue with [competing consumers](./competing-consumers.md) instead when a message must reach exactly one worker, and [scatter-gather](./scatter-gather.md) when you need the answers back.

- **Load multiplied.** One message becomes N deliveries, so size each branch for the extra load.
- **Per-branch care.** Each branch needs its own retries, dead-letter queue and duplicate protection, since delivery is at least once per copy.
- **Backlog.** A lagging consumer piles up unread copies, so set a backlog limit or expiry and filter at the subscription.

**Example.** An order-placed event has 5 consumers: email takes 200 ms, inventory 50 ms, analytics 20 ms, fraud 300 ms and loyalty 100 ms. Called one after another they cost 670 ms. Fanned out, the producer publishes once and the last branch finishes about 300 ms later, the slowest branch. At 100 orders a second that is 500 deliveries a second. If analytics is down for an hour, its branch alone holds 100 x 3,600 = 360,000 unread copies, and your backlog limit decides when they are dropped.

## How it works
<!--meta block=structure-->

```mermaid caption="What stops a broken consumer from touching the others? The queue in front of it. Billing's copy is its own message from step 2 onward, so it can back up at step 3 and dead-letter at step 4 while search drains normally — and no arrow ever runs back to the publisher."
flowchart LR
    Pub["Order Service"]:::ext
    T(["Topic"])
    subgraph Br["One branch, one buffer: its own retries and dead letters"]
        QA[("Billing queue")]
        DLQ[("Billing dead-letter queue")]
    end
    CA["Billing"]
    QS[("Search queue")]
    CS["Search"]:::ext
    Pub -->|"1 publish once"| T
    T -->|"2 copy, filter applied"| QA
    T -->|"2 copy, filter applied"| QS
    QA -->|"3 drain at its own pace"| CA
    CA -->|"4 give up after N retries"| DLQ
    QS -->|"3 drain at its own pace"| CS
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Pure broadcast vs. filtered fan-out** — Every consumer receives every message, or each subscription carries a filter — by attribute or by content — so a branch only sees messages it cares about, trimming volume and cost per consumer.
- **Direct fan-out vs. queue-per-consumer hybrid** — The topic pushes straight to each consumer, or a durable queue sits in front of each one; the queue absorbs bursts and lets a slow branch fall behind without holding up the fast ones.
- **Push vs. poll delivery** — The broker pushes each copy to a consumer's endpoint, or each consumer polls its own queue and pulls at the rate it can actually handle.
- **Ordered vs. unordered fan-out** — Delivery is best-effort parallel with no order across messages, or ordering is preserved per key at the cost of some of the parallelism.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Consumers process in parallel**, each at its own pace, so total time tracks the slowest single branch, not the sum of them.
- **A durable queue per consumer** isolates one slow or failed branch from all the others.
- **New consumers attach to the topic** without touching or redeploying the producer.
- **Filtering keeps each branch's volume relevant instead** of forcing every consumer to see everything.

### Cons
<!--meta polarity=con-->

- **One logical message becomes N physical deliveries** — load and cost that grow with the number of consumers.
- **Each branch needs its own** [idempotency](./idempotency.md), retry, and dead-lettering; delivery is at-least-once per copy.
- **There is no built-in "did everyone get it"** — completion and failure are per-branch, not global.
- **A misconfigured filter silently drops** messages a consumer needed, with nothing in the call to trace.
- **Per-branch isolation stops at the broker** — where branches share one topic or log, a consumer that never catches up piles unread copies into storage every branch shares, until a backlog limit or an expiry policy cuts it off.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several independent consumers must each act** on the same event, in parallel and without coordinating.
- **Consumers run at different speeds** and one must be free to fall behind without stalling the others.
- **You want to add or remove consumers** without redeploying or even informing the producer.

### Avoid when
<!--meta polarity=avoid-->

- **Each message must go** to exactly one of several workers, not all of them — that is a [message queue](./message-queue.md), not a broadcast.
- **You need the combined result** of asking many parties — that is [Scatter-Gather](./scatter-gather.md), which adds a correlated gather.
- **A strict synchronous response** is required before the producer can continue.

Left unbounded, fan-out is also how a single publish becomes a [thundering herd](../../hazards/thundering-herd.md) — every consumer hit at once — so size the branches for the amplification before it finds you.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — fan one message into isolated per-consumer branches"
type Message = { type: string; body: unknown };

interface Consumer {
  name: string;
  wants(m: Message): boolean;        // per-subscription filter
  handle(m: Message): Promise<void>;
}

// The producer publishes once; each consumer gets its own independent copy.
async function fanOut(consumers: Consumer[], message: Message): Promise<void> {
  const targets = consumers.filter((c) => c.wants(message)); // trim the branch to what it cares about
  const deliveries = targets.map((c) => c.handle(structuredClone(message))); // an independent copy per branch

  // every branch starts at once and one failure never cancels another; this awaits the slowest, so do not await fanOut on the publish path
  const results = await Promise.allSettled(deliveries);

  results.forEach((r, i) => {
    if (r.status === "rejected") {
      // retry or dead-letter this branch alone — the rest already went through
      console.error(`branch ${targets[i].name} failed:`, r.reason);
    }
  });
}

```

## In the wild
<!--meta block=wild-->

- **Amazon Simple Notification Service (SNS) → Simple Queue Service (SQS) fanout** — Publishing to an SNS topic pushes an independent copy to every subscribed SQS queue; each microservice owns a queue and drains it at its own pace, a Lambda event source mapping polls each queue in batches, subscription filter policies route by message attribute, and delivery failures land in a redrive dead-letter queue. {#wild-sns-sqs}
- **Azure Service Bus topics** — A topic delivers each message into every subscription, and a subscription is its own durable queue-like buffer that a consumer reads independently; SQL and correlation filter rules decide which messages land in each subscription. {#wild-azure-sb-topics}
- **Parallel large language model (LLM) & agent fan-out** — An orchestrator dispatches one request to several models, tools, or sub-agents at once — running independent tool calls or sampling multiple generations in parallel so none waits on the others; gathering the results afterwards is a separate fan-in step. {#wild-llm-fanout}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Per-subscription filter** — Which messages a branch receives — narrows a consumer to the subset it cares about instead of the whole stream.
- **In-flight / visibility timeout** — How long a delivered copy is hidden from redelivery while a consumer works it; too short redelivers prematurely, too long slows recovery from a crash. Set it above the slowest normal handling time of that branch.
- **Redelivery limit before dead-lettering** — How many times a copy is retried on one branch before it is moved to that branch dead-letter queue (SQS calls this maxReceiveCount).
- **Delivery retry / backoff policy** — How the broker spaces retries to a failing branch so a struggling consumer is not hammered.
- **Per-consumer batch size** — How many copies a consumer pulls and processes per fetch, trading latency against throughput on that branch.

### Signals to watch
<!--meta polarity=signal-->

- **Per-queue backlog** — Pending copies on a single branch; the core per-consumer saturation signal (e.g. SQS ApproximateNumberOfMessagesVisible).
- **Age of the oldest unprocessed copy** — How far the slowest branch has fallen behind the head of its queue.
- **Dead-letter-queue depth** — Copies a branch gave up on after exhausting retries — poison messages or a broken consumer.
- **Delivery-failure / throttle rate** — How often the broker fails or is throttled delivering to a branch endpoint.

### Failure modes under load
<!--meta polarity=failure-->

- **One branch backs up in isolation** — A slow or failed branch sees its queue grow while the others stay healthy: the isolation working, shown as one climbing backlog.
- **Poison message redelivery loop** — A copy that always fails redelivers on its branch until the redelivery limit moves it to the dead-letter queue.
- **Silent filter drop** — A misconfigured filter excludes messages a consumer needed; nothing errors, the branch simply never sees them.
- **Publish-burst amplification** — A burst on the topic multiplies into a simultaneous copy on every branch, hitting all consumers at once.

### Readiness checklist
<!--meta polarity=check-->

- Every consumer is idempotent — delivery is at-least-once per copy
- Each branch has its own dead-letter queue and someone watches its depth
- Filter rules are tested — a wrong filter drops messages silently
- Per-queue backlog and oldest-message age are monitored per branch
- Fan-out breadth is sized for the N-fold amplification of a publish burst

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Real-Time Updates](../../themes/realtime-updates.md) — Push one event to many subscribers at once {#fluency-realtime-updates}
- [Gen AI at Scale](../../themes/genai-scale.md) — Dispatch parallel calls {#fluency-genai-scale}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Competing Consumers](./competing-consumers.md) — Put a durable queue per consumer, each drained by a worker pool at its own pace.
- [Content-Based Router](./content-based-router.md) — Filter each branch so a consumer only gets the messages it cares about.
- [Fan-In](./fan-in.md) — The parallel branches fan-out creates are gathered by a fan-in
- [WebSocket](./websocket.md) — Fan-out to clients ends in open connections such as WebSockets.
- [Idempotency](./idempotency.md) — Each copy is delivered at least once, so every branch must tolerate a repeat.

**Part of**

- [Scatter-Gather](./scatter-gather.md) — Fan-out is the send half of scatter-gather, which then adds a collect and merge step

**Often confused with**

- [Publish-Subscribe](./pubsub.md) — Fan-out is the delivery topology — one copy per consumer, in parallel; pub/sub is the decoupling contract that usually carries it.
- [Message Router](./message-router.md) — Fan-out delivers a copy to all; a router chooses one destination
- [Wire Tap](./wire-tap.md) — Fan-out copies are real deliveries every consumer is expected to process
- [Recipient List](./recipient-list.md) — A recipient list narrows delivery to a per-message set instead of everyone subscribed

**Exposed to**

- [Thundering Herd](../../hazards/thundering-herd.md) — Can fall into thundering herd when one publish hits every consumer at the same instant.

**Demonstrated by**

- [Facebook News Feed](../../designs/fb-news-feed.md) — the news feed is the archetypal fan-out-on-write system, and its hybrid twist shows exactly where fan-out stops paying off
- [Instagram](../../designs/instagram.md) — the feed design is the canonical fan-out-on-write: one post replicated across millions of follower feeds
- [WhatsApp](../../designs/whatsapp.md) — a single input producing delivery to many recipients is the fan-out shape at work
- [Facebook Live Comments](../../designs/fb-live-comments.md) — the entire system is one write exploding into millions of reads — the canonical fan-out shape at extreme scale
- [Google Docs](../../designs/google-docs.md) — a single recorded event is delivered to all currently-connected consumers at once
- [Online Auction](../../designs/online-auction.md) — delivering one bid to every watcher across up to ~100M live connections is fan-out at scale
- [Robinhood](../../designs/robinhood.md) — one inbound message multiplies to millions of connected recipients — the classic fan-out shape
- [Logging Service](../../designs/logging-service.md) — An in-process fan-out where one failing destination must not stop the later ones
- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — Fan-out sized by vendor quota, since the binding limit is vendor calls and not compute

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — A topic delivers one publish to every subscriber, which is this pattern as a hosted primitive.

<!-- relationships:end -->
