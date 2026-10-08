---
title: Single Responsibility Principle
description: A class should have one reason to change — one actor it answers to
area: principles-craft
owner: Oleksandr Derechei
tags: [low-level-design, separation-of-concerns, maintainability]
status: stable
aliases: [SRP]
solves: [adding one feature means editing five unrelated files, "one class does data access, formatting, and business rules all at once", a change for one team keeps breaking another team's code in the same class, this class is huge and every change to anything ends up touching it, nobody can say what this class actually does in one sentence]
---

# Single Responsibility Principle

A module should answer to exactly one actor — one stakeholder group whose changing needs are its single reason to be rewritten. Gather the things that change together; separate the things that change for different reasons.

## What it says
<!--meta block=description-->

A class should have only one reason to change. It is the S in SOLID, sharpened by Robert C. Martin from an older instinct toward cohesion. Responsibility does not mean do one small thing; it means answer to one source of change. Martin's later gloss is the clearer one: a responsibility is an actor, a person or group whose evolving needs get the module rewritten. Keep one actor's concerns together and separate the others.

## Explained
<!--meta block=explain-->

The single responsibility principle says a module should answer to one source of change, meaning one person or group whose needs decide when you rewrite it. It does not mean do one small thing. When two groups' concerns share a class, a change one group asked for can break what the other relies on, and any edit touching shared lines needs both groups to review it. Choose it over grouping by theme when two different people request changes to the same file, such as a finance team and an operations team. Keep code together when one group always edits it in lockstep, because splitting it only adds hops. Overdone, it leaves a swarm of one-method classes, so following one request means opening a dozen files and the cohesion you wanted is gone. The counter-move is to measure responsibility in reasons to change, never in lines or method count. A quick check is to describe the class in one sentence without using and, and a name ending in Manager or Util is usually the tell.

**Example.** An Employee class has calculatePay(), reportHours() and save(). Finance rewrites the overtime rules, and calculatePay() shares a helper with reportHours(), which HR uses for audits, so one change shifts audit totals before anyone notices. Three groups, finance, HR and the database team, edit one file. The team splits it into PayCalculator, HoursReporter and EmployeeRepository, each with one owner. It stops there: the 5 small methods that format a pay slip always change together for finance, so they stay inside PayCalculator instead of becoming 5 classes. The cost is 3 files to open when you trace one payroll run.

## Why it helps
<!--meta block=rationale-->

Two actors in one module means every edit must satisfy an audience it was not written for. A request from one of them is hard to review by that group alone, because the same lines can carry a rule the other depends on, so the change waits on a second sign-off, and the other actor's tests never run against it unless someone thinks to run them. Once their needs diverge, the cost of owning a module rises with the number of actors it answers to more than with its size.

Split along the axes of change and each edit stays local: the finance request touches finance code, the audit rule touches audit code. A split removes shared code as a hidden path for breakage; shared types and storage can still couple the pieces. The seams then line up with the org chart, which is where change originates.

## Applying it
<!--meta block=applying-->

Group by reason to change, not by superficial similarity:

- Ask of each module: who requests changes to this? Count the distinct requesters in the file's git log authors or its ticket labels. If two different actors do, that is two responsibilities living in one place.
- Separate the axes that move independently — policy from mechanism, formatting from calculation, persistence from domain logic.
- Watch for the tell: a class named with an “and,” or a vague `Manager`/`Util`, is usually holding more than one job.
- Keep together what changes together — [cohesion](./high-cohesion-low-coupling.md) is the other half. Do not split code that a single actor always edits in lockstep.
- In review, look for one pull request touching both a business rule and a layout or storage detail, one file edited for unrelated tickets from different teams, or a private helper called by methods that serve different actors. Give each actor its own copy or pass the value in; duplicating an accidental similarity costs less than the coupling.

The test: describe the class in one sentence without using “and.” If you cannot, it is probably answering to more than one actor.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — one class serving three actors through a shared helper, then split by who asks for change"
interface Db { put(key: string, value: unknown): void }
type Shift = { hours: number; breakHours: number; rate: number };

// Before: finance, HR and the database team all edit this class.
class Employee {
  constructor(public s: Shift) {}
  private billableHours() { return this.s.hours - this.s.breakHours; } // shared helper
  calculatePay() { return this.billableHours() * this.s.rate; }        // finance's rule
  reportHours() { return `Hours: ${this.billableHours()}`; }           // HR's audit format
  save(db: Db) { db.put("employee", this.s); }                         // database team
}

// After: one owner per class. Review cue: a private helper called by methods that
// serve different actors. Each actor now owns its own copy of the subtraction.
class PayCalculator {
  calculatePay(s: Shift) { return (s.hours - s.breakHours) * s.rate; }
}
class HoursReporter {
  reportHours(s: Shift) { return `Hours: ${s.hours - s.breakHours}`; }
}
class EmployeeRepository {
  save(db: Db, s: Shift) { db.put("employee", s); }
}
```

## Taken too far
<!--meta block=overreach-->

Read as “do one tiny thing”, the principle breaks a system into a swarm of anemic one-method classes, each too small to carry meaning. Behaviour that belongs together is scattered across a dozen files, and following a single request means hopping between them. The cohesion the principle protects is gone.

Responsibility is measured in reasons to change, not in lines of code or method count. Five steps of one job for one actor, named by that job, pass the one-sentence test and belong together; splitting them buys only ceremony and indirection. Five unrelated jobs for one actor do not pass.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Interface Segregation Principle](./interface-segregation.md) — The interface-facing side of one reason to change.
- [REPR](../patterns/architecture/repr.md) — REPR suits an API where each operation has its own actor; it is not a rule that every operation gets a class.
- [High Cohesion, Low Coupling](./high-cohesion-low-coupling.md) — Cohesion is the other half: keep together what one actor changes together.

**Specializes**

- [Separation of Concerns](./separation-of-concerns.md) — One reason to change is separation of concerns drawn at the level of a single module.

**Prevents**

- [God Object](../hazards/god-object.md) — One reason to change keeps a class from swelling into the object that does everything.

**Demonstrated by**

- [Parking Lot](../designs/parking-lot.md) — Parking Lot keeps the Ticket a pure record rather than a session-plus-pricing hybrid
- [Elevator](../designs/elevator.md) — responsibilities are split so no class carries two independent reasons to change
- [Amazon Locker](../designs/amazon-locker.md) — the three responsibilities are split across three classes instead of collapsing into one orchestrator that also validates and stores state
- [Connect Four](../designs/connect-four.md) — Three collaborators each with a single responsibility is the principle in miniature
- [File System](../designs/file-system.md) — every class in the entry hierarchy carries a single reason to change

<!-- relationships:end -->
