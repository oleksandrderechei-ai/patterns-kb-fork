---
title: Observability Platform
description: "Logs, metrics and traces as managed services, and what each cloud charges for them"
area: capabilities
owner: Oleksandr Derechei
tags: [observability, cloud]
status: stable
aliases: [monitoring, logging, APM, telemetry]
solves: [our logging bill is bigger than the compute that produces the logs, we have three consoles and no way to correlate an incident across them, I need to know which customer was affected and the metric cannot tell me, nobody can say how long we keep logs or why that number was chosen, moving clouds means rewriting every dashboard and alert we have]
---

# Observability Platform

The managed side of knowing what your system is doing: somewhere to send logs, metrics and traces, something that queries them, something that alerts on them — and a bill that is driven by how much telemetry you emit rather than by how much traffic you serve.

## What it is
<!--meta block=description-->

Every cloud sells three stores and two readers. A log store searches events, a metric store aggregates numbers over time, and a trace store shows one request's whole path. Dashboards and alert rules read them, and an agent in your workloads feeds them. You are billed by volume ingested and kept, so the bill tracks how chatty your code is. The collection layer is the portable part; the stores are what you rent.
## Explained
<!--meta block=explain-->

An observability platform stores three kinds of evidence about your running system and reads them back: logs (searchable events), metrics (numbers over time) and traces (one request's path through your services), with dashboards and alerts on top. Take the provider's own stack by default and move off it only when the bill or a second cloud forces you. The bill tracks how much your code emits, not how many users you have, so you pay for volume ingested, volume kept and often each query. When you leave, move one store at a time: metrics first, because the data is small, and logs last, because a searchable log store at volume is hard to run.

- **Dashboards and queries do not port** Instrument to an open standard and send via your own collector, so a backend change is a pipeline edit.
- **Retention is priced by the longest requirement** Set it per signal, not once for everything.
- **Spans dropped after collection are already paid for** Sample at the start of a request and keep every error trace.

**Example.** Your service takes 500 requests a second, and a debug line of 1 KB is logged on each. That is 500 KB a second, or 43.2 GB a day. At an illustrative 0.50 dollars per GB ingested, one forgotten line costs 21.60 dollars a day, about 650 a month, and no user notices. Sampling at the start of each request and keeping 10 percent cuts it to 2.16 dollars a day. The cost is that you see 1 request in 10, so you also keep every request that ends in an error.

## The capabilities
<!--meta block=capabilities-->

- **Log aggregation and search** — A store that accepts arbitrary events from every workload and lets you search across all of them at once. It is the only one of the three stores that can answer a question you did not anticipate, which is what makes it both the most useful during an incident and the most expensive to keep.
- **Time-series metric store** — Numeric series identified by name and a set of labels, aggregated on write so a year of data stays small. Cheap to keep and cheap to query over long windows, and structurally unable to tell you which request or which customer — every label you add to fix that multiplies the number of series you are storing.
- **Distributed trace collection** — Spans from each service, joined by a propagated id into one tree per request, so latency is attributable to a hop rather than to a system. Almost always sampled: keeping every span costs more than the traffic it describes, and the sampling decision is normally made at the start of the request so a trace is whole or absent rather than partial.
- **Alert rules and routing** — A rule evaluated continuously against one of the stores, and the delivery path that turns a firing rule into a page, a ticket or a message. The routing half is the part teams under-build: a rule with no owner and no escalation is a rule that fires into a channel nobody reads.
- **Dashboards** — Saved queries arranged for a person to read under pressure. Their value is almost entirely in being built before the incident, because a dashboard authored during one is a query you could have run faster by hand.
- **Telemetry collection agent** — The process that gathers telemetry from workloads and forwards it to the stores, usually with batching, retry, redaction and sampling on the way through. This is the layer where cost is controlled, because it is the last place you can drop or aggregate something before you start paying to store it.
- **Synthetic checks** — A probe run from outside your system on a schedule, exercising a URL or a whole scripted journey. It is the only signal that keeps arriving when the system is down hard enough to stop reporting on itself, and the only one that covers a path no real user happened to take in the last five minutes.
- **Long-term retention and archive** — A cheaper tier for telemetry you must keep but rarely read — usually with slower or more limited query, and often with a per-scan charge instead of a per-gigabyte-month one. This is what separates an audit requirement from an operations budget, and keeping the two in the hot tier together is the most common overspend on this bill.
- **Metrics computed from logs** — A rule that extracts a counter or a distribution out of matching log lines, so a number you can alert on cheaply is produced from events you may not keep. Worth reaching for exactly when a metric is missing from an application you cannot change.
- **Fault injection experiments** — A managed service that slows, fails or kills a dependency on a schedule you set, with a stop condition tied to an alarm. Run it against a system you have already watched, or you learn nothing from the result.

## What each cloud calls it
<!--meta block=mapping-->

| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Log aggregation and search | Amazon CloudWatch Logs | Azure Monitor Logs (Log Analytics) | Cloud Logging | OpenSearch, Grafana Loki |
| Time-series metric store | CloudWatch metrics; Amazon Managed Service for Prometheus | Azure Monitor Metrics | Cloud Monitoring | Prometheus, VictoriaMetrics |
| Distributed trace collection | AWS X-Ray | Application Insights | Cloud Trace | Jaeger, Grafana Tempo |
| Alert rules and routing | CloudWatch alarms | Azure Monitor alerts | Cloud Monitoring alerting policies | Prometheus Alertmanager |
| Dashboards | CloudWatch dashboards; Amazon Managed Grafana | Azure Monitor workbooks and dashboards | Cloud Monitoring dashboards | Grafana |
| Telemetry collection agent | CloudWatch agent; AWS Distro for OpenTelemetry | Azure Monitor Agent | Ops Agent | OpenTelemetry Collector, Fluent Bit, Vector |
| Synthetic checks | CloudWatch Synthetics | Application Insights standard availability tests | Cloud Monitoring uptime checks | Prometheus Blackbox Exporter |
| Log archive to object storage | CloudWatch Logs export to Amazon S3 | Azure Monitor Logs export to Storage | Cloud Logging sink to Cloud Storage | object storage plus a columnar file format |
| Metrics computed from logs | CloudWatch metric filters | Azure Monitor log alert rules | Cloud Logging log-based metrics | Grafana Loki recording rules |
| Fault injection experiments | AWS Fault Injection Service | Azure Chaos Studio | Fault Injection Testing (Preview) | Chaos Mesh, LitmusChaos |

## Choosing
<!--meta block=choosing-->

Start with the provider's own stack, and be honest that this is a default rather than a comparison. Managed logs, metrics and alerts arrive already wired to the platform's own resources, with identity and access handled and nothing to run — and for most systems that is where it should stop. The reason to look further is almost never a missing feature.

The reason is usually one of two. Either **the bill has become the problem**, at which point a self-hosted metric store or a log store you operate can be an order of magnitude cheaper per gigabyte and you are trading money for an on-call rotation. Or **your workloads are not all in one place**, in which case a single backend you run beats three provider consoles nobody correlates across, and the first-party option was never really on the table.

Split the decision by store rather than taking a stack whole, because the three have different economics. Metrics are the usual first thing to move: the data is small, the query engine is mature, and the saving is large. Logs are the usual last thing to move, because operating a searchable log store at volume is genuinely hard and the failure mode is losing the thing you needed during the incident. Traces sit between the two and are frequently the easiest to run yourself, since sampling has already reduced the volume to something a single node handles.

Whatever you choose, **instrument against a vendor-neutral standard and collect through a collector you control**. It costs nothing at the start and it is the difference between changing a backend by editing a pipeline and changing it by editing every service. It also makes the honest version of a migration possible: run both backends in parallel for a month, compare what each one says, and cut over when the dashboards agree.

Two decisions people leave until the bill arrives, and should make on day one. Set retention per signal rather than globally — debug logs for days, request logs for weeks, the handful of metrics behind your service objectives for years — because one global retention setting is priced by the longest requirement anyone has. And decide sampling at the head rather than dropping at the tail: a request sampled out at the start costs nothing to carry, while spans dropped after collection have already been paid for. The exception worth building is tail-based sampling for errors, so the traces you actually want are the ones you keep.

## What does not port
<!--meta block=portability-->

- **The query languages are unrelated**: each provider's log query language is its own, and none of them is a dialect of another. Every saved query, every dashboard panel and every log-based alert rule is rewritten by hand, and that corpus is usually larger than anyone remembers until they count it.
- **Nothing moves with you**: history stays in the store that has it. Plan a period of running both, because the alternative is losing your year-on-year comparison at the moment you most want to prove the migration did no harm.
- **Alert semantics differ in the details that page people**: how long a condition must hold, what happens to a rule when data stops arriving, and whether an alert auto-resolves are all different defaults. Ported rules tend to fire more or fewer times than they used to, and the direction is not predictable from the rule text.
- **Platform metrics are not the same metrics**: each provider emits its own set for its own services, at its own resolution and dimensions. Dashboards built on managed-service metrics do not have equivalents to port to, so the infrastructure half of your monitoring is rebuilt rather than translated — only the parts your own code emits carry over.
- **The unit of billing moves**: ingestion, retention, query scan and alert evaluation are priced differently on each provider, so the same telemetry costs a different amount, and a different shape of telemetry is the expensive one. Re-run the estimate against the target's own price list instead of scaling the current bill.
- **Trace context propagation has to agree end to end**: a service emitting one header format into a system expecting another produces broken traces rather than an error, and the symptom is a trace that stops at a boundary rather than an alarm. Standardise the propagation format before the migration, not during it.
- **Redaction is a per-pipeline decision that does not follow the data**: the rules stripping credentials and personal data out of telemetry live in the agent or the ingestion pipeline, so a new pipeline starts with none of them. Port those rules first, before the first byte flows, because the failure mode is a compliance incident you discover by searching for it.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Requires**

- [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) — Uptime checks and alerting need an endpoint that answers honestly; the platform polls, it does not provide

**Implements**

- [Distributed Tracing](../patterns/distributed/resilience/distributed-tracing.md) — Managed trace collection is this pattern rented: the collector, the store and the waterfall view
- [Secure Logger](../patterns/security/secure-logger.md) — Redaction rules in the collection pipeline apply this before telemetry reaches any store
- [Fault Injection](../patterns/distributed/resilience/fault-injection.md) — Managed chaos services run the experiment and halt it when your alarm fires.
- [Correlation Identifier](../patterns/messaging/correlation-identifier.md) — Trace context is a correlation identifier the platform propagates and indexes for you.
- [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) — Synthetic checks probe the endpoint your service exposes, from outside it.

<!-- relationships:end -->
