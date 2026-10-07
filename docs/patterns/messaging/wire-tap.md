---
title: Wire Tap
description: "Copies messages to a side channel for inspection, unchanged"
area: messaging
owner: Oleksandr Derechei
tags: [observability, decoupling, isolation]
status: stable
aliases: [traffic mirroring, shadowing]
solves: [I need to see what is actually flowing through this channel and I cannot redeploy either end, adding logging to the consumer means editing code I do not own, I want to try the rewritten service against real traffic before trusting it with real requests, auditors want a record of everything that crossed this channel and nobody kept one, the logging I added inside the handler is now slowing down the actual work]
---

# Wire Tap

Copies every message that crosses a channel onto a side channel for inspection, leaving the original message and its delivery to the real receiver completely unchanged.

## What it is
<!--meta block=description-->

A wire tap copies every message passing through a channel onto a second channel for an observer, while the original goes on to its receiver untouched. With a broker-level or proxy tap, sender and receiver do not know it exists and no production code changes; an in-process wrapper edits the call site. You add audit, monitoring or a shadow consumer without letting a slow observer block delivery.

## Explained
<!--meta block=explain-->

Choose a wire tap over logging inside the sender or receiver when the observer must not be able to affect delivery: the copy is handed off and its result ignored, so a slow observer cannot block the original. With a broker-level or proxy tap neither endpoint changes; an in-process wrapper edits the call site. Shadowing a new consumer on real traffic is the case where that isolation matters most.

- **Hidden failure.** A failing tap looks like quiet traffic. Alert on the tap's lag and on the gap between the two counts.
- **Double traffic.** The tapped channel carries twice the load at that point, so filter or sample what you copy.
- **Data leak.** The copy can reach a monitoring system less protected than the original, so mask sensitive fields before it leaves.

**Example.** A payments channel carries 500 messages a second. A tap copies them to an audit store that handles 300 a second. The tap is out of band, so payments keep flowing at 500 a second while the tap queue grows by 200 a second: 200 x 600 = 120,000 messages after 10 minutes. The audit view is then 120,000 / 300 = 400 s behind, and nothing on the payment path shows it. A lag alert catches that. With a 100,000-message bound it fills after 100,000 / 200 = 500 s, then drops copies, so the drop rate shows the gap, not lag. Masking the card number first keeps the full number out of the audit store.

## How it works
<!--meta block=structure-->

```mermaid caption="What stops the watcher from slowing the delivery? Step 3 hands off a copy and throws the result away, so the receiver gets the same bytes at the same time whether the tap is fast, lagging or gone. Step 5 is the price of that: when the side channel fills, you lose copies, not messages."
flowchart LR
    S["Sender"]:::ext
    subgraph Prim["The primary path: same payload, no added wait"]
        WT["Tap point"]
        R["Receiver"]
    end
    T[("Tap channel")]
    Obs["Monitor / audit sink"]:::ext
    Drop["Discarded copies"]:::ext
    S -->|"1 message"| WT
    WT -->|"2 forward, byte for byte"| R
    WT -.->|"3 hand off a copy, discard the result"| T
    T -->|"4 read at its own pace"| Obs
    T -.->|"5 shed when the channel is full"| Drop
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Static tap** — Copies every message unconditionally — the simplest form, best when you need a complete audit trail or full traffic capture.
- **Filtered / conditional tap** — Applies a predicate before copying — only errors, only messages above a size threshold — so the side channel's volume stays manageable.
- **Store-backed tap** — Writes the copy into a persistent message store instead of a live stream, trading real-time visibility for replay and later analysis.
- **Broker-level tap** — Implemented as a binding or mirror inside the message broker itself — an exchange-to-exchange binding, a topic mirror — rather than in application code, so neither producer nor consumer needs redeploying.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Out-of-band, so the tap adds no hop and no wait to delivery** — the copy still costs CPU for the clone and shares broker capacity (see the first con).
- **Enables auditing, debugging, and monitoring** without touching sender or receiver code.
- **Drops in or comes out** cleanly, without redeploying either endpoint.
- **Lets a new consumer shadow** real production traffic before it's ever trusted with the real path.

### Cons
<!--meta polarity=con-->

- **Duplicates volume through the tapped point** — a busy channel now feeds two consumers instead of one.
- **A lagging or failed tap consumer** gives stale or missing observability with no visible symptom on the main path.
- **A careless tap can leak sensitive payloads** to a monitoring or logging surface that isn't secured for them.
- **One more piece of routing topology** to keep documented and in sync with the primary channel.
- **The tap records what entered the channel, not what the receiver processed**, so reconcile it against receiver outcomes before treating it as the audit of record.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need visibility into live message traffic** for debugging, auditing, or monitoring without touching producers or consumers.
- **You want to validate a new consumer** against real traffic before cutting it over.
- **A sensitive channel needs an audit trail** of what crosses it, written by a lossless store-backed tap; a tap that drops copies when full leaves gaps.

### Avoid when
<!--meta polarity=avoid-->

- **The real need is visibility** into the receiver's own behavior — instrument the receiver directly instead.
- **You need guaranteed, ordered delivery of the copy** — a plain in-process tap is fire-and-forget, so copies can be lost; a store-backed tap trades real-time visibility for replay.
- **The tap would carry sensitive** payloads onto a monitoring channel that isn't secured for them.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — wrapping a handler with a tap"
type Message<T> = { id: string; payload: T; timestamp: number };

function wireTap<T>(
  deliver: (msg: Message<T>) => Promise<void>,   // real receiver
  tap: (msg: Message<T>) => void | Promise<void>, // side channel
  bound: number,                                  // tap buffer bound
): (msg: Message<T>) => Promise<void> {
  const queue: Message<T>[] = [];
  let dropped = 0;                                // the drop-rate signal
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      try { await tap(queue.shift()!); } catch { dropped++; } // never reaches the caller
    }
    draining = false;
  };
  return (msg) => {
    if (queue.length < bound) {
      // mask sensitive fields here, before the copy leaves
      queue.push(structuredClone(msg));
      queueMicrotask(drain);                      // runs after deliver is called
    } else dropped++;                             // full: lose the copy, not the message
    return deliver(msg);                          // original message, unmodified
  };
}

const send = wireTap(deliverToReceiver, (msg) => auditLog.write(msg), 100_000);
await send({ id: "1", payload: { amount: 42 }, timestamp: Date.now() });
```

## In the wild
<!--meta block=wild-->

- **Envoy request mirroring** — A route request_mirror_policies clause copies live traffic to a shadow cluster and discards the response, so the mirror cannot affect the real one; runtime_fraction samples what share of requests are mirrored, and the shadowed authority gets a -shadow suffix. {#wild-envoy-shadow}
- **nginx mirror module** — The ngx_http_mirror_module issues a background subrequest copy of each request to a mirror location and ignores the result; mirror_request_body controls whether the body is duplicated, and errors on the mirror path do not affect the original response. {#wild-nginx-mirror}
- **Apache Camel wireTap()** — Its wireTap() enterprise integration pattern (EIP) sends a copy of the exchange to a second endpoint on a separate thread pool while the original route continues; the tap is InOnly and fire-and-forget, and an onPrepare processor can transform or redact the copy before it goes. {#wild-apache-camel-wiretap}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Tap sampling / filter predicate** — Copy every message or only a sampled or filtered subset, to keep the side-channel volume manageable.
- **Tap channel buffer bound** — How much the tapped side may buffer before dropping copies, so a slow observer never backpressures the primary path. Start from peak message rate times the longest observer stall you accept; drop copies when full, never block.
- **Redaction / field masking** — Which fields are stripped or masked before the copy leaves the primary channel.

### Signals to watch
<!--meta polarity=signal-->

- **Tap consumer lag** — How far behind the live flow the tapped consumer is; the gap between what happened and what the observer has seen. Alert when lag exceeds the window the observer promises.
- **Tap drop rate** — Copies discarded when the side channel is full or the tap errors — the size of the observability gap. Alert on any sustained non-zero rate when the tap feeds an audit trail.
- **Side-channel volume vs. primary** — Message rate on the tapped channel relative to the primary, to confirm the tap is not doubling the load it observes.

### Failure modes under load
<!--meta polarity=failure-->

- **Silent observability gap** — A lagging or failed tap consumer yields stale or missing data with no symptom on the primary path.
- **Sensitive-data leak** — The copy carries payloads onto a monitoring or logging surface that is not secured for them.
- **Backpressure leak** — A tap that is not truly fire-and-forget lets a slow observer stall or fail the primary path it was meant to leave untouched. Typical cause: a synchronous tap call or an unbounded tap queue.
- **Volume doubling at the tap point** — The tapped channel serves two consumers, so the copy competes with real traffic for shared broker capacity; sample or filter what you copy.

### Readiness checklist
<!--meta polarity=check-->

- Tap failures are swallowed, never block or fail the primary path, and are counted in the drop rate
- Sensitive fields are redacted or masked before the copy leaves the primary channel
- The side channel is bounded or sampled so it cannot exhaust broker or consumer capacity
- Tap consumer lag is monitored so an observability gap is visible
- The copy is deep or immutable, so the observer cannot alter the message the receiver sees

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Observability](../../themes/observability.md) — Observe message flow without changing it {#fluency-observability}
- [Health Modeling](../../themes/health-modeling.md) — Evidence from a path that has no request to measure {#fluency-health-modeling}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Secure Logger](../security/secure-logger.md) — Tap to an audit log
- [Publish-Subscribe](./pubsub.md) — A broker-level tap is one more subscription on the same topic
- [Strangler Fig](../distributed/coordination/strangler-fig.md) — Mirror live traffic at a new slice to check it before cutover
- [Shadow Traffic](../distributed/routing/shadow-traffic.md) — Its copy-to-a-side-channel idea, applied to requests at the router

**Often confused with**

- [Fan-Out](./fan-out.md) — The tap's copy is out-of-band and discardable, not a delivery

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that copies messages to a side channel as a ready-made building block.

<!-- relationships:end -->
