---
title: Hexagonal
description: Core domain isolated behind ports and adapters
area: architecture
owner: Oleksandr Derechei
tags: [modularity, decoupling, testability, separation-of-concerns]
status: stable
aliases: [ports-and-adapters, onion-architecture, clean-architecture]
solves: [testing one business rule means spinning up a database and a web server, my domain classes import the ORM and the HTTP request object, the framework upgrade broke code that has nothing to do with the framework, "I need the same logic behind an API, a CLI, and a nightly job without copy-paste", swapping our message broker means touching hundreds of files]
---

# Hexagonal

Wraps the core domain in ports it defines itself, then lets adapters plug in databases, UIs, and frameworks from the outside — so the business rules never depend on any of them.

## What it is
<!--meta block=description-->

When the domain model imports the database mapper or the web framework, a driver upgrade edits code that has nothing to do with drivers. Hexagonal architecture, also called Ports and Adapters, puts the business rules in a core that depends on nothing outside it. The core declares ports, which are interfaces for what it needs and offers. Adapters outside it fill them, so every dependency points inward.

## Explained
<!--meta block=explain-->

A hexagonal design keeps your business rules in a core that depends on nothing outside it. The core declares ports, which are interfaces for what it needs, such as saving an order, and what it offers, such as placing one. Adapters outside the core fill the ports: a database class, a web controller, a test fake. Every dependency points inward, so you can swap the database, or run the rules with no database at all, without touching the rules. A real hexagon passes one test: delete the persistence adapter and the domain still compiles. Choose it over a plain [layered](layered.md) stack when the rules must outlive the framework or must be testable without starting anything. For a thin service over one database it only adds files.

- **Ceremony piles up.** Each dependency needs an interface and wiring, so size ports to what the business asks, not the vendor's whole API.
- **Drift re-couples the core.** One adapter passing a database object through a port does it, so fail the build on any import that points outward.

**Example.** A shop has 400 domain tests. Against a real database each takes about 50 ms, 20 seconds in all. Against an in-memory fake of the order-saving port each takes 2 ms, 0.8 seconds in all, so the tests run on every save. When the team moves from Postgres to DynamoDB they write one new adapter and leave the core untouched. The cost shows up in review: one adapter returned a database row object through the port, and the core quietly began to import the database library. An import rule in the build now fails on that.

## How it works
<!--meta block=structure-->

```mermaid caption="Does anything inside the box name something outside it? No — step 3 calls outward at run time, but the core only ever names its own port, and step 4 is the composition root supplying the adapter behind it."
flowchart LR
    REST["REST controller"]
    Job["Nightly job"]
    subgraph Core["The core — imports no framework or driver"]
        InPort["Primary port: PlaceOrder"]
        Rules["Order rules"]
        OutPort["Secondary port: OrderRepository"]
    end
    Repo["Postgres adapter"]
    Orders[("Orders table")]:::ext
    REST -->|"1 POST /orders"| InPort
    InPort -->|"2 place(order)"| Rules
    Rules -->|"3 save(order)"| OutPort
    OutPort -->|"4 wired to this at startup"| Repo
    Repo -->|"5 INSERT"| Orders
    Job -.->|"same primary port"| InPort
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Ports & Adapters** — Alistair Cockburn's later name for the same pattern, naming the parts rather than the drawing. The hexagon was only the customary picture, chosen so the diagram implies no top or bottom.
- **Onion Architecture** — Draws the same idea as concentric rings — domain model at the center, then domain services, then application services — and states the dependency rule explicitly: nothing points outward.
- **Clean Architecture** — Adds an explicit use-case (interactor) ring between the domain and its ports, and generalizes the dependency rule across any number of layers.
- **[Anti-Corruption Layer](../ddd/acl.md)** — A neighbour rather than a variant. An adapter that translates and validates at a bounded-context boundary is one way to fill a port, so a foreign or legacy model can't leak its shape into the core.
- **Driving and driven sides** — Driving (primary) adapters such as web, CLI or a job call the core through inbound ports; driven (secondary) adapters such as a database or queue implement outbound ports the core calls.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Core business logic has zero** dependency on frameworks, drivers, or transport — it's plain code you can unit-test with in-memory fakes.
- **Infrastructure is swappable**: replace Postgres with DynamoDB, or REST with gRPC, by writing a new adapter and not touching the core, provided no port carries an adapter's types.
- **Ports make every integration point an explicit**, named contract instead of an implicit coupling.
- **Many front doors, one core** — a web API, a CLI and a scheduled job can all drive the same core at once without duplicating rules.

### Cons
<!--meta polarity=con-->

- **More upfront ceremony**: an interface, at least one adapter and wiring for each port, and one port per collaborator is the costly end.
- **Drawing the port boundary** is a real design judgment — too fine and it's noise, too coarse and infrastructure leaks back in.
- **Small, short-lived apps rarely earn back the indirection**; it adds files and interfaces for a project that will never change database.
- **Nothing stops a hurried adapter** from smuggling infrastructure types back across the port if the team isn't disciplined.
- **Fakes can drift**: each port needs an in-memory fake that can diverge from the real adapter, so run one contract suite against both.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Rules must outlive their tech** — the business rules need to outlive a specific framework, database, or transport that's likely to change.
- **You want to unit-test core logic** without booting a database, HTTP server, or queue.
- **Several front doors** — web, CLI, batch job, another service — must drive the same core logic consistently.

### Avoid when
<!--meta polarity=avoid-->

- **The app is a thin** CRUD (create, read, update, delete) wrapper around one database with no real domain logic worth isolating.
- **The team is small** and a straightforward [Layered / N-Tier](./layered.md) structure already gives enough separation for the project's lifetime.
- **Nobody will enforce the boundary** — an unpoliced port is just an interface nobody bothers to implement twice.

Prevents the smell of business rules entangled with frameworks, drivers, and wire formats — the drift toward a [Big Ball of Mud](../../hazards/big-ball-of-mud.md) where nothing can change in isolation.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a port, a core, and one adapter"
// Port: interface the core defines and owns
interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
}

// Core: depends only on the port, never on SQL or a driver
class PlaceOrder {
  constructor(private readonly orders: OrderRepository) {}

  async execute(order: Order): Promise<void> {
    if (order.items.length === 0) throw new Error("cannot place an empty order");
    await this.orders.save(order);
  }
}

// Adapter: implements the port and owns the mapping between domain Order and the stored row (toRow, toOrder), items included
class PostgresOrderRepository implements OrderRepository {
  constructor(private readonly db: Pool) {}
  async save(order: Order): Promise<void> {
    const { id, ...row } = toRow(order);
    await this.db.query("insert into orders (id, body) values ($1, $2)", [id, row]);
  }
  async findById(id: string): Promise<Order | null> {
    const { rows } = await this.db.query("select * from orders where id = $1", [id]);
    return rows[0] ? toOrder(rows[0]) : null;
  }
}

// Fake: same port, in memory; run one contract test suite against both
class InMemoryOrderRepository implements OrderRepository {
  private readonly byId = new Map<string, Order>();
  async save(order: Order) { this.byId.set(order.id, order); }
  async findById(id: string) { return this.byId.get(id) ?? null; }
}

// Composition root wires the adapter into the core's port
const placeOrder = new PlaceOrder(new PostgresOrderRepository(pool));
```

## In the wild
<!--meta block=wild-->

- **Alistair Cockburn, "Hexagonal architecture"** — The 2005 article that named the pattern as Ports and Adapters: the application core talks to the outside only through ports, and a driving or driven adapter plugs into each one, so the same core runs under a test harness, a UI or a batch job. {#wild-cockburn-hexagonal}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Port granularity** — One port per use case or one per collaborator. Too fine floods the codebase with single-method interfaces; too coarse lets the shape of one adapter leak into the core.
- **Dependency rule enforcement** — Which packages may import which, checked by the build or an architecture test. A rule that lives only in the README erodes within a few releases.
- **Where translation happens** — Mapping between wire or storage shapes and domain types belongs in the adapter. Put it in the core and the core learns the outside format.

### Signals to watch
<!--meta polarity=signal-->

- **Inward-import violations** — Count of core files that import a framework, driver or adapter package. The number should stay at zero; one is a review finding.
- **Share of tests that run without infrastructure** — Use-case tests that need no database, broker or web server, and how long the core suite takes. A falling share means the core is regaining dependencies.
- **Port change rate** — How often a port signature changes when you only swap or upgrade an adapter. A port that changes with its adapter mirrors that adapter.

### Failure modes under load
<!--meta polarity=failure-->

- **Leaky port** — A port named after SQL, HTTP or a vendor SDK. Swapping the adapter then edits the core, and the hexagon was paid for and delivered nothing.
- **Anemic core** — The core only passes data through while the rules sit in adapters or controllers. You see business logic that cannot be tested without the framework.
- **Fake drifts from the real adapter** — The in-memory adapter that keeps tests fast stops behaving like the real one. Tests stay green and production disagrees.
- **Ceremony on plain CRUD** — One port, one adapter and one mapper per table for a screen with no rules. You see three files changed per added field.

### Readiness checklist
<!--meta polarity=check-->

- The core builds and its tests run with no framework or driver on the classpath
- An architecture test fails the build on any inward-dependency violation
- Every port has one contract test suite run against the real adapter and the in-memory fake
- Port names and methods use domain words, not storage or transport words

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Architecture Styles](../../themes/architecture-styles.md) — Put the domain at the centre and let infrastructure plug in through ports. {#fluency-architecture-styles}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Dependency Injection](../gof/extra/dependency-injection.md) — Adapters are injected into the core's ports
- [Anti-Corruption Layer](../ddd/acl.md) — Adapters often carry an anti-corruption layer
- [Dependency Inversion Principle](../../principles/dependency-inversion.md) — Ports-and-adapters is dependency inversion drawn at the architecture boundary.
- [Design for Evolution](../../principles/design-for-evolution.md) — Ports and adapters are evolvability made structural

**Alternative to**

- [Layered / N-Tier](./layered.md) — Pick this when the rules must be testable apart from framework and database; layered is enough for thin CRUD.
- [Microkernel / Plugin](./microkernel.md) — Adapters are wired by the owning team; a microkernel loads plug-ins at run time

**Composed of**

- [Adapter](../gof/structural/adapter.md) — Ports are filled by adapters

**Prevents**

- [Big Ball of Mud](../../hazards/big-ball-of-mud.md) — Isolating the core keeps the mud out
- [Golden Hammer](../../hazards/golden-hammer.md) — Ports your own code owns keep one tool's vocabulary out of callers, so swapping the tool is one adapter

<!-- relationships:end -->
