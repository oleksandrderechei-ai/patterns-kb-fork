---
title: Correlation Identifier
description: Tags related messages so replies can be matched up
area: messaging
owner: Oleksandr Derechei
tags: [messaging, asynchrony]
status: stable
aliases: [correlation ID]
solves: [replies land on a shared channel and I cannot tell which one answers which request, I have to grep six services logs by timestamp to piece together what happened to one order, responses come back out of order and my client hands the wrong answer to the wrong caller, a customer reports a failure and I have no way to follow that one request across our services, I fired ten requests at once and their answers are interleaved with everyone elses]
favourite: true
---

# Correlation Identifier

Stamps every request with a unique token that each downstream reply, retry, or log line copies verbatim — so a flood of concurrent, asynchronous messages on a shared channel can still be traced back to the one conversation that produced them.

## What it is
<!--meta block=description-->

Replies on a shared channel arrive late, out of order and mixed with others, and nothing on them says which request they answer. A **correlation identifier** is a unique token, such as a UUID (universally unique identifier), a sequence number or a business key, stamped into the request header and copied unchanged by every reply or follow-up. Passed through every hop, it also narrows logs to one operation. It differs from a message id, which names one message.

## Explained
<!--meta block=explain-->

A correlation identifier is a token, such as a random UUID, that you put in the header of a request and that every reply or follow-up message copies unchanged. It lets you match each answer to its question when answers arrive late, out of order or mixed with others on one channel, and it gives you one key to search every log line of that operation. Add it as soon as more than one conversation shares an asynchronous channel, because matching by arrival order breaks the first time one reply is slow. It is not a message id: that names one message, while the correlation id names the whole conversation.

- **Dropped ids.** A hop that drops or replaces the id breaks the chain, so reject a message that arrives without one.
- **Pending table.** The sender must track pending ids with a timeout and a size cap, or a lost reply leaks memory.
- **Links only.** The id does not show that all replies arrived; an aggregator does that.
- **Collisions and leaks.** Use a random id, not a business key, so a clash or log leak exposes nothing.

**Example.** A pricing service sends 3 requests onto one reply queue: a1 for a hotel, b2 for a flight, c3 for a car. The replies return as c3, a1, b2. Matched by arrival order, the hotel would get the car price. Matched by id, each lands on its own request. The flight service is down, so b2 never returns. With a 30 s timeout the caller fails that one request and frees its entry. With no timeout and 20 requests a second, a dead service leaks 20 entries a second, which fills a 1,000-entry cap in 50 s.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a reply find the request it answers when replies come back in any order? The id written at step 1 is copied at step 4 and looked up at step 6, so arrival order never enters into it."
flowchart LR
    Req["Requestor"]
    Pend[("Pending map, keyed by id")]
    subgraph Same["One id, copied verbatim at every hop"]
        RQ[("Request channel")]
        Svc["Responder service"]:::ext
        RP[("Reply channel")]
    end
    Req -->|"1 stamp a unique id, send"| RQ
    Req -->|"2 record the id as pending"| Pend
    RQ -->|"3 deliver"| Svc
    Svc -->|"4 reply, same id copied"| RP
    RP -->|"5 deliver"| Req
    Req -->|"6 look the id up, resolve the caller"| Pend
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Two requests are in flight at once and their replies come back out of order; the correlation id — not arrival order — tells the requestor which reply answers which request, and a reply matching no pending id is discarded."
sequenceDiagram
    autonumber
    participant R as Requestor
    participant Ch as Channel
    R->>Ch: Request A, CorrelationId=aaa
    R->>Ch: Request B, CorrelationId=bbb
    Note over R: aaa, bbb held as pending
    Ch-->>R: Reply, CorrelationId=bbb
    Ch-->>R: Reply, CorrelationId=aaa
    alt id matches a pending request
        R->>R: resolve caller by id, arrival order irrelevant
    else id unknown, late, or already handled
        Ch--xR: Reply, CorrelationId=zzz
        R->>R: discard unmatched reply
    end
```

## Variations
<!--meta block=variations-->

- **Message-header correlation ID** — The classic form — a GUID placed in a header field (`JMSCorrelationID`, AMQP (Advanced Message Queuing Protocol)'s `correlation_id`) that the responder copies straight from the request into the reply.
- **Business key as correlation ID** — Reuse a domain identifier that's already unique — an order id, a session id — instead of generating a synthetic token. Cheaper, but only safe when that key genuinely can't repeat across concurrent conversations.
- **[Scatter-Gather aggregation key](./scatter-gather.md)** — One correlation id ties every parallel reply back to a single [fan-out](./fan-out.md) request, so the [aggregator](./aggregator.md) knows when it has collected them all.
- **Distributed trace ID** — The same idea propagated across every hop of a call chain (W3C `traceparent`, `X-Request-Id`) so logs and spans from otherwise unrelated services join into one trace.
- **[Saga correlation](../distributed/coordination/saga.md)** — One id threads every step of a long-running saga, so its completion, compensation, and timeout handlers all know which instance they belong to.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Lets one channel or queue carry** many concurrent conversations without cross-talk between them.
- **Replies can arrive in any order**, or interleaved with unrelated traffic, and still land on the right pending request.
- **Costs almost nothing to add** — one extra header field, copied verbatim at every hop.
- **Extends directly into distributed tracing**: the same mechanism stitches a whole multi-service call into one story.

### Cons
<!--meta polarity=con-->

- **Every hop must copy the id correctly** — one component that drops or regenerates it silently breaks the chain. Assert the id on the way in and reject a message without one, rather than generating a fresh id and losing the thread.
- **The requestor must track pending** correlation ids itself, with timeouts, or a reply that never arrives leaks memory forever — give the pending map a hard ceiling as well as an expiry, so a silent downstream degrades instead of exhausting the caller.
- **A collision or an accidentally reused id** attributes a reply to the wrong requestor — use a random UUID unless a business key is provably unique across concurrent conversations.
- **It only marks messages as related** — it provides no ordering and no guarantee that every expected reply actually arrived.
- **Completeness needs a second mechanism on top**: something has to know how many replies to expect and what to do when one never comes, which is the job of a [Scatter-Gather](./scatter-gather.md) aggregator, not of the id.
- **An id that reaches a log** or an audit trail carries whatever it was built from — a business key used as a correlation id puts an order number, or worse, into every span and log line a third party might hold.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple requests are in flight at once** over the same asynchronous channel or queue.
- **Replies can arrive out** of order, or interleaved with unrelated messages, and still must land on the right caller.
- **One logical operation spans several services** or processes and needs to be traced as a single unit.

### Avoid when
<!--meta polarity=avoid-->

- **The exchange is a synchronous request/reply call** — the open connection already correlates request and response for free.
- **Only one request is ever outstanding** at a time, so there's nothing to disambiguate.
- **You need the workflow around** the correlated messages managed, not just the matching — reach for [Scatter-Gather](./scatter-gather.md) or [Saga](../distributed/coordination/saga.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — matching vendor callbacks back to their flow"
interface Callback { flowId: string; payload: unknown; }

class CorrelatingVendorClient {
  private pending = new Map<string, (cb: Callback) => void>();

  // flowId is generated once when the flow is created, not per call: the same id
  // rides every transition, task row, vendor request and the final webhook.
  async request(flowId: string, payload: unknown): Promise<Callback> {
    return new Promise<Callback>((resolve) => {
      this.pending.set(flowId, resolve);
      idVendor.send({ flowId, payload });
    });
  }

  // Called whenever the vendor calls back into the API.
  onCallback(cb: Callback) {
    const resolve = this.pending.get(cb.flowId);
    if (!resolve) return; // unknown, late, or already-handled callback
    this.pending.delete(cb.flowId);
    resolve(cb);
  }
}

await vendorClient.request(flowId, { personaId, documentKey });
log.info({ flowId, step: "verify_id" });   // same id in the logs …
await webhook.deliver(clientUrl, { flowId, state: "cleared" }); // … and on the wire
```

## In the wild
<!--meta block=wild-->

- **W3C Trace Context** — Standardizes the traceparent header — version, 16-byte trace-id, 8-byte span-id, and flags — plus a tracestate header for vendor data, so every service in a call chain propagates one trace id that joins otherwise unrelated spans into a single trace. {#wild-w3c-trace-context}
- **Java Message Service (JMS) JMSCorrelationID** — A standard JMS header the responder copies from the request into the reply so the requestor can match it against its pending calls; typically paired with JMSReplyTo, which names the queue the reply should return on. {#wild-jms-correlation-id}
- **AMQP correlation_id** — A dedicated message property carried alongside reply_to; the RabbitMQ remote procedure call (RPC) tutorial documents using the two together to implement request/reply over queues, the responder echoing the correlation_id back on the reply-to queue. {#wild-amqp-correlation-id}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Pending-request timeout** — How long the requestor keeps a correlation entry waiting for its reply before expiring it and reclaiming the slot.
- **Pending-map ceiling** — The maximum number of outstanding correlations the requestor will hold at once, and what it does on reaching it — reject, shed, or block.
- **ID generation scheme** — Random UUID versus a reused business key; it sets how much collision resistance you have when many conversations share one channel.
- **Propagation header** — Which header carries the id (traceparent, X-Request-Id, JMSCorrelationID), and therefore what every hop has to read and re-emit.

### Signals to watch
<!--meta polarity=signal-->

- **Outstanding pending correlations** — Size of the requestor pending map, next to its ceiling — the number that tells you whether replies are coming back at all.
- **Unmatched reply rate** — Replies whose correlation id has no pending entry — late, unknown, or an id that was dropped or regenerated somewhere upstream.
- **Missing-id rate on ingress** — Messages arriving with no correlation header at all, counted per upstream — this names the component that is breaking the chain.
- **Request-to-reply latency** — Time from stamping the id on a request to matching its reply, measured per correlation.

### Failure modes under load
<!--meta polarity=failure-->

- **Leaked pending entries** — A reply that never arrives, with no timeout on the pending map, grows the requestor state without bound until the process dies.
- **Dropped or regenerated id** — One hop that fails to copy the id verbatim breaks the chain, and every reply behind it becomes unmatchable.
- **Collision or reuse** — A repeated or accidentally reused id attributes a reply to the wrong requestor — a silent, load-dependent mismatch.
- **Late reply after expiry** — A reply arriving after its pending entry timed out has nowhere to land; without a defined path it is dropped silently, and the work it reports on looks like it never finished.

### Readiness checklist
<!--meta polarity=check-->

- Every pending correlation expires, and the expiry path is exercised in tests rather than first in an incident
- The pending map has a hard ceiling as well as a timeout, so a silent downstream degrades instead of exhausting memory
- Ids are collision-resistant, or the business key used instead was shown to be unique across concurrent conversations
- Ingress asserts the id is present and rejects rather than generating a replacement, so a broken chain is loud
- A reply that arrives after its entry expired has a defined destination and is counted, not dropped
- The id carries no data you would not want in a log line or a third-party trace

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Observability](../../themes/observability.md) — Stitch one request across services {#fluency-observability}
- [Microservices Design](../../themes/microservices-design.md) — One id threaded through every hop {#fluency-microservices-design}
- [Workload Composition](../../themes/workload-composition.md) — Rejoin a request that was split across components {#fluency-workload-composition}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Scatter-Gather](./scatter-gather.md) — Correlate responses back to the request
- [Saga](../distributed/coordination/saga.md) — Correlate the steps of one saga
- [Splitter](./splitter.md) — Fragments of one split message are tied back to their origin
- [Publish-Subscribe](./pubsub.md) — A topic hides who is listening; the id is what stitches the trail back together
- [Design for Operations](../../principles/design-for-operations.md) — The correlation id is what makes a distributed incident legible
- [Asynchronous Request-Reply](../distributed/routing/async-request-reply.md) — A request queue and a reply queue need the id to route the answer back to the caller that is waiting

**Enables**

- [Distributed Tracing](../distributed/resilience/distributed-tracing.md) — A trace id propagated over every hop is this pattern generalised past the reply-matching case
- [Aggregator](./aggregator.md) — The aggregator is the consumer that uses the id to decide which fragments belong together

**Often confused with**

- [Unique ID Generation](../distributed/coordination/unique-id-generation.md) — This generates primary keys; a correlation id tags related messages and is never a key

**Demonstrated by**

- [ChatGPT](../../designs/chatgpt.md) — the runId is the correlation identifier that ties asynchronous token output back to its originating request across a fully decoupled path
- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — one flowId threading a persona-verification saga's vendor calls, logs, and webhook payload end to end
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — one id instead of distributed tracing, with the honest note that this stops being true when work leaves the transaction

**Implemented by**

- [Observability Platform](../../capabilities/observability-platform.md) — Distributed tracing propagates the identifier across every hop and lets you search by it.

<!-- relationships:end -->
