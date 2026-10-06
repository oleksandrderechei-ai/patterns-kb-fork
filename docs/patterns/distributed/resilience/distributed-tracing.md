---
title: Distributed Tracing
description: "Follow one request across every service it touches, as a single timeline"
area: distributed-resilience
owner: Oleksandr Derechei
tags: [observability, latency]
status: stable
aliases: [tracing, spans, request tracing, trace context]
solves: [a page is slow and six services each say they were fast, we cannot tell which service the error actually started in, correlating log files by timestamp across services is how every incident begins, nobody knows which services a request really calls because the architecture diagram is out of date, the p99 spiked and we have no example of a request that was slow]
---

# Distributed Tracing

Gives one request a single identity that travels with it across every service, queue and database it touches, and records each unit of work against that identity. The result is a timeline showing where the time actually went and which hop failed — a question logs and metrics cannot answer once a request crosses a process boundary.

## What it is
<!--meta block=description-->

When a request crosses many services and runs slowly, no single log shows which step took the time. Distributed tracing records each unit of work as a span that carries a shared trace id and names its parent. The spans join into one tree showing the path of the request and the cost of each step. Each caller passes the trace id on to the next.

## Explained
<!--meta block=explain-->

Distributed tracing records one request's path through many services, so you can see which step took the time or failed. Each piece of work, such as an incoming request, an outgoing call or a query, is saved as a span with a start, a duration and a status. Every span carries the same trace id and names the span that caused it, so the spans join into one tree. Each caller puts the trace id and its own span id into the outgoing request, usually in the traceparent header, and the callee continues from them. Choose it over logs when no one can say which service owns a delay, since logs from different machines cannot be lined up reliably. Check the awkward hops: a message queue, where the id must ride in the message, and a thread pool, where you carry it across by hand.

- **Volume.** Full tracing costs more to store than the traffic costs to serve, so keep a sample and every error or slow trace.
- **Silent breaks.** One service that drops the id splits the trace in two, so check every hop.
- **Samples cannot count.** A sample cannot say how many requests were slow, so use metrics and put the trace id on them.

**Example.** A checkout takes 1.2 s. Its trace shows the order service at 1.18 s, inventory at 40 ms and payment at 1.05 s, and inside payment one bank call at 1.0 s. The slow hop is visible without reading five log files. Each request makes 20 spans of about 500 bytes, so 10 KB, and at 1,000 requests a second that is 10 MB a second, about 864 GB a day. Keeping 1% brings it to 8.6 GB. The cost is that a fault hitting 1 request in 1,000 is then kept in only 1 trace in 100,000, so keep every error and every slow trace on top.

## How it works
<!--meta block=structure-->

```mermaid caption="How do spans recorded in three separate processes become one timeline? Only because the identity was propagated in the request itself — export is out of band and unordered, so the trace id and the parent link are what rebuild the tree."
flowchart LR
    C["Client"]:::ext
    subgraph Prop["The context travels with the request"]
        G["Gateway"]
        S1["Orders service"]
        S2["Pricing service"]
    end
    Col["Collector"]
    B[("Trace backend")]
    C -->|"1 request, no trace context yet"| G
    G -->|"2 start a trace, send traceparent onward"| S1
    S1 -->|"3 read it, start a child span, pass it on"| S2
    G -.->|"4 export spans out of band"| Col
    S1 -.->|"4 export spans out of band"| Col
    S2 -.->|"4 export spans out of band"| Col
    Col -->|"5 spans reassemble by trace id"| B
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Where does a trace usually break? At the queue. An HTTP call carries context in a header for free; a message carries it only if the producer put it in the envelope and the consumer looked for it."
sequenceDiagram
    participant G as Gateway
    participant O as Orders
    participant P as Pricing
    participant Q as Queue
    participant W as Worker
    G->>O: traceparent trace=a1, span=01
    O->>P: traceparent trace=a1, parent=02
    P-->>O: 120 ms
    O->>Q: publish, context in the message envelope
    O-->>G: 140 ms
    Q->>W: consume, context read from the envelope
    Note over W: same trace a1, linked to span 02
    Note over Q,W: without the envelope the async work starts a NEW trace
```

## Variations
<!--meta block=variations-->

- **Head-based sampling** — The first service decides whether this trace will be kept, and propagates that decision so every downstream service agrees. It is stateless, costs nothing to run, and bounds spend predictably, which is why it is where almost everyone starts. It also decides before anything has happened, so the rare slow or failed request is discarded at exactly the same rate as the boring ones.
- **Tail-based sampling** — Spans are buffered until the trace completes, then kept or dropped based on what actually happened — errors and long durations retained, routine successes thrown away. It keeps the traces you would have chosen with hindsight, which is the whole point of having them. The buffer is a stateful component sized for peak trace throughput, and it has to hold every span of a trace in one place, which constrains how the collectors are deployed.
- **Forced sampling on interest** — A low baseline head rate, plus rules that switch sampling on when a request is already suspicious — an error status, a debug header from a support tool, an upstream that has been slow. Because the decision propagates, one service turning it on captures the full downstream tree. It needs the trigger to be visible early, so it complements tail-based sampling rather than replacing it.
- **Instrumentation at the [sidecar](../routing/sidecar.md) or [mesh](../routing/service-mesh.md)** — The proxy beside each service creates and propagates spans, so every hop is traced with no change to application code — invaluable across services nobody wants to modify. It sees only what crosses the network, so the trace shows which call was slow and never which function inside it was, and in-process work stays invisible.
- **Exemplars linking metrics to traces** — A latency metric carries the trace id of a request that landed in each bucket, so a spike on a dashboard is one click from a concrete example of it. It closes the gap between "how many were slow" and "why this one was", which is otherwise a manual search. It requires the metrics pipeline and the tracing pipeline to agree on the identifier, and only helps for the requests that were sampled.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The slow hop is visible directly**, instead of being inferred by comparing timestamps across log files that do not agree.
- **A failure shows where it started** rather than where it surfaced, which is usually several services apart.
- **The trace tree documents the real call graph**, including the dependency nobody remembered adding.
- **A standard propagation format** means services owned by other teams join the same trace without any agreement beyond the header.
- **Export is out of band**, so a tracing backend that is down costs visibility rather than availability.

### Cons
<!--meta polarity=con-->

- **One service that does not propagate the context** breaks every trace that passes through it, and the break is silent.
- **Full-fidelity tracing at high traffic** costs more to store than the traffic costs to serve, so sampling is not optional.
- **Head-based sampling discards the outliers you most wanted**, because the decision is made before anything interesting happens.
- **Traces are a sample**, so they explain individual requests and cannot answer questions about totals.
- **Span attributes are a data-exfiltration surface** with none of the review a log statement usually gets.
- **A span name built from a request id** creates one operation per request, and the backend's indexes become the bottleneck.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A single user action** crosses more than two processes before an answer comes back.
- **Latency is the complaint** and nobody can say which hop owns it.
- **Services are owned by different teams**, so no one person can hold the whole call path in their head.
- **Failures surface far from where they start**, and incidents keep beginning with an archaeology exercise.

### Avoid when
<!--meta polarity=avoid-->

- **The system is one process**, where a profiler answers the same question with more detail and no infrastructure.
- **The question is how many**, how often or how much, which is what metrics are for.
- **Only some services can be instrumented**, where partial traces mislead more than the missing hops cost.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — propagate the context, including across the hop that usually loses it"
// INBOUND: continue the caller's trace if there is one, start a new one if not.
// Any service that speaks the same header format joins the trace, no other agreement needed.
app.use((req, res, next) => {
  const parent = propagator.extract(req.headers);      // reads `traceparent`
  tracer.startActiveSpan(`${req.method} ${req.route?.path ?? "unmatched"}`, { parent }, (span) => {
    // Route TEMPLATE, never the concrete path: `/orders/:id` is one operation,
    // `/orders/8f2c...` is one per request and kills the backend index.
    res.on("finish", () => { span.setAttribute("http.status_code", res.statusCode); span.end(); });
    next();
  });
});
// OUTBOUND over HTTP: propagator.inject(context.active(), headers) writes `traceparent`.
// OUTBOUND over a QUEUE: the hop that breaks. No connection carries the context,
// so write it into the ENVELOPE and read it back out, or the asynchronous half
// of the work starts a brand-new, unrelated trace.
async function publishOrderPlaced(event: OrderPlaced) {
  const carrier: Record<string, string> = {};
  propagator.inject(context.active(), carrier);
  await queue.publish({ body: event, headers: carrier });
}
async function onMessage(msg: Message) {
  const parent = propagator.extract(msg.headers);
  // A `link`, not a child span, when the consumer runs much later: a child
  // would distort the producer's span, which ended long ago.
  tracer.startActiveSpan("OrderPlaced handler", { links: [{ context: parent }] }, async (span) => {
    try { await handle(msg.body); } finally { span.end(); }
  });
}
```

## In the wild
<!--meta block=wild-->

- **OpenTelemetry** — The Cloud Native Computing Foundation (CNCF) project that standardises the API, the SDKs and the wire protocol for traces, metrics and logs, plus a vendor-neutral collector. It is what lets instrumentation be written once and pointed at a different backend later. {#wild-opentelemetry}
- **W3C Trace Context** — The recommendation that defines the `traceparent` and `tracestate` headers. Being a published standard rather than a vendor format is exactly why two independently built services can join one trace. {#wild-w3c-trace-context}
- **Jaeger** — A CNCF distributed tracing backend that collects, stores and queries spans, with support for sampling decided centrally rather than hardcoded in each service. {#wild-jaeger}
- **Google Dapper** — The 2010 paper describing the internal tracing system that established the model — trace ids, spans, parent links, and low sampling rates as the way to make it affordable. Nearly every system since follows its shape. {#wild-dapper}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Sampling rate and strategy** — What fraction of traces is kept and when that is decided. It sets both the storage bill and whether the trace you need during an incident exists at all.
- **Span naming** — What a span is called — the route template, never the concrete path. A name containing an id creates one operation per request and turns the backend index into the bottleneck.
- **Attribute allowlist** — Which request data is attached to spans. Treat it exactly like a log destination: attributes travel to a third-party backend and get none of the review a log statement usually receives.
- **Exporter batching and queue size** — How many spans buffer before export and what happens when the buffer fills. Dropping spans is correct; blocking the request path to export telemetry is not.
- **Tail-sampling buffer window** — How long a collector holds the spans of an unfinished trace. Shorter than your slowest request and the slow traces are the ones truncated.

### Signals to watch
<!--meta polarity=signal-->

- **Trace completeness** — The share of traces whose spans span the whole expected path. A drop names the service that stopped propagating context, which nothing else will tell you.
- **Span export drop rate** — Spans discarded because the exporter queue was full. Non-zero means the traces you are reading are missing parts of themselves.
- **Effective sampling rate** — Traces kept against traces started. It drifts from the configured value whenever a forced-sampling rule fires more than expected.
- **Distinct span names** — Operation cardinality in the backend. A sudden climb is almost always an id that leaked into a span name.
- **Backend ingest latency** — How long between a span ending and being queryable. During an incident this is the difference between a useful tool and one you gave up on.

### Failure modes under load
<!--meta polarity=failure-->

- **A trace that stops halfway** — One service does not propagate the context, so everything downstream forms a separate tree. The trace looks complete and simply ends, which reads as if the work finished there.
- **Async work becomes its own trace** — A message is published without the context in its envelope, so the consumer starts a fresh trace. The expensive half of the request becomes invisible to the half you are looking at.
- **The slow request was never sampled** — Head-based sampling discarded it before anything knew it would be slow, so the outlier that caused the incident has no trace at all.
- **Cardinality explosion in span names** — Ids in operation names create one distinct operation per request, and backend queries slow to the point of being useless.
- **Telemetry back-pressures the request path** — An exporter configured to block instead of drop turns a slow tracing backend into slow requests — an observability tool causing the outage it was meant to explain.

### Readiness checklist
<!--meta polarity=check-->

- Context propagates on every hop, including queues and thread handoffs
- Span names use route templates, never concrete ids
- Export is asynchronous and drops rather than blocks when the buffer fills
- The sampling strategy keeps errors and slow requests, not only a flat fraction
- Trace ids appear on log lines, so a trace and its logs can be joined
- Span attributes are reviewed for sensitive data like any other log destination
- Trace completeness is monitored, so a service that stops propagating is caught
- Latency metrics carry exemplars, so a spike leads directly to a trace

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Twelve-Factor](../../../themes/twelve-factor.md) — Telemetry emitted, collected elsewhere {#fluency-twelve-factor}
- [Observability](../../../themes/observability.md) — Reassemble one request into a single timeline {#fluency-observability}
- [Health Modeling](../../../themes/health-modeling.md) — Explain a verdict once it turns amber {#fluency-health-modeling}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Service Mesh](../routing/service-mesh.md) — The mesh proxy can start and propagate spans on every hop without any application change
- [Sidecar](../routing/sidecar.md) — Exporting spans from a companion process keeps the tracing software development kit (SDK) and its configuration out of the application
- [Health Endpoint Monitoring](./health-endpoint.md) — A probe says whether an instance is healthy; a trace says which hop made a request slow

**Enables**

- [Geode](../routing/geode.md) — Asynchronous multi-region request paths cannot be followed without it

**Requires**

- [Correlation Identifier](../../messaging/correlation-identifier.md) — A trace id carried over every hop is a correlation id, so the shared id comes first

**Prevents**

- [Leaky Abstraction](../../../hazards/leaky-abstraction.md) — Reveals the cost an abstraction's interface never mentions
- [Premature Optimization](../../../hazards/premature-optimization.md) — Shows which call actually takes the time, so effort goes to the measured bottleneck

**Implemented by**

- [Observability Platform](../../../capabilities/observability-platform.md) — Available as a managed service rather than a system you assemble

<!-- relationships:end -->
