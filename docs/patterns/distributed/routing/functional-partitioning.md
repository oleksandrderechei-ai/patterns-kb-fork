---
title: Functional Partitioning
description: "Give each business area its own store, sized and tuned for how that area is used"
area: distributed-scale
owner: Oleksandr Derechei
tags: [partitioning, boundaries]
status: stable
aliases: [partition by bounded context, database per service, subject-area partitioning]
solves: [a monthly report scans the audit tables and checkout slows to a crawl, one database holds four unrelated business areas and is sized for all of them at once, "the catalogue wants a search index and the orders want transactions, and they share a server", "backups run to the strictest policy any table needs, which costs us for everything", one area of the product needs its data to stay in a region and the query filter keeps being forgotten]
---

# Functional Partitioning

Divides data by what it is for rather than by key or by column: invoices in one store, inventory in another, each drawn along a bounded context. Every area then gets the store, the capacity and the operational treatment its own access pattern deserves, and one area's load stops being every area's problem.

## What it is
<!--meta block=description-->

Functional partitioning gives each business area its own data store, along a bounded context, so order capture, the catalogue and audit history stop competing for one database. It is the third axis beside sharding, which splits rows, and vertical partitioning, which splits columns. Each store is sized and tuned for its own job. You give up joins and transactions across the boundary, so the boundary must fall where such queries are rare.

## Explained
<!--meta block=explain-->

Functional partitioning gives each business area its own data store, so orders, the product catalogue and audit history no longer share one database. The areas want different things: order capture is write-heavy and needs transactions, the catalogue is read-heavy and wants search, and audit history is huge and read once a quarter. In one database they fight over the same memory, connections and maintenance window, so a report that scans a year of history slows checkout. Split by function, each store is sized, tuned and backed up for its own job. Choose it over sharding when the trouble is that areas disturb each other, not the volume inside one area.

- **Cross-area queries.** They become two queries and a merge in your code, so draw the boundary along a bounded context, one coherent business model.
- **No shared transaction.** A write across areas needs a saga, a chain of steps with an undo for each.
- **Stale copies.** Shared reference data is copied into each partition and is briefly stale after a change, so set an accepted staleness.
- **Costly boundary.** Moving it later is expensive, so wait until the areas are clear.

**Example.** Illustrative figures: One 1 TB database holds 50 GB of orders, 20 GB of catalogue and 930 GB of audit history. A nightly audit report scans the history, pushes the orders out of memory, and checkout latency goes from 40 ms to 400 ms for two hours. After moving audit history to its own store, the report cannot touch checkout. The cost: an order page showing product names is now two queries, one to each store, merged in code, and placing an order while reducing stock needs a saga with a restock step as its undo.

## How it works
<!--meta block=structure-->

```mermaid caption="What does each partition buy, and what does it cost? Each area gets a store sized and tuned for its own pattern — and any question spanning two areas becomes two queries plus a merge you write, which is why the boundary must fall where those questions are rare."
flowchart LR
    A["Application"]:::ext
    subgraph Parts["One store per bounded context"]
        O[("Orders<br/>write-heavy, transactional")]
        P[("Catalogue<br/>read-heavy, search-shaped")]
        H[("History<br/>append-only, cheap")]
    end
    M["Merge in the application"]
    A -->|"1 place an order"| O
    A -->|"2 browse products"| P
    A -->|"3 archive the event"| H
    A -->|"4 an order plus its product needs both"| M
    M -->|"5 query orders"| O
    M -->|"6 query catalogue, then join in code"| P
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="How does a write that crosses the boundary stay correct? It stops being a transaction and becomes a sequence with compensations — published from an outbox, so the state change and the event announcing it cannot diverge."
sequenceDiagram
    participant A as Order service
    participant O as Orders store
    participant B as Inventory service
    participant I as Inventory store
    A->>O: write the order and an outbox row in one transaction
    A->>B: OrderPlaced, published from the outbox
    B->>I: decrement stock
    I--xB: insufficient stock
    B->>A: StockRejected
    A->>O: compensate — cancel the order
    Note over A,I: no transaction spans the two stores
```

## Variations
<!--meta block=variations-->

- **Split by [bounded context](../../ddd/bounded-context.md)** — The default. Each partition holds one coherent domain model with its own language and invariants. Where the contexts are well drawn, most queries and transactions stay inside one partition. It presumes the contexts have actually been identified — split by table ownership or by team roster instead and you get the costs without the isolation.
- **Read-only reference split from read-write data** — The smallest useful version: catalogues, rate tables and taxonomies move to their own store, away from the transactional data that changes constantly. The reference side can be cached hard, replicated widely and served read-only, because nothing in the request path writes to it. It needs a defined publication process, since read-only means changes arrive on a schedule rather than never.
- **Split by store technology** — The boundary follows what each area needs from a store rather than what it means — relational for anything with real invariants, a search index for text queries, a time-series store for metrics, [object storage](./object-storage.md) for large content. Each area stops being compromised by a store chosen for someone else's workload. You are now operating several technologies, and each is a separate thing to back up, patch and be woken up by.
- **Split by criticality or retention** — Data is grouped by how much it matters and how long it must live: transactions with frequent backups and tight recovery objectives, logs and traces with a cheap tier and a short life. Backup cost, recovery time and storage class stop being set by the most demanding data in a shared store. The classification has to be maintained, because data changes criticality faster than anyone updates the schema.
- **Split by residency or tenancy** — The partition follows a jurisdiction or a tenant — one store per region for data that may not leave it, or a dedicated store for a customer whose contract demands isolation. It turns a compliance requirement into a topology fact rather than a predicate every query must remember. It multiplies the number of deployments you operate, and any genuinely global question becomes a fan-out with a merge.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Each area gets a store** chosen and sized for its own access pattern instead of a compromise sized for the sum.
- **A heavy query is confined** to the area that issued it, so one team's report does not slow another team's checkout, provided the stores share no hosts, pools or network. Cross-area reads still load both.
- **Backup frequency**, retention, recovery objectives and storage class become per-area decisions rather than one policy for everything.
- **A store failing takes out** one area rather than the whole system, so degradation is partial for requests that stay inside one area, provided callers handle the missing area with a fallback or timeout. A request that reads across areas still fails.
- **Sensitive or residency-bound data** can be isolated by topology, so compliance stops depending on every query remembering a filter.

### Cons
<!--meta polarity=con-->

- **Any query spanning two areas** becomes two queries and a merge in application code, which is slower and is now yours to keep fast, and the two reads come from different points in time, so the merged view can be inconsistent.
- **No transaction covers two stores**, so a write across areas needs compensating steps instead of a commit.
- **Referential integrity across the boundary is unenforced**, so dangling references become something you detect rather than something you prevent.
- **Reference data replicated** into every partition has to be kept in step, and each copy is briefly wrong after every change.
- **The boundary is costly to move** — moving a table between areas is a migration, a code change and a contract change at once.
- **Several store technologies means several things to operate**, patch and be paged for, and the on-call surface grows with the split.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Distinct business areas share** one store and have visibly different access patterns.
- **Work in one area** is already degrading another through a shared buffer pool, connection pool or maintenance window.
- **The bounded contexts are known**, and the queries that cross them are already rare.
- **Retention, backup or residency requirements** differ enough that one policy is wrong for most of the data.

### Avoid when
<!--meta polarity=avoid-->

- **The domain is small and highly interconnected**, where nearly every question spans areas and the split adds a merge to all of them.
- **The boundaries are still being discovered**, where splitting now freezes a guess into a migration.
- **Strong cross-area transactional guarantees** are genuinely required and compensation is not an acceptable substitute.
- **The pressure is volume within one area**, where sharding that area is the axis that helps.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — one connection per area, and the cross-boundary read made explicit"
// One handle per functional partition: no connection can see both schemas,
// so a cross-boundary query cannot be written by accident.
const orders    = connect(process.env.ORDERS_DSN);      // transactional, write-heavy
const catalogue = connect(process.env.CATALOGUE_DSN);   // read-heavy, search-shaped
const history   = connect(process.env.HISTORY_DSN);     // append-only, cheap tier

// INSIDE a partition everything is ordinary — including transactions.
export async function placeOrder(cmd: PlaceOrder) {
  return orders.tx(async (t) => {
    const order = await t.insertOrder(cmd);
    // Outbox row in the SAME transaction: the write and its announcement cannot diverge.
    await t.insertOutbox({ type: "OrderPlaced", orderId: order.id, sku: cmd.sku });
    return order;
  });
}

// ACROSS partitions there is no join: two queries and a merge, batched by key.
// Per-row lookups here are how a functional split ends up slower than what it replaced.
export async function orderWithProduct(orderId: string) {
  const order    = await orders.findOrder(orderId);
  const products = await catalogue.findProductsByIds([order.sku]);
  return { ...order, product: products.get(order.sku) ?? UNKNOWN_PRODUCT };
}

// Reference data every area uses is REPLICATED into each partition, not joined
// from a shared one: no hot spot, at the price of briefly stale copies.
export async function onTaxonomyPublished(version: TaxonomyVersion) {
  await Promise.all([orders.upsertTaxonomy(version), catalogue.upsertTaxonomy(version)]);
}
```

## In the wild
<!--meta block=wild-->

- **Database per service** — The microservice convention is functional partitioning made a rule: each service owns its own store and no other service reads it directly. It is what makes independent deployment real, and it is why cross-service reads become API calls or maintained views. {#wild-database-per-service}
- **Amazon service-oriented mandate** — Amazon is the widely documented early example of forbidding direct access to another team data store and requiring a service interface instead — the organisational rule that makes the functional boundary hold in practice. {#wild-amazon-service-oriented}
- **Regional data residency deployments** — Regulations that forbid personal data leaving a jurisdiction are commonly satisfied by a store per region rather than a column filter, turning the requirement into topology that cannot be forgotten in a query. {#wild-data-residency}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Where the boundary falls** — The one decision that determines whether this pays. Cut where cross-area queries and writes are already rare, and you are making an existing seam explicit rather than inventing one.
- **Store technology per area** — What each partition runs on, chosen for its own access pattern. Each additional technology is another thing to patch, back up and be paged for, so the isolation has to be worth the operational surface.
- **Reference data replication lag** — How stale a replicated copy of shared reference data is allowed to be. Tighter means more synchronisation traffic; looser means each area is briefly working from a different taxonomy. Start from the longest period two areas can disagree without harm, such as a price or tax change window, and alert when the signal-3 age exceeds it.
- **Cross-area read strategy** — Whether a question spanning areas is answered by a fan-out at request time or from a view maintained off events. The view costs storage and staleness and removes a synchronous dependency.
- **Per-area retention and backup policy** — Frequency, retention and storage class per partition. The point of the split is that these stop being one policy set by the most demanding data.

### Signals to watch
<!--meta polarity=signal-->

- **Cross-partition query rate** — How many requests need more than one area, as a share of all requests. Record the share before the split and treat a sustained rise from that baseline as the sign the boundary is in the wrong place; it can rise before latency complaints, since each extra query adds a round trip.
- **Per-area saturation** — Connections, CPU and storage per partition. The whole promise is that these move independently, so watching them together is how you confirm the isolation is real.
- **Reference data propagation lag** — Age of the replicated copy in each partition. It bounds how long two areas can disagree about the same fact.
- **Compensation rate on cross-area writes** — How often a multi-area write has to be unwound. A rise usually means a boundary is being crossed by a transaction that should have been inside one area. Compare it with the failure rate of the same writes before the split.
- **Dangling reference count** — References from one partition to an entity no longer in another. Nothing prevents these, so the only question is whether you look.

### Failure modes under load
<!--meta polarity=failure-->

- **Distributed monolith** — The boundary was drawn by team or by table rather than by domain, so most requests still span areas. Most reads are now merges and most writes need compensation, and the system is slower than the shared database it replaced.
- **Chatty cross-boundary reads** — An application-side join issues one lookup per row instead of one batched call, and a page that was a single query becomes hundreds of round trips.
- **Partial write left uncompensated** — A cross-area sequence fails partway and the compensation is missed or itself fails, leaving two areas that disagree with nothing raising an error.
- **Reference data divergence** — The replicated copy in one partition falls behind and two areas price, categorise or validate the same thing differently for as long as the lag lasts.
- **Boundary change becomes a project** — Moving an entity between areas costs a migration, a code change and a contract change, so the wrong boundary is tolerated for years.

### Readiness checklist
<!--meta polarity=check-->

- The boundary follows a bounded context, and cross-area queries were counted before the split
- No area reads another area store directly; the interface is an API or an event
- Cross-boundary reads are batched by key rather than issued per row
- Cross-area writes publish from an outbox and have written compensations
- Shared reference data is replicated per area, with a tolerated lag that is stated
- Each partition has its own capacity, backup and retention policy rather than a shared default
- A periodic job looks for dangling cross-partition references and reports them

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Scalability](../../../themes/scalability.md) — Split by business area so each scales on its own terms {#fluency-scalability}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Bounded Context](../../ddd/bounded-context.md) — The context boundary is where the partition should fall, which is what stops the split producing a distributed monolith
- [Outbox](../coordination/outbox.md) — Cross-area events publish from an outbox, so a state change and the event announcing it cannot diverge
- [Saga](../coordination/saga.md) — Once a write can span two stores the transaction is gone, so a compensating sequence takes its place
- [Object Storage](./object-storage.md) — Large content gets its own store type when an area is split by technology

**Alternative to**

- [Sharding](./sharding.md) — Splits the subject rather than the key space — reach for it when areas differ, for sharding when one area is too big

**Often confused with**

- [Vertical Partitioning](./vertical-partitioning.md) — Splits by business area into separate stores, not by columns of one entity

**Prevents**

- [Monolithic Persistence](../../../hazards/monolithic-persistence.md) — Each business area gets its own store, sized and tuned for how that area is read and written

<!-- relationships:end -->
