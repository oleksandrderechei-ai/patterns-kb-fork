---
title: Record Architecture Decisions
description: Write down the decision and its reasoning at the moment you make it
area: principles-systems
owner: Oleksandr Derechei
tags: [operations, maintainability]
status: stable
aliases: [ADR, architecture decision record, arc42, C4 model]
solves: [nobody remembers why we chose this database and the person who did has left, we keep re-litigating the same architectural decision every six months, our architecture diagram is beautiful and three years out of date, a new joiner asks why it works this way and the honest answer is that nobody knows, we reversed a decision and then reversed it back because the original reasons were lost]
---

# Record Architecture Decisions

Capture each significant decision as a short dated record — the context that forced it, the options considered, what was chosen, and what that costs — written when the decision is made rather than reconstructed afterwards.

## What it says
<!--meta block=description-->

Document decisions, not designs. A design document describes the system as it is today and is wrong once the system changes. A decision record states what forced a choice, what else was considered, what was picked and what it costs, and stays true because the past does not change. Keep each record short, dated, numbered and immutable, in the repository beside the code, and supersede it with a new record, never an edit.

## Explained
<!--meta block=explain-->

Architecture documentation means you record decisions, not designs. A design document describes what the system looks like and is wrong as soon as the system changes. A decision record says what forced a choice, what else was on the table, what was picked and what it costs, and it stays true because the past does not change. Each record is short, dated, numbered and never edited: to reverse one, write a new record that links to it. Keep the records in the repository and review them in the same pull request as the change. Choose records over a wiki of descriptions when a choice is expensive to reverse, such as a datastore, a service boundary or an auth model, and skip them for a linter.

- **Volume buries the records that matter.** Two hundred records hide the ten that count, so use reversal cost as the bar for writing one.
- **A record demanded before work starts becomes a gate.** People write it to pass review, so write it as the decision is taken.
- **Descriptive diagrams still rot.** Keep that layer thin, generate what you can, and delete a diagram rather than keep a wrong one.

**Example.** A team chooses DynamoDB over Postgres for its orders store. The record is one page: context (50,000 writes a second at peak, from a load test), options (Postgres with sharding, DynamoDB), decision, and consequences, including that ad hoc joins will not work and reporting needs a copy in a warehouse. Two years later a new engineer proposes Postgres, and the record shows it was considered and why it lost. When the write peak drops to 2,000 a second, the team writes record 31 superseding it, and record 12 changes only its status line. They wrote 14 records in a year, not 200.

## Why it helps
<!--meta block=rationale-->

A decision whose reasoning is lost cannot be revisited safely. Someone will eventually look at the choice, fail to see a reason for it, and either change it, rediscovering the original constraint through an outage — or leave it alone out of superstition. Both outcomes come from the same missing sentence, and the sentence was cheap when the decision was fresh and is often unrecoverable later.

It also changes the decision itself. Writing down the options and the cost forces the cost to be named while you can still choose differently, which is the point at which naming it is useful. A choice nobody can articulate a downside for has usually not been compared to anything.

A numbered series of records is a readable history of how the system came to be, so a new joiner learns the constraints in an afternoon rather than by breaking things, and an argument that has already been had can be closed by reference rather than re-run. Teams without one re-litigate the same few decisions, because there is no way to distinguish a settled question from an unexamined one.

## Applying it
<!--meta block=applying-->

Keep the habit cheap enough to survive a busy week:

- One page, four headings — context, options, decision, consequences. If it needs more, the decision has more than one decision in it. In context, give the measured figure, its source (a load test, an incident) and the date.
- Store records in the repository, numbered and dated, and review them in the pull request that makes the change.
- Write consequences honestly, including the ones you dislike. A record with no costs is marketing and will not be trusted by the person who finds it.
- Never edit the body of a record to reflect a change of mind. Write a new one that links to the old, and set the old record's status line to superseded by the new number. That status line is the one permitted change.
- Record decisions you rejected and why, since the next person will otherwise propose them again.
- Set the bar at "expensive to reverse". Choosing a datastore, a boundary, an auth model or a messaging style qualifies; choosing a linter does not.
- Name files NNNN-short-title.md in one folder, such as docs/decisions/. Give each a status line (proposed, accepted, or superseded by NNNN) and the condition that would reopen it.
- Test for a record in review: would undoing this change another team's code or data, or need a migration? If yes, write one.

## Taken too far
<!--meta block=overreach-->

The usual failure is volume. Once a team decides records are good, everything becomes one — library choices, naming conventions, a refactor someone wanted noticed — and a corpus of two hundred records is unsearchable, so the ten that matter are lost among them. The bar is reversal cost, so most decisions get no record.

The second failure is turning it into a gate. A record required before work can start makes it an approval step, and approval steps get written to pass rather than to inform, the reasoning becomes justification, and the honest downsides disappear from the consequences section.

The third is forgetting which documents are allowed to decay. Decision records are immutable and cost little to keep, though superseded ones add to the volume the bar must hold down; descriptive documents and diagrams describe a moving target and cost real effort to hold true. Treating both as equally permanent leaves a documentation set nobody trusts, because a reader who finds one stale diagram stops believing the accurate records next to it. Keep the descriptive layer deliberately thin, generate what you can from the system itself, and delete a diagram rather than keep a wrong one.

The fourth failure is records nobody can find. Keep one index, and link each record from the code or config it constrains.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Design for Evolution](./design-for-evolution.md) — A recorded decision is what makes a later reversal a change rather than an excavation
- [Build for the Needs of the Business](./build-for-business.md) — The context section is where the business constraint that forced a technical choice gets written down

**Prevents**

- [Boat Anchor](../hazards/boat-anchor.md) — A dated record of why something was kept makes it possible to tell a live constraint from a dead one
- [Lava Flow](../hazards/lava-flow.md) — A dated record of why code was kept lets a reader tell live code from dead.

<!-- relationships:end -->
