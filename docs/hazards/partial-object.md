---
title: Partial Object
description: "One class, populated differently by every code path that returns it"
area: hazards
owner: Oleksandr Derechei
tags: [low-level-design, validation, code-smell]
status: stable
aliases: [partial object population, POOP, optional object population]
solves: [whether a field is populated depends on which method returned the object, we keep getting null reference errors on a field that is set on some paths, a total came out wrong because a price was zero instead of missing, I cannot tell from the type which fields I am actually guaranteed, this class grew a nullable field for every screen that reused it]
---

# Partial Object

One class reused across several contexts, each filling in a different subset of its fields and leaving the rest at their defaults — so which fields are actually populated depends on which code path built the instance, and nothing in the type says which.

## What it is
<!--meta block=description-->

A partial object is an instance whose contract you cannot read from its type. One class serves several uses, and each producer fills only the part it needs, so a caller cannot tell which fields mean anything. You recognise it by the question "which fields am I guaranteed?" having no answer short of tracing every producer. Its trait: an unset field often reads as a valid zero or empty, so a missing value becomes a confident wrong number.

## Explained
<!--meta block=explain-->

A partial object is an instance whose type does not tell you which of its fields hold real data. One class serves several uses, and each code path that builds it fills in only the part it needs, so a list view leaves out the price and a discount lookup fills only the discount. An unfilled field reads as zero or empty, which looks the same as a real zero, so a total over a missing price is a confident wrong number, not an error. It grows because a second class feels like repeating yourself, so the existing one is widened. Repair it at the type; a call-site null guard alone just moves the wrong answer elsewhere. Give each context its own type holding exactly what it guarantees, and require mandatory fields in the constructor as a [value object](../patterns/ddd/value-object.md) does. For a screen-shaped read, return a [DTO](../patterns/enterprise/dto.md), not the entity.

- **More types.** One extra class per context plus a mapper; worth it while the shapes differ in what they guarantee.
- **Mapping.** Code must convert between the types where one context hands data to another; keep that in one place.

**Example.** A Product class has name, price and discount. A list finder fills only the name, so price stays 0. A cart that should total 25.00 shows 0.00 for each item the list finder loaded, so the total is 0.00 and checkout charges the wrong amount with no error. A null check at checkout would hide it. The fix is two types: ProductSummary with id and name, and PricedProduct whose constructor demands a price. The total function accepts only PricedProduct, so passing a summary fails to compile in a statically typed language; in a dynamic one, the constructor check fails at once.

## How it happens
<!--meta block=causes-->

It arrives one reasonable decision at a time. A screen needs the same entity with fewer fields, so a second finder populates fewer of them; a report needs two extra fields, so they are added to the same class. Nobody introduces a partial object; the type simply accumulates contexts until no single statement describes what it holds.

Two things make it hard to stop. A constructor that required every field would break the contexts that do not have them, so enforcement at construction is not available until the type is split; and projection tooling makes selecting fewer columns into the same entity type a one-line change, which is cheaper than declaring a purpose-shaped type.

```mermaid caption="Why is step 5 worse than a crash? The caller at step 4 cannot tell which producer built the instance, and an unset price reads as zero rather than missing, so the failure is a plausible total, not an exception someone would investigate."
flowchart LR
    F1["findProduct"] -->|"1 fills every field"| P["Product"]
    F2["listProducts"] -->|"2 leaves price null"| P
    F3["findDiscounted"] -->|"3 fills only discount fields"| P
    P -->|"4 same type, unknown contract"| C["Caller computing a total"]
    C -->|"5 wrong number, no error"| R["Report"]
```

- **Several finders, one return type.** Each populates the subset its own caller needed, and the type's contract becomes the union of all of them with none guaranteed.
- **Optional-field creep.** A nullable field is added per new caller until most of the type is nullable, at which point the type asserts nothing at all.
- **A depth flag.** A "summary" or "full" parameter silently changes which fields come back, so the contract depends on an argument rather than on the type.
- **Detached lazy-loading proxies.** The fields exist and touching them triggers a load, so an instance separated from its source behaves exactly like a partially populated one — and fails somewhere far from where it was built.
- **Optionality pushed into a base class.** The shared fields are hoisted into a parent, which reproduces the problem one level up and adds an inheritance constraint on top.
- **A domain type used as a query result.** A read shaped for a screen is returned as the entity, so the entity's invariants are quietly not upheld by that path.

## What it costs
<!--meta block=cost-->

- **Null-reference failures in production.** They land on paths where a caller assumed a field its particular producer never set, a producer-and-caller pair tests often miss.
- **Silently wrong answers, not crashes.** Where the unset value is a valid-looking zero or empty string, the system computes and reports something plausible instead of failing.
- **Understanding one call means reading every producer.** The signature answers nothing, so the type's real contract lives only in the set of methods that build it.
- **Defensive checks spread outward.** Null guards accumulate in code that does not care about the field, and every field added multiplies them.
- **Unrelated consumers get coupled.** They share one wide type, so a change made for one appears on all of them and can break any.
- **Write-back corruption.** Where a save writes every field, saving a partly filled instance overwrites stored values with defaults, so the damage persists.

The expensive part is how fixes behave. A null guard added where the exception surfaced substitutes a default instead of restoring the missing value, so the wrong answer moves and looks fixed. Guards pile up until nobody can describe their combined effect, so only a repair at the type lasts. Weigh the saving, one class not written, against a contract readers can recover only by tracing every producer.

## Getting out
<!--meta block=mitigation-->

Give each context its own type, holding exactly the fields that context guarantees. Duplication costs less than ambiguity. This is the case where [Don't Repeat Yourself (DRY)](../principles/dry.md) is misapplied, because the two shapes look alike today and answer different questions.

Then make the invalid state unconstructable. Require the mandatory fields as constructor parameters and make the fields read-only, so an incompletely populated instance cannot exist; this is the same [validate-at-construction](../patterns/ddd/value-object.md) discipline a value object uses. Where a field is genuinely optional, use a nullable field or a distinct type that separates "not loaded" from "loaded and empty", instead of letting one default mean both.

For the query-shaped cases, stop returning the domain type. A read built for a screen is a [purpose-shaped carrier](../patterns/enterprise/dto.md), not an entity, and treating the read and write models as separate things removes the pressure that widened the type in the first place. Group related fields into small types and compose the shapes each context needs, rather than hoisting the optional ones into a base class. To find existing cases, list every producer of the type, tabulate which fields each sets, and split the type with the most consumers first. For a detached lazy proxy, load what the caller needs before the source closes and return a DTO.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Mitigated by**

- [Value Object](../patterns/ddd/value-object.md) — Validate at construction and the incompletely populated instance cannot exist
- [Encapsulation](../principles/encapsulation.md) — A type that cannot be constructed invalid cannot be partially populated
- [DTO](../patterns/enterprise/dto.md) — A purpose-shaped carrier per context beats one wide type with an unknown contract
- [CQRS](../patterns/architecture/cqrs.md) — Separating the read model from the write model removes the pressure that widened the type
- [Make Illegal States Unrepresentable](../principles/make-illegal-states-unrepresentable.md) — A type that cannot be built incomplete cannot be partially populated
- [Interface Segregation Principle](../principles/interface-segregation.md) — The coupling here runs through one wide shared type rather than a shared interface

**Threatens**

- [Active Record](../patterns/enterprise/active-record.md) — One wide entity class shared by every query is filled differently per finder

<!-- relationships:end -->
