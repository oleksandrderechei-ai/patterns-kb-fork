---
title: Message Router
description: Directs a message to the right channel based on rules
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling]
status: stable
solves: [my publisher has a giant if/else deciding which service each message goes to, adding one more destination means editing and redeploying every sender, the same destination-picking logic is copied across three producers and has already drifted, business code is cluttered with knowledge of where things need to be sent, I want to change where certain messages go without shipping new code in the sender]
---

# Message Router

Inspects each incoming message against a set of rules and forwards it, unchanged, to exactly one of several output channels — so senders never have to know who's listening or how many consumers exist.

## What it is
<!--meta block=description-->

A **message router** reads each message from one input channel and forwards it unchanged to exactly one of several output channels, chosen by a rule over a header, message type, sender or rule table. It does not split, transform or enrich. Producers publish to one place and never hold the list of destinations, so the mapping can change without touching them. A [content-based router](./content-based-router.md) reads the body; a [recipient list](./recipient-list.md) fans out.

## Explained
<!--meta block=explain-->

A message router reads each message from one input channel and forwards it unchanged to exactly one of several output channels, chosen by a rule over its metadata: a header, a message type or the sender. Producers publish to one place and never hold the list of destinations, so the mapping can change without touching them. Choose it when the destination follows from metadata and the mapping changes on a different schedule from the code on either side. Skip it when your broker can do the same with bindings (rules that match a message routing key to a queue), because then there is no component to run.

- **Coupling point.** Every message crosses it, so keep it stateless and run several copies.
- **Rule sprawl.** Keep rules in one ordered table with a test per rule.
- **Misrouting.** Log which rule matched, and send unmatched messages to a [dead-letter channel](./dead-letter-channel.md) (a side queue for failures), not a default queue.

**Example.** A router reads 300 messages a second and sorts them by a tenant-tier header with two rules: premium (10%, so 30 a second) goes to a fast queue and standard (the other 270 a second) goes to a standard queue. Assume one router copy handles 500 a second: at a launch of 900 a second that is 2 copies at 90% busy, so plan a third for headroom. Then a release misspells the header on every premium message, so neither rule matches. With the standard queue as the default, those 30 messages a second would sit there unnoticed. With a dead-letter channel for unmatched messages, its depth alarm fires once the depth passes its threshold.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a sender reach the right handler without knowing that handler exists? It writes to one address (1), and the router decides from the labels alone (2–3), so the body crosses the boundary unparsed and unchanged. Exactly one output wins (4 or 5), and a message no rule claims goes to the dead-letter channel (6), not a default queue, instead of disappearing."
flowchart LR
    S["Order service"]
    subgraph Decide["Decision surface: labels only"]
        R{"Message router"}
        T[("Rule table")]
    end
    A["Refunds queue"]
    B["Support queue"]
    D[("Dead-letter channel")]:::ext
    S -->|"1 publish to one address"| R
    R -->|"2 match headers, never the body"| T
    T -->|"3 first rule that matches wins"| R
    R -->|"4 type=refund"| A
    R -->|"5 priority=vip"| B
    R -->|"6 nothing matched"| D
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **[Content-Based Router](./content-based-router.md)** — Routes on values inside the message body instead of header, type or sender. The body is read but still forwarded unchanged, so the router must parse it and is coupled to the message schema.
- **Static / rule-table router** — A fixed, config-file or hardcoded mapping from condition to channel — simplest form, but adding a route means a redeploy.
- **Dynamic router** — Rules are loaded from a registry or control channel and can be changed or reloaded at runtime without touching the router's code.
- **[Recipient list](./recipient-list.md)** — Sends the message to every channel that matches, not just one — a [fan-out](./fan-out.md) cousin rather than an exclusive routing decision.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Centralizes routing logic**, so producers stay decoupled from the number and identity of consumers.
- **New destinations are added** by changing the router's rules, not the sender's code.
- **Leaves the message body untouched**, so routing stays a separate concern, reasoned about from headers alone.
- **Rules live in one place**, so they're testable and auditable instead of scattered across senders.

### Cons
<!--meta polarity=con-->

- **The router becomes a single point of coupling** — and potentially a throughput bottleneck.
- **Rule sprawl turns a simple router** into an unmaintainable decision tree over time.
- **Debugging a misrouted message** means auditing the router's rules, not just the message.
- **Rules that depend on external** or mutable state make routing behavior harder to predict statically.
- **Ordering across channels is lost** when a stream is split across output channels or several router copies run, unless the router partitions by key.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple downstream consumers exist** and the right one depends on something other than the message body.
- **Senders should stay ignorant** of how many consumers exist or where they run.
- **Routing logic changes often enough** that it shouldn't be baked into producer code.

### Avoid when
<!--meta polarity=avoid-->

- **There's only one possible destination** — a direct channel needs no router at all.
- **The decision genuinely depends on the message's content** — reach for [Content-Based Router](./content-based-router.md) instead.
- **Every consumer needs the same message** — that's a fan-out, not an exclusive routing decision.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a rule-based router"
type Channel = "orders" | "refunds" | "support" | "dead-letter";
interface Message { headers: Record<string, string>; body: unknown }
type Rule = { matches: (m: Message) => boolean; channel: Channel };

class MessageRouter {
  constructor(
    private readonly rules: Rule[],
    private readonly fallback: Channel,
  ) {}

  route(message: Message): Channel {
    for (const rule of this.rules) { // first match wins
      if (rule.matches(message)) return rule.channel;
    }
    return this.fallback; // nothing matched: dead-letter, not a business queue
  }
}

const router = new MessageRouter(
  [
    { matches: (m) => m.headers["type"] === "refund", channel: "refunds" },
    { matches: (m) => m.headers["priority"] === "vip", channel: "support" },
  ],
  "dead-letter",
);

publish(router.route(incoming), incoming); // decide once, forward unchanged
```

## In the wild
<!--meta block=wild-->

- **Apache Camel** — Its routing domain-specific language (DSL) implements the enterprise integration pattern (EIP) catalog directly: choice().when().otherwise() for a content-based router, routingSlip() for a route read from a header, dynamicRouter() for rules evaluated per message, and recipientList() for fan-out. {#wild-apache-camel}
- **Spring Integration** — Ships router endpoints — HeaderValueRouter, PayloadTypeRouter, or a SpEL expression — that resolve one input channel to an output channel, with a default-output-channel for unmatched messages. {#wild-spring-integration}
- **RabbitMQ exchanges** — A direct exchange matches the routing key to a binding exactly, a topic exchange matches routing-key patterns with the \* and # wildcards, and a headers exchange routes on header attributes instead — publishers address the exchange and bindings decide the queue. {#wild-rabbitmq-exchanges}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Default / fallback channel** — Where a message matching no rule goes. Point it at a dead-letter channel with a depth alarm, not a working queue; without one, unmatched messages are dropped or sit unread.
- **Rule evaluation order** — First-match vs. evaluate-all ordering of the rule list decides which of several matching rules wins. Default to first-match with the most specific rule first; use evaluate-all only when you mean a recipient list.
- **Rule reload interval** — For a dynamic router, how often rules are re-read from the registry or control channel without a redeploy. Set it from how long a wrong route is tolerable, and keep the last good rule set when a reload fails.

### Signals to watch
<!--meta polarity=signal-->

- **Unroutable / fallback rate** — Fraction of messages hitting the fallback channel or matching no rule; a spike means the rules or the producers' headers have drifted from the traffic. For a closed set of message types, a sustained rate above zero is a bug.
- **Per-channel distribution** — Message counts per output channel; a channel that suddenly drops to zero flags a broken rule, or one that an earlier rule in the list always matches first (a shadowed rule).
- **Routing latency per message** — Time to evaluate the rule set, which matters when a rule consults external or mutable state.

### Failure modes under load
<!--meta polarity=failure-->

- **Silent misroute** — A wrong rule forwards a message to the wrong channel; the body is untouched, so no downstream error appears unless the consumer validates. Per-channel counts and the matched-rule log are the main signals.
- **No match, no fallback** — A message that satisfies no rule and has no fallback channel is dropped or sits unread; the fallback-rate signal is the only warning.
- **Stale external rule table** — Rules that depend on mutable state route to a decommissioned or renamed channel after the topology changes underneath them.
- **Router bottleneck** — All traffic funnels through one router; heavy per-message rule evaluation makes it the throughput ceiling for everything downstream.

### Readiness checklist
<!--meta polarity=check-->

- A dead-letter channel serves as the fallback for messages that match no rule, with a depth alarm.
- Rules are tested in isolation against representative messages
- Unroutable-message rate is monitored and alerted
- Rule changes are versioned and reviewable, not edited live without a record

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Pick one output channel per message by rule. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Message Queue](./message-queue.md) — Rules read from one input queue and forward to destination queues
- [Splitter](./splitter.md) — Split first, then route each fragment to the endpoint that handles it
- [Dead Letter Channel](./dead-letter-channel.md) — Messages that match no rule go to the dead-letter channel, not a default queue.

**Has variant**

- [Content-Based Router](./content-based-router.md) — Route by rules; content-based inspects the body
- [Recipient List](./recipient-list.md) — Drops the exactly-one constraint and delivers to every channel that matches

**Often confused with**

- [Fan-Out](./fan-out.md) — A router picks exactly one channel; fan-out copies to every consumer

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Subscription filters move the routing decision into the broker.

<!-- relationships:end -->
