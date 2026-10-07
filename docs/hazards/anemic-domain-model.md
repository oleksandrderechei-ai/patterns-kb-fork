---
title: Anemic Domain Model
description: Data objects with no real behavior of their own
area: hazards
owner: Oleksandr Derechei
tags: [anti-pattern, encapsulation, validation, code-smell]
status: stable
aliases: [anemic model, anemic domain]
solves: [my domain classes are nothing but getters and setters, the same validation rule is copy-pasted across three service classes, any caller can set a total to a negative number and nothing refuses it, business rules live in services while the entities are just data bags]
---

# Anemic Domain Model

Data objects with no real behavior of their own — every field has a getter and setter, but the rules that make sense of them all live somewhere else.

## What it is
<!--meta block=description-->

An anemic domain model is a set of classes named after business concepts, such as Order or Invoice, that hold fields but enforce no rules. The logic lives in services that reach in and change the fields. You recognize it by classes with a long run of getter-setter pairs and no method that expresses a rule, or a total any caller can set negative. The defining trait is that the object no longer protects its own consistency.

## Explained
<!--meta block=explain-->

An anemic domain model is a set of classes named after real business things, such as Order or Invoice, that hold fields but enforce no rules. The rules live in separate service classes that reach in and change the fields. Teams fall into it because layered designs put data and logic in separate tiers, code generators make one class per table, and each new rule follows the path the last one took. Every service then writes the same check a little differently, and anything holding the object can put it in a state the business forbids. Choose a rich model where rules are real and keep changing, such as pricing. Keep a plain script for a bulk import that holds no shared rule. The way out is to move one rule at a time into a named method on the object it is about, send callers through that method, then delete the setter it replaced.

- **Mapping friction.** A rich object can be harder to map to a table, so put a mapper between them and budget for it.
- **Orphaned cross-object rules.** A rule spanning two objects with no owner goes in a named service; keep that list short enough to recite.

**Example.** Four services set an order's discount: checkout, admin, refunds and a nightly import. Each copies the rule "discount at most 30%". Marketing cuts the cap to 25%, and the team edits three services but misses the import. The import loads 200 orders a night averaging 100 euros, each carrying up to 5 euros too much discount, so the company loses up to 1,000 euros a night until someone notices. The fix is one method, \`Order.applyDiscount(percent)\`, that refuses anything over 25. You move the four callers onto it, then delete \`setDiscount\`. The next cap change is one edit.

## How it happens
<!--meta block=causes-->

```mermaid caption="The reinforcing loop: each rule added to a service makes the next one land there too."
flowchart TB
    A["New business rule needed"] -->|"add to a service, easier to test"| B["Add it to a Service method"]
    B -->|"no behavior lands on the entity"| C["Entity keeps only getters and setters"]
    C -->|"the path is carved"| D["Next rule follows the same shortcut"]
    D -->|"another rule appears"| A
    D -->|"logic accretes outside"| E["Entity becomes a passive record"]
```

- Layered-architecture conventions split "data" and "logic" into separate tiers, so entities hold state and services hold behavior by default.
- ORMs (object-relational mappers) and code generators scaffold entities as one-field-one-column classes, reinforcing the idea that an entity is a row wrapper, not a model; frameworks that need a no-arg constructor and public setters push state public too.
- Testing a plain data class is trivial and testing a service in isolation is straightforward, so logic gravitates toward services for the sake of easy tests.
- The same class gets reused as an API payload, a persistence record, and a domain object, so behavior is stripped out to keep it a neutral, serializable shape.
- No one owns the question of where a rule belongs, so each new rule just follows the path the last one carved.
- The model is built from the database schema rather than from the business, so the classes are tables with getters and there was never a place for behaviour to go — which is also why [Active Record](../patterns/enterprise/active-record.md) and [Transaction Script](../patterns/enterprise/transaction-script.md) so often appear alongside it.

## Why it hurts
<!--meta block=cost-->

- Business rules get duplicated across every service that touches the entity, because there is no single method to call, so each caller re-implements the check slightly differently.
- Invariants are not guaranteed. Any code holding a reference can set a field to a value the domain would never allow, because nothing on the object refuses it.
- Domain knowledge moves into procedural method bodies instead of named domain concepts, so the ubiquitous language the team agreed on stops matching the code.
- Behavior tests end up exercising the [service layer](../patterns/enterprise/service-layer.md), not the entity, so the entity itself has no enforced contract and can drift silently as fields are added.
- Moving or fixing a rule means hunting down every service that duplicated it, instead of changing one method in one place.
- The model still costs what a domain model costs, the object graph and the mapping layer that keeps it in step with the database, while the behavior that would repay that cost sits in services. The team pays for a domain model and gets a [transaction script](../patterns/enterprise/transaction-script.md).
- It is self-reinforcing: a rich method looks out of place next to a hundred plain accessors, so the next rule lands in the service layer too.
- The real choice is to enrich the model or drop it for a script that admits what it is.

## How to avoid it
<!--meta block=mitigation-->

Move one rule at a time, and start with the one you have already had to fix twice. Find every place that check is written, by searching each setter's callers and the rule's literal value; give the class the rule is about a named method that does it, and send those callers through the method. The duplication is what is costing you this month, and one method ends it. The rest of the class can wait. Start where two or more copies exist. Leave scripts and stable CRUD alone, and enrich only where rules change often.

Close the door behind each move, in that order: add the method, migrate the callers, then delete the setter it replaced. A setter left in place is a route around the rule, and a route around the rule is how the second copy gets written. Leave persistence until last, and put a mapper between the table and the model, so the shape the rules want is not negotiated with the schema every time.

Decide where a rule that spans two objects lives, before it decides itself. Such a rule has no owner among them, so give it a named domain service and keep that a list you can recite, rather than the tier everything drifts back into. Move the tests with the behaviour too: while the only test of a rule runs through the service, the object has no enforced contract, and the next field added to it can break one quietly.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Primitive Obsession](./primitive-obsession.md) — Entities made of bare primitives and no behaviour are the usual shape of an anemic model

**Often confused with**

- [Transaction Script](../patterns/enterprise/transaction-script.md) — Same procedures over data-only classes, but chosen on purpose because the logic is simple

**Mitigated by**

- [Aggregate](../patterns/ddd/aggregate.md) — Behavior on the aggregate keeps the model rich
- [Data Mapper](../patterns/enterprise/data-mapper.md) — Keeping SQL out of the model removes the pressure to flatten it
- [Encapsulation](../principles/encapsulation.md) — The anaemic model is precisely what its absence produces: public state, rules elsewhere
- [Entity](../patterns/ddd/entity.md) — Behaviour on the entity, not only on the aggregate, keeps the model rich.

**Threatens**

- [Domain Service](../patterns/ddd/domain-service.md) — Services that absorb all behaviour are the usual route to an anemic model
- [Active Record](../patterns/enterprise/active-record.md) — An active record is a row-shaped class with a setter per column, so rules drift out into services
- [Service Layer](../patterns/enterprise/service-layer.md) — A service layer that holds all the rules turns the domain classes into bags of fields
- [DTO](../patterns/enterprise/dto.md) — Field-only data transfer object (DTO) classes are easily reused as the domain model, and the rules then live elsewhere
- [Entity](../patterns/ddd/entity.md) — An entity reduced to fields and accessors is the anemic form

<!-- relationships:end -->
