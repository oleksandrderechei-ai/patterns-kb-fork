---
title: Aggregate
description: A cluster of objects treated as one consistency unit
area: ddd
owner: Oleksandr Derechei
tags: [domain-modeling, validation, encapsulation]
status: stable
aliases: [aggregate root]
solves: [my order total does not match the sum of its line items and I cannot find who broke it, two concurrent requests both passed the balance check and the account went negative, I do not know how much data one save is supposed to write atomically, some code path updated a child row without going through the parent and skipped the rules, every write locks half my database because the transaction touches too many tables]
---

# Aggregate

A cluster of entities and value objects bound behind one root and saved as a unit, so a rule that spans them is never left half-enforced.

## What it is
<!--meta block=description-->

A rule that spans several objects, such as an order total equal to the sum of its lines, has no owner if any code can edit a line directly. An aggregate groups the objects and lets outside code reach them only through one root. The root checks the rule on every change, and the whole group is loaded and saved as one unit.

## Explained
<!--meta block=explain-->

An aggregate is a group of objects, such as an order and its lines, that you change only through one main object, the root, so a rule spanning the group is checked in one place and saved in one transaction. Without it, any code can edit a line directly: one path adds a line and forgets the total, another writes a total from a stale read, and a customer finds the mismatch. Choose the boundary by the rules that must hold at every instant and let everything else agree later, because that choice sets how much each write locks.

- **Wide boundaries lock** A boundary around a busy field makes unrelated commands wait; split that field into its own root or budget retries.
- **Eventual agreement** Agreement between roots needs an outbox (an event row saved in the same transaction) and readers that tolerate a window of disagreement.
- **Costly redraws** Refer to other roots by id, never by object, so redrawing a boundary changes one root only.

**Example.** The rule is that an order's total never exceeds 5,000. Two clerks load order 12 at version 7 with a total of 4,200. One adds 600, the other adds 500, and each passes the check alone, though together they reach 5,300. The first save writes version 8. The second save is rejected because it was based on version 7, so that clerk reloads, sees 4,800, and the root refuses the 500 line. The cost is that retry. Putting the customer's address inside the order would make address edits collide with line edits, so the order holds only a customer id.

## How it works
<!--meta block=structure-->

```mermaid caption="External code reaches the cluster only through its root. The root checks invariants before any mutation lands; internal entities are never referenced directly from outside."
flowchart TB
    Ext["External caller"] -->|"method call, e.g. addItem"| Root["Aggregate Root"]
    Root -->|"enforce invariants, then mutate"| E1["Entity inside boundary"]
    Root -->|"replace"| V1["Value Object inside boundary"]
    Ext -.->|"blocked: no direct reference"| E1
```

## Variations
<!--meta block=variations-->

- **Reference by identity** — An aggregate holds other aggregates by ID, never by object reference, so each cluster stays small and independently transactional.
- **[Domain events on commit](./domain-event.md)** — The root records events internally as it mutates; they're published only after the transaction that saved it has actually succeeded.
- **[Event-sourced](../architecture/event-sourcing.md) aggregate** — State is rebuilt by folding a stored stream of past events rather than loaded as a snapshot; a command only ever produces new events, never a direct field write.
- **Aggregate factory** — Multi-step construction — assembling an Order from a cart, say — is delegated to a dedicated factory, so the root's constructor stays a simple, valid-by-construction call.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Invariants spanning multiple objects** are enforced in one place, not scattered across services.
- **A clear transaction boundary** — one aggregate is one atomic load and save, no partial updates.
- **[Encapsulation](../../principles/encapsulation.md)**: internal entities are hidden, so their rules can't be bypassed from outside.
- **Concurrency control stays tractable** — version or lock the root, not a web of related tables.

### Cons
<!--meta polarity=con-->

- **An aggregate that grows too large** drags unrelated data into every transaction and lock.
- **Cross-aggregate consistency becomes eventual**, which needs real machinery — events, sagas — to close.
- **Choosing the right boundary is genuinely hard**, and a wrong one is expensive to redraw later.
- **Loading a large aggregate** can pull in far more data than a single command actually needs.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several objects share an invariant** that must never be violated, like a total matching its parts.
- **You need a clear transaction boundary** for saving and loading a related cluster of data.
- **The domain has a natural grouping** that only makes sense together, like an order and its line items.

### Avoid when
<!--meta polarity=avoid-->

- **The objects share no real invariant** — plain [Entities](./entity.md) or [Value Objects](./value-object.md) suffice.
- **You're tempted to widen the boundary** "just in case" — that's exactly how aggregates balloon and lock contention appears.
- **The true consistency requirement is eventual**, not immediate — reference the other side by ID and let a [Domain Event](./domain-event.md) synchronize it later.

Prevents the smell of an [Anemic Domain Model](../../hazards/anemic-domain-model.md), where the rules that belong on the root leak into service code.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an Order aggregate root"
class Order { // aggregate root
  private readonly items: LineItem[] = [];

  addItem(sku: string, quantity: number, unitPrice: Money): void {
    if (quantity <= 0) throw new Error("quantity must be positive");
    this.items.push(new LineItem(sku, quantity, unitPrice));
  }

  get total(): Money {
    return this.items.reduce((sum, i) => sum.add(i.subtotal), Money.zero());
  }
}

// LineItem is reachable only through Order.
class LineItem {
  constructor(readonly sku: string, readonly quantity: number, readonly unitPrice: Money) {}
  get subtotal(): Money { return this.unitPrice.times(this.quantity); }
}
```

## In the wild
<!--meta block=wild-->

- **Axon Framework** — A Java class annotated @Aggregate is the only entry point for commands into its cluster; @AggregateMember marks the entities inside the boundary. {#wild-axon-framework}
- **Spring Data** — Its repositories are defined per aggregate root, and `AbstractAggregateRoot` lets the root register domain events to publish when it is saved. {#wild-spring-data-aggregate}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Aggregate boundary size** — How much sits inside one root. Wider locks more on every command; narrower pushes invariants out into service code.
- **Optimistic concurrency version** — A version field or timestamp on the root that each write checks against the loaded value, rejecting the save on mismatch. The alternative, pessimistic locks held across the transaction, trades throughput for fewer conflicts.
- **Conflict retry policy** — How many times a command is replayed when an optimistic version check fails before the failure surfaces to the caller.
- **Snapshot frequency** — For an event-sourced root, how many events accumulate before a state snapshot is written, so a load does not re-fold the entire history every time.

### Signals to watch
<!--meta polarity=signal-->

- **Version-conflict rate** — How often a save is rejected because another writer changed the same root first. A climbing rate flags a hot root.
- **Aggregate hydration cost** — Rows or bytes pulled to reconstruct one aggregate, and the time to do it. Growth signals a boundary that has ballooned.
- **Command retry count** — Retries per command driven by conflict, a proxy for contention on the hottest roots.

### Failure modes under load
<!--meta polarity=failure-->

- **Hot aggregate contention** — Commands crowd onto one root — a shared counter, say — and retries pile up until throughput collapses there.
- **Oversized aggregate** — A boundary drawn too wide loads and locks unrelated data on every command, so each write competes with everything else touching the root and transactions slow.
- **Unbounded event replay** — An event-sourced aggregate with a long history and no snapshotting re-folds thousands of events on each load, and hydration time creeps upward.

### Readiness checklist
<!--meta polarity=check-->

- Reference other aggregates by identity, never by object reference.
- Guard the root with an optimistic version and settle the conflict-retry policy before load appears.
- Publish domain events only after the aggregate transaction has committed, never inside it.
- Confirm each invariant genuinely spans the cluster; if it does not, the boundary is too wide.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Service Boundaries](../../themes/service-boundaries.md) — The strongest service candidate already on the board {#fluency-service-boundaries}
- [Event Storming](../../themes/event-storming.md) — The cluster of events sharing one consistency rule {#fluency-event-storming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Repository](../enterprise/repository.md) — One repository per aggregate root
- [Domain Event](./domain-event.md) — Aggregates emit domain events on change
- [Encapsulation](../../principles/encapsulation.md) — Applies encapsulation to a cluster of objects rather than to one
- [Law of Demeter](../../principles/law-of-demeter.md) — An aggregate root is the only object others may call, which keeps the chain of dots short
- [Specification](../enterprise/specification.md) — Specifications express rules that span or select aggregates.
- [Context Map](./context-map.md) — An aggregate's visibility to other contexts is a decision made on the context map
- [Domain Service](./domain-service.md) — Cross-aggregate rules that no root owns live in a domain service
- [Event Sourcing](../architecture/event-sourcing.md) — An aggregate can persist as the events it emitted, not a row

**Alternative to**

- [Transaction Script](../enterprise/transaction-script.md) — Behaviour on the model vs. one procedure per business transaction

**Composed of**

- [Entity](./entity.md) — An aggregate is a graph of entities and values
- [Value Object](./value-object.md) — Values live inside the aggregate boundary

**Part of**

- [Bounded Context](./bounded-context.md) — An aggregate's invariants hold inside one context's model

**Often confused with**

- [Iterator](../gof/behavioral/iterator.md) — Same word, two senses: a consistency boundary here, the collection an iterator walks there

**Prevents**

- [Anemic Domain Model](../../hazards/anemic-domain-model.md) — Behavior on the aggregate keeps the model rich

<!-- relationships:end -->
