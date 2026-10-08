---
title: Observability
description: Knowing what a running system is actually doing
area: themes-operating
owner: Oleksandr Derechei
tags: [observability, maintainability]
status: stable
aliases: [o11y, telemetry]
---

# Observability

A distributed system fails in ways no single developer can reproduce on a laptop. Observability is the property that a system's internal state can be inferred from what it emits — its logs, metrics, and traces — so whoever is on call can find the actual cause instead of guessing at it.

## The question
<!--meta block=description-->

Something is slow or failing for some users, and you do not know which service or code path is to blame. In a system of dozens of services you cannot attach a debugger, because the request has already crossed process and network boundaries. You can only answer what happened afterwards if you recorded it beforehand: structured logs, metrics and traces, correlated into one story.

## Explained
<!--meta block=explain-->

Observability means recording what a running system does, in a form you can query afterwards, so you can answer questions nobody planned for. Once a request crosses dozens of services you cannot attach a debugger, so you rely on three records: logs, which are detailed event lines; metrics, which are cheap counts and timings with no view of one request; and [traces](../patterns/distributed/resilience/distributed-tracing.md), which follow one request through every service. A shared [correlation id](../patterns/messaging/correlation-identifier.md) on every call joins them. Monitoring watches dashboards for failures you predicted, and observability covers the ones you did not. Recording is never free, so you sample. Deciding up front to keep a fixed share is cheap, but the request that failed at 3am is mostly not kept. Deciding at the end, keeping only slow or failed traces, finds it.

- **Storage and money.** Sample traces, and cap labels: a metric's series count is the product of its labels' value counts.
- **Tail sampling holds memory.** Size the buffer from request rate times duration, plus spike headroom; route a trace's spans to one sampler.
- **Secrets leak into logs.** Redact fields before writing with a [secure logger](../patterns/security/secure-logger.md); it only catches the fields it is set up to know.
- **Retention differs by record.** Set each type's retention by how long after an incident you still investigate.

**Example.** A service takes 500 requests a second and each trace is 5 KB. Keeping all traces writes 2.5 MB a second, about 216 GB a day. Keeping 1 in 100 up front writes about 2.2 GB a day, but a failing request has a 99% chance of being missing. Assume 2% of requests are slow or failed. Keeping only those, decided after the request ends, writes about 4.3 GB a day (scaling with that share) and keeps the bad ones while the buffer holds and every span of a trace reaches one collector. The cost is memory: at 2 s per request, about 1,000 traces, 5 MB, sit in the buffer at any moment.

## The trade-space
<!--meta block=tradespace-->

Instrumentation costs whether or not you ever need it: CPU to collect, network to ship, storage to retain, and money for every unique combination of label values a metric carries, its cardinality. Logging, tracing and tagging everything costs more than it returns. Cardinality bites metrics first: keep unbounded values such as user id or URL in logs and traces, not metric labels.

Sampling comes in two shapes. **Head-based sampling** decides up front (keep one trace in a hundred, say), which is cheap and predictable, but the request that timed out at 3am has a 99% chance of never being recorded. **Tail-based sampling** decides at the end of the request (keep it only if slow or errored), which finds that request, at the cost of buffering every in-flight trace until its outcome is known and of routing all spans of a trace to one sampler. Count requests and errors before sampling, so dashboards stay true while traces are thinned.

Metrics are pre-aggregated, and cheap only while label cardinality stays capped; one unbounded label can cost more than the traces. Logs are detailed but hard to correlate alone; traces show a request's path across services. Most systems need all three, each with its own retention and sampling budget. The [Metrics & Monitoring](../designs/metrics-monitoring.md) case study works through ingesting and alerting on the metrics side.

```mermaid caption="Every sampling strategy trades storage cost against the risk of missing the one request you needed."
flowchart TB
    P{"Capture every trace, or sample?"}
    P -->|"Keep all"| C["Complete answers, highest storage and cardinality cost"]
    P -->|"Head-based sample"| H["Cheap, but may drop the one request that broke"]
    P -->|"Tail-based sample"| T["Buffer until it ends, keep only errors and slow ones"]
    H -->|"~1% kept"| R["A retention budget bounds the cost either way"]
    T -->|"errors and slow kept"| R
    C -->|"full volume"| R
```

## Patterns that implement the choice
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) {#tour-health-endpoint}

A dedicated endpoint reporting whether a service is alive and whether it's ready for traffic gives load balancers, orchestrators, and on-call engineers a single, cheap signal to poll instead of inferring health from user-facing errors.

### [Correlation Identifier](../patterns/messaging/correlation-identifier.md) {#tour-correlation-identifier}

A single id generated at the edge and propagated through every downstream call turns a scatter of per-service log lines into one traceable story — the thread that makes distributed tracing and cross-service debugging far easier.

### [Wire Tap](../patterns/messaging/wire-tap.md) {#tour-wire-tap}

Copying messages off a channel to an inspection point lets you watch what's actually flowing between services without touching the producer or consumer — observability added at the transport layer, with little effect on the transaction, though a tap adds channel load and copies payloads that need the same redaction as logs.

### [Secure Logger](../patterns/security/secure-logger.md) {#tour-secure-logger}

Logging is only safe to turn up when it can't leak credentials, tokens, or personally identifiable information (PII). A secure logger redacts or masks sensitive fields before they reach disk, so generous logging is safer, though only the fields it is set up to catch are redacted.

### [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) {#tour-circuit-breaker}

Beyond protecting callers from a failing dependency, a circuit breaker's open, closed, or half-open state is itself one of the most useful signals a system exposes — it names exactly which dependency is unhealthy right now, once the state is exported as a metric.

### [Distributed Tracing](../patterns/distributed/resilience/distributed-tracing.md) {#tour-distributed-tracing}

The answer to "which of these six services was slow". Every unit of work becomes a span carrying one shared trace identity and a link to what caused it, so the pieces reassemble into the request's actual path. Metrics say how many were slow; a trace says why this one was, and the two are joined by putting the trace id on the log line.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Signal | Reach for |
| --- | --- | --- |
| A cheap way to know an instance is alive and ready for traffic | Liveness / readiness | [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) |
| To follow one request across every service it touches | Traceability | [Correlation Identifier](../patterns/messaging/correlation-identifier.md) |
| Visibility into message traffic without touching producer or consumer | Passive inspection | [Wire Tap](../patterns/messaging/wire-tap.md) |
| High log volume without leaking secrets | Safe logging | [Secure Logger](../patterns/security/secure-logger.md) |
| An instant read on which dependency is unhealthy right now | Failure signal | [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) |
| To see which hop made one request slow | Latency attribution | [Distributed Tracing](../patterns/distributed/resilience/distributed-tracing.md) |

## Related areas
<!--meta block=siblings-->

- [Resilience](./resilience.md) — Retries, timeouts, and circuit breakers only help if you can see whether they're firing.
- [Performance](./performance.md) — You can't tune what you can't measure — latency histograms and traces are the raw material.
- [Streaming](./streaming.md) — [Message flow](./message-flow.md) between services is invisible by default; the same instrumentation makes a pipeline observable.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Metrics & Monitoring](../designs/metrics-monitoring.md) — Metrics are the cheap, pre-aggregated record; the case study works through ingesting and alerting on them.

<!-- relationships:end -->
