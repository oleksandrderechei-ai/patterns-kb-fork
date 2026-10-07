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

High cohesion means the parts of a module belong together because they change for the same reason. Low coupling means a module depends on little of any other module and only through a narrow interface. Together they put module boundaries where changes stay inside them, so one edit touches one module and a module can be tested with few fakes. Choose to cut by reason to change over cutting by technical layer or by size, because a layer-shaped cut sends every feature through every module. Version history tells you the true grouping: files that move together belong together. The cost is a design judgement that is often wrong the first time, and an extra interface wherever two modules meet. Keep it affordable by hiding internals, passing only what a module uses, and merging two modules whose changes always cross the line. See [separation of concerns](separation-of-concerns.md) for the nearest neighbour.

**Example.** A shop's tax rule changes. In the layered code, the edit touches 9 files: the order controller, the order service, the invoice builder, three mappers and 3 report queries, and 2 reviewers needed a full day. After regrouping around the pricing capability, the rule lives in one module with a 3-function interface, and the same change touches 1 file and its tests. The regrouping took 6 days. The risk was a module boundary in the wrong place, so the team checked version history first: 70% of recent commits had touched those 9 files together.

## Why it helps
<!--meta block=rationale-->

Without cohesion, one reason to change touches many modules, and one module has many reasons to change. A tax-rule edit then means changes in the order code, the invoice code and the report code, and a developer must understand all three to be sure. Without low coupling, a change inside one module breaks another that reached into its details, and nothing in the first module's tests shows it.

When related things sit together and modules meet only at narrow interfaces, a change has a small blast radius. You can read one module without the others, test it with few fakes and replace it without a hunt through the codebase. Over a system's life most work is change, so the shape of the boundaries decides how fast that work goes.

## Applying it
<!--meta block=applying-->

Use change as the test, because it shows where the real boundaries are:

- **Group by reason to change.** Look at which files move together in version history and put them in one module, even if they look like different layers.
- **Hide the internals.** Export a small interface and keep data shapes and helpers private, so callers cannot depend on them.
- **Depend on what you need.** Pass in the one function or narrow interface a module uses, not the whole object it came from.
- **Watch the arrows.** If module A calls five things in B, or two modules call each other, the boundary is probably in the wrong place.
- **Cut at seams that match the domain.** A module named for a business capability stays cohesive longer than one named for a technical layer.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — a loose class that reaches into others, then a cohesive one behind a narrow interface"
// Before: Invoice knows how Customer stores its address and how the database is shaped.
class Invoice {
  send(customer: Customer, db: Database) {
    const addr = customer.profile.contact.addresses[0];       // reaches three levels in
    const rows = db.query("SELECT * FROM lines WHERE inv=?", this.id);
    mailer.send(addr.email, render(rows));                    // formatting, data and delivery here
  }
}

// After: each piece does one job and sees only what it is given.
interface Recipient { email: string }
const lines = (db: Database, id: string) => db.query("SELECT * FROM lines WHERE inv=?", id);
const body = (rows: Line[]) => render(rows);                  // pure formatting, no I/O
function sendInvoice(to: Recipient, text: string, send: (to: string, text: string) => void) {
  send(to.email, text);                                       // only knows the email field
}
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

**Prevents**

- [Shotgun Surgery](../hazards/shotgun-surgery.md) — Draws module boundaries where changes stay inside them
- [Spaghetti Code](../hazards/spaghetti-code.md) — Clear boundaries stop any part reaching into any other
- [Big Ball of Mud](../hazards/big-ball-of-mud.md) — Low coupling keeps a change from spreading into a ball of mud

<!-- relationships:end -->
