---
title: Distributed Monolith
description: Separate services that still have to be released together
area: hazards
owner: Oleksandr Derechei
tags: [modularity, boundaries, decoupling, code-smell, maintainability]
status: stable
aliases: [distributed big ball of mud]
solves: [releasing one service means releasing three others the same afternoon, we split the monolith and everything got slower, a schema change in my service breaks two other teams, one page load fans out into forty internal calls, every team has to be in the room before anything can ship]
---

# Distributed Monolith

A system split into separately deployable services that still cannot be deployed separately: it pays every cost of distribution and collects none of the independence the split was meant to buy.

## What it is
<!--meta block=description-->

A distributed monolith is a system split into many services that still have to change and ship together. You recognize it by the release calendar, not the diagram: shipping one service means shipping others the same afternoon. The defining trait is that it pays the full price of distribution and collects none of the independence. It is not a Big Ball of Mud: its diagram is tidy, with the structure drawn in the wrong place.

## Explained
<!--meta block=explain-->

Services split apart, yet change and ship as one. You pay the full price of distribution, which is network delays, partial failures and one pipeline per service, and you collect none of the independence it was meant to buy. It grows when boundaries are drawn before the business is understood, along technical layers, with a shared database schema, shared libraries holding business logic, or chains of synchronous calls. Fix the data first, because two services on one schema are one service whatever the pipelines say: give each a private store and local read copies. Then cut the chains, sending an event where the caller needs no answer and running multi-service steps as a [saga](../patterns/distributed/coordination/saga.md) of local steps with undo actions. Draw new boundaries from the business domain. Track one number: how many services were released together this month.

- **Stale copies.** Local read copies can lag the owner, so design screens and rules to tolerate that.
- **Merging is costly.** Splitting later is routine but merging four services back is a project.

**Example.** An order request calls pricing, stock, billing and shipping in a chain on one shared schema, and all five services release together. Each is up 99.9%, but the chain needs all 5, so it is up 0.999 to the fifth power, about 99.5%: roughly 44 hours of failure a year, not 9. The team gives each service its own store with a local copy of what it reads, and orders publish events that billing and shipping consume. The order request now needs only order, pricing and stock, about 99.7% or 26 hours a year, and a billing change ships alone.

## How it happens
<!--meta block=causes-->

Nobody ships a distributed monolith on purpose. It is what you get when the boundaries are drawn before anyone knows where they belong, and the split then sets them in concrete: a bad boundary inside one process is an unfortunate import, and the same boundary across a network is a contract, a client library and two teams' schedules. Every cause below is a boundary in the wrong place.

The reason it survives review is that each individual decision looks reasonable. Sharing a schema avoids a migration. Extracting a common library removes duplication. Calling a neighbour for the current value is more correct than holding a copy. Each choice is locally right and globally the same choice — to keep the pieces in step with each other.

- **Boundaries along technical layers.** A "data access service", a "validation service" and a "messaging service" can never change alone, because every feature crosses all three.
- **A shared database schema.** Two services reading and writing the same tables are coupled through the data whatever their code does, so a column change has to be scheduled across everyone who touches it. Sharing a database server is fine; sharing a schema is not.
- **Boundaries drawn before the domain is understood.** Split on the org chart ([Conway's law](../principles/conways-law.md)) or on a guess and responsibilities keep migrating between services, with each migration costing a coordinated release.
- **Shared libraries carrying domain logic.** A common library recreates compile-time coupling: a version bump has to land everywhere at once, which is the release train the split was meant to remove.
- **Chatty synchronous calls.** If two pieces talk constantly once separated, the chatter may be a sign they belonged together. Find the pairs in traces or call counts: one request that triggers many calls, or a caller that blocks on the callee.
- **Distributed transactions treated as ordinary calls.** Insisting on all-or-nothing outcomes across services re-couples them at the tightest possible point, and does it inside the request path.
- **Refusing to duplicate any data.** With no local read copies, every service calls the owner for everything — which is sharing state through an API instead of through a table.
- **Contracts changed in place.** Services with no versioning or contract checks must deploy together, because a producer change breaks its consumers at once.

## What it costs
<!--meta block=cost-->

- **Every release is a scheduling problem.** Coordinated deploys across teams are the long release train that the split was supposed to remove, now running with more moving parts and more ways to derail.
- **Latency adds up per hop.** Each call costs network time and serialization, and a chain pays all of it on every request. A page load that fans out to many calls can be slower than the in-process call it replaced, and the slowest dependency sets the tail.
- **Availability multiplies downward.** Assuming independent failures and every hop required, a synchronous chain is up only while every link is up: five services at 99.9% each give about 99.5%, roughly 44 hours of failure a year against 9.
- **Debugging lost its call stack.** A failure now crosses processes and machines, so you buy and operate [Distributed Tracing](../patterns/distributed/resilience/distributed-tracing.md) to recover what a single-process stack trace showed for free.
- **You run N of everything.** N pipelines, N runtimes, N dashboards, N on-call rotations — all of it for one unit of independent change.
- **Coupling grows faster than the service count.** At 99.9% per link a required chain is up about 99.0% at 10 services (roughly 87 hours of failure a year) and about 98.0% at 20 (roughly 174), and each added link is another pair that can force a joint release.

The compounding cost is organizational, and it arrives quietly. The architecture teaches teams they cannot move alone, so they stop trying: work gets batched into large coordinated releases because small ones are not any cheaper, and batching makes each release riskier, which is then used to justify more coordination. By the time somebody proposes redrawing the boundaries, the work competes with the roadmap for the same engineers, and moving functionality back across four existing services is a harder project than the original split ever was.

## Getting out
<!--meta block=mitigation-->

Measure first. Group the deploy log by day, count the distinct services in each group, and keep that as your baseline. Read it per release, alongside how often each service ships. Then work in this order: fix the data, cut the synchronous chains, decouple the contracts, extract at the edges.

Draw boundaries from the domain, not from the deployment. A candidate service should wrap a [Bounded Context](../patterns/ddd/bounded-context.md) (a piece of the business with its own model and vocabulary) and own whole [Aggregates](../patterns/ddd/aggregate.md), so its consistency rules live inside it. Test it with one question: could this ship on a Tuesday while nothing else does? An answer that needs a caveat is a boundary in the wrong place. When in doubt, stay coarse: splitting one service into two later is routine, and pulling functionality back across four is a project. Give each service a private store and a local copy of what it reads, a [Materialized View](../patterns/distributed/coordination/materialized-view.md), instead of calling for it every time.

Then cut the synchronous chains. Where the caller needs no answer, publish an event, so a downstream outage delays the work instead of failing the request. Keep the event atomic with the state change using an [Outbox](../patterns/distributed/coordination/outbox.md). Where a step spans services, run it as a [Saga](../patterns/distributed/coordination/saga.md) with compensating actions, not a distributed transaction. Where two contexts model the same idea differently, put an [Anti-Corruption Layer](../patterns/ddd/acl.md) between them. While boundaries are still wrong, [Contract Testing](../patterns/testing/contract-testing.md) and [API Versioning](../patterns/distributed/routing/api-versioning.md) let services deploy separately.

If you are already inside one, extract at the edges. Take the service with the fewest dependencies, put a facade in front that routes old and new, and move one slice at a time: [Strangler Fig](../patterns/distributed/coordination/strangler-fig.md) applied to a system that is already distributed.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Big Ball of Mud](./big-ball-of-mud.md) — Mud is the absence of structure; this has structure, drawn in the wrong place and now enforced by the network.

**Mitigated by**

- [Bounded Context](../patterns/ddd/bounded-context.md) — Boundaries taken from the domain rather than from technical layers are what stop services having to move together.
- [Anti-Corruption Layer](../patterns/ddd/acl.md) — A translation layer at the seam keeps one team's model change from propagating into everyone else's release.
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — A local read copy removes the synchronous call that made the caller depend on the callee being up.
- [Saga](../patterns/distributed/coordination/saga.md) — Compensating steps replace the distributed transaction whose all-or-nothing semantics coupled the services.
- [Strangler Fig](../patterns/distributed/coordination/strangler-fig.md) — Extracting at the edges first, behind a routing seam, avoids the first slice dragging half the system with it.
- [Contract Testing](../patterns/testing/contract-testing.md) — Verified contracts are what let services deploy separately instead of only together
- [API Versioning](../patterns/distributed/routing/api-versioning.md) — Versioned contracts remove the lockstep release that makes services a monolith
- [Conway's Law](../principles/conways-law.md) — Layer-owned services are Conway's law at work, and the cure starts in the org.
- [Outbox](../patterns/distributed/coordination/outbox.md) — Writing the event and the state change in one local transaction is what lets a service publish instead of call, so the synchronous chain can go.

**Threatens**

- [Microservices](../patterns/architecture/microservices.md) — A split along technical layers with a shared schema keeps the coupling and adds the network

<!-- relationships:end -->
