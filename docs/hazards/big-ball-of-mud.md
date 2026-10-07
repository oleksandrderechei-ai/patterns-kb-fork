---
title: Big Ball of Mud
description: No discernible architecture at all
area: hazards
owner: Oleksandr Derechei
tags: [anti-pattern, code-smell, decoupling, maintainability, boundaries]
status: stable
aliases: [BBoM]
solves: [there is no layer a change can stay inside, the UI queries the database directly and nothing stops it, anything can import anything and eventually does, "the same business rule lives in a controller, a cron job and a database trigger"]
---

# Big Ball of Mud

No discernible architecture at all — every module can reach every other one, and no boundary holds.

## What it is
<!--meta block=description-->

A big ball of mud is a system built by expedience, with no boundary a change can stay inside. You recognize it when the UI queries the database directly, one business rule lives in a controller, a cron job and a trigger, and anything can import anything. It is Spaghetti Code at the scale of the whole system: the tangle runs between layers, services and domains, not just between statements.

## Explained
<!--meta block=explain-->

A big ball of mud is a system with no enforced boundaries: any part can call or change any other, so a change in one place can break something far away. It grows one rushed fix at a time. The quick fix ships, the tidy one takes a week, and each shortcut adds a link that costs weeks to remove later. Delivery is measured and structure is not, so no review catches it. Choose by economics. If the system earns and rarely changes, freeze it behind one stable entrance and stop investing. If it changes often, strangle it with the [strangler fig](../patterns/distributed/coordination/strangler-fig.md): send one slice of work at a time to new code behind a front door, so the old system keeps earning while it shrinks. Reserve a full rewrite for a platform that is dead underneath, because a stalled rewrite leaves you two balls of mud. Make each boundary a build check that fails a merge, since a rule in a wiki loses to a deadline.

- **Falling speed.** Coupling, not line count, sets the price of each change, so speed falls as headcount rises and new hires need months.
- **Boundary upkeep.** Each boundary needs an owner and a slice of every sprint, about 15% in the example below, so list it on the roadmap.

**Example.** A shop has 10 engineers shipping 20 features a quarter. After three years it has 30 engineers and ships 25, so output per engineer fell from 2 to under 1. A tax change now edits 9 files across 4 modules. The team gives orders one entrance, moves callers onto it as they pass, and adds a continuous integration (CI) check that fails any import reaching past it. They count cross-boundary imports each month: 400 at the start, 310 after a quarter. A count that keeps falling month on month shows the tangle has stopped growing. The work takes about 15% of each sprint, which they list as its own roadmap line.

## How it happens
<!--meta block=causes-->

Nobody sets out to build one. It grows a rushed fix at a time: the quick way works today, the tidy way takes a week, and the quick way ships. Each fix leaves the code a little harder to change, which makes the next quick fix easier to justify. Four ordinary pressures keep that loop turning.

The loop is asymmetric, and that asymmetry is what makes it a ratchet. A shortcut that reaches across a boundary adds a dependency edge in an afternoon; removing that edge a year later costs weeks, because other code has grown through it in the meantime.

Treat it as an incentive problem before a skill problem. Delivery is measured and structure is not, so the engineer who reaches across a boundary is rewarded this sprint while the cost lands on whoever is on call next year. No step in the loop below is set up to fail a code review. That is why it keeps turning on teams that know better.

```mermaid caption="The loop that builds the mud. Each fix makes the next one riskier and the shortcut more tempting."
flowchart LR
    P["Deadline pressure"] -->|"ship the quick fix"| F["Quick fix bypasses structure"]
    F -->|"reaches across a boundary"| K["New coupling point created"]
    K -->|"structure erodes"| H["System harder to understand"]
    H -->|"refactor feels riskier"| P
```

- A prototype ships to production because it "worked," and the shortcuts it took never get revisited.
- No one owns the architecture, so nothing stops a change from reaching across a boundary.
- Tests are thin or absent, so refactoring feels riskier than patching around the problem.
- Turnover erodes the tribal knowledge of why a boundary existed, so the next engineer just routes around it.

## Why it hurts
<!--meta block=cost-->

- Any change can break something unrelated because nothing is isolated, so regression risk grows with how much code the change can reach, which here is most of the system.
- Onboarding often takes months instead of weeks, because boundaries are unwritten and unenforced and the knowledge sits in a few heads.
- Automated tests need most of the app running to mean anything, so few get written and confidence in a deploy stays low.
- Feature velocity decays as the codebase grows, since coupling — not line count — is what makes change expensive.
- Only a shrinking group of people will touch the oldest core, which is a bus-factor problem waiting to happen.
- A full rewrite becomes the only fix anyone proposes. It is expensive, often stalls before it ships, and leaves two balls of mud instead of one.

The bill that reaches a budget is organizational. Velocity decay gets absorbed by hiring, so headcount grows while output does not, and every new hire pays the months of onboarding before contributing. The rewrite that eventually gets proposed competes with the roadmap for the same engineers, and the roadmap usually wins. Past a point the question stops being how to fix the system and becomes which parts of it are worth fixing at all.

## How to avoid it
<!--meta block=mitigation-->

Every escape route works the same way: draw a boundary, then make crossing it cost something. A rule in a wiki loses to a deadline; a rule the build enforces does not, so the import check belongs in CI (continuous integration) where it can fail a merge.

Start where the change is, not where the mess is worst. Take the area you edit most often, give it one entrance, and move callers onto that entrance as they come past. The rest of the mud can stay muddy until it costs you something. Choose the area by change frequency in version-control history: the module that changes most often goes first, and one that rarely changes is a candidate to freeze. Where tests are thin, pin current behaviour with characterization tests on that area before moving callers onto the entrance.

Boundaries hold only while someone is accountable for them. Give each seam an owner and a check that fails the build, and put the repair work on the roadmap as its own line item instead of hiding it as slack inside feature estimates, because work that is invisible to planning is the first thing a deadline takes back. A count of cross-boundary imports, watched over months, is the number that tells you whether the ratchet has actually stopped. If the area already has many violating imports, record them as a baseline, fail the build only on new ones, and shrink the baseline over time.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Lava Flow](./lava-flow.md) — Layers of code no one understands are the mass a big ball of mud is made of
- [Spaghetti Code](./spaghetti-code.md) — The same tangle inside one module; once it spreads across modules it is mud

**Often confused with**

- [Distributed Monolith](./distributed-monolith.md) — A distributed monolith usually has a tidy diagram — the problem is where the lines fall, not that they are missing.
- [God Object](./god-object.md) — A whole system with no structure, not one class that swallowed the rest

**Mitigated by**

- [Hexagonal](../patterns/architecture/hexagonal.md) — Isolating the core keeps the mud out
- [Layered / N-Tier](../patterns/architecture/layered.md) — Enforced layers resist mud
- [Strangler Fig](../patterns/distributed/coordination/strangler-fig.md) — Replace the mud incrementally instead of a rewrite
- [Bounded Context](../patterns/ddd/bounded-context.md) — Boundaries keep models from merging into mud
- [Separation of Concerns](../principles/separation-of-concerns.md) — Clear concern boundaries are precisely what the mud has dissolved
- [Design for Evolution](../principles/design-for-evolution.md) — Deliberate seams are exactly what the mud grew in the absence of
- [Vertical Slice](../patterns/architecture/vertical-slice.md) — Filing by feature keeps a change inside one folder instead of spreading it everywhere
- [High Cohesion, Low Coupling](../principles/high-cohesion-low-coupling.md) — Low coupling is what keeps a change inside its boundary

**Threatens**

- [Microservices](../patterns/architecture/microservices.md) — A tangled system split without untangling it becomes a distributed mess

<!-- relationships:end -->
