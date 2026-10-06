---
title: Lava Flow
description: Dead or unexplained code kept in place because nobody dares remove it
area: hazards
owner: Oleksandr Derechei
tags: [anti-pattern, code-smell, maintainability]
status: stable
aliases: [Dead code, Cruft]
solves: [nobody knows what this module does and everyone is afraid to delete it, half the codebase is old experiments that shipped and never got cleaned up, "we keep commented-out code and old flags just in case, and the repo only grows", new developers keep building on code that is actually dead]
---

# Lava Flow

Code from an old experiment or departed team hardens in place, because nobody knows what it does and nobody dares remove it.

## What it is
<!--meta block=description-->

**Lava flow** is dead or poorly understood code that stays in a system after its purpose is gone, like cooled lava that nobody clears. It is left behind by prototypes shipped as products, abandoned experiments and developers who moved on without notes. You recognise it by modules with no owner and no tests, variables named `temp2`, and a team that says "do not touch that, it might be needed". The trait is fear of removal, not age.

## Explained
<!--meta block=explain-->

Lava flow is dead or poorly understood code that stays in the system because nobody dares delete it. It is left by prototypes that shipped, abandoned experiments and people who left without notes. It is not defined by age but by fear: there are no tests to prove removal is safe and no owner to ask. It gets worse with time, because new code is built on or around it, and a deletion that was safe in year one becomes a risky project in year four. Choose measuring over guessing: find out from production traffic what is actually unused, then delete in small reversible steps. Where code is used but not understood, write tests that record its current behaviour first, so a rewrite has a net under it.

**Example.** A 4,000-line reporting module has no owner and no tests, and the team says it might feed finance. A counter added to its entry points shows 0 calls in 6 weeks across 3 month-end closes. The team deletes one sub-module per week behind version control, and watches errors after each. In 5 weeks they remove 3,100 lines and 11 dependencies, and the build drops from 14 to 11 minutes. One removal broke a quarterly job and was restored in an hour from version history. The cost was 5 weeks of cautious work, and the counter-move to the risk was small steps.

## How it happens
<!--meta block=causes-->

```mermaid caption="The loop: unknown code is never removed, and new code gets built on top of it."
flowchart TB
    A["Prototype or experiment ships"] -->|"author moves on, no notes"| B["Code with no owner and no tests"]
    B -->|"nobody knows what depends on it"| C["Removal feels risky, so it stays"]
    C -->|"new code built around and on top of it"| D["Real dependencies now exist"]
    D -->|"removal is now actually risky"| C
```

- **Prototype becomes product.** Code written to try an idea ships under a deadline, and the cleanup that was promised never gets scheduled.
- **Turnover without handover.** The person who knew why a branch exists leaves, and what remains is code that works and cannot be explained.
- **No tests to prove it is safe.** Without tests, nobody can show that deleting a module changes nothing, so the safe choice is to keep it.
- **Commented-out and flagged-off code.** Developers keep old versions "just in case", and a feature flag stays in the code long after its rollout ended. Kept with no use, such code is a [boat anchor](./boat-anchor.md).
- **Pressure to add, not remove.** Features are tracked and rewarded, while deletion is invisible work with only downside if something breaks.

## What it costs
<!--meta block=cost-->

- **Readers waste time.** Each new developer reads the dead code to learn that it is dead, and some build on it by mistake.
- **Dependencies pile up.** Unused code keeps its libraries in the build, so security patches and upgrades apply to something nobody uses.
- **Tests and builds slow down.** Dead paths are compiled, scanned and sometimes tested on every run, with no benefit.
- **It hides real structure.** A search for how a feature works returns five candidates, and the reader cannot tell which one runs.
- **It grows more dangerous with time.** The longer it sits, the more live code is attached to it, and a removal that was safe in year one is a risky project in year four.

## Getting out
<!--meta block=mitigation-->

Find out what is really unused before you delete anything. Production telemetry, coverage from real traffic or a counter added to the suspect function answers the question with evidence, and a few weeks of zero calls is a stronger reason than a code review.

Then remove in small, reversible steps. Delete one module at a time, behind version control so that it can be restored, and watch the error rate afterwards. For code that is still referenced but not understood, write characterisation tests that record what it does today, and then refactor or replace it with the tests as a safety net. For a whole legacy area, the [strangler fig](../patterns/distributed/coordination/strangler-fig.md) approach replaces it one slice at a time.

Stop new lava from forming. Give every module an owner, delete a feature flag in the same sprint that finishes its rollout, and treat a prototype's ship date as the start of a cleanup deadline. Make deleting code a visible, praised piece of work, because a team that is never rewarded for removal will not do it.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Boat Anchor](./boat-anchor.md) — Dead code that stays because nobody dares delete it
- [Big Ball of Mud](./big-ball-of-mud.md) — Unowned code nobody dares remove keeps piling up

**Mitigated by**

- [Golden Master](../patterns/testing/golden-master.md) — Fear of removal fades when a recorded baseline shows nothing changed
- [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) — Code written for an unproven need is what turns into lava when the need never comes

**Threatens**

- [Strangler Fig](../patterns/distributed/coordination/strangler-fig.md) — The old system lingers unowned when the cutover is never finished
- [External Configuration Store](../patterns/distributed/coordination/external-configuration-store.md) — Stale keys and flags accumulate that no one dares remove
- [Feature Flag](../patterns/distributed/routing/feature-flag.md) — A release flag left in place after rollout is a common way for lava flow to start

<!-- relationships:end -->
