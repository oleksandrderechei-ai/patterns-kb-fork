---
title: Event Storming
description: "Discovering the domain by putting every business event on a wall, in order, with the people who know"
area: themes-starting
owner: Oleksandr Derechei
tags: [domain-modeling, boundaries]
status: stable
---

# Event Storming

A workshop that puts everyone who knows something about the domain in one room and asks them to write down what happens, in the past tense, on a timeline — and then reads the structure of the system off the wall they built.

## The question
<!--meta block=description-->

Most patterns in the domain-driven band assume you already know where the boundaries are, and event storming is how you find them. Everyone who knows part of the domain writes past-tense events on sticky notes along a wall, then adds commands, actors, policies (whenever this, then that) and aggregates in passes, leaving hot spots unresolved. The output is a shared vocabulary rather than a document, run at three scales: big picture, process, design-level.

## Explained
<!--meta block=explain-->

Event storming is a workshop where everyone who knows part of a business writes what happens, one fact per sticky note in the past tense, such as order placed, and arranges the notes on a wall by time. You run it to find where one part of the business ends and another begins, and to agree on the words people use, before anyone designs code. A word that changes meaning along the wall often marks a boundary. A disagreement about the order of two notes often shows a misunderstanding that would become a bug. After the events, add commands, actors, policies and aggregates in passes. Pick the scale by what is unclear. Run a big-picture session of the whole business, usually once, when two teams use the same word differently. Run a process session on one flow when the steps are unclear. Run a short design-level session on a single [aggregate](../patterns/ddd/aggregate.md), a group of data that must change together, when one team cannot decide what a transaction covers. Write unresolved arguments on a hot-spot note and move on.

- **Expensive day.** It costs a day of many people, so invite only those whose knowledge the wall needs.
- **Absent people.** Shared understanding does not reach anyone absent, so choose attendees by the knowledge the wall needs and brief affected others afterwards.
- **Open hot spots.** Hot-spot arguments usually need data or someone not in the room, so assign each an owner before you leave.

**Example.** A retailer finds sales and the warehouse both say order, so it runs a big-picture session. Eight people spend a day, 64 person-hours, and write about 120 notes. On the wall, order means what the customer asked for in sales, and a picking list in the warehouse, so they become two separate parts of the system. A question about refunds on a half-shipped order needs finance, so it goes on a hot-spot note, one of 3 left open. Resolving it in the room would likely have produced a confident wrong answer. A later one-hour session covers just the picking list.

## The trade-space
<!--meta block=tradespace-->

The cost is the room. A big-picture session needs a day from people whose time is expensive and who do not normally sit together, and the output is not a specification. It is a wall of notes plus the understanding the people in the room now share. That understanding does not transfer to anyone who was absent, which is why a photograph of the wall is nearly worthless to a newcomer.

The other trade is when to stop. Every session reaches a point where the remaining disagreements are hard, and there are two ways to spend the next hour: resolve them, or write them on a hot-spot note and move on. Resolving them in the room is tempting and usually wrong. The questions that survive an event storm need data, a customer, or a decision from someone not present, so forcing an answer produces a confident wrong model rather than a known gap.

Scale is the third axis, and picking wrong wastes the most. A big-picture session over a domain nobody disputes produces a wall everybody nods at and no information. A design-level session before the boundaries are agreed produces a detailed model of the wrong aggregate. The signal for the coarse version is that two teams use the same word differently; the signal for the fine version is that one team cannot decide what a single transaction covers. The signal for the process-level version is that the steps of one flow are unclear.

```mermaid caption="Running the wrong scale is the usual way a session wastes a day."
flowchart TB
    Q{"What is actually unclear?"}
    Q -->|"Two teams use the same word differently"| BIG["Big picture — whole domain, one day, find the boundaries"]
    Q -->|"One flow crosses systems and nobody owns it end to end"| PROC["Process modelling — one flow, commands and policies"]
    Q -->|"We cannot agree what one transaction covers"| DESIGN["Design level — one aggregate, at the whiteboard, an hour"]
    BIG --> OUT["Boundaries, language, and a list of hot spots"]
    PROC --> OUT
    DESIGN --> OUT
```

## What the wall turns into
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Domain Event](../patterns/ddd/domain-event.md) {#tour-domain-event}

A domain event is the orange note. A past-tense statement of something the business considers to have happened is what the workshop asks people to write, so the technique produces domain events rather than requirements. The names usually survive into the code.

### [Aggregate](../patterns/ddd/aggregate.md) {#tour-aggregate}

Aggregates are added in a late pass: a group of data that must change together, guarded by the same rule, accepting the same commands. Adding them late rather than early is deliberate, because a boundary proposed before the events are on the wall is a guess.

### [Bounded Context](../patterns/ddd/bounded-context.md) {#tour-bounded-context}

The clearest signal on a wall is a word that changes meaning partway along it: an "order" in fulfilment is not the "order" in billing. That point often marks a context boundary, one that up-front modelling alone rarely shows.

### [Anti-Corruption Layer](../patterns/ddd/acl.md) {#tour-acl}

Once the boundary is on the wall, the notes crossing it are the integration, and the ones arriving from a system you do not control are where a translation layer earns its keep. The workshop names the traffic; this pattern is what you build for it.

### [Event Sourcing](../patterns/architecture/event-sourcing.md) {#tour-event-sourcing}

A session that produces a good event model makes this look inevitable, but that is a trap: discovering the domain in events does not oblige you to store it in events. The technique is a modelling tool, and the storage decision is separate and costlier.

### [CQRS](../patterns/architecture/cqrs.md) {#tour-cqrs}

The questions people ask during a session — "how would you know that?", "where do you look that up?" — are read models. They rarely line up with the aggregates beside them, which is the observation that makes separating the two sides worth considering. A read model is a view built to answer one question; the aggregate is the side that accepts changes.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Signal | Reach for |
| --- | --- | --- |
| A shared vocabulary before anyone writes a line of code | Same word, two meanings | A big-picture session with domain experts present |
| To name what happened in a way the business recognises | Past-tense facts | [Domain Event](../patterns/ddd/domain-event.md) |
| To decide what one transaction is allowed to cover | Consistency boundary | [Aggregate](../patterns/ddd/aggregate.md) |
| To split a system between teams along a real seam | Language changes | [Bounded Context](../patterns/ddd/bounded-context.md) |
| To integrate with a system whose model you dislike | Foreign vocabulary | [Anti-Corruption Layer](../patterns/ddd/acl.md) |
| To turn the timeline into an implementation design | Events agreed, design next | [Event Modeling](./event-modeling.md) |
| To keep or replay every past state | History is a requirement | [Event Sourcing](../patterns/architecture/event-sourcing.md) |
| To answer the questions the wall raised in one read | Read differs from write | [CQRS](../patterns/architecture/cqrs.md) |
| To pick the finer session | Steps unclear, or one transaction undecided | A process-level or design-level session on that flow or aggregate |

## Related areas
<!--meta block=siblings-->

- [Event Modeling](./event-modeling.md) — The sequel: once the events are agreed, this lays them out as a buildable design.
- [Service Boundaries](./service-boundaries.md) — The wall shows you where the seams are; this is what to do once you can see them.
- [Multi-Step Processes](./multi-step-processes.md) — The policies discovered on the wall — whenever this, then that — are what these patterns implement.
