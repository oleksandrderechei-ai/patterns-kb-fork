---
title: Bounded Context
description: A model's boundary of validity and meaning
area: ddd
owner: Oleksandr Derechei
tags: [domain-modeling, boundaries, decoupling]
status: stable
aliases: [BC]
solves: [everyone says customer but each team clearly means something different, our shared User class has thirty nullable fields because every team bolted theirs on, I cannot change one field without breaking four other teams services, every release needs sign-off from three teams because we all share one model, the same word means different things in different parts of my code and bugs follow]
---

# Bounded Context

Marks the boundary inside which a domain model's terms, rules, and invariants hold exactly one meaning — and beyond which the same word is free to mean something else entirely.

## What it is
<!--meta block=description-->

No single model serves every subdomain: one shared Order class forced to fit sales, shipping and support fills with flags and empty fields. A bounded context is a boundary, such as a service or module, inside which a term like Order has one meaning, one set of rules and one implementation. Each seam to another context becomes a decision you make on purpose, write down and keep paying for.

## Explained
<!--meta block=explain-->

A bounded context is a line around one part of your system inside which each word has one meaning, so a term like Order is modelled once per context instead of once for everybody. Without lines, one shared Order class has to serve sales, shipping and support, and fills with flags and empty fields that only some callers understand. Prefer a few wide contexts early and split only when the vocabulary actually forks. Pay for each seam, the point where two contexts meet, on purpose: use an [anti-corruption layer](acl.md) only where the two languages really differ, and where they do not, adopt the other side's model as it is.

- **Wrong line** A wrong boundary must be undone at every integration point at once, so split only when the vocabulary actually forks.
- **Seam code** Every seam needs translation code; keep it where two languages really differ.
- **Duplicated data** Each context stores copies of published facts in its own shape, updated from events, and never queries across the line.
- **Unenforced line** A line held only in a document erodes; enforce it with a separate schema and deploy.

**Example.** Sales needs an order with line items and a discount: 9 fields. Shipping needs the same order as parcels, weights and a destination: 8 fields. One shared Order would carry 17 fields, and neither team would use more than 9. With two contexts, Sales publishes OrderConfirmed with sku, quantity and address, and Shipping stores its own copy through a translator of about 12 lines that looks up weights in Shipping's own catalog. The cost is delay and duplication: if Sales corrects the address, Shipping learns seconds later, so a parcel already packed keeps the old address and needs a recall step.

## How it works
<!--meta block=structure-->

```mermaid caption="Two contexts, two different \"Order\" models. Nothing crosses the boundary untranslated."
flowchart LR
    subgraph SalesCtx[Sales Context]
        SM["Order, priced & discounted"]
    end
    subgraph ShipCtx[Shipping Context]
        PM["Order, weight & destination"]
    end
    SM -->|ACL translates at the boundary| PM
```

## Variations
<!--meta block=variations-->

- **Shared Kernel** — Two teams deliberately share a small, jointly-owned subset of the model — changes to it require both teams' consent.
- **Customer-Supplier** — An upstream context's team commits to meeting a downstream team's needs, with a formal process for negotiating changes.
- **Conformist** — The downstream context simply adopts the upstream model as-is, with no translation — cheap, but you inherit upstream's quirks.
- **[Anti-Corruption Layer](./acl.md)** — The downstream context keeps its own model and translates the upstream one at the boundary, refusing to let foreign concepts leak in.
- **Open Host Service / Published Language** — A context exposes a stable, well-documented protocol for many consumers at once, rather than negotiating a bespoke integration per client.
- **Separate Ways** — Two contexts have no integration at all — duplicating a little logic is cheaper than coupling two models that barely overlap.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Keeps each team's model coherent** — no cross-team compromise language creeping in.
- **Contexts evolve**, deploy, and release independently of one another.
- **The ubiquitous language stays precise**: a term means exactly one thing inside a boundary.
- **Lines up naturally with team and service boundaries**, so ownership stays unambiguous.

### Cons
<!--meta polarity=con-->

- **Drawing the wrong boundary** is expensive to fix later — it touches every integration point.
- **Every seam between contexts needs explicit mapping** or translation, which is real code to maintain.
- **A shared database across contexts** quietly erodes the boundary until it's meaningless.
- **Some duplication of data and logic** across contexts is deliberate, but it isn't free.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The domain is large enough** that one model can't stay consistent across all of it.
- **Different teams already use the same word** to mean genuinely different things.
- **You need a separately owned boundary** — a service, module, or team can own and evolve it independently.

### Avoid when
<!--meta polarity=avoid-->

- **The domain is small enough** that one shared model serves everyone without strain.
- **You're not yet sure where the real seams** are — a premature boundary ossifies into a wrong one.
- **Splitting now would fragment a team** that still needs to reason about the whole model together.

Prevents the slide into a [Big Ball of Mud](../../hazards/big-ball-of-mud.md), where models merge and every term means something different depending on who's reading the code.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — two contexts, two \"Order\" models"
// Sales context: its own Order shape and language
namespace Sales {
  export interface Order {
    id: string;
    lineItems: { sku: string; qty: number; unitPriceCents: number }[];
    discountCents: number;
  }
}

// Shipping context: a different "Order", same real-world thing
namespace Shipping {
  export interface Order {
    id: string;
    parcels: { sku: string; qty: number; weightGrams: number }[];
    destination: { line1: string; postcode: string };
  }
}
```

```typescript summary="TypeScript — translating at the seam"
// Translation lives at the boundary, not inside either model
function toShippingOrder(
  order: Sales.Order,
  weightBySku: Map<string, number>,
  destination: Shipping.Order["destination"],
): Shipping.Order {
  return {
    id: order.id,
    parcels: order.lineItems.map((li) => ({
      sku: li.sku,
      qty: li.qty,
      weightGrams: weightBySku.get(li.sku) ?? 0,
    })),
    destination,
  };
}
```

```typescript summary="TypeScript — the seam as an anti-corruption layer"
type OrderConfirmed = {
  orderId: string;
  lines: { sku: string; qty: number }[];
  address: Shipping.Order["destination"];
};

// Shipping's own catalog holds the weights; an unknown SKU is an error, not 0 grams
function onOrderConfirmed(e: OrderConfirmed, catalog: Map<string, number>): Shipping.Order {
  return {
    id: e.orderId,
    parcels: e.lines.map((l) => {
      const weightGrams = catalog.get(l.sku);
      if (weightGrams === undefined) throw new Error("unknown SKU " + l.sku);
      return { sku: l.sku, qty: l.qty, weightGrams };
    }),
    destination: e.address,
  };
}
```

## In the wild
<!--meta block=wild-->

- **Eric Evans, Domain-Driven Design** — The 2003 book that introduced Bounded Context as the boundary within which one model and one language hold, together with the context map that relates contexts. {#wild-evans-bc}
- **Context Mapper** — An open-source modelling tool and domain-specific language (DSL) for domain-driven design that describes bounded contexts and the relationships between them as a context map. {#wild-context-mapper}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Where the boundary falls** — Drawn where a term changes meaning, where a team owns the language, or where data has one owner. A boundary cut along technical layers fails all three tests.
- **Relationship between two contexts** — Shared kernel, customer-supplier, conformist, anti-corruption layer or published language. Each sets who bends to whom when the other changes.
- **Deployment and data separation** — Whether a context has its own deployable and its own schema. Separate schemas make the boundary real; one shared schema makes it a convention.

### Signals to watch
<!--meta polarity=signal-->

- **Cross-context imports and joins** — Direct imports or queries from one context into another's internals. Each one is a boundary breach to review. Fail CI on imports that cross a context directory except through its published interface, and search SQL for another context's tables.
- **Pull requests touching two contexts** — A high share means the boundary is in the wrong place or the contexts are coupled through a shared model. Count pull requests per month whose changed paths span two context directories; a rising trend against the share when the contexts were drawn matters more than a fixed figure.
- **Contract-test failures at the boundary** — Breaks in the published interface between contexts, caught before release.

### Failure modes under load
<!--meta polarity=failure-->

- **Integration through the database** — Two contexts read each other's tables. A column rename in one breaks the other with no interface to warn you.
- **Shared model creep** — A common library of domain types grows until every context depends on it, and one change forces all of them to deploy.
- **One word, two meanings, one class** — A single `Customer` type serves billing and support, and every new field serves one side and confuses the other.
- **Stale context map** — The map no longer matches the code, so teams plan against relationships that no longer exist.

### Readiness checklist
<!--meta polarity=check-->

- Each context has a named owning team and a glossary of its terms
- No context reads another's tables or private types
- The context map names the relationship type on every edge and is reviewed when integrations change
- Cross-boundary calls go through a published interface with translation at the edge

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Service Boundaries](../../themes/service-boundaries.md) — The first cut — a service never spans two of these {#fluency-service-boundaries}
- [Event Storming](../../themes/event-storming.md) — Where the language changes along the timeline {#fluency-event-storming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Anti-Corruption Layer](./acl.md) — An anticorruption layer (ACL) guards a context's boundary
- [Domain Event](./domain-event.md) — Contexts talk by publishing facts, not by sharing a model
- [Partition Around Limits](../../principles/partition-around-limits.md) — A context boundary is a partition the domain hands you for free
- [Design for Evolution](../../principles/design-for-evolution.md) — The context is the boundary that keeps a change local
- [Functional Partitioning](../distributed/routing/functional-partitioning.md) — Giving each context its own store is how the model boundary becomes a physical one rather than a convention
- [Conway's Law](../../principles/conways-law.md) — A context boundary holds only if the team boundary matches it.
- [High Cohesion, Low Coupling](../../principles/high-cohesion-low-coupling.md) — A bounded context is high cohesion and low coupling drawn at the scale of a team
- [Context Map](./context-map.md) — A context map draws the contexts and names the relationship between each pair.

**Alternative to**

- [Canonical Data Model](../messaging/canonical-data-model.md) — Lets each context keep its own model and translate at the border

**Enables**

- [Microservices](../architecture/microservices.md) — The context boundary is what a service boundary is drawn from.

**Composed of**

- [Aggregate](./aggregate.md) — Its model is drawn as aggregates, each with one meaning

**Prevents**

- [Big Ball of Mud](../../hazards/big-ball-of-mud.md) — Boundaries keep models from merging into mud
- [Monolithic Persistence](../../hazards/monolithic-persistence.md) — A context that owns its store is what stops every kind of data pooling into one
- [Distributed Monolith](../../hazards/distributed-monolith.md) — Splitting on layers instead of contexts is how a system ends up distributed and still monolithic.

<!-- relationships:end -->
