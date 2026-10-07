---
title: God Object
description: One class knows and does almost everything
area: hazards
owner: Oleksandr Derechei
tags: [anti-pattern, decoupling, separation-of-concerns, testability, code-smell]
status: stable
aliases: [God Class, The Blob]
solves: [one class knows about everything and every feature has to touch it, unrelated features keep colliding in merge conflicts on the same file, testing this class means mocking half the system, the longest file in the repo grows every sprint and nobody can split it]
---

# God Object

One class knows and does almost everything — until every change to the system, however small, has to go through it.

## What it is
<!--meta block=description-->

A **god object** is one class that knows about most of the system and does most of the work, built up by individually reasonable additions. You recognise it by its gravity: most classes import it, merge conflicts cluster in its file, and testing it means faking half the system. The defining trait is not length. A long class with one job is only large; a god object holds many unrelated jobs, so a change to one risks the rest.

## Explained
<!--meta block=explain-->

A god object is one class that knows about most of the system and does most of the work: validating input, talking to the database, applying business rules and coordinating every other class. It usually starts as an innocent Manager or Context class and grows because adding one more method is quicker than designing a new class. Stop it growing first, so every new job gets its own class. Then move one job out at a time, choosing the cut from version history, since methods that usually change in the same commits belong together; check the commits are not one large feature that touched many jobs. Move the state with the job, because a stateless helper leaves every caller coupled as before. The old class may remain as a forwarding [facade](../patterns/gof/structural/facade.md).

- **Two entry points.** The facade doubles the surface while it lives, so put a removal date on it.
- **Caller migration.** Every caller must move to the new class; do it one job at a time.

**Example.** An AppManager class has 6,000 lines and 12 dependencies. In the last quarter, 45 of the 60 commits that touched it changed invoice methods, so invoicing is the first cut. The team creates an InvoiceService holding the invoice state and taking just 2 collaborators, the database and the tax calculator. AppManager keeps forwarding methods for 8 weeks, then they are deleted. Invoice tests drop from 12 fakes to 2, and invoice work stops colliding with other changes.

## How it happens
<!--meta block=causes-->

```mermaid caption="The reinforcing loop: each shortcut increases the cost of the refactor that would undo it."
flowchart TB
    A["New feature needed"] -->|"add to the familiar class"| B["One more method on the class"]
    B -->|"pulls in one more subsystem"| C["Class depends on more of the system"]
    C -->|"refactor cost rises"| D["Splitting it feels riskier than before"]
    D -->|"next feature arrives"| A
    D -->|"everything routes through it"| E["Class becomes the de facto integration point"]
```

- No owner enforces a single responsibility per class, so the path of least resistance is always "add it here."
- A class becomes the de facto integration point: every subsystem already talks to it, so wiring a new one through it is one line instead of a new interface.
- Deadline pressure rewards the fastest change, and extending an existing class beats designing a new collaborator and its tests.
- Missing or weak module boundaries mean nothing stops a class from reaching into unrelated concerns.
- Without [dependency injection](../patterns/gof/extra/dependency-injection.md), code reaches for a convenient global or singleton instead of taking a narrow, explicit dependency.
- Growth feeds itself: the class that already holds the data and the callers is where the next feature seems to belong.

## Why it hurts
<!--meta block=cost-->

- A change to one job can break another job, because everything is coupled through the one class.
- Unit testing requires mocking a huge dependency graph, so tests are slow, brittle, or simply not written.
- Parallel work collides constantly — two developers touching different features both edit the same file.
- No one can hold the whole class in their head, so changes are made by cautious imitation rather than understanding.
- It can't be reused or extracted piecemeal — replacing one responsibility means untangling all of them first.
- Onboarding stalls: new engineers meet the god object early and take it for the map of the whole system, so its tangles are copied into new code.

## How to avoid it
<!--meta block=mitigation-->

Stop the class growing before you try to shrink it. Every new responsibility gets its own class, even when adding one more method to the big one would take a minute. Before each extraction, write tests that pin the current behavior, so a move that changes it shows up. Then move one existing job out at a time, starting with the one whose tests you most want back.

Choose the cut from history rather than from the file. Methods that keep changing in the same commits are usually one responsibility, and that clustering still holds long after the class's own names stopped meaning anything; check that the commits are not one large feature that touched many jobs. Hand the extracted class exactly the collaborators it needs and nothing wider, so the reach that grew the original is not available to the new one.

Expect the old class to survive as a facade that forwards to the new ones. That is fine while it stays a facade: review it against the rule that it has no fields and no branches, because once it holds state or makes a decision it is the same class again. Give each extracted responsibility a named owner and put a removal date on the facade, because a shim nobody is accountable for is where the next one starts.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Shotgun Surgery](./shotgun-surgery.md) — A class that takes every client's special case is where one change must be repeated for each client.

**Often confused with**

- [Spaghetti Code](./spaghetti-code.md) — One class holding many unrelated jobs, whatever the control flow
- [Big Ball of Mud](./big-ball-of-mud.md) — One class that does most of the work, inside a system that may be otherwise tidy

**Mitigated by**

- [Mediator](../patterns/gof/behavioral/mediator.md) — Centralizing coordination, done carefully, avoids one class doing all
- [Dependency Injection](../patterns/gof/extra/dependency-injection.md) — Injected collaborators keep one class from owning everything
- [Single Responsibility Principle](../principles/single-responsibility.md) — One reason to change keeps a class from swelling into the object that does everything
- [REPR](../patterns/architecture/repr.md) — An operation cannot accumulate onto a shared class if each one has its own

**Threatens**

- [Service Layer](../patterns/enterprise/service-layer.md) — A service layer tends to collect every use case into one manager class
- [Active Record](../patterns/enterprise/active-record.md) — A row-owning class that also holds business logic grows into one
- [Front Controller](../patterns/enterprise/front-controller.md) — A front controller that takes every route's special case becomes the same class
- [Facade](../patterns/gof/structural/facade.md) — A facade that starts holding state or logic grows into one class that everything leans on
- [Service Locator](../patterns/gof/extra/service-locator.md) — A shared registry that answers every request is one way the object everything reaches into forms
- [Single Access Point](../patterns/security/single-access-point.md) — A single access point that takes every route's special case becomes the same class.

<!-- relationships:end -->
