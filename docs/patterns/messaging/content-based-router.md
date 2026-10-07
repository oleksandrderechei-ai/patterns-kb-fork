---
title: Content-Based Router
description: Routes a message by inspecting its actual content
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling]
status: stable
aliases: [CBR]
solves: [every consumer starts with the same if-block checking whether the message is even meant for it, my workers pull messages off the queue and throw most of them away, the check for whether an order is big enough to need review is copy-pasted into four services, I want to peel off one special case without touching the service that emits the message, the sender would have to understand my downstream business rules to address this correctly]
---

# Content-Based Router

Inspects a message's actual content — not its type, not its headers — and forwards it down whichever channel matches what's inside.

## What it is
<!--meta block=description-->

A **content-based router** reads each message from one inbound channel, looks at values in its body, and forwards it to one of several outbound channels, with a default channel for anything that matches nothing. Producers send one kind of message to one place, and each consumer sees only its own share, so branching logic stays out of both. It differs from a plain [message router](./message-router.md) in deciding on body values, though a header check may come first.

## Explained
<!--meta block=explain-->

A content-based router reads each message from one inbound channel, looks at values in its body, and sends it to one of several outbound channels. The producer sends everything to one place and never learns how many destinations exist, and each consumer receives only the messages it handles. Choose it when the destination depends on data only the body holds, such as a ticket category. Choose a header-based router when a type or version field already settles it, because parsing every body at full volume buys nothing then.

- **Layout coupling.** The router depends on the message layout, so pin routed fields with a versioned schema and keep rules off deeply nested paths.
- **Rule tangle.** Keep rules in an ordered list with a test per rule.
- **Silent catch-all.** Send unmatched messages to a dead-letter channel (a side channel for failures) and alert on its depth.
- **Malformed body.** A message that fails to parse also goes to the dead-letter channel, so one bad message cannot block the router.

**Example.** Support tickets arrive at 50 a second on one queue. The rules, first match wins: category billing goes to the billing queue, priority urgent goes to the on-call queue, category general goes to the general queue, and anything else goes to an unmatched channel with a depth alarm. With 10% billing and 2% urgent, billing gets 5 a second and on-call at most 1, since an urgent billing ticket goes to billing: rule order is a decision you make. Then a producer renames category to topic. No ticket matches billing or general any more, so about 49 a second land in unmatched, not hidden in general, and its alarm fires once its evaluation window passes.

## How it works
<!--meta block=structure-->

```mermaid caption="How much of the message must the router open to decide? Everything inside the boundary: the producer emits one message type (1) and the router deserializes the fields its rules name (2), which is why renaming one of them upstream changes routing here. The first matching condition wins (3, then 4), and whatever classifies as nothing goes to an explicit channel (5) rather than to the void."
flowchart LR
    P["Order service"]
    subgraph Parse["Payload schema the rules depend on"]
        B[("Order body: amount, region")]
        R{"Content-based router"}
    end
    F["Fraud-review queue"]
    EU["EU billing queue"]
    DL[("Dead-letter channel")]:::ext
    P -->|"1 one message type, one channel"| B
    B -->|"2 deserialize the routed fields"| R
    R -->|"3 amount > 10000, first match wins"| F
    R -->|"4 region = EU"| EU
    R -->|"5 no rule matched, or body unreadable"| DL
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Static / table-driven routing** — Rules live in a lookup table — a field value mapped to a channel name — so operators can add or change destinations without redeploying router code.
- **Dynamic / rule-engine routing** — Conditions are expressed in a rules DSL (domain-specific language), JSONPath/XPath predicate, or business-rule engine, letting the routing logic evolve independently of the integration code around it.
- **Header-assisted routing** — A cheap header check (a type or version field) narrows the candidates first, so the router only parses the full body when the header alone can't decide.
- **Multi-match / recipient hybrid** — When more than one condition can match the same message, it's copied to every matching channel instead of exactly one — the point where this pattern shades into a [Recipient List](./recipient-list.md).

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Centralizes branching logic in one place instead** of scattering conditionals through every consumer.
- **Keeps the producer ignorant** of how many consumer variants exist downstream.
- **New destination channels are added** by extending the router, not by touching producers or existing consumers.
- **Makes the routing rules visible**, named, and testable as a single unit.

### Cons
<!--meta polarity=con-->

- **Becomes a central, must-not-break piece of infrastructure** — a bug there misroutes everything behind it.
- **Must read the body fields its rules name**, adding parse cost and a dependency on the message schema.
- **Conditions accrete over time into a tangle** of nested, hard-to-audit rules.
- **A catch-all default branch can silently swallow** or misroute anything unclassified.
- **Consume-then-publish is not atomic** — a crash between the two loses or duplicates a message, so ack after publish and make consumers idempotent.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Messages on the same channel** need genuinely different handling based on what's in them.
- **You want to add handling** for a new case without editing the producer.
- **The routing decision depends** on values only visible in the payload, not in headers or metadata.

### Avoid when
<!--meta polarity=avoid-->

- **The destination is knowable from a header** or message type alone — a plain header-based router is cheaper and skips parsing the body.
- **There's only one consumer or one destination** — there's nothing to route between.
- **Routing rules change so often they're really business logic** — put them in a rules engine or the domain layer, not hardcoded into the router.
- **More than one destination must get each message** — use a [Recipient List](./recipient-list.md). Each message follows a fixed path: use a [Routing Slip](./routing-slip.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — routing an order by its content"
type Channel = "fraud-review" | "eu-billing" | "default";

interface OrderMessage {
  amount: number;
  region: "US" | "EU" | "APAC";
}

// The rule set: evaluated in order, first match wins.
function route(order: OrderMessage): Channel {
  if (order.amount > 10_000) return "fraud-review";
  if (order.region === "EU") return "eu-billing";
  return "default";
}

function dispatch(
  order: OrderMessage,
  channels: Record<Channel, (o: OrderMessage) => void>,
): void {
  const channel = route(order);
  channels[channel](order);
}

// Producer only ever emits OrderMessage; it never sees a channel name.
dispatch({ amount: 15_000, region: "US" }, {
  "fraud-review": (o) => reviewQueue.publish(o),
  "eu-billing": (o) => euBillingQueue.publish(o),
  "default": (o) => defaultQueue.publish(o),
});
```

## In the wild
<!--meta block=wild-->

- **Apache Camel choice()** — The choice().when(predicate) DSL evaluates predicates — Simple, XPath, or JSONPath expressions over the message body — and sends each exchange down exactly one branch, with otherwise() as the explicit catch-all for anything unmatched. {#wild-apache-camel-choice}
- **AWS EventBridge** — Rules match JSON event patterns against the event payload itself, including nested fields, and deliver each matching event only to that rule's targets. There is no otherwise branch: an event matching no rule is simply not delivered, so a catch-all rule is needed to observe unclassified events. {#wild-aws-eventbridge}
- **Spring Integration payload routers** — Routers such as payload-type-router and expression-based routers resolve the output channel from the message payload rather than its headers; a default-output-channel catches unmatched messages, and resolution-required controls whether an unresolvable message raises an error instead. {#wild-spring-integration-router}
- **Amazon Simple Notification Service (SNS) filter policies** — Each subscription to a topic can carry a filter policy matched against a message's attributes (or, optionally, its body), so a subscriber receives only the messages that match — content-based routing applied at the topic edge, per subscriber, instead of in a central router. {#wild-amazon-sns-filter-policy}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Rule order (first-match)** — The sequence in which conditions are evaluated; with first-match-wins semantics, reordering rules changes where overlapping messages land. Put the most specific rules first and keep a test table of sample messages with the expected channel for every overlap.
- **Default / otherwise branch** — Where a message that matches no rule goes — an explicit channel versus an implicit drop determines whether unclassified traffic is caught or lost.
- **Header prefilter vs. body parse** — Whether a cheap header or type check narrows candidates before the router parses the full body, trading routing cost against how much of the payload it must read.
- **Rule source** — Whether rules are hardcoded or externalized to a table or rules engine that operators can change without redeploying the router.

### Signals to watch
<!--meta polarity=signal-->

- **Per-branch match distribution** — Volume routed to each destination channel; a branch that drops to zero is an early sign of upstream schema drift, for a branch that normally has steady traffic.
- **Unmatched / default rate** — Fraction of messages falling through to the default branch — a spike means messages stopped classifying as expected. Take a baseline over a normal week and alert at a multiple of it; any non-zero parse-failure rate deserves a look.
- **Parse-failure rate** — Messages the router cannot deserialize far enough to route — a direct dependency on the payload schema showing up at runtime.

### Failure modes under load
<!--meta polarity=failure-->

- **Schema drift** — A producer renames or restructures a routed field and every affected message silently falls through to the default branch.
- **Unparseable payload** — A malformed body gives the router nothing to route on. With no fallback it is dropped, or retried without end so it blocks the queue; cap retries, then dead-letter it with the original body and the error.
- **Catch-all swallows traffic** — A permissive default branch quietly absorbs anything unclassified, hiding misrouting until someone notices the missing messages downstream.
- **Rule tangle** — Rules that overlap after years of additions let the wrong rule match first. The misrouted subset is hard to spot.

### Readiness checklist
<!--meta polarity=check-->

- Route unmatched or unparseable messages to an explicit channel or dead-letter, never drop them silently.
- Alert on the unmatched / default branch rate.
- Version the message schema the rules depend on and test the rules against it.
- Keep per-branch counters so a branch going quiet surfaces drift early.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Route each message to a channel by inspecting its body. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Fan-Out](./fan-out.md) — Filtering trims a broadcast fan-out down to the relevant subscribers.
- [Dead Letter Channel](./dead-letter-channel.md) — A payload matching no rule goes to the dead-letter channel, not nowhere
- [Message Translator](./message-translator.md) — Route by shape first, then translate each branch into one format
- [Message Encoding](./message-encoding.md) — Pin the routed fields in a versioned schema so rules keep matching.

**Alternative to**

- [Routing Slip](./routing-slip.md) — One central router inspects each message and picks its next hop, so every new route changes it

**Variant of**

- [Message Router](./message-router.md) — Route by rules; content-based inspects the body

**Often confused with**

- [Recipient List](./recipient-list.md) — When more than one condition matches and all of them should get a copy, it shades into a recipient list

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — An event bus matches the message body against rules and picks the destination for you.

<!-- relationships:end -->
