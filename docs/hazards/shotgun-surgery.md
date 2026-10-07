---
title: Shotgun Surgery
description: "One small change needs many small edits in many places, and a missed one breaks the system"
area: hazards
owner: Oleksandr Derechei
tags: [anti-pattern, code-smell, maintainability]
status: stable
solves: [adding one field means editing fifteen files and I keep missing one, a tiny feature change touches a few lines in dozens of classes, after every change a bug appears in a place I forgot to update, I need a checklist to remember every place a rule is written]
---

# Shotgun Surgery

One small change forces you to edit many files in many places, and missing one leaves the system quietly wrong.

## What it is
<!--meta block=description-->

**Shotgun surgery** is a code smell where one logical change, such as adding a field or a payment type, needs small edits scattered across many classes. It grows when one responsibility is spread thin instead of living in one place. You recognise it in review: a pull request touches 15 files with a few lines each, and the author needed a text search to find them all. The trait is scatter, not size.

## Explained
<!--meta block=explain-->

Shotgun surgery is when one logical change, such as adding a payment type or a field, forces small edits in many files. It happens because one responsibility is spread across the code instead of living in one module, often as copied rules or one \`if\` branch per variant in every function. Gather the responsibility into one owner rather than adding a checklist. A checklist only manages the scatter; a single owner removes it. Pick the cut from version history: files that changed together in past commits belong in one module. The cost is that the move edits the same scattered files, so do it one copy at a time and delete the old copy in the same commit.

**Example.** Adding a new order status, SHIPPED_LATE, touches 14 files: two enums, three switch statements, a mapper, a dashboard filter, an email template and 6 tests. A developer finds 13 by searching and misses the dashboard filter, so late orders vanish from it for 9 days. The team then moves the status rules into one OrderStatus module that owns labels, transitions and filters, one status at a time with tests. The next status touches 2 files. The move cost 3 days.

## How it happens
<!--meta block=causes-->

```mermaid caption="The loop: each new variant is added where the last one was, so the scatter grows with every change."
flowchart TB
    A["One rule or concept is needed in many places"] -->|"copy the handling to each place"| B["The concept lives in N files"]
    B -->|"a change must touch all N"| C["Edits are missed or applied differently"]
    C -->|"bug fixed by one more local patch"| B
    B -->|"next variant added"| A
```

- **Duplicated knowledge.** The same rule, such as a status list or a tax calculation, is written out in several modules, so a change to the rule is a change to every copy.
- **Responsibility cut by layer, not by reason to change.** A feature needs a controller, a service, a mapper and a validator edited together, because the cut follows technical tiers instead of the concept (the [single-responsibility](../principles/single-responsibility.md) idea).
- **Missing abstraction for a varying concept.** Each new payment type or document format adds an `if` branch in every function that handles it, instead of one new class.
- **Over-eager splitting.** One idea cut into a dozen tiny classes leaves its change spread across all of them.
- **Weak module boundaries.** Nothing stops a feature's logic from leaking into shared utilities, so the shared code grows a case for every client.

## What it costs
<!--meta block=cost-->

- **Missed edits become production bugs.** A change that reaches 11 of 12 places passes the tests that cover the 11 and fails on the twelfth path.
- **Every change costs more than it looks.** A one-line feature turns into a day of search, edit and re-test, and estimates stop matching the visible size of the work.
- **Reviews get shallow.** Reviewers cannot hold 15 small diffs in mind, so they check each hunk and miss the one that is absent.
- **Merge conflicts spread out.** Many small edits in many files collide with every other branch that touches the same concept.
- **Developers avoid the change.** The scatter makes the area feel risky, so people patch around it instead of fixing it, and the scatter gets worse.

## Getting out
<!--meta block=mitigation-->

Bring the scattered responsibility back into one place before you make the next change. Use your version history to find it: the files that changed together in recent commits for this concept (`git log --name-only` on the concept's path lists them; start with ten and widen until the set stops growing) are the pieces to gather. Move the logic, with its tests, into one module that owns the rule, and make the other files call it.

Do it in small steps that keep the system working. Move one copy at a time, run the tests, and delete the old copy in the same commit, so the old and new versions never both live. Where a concept varies, such as payment types, replace the repeated `if` branches with one interface and a class per variant, so a new variant is one new file. Where a class was cut too fine, merge the pieces back into one before you add the next variant.

Then put up a guard so the scatter does not return. A short list of which module owns which rule, and a review habit of asking "where else does this change?", or a test or CI grep that fails when a rule appears outside its owning module, catch it early. If one new variant still needs more than the owning module and its tests after the move, the boundary is in the wrong place.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Primitive Obsession](./primitive-obsession.md) — Repeating the same rule at many call sites is a common cause of scattered edits
- [God Object](./god-object.md) — Shared code that grows a case for every client becomes one class everything leans on, while the clients still need edits together.

**Mitigated by**

- [Strategy](../patterns/gof/behavioral/strategy.md) — One logical change needs edits in many classes, which gathering the variants into one place ends
- [Vertical Slice](../patterns/architecture/vertical-slice.md) — A change that needs small edits across many layers is the pain a feature slice removes
- [Don't Repeat Yourself (DRY)](../principles/dry.md) — A rule copied to many places is the usual reason one change needs many edits
- [Open/Closed Principle](../principles/open-closed.md) — A change that forces edits to many existing classes shows they are not open to extension
- [High Cohesion, Low Coupling](../principles/high-cohesion-low-coupling.md) — One change spread across many modules shows low cohesion
- [Specification](../patterns/enterprise/specification.md) — A named specification gathers a rule copied into the report, the job and the screen into one object
- [Atomic Design](../patterns/frontend/atomic-design.md) — Shared atoms and molecules put a repeated UI part in one file, so one change lands once

**Threatens**

- [Layered / N-Tier](../patterns/architecture/layered.md) — One new field must be edited into every layer in turn
- [DTO](../patterns/enterprise/dto.md) — Each transfer shape copies the same fields, so one change touches every copy
- [Microservices](../patterns/architecture/microservices.md) — A change cutting across service boundaries needs coordinated edits in many repos

<!-- relationships:end -->
