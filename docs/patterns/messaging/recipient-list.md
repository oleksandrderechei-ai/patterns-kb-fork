---
title: Recipient List
description: "Sends each message to a computed set of channels — not one, and not all"
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling]
status: stable
solves: ["the same order event has to reach billing, fulfilment and the audit log, and the list is different per customer", "my publisher hardcodes which services get a copy, so onboarding a consumer is a deploy", "two rules both match and I need the message to go to both, not just the first", "I need to fan out to a computed set of destinations, not to everyone subscribed"]
---

# Recipient List

Computes, per message, the set of channels that message belongs on, and sends a copy to each — so adding a destination changes the list, not the sender.

## What it is
<!--meta block=description-->

A recipient list computes, for each message, the set of channels it belongs on and sends a copy to each. The list is data, such as a rules table, a subscription registry or a field on the message, so adding a destination changes that data and not the producer. It sits between a router, which picks one channel, and a broadcast to everyone.

## Explained
<!--meta block=explain-->

A recipient list works out, for each message, which channels it belongs on and sends a copy to each one. The list is data, such as a rules table or a field on the message, so adding a destination changes that data and not the producer. Choose it only when the set of destinations really varies per message. If every subscriber always gets every message, publish-subscribe is simpler, and if each message goes to exactly one place, a router says so more plainly.

- **Partial delivery.** Some recipients hold the message and others do not. Record an outcome per recipient and retry only the failures.
- **Duplicates.** A retry sends a second copy to recipients that already succeeded, so make every consumer safe to run twice.
- **Empty list.** An empty list drops the message silently. Send that case to a dead-letter channel (a side queue) and alert on its rate.
- **Slow recipient.** Sequential sends make latency the sum of the list. Send in parallel with a cap; latency then follows the slowest.

**Example.** An alert system gets 1,000 alerts a minute. Every alert goes to the log, warnings and critical alerts go to chat, and critical alerts go to the pager. With 100 warnings and 20 critical, that is 1,000 + 120 + 20 = 1,140 copies a minute. The pager service goes down. Replaying the whole list for each failed critical alert would send its log and chat copies again, 3 deliveries for 1 needed. Recording an outcome per recipient retries only the pager, so chat sees no duplicates, as long as those outcomes are stored durably.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one event reach three services the sender has never heard of? Steps 3 and 4 compute the list from data that lives outside the code, so onboarding a fourth service is a row in the rules rather than a release of the order service. Steps 5 to 7 are the same send repeated — and each one can fail on its own."
flowchart LR
    Prod["Order Service"]
    In[("Order events channel")]
    subgraph Disp["Recipient list — one message, N sends"]
        Calc["Compute recipients"]
        Send["Send one copy each"]
    end
    Rules[("Destination rules")]
    Billing["Billing"]:::ext
    Fulfil["Fulfilment"]:::ext
    Audit["Audit log"]:::ext
    Prod -->|"1 publish order.placed"| In
    In -->|"2 consume"| Calc
    Calc -->|"3 read destinations"| Rules
    Calc -->|"4 list for this message"| Send
    Send -->|"5 copy"| Billing
    Send -->|"6 copy"| Fulfil
    Send -->|"7 copy"| Audit
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What does a half-delivered message leave behind? Billing and the audit log have acted, fulfilment has not, and nobody but the dispatcher knows — which is why the outcome is recorded per recipient and the retry goes to fulfilment alone. Replay the whole list instead and billing sees the order twice."
sequenceDiagram
    autonumber
    participant D as Dispatcher
    participant B as Billing
    participant F as Fulfilment
    participant A as Audit log
    D->>D: compute list = billing, fulfilment, audit
    D->>B: send copy
    B-->>D: ack
    D->>F: send copy
    F--xD: no ack
    D->>A: send copy
    A-->>D: ack
    Note over D,F: two recipients hold the message, one does not
    D->>F: retry this recipient alone
```

## Variations
<!--meta block=variations-->

- **Static list** — Destinations come from a configuration entry an operator edits, so the whole routing decision is one reviewable file — at the price of a config change and a reload for every new consumer.
- **[Content-Based Router](./content-based-router.md) rules per destination** — Each destination carries a predicate over the message, and every destination whose predicate passes gets a copy. This is where the two patterns meet: identical rule evaluation, except that first-match-wins is dropped and all the matches are kept.
- **List looked up in a registry** — The list is resolved at send time from a directory, a subscription table or a service registry. Participants join and leave by writing to that store, so neither side redeploys — and a stale or unreachable registry now decides who gets your messages.
- **List carried in the message** — The message names its own list of destinations in a header, and the dispatcher does no computing at all. That moves the decision to whoever created the message, which suits a workflow that already knows its route, and it makes the route visible in a trace instead of hidden in a rule table. The dispatcher must still check each named destination against an allow-list, or any producer can address any destination.
- **Delivery semantics: all-or-nothing versus best-effort** — Either the dispatcher abandons the message on the first failed send and lets redelivery repeat the sends that already succeeded, or it attempts every recipient and records an outcome for each. The first keeps the dispatcher stateless and duplicates whenever an earlier send went out; the second cuts duplicates only while its recorded outcomes survive a crash, and makes the dispatcher hold per-recipient state.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Destinations are data**, so onboarding a consumer is a config or registry change instead of a producer release.
- **The set can differ per** message, so one customer's event reaches three systems and the next customer's reaches one, with no branching in the sender.
- **Consumers receive only what was addressed** to them, so none carries a filter. The predicate moves into the list, where it is maintained once.
- **With a static list or rule table, who receives what lives in one place**, so the decision is testable and auditable as a unit.

### Cons
<!--meta polarity=con-->

- **Partial delivery is the defining problem**: some recipients hold the message and some do not, and the dispatcher is the only party that knows. Record an outcome per recipient and retry the failures alone.
- **The list is state someone maintains** and can get wrong — and a list that computes to empty drops the message with no error anywhere. Send the empty case to a [Dead Letter Channel](./dead-letter-channel.md) and alert on its rate.
- **A retry delivers a second copy** to recipients that already succeeded, whether it replays the list or the broker redelivers the input. Make every consumer [idempotent](./idempotency.md) before the first duplicate arrives.
- **Debugging means reconstructing the list** for one specific message, which a static topology never asks of you. Log the computed list against the message's [correlation identifier](./correlation-identifier.md).
- **Dispatch cost grows with the list**: send sequentially and latency becomes the sum of every recipient, so one slow consumer sets the pace for all of them.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The destinations differ from message to message** and follow from data — the customer, the order type, a subscription table.
- **More than one rule can match** the same message and every match must get a copy, not just the first.
- **You want to add a consumer** without redeploying the producer, and without handing that consumer every message either.

### Avoid when
<!--meta polarity=avoid-->

- **Every consumer wants every message** — [publish-subscribe](./pubsub.md) is simpler, and the broker owns the delivery problem for you.
- **Exactly one destination should act on the message** — that is a router, and N-way delivery only buys you a partial-failure problem you did not have.
- **You need the recipients' answers back** — that is [Scatter-Gather](./scatter-gather.md), which adds a correlated gather on top of the dispatch.
- **The list would run to hundreds of entries** — push that breadth to a topic whose subscriptions carry the filters, rather than making one component send hundreds of copies.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — compute the recipients, then collect an outcome per recipient"
type Channel = "billing" | "fulfilment" | "audit" | "eu-tax";
interface OrderPlaced { orderId: string; region: "US" | "EU"; total: number }
// The list is data: one predicate per destination, and EVERY match gets a copy.
const rules: { channel: Channel; wants: (o: OrderPlaced) => boolean }[] = [
  { channel: "billing", wants: () => true },
  { channel: "fulfilment", wants: (o) => o.total > 0 },
  { channel: "audit", wants: (o) => o.total >= 10_000 },
  { channel: "eu-tax", wants: (o) => o.region === "EU" },
];
const recipientsFor = (o: OrderPlaced): Channel[] =>
  rules.filter((r) => r.wants(o)).map((r) => r.channel);

type Outcome = { channel: Channel; ok: boolean; error?: unknown };
const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("send timed out")), ms))]);

async function dispatch(order: OrderPlaced, timeoutMs: number, maxAttempts: number): Promise<Outcome[]> {
  const recipients = recipientsFor(order);
  if (recipients.length === 0) {  // an empty list is a message nobody will ever see
    await deadLetter.publish(order, "no recipient matched");
    alertOnEmptyList(order.orderId); // alert on the rate, never a silent no-op
    return [];
  }
  const outcomes = new Map<Channel, Outcome>();
  let pending = recipients;
  for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt++) {
    // one failed send must not hide the outcome of the others
    const settled = await Promise.allSettled(pending.map((c) => withTimeout(channels[c].publish(order), timeoutMs)));
    settled.forEach((r, i) => outcomes.set(pending[i], {
      channel: pending[i], ok: r.status === "fulfilled",
      error: r.status === "rejected" ? r.reason : undefined,
    }));
    pending = pending.filter((c) => !outcomes.get(c)!.ok); // retry only what failed
  }
  for (const c of pending) await deadLetter.publish(order, `recipient ${c} still failing`); // per recipient
  return [...outcomes.values()];
}
```

## In the wild
<!--meta block=wild-->

- **Apache Camel** — The `recipientList()` enterprise integration pattern (EIP) resolves destination endpoints per exchange from an expression, then sends to each — the pattern as a first-class route construct. {#wild-camel}
- **Spring Integration** — `RecipientListRouter` holds a list of channels, each optionally guarded by a selector expression, and sends the message to every recipient whose selector matches. {#wild-spring-integration}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Dispatch concurrency** — Whether copies go out sequentially or in parallel, how many sends are in flight at once, and a timeout on each send. Sequential makes latency the sum of the list and unbounded parallelism turns a long list into a burst, so cap in-flight sends at what the most rate-limited recipient accepts.
- **Failure policy** — Whether the first failed send abandons the whole message or the dispatcher attempts every recipient and collects outcomes — the choice decides who owns the retry, the broker or the dispatcher.
- **Per-recipient retry and dead-letter policy** — How many times one recipient is retried and where its copy goes when the retries run out. Work out attempts and backoff from the slowest recipient's p99 latency and how long the input channel can wait; a single shared policy lets the slowest recipient set the budget for all of them.
- **List source and refresh** — Where the list comes from — inline config, a rule table, a registry read per message — and how often a cached copy of it is refreshed.

### Signals to watch
<!--meta polarity=signal-->

- **Computed list size per message** — How many sends each message costs; a distribution drifting upward means each publish costs more sends than it used to. Alert when its p95 passes the baseline you measured for that message type.
- **Per-recipient delivery failure rate** — Broken out by destination, because an aggregate rate hides one recipient failing while the rest succeed.
- **Empty-list rate** — Messages for which the computation matched nothing; they are delivered nowhere and raise no error on their own.
- **Dispatch latency per message** — Grows with list length under sequential sending (the sum of all sends) and tracks the slowest recipient under parallel sending.

### Failure modes under load
<!--meta polarity=failure-->

- **Partial delivery** — Some recipients acknowledged and some did not, so some systems have acted on the message and others have not.
- **Silent empty list** — A rule change or a stale registry narrows the computation to nothing, and those messages disappear with no failure recorded anywhere.
- **Duplicate delivery on retry** — Replaying the whole list re-sends to recipients that already succeeded, so a non-idempotent consumer applies the message twice.
- **One slow recipient stalls the dispatch** — Under sequential sending every other recipient waits behind the slowest, and the input channel backs up behind them.
- **List source unavailable** — A registry or rule store read per message is a dependency that can stop routing entirely when it goes down.

### Readiness checklist
<!--meta polarity=check-->

- Every consumer is idempotent — a retried dispatch delivers duplicates to recipients that already succeeded
- An empty computed list goes to a dead-letter channel and is alerted on, never treated as a no-op
- Delivery outcome is recorded per recipient, so a retry can target only the recipients that failed
- The computed list is logged with the message correlation id, so one message path can be reconstructed
- The list source has defined behaviour when it is unreachable — fail the dispatch or fall back to a cached list, never silently narrow it

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Deliver each message to every channel on a list that you keep as data. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Scatter-Gather](./scatter-gather.md) — The scatter half can dispatch through a recipient list the router controls
- [Splitter](./splitter.md) — A splitter feeds each fragment to the step that decides where that fragment goes
- [Dead Letter Channel](./dead-letter-channel.md) — A list that computes to empty goes here instead of vanishing.

**Variant of**

- [Message Router](./message-router.md) — Same dispatch decision, but N destinations instead of exactly one

**Often confused with**

- [Content-Based Router](./content-based-router.md) — A content-based router picks the first matching rule; a recipient list takes every match
- [Fan-Out](./fan-out.md) — Fan-out copies to every consumer; a recipient list copies to a computed subset
- [Publish-Subscribe](./pubsub.md) — The topic holds the subscriber set; the sender names no recipient.
- [Routing Slip](./routing-slip.md) — A routing slip sends one message through an ordered chain of steps, each forwarding to the next; a recipient list sends a copy to every recipient at once.

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that sends a message to a computed list of recipients as a ready-made building block.

<!-- relationships:end -->
