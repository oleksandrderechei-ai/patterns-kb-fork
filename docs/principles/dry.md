---
title: Don't Repeat Yourself (DRY)
description: Every piece of knowledge has one authoritative home in the system
area: principles-craft
owner: Oleksandr Derechei
tags: [low-level-design, maintainability, abstraction, decoupling]
status: stable
aliases: [DRY, Once and Only Once, Single Source of Truth]
solves: [I fixed the same bug in three places because the logic was copy-pasted, changing one business rule means editing five files and I always miss one, two constants encode the same fact and they've drifted out of sync, I keep copy-pasting a block and tweaking one line each time, "the docs, the validation, and the schema each state the rule slightly differently"]
favourite: true
---

# Don't Repeat Yourself (DRY)

Every piece of knowledge — a rule, a formula, a fact about the domain — should have a single, authoritative representation. The enemy is not duplicated text; it is duplicated knowledge that has to be changed in lockstep.

## What it says
<!--meta block=description-->

Every piece of knowledge must have a single, unambiguous, authoritative representation within a system. Coined by Andy Hunt and Dave Thomas in The Pragmatic Programmer, DRY is often misremembered as “never write the same code twice” — but its subject is knowledge, not text. Two lines that happen to look alike are not the target; two places that both encode the same fact are, and each should refer back to one definition.

## Explained
<!--meta block=explain-->

DRY means every fact your system relies on, such as a tax rate, a validation rule or a list of database columns, is written down in one place, and everything else points to it. When a fact lives in two places, the copies agree only until someone edits one, and then the system holds two answers with no test looking at the gap. Apply it to knowledge, not to text: two blocks that look alike but exist for different reasons are not duplication. Choose it over leaving copies alone when the copies must change together. Choose repetition over a shared helper when they change for different reasons, because merging them ties two owners to one change schedule. A computed copy, such as a cache, is fine as long as it is generated and never written by hand.

- **A shared function bends under flags,** so a change for one caller quietly breaks another. A common heuristic: tolerate two copies, unify on the third.
- **A merge couples owners.** Unify only when the shared code has a single reason to change, or the shared helper becomes the wrong abstraction.

**Example.** A shop's checkout holds 20% VAT as 0.2 in a pricing file, and its invoice template hard-codes 0.20. The rate moves to 22%, checkout is updated, and 400 invoices go out with the old rate. One named constant read by both fixes it. The same team then merges two address validators because they look alike: the US form needs a 5-digit ZIP and the UK form a postcode. The merged function takes a country flag and 3 more parameters, and a UK change breaks US signups. Two small validators, each with its own tests, were cheaper: they look alike but change for different reasons.

## Why it helps
<!--meta block=rationale-->

When one fact lives in two places, the two are only correct while they agree. Nothing keeps them agreeing. Change the tax rate in the constant and forget the hard-coded literal elsewhere, and the system now holds two contradictory truths; the defect is not in either copy but in the gap between them, which is exactly where no test is looking.

A single authoritative source removes the gap. There is nowhere for the copies to drift, so a change is correct by construction and there is only one place to look when the rule changes. Over a system's life you usually spend more time changing it than first writing it, and one home per fact is what keeps those changes safe.

## Applying it
<!--meta block=applying-->

Give each fact one home and make everything else point at it:

- Extract shared logic into a named function or module and call it instead of copying it.
- Generate, don't restate: build types, API clients, or config from a single schema instead of hand-maintaining parallel copies. Edit only the schema and mark the output generated. Worth it for many copies or across languages; for two copies, a named constant is cheaper.
- Name the concept. A repeated literal (`MAX_RETRIES = 3`) or a repeated expression usually wants a name that records why it exists. Put the name in one module that both callers import; a constant defined twice is the same breach.
- For data, keep one source of truth and compute the rest. A cached or denormalized (stored twice for speed) copy is fine as long as it is computed, never separately authored.
- In review, flag one change that edits the same literal or rule in more than one file, such as 0.2 in one place and 0.20 in another. That is one fact held twice; give it one named home.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — the VAT rate written twice, then read from one constant"
// Before: checkout and invoice each hold the rate; one edit leaves the other stale.
// pricing.ts
export const total = (net: number) => net * (1 + 0.2);
// invoice.ts
export const vatLine = (net: number) => net * 0.20;

// After: one home for the fact; both files import it.
// vat.ts
export const VAT_RATE = 0.22;
// pricing.ts
export const total = (net: number) => net * (1 + VAT_RATE);
// invoice.ts
export const vatLine = (net: number) => net * VAT_RATE;
```

## Taken too far
<!--meta block=overreach-->

DRY is about knowledge, not coincidence. Two blocks that look identical today but exist for different reasons are not duplication — merging them couples two things that will need to change apart, and the next change for one caller quietly breaks the other. This is the wrong abstraction; as Sandi Metz put it, duplication is far cheaper than the wrong abstraction.

So wait for the knowledge to actually repeat — a common heuristic is to tolerate a thing twice and only unify on the third occurrence — and make sure the shared code answers to a single reason for change. Over-applied, DRY also trades away readability: a maze of tiny helpers and parameters bent to serve every caller can be much harder to follow than a little honest repetition. Test before unifying: if the fact changes, must both places change in the same commit? If not, keep two copies.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Vertical Slice](../patterns/architecture/vertical-slice.md) — The maxim a slice layout relaxes on purpose, and the judgement it hands back to the team
- [Rule of Three](./rule-of-three.md) — The wait avoids merging two things that only look alike
- [Atomic Design](../patterns/frontend/atomic-design.md) — Atomic design applies this to user interface (UI) parts, with a shared name for each tier

**Prevents**

- [Shotgun Surgery](../hazards/shotgun-surgery.md) — Keeps each rule in one place, so a change to it is made once

**Demonstrated by**

- [Connect Four](../designs/connect-four.md) — Replacing four near-identical checker classes with one parameterised loop is don't repeat yourself (DRY) doing real work
- [File System](../designs/file-system.md) — duplication is removed both by a shared base class and by a single path-parsing entry point
- [BookMyShow](../designs/bookmyshow.md) — one source of truth replaces two structures whose disagreement would double-sell a seat

<!-- relationships:end -->
