---
title: Make Illegal States Unrepresentable
description: "Shape types so an invalid combination of values cannot be written, and the compiler rejects it"
area: principles-craft
owner: Oleksandr Derechei
tags: [domain-modeling, validation, maintainability]
status: stable
solves: [an order can be shipped with no ship date and nothing in the type stops it, every function re-checks that the optional fields match the status flag, we have impossible states in the database and no idea how they got there, a new status was added and half the switch statements silently ignore it]
---

# Make Illegal States Unrepresentable

Shape your types so that a combination of values that makes no sense cannot be written down, and the compiler rejects it.

## What it says
<!--meta block=description-->

Design your data types so that every value you can construct is a valid one. The phrase is Yaron Minsky's, from his work on OCaml at Jane Street. It is not "validate harder". Validation checks a bad state after it exists, while this principle removes the bad state from the type, so there is nothing left to check at run time and the compiler does the work.

## Explained
<!--meta block=explain-->

This principle says to shape your types so that a nonsense combination of values cannot be constructed at all. A type with a status flag and an optional date lets you build a shipped order with no date, and every function that reads it must guard against that, so some will forget. A tagged union with one variant per state, each holding exactly the data that state needs, removes the case. Choose it over validation when a wrong state is costly and the compiler can express the rule, since validation catches a bad state after it exists and the type prevents it. Parse raw input into the strict type once, where it enters, and let the rest of the code trust it. The cost is conversion at every edge and types that get hard to read if you encode every rule. Stop at the rules where a wrong state costs money or data. A [value object](../patterns/ddd/value-object.md) is the usual carrier.

**Example.** A booking system stores status as a string with optional refundedAt and cancelReason. Over a year, 17 records are found with status confirmed and a refund date, and each one caused a wrong total in a report. The team rewrites the type as a union: confirmed, cancelled with a reason, refunded with a date and amount. The 17 impossible rows cannot be created, and a new state fails to compile in 6 switch statements until it is handled. The cost is a parse step at the database and API edges, about 60 lines, and one migration for the old rows.

## Why it helps
<!--meta block=rationale-->

When a type allows an illegal combination, such as an order that is shipped but has no shipping date, every function that reads it must guard against that case, and some will forget. The defect is a state that the program can reach but the rules forbid, and it shows up far from where it was created, as a null error or a wrong total in a place nobody tested.

When the type cannot hold the combination, that class of defect cannot occur: a function that receives a shipped order gets a date, because the type guarantees it. You write the guard once, at the place where raw input becomes a typed value, and the rest of the code works with values it can trust. Tests then need to cover behaviour, not impossible shapes.

## Applying it
<!--meta block=applying-->

Look for fields that are only valid together, and fold them into one type:

- **Replace flags and nullable fields with a tagged union.** One variant per state, each carrying only the data that state needs.
- **Replace parallel fields with one structure.** Two lists that must have equal length, or a value and its unit, belong in one type.
- **Make required data required.** If a state needs a date, give that state a date field that cannot be empty, instead of an optional one that you check.
- **Convert once, at the edge.** Parse raw input into the strict type where it enters, and fail there with a clear error.
- **Use exhaustive matching.** Let the compiler tell you when a new state is not handled by any function that switches on the type.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — a flag-and-nullable shape that allows nonsense, then a union that does not"
// Before: "shipped" with no date, or "pending" with a date, both compile.
interface Order {
  status: "pending" | "shipped" | "cancelled";
  shippedAt?: Date;
  cancelReason?: string;
}

// After: each state holds exactly the data that state needs.
type Order =
  | { status: "pending" }
  | { status: "shipped"; shippedAt: Date }
  | { status: "cancelled"; reason: string };

function describe(o: Order): string {
  switch (o.status) {
    case "shipped":   return `sent ${o.shippedAt.toISOString()}`;   // date is guaranteed
    case "cancelled": return `cancelled: ${o.reason}`;
    case "pending":   return "waiting";
  }                                                                  // a new state fails to compile here
}
```

## Taken too far
<!--meta block=overreach-->

Types can express only so much, and a type that tries to encode every business rule becomes harder to read than the rule. Pushing a rule such as "the end date is after the start date" into a clever type may need generics that few teammates can follow, and the error messages that result are worse than a plain runtime check. The aim is fewer bad states, not a proof of the whole domain.

Strict types also have a price at the edges. Every external input, from a database row to a form field, must now be parsed into the type, and a state that is legal in the data today but not in the type is a failed load. Keep the type strict where a wrong state costs money or data, and accept a runtime check where the type would cost more than the bug.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Value Object](../patterns/ddd/value-object.md) — A type that can only hold valid values, such as a validated email address
- [Immutability](../patterns/functional/immutability.md) — A value that cannot change cannot be moved into an invalid state later
- [Fail Fast](./fail-fast.md) — Removes the bad state from the type, so the compiler rejects it before the program runs
- [State](../patterns/gof/behavioral/state.md) — Gives each state only the data and moves it can legally have
- [Encapsulation](./encapsulation.md) — A private constructor lets only valid values be built
- [Keep It Simple (KISS)](./kiss.md) — The type that rules out bad states is usually also the simplest model that meets the requirement.
- [Builder](../patterns/gof/creational/builder.md) — A staged builder applies this to construction, so a half-set object cannot be built

**Prevents**

- [Primitive Obsession](../hazards/primitive-obsession.md) — Moves the rules about a value into its type, so a bad value cannot be built

<!-- relationships:end -->
