---
title: Multi-Tenancy
description: "Many customers on shared infrastructure, with a tenant key and a choice of how much each tenant shares"
area: distributed-scale
owner: Oleksandr Derechei
tags: [partitioning, isolation, boundaries]
status: stable
aliases: [multitenancy, multi-tenant architecture, tenant isolation, SaaS tenancy]
solves: [one database per customer costs too much but I cannot let customers see each other's rows, one customer's big report slows the product for all the other customers, a big customer wants its own database and region while small ones stay shared, one forgotten filter in a query showed one customer another customer's data]
---

# Multi-Tenancy

Serve many customers from shared infrastructure, tag every request and every record with a tenant, and choose per tenant how much of the stack is shared and how much is theirs alone.

## What it is
<!--meta block=description-->

Multi-tenancy is one deployment of a product serving many customers, called tenants, who each see only their own data and get a fair share of capacity. Every request carries a tenant identity from the front door to the last query. The design choice is a point between one shared pile and one full stack per customer, trading cost against isolation, and tenants can sit at different points.

## Explained
<!--meta block=explain-->

Multi-tenancy is one deployment of a product serving many customers, called tenants, who each see only their own data and get a fair share of capacity. Every request carries a tenant id from the front door to the last query. You then choose how much each tenant shares. Shared everything puts all tenants in the same tables with a tenant key on each row. Schema per tenant and database per tenant give each its own container in the same system. A stamp per tenant gives each a full copy of the stack. Each step costs more and isolates more. Choose a mix over one stack per customer when most customers are small, since a dedicated stack costs more than they pay.

- **Data leaks.** A missed filter in shared tables leaks data, so enforce the tenant key below the application with a database row policy.
- **Noisy neighbour.** One heavy tenant slows the rest, so cap each tenant's use of shared resources.

**Example.** A product has 2,000 small tenants and 3 large ones. The small ones share one database, every row keyed by tenant id, with a row policy that filters each session to its tenant. The 3 large ones each get their own database, listed in a tenant catalog, so a request looks up its tenant and goes to the right place. One small tenant starts a report that reads 40 percent of the shared disk, so a per-tenant limit of 100 requests a second cuts it off. Cost: the team runs 4 databases, 3 restore plans and a catalog, not 2,003 databases.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a request reach only its own tenant's data? The tenant id is read at 1, a catalog at 2 and 3 says where that tenant lives, and the request goes at 4 to a shared pool, a dedicated database or its own stamp."
flowchart LR
    Req["Request with tenant id"]
    Res["Resolve tenant"]
    Cat[("Tenant catalog")]
    Pool[("Shared database, rows keyed by tenant")]
    Silo[("Dedicated database")]
    Stamp["Tenant's own stamp"]
    Req -->|"1 read tenant from token"| Res
    Res -->|"2 look up placement"| Cat
    Cat -->|"3 placement"| Res
    Res -->|"4 small tenant"| Pool
    Res -->|"4 larger tenant"| Silo
    Res -->|"4 tenant with its own stamp"| Stamp
```

```mermaid caption="In the shared model the tenant travels with the request through every layer: it is checked against a per-tenant limit at 3 and set as a database setting at 5, so the filter applies to every query even if the code forgets it."
sequenceDiagram
    autonumber
    participant C as Client
    participant G as Gateway
    participant S as Service
    participant D as Database
    C->>G: request with token
    G->>G: read tenant t42 from token
    G->>G: check t42 against its rate limit
    G->>S: request with tenant t42
    S->>D: set tenant t42 for this session
    D->>D: row policy keeps rows where tenant = t42
    D-->>S: only t42's rows
    S-->>C: response
```

The walk has four parts:

1. **Identify** the tenant at the edge, from a token or host name, and treat that value as trusted only after it is verified. Every later layer reads it from the request context and never from a parameter a client could change.
2. **Place** the tenant. A catalog maps each tenant to where its data and compute live, so you can move a tenant between models without a client change.
3. **Isolate** the data. In the shared model the tenant key is on every row and enforced below the application, for example by a database row policy, so one forgotten `WHERE` clause cannot leak rows. In the other models the boundary is a schema, a database or a stamp.
4. **Limit** the resources. A per-tenant quota or rate limit on the shared parts stops one tenant from using more than its share.

## Variations
<!--meta block=variations-->

- **Shared everything (pool)** — all tenants share tables and compute, and a tenant key on each row separates them. It is the cheapest per tenant and the easiest to run as one fleet. One missed filter leaks data, and one heavy tenant slows the rest.
- **Schema per tenant (bridge)** — one database, one schema for each tenant. It gives a cleaner boundary and per-tenant changes to structure. A migration must run once per schema, so thousands of tenants make deploys slow.
- **Database per tenant (silo)** — each tenant gets a database, and often its own compute. Backups, restores and encryption keys are per tenant, and a noisy tenant harms only itself. Cost and connection counts rise with the tenant count.
- **[Deployment stamp](./deployment-stamp.md) per tenant** — a full copy of the stack for a tenant, or a group of them. It gives the strongest isolation and the blast radius of one stamp. It costs a whole stack for each unit, so it is used for large or regulated tenants.
- **Tiered mix** — small tenants share a pool and large or regulated ones get silos or stamps, with a catalog that records where each lives. It fits most products, and you pay for the catalog and for running more than one model.
- **Sharded pool** — the shared database is split by tenant key across several nodes, as in [sharding](./sharding.md), so the pool scales past one machine and the largest tenant can be moved to its own shard.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Low cost per tenant** — shared compute and storage mean a small customer costs a fraction of a dedicated stack.
- **One fleet to run** — you deploy, patch and monitor one product, so a release reaches every tenant at once.
- **Isolation is a dial** — you can raise it for one tenant by moving it to a silo or stamp, without changing the product.
- **Capacity pooled across tenants** — their peaks rarely coincide, so shared capacity serves more tenants than separate stacks would.

### Cons
<!--meta polarity=con-->

- **A missing filter leaks data** — the tenant key must be enforced below the application code, such as a database row policy, and tested with a second tenant.
- **Noisy neighbours** — a tenant that takes a shared resource slows the rest, so limit per tenant and watch per-tenant load.
- **Per-tenant needs are hard to meet** — a separate backup, key, region or release date fits a silo, not a pool, and shared tables make one tenant's restore touch the rest.
- **More isolation costs more** — each step toward silo and stamp multiplies databases, connections and operations work by the tenant count.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You sell one product to many customers** and a dedicated stack for each would cost more than the customer pays.
- **Tenants differ a lot in size**, so most are small and a few are large enough to deserve their own isolation.
- **You want one release process** for all customers, with the option to move some to stronger isolation later.

### Avoid when
<!--meta polarity=avoid-->

- **Each customer has a hard legal or contract need** for dedicated infrastructure or its own region — give each a [deployment stamp](./deployment-stamp.md).
- **One tenant dominates the load** — split it out by [sharding](./sharding.md) on the tenant key, or give it a silo.
- **You have a single customer** — a tenant key is pure overhead; add it when the second one signs.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — resolve a tenant, rate-limit it and run a query scoped to it"
type Placement = { model: "pool" | "silo"; dsn: string };
const catalog = new Map<string, Placement>([
  ["t1", { model: "pool", dsn: "postgres://shared" }],
  ["t2", { model: "silo", dsn: "postgres://t2-db" }],
]);
const used = new Map<string, number>();     // per tenant; reset every second elsewhere
const LIMIT = 100;                          // per-tenant cap on shared parts

async function handle(tenantId: string, sql: string, run: Run) {
  const place = catalog.get(tenantId);
  if (!place) throw new Error("unknown tenant");
  const n = (used.get(tenantId) ?? 0) + 1;
  used.set(tenantId, n);
  if (place.model === "pool" && n > LIMIT) throw new Error("tenant over limit");
  // In the pool, set the tenant for the session: a row policy filters every
  // query to this tenant, so a forgotten WHERE cannot leak another's rows.
  return run(place.dsn, [
    ["select set_config('app.tenant', $1, true)", [tenantId]],
    [sql, []],
  ]);
}
type Run = (dsn: string, stmts: [string, unknown[]][]) => Promise<unknown>;
```

## In the wild
<!--meta block=wild-->

- **PostgreSQL row-level security** — A table policy filters every query to the rows a session may see, which lets a shared table enforce the tenant key below application code. {#wild-pg-rls}
- **Citus** — Distributes Postgres tables across nodes by a distribution column and documents choosing the tenant id for it in multi-tenant applications. {#wild-citus}
- **Salesforce** — Runs many customer orgs on shared infrastructure and shared database tables, separating each org's data by an org identifier. {#wild-salesforce}
- **AWS SaaS tenant isolation guidance** — Names the silo, pool and bridge models for isolating tenants and discusses how to mix them. {#wild-aws-saas}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **isolation model per tenant tier** — Which tenants share tables, which get a schema or database, and which get a stamp; the line is usually drawn by size, price and compliance need.
- **per-tenant rate limit and quota** — The cap on requests, rows or storage one tenant may take from a shared part; too loose lets a tenant crowd out others and too tight throttles a legitimate peak.
- **tenant-to-placement catalog** — The record of where each tenant lives, which lets you move a tenant between models without changing clients.

### Signals to watch
<!--meta polarity=signal-->

- **latency and error rate per tenant** — Aggregates hide the one tenant being hurt, so break every key metric down by tenant.
- **share of shared resource by tenant** — Top tenants by database time, IO and connections; it shows a noisy neighbour before the victims complain.
- **queries run without a tenant context** — Any count above zero is a leak waiting to happen.

### Failure modes under load
<!--meta polarity=failure-->

- **cross-tenant data leak** — A query without the tenant filter, or a cache key without the tenant, returns another tenant's data.
- **noisy neighbour** — One tenant's load takes a shared database or queue and slows everyone on it.
- **per-schema migration drag** — A change must run in every schema or database, so thousands of tenants turn a deploy into a long rolling job.

### Readiness checklist
<!--meta polarity=check-->

- Enforce the tenant key below application code, such as a row policy, not only in queries
- Test isolation with two tenants, and include caches, queues and file paths
- Put a per-tenant limit on every shared resource
- Break every dashboard and alert down by tenant
- Keep a catalog so a tenant can move to a stronger model

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Scale Units & Stamps](../../../themes/scale-units-and-stamps.md) — The isolation models run from shared rows to a stamp per tenant, and a catalog lets you move a tenant between them. {#fluency-scale-units-and-stamps}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Deployment Stamp](./deployment-stamp.md) — A stamp per tenant is the strongest isolation model.
- [Sharding](./sharding.md) — A shared pool can be sharded by the tenant key.
- [Defense in Depth](../../../principles/defense-in-depth.md) — Tenant isolation needs layers: edge identity, application context and a database row policy.

**Prevents**

- [Noisy Neighbour](../../../hazards/noisy-neighbour.md) — Per-tenant limits and stronger isolation keep one tenant from draining shared resources.

**Implemented by**

- [Resource Organisation](../../../capabilities/resources.md) — An account, subscription or project per tenant is the silo model's billing and permission boundary.

<!-- relationships:end -->
