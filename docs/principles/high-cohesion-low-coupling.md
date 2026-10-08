---
title: "High Cohesion, Low Coupling"
description: "Keep what changes together in one module, and keep modules knowing little about each other"
area: principles-craft
owner: Oleksandr Derechei
tags: [modularity, decoupling, maintainability]
status: stable
aliases: [Cohesion and coupling]
solves: [one small change means editing a dozen files across several modules, every module reaches into the internals of the others, changing one class breaks code in places that look unrelated, I cannot test one module without faking half the codebase]
---

# High Cohesion, Low Coupling

Keep the things that change together inside one module, and keep different modules knowing as little about each other as you can.

## What it says
<!--meta block=description-->

**Cohesion** measures how strongly the parts inside a module belong together. **Coupling** measures how much one module needs to know about another. The pair comes from structured design work in the 1970s, and it is two halves of one aim: draw module boundaries where changes stay inside them. It is not "small modules". A module can be tiny and still be coupled to everything around it.

## Explained
<!--meta block=explain-->

High cohesion means the parts of a module belong together because they change for the same reason. Low coupling means a module depends on little of any other module and only through a narrow interface. So one edit touches one module, and a module can be tested with few fakes. Cut by reason to change, not by technical layer or size, because a layer-shaped cut sends most features through several modules. Version history is the best evidence of grouping, though bulk edits and new features can mislead it. The cost is a design judgement that is often wrong the first time, and an extra interface wherever two modules meet. Keep it affordable by hiding internals, passing only what a module uses, and merging two modules whose changes always cross the line. See [separation of concerns](separation-of-concerns.md) for the nearest neighbour.

**Example.** A shop's tax rule changes. In the layered code, the edit touches 9 files: the order controller, the order service, the invoice builder, three mappers and 3 report queries, and 2 reviewers needed a full day. After regrouping around the pricing capability, the rule lives in one module with a 3-function interface, and the same change touches 1 file and its tests. The regrouping took 6 days, which pays back only if changes like this recur. The risk was a module boundary in the wrong place, so the team checked version history first, and its own count showed 70% of recent commits had touched those 9 files together.

## Why it helps
<!--meta block=rationale-->

Without cohesion, one reason to change touches many modules, and one module has many reasons to change. A tax-rule edit then means changes in the order code, the invoice code and the report code, and a developer must understand all three to be sure. Without low coupling, a change inside one module breaks another that reached into its details, and unit tests of the first module will not show it.

When related things sit together and modules meet only at narrow interfaces, a change has a small blast radius. You can read one module without the others, test it with few fakes and replace it without a hunt through the codebase. Over a system's life most work is change, so the shape of the boundaries decides how fast that work goes.

## Applying it
<!--meta block=applying-->

Use change as the test, because it shows where the real boundaries are:

- **Group by reason to change.** Count which files appear in the same commit (git log --name-only); files that nearly always move together share a module, even across layers. Skip bulk renames and mechanical commits; with little history, use domain seams.
- **Hide the internals.** Export a small interface and keep data shapes and helpers private, so callers cannot depend on them.
- **Depend on what you need.** Pass in the one function or narrow interface a module uses, not the whole object it came from.
- **Watch the arrows.** If module A calls many things in B (for example, most of its interface), the boundary is probably in the wrong place. Two modules that call each other belong in one module or behind one interface; grep the imports both ways to check.
- **Cut at seams that match the domain.** A module named for a business capability stays cohesive longer than one named for a technical layer.
- **Spot hidden coupling.** Two modules reading or writing the same table, global or config key are coupled even with no import between them.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — a loose class that reaches into others, then a cohesive one behind a narrow interface"
// Before: Invoice reaches into Customer and Database, and sends mail itself.
class Invoice {
  send(customer: Customer, db: Database) {
    const addr = customer.profile.contact.addresses[0];   // reaches three levels in
    const rows = db.query("SELECT * FROM lines WHERE inv=?", this.id);
    mailer.send(addr.email, render(rows));                // data, formatting and delivery here
  }
}

// After: Customer owns its email; sendInvoice sees only what it is given.
class Customer {
  email(): string { return this.profile.contact.addresses[0].email; }  // the reach lives here, once
}
const lines = (db: Database, id: string) => db.query("SELECT * FROM lines WHERE inv=?", id);
function sendInvoice(to: string, rows: Line[], send: (to: string, text: string) => void) {
  send(to, render(rows));                                 // knows an address, rows and a sender
}

// The caller wires the pieces together:
sendInvoice(customer.email(), lines(db, id), mailer.send);
```

## Taken too far
<!--meta block=overreach-->

Pushing for zero coupling splits modules until every simple task crosses five interfaces. Each interface is a place where a change must be agreed and a contract kept, so too many small modules turn local changes into cross-module ones, which is the opposite of the aim. Pushing cohesion by size produces the same result: a module cut in two to make it smaller can end up with two halves that must always change together.

Some coupling is the point. A checkout that needs a price must know the pricing module exists, and hiding that behind three layers of indirection buys nothing. Judge a boundary by whether changes stay inside it, and remove a boundary when most changes cross it anyway.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Separation of Concerns](./separation-of-concerns.md) — Draws module boundaries around one concern each
- [Law of Demeter](./law-of-demeter.md) — Fewer things one module must know about another
- [Dependency Inversion Principle](./dependency-inversion.md) — Modules depend on abstractions rather than on one another's details
- [Bounded Context](../patterns/ddd/bounded-context.md) — A context groups what changes together and keeps its model private
- [Single Responsibility Principle](./single-responsibility.md) — One reason to change is the unit that cohesion groups around.
- [Encapsulation](./encapsulation.md) — Hiding internals keeps a narrow interface narrow, so coupling stays low.

**Prevents**

- [Shotgun Surgery](../hazards/shotgun-surgery.md) — Draws module boundaries where changes stay inside them
- [Spaghetti Code](../hazards/spaghetti-code.md) — Clear boundaries stop any part reaching into any other
- [Big Ball of Mud](../hazards/big-ball-of-mud.md) — Low coupling keeps a change from spreading into a ball of mud
- [Distributed Monolith](../hazards/distributed-monolith.md) — Boundaries drawn where changes stay inside them stop services having to release together.

<!-- relationships:end -->
