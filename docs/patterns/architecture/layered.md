---
title: Layered / N-Tier
description: "Presentation, logic, and data as separate tiers"
area: architecture
owner: Oleksandr Derechei
tags: [modularity, separation-of-concerns, decoupling]
status: stable
aliases: [n-tier, three-tier, multitier]
solves: [my UI code is full of SQL queries and I hate it, I changed the database and half the app broke, nobody on the team agrees where new code is supposed to go, business rules are copy-pasted into three different screens, I want to swap out the ORM but the logic is welded to it]
---

# Layered / N-Tier

Splits a system into presentation, business logic, and data-access tiers stacked on top of one another, where each tier talks only to the tier directly beneath it.

## What it is
<!--meta block=description-->

Screens, business rules and storage change at different rates, yet tangled together each edit touches all three. A layered design stacks the system in tiers, usually presentation, business logic and data access. Each tier calls only the one directly below it, so a request has one path from the click to the database row and back. With tiers split into modules whose dependencies are declared, a wrong-way call fails the build.

## Explained
<!--meta block=explain-->

A layered design stacks the system in tiers, usually screens, business rules and data access. Each tier calls only the one directly below it, so a request has a single path from the click to the database row and back. You can swap the database or the screen framework without touching the rules, and most engineers already know the layout. Choose it as the default when screens, rules and storage change at different rates and a new hire should find their way at once. When the domain is rich, put the rules at the centre with a [hexagonal](hexagonal.md) design, where the dependency points at the domain, not at the database.

- **Technical boundaries.** Rules drain into service classes and a one-field feature edits every tier, so keep behaviour in domain objects.
- **Nothing stops upward calls.** Split tiers into modules whose declared dependencies make the build fail on a wrong-way call.

**Example.** A profile page gets a new field, middle name. The change touches the database column, the data-access class, the business entity, the transfer object, the controller and the form: 6 edits across 3 tiers. The business tier only passes the value down, so it adds no decision, just a hop. A validation rule that the name holds at most 40 characters, written in the controller, lets a batch import skip it. Moving that rule into the entity makes both entry points obey it, provided the import builds the entity rather than writing rows directly. The cost is that the 6 edits stay.

## How it works
<!--meta block=structure-->

```mermaid caption="Which tier is allowed to talk to the database? Only the one at the bottom — steps 2 and 3 are the only ways down, so swapping the store rewrites step 4 and nothing else. Every arrow inside the box points at the tier immediately below it, and the answer climbs back the same way."
flowchart TB
    Client["Browser or API client"]:::ext
    subgraph Stack["Dependencies point down only"]
        UI["Presentation tier"]
        BL["Business tier"]
        DA["Data access tier"]
    end
    DB[("Database")]
    Client -->|"1 place order"| UI
    UI -->|"2 orders.place(items)"| BL
    BL -->|"3 save(order)"| DA
    DA -->|"4 insert row"| DB
    DA -->|"5 saved order"| BL
    BL -->|"6 result"| UI
    UI -->|"7 render"| Client
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Closed vs. open layering** — Closed layering forces every call through the layer immediately below; open layering lets an upper layer skip down to a lower one directly, usually for performance, at the cost of the isolation strict layering buys. Relax closure exactly where a layer has nothing to say.
- **Logical layers vs. physical tiers** — Layers can live in one process (logical layering) or be deployed as separate processes on separate machines — a web tier, an app tier, a database tier — talking over the network. "N-tier" strictly names the physical, distributed form.
- **[Model-view-controller (MVC)](./mvc.md)** — Applies the same layering discipline one level down, inside the presentation tier alone: model, view, and controller as sub-layers of what's often just the top of a bigger stack.
- **Cross-cutting layer** — A horizontal concern — logging, authentication, caching — that every tier calls into rather than sitting inside the strict top-to-bottom stack; drawn beside the pattern more often than it is drawn as part of it.
- **Tier as a security boundary** — Once tiers are physically separated, the network between them is a place to enforce policy: give each tier its own subnet and allow the data tier to accept traffic only from the tier directly above it. A stolen web-tier credential then reaches one hop, not the database. This is the strongest argument for paying the latency of physical separation, and it is unavailable to a purely logical stack.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Clear separation of concerns** — each tier has one job and one reason to change.
- **Tiers are independently replaceable**: swap the database or the UI framework without touching business logic, provided the lower tier's interface does not leak storage shapes. Schema and entity changes still ripple.
- **Widely understood** — most engineers can navigate a layered codebase with no extra briefing.
- **Business logic can be tested** in isolation by mocking the layer below it.
- **A tier boundary is a process boundary** in the physical n-tier form, so tiers need not share an operating system or a runtime, and an existing workload can move one tier at a time.

### Cons
<!--meta polarity=con-->

- **Small changes ripple through tiers** — a one-field change edits every tier: column, entity, DTO (data transfer object), controller.
- **Encourages an anemic domain layer**, since the boundaries are structural, not behavioral, and logic tends to pool in services instead.
- **Strict layering adds call-through boilerplate** — a DTO or interface at every boundary a request crosses.
- **Horizontal slicing doesn't map to business capabilities**, so a single feature still touches code in every tier and every team.
- **Isolation at the unit level** costs visibility at the whole-path level: once tiers are physically separated, exercising or diagnosing one request means stitching together evidence from every tier it crossed.
- **Pass-through middle tiers** — a middle tier that only forwards create-read-update-delete calls adds a network hop, a deployment unit and an on-call rotation and no decision. Strict closure produces these by construction.
- **The security boundary a tier** buys has to be maintained per tier, so the rule set grows with the topology — every new tier is another subnet, another set of allowed sources, and another place a rule can be wrong without anything failing loudly.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The team wants a familiar**, conventional structure that's cheap to onboard new engineers into.
- **Presentation, business rules**, and storage genuinely change at different rates and for different reasons.
- **You need to replace** or scale one tier on its own — swap the database, add a caching layer, change the UI framework.
- **You are moving an existing** application to a new environment and want it to arrive intact. The style is portable, the shape survives the move, and nothing has to be re-architected to run in two environments at once.
- **The architecture is still moving** and you do not yet know which parts need to scale separately.

### Avoid when
<!--meta polarity=avoid-->

- **The domain is complex enough** that a purely horizontal split obscures the real dependency direction — put the domain at the center with [Hexagonal](./hexagonal.md) instead.
- **Teams are organized around business capabilities, not tiers** — coupling every feature to every layer slows delivery across team boundaries.
- **The application is small enough** that the ceremony of extra layers buys nothing over a single tier.

Guards against the smell of business rules bleeding into the UI and queries scattered through render code — the tangle that becomes [Spaghetti Code](../../hazards/spaghetti-code.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — three tiers, one request"
// Presentation tier — no SQL, no business rules, just orchestration
class OrderController {
  constructor(private readonly orders: OrderService) {}

  async placeOrder(req: PlaceOrderRequest): Promise<OrderView> {
    const order = await this.orders.place(req.customerId, req.items);
    return { id: order.id, total: order.total };
  }
}

// Business logic tier — owns the rules, knows nothing of HTTP or SQL
class OrderService {
  constructor(private readonly repo: OrderRepository) {}

  async place(customerId: string, items: LineItem[]): Promise<Order> {
    const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    if (total <= 0) throw new Error("order must have a positive total");
    return this.repo.save({ id: crypto.randomUUID(), customerId, items, total });
  }
}

// Data access tier — owns persistence, no business rules
class OrderRepository {
  constructor(private readonly db: Database) {}

  async save(order: Order): Promise<Order> {
    await this.db.query("insert into orders (...) values (...)", [order]);
    return order;
  }
}
```

## In the wild
<!--meta block=wild-->

- **Spring Framework stereotypes** — `@Controller`, `@Service` and `@Repository` are the framework's own names for the presentation, business and data-access tiers, and the usual Spring application is organised along them. {#wild-spring-stereotypes}
- **TCP/IP protocol stack** — The network stack is the long-standing layered design: link, internet, transport and application layers, each using only the service of the layer below and hiding its own internals. {#wild-tcp-ip}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Per-tier instance count** — In the physical n-tier form each tier scales horizontally on its own behind its own load balancer, so the saturating tier can be given capacity without touching the others.
- **Inter-tier connection pool size** — The bounded pool a tier holds to the tier below it — most critically the app-tier-to-database pool (a maximum pool size, min idle). Size it so the per-instance maximum times the app instance count stays within the database's own connection limit.
- **Inter-tier timeout and retry** — The request timeout and retry policy on each downward call, so a slow lower tier is abandoned rather than allowed to pin resources in the tier above. Keep each downward timeout shorter than the caller's own, and retry sparingly with jittered backoff, since retries add load to a tier that is already saturated.
- **Cache tier placement** — An optional caching layer inserted between the app and data tiers to absorb read load before it reaches the database.
- **Tier-to-tier transport** — Whether a call between tiers is a direct request or a queued message. A queue decouples the tiers' availability and their scaling, and it turns a synchronous failure into a backlog you have to drain.
- **Data-tier replication** — The replica count and the failover mode behind the data tier. This is where the tier's availability actually comes from; a stateless application tier cannot compensate for a single database instance.

### Signals to watch
<!--meta polarity=signal-->

- **Per-tier latency contribution** — Time spent in each tier hop; total request latency is the sum, so measuring per hop shows which tier to attack.
- **Connection pool utilization and wait time** — How saturated each inter-tier pool is and how long callers block waiting for a connection — the earliest warning of an impending stall. Alert when wait time stays above zero over a sustained window, taking the baseline from the load test.
- **Per-tier saturation** — CPU, memory, or thread-pool utilization per tier, which identifies the bottleneck tier that caps whole-system throughput.
- **Database connection count vs. limit** — Active connections against the server's configured maximum — the ceiling the whole app tier shares.

### Failure modes under load
<!--meta polarity=failure-->

- **Connection pool exhaustion** — The app tier runs out of connections to the tier below; requests queue on pool acquisition and time out while the database itself sits idle.
- **Bottleneck tier caps throughput** — One tier saturates and gates the entire request path while the other tiers sit underused, because every request must pass through all of them.
- **Latency stacking** — A request that fans into many downward calls multiplies per-hop network latency — an N+1 pattern spread across tiers rather than rows.
- **Cascading timeout** — A slow lower tier holds threads busy in the tier above until that tier's own pool is exhausted and the stall climbs the stack.

### Readiness checklist
<!--meta polarity=check-->

- Each tier except the data tier is stateless and independently scalable behind its own load balancer.
- Inter-tier connection pools are bounded and sized so the app tier cannot exceed the database's connection limit.
- Every downward call has a timeout so a slow lower tier cannot hang the tier above it.
- A load test has identified which tier saturates first and at what request rate.
- A web application firewall sits between the front end and the internet, so the outermost tier is not the first thing to see unfiltered traffic.
- The data tier is replicated with a tested failover, not a single instance behind a stateless fleet.
- When tiers multiply, routing to a specific tier is decided at layer 7 rather than by each tier knowing the topology of the next.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Architecture Styles](../../themes/architecture-styles.md) — One deployable, layers that only call downward {#fluency-architecture-styles}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Separation of Concerns](../../principles/separation-of-concerns.md) — The layered split is separation of concerns by altitude.
- [Service Layer](../enterprise/service-layer.md) — A service layer is the business tier's entry point: the one coarse boundary the presentation tier calls.

**Alternative to**

- [Microservices](./microservices.md) — Horizontal layers keep one deployable and one release train; microservices trade that for independent deployment.
- [Vertical Slice](./vertical-slice.md) — The same code, filed the other way — by tier instead of by feature
- [Hexagonal](./hexagonal.md) — Dependencies point inward vs. straight down the tiers

**Generalizes**

- [MVC](./mvc.md) — Model-view-controller (MVC) is a layering of user interface (UI) concerns

**Prevents**

- [Spaghetti Code](../../hazards/spaghetti-code.md) — Clear tiers keep call flow from tangling
- [Big Ball of Mud](../../hazards/big-ball-of-mud.md) — Enforced layers resist mud

**Exposed to**

- [Shotgun Surgery](../../hazards/shotgun-surgery.md) — Can fall into shotgun surgery when one new field must be edited into every layer in turn

<!-- relationships:end -->
