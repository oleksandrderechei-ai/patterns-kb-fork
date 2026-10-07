---
title: Value Object
description: "Defined only by its attributes, no identity"
area: ddd
owner: Oleksandr Derechei
tags: [domain-modeling, immutability, validation]
status: stable
aliases: [VO]
solves: [I am passing money around as a float and rounding errors keep showing up, the same email format check is copy-pasted in fifteen different places, someone mutated an object I handed them and it corrupted my copy too, my function signature is six strings in a row and callers keep swapping them, two objects hold identical data but comparing them returns false]
---

# Value Object

Defined only by its attributes, with no identity of its own — two instances holding the same data are simply the same value, immutable, freely comparable, and safe to share without a second thought.

## What it is
<!--meta block=description-->

A bare number or string has nowhere to keep its rules: one caller reads an amount as pounds, the next as pence, and any line can set it to minus five. A value object gives the concept a type of its own, such as money or a date range. It has no id and never changes; equal fields mean equal values, and a change returns a new instance. The rules travel with the data.

## Explained
<!--meta block=explain-->

A value object is a small unchangeable type, such as Money or an email address, that equals any other with the same fields and carries its own validation, so a rule written once travels with every value. Left as a raw number or string, one caller reads an amount as pounds and the next as pence, any line can set it to minus five, and the same check is pasted at every call site. Choose it over an [entity](entity.md) when no one needs to follow the thing through change: any five dollars will do.

- **Wrapper ceremony** A one-field wrapper feels like ceremony and gets skipped; use your language record or data class so it costs one line.
- **Hand-written equality** Equality that misses a field brings back identity bugs; generate equality from the fields.
- **Allocations** Rebuilding a value in a hot loop costs allocations; hoist it out or reuse common instances.
- **No row of its own** A database row needs a key the value lacks; store its fields in the owner row or one serialized column.

**Example.** An invoice stores amount as a plain number. One caller sends 1999 meaning pence and another sends 19.99 meaning pounds, and the total reads 2018.99 instead of 39.98. Replace the number with Money(minorUnits, currency): the constructor rejects the fractional 19.99, and adding two Money values in different currencies throws at once, so that mix-up fails in the first test rather than in a customer's bill. A whole number sent in the wrong unit still needs a named-unit factory. The cost is storage shape: the invoice row now holds two columns, amount_minor and currency, because a value has no row of its own.

## How it works
<!--meta block=structure-->

```mermaid caption="\"Converting\" never mutates the value — it returns a brand-new instance. The original is untouched, because there is no identity to preserve across the change."
flowchart LR
    Orig["Money(5 USD)"] -->|"convertTo(EUR) returns"| New["new Money(4.60 EUR)"]
    Orig -->|"original never mutates"| Shared["still 5 USD — shared, cached, no defensive copy"]
```

## Variations
<!--meta block=variations-->

- **[Immutability](../functional/immutability.md)** — Fields are set once at construction and never reassigned; every "change" produces a new instance. This is the core discipline, not an option. A value lives inside the entity or aggregate that owns it and is replaced wholesale, so changing a customer's address hands the customer a different Address.
- **Self-validating value** — The constructor enforces its own invariants — a `Money` that rejects negative cents, an `Email` that checks its format — so an invalid instance simply cannot exist.
- **Value object with behavior** — Operations like `add()`, `overlaps()`, or `format()` live on the value itself and return new instances, keeping domain logic beside the data it acts on.
- **Structural (composite) value** — Built from other value objects — an `Address` composed of `Street`, `City`, and `PostalCode` — with equality defined recursively across every part.
- **Domain primitive** — The discipline taken to its conclusion: no bare `string` or `int` crosses into domain code, so every quantity arrives as a type that validated itself at construction. An injection or range attack must get past a constructor, not past whichever caller remembered the check.
- **Enumeration class** — A value with a fixed, closed set of instances declared as static members, rather than a language enum. Costs more to declare, and buys what an enum cannot carry: behaviour per case, extra fields, and a set that cannot be widened by casting an arbitrary integer into it.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Equality by value** eliminates whole classes of aliasing bugs — equal data means interchangeable.
- **Immutability makes instances safe to share**, cache, and pass across threads without defensive copies, provided every field is itself immutable (a held array, list or Date still needs a copy).
- **Validates the rules its constructor checks**, so an instance that breaks them cannot exist.
- **Keeps domain logic** — formatting, arithmetic, comparison — next to the data instead of scattered in services.

### Cons
<!--meta polarity=con-->

- **Every "change" allocates a new instance** — real churn and garbage collection (GC) pressure at scale if overused.
- **Equality and hashing must compare every field**; forgetting one silently reintroduces identity bugs.
- **Persistence layers built around row identity** often force embedding or serialization workarounds.
- **Easy to under-use** — a thin primitive wrapper feels like ceremony, so [primitive obsession](../../hazards/primitive-obsession.md) creeps back in.
- **Value or entity is each model's call**, not a property of the concept: an address is a value to shipping and an identified thing to the utility that bills the premises, so do not carry the classification across a service boundary.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A concept is fully described by its attributes**, and no two with the same attributes should be told apart — money, a date range, a coordinate.
- **You want equality, comparison, and hashing** based on content rather than reference.
- **You're validating the same primitive** — an email, a percentage, a currency amount — in more than one place.

### Avoid when
<!--meta polarity=avoid-->

- **The concept has a continuous lifecycle** that must be tracked even as its attributes change — that's an [Entity](./entity.md).
- **Persistence or a client needs to reference** this exact instance independent of its current data.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an immutable Money value"
class Money {
  private constructor(
    readonly amountCents: number,
    readonly currency: string,
  ) {
    if (!Number.isSafeInteger(amountCents)) throw new Error("amount must be whole cents");
    if (amountCents < 0) throw new Error("amount must not be negative");
    if (currency === "") throw new Error("currency required");
  }

  static of(amountCents: number, currency: string): Money {
    return new Money(amountCents, currency);
  }

  add(other: Money): Money {
    if (other.currency !== this.currency) throw new Error("currency mismatch");
    return new Money(this.amountCents + other.amountCents, this.currency); // new instance
  }

  equals(other: Money): boolean {
    return this.amountCents === other.amountCents && this.currency === other.currency;
  }
}

const a = Money.of(500, "USD");
const b = Money.of(500, "USD");
a.equals(b); // true: same value, no shared identity
a === b;     // false: different objects, and that's fine
```

## In the wild
<!--meta block=wild-->

- **java.time** — LocalDate, Duration and Instant are documented value-based classes: immutable, self-validating, and compared by their components rather than by reference. Their Javadoc warns against identity-sensitive operations such as == comparison or synchronizing on an instance, since implementations may cache or intern values. {#wild-java-time}
- **Java records** — A language-level value aggregate, final since Java 16: the compiler makes the components final and generates equals, hashCode and toString from them, giving component-wise value equality without hand-written boilerplate. {#wild-java-records}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Which fields define equality** — All attributes or a subset. Leave one out and two different values compare equal; add one and equal values compare different.
- **Where validation runs** — In the constructor, so an invalid instance cannot exist, against a check at each caller that someone forgets.
- **How much to wrap** — A named type such as `Money` or `EmailAddress` against a bare primitive. Wrapping everything adds types to maintain; wrapping nothing breeds same-typed parameters swapped by mistake.
- **Persistence mapping** — Embedded columns or one serialized column. Embedding keeps the value queryable; serializing keeps the table narrow.

### Signals to watch
<!--meta polarity=signal-->

- **Methods with several same-typed parameters** — A review smell for primitives that should be a value, since two strings or numbers swapped compile fine.
- **Constructor validation failures** — Rejected values logged at construction show where bad input enters.
- **Allocation rate in hot paths** — Millions of short-lived small objects show up in the allocation profile and garbage-collection time.

### Failure modes under load
<!--meta polarity=failure-->

- **Mutated while used as a key** — A value object with setters changes after going into a hash set or map. The entry is then lost under its old hash.
- **Equality drifts from the fields** — A new field is added and `equals` and `hashCode` are not updated, so values that differ compare equal.
- **Hot-loop allocation** — Wrapping a value used billions of times costs measurable memory and pause time; keep the primitive in the inner loop, wrap at the boundary, and measure before switching.
- **Floating-point money** — A money value kept as a float accumulates rounding error. You see totals off by a cent.

### Readiness checklist
<!--meta polarity=check-->

- The type is immutable, with no setters and operations that return a new instance
- Equality and hash are tested against every field, ideally by a property test
- Constructors reject invalid input
- The persistence mapping round-trips in a test

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Service Boundaries](../../themes/service-boundaries.md) — No identity, so it crosses a boundary as a copy {#fluency-service-boundaries}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Immutability](../functional/immutability.md) — Value objects are immutable by nature
- [Lens / Optics](../functional/lens-optics.md) — Nested replacements get a reusable, composable path
- [Encapsulation](../../principles/encapsulation.md) — Its constructor check is encapsulation at the smallest useful scale
- [Specification](../enterprise/specification.md) — A rule object is a value object that answers one question.
- [Make Illegal States Unrepresentable](../../principles/make-illegal-states-unrepresentable.md) — A value object checks its rules once, at construction, so every instance is valid

**Part of**

- [Aggregate](./aggregate.md) — Values live inside the aggregate boundary

**Often confused with**

- [DTO](../enterprise/dto.md) — A transfer shape with no behavior vs. a domain value
- [Entity](./entity.md) — Identity matters vs. only the values matter

**Prevents**

- [Partial Object](../../hazards/partial-object.md) — Its validate-at-construction rule is what stops a half-filled instance existing
- [Primitive Obsession](../../hazards/primitive-obsession.md) — Gives a concept such as money or an email address its own type, so its rules travel with it

**Demonstrated by**

- [Parking Lot](../../designs/parking-lot.md) — Parking Lot models its Ticket as an immutable value object with no behaviour
- [Elevator](../../designs/elevator.md) — a small read-only, content-compared object whose equality semantics the entire direction-aware stopping algorithm depends on
- [Amazon Locker](../../designs/amazon-locker.md) — an immutable record whose isExpired() is a pure derivation over its fixed fields
- [Connect Four](../../designs/connect-four.md) — Attribute-only holders with no identity lifecycle or behaviour are textbook value objects
- [Logging Service](../../designs/logging-service.md) — a small immutable data holder defined entirely by its fields is the value object at work
- [Inventory Management](../../designs/inventory-management.md) — AlertConfig has no identity and never mutates after construction — a pure value grouping two fields
- [Rate Limiter](../../designs/design-rate-limiter.md) — the self-describing, unmodifiable answer object is a textbook value object

<!-- relationships:end -->
