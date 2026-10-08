---
title: Context Map
description: One diagram of every bounded context and the relationship between each pair
area: ddd
owner: Oleksandr Derechei
tags: [domain-modeling, boundaries]
status: stable
solves: [two teams changed a shared model and broke each other without warning, we cannot tell which team has to adapt when another team changes its data, a legacy system bleeds its odd model into everything that calls it, teams argue about who owns an integration because nobody wrote down who depends on whom]
---

# Context Map

A context map is the drawn, kept-current picture of every bounded context in a system and the named relationship between each pair of them, so that who depends on whom, and who must adapt, is a decision the teams can see.

## What it is
<!--meta block=description-->

Teams on a large system use the same words for different things and lean on each other's models without saying so, so an integration breaks the day one side changes. A context map names every bounded context and draws the relationship between each pair: who is upstream, who adapts, and who translates. It turns hidden team dependencies into decisions you can see, discuss and change.

## Explained
<!--meta block=explain-->

A context map is one diagram that lists every [bounded context](./bounded-context.md) in your system and labels the line between each pair that integrates: which side is upstream, which is downstream, and what the downstream side does about it (negotiate, conform, translate, or cut the link). Draw it from how the teams really work today, not from how you wish they did. Without it, each integration is an accident: a team finds out it was downstream of another only when that team changes a field. With it, you decide where to pay for an [anticorruption layer](./acl.md), where to demand a contract, and where to accept the other model. Choose it over a plain architecture diagram when the question is who has to adapt, since a box-and-arrow diagram shows traffic and not power.

- **It goes stale.** Teams and contracts change faster than diagrams; give one named owner a quarterly review and date the map.
- **It records what is, not what you want.** Draw the relationships that exist, including conformist ones you dislike, then plan to change them.
- **Labels hide mismatches.** Both teams may say partnership while one behaves as supplier; ask each side to name its own role.

**Example.** A shop has Sales, Billing and a 15-year-old ERP. The first map shows Billing conforming to the ERP's customer record, which has 42 fields and three meanings of status. Every ERP release in the last year broke Billing, four times in all. The team marks that line conformist, then buys a two-week anticorruption layer that maps the ERP record to a 9-field Billing customer. The next ERP release changes 6 fields and touches one mapper. The map also shows Sales and Billing as customer-supplier, so Sales now reviews Billing's invoice requests in planning. The cost: a mapper to maintain, Sales' planning time, and one more diagram to review each quarter.

## How it works
<!--meta block=structure-->

You draw one box per [bounded context](./bounded-context.md) and one line per pair that has to exchange anything, then label each line with the relationship. Mark which end is upstream; partnership and shared kernel have none, because both sides change together. Upstream's model drives the interface; how far downstream can steer it depends on the label. The labels come from the domain-driven design catalogue, and each says who adapts and who bears the cost of change. The anticorruption layer sits on the downstream side, open host service and published language on the upstream side.

```mermaid caption="How does a team find out who has to adapt when a model changes? Each line carries a relationship, and the arrow runs from upstream to downstream."
flowchart LR
    Sales["Sales"]
    Billing["Billing"]
    Shipping["Shipping"]
    Legacy["Legacy ERP"]:::ext
    Reporting["Reporting"]
    Sales -->|"1 customer-supplier"| Billing
    Sales -->|"2 open host service + published language"| Shipping
    Legacy -->|"3 anticorruption layer"| Billing
    Legacy -->|"4 conformist"| Reporting
    Shipping -.->|"5 separate ways"| Reporting
    classDef ext stroke-dasharray:4 4
```

Read each line as a sentence: "Billing is downstream of Sales, and Sales plans for Billing's needs." The map does not describe code. It describes teams and the power between them. It changes when the organisation does, not when a class does.

## Variations
<!--meta block=variations-->

- **Partnership** — Two contexts succeed or fail together, so their teams plan and release in step and share the cost of any interface change. Use it when neither side can ship without the other.
- **Shared kernel** — Two contexts own a small slice of model and code in common, changed only by agreement and tested by both. It saves duplication and couples the two teams' release schedules.
- **Customer-supplier** — Upstream treats downstream as a customer: it takes the downstream team's needs into its plan and negotiates the contract. Downstream has a voice, and upstream accepts the duty.
- **Conformist** — Downstream adopts the upstream model as it is, because upstream will not change for it. It is the cheapest to build, gives your model no protection, and every upstream change lands in it.
- **[Anticorruption layer](./acl.md)** — Downstream translates the upstream model into its own at the border, which keeps a poor or shifting upstream model out of your own, at the price of a mapper you maintain.
- **Open host service** — Upstream publishes one well-defined protocol for everyone who integrates, instead of a custom bridge for each consumer.
- **Published language** — A documented, shared exchange format, such as a schema or a standard, that both sides translate to and from. It usually travels with an open host service.
- **Separate ways** — The two contexts do not integrate at all. Where the link would cost more than duplicating a little functionality, you cut it.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Makes team dependencies visible.** A surprise break between two services becomes a labelled line someone owns.
- **Forces an honest choice per boundary.** Naming a relationship makes the team decide who adapts, instead of drifting into one.
- **Shows where to invest in protection.** Every conformist line to a model you dislike is a candidate for an anticorruption layer.
- **Gives newcomers the system's real shape** in one page, which no code listing shows.

### Cons
<!--meta polarity=con-->

- **Goes stale.** A map nobody updates can mislead, because readers trust it.
- **Describes politics as well as code.** A relationship you wish you had is not the one you have, so draw the real one first.
- **Needs bounded contexts to exist.** In a single shared model there is nothing to map, and drawing one only records the mud.
- **Labels can hide a mismatch.** Two teams may both call the line a partnership while one acts as the supplier.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several teams own several models** and their integrations keep breaking in surprising places.
- **You are splitting a monolith** and need to decide which seams get translation and which get a shared contract.
- **A legacy system sits beside a new one** and you must say who adapts to whom.
- **You are planning a reorganisation** and want to see which team boundaries cut across tight coupling.

### Avoid when
<!--meta polarity=avoid-->

- **One team owns one model.** There are no boundaries to map, and the diagram is decoration.
- **You have not named the bounded contexts yet.** Draw those first, because a map of unclear boxes encodes the confusion.
- **Nobody will own the review.** Skip the map rather than let it rot.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a context map as data: ask who must hear about a change to one context"
type Relationship =
  | "partnership" | "shared-kernel" | "customer-supplier" | "conformist"
  | "anticorruption-layer" | "open-host-service" | "published-language" | "separate-ways";

interface Edge { upstream: string; downstream: string; kind: Relationship }

const map: Edge[] = [
  { upstream: "Sales",  downstream: "Billing",   kind: "customer-supplier" },
  { upstream: "Sales",  downstream: "Shipping",  kind: "open-host-service" },
  { upstream: "Legacy", downstream: "Billing",   kind: "anticorruption-layer" },
  { upstream: "Legacy", downstream: "Reporting", kind: "conformist" },
  { upstream: "Shipping", downstream: "Reporting", kind: "separate-ways" },
];

// Who must react when `context` changes its model? Separate ways is recorded only to show a decided non-link, so it is filtered out.
function mustReact(context: string): { who: string; unprotected: boolean }[] {
  return map
    .filter(e => e.upstream === context && e.kind !== "separate-ways")
    .map(e => ({
      who: e.downstream,
      unprotected: e.kind === "conformist",   // no translation layer: a change lands as is
    }));
}

mustReact("Legacy");
// [{ who: "Billing", unprotected: false }, { who: "Reporting", unprotected: true }]
```

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Service Boundaries](../../themes/service-boundaries.md) — Record how each pair of bounded contexts relates on a single map. {#fluency-service-boundaries}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Anti-Corruption Layer](./acl.md) — An anticorruption layer (ACL) is the relationship drawn on a line where the downstream context translates the upstream model
- [API Gateway](../distributed/routing/api-gateway.md) — An open host service on the map is often realised as an application programming interface (API) gateway
- [Aggregate](./aggregate.md) — Each context on the map holds its own aggregates and exposes only some of them
- [Bounded Context](./bounded-context.md) — Each box on the map is one of these.
- [Conway's Law](../../principles/conways-law.md) — The map records which team boundaries the system's structure follows, and where they cut across tight coupling.
- [Conway's Law](../../principles/conways-law.md) — Conway's law explains why the map's team and context lines drift apart

<!-- relationships:end -->
