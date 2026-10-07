---
title: Spaghetti Code
description: Control flow too tangled to follow
area: hazards
owner: Oleksandr Derechei
tags: [anti-pattern, readability, maintainability, decoupling, code-smell]
status: stable
aliases: [tangled code, spaghetti]
solves: [changing one thing breaks an unrelated test three modules away, I cannot follow what happens when the button is clicked without a debugger, "one function runs hundreds of lines mixing validation, IO and formatting", state is mutated from a dozen far-apart places with no owner]
---

# Spaghetti Code

Control flow too tangled to follow — every branch, jump, and shared variable depends on knowing the whole program to predict what one line does.

## What it is
<!--meta block=description-->

Spaghetti code is a codebase where control flow has no discernible shape. Functions call each other in cycles, conditions nest deep, and state is mutated from a dozen unrelated places, so understanding one button click means tracing the whole call graph. You recognise it by functions hundreds of lines long, global variables with no owner, copy-pasted logic patched differently in each copy, and a change that breaks a test three modules away.

## Explained
<!--meta block=explain-->

Spaghetti code is a codebase where control flow has no readable shape: functions call each other in cycles, conditions nest six deep, and shared variables are changed from a dozen unrelated places. To learn what one button click does you must trace jumps through the whole program, because any part might have changed the data you are looking at. It grows from small steps: a deadline rewards the fastest local fix, there is no agreed layering, so a new branch goes wherever the cursor is, and copy-and-tweak feels safer than extracting a shared function. Each patch is then written by someone who cannot see the whole, which adds another strand. Reverse it in order. First pin today's behaviour with tests that record what the code does now, because untangling without them changes behaviour silently. Then pass the shared variable in and return it out, so writes show in signatures. Fix a direction, as a [layered](../patterns/architecture/layered.md) design does, and check it in the build.

- **Effort with no feature.** Characterisation tests and refactoring ship nothing new; spend them only on strands you already have to edit.
- **Tests lock in bugs.** Recorded behaviour includes wrong behaviour; mark suspect outputs and fix them in a separate change.

**Example.** An order function runs 400 lines and mixes validation, tax, database calls and formatting. A global variable, currentDiscount, is written in 3 places. A typical change touches 11 files. The team first writes 15 tests that record today's outputs. They then make the discount a parameter, so its 3 writers appear in 3 signatures, and split tax out as the lowest tier. A dependency check fails any merge where storage calls the rules. After a quarter a typical change touches 4 files.

## How it happens
<!--meta block=causes-->

```mermaid caption="A feedback loop, not a single decision. Each shortcut makes the next one cheaper and the tangle worse."
flowchart TB
    A["Ship the first feature fast"] -->|"deadline pressure"| B["Add a special case inline"]
    B -->|"reuse without extracting"| C["Copy-paste, not a shared abstraction"]
    C -->|"avoid threading params"| D["Shared mutable state grows"]
    D -->|"next change lands anywhere"| E["Patch symptoms, not structure"]
    E -->|"boundaries keep eroding"| F["No layer left to enforce"]
    F -->|"nowhere right to put code"| B
```

- Deadline pressure rewards the fastest local fix, not the clearest global structure.
- No agreed layering, so there's nowhere "wrong" to put a new branch — it goes wherever the cursor is.
- Copy-paste-and-tweak feels safer than extracting a shared abstraction under time pressure.
- Shared mutable state creeps in to avoid threading a value through several call levels.
- Code review focused on "does it work" rather than "does it fit the shape of the system."
- Turnover: each new author adds a patch without the context to see the whole flow.

## Why it hurts
<!--meta block=cost-->

- **Unreadable causality.** Understanding one behavior requires holding the whole program in your head; nobody can, so mental models go stale.
- **Change becomes unsafe.** A local edit has non-local effects through shared state and hidden call paths, so every fix risks a regression somewhere unrelated.
- **Tests resist writing.** Tangled logic is hard to isolate, so it is hard to unit test; coverage and confidence stay low.
- **Onboarding gets slow.** New engineers can't reason locally; every task starts with archaeology instead of implementation.
- **Bugs hide in the gaps.** Duplicated, slightly-diverged copies of the same logic drift out of sync, so the "same" operation behaves differently depending on which copy ran.
- **It compounds.** Left alone, it can grow into [Big Ball of Mud](./big-ball-of-mud.md), the whole-system version of the same problem.

## How to avoid it
<!--meta block=mitigation-->

Start with the state, not the control flow. Take one variable that far-apart code both reads and writes, and make it something passed in and returned out instead — the writes then show up in the signatures, and the trail a reader has to follow shrinks to what the function was handed. Do it to the strand you are already working on.

Then fix a direction before you move anything else. Name the tiers you already have — entry point, rules, storage — and allow calls downward only; the cycle you cannot remove marks the module holding two concerns, so split that one first. Watch how many files a typical change touches, because that number tells you whether the flow untangled or just moved. Take the number from version-control history: files per merged change over the last several changes. It is a proxy, so confirm with how often changes cause regressions. To pick the first strand, list the cycles your dependency check reports and start with the module in the most cycles that also changes most. Stop when a typical change stays inside one tier.

The direction holds only while something checks it. Make the rule executable as a dependency check that fails a merge, and change what review asks from "does this work" to "does this call downward", because a convention that lives in people's heads is renegotiated under every deadline. Then watch for the tier that only forwards: a layer that makes no decision is a file you must open on every change and learn nothing from, and folding it back is cheaper than defending it.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Premature Optimization](./premature-optimization.md) — Hand-tuned shortcuts added "to be safe" tangle control flow further
- [Big Ball of Mud](./big-ball-of-mud.md) — Left alone, tangled control flow spreads until no boundary in the system holds

**Often confused with**

- [God Object](./god-object.md) — Tangled control flow in any code, not one class holding many jobs

**Mitigated by**

- [Layered / N-Tier](../patterns/architecture/layered.md) — Clear tiers keep call flow from tangling
- [Separation of Concerns](../principles/separation-of-concerns.md) — Keep each concern in its own place and control flow stops threading through everything
- [High Cohesion, Low Coupling](../principles/high-cohesion-low-coupling.md) — Tangled flow between modules is what low cohesion and high coupling produce

<!-- relationships:end -->
