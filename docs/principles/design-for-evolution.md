---
title: Design for Evolution
description: "Expect every part to change, and keep each change local"
area: principles-systems
owner: Oleksandr Derechei
tags: [modularity, extensibility, decoupling, maintainability]
status: stable
aliases: [evolutionary architecture]
solves: [a one-line change means coordinating a release across four teams, we cannot deploy anything without deploying everything at the same time, adding a field to one message broke three consumers nobody knew about, the same business rule is copy-pasted into six services and they have drifted apart, everyone agrees the system needs replacing but nobody can find a first step]
---

# Design for Evolution

Every system that stays in service outlives the design it launched with, so build it so that one team can change one part without a negotiation across the rest. The useful question is never whether the system will change — it is whether a change stays local or spreads.

## What it says
<!--meta block=description-->

Assume the system will be asked to do something it was not built to do, and arrange it so that answering costs one team one change to one part. At class level this is [Open/Closed](./open-closed.md); at system scale the difference is enforcement, because a published endpoint or message has consumers you cannot enumerate or recompile. The tools are deployment units and wire contracts. It is no licence to pre-build futures: change should be cheap when it comes.

## Explained
<!--meta block=explain-->

Design for evolution means you arrange the system so that the changes you expect cost one team one change to one part, without paying for flexibility in advance. At class level this is the open-closed idea. At system scale the difference is enforcement: a compiler finds every caller of a changed method, but a published endpoint or message has consumers you cannot list or recompile. So the tools are deployment units and wire contracts. Change a contract by adding, never by removing or redefining, and make readers skip what they do not recognise. Give each business capability one owner and one boundary, and translate a neighbour's model at the edge so one file changes when their schema moves. Choose replacing in slices over a rewrite, because the system stays shippable on every day of the migration.

- **Flexibility nobody used is paid in full.** Open only the axes you have watched vary, and leave the rest closed.
- **Indirection is paid on every read.** Avoid it where a change comes once a year, because the next reader pays for it daily.
- **A second API version never retired doubles the surface.** Set its end date the day you publish it.

**Example.** A shipping service publishes an order event with the address as one text field. Marketing wants a country code. The team adds an optional country field and leaves address as it was. Four of the 5 consumers ignore fields they do not know, so they change nothing and nobody redeploys in lockstep. Billing, the fifth, reads the address text in 40 places, so a translation layer at its edge means a later schema change touches one file. The test passes: one team, one deployment. The cost is that layer: one more file billing's team must keep current.

## Why it helps
<!--meta block=rationale-->

What a change costs is set by how many parties have to agree to it. Where one service ships on its own, a fix is a deploy; where two must ship together, the same fix becomes a scheduling problem across two backlogs and goes out at the pace of the slower team. Two components that cannot be released separately are one component with a network in the middle, and you are paying the latency, the partial failures and the serialization of a distributed system without buying the independence they are supposed to fund.

Locality of knowledge (each rule kept in one place) is the other half of the bill. When one business rule lives behind one boundary, changing it touches one deployable unit; when six services each keep their own copy, changing it means six coordinated edits and a window in which they disagree. Customers see that as two different prices for the same thing. A stable contract is what holds that boundary: consumers depend on what the boundary promises rather than on how the code behind it works this quarter, so the inside can be rewritten without a single consumer noticing. Lose that and changes stop having edges, which is the road to a [Big Ball of Mud](../hazards/big-ball-of-mud.md).

## Applying it
<!--meta block=applying-->

Keep the unit of change small enough that one team owns all of it:

- Release each service on its own, or admit it is not a separate service. If two units must always go out together, merge them and stop paying for the hop. A short, dated lockstep during a migration is not evidence.
- Change a published contract by adding, never by removing or redefining: a new optional field, a new message type, the old shape still answering. Then make your own readers skip what they do not recognise, so a producer can add a field without a coordinated release. Both halves of [Postel's Law](./postels-law.md) are what buy that freedom.
- Give each business capability one owner and one boundary, drawn on the domain rather than on a technical layer. A rule then changes inside one [Bounded Context](../patterns/ddd/bounded-context.md) instead of in the six services that each held a copy of it.
- Keep the rules independent of what carries them. With the database, the queue and the HTTP framework behind ports your own code defines — the arrangement [Hexagonal Architecture](../patterns/architecture/hexagonal.md) describes — swapping one of them is an adapter rewrite rather than a domain rewrite.
- Translate at the edge instead of letting a neighbour's model spread inward. An [Anti-Corruption Layer](../patterns/ddd/acl.md) on a synchronous boundary, or a [Message Translator](../patterns/messaging/message-translator.md) on a queue, means one file changes when their schema moves — not every call site that had learned their field names.
- When an additive change is impossible, run both versions and set the old one's retirement date the day you publish the new one. Log calls per version and consumer, and move the date only on that evidence. [API Versioning](../patterns/distributed/routing/api-versioning.md) with no sunset is a second system that every later change must also cross.
- Replace rather than rewrite. Route through a façade, move one capability at a time behind it, and delete what it displaced — a [Strangler Fig](../patterns/distributed/coordination/strangler-fig.md) keeps the system shippable on every day of the migration, where a rewrite is only shippable on the last one.
- Check additivity in CI: diff the published schema against the last release and fail on a removed or redefined field. Drop a field only once logs show no consumer reads it.

The test is not how clean the boundaries look on a diagram. Take any change you expect this year and name the one team that would make it and the one thing they would deploy; where you cannot, you have found the boundary that is not doing its job.

## Taken too far
<!--meta block=overreach-->

The common failure is flexibility nobody used. A plugin system with one plugin, a configuration surface with one setting, an abstraction over the single database you will ever run — each was paid for in full on the day it was written and each returns nothing, which is exactly the trade [You Aren't Gonna Need It (YAGNI)](./yagni.md) refuses. Extensibility is only cheap along an axis you have already watched vary; along the others it is a guess with a maintenance bill attached.

Indirection charges asymmetrically: it is paid for on every read, not once. What used to be a function call becomes an interface, a factory, a registry entry and a runtime lookup, so everyone tracing a defect through it pays — while the change it was meant to make cheap arrives once a year, if it arrives. Versioned contracts run the same way. Publish a second version without retiring the first and you have not made the system easier to change; you have doubled the surface every later change has to cross, and it stays, because proving the old version unused takes usage data few teams collect.

The expensive version of this mistake is buying decoupling with asynchrony. Put a broker between two services and neither has to be up when the other is — but a request that was one stack trace becomes a correlation id chased across four logs, and the ordering a function call gave you for free is now yours to reason about. [Event-Driven Architecture](../patterns/architecture/eda.md) earns that bill where producers genuinely must not know their consumers and the work can complete later. It does not earn it between two services that are always deployed together and always need an answer before they can reply, where the honest move is to leave the call synchronous and go find the boundary that would have done more work.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Strangler Fig](../patterns/distributed/coordination/strangler-fig.md) — Replace a system incrementally instead of rewriting it in one jump
- [Bounded Context](../patterns/ddd/bounded-context.md) — A change to one rule should touch one boundary, not seven
- [Anti-Corruption Layer](../patterns/ddd/acl.md) — Translate at the seam so a neighbour's model cannot leak inward
- [Hexagonal](../patterns/architecture/hexagonal.md) — Swap an adapter without touching the domain it serves
- [Event-Driven Architecture](../patterns/architecture/eda.md) — Add a consumer without asking the producer's permission
- [Postel's Law](./postels-law.md) — Tolerate unknown fields and a wire contract can grow additively
- [Record Architecture Decisions](./architecture-documentation.md) — Evolving a system safely needs to know why it is shaped this way
- [Conway's Law](./conways-law.md) — Team structure sets the price of changing each boundary.
- [Rule of Three](./rule-of-three.md) — Structure that changes with real use is better than abstractions fixed in advance
- [API Versioning](../patterns/distributed/routing/api-versioning.md) — Where an additive change is impossible, run both versions and date the old one's retirement the day you publish the new
- [Message Translator](../patterns/messaging/message-translator.md) — On a queue, translate a neighbour's message at the edge so one file changes when their schema moves

**Generalizes**

- [Open/Closed Principle](./open-closed.md) — The same rule at system scale: extend by adding, not by editing what already ships

**Prevents**

- [Big Ball of Mud](../hazards/big-ball-of-mud.md) — Boundaries maintained deliberately are what stop everything touching everything

<!-- relationships:end -->
