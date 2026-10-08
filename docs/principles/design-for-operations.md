---
title: Design for Operations
description: "Operators are users of your system, and their needs are requirements"
area: principles-systems
owner: Oleksandr Derechei
tags: [operations, maintainability, lifecycle]
status: stable
aliases: [operability]
solves: [the site is down and nobody can tell what changed, debugging production means adding log lines and redeploying, only the person who wrote it can work out why it broke, rolling back a bad release takes us the rest of the night, we have a hundred dashboards and none of them says what is actually wrong]
---

# Design for Operations

Design the system for the people who will run it, not only for the people who will use it. What it costs to operate — how it is released, configured, watched and diagnosed — is settled while you write it, and is rarely something you can bolt on afterwards.

## What it says
<!--meta block=description-->

The people who run your system are its users, and what they need is a requirement, not a courtesy. A system is operable when someone who has never read its source can answer three questions from its output: is it healthy, what changed, and what do I do. This is wider than telemetry: it covers zero-downtime release, rollback, start-up-checked configuration and two versions serving at once. Each is cheap to build in and expensive to retrofit.

## Explained
<!--meta block=explain-->

Treat the people who run your system as users with requirements. Someone who has never read the source must be able to answer, from its output, three questions: is it healthy, what changed, and what do I do. Zero-downtime release, rollback, start-up-checked configuration and two versions serving at once are decided while you write the code, and cost far more to add after interfaces ship. Choose it over adding monitoring later when you will run the system for years or someone else will.

- **Storage bill.** Unread instrumentation still costs storage, so emit only what someone will act on.
- **Alert fatigue.** Alerts nobody acts on teach the on-call to ignore the channel, so page only on what a user can feel.
- **Stale runbooks.** Nothing compiles a runbook, so attach each to its alert and prefer a script that works or fails visibly.
- **Deep checks.** A health check that tests a shared dependency can pull every instance at once, so keep liveness shallow.

**Example.** A checkout service pages the on-call at 2 am: errors are up. With no request id, tracing one failed order across 6 services means joining logs by timestamp, and takes an hour. With a correlation id stamped at the edge and carried on every hop, one search finds the failure in the tax service in 5 minutes. The health endpoint answered 200 while the connection pool was exhausted, so the team adds a readiness check on the database, and keeps liveness shallow so a database outage cannot pull every instance. The cost is cleanup: nobody acted on 90 of 140 alerts, so they delete those 90 and keep the 50 that match symptoms a user can feel.

## Why it helps
<!--meta block=rationale-->

Most of what a system costs after launch is spent finding out what it is doing. An incident on an opaque service starts with reconstruction — reading code, guessing at state, correlating timestamps by hand — and the repair only begins once that is done. On an instrumented one it starts with a signal naming the failing dependency and a deployment record naming the change. The defect is the same size in both cases; the outage is not.

Operability also decides what you dare to do. A team that can release in minutes and undo in one ships small changes often, so each failure has few suspects and a cheap way back. A team that cannot batches a quarter of work into one release night, where a failure has a hundred suspects and no reverse gear — which is why the change everyone was nervous about keeps getting postponed into the batch that makes it riskier still.

## Applying it
<!--meta block=applying-->

Treat each operational question as a feature with an owner:

- Expose health as something a machine can ask about. A [Health Endpoint](../patterns/distributed/resilience/health-endpoint.md) reports whether the instance can serve. Keep liveness shallow. Make readiness check what this instance needs (dependencies reachable, migrations applied) with a short timeout, and test shared dependencies there only, so their outage does not eject the whole fleet.
- Read configuration from the environment and check it at start-up. A setting that changes with a restart, not a rebuild, is a five-minute fix during an incident, and one that fails loudly at boot catches missing or malformed values before they serve traffic. A valid but wrong value still needs review.
- Stamp every request with an identifier and carry it across every hop. One [Correlation Identifier](../patterns/messaging/correlation-identifier.md) reassembles a single user’s journey out of ten services’ logs; without it, a cross-service diagnosis is a manual join on timestamps that nobody finishes.
- Decide what may be written down before you write it down. A [Secure Logger](../patterns/security/secure-logger.md) that redacts credentials and personal data where the line is emitted keeps your diagnostic trail from becoming the breach you have to disclose.
- Make rollback the cheap path, and let two versions coexist. If a rollout can only go forward, every release is a bet; if old and new can serve together (schema changes additive, messages tolerant of fields they do not know), you stop a bad release in the time it takes to shift traffic, as long as the new version has written nothing the old cannot read. Split a breaking change into expand, migrate, contract, and drop the old path once no old version serves traffic.
- Push the cross-cutting operational machinery out of each service. Running telemetry, credential rotation and traffic policy in a [Sidecar](../patterns/distributed/routing/sidecar.md) beside the process gives every service the same operational surface without every team building its own, and leaves one place to fix when that surface changes. Each sidecar is another process to size, upgrade and watch, and another thing that can fail.
- Give the operator a lever to pull under pressure. [Load Shedding](../patterns/distributed/resilience/load-shedding.md), a switch that disables an expensive feature, a read-only mode: each can turn an outage into a degraded service, if it exists before the night you need it and has been exercised since. Name who may pull it without approval.
- Record what changed. Stamp every signal with the code version and config version, and log each deploy and config change, so the question “what changed” is answered from output.

The test is not whether the information exists somewhere. It is whether a person who did not write the system can find it in the minutes the incident allows.

## Taken too far
<!--meta block=overreach-->

Instrumentation is not free, and unread instrumentation is pure cost. A metric for every line of code buys an ingestion and storage bill that grows with traffic, a query surface nobody can navigate, and dashboards that take longer to scan than the code takes to read. Emit what someone will act on, and delete what has answered no question in a year.

Alerts decay the same way and faster. One that fires on a condition nobody acts on teaches the on-call to ignore the channel, so the page that mattered arrives in a stream already classified as noise — alert on symptoms a user can feel, and leave the rest as a dashboard to consult. A wall of green panels is evidence that the checks you thought of pass, not that the system is well, and the failures that hurt are the ones no panel was built for.

Runbooks rot faster than code, because nothing compiles them. A confident wrong instruction is worse than no instruction: it sends a tired operator down a path that no longer exists, and it keeps its authority right up to the moment it does damage. Keep each runbook short and attached to the alert that fires it, prefer a script that either works or fails visibly to a paragraph that can go stale in silence, and delete any step whose last successful use nobody remembers. The same restraint applies to the principle itself — operational machinery that outweighs the service it watches is a second system to run, and the cure for a [Cascading Failure](../hazards/cascading-failure.md) should not be able to start one.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) — Operators need one place to ask whether the thing is working
- [Correlation Identifier](../patterns/messaging/correlation-identifier.md) — One request crossing ten services must still read as one request
- [Secure Logger](../patterns/security/secure-logger.md) — Logs exist for operators, and they must not leak what they record
- [Sidecar](../patterns/distributed/routing/sidecar.md) — Operational surface can be attached without editing the service
- [Load Shedding](../patterns/distributed/resilience/load-shedding.md) — Give operators a lever that gets pulled before the system falls over
- [Principle of Least Astonishment](./least-astonishment.md) — An operable system is a predictable one at three in the morning
- [Analyse Failure Modes](./failure-mode-analysis.md) — What you decided to detect is what the system has to emit
- [Prefer Managed Services](./managed-services.md) — You still operate what you bought, only at a different layer
- [Resource Organisation](../capabilities/resources.md) — The estate layout is where this principle becomes concrete.
- [Blue-Green Deployment](../patterns/distributed/routing/blue-green-deployment.md) — Shifting traffic back to the old copy is the cheap rollback this principle asks for

<!-- relationships:end -->
