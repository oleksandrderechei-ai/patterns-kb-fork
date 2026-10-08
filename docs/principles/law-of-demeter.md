---
title: Law of Demeter
description: "A method should talk only to its immediate collaborators, never reach through them"
area: principles-craft
owner: Oleksandr Derechei
tags: [low-level-design, encapsulation, decoupling, boundaries]
status: stable
aliases: [Principle of Least Knowledge, LoD]
solves: [a small change to one class rippled through everything that reached into it, my code is full of long chains like a.getB().getC().doThing(), renaming an internal field broke callers three objects away, testing one method means stubbing a whole chain of nested objects, my mocks return mocks that return mocks just to satisfy one call]
---

# Law of Demeter

Only talk to your immediate neighbours. A method may use the objects it is handed, holds, or makes — but it should not reach through one of them to poke at a stranger. The moment you write `a.getB().getC()`, you have taken a dependency on the shape of everything in that chain.

## What it says
<!--meta block=description-->

A method should only call methods on a small circle: its own fields, its parameters, objects it creates and the object it lives on, never on the objects those calls return. Formulated in 1987 by Ian Holland in the Demeter Project at Northeastern University, it is also called the principle of least knowledge. The classic violation is the train wreck, order.getCustomer().getAddress().getCity(); its partner is Tell, Don’t Ask.

## Explained
<!--meta block=explain-->

The Law of Demeter says a method should talk only to its own fields, its parameters and objects it creates, never to the objects those calls return. A chain such as order.getCustomer().getAddress().getCity() ties the caller to how three classes are nested, so renaming or moving any of them breaks code far away. The cure is to tell an object what you want and let it decide: order.shippingCity(), or account.withdraw(amount) in place of reading the balance, comparing it and writing it back. Choose it over chains of getters when the objects you reach through hold rules or structure that may change. Leave a chain alone when it is the intended interface, as with a fluent builder or a stream pipeline, where each call hands you the next stage and nothing private is pried open.

- **To the letter, it buries the design in pass-through methods.** Treat a second dot as a prompt to ask whose job it is.
- **Every forwarding method is code to maintain.** Add one only when callers repeatedly want that far-off value.

**Example.** Say a report calls order.getCustomer().getAddress().getCity() in 14 places. The company then splits Address into BillingAddress and ShippingAddress, and all 14 lines stop compiling. The team adds order.shippingCity() on Order, which asks the customer and keeps the nesting private, so the next such change touches one method, not 14 call sites. The cost is one forwarding method per question callers ask, and a team that adds one for every field could end up with dozens of pass-through methods on Order. So they add one only for questions asked from 3 or more places, a cutoff this team chose. The list.stream().filter(...).map(...) in the same report stays a chain.

## Why it helps
<!--meta block=rationale-->

A chain of calls is a chain of assumptions. `order.getCustomer().getAddress().getCity()` hard-codes that an order has a customer, a customer has an address, and an address exposes a city. Those are three private structural facts, none of them the caller's. Refactor any link, make one nullable, wrap one in a [value object](../patterns/ddd/value-object.md), and every train wreck that walked through it breaks at once, in code that never mentioned the thing that changed.

Keeping to your immediate collaborators limits how far a change spreads. Each object hides its neighbours behind its own interface, so a structural change stops at the first boundary, as long as the method's signature and result type stay the same, instead of propagating outward. It also shows up in tests: a method that only touches what it holds needs one stub (the Order), while the chain order.getCustomer().getAddress().getCity() needs three nested fakes (Order, Customer, Address) just to exercise one line.

## Applying it
<!--meta block=applying-->

Push behavior toward the data instead of pulling data toward the behavior:

- When you catch yourself chaining getters, add a method to the direct collaborator that answers the real question — `order.shippingCity()`, not a walk through customer and address.
- Tell, don't ask: replace “get the balance, compare it, then set it” with `account.withdraw(amount)` and let the object enforce its own rules.
- In review, flag a call whose receiver is the return value of another call, and ask which object should own the answer. Same-type returns, as in builders and stream pipelines, are fine.
- Add the forwarding method once 3 or more call sites ask the same question; below that, leave the chain. A far-off value wanted everywhere can also mean a collaborator is missing.
- Review test: if a unit test must stub an object that returns another stub, or the call site needs null checks on each hop, the code under test is reaching through.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — a report walks order to customer to address to city, then asks Order for shippingCity()"
// Before: the report knows how Order, Customer and Address nest.
const city = order.getCustomer().getAddress().getCity();   // knows three classes' shapes
// a test of this line needs three nested fakes: Order, Customer, Address

// After: Order answers; the nesting stays private.
// order.ts
shippingCity(): string { return this.getCustomer().shippingCity(); }
// customer.ts
shippingCity(): string { return this.getAddress().getCity(); }
// report.ts
const city = order.shippingCity();
```

## Taken too far
<!--meta block=overreach-->

Followed to the letter, the law adds a forwarding method to every object so callers stay one dot away. That pile of pass-through methods adds more indirection than the chain did and hides nothing.

And not every dot is a train wreck. A fluent builder, a stream pipeline, or navigation through a plain data structure chains by design — `list.stream().filter(…).map(…)` is not reaching into someone's private guts, it is one object handing you the next stage. The law is about not coupling to hidden structure; Leave a chain alone when it is the intended interface and nothing private is pried open.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Encapsulation](./encapsulation.md) — Reaching through an object for its collaborators is only possible where state is exposed
- [Facade](../patterns/gof/structural/facade.md) — Callers talk to one object instead of walking into a subsystem's internals
- [Aggregate](../patterns/ddd/aggregate.md) — Outside code goes through the root and never reaches into the objects inside the boundary
- [High Cohesion, Low Coupling](./high-cohesion-low-coupling.md) — Limiting what a caller may reach is one way to keep coupling low
- [Value Object](../patterns/ddd/value-object.md) — Hands callers a small immutable answer, such as a city or Money, instead of the nested object behind it.

**Demonstrated by**

- [Parking Lot](../designs/parking-lot.md) — Parking Lot keeps records from navigating the domain by storing ids, not references

<!-- relationships:end -->
