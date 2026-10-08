---
title: Encapsulation
description: Keep state private so its invariants have exactly one owner
area: principles-craft
owner: Oleksandr Derechei
tags: [low-level-design, encapsulation, abstraction, state-management]
status: stable
aliases: [information hiding, data hiding]
solves: [the same validation rule is checked in four callers and missing in the fifth, any code can put this object into a state that should be impossible, changing how one field is stored broke twenty call sites, our objects are bags of getters and setters and the rules live somewhere else, I handed out the internal list and something mutated it from outside]
---

# Encapsulation

The object that holds a piece of state is the only thing allowed to change it, and it enforces the rules about it. Callers ask it to do something rather than reaching in and doing it themselves.

## What it says
<!--meta block=description-->

Hide state behind operations. An object keeps its data private and publishes verbs meaningful in the domain, so every change passes through code that can refuse it and an invariant spanning several fields has one owner. At module scope the same rule is information hiding: publish the interface, hide the decisions likely to change. Construction is part of the boundary, and a collection handed out by reference hands out the invariant with it.

## Explained
<!--meta block=explain-->

Encapsulation means an object keeps its data private and offers operations named for what the domain does, so every change goes through code that can refuse it. A rule that spans several fields then has one owner, instead of being rechecked, or forgotten, by every caller. The same idea at module level is information hiding: publish the interface and hide the decisions most likely to change, so the storage can change without a caller changing. Choose it over public fields when an object has rules to protect, and have the constructor refuse to build an invalid object. Hand out read-only views of collections, since a list given out by reference lets anyone add an item the owner would reject. Do not apply it to a data-transfer object, whose whole job is to carry fields across a boundary.

- **Ceremony leaves state as reachable as before.** A getter and setter for every field protects nothing. Name operations after domain actions like cancel().
- **Guarding mutable state takes effort.** Every mutator must enforce the rule. Prefer immutability: after a checked constructor nothing can break the rule.

**Example.** An Order has a public list of items and a public total. One screen adds an item without updating the total, another sets a negative quantity, and an invoice shows 80 dollars for a 100-dollar basket. The team makes the fields private, builds an Order only with at least one item, and exposes addItem(sku, qty) and cancel(). addItem rejects a quantity of 0 or less and recomputes the total, and items() returns a read-only view. The rule now has one owner, so a bug in it can live in one place. The cost is that the JSON mapper needs a constructor to build Orders, so the team keeps a plain OrderDto with public fields for the API response.

## Why it helps
<!--meta block=rationale-->

A rule that lives outside the data it governs has to be repeated by everyone who touches that data, and the fifth caller is the one that forgets. Put the rule where the state is and outside the owner there is nowhere to forget it, and a bug in the rule can live only in the owner's code.

The second payoff is freedom to change. When callers depend only on operations, the storage representation is a private decision: a field becomes a computed value, two fields collapse into one, a list becomes a map, and no caller notices. Exposed state inverts that: every field is a published contract, so the cheapest internal change turns into a survey of the call sites that read the field.

## Applying it
<!--meta block=applying-->

Move the rule to the state, then close the door behind it:

- Name operations after what the domain does — `cancel()`, `applyDiscount()` — rather than exposing a setter per field.
- Validate in the constructor, so there is no window in which a half-built object exists.
- Return read-only views of collections, and add or remove through operations that can enforce the rule. A view tracks the owner's later changes and does not protect mutable elements; copy it when the caller keeps it, or make the elements immutable.
- Ask objects to act instead of extracting their state to act on it — a caller that reads three fields to make a decision is making a decision that belonged to the owner.
- Where a whole cluster of objects shares one rule, give the cluster a single entry point, which is what an [aggregate](../patterns/ddd/aggregate.md) is.
- Reach for immutability where you can: with no mutating operation, the constructor check is the only guard the invariant needs, and the cheapest to reason about.
- In review, flag a public mutable field, a getter that returns an internal collection, a setter that assigns with no check, and a caller that reads several fields to branch.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — a caller pushes an item and leaves the total stale, then the Order owns both"
type Item = { sku: string; qty: number; price: number };

// Before: fields are public, so any caller can break the rule.
class Order { items: Item[] = []; total = 0; }
order.items.push({ sku: "A1", qty: 2, price: 500 });  // total is now wrong

// After: one owner for the rule; total is computed, so it cannot drift.
class Order {
  #items: Item[] = [];
  addItem(item: Item) {
    if (item.qty <= 0) throw new Error(`qty must be positive, got ${item.qty}`);
    this.#items.push(item);
  }
  items(): readonly Item[] { return this.#items; }  // a read-only view, not a copy
  total(): number { return this.#items.reduce((s, i) => s + i.qty * i.price, 0); }
}
```

## Taken too far
<!--meta block=overreach-->

The common failure is not too little encapsulation but the ceremony without the principle: a getter and a setter mechanically generated for every private field. The state is just as reachable and just as unguarded, and the type now has more code saying so. If every field has a public accessor pair, the fields are public with extra steps.

The other overreach is applying it where it does not belong. A [data-transfer object](../patterns/enterprise/dto.md) exists to be a bag of fields crossing a boundary, and giving it behaviour and private state makes it worse at its only job. Deciding which types are carriers and which are owners is the actual work; treating everything as an owner produces indirection with nothing behind it.

Two real costs to weigh rather than deny. Serialization and mapping tooling generally wants field access, so a strictly private design has to be reconciled with it — usually through a constructor the tool can use, sometimes through a separate persistence shape. And hidden state can hide a cost: a caller cannot see that an innocuous-looking operation triggers a query, which is the same complaint the [leaky abstraction](../hazards/leaky-abstraction.md) hazard makes. Neither argues for exposing state; both argue for choosing the boundary deliberately instead of by reflex.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Aggregate](../patterns/ddd/aggregate.md) — An aggregate is this principle at cluster scope: one entry point owns the whole cluster's rules
- [Value Object](../patterns/ddd/value-object.md) — Validate at construction is this principle applied to a small immutable type
- [Law of Demeter](./law-of-demeter.md) — Asking an object to act rather than reaching through it follows directly from hiding its state
- [Command-Query Separation](./command-query-separation.md) — Queries expose state safely while commands guard how it changes.
- [Hyrum's Law](./hyrums-law.md) — Hiding internals leaves less for callers to depend on
- [Make Illegal States Unrepresentable](./make-illegal-states-unrepresentable.md) — Hiding the fields behind checked construction keeps every instance valid
- [DTO](../patterns/enterprise/dto.md) — The carrier it exempts: a DTO is a bag of fields crossing a boundary, so decide which types own state and which only carry it.
- [High Cohesion, Low Coupling](./high-cohesion-low-coupling.md) — A small, well-cut module is easier to keep hidden behind its interface.

**Prevents**

- [Partial Object](../hazards/partial-object.md) — Guards against a type whose populated subset depends on which code path built it
- [Anemic Domain Model](../hazards/anemic-domain-model.md) — The anaemic model is precisely what its absence produces: public state, rules elsewhere

<!-- relationships:end -->
