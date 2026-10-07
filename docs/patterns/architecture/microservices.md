---
title: Microservices
description: "One business capability per service, each owning its own data"
area: architecture
owner: Oleksandr Derechei
tags: [modularity, boundaries, decoupling]
status: stable
aliases: [microservice architecture, MSA]
solves: [one team's release is blocked waiting for four other teams to finish, a bug in the reporting code forces us to redeploy the entire application, we cannot scale checkout without also scaling everything bolted to it, changing one table breaks three unrelated parts of the codebase, the codebase is too big for anyone to change it safely]
---

# Microservices

Splits an application into small autonomous services, each owning one business capability and its own data — so a team can ship its service without waiting for anyone else's release.

## What it is
<!--meta block=description-->

In one deployable, every change queues behind every other: a half-finished migration holds the release train, and one module's leak restarts everything. Microservices split the application into services that each cover one business capability, with their own data store and their own release. No other service compiles against its code or reads its tables, so a team ships on its own schedule.

## Explained
<!--meta block=explain-->

Microservices split an application into services that each own one business capability, with their own data store and their own release. A team changes and ships its service without waiting for any other team, because no other service reads its tables or compiles against its code. Choose it over one deployable program when several teams keep blocking each other at release time, or one capability needs to scale far apart from the rest. For one or two teams on a simple domain, a [layered](layered.md) program costs far less. Keep all three rules: one responsibility, independent deployment, private data. Share a database and you pay for distribution and get none of the independence, which is a distributed monolith. Sizing the services is a modelling question first, so the usual answer is one service per [bounded context](../ddd/bounded-context.md).

- **No shared transaction.** A change across two services is not one transaction, so design the undo step for each failure.
- **Network waits add up.** Each call adds a wait, so cap the depth of call chains.
- **Logs scatter.** One user action spans many logs, so set up tracing before the first outage.
- **Open choices.** Agree platform rules for logging, metrics and deployment.

**Example.** A shop splits into orders, payments and inventory. Placing an order calls payments, which charges 60.00, then inventory, which finds no stock. There is no shared transaction to roll back, so orders runs a refund of 60.00 as the undo step. If a request also chained through pricing and then tax, three calls deep with a 1 s timeout each, it can take 3 s to fail, so the team caps chains at two calls. A support agent tracing one order finds it in 3 services' logs by one order ID. The cost is that this refund path and the tracing setup had to exist before launch.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a request cross two services when neither may read the other's database? The gateway routes it to exactly one owner, which writes only its own store and states a fact; shipping learns from the fact rather than from a join."
flowchart LR
    Client["Client"]
    GW["API gateway"]
    subgraph Ord["Orders service — private data"]
        OrderSvc["Order logic"]
        OrderDB[("Orders store")]
    end
    Broker[("Event broker")]
    subgraph Shp["Shipping service — private data"]
        ShipSvc["Shipping logic"]
        ShipDB[("Shipments store")]
    end
    Client -->|"1 one request"| GW
    GW -->|"2 route to the owner"| OrderSvc
    OrderSvc -->|"3 write own store"| OrderDB
    OrderSvc -->|"4 publish OrderPlaced"| Broker
    Broker -->|"5 deliver"| ShipSvc
    ShipSvc -->|"6 write own store"| ShipDB
```

```mermaid caption="The customer's answer does not wait for shipping. The order commits and returns in steps 3 to 5, so a shipping outage delays the parcel rather than the sale — and the queued event catches shipping up when it returns."
sequenceDiagram
    autonumber
    participant C as Client
    participant GW as API gateway
    participant O as Order service
    participant B as Broker
    participant S as Shipping service
    C->>GW: POST /orders
    GW->>O: route
    O->>O: commit order row + outbox row
    O-->>GW: 201 Created
    GW-->>C: 201 Created
    alt shipping healthy
        B->>S: OrderPlaced
        S-->>B: ack, shipment created
    else shipping down
        B--xS: delivery fails
        Note over B,S: event stays queued, and the order still exists
    end
```

## Variations
<!--meta block=variations-->

- **Service per [Bounded Context](../ddd/bounded-context.md)** — Size each service to a boundary the business already has, so the words inside it mean one thing and a feature usually lands in one place. Cut finer than that and ordinary changes turn into cross-team negotiations.
- **[API Gateway](../distributed/routing/api-gateway.md) at the edge** — One entry point routes external traffic to the owning service and carries the cross-cutting work — authentication, rate limits, request logging. Keep domain knowledge out of it: a gateway that understands orders becomes a second place every order change has to be made.
- **[Backend-for-Frontend](../distributed/routing/bff.md) per client** — Give each client type its own aggregating façade instead of one gateway serving all of them. A mobile screen that needs four services gets one call shaped for it, and the web team stops blocking the mobile team's payload changes.
- **[Service Mesh](../distributed/routing/service-mesh.md) for internal traffic** — Move retries, timeouts, mutual Transport Layer Security (TLS) and traffic splitting into a proxy beside each service rather than into every service's code. Policy then changes without a redeploy, at the cost of one more layer in the request path and in the on-call rotation.
- **Choreography or orchestration** — In choreography each service reacts to events on its own and no component knows the whole flow. In orchestration a coordinator drives the steps and compensates the failed ones, which is the [Saga](../distributed/coordination/saga.md) shape. Choreography keeps services from calling each other, but they still share event contracts and the flow is only visible by tracing; orchestration gives you one place to answer "where did this order stop".
- **Extraction by [Strangler Fig](../distributed/coordination/strangler-fig.md)** — Many systems are carved out of a monolith rather than designed from nothing. Route one capability at a time through a façade to a new service, keep the old path running until traffic has moved, then delete it. The alternative, a rewrite that lands all at once, has to reproduce every behaviour of the old system in one release.
- **Modular monolith first** — Enforce the module boundaries and the private data inside one deployable, and split only once the boundaries have survived repeated changes without cross-module edits. Moving a boundary is a refactor while it is in-process and a migration once it is a network call, so this ordering buys the option to be wrong cheaply. A boundary that is only a folder name is not a boundary, so enforce it with a compile-time module system, an architecture test that fails the build on a forbidden import, or separate schemas with no cross-schema joins. Cross-module reads go through a published interface or an event-fed copy, which makes the later split far less exploratory.
- **Service-oriented architecture, minus the bus** — Service-oriented architecture argued for autonomous services a decade earlier and mostly delivered them through a shared enterprise service bus that carried routing, transformation and orchestration for everyone. This style rejects that central bus: intelligence moves into the services and the pipes stay dumb, which is why data is private to its owner rather than a shared canonical schema. A distributed monolith is what you get when the bus is deleted but the coupling it carried is not.
- **Transactional outbox for events** — Write the state change and the event row in one local transaction, and let a relay publish the row. Delivery is then at least once, so consumers dedupe by event ID.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Independent deploys and rollbacks** — a team deploys and rolls back one service without a release train, so shipping speed stops depending on the slowest team, provided contracts stay compatible and deployment is automated.
- **Scale the subsystem under pressure** instead of the whole application — one busy capability no longer sets the replica count for everything.
- **A schema change touches the one service** that owns the data, so migrations stop being cross-team events, provided no other service reads that store.
- **Failures stay local when callers handle them** — a down service degrades one capability rather than the application, provided callers use timeouts and a [Circuit Breaker](../distributed/resilience/circuit-breaker.md).
- **Each service can pick the language** and the store that fit its work, which pays off where one capability's needs genuinely differ from the rest.

### Cons
<!--meta polarity=con-->

- **Each service is simpler** and the system is harder: discovery, versioning and consistency across services become your problem rather than the language's.
- **A change spanning two services** is not one transaction, so you get eventual consistency and have to design the reconciliation yourself.
- **Calls become network hops** — every call that used to be a function call is now one, and a chain three services deep adds three timeouts' worth of tail latency.
- **One user action spans many services**, so debugging needs correlated logs and distributed tracing in place before the first incident, not after it.
- **Decentralised choice with no standards** produces a fleet nobody can operate — agree platform-wide rules for logging, metrics and deployment even while service internals stay free.
- **The style assumes automated deployment, per-service monitoring** and teams that own their services in production. Without those, splitting the deployable multiplies the operational surface and buys none of the autonomy, which is the [distributed monolith](../../hazards/distributed-monolith.md).

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several teams work on one application** and keep blocking each other at release time.
- **The domain is complicated enough** to have real internal boundaries, and updates are frequent.
- **One capability's load or storage** needs differ enough from the rest that scaling them together wastes money.
- **You are carving capabilities out** of a large legacy system and want to replace it a piece at a time.

### Avoid when
<!--meta polarity=avoid-->

- **The domain is simple** and one or two teams own all of it — [Layered / N-Tier](./layered.md) or [Web-Queue-Worker](./web-queue-worker.md) costs far less.
- **You do not yet know** where the boundaries are. Splitting on a guess freezes the guess behind a network call.
- **Automated deployment, per-service monitoring** and end-to-end tracing are not in place — those are the entry fee, not a later improvement.
- **The work is one tightly coupled transaction** that must commit or not at all, and no compensating path is acceptable.
- **The team shares domain code** between services as a library and treats it as normal. Every consumer then upgrades on the owner's schedule, which is a release train wearing a package manager's clothes.

Answers the smell of a codebase where every change touches everything — but split on the wrong boundaries it trades [Big Ball of Mud](../../hazards/big-ball-of-mud.md) for [Chatty I/O](../../hazards/chatty-io.md), which is the same tangle with network latency added.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a service that owns its data and learns the rest from events"
// Shipping service. It owns shipments and nothing else, and it never opens
// a connection to the order service's database.
type OrderPlaced = { orderId: string; address: Address };

const shipments = new ShipmentStore();   // its own schema; no other service has credentials

// Inbound: react to a fact another service published, keeping a local copy of
// only the fields shipping needs. Duplicating the address buys autonomy.
broker.subscribe("OrderPlaced", async (e: OrderPlaced) => {
  // A unique key on orderId makes redelivery safe: a concurrent duplicate hits the constraint.
  try {
    await shipments.create({ orderId: e.orderId, address: e.address, state: "pending" });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;   // a duplicate means the parcel exists; redelivery must not create a second one
  }
});

// Outbound: a contract shaped like the domain, not like the table behind it.
app.get("/shipments/:orderId", async (req, res) => {
  const s = await shipments.find(req.params.orderId);
  if (!s) return res.status(404).json({ error: "no shipment for that order" });
  res.json({ orderId: s.orderId, state: s.state, eta: s.eta });   // internal columns stay internal
});
```

```typescript summary="TypeScript — the two shortcuts that give the coupling away"
// Both look harmless in review, and both undo the style.

// 1. Reading another service's store. Now the orders team cannot rename a
//    column without breaking shipping, and the two must deploy together.
const order = await ordersDb.query("select * from orders where id = $1", [orderId]);

// 2. A synchronous chain. Shipping waits on pricing, which waits on tax, so
//    the client's latency is the sum and any one outage is all three.
const price = await pricing.quote(orderId);       // pricing calls tax internally
const label = await carrier.buyLabel(price);

// The event-driven version keeps the read local and the chain flat: shipping
// already holds what it needs, and publishes rather than waits.
const local = await shipments.find(orderId);
// In production, publish through an outbox so the state change and the event commit together.
await broker.publish("ShipmentReady", { orderId, weight: local.weight });
```

## In the wild
<!--meta block=wild-->

- **Kubernetes** — The open-source orchestrator most service fleets run on. It schedules containers across nodes, restarts the ones that fail their liveness probe, gives each service a stable DNS name and virtual IP through a `Service` object, and holds a replica count per `Deployment` so one service scales without the others. {#wild-kubernetes}
- **Netflix** — Documented its move from a monolithic application to hundreds of independently deployed services, and open-sourced the tooling that made the move survivable — Eureka for service registration, Ribbon for client-side load balancing, Hystrix for circuit breaking. {#wild-netflix}
- **Amazon** — Reorganised its retail platform in the early 2000s into services owned end to end by small teams, with the rule that a team may only reach another team through its published interface. It is the origin story most often cited for the style. {#wild-amazon}
- **Istio** — A service mesh that runs an Envoy proxy beside every service and takes over the internal traffic concerns — mutual TLS between services, retries and timeouts, and percentage-based traffic splitting for canary releases — configured centrally rather than in each service. {#wild-istio}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Service granularity** — How much capability one service owns, and whether one team owns it end to end. Cut too fine and every feature becomes a cross-team negotiation; cut too coarse and you are back to a shared release. Too fine when span count rises (signal 2) or most changes need two teams; too coarse when services deploy together (signal 3).
- **Replica count and autoscaling target per service** — Each service scales on its own signal: CPU, in-flight requests or queue depth, instead of the whole application scaling on the busiest path. Load-test one replica for the rate where p99 breaks, and set the target at a fixed fraction of it.
- **Per-dependency timeout and retry budget** — The deadline and the attempt count on each outbound edge. Set them per edge and check the product across the chain: three hops making three attempts each turn one client request into 27 calls at the bottom. Fit each timeout inside the caller's remaining deadline, and retry at one layer only.
- **Compatibility policy for APIs and event schemas** — How long a deprecated field survives and whether consumers must ignore fields they do not recognise. This is what decides whether two services can deploy in either order.
- **Connection pool size and max in-flight requests per upstream** — Bounds how much of a caller's capacity one slow dependency can hold, which is the difference between a degraded feature and a degraded service. A starting point is request rate times p99 latency (signal 1), the in-flight count that rate needs; cap slightly above it.

### Signals to watch
<!--meta polarity=signal-->

- **Per-service request rate, error rate and p99 latency** — The three numbers that tell you which service is unhealthy without reading anyone else's dashboard.
- **End-to-end latency and span count per traced request** — How long a user action takes across every hop, and how many hops it took. A rising span count is a chain growing longer than anyone designed.
- **Deployment frequency per service** — The autonomy the style was bought for, measured directly. If services only ever deploy together, they are not deploying independently and the split is not paying.
- **Consumer lag on the asynchronous edges** — The backlog between a published event and the consumer that has processed it, which is the size of the window in which two services disagree. Alert when lag exceeds the staleness the feature tolerates, and watch its rate of change.
- **Share of a service's errors attributable to a downstream** — Separates a service that is broken from a service that is merely downstream of something broken, which is the difference between two very different pages.

### Failure modes under load
<!--meta polarity=failure-->

- **Cascade along a synchronous chain** — C slows down, so B's threads fill waiting on C, so A's fill waiting on B, and a request path nobody thought was related is down.
- **Retry amplification** — Each hop makes its own attempts, so three hops of three attempts turn one client request into 27 calls at the bottom and a small outage arrives as a flood.
- **Chatty request patterns** — A screen assembled from six services makes six round trips per view, and latency becomes network time rather than work time. It usually means the boundaries are in the wrong place.
- **Version skew** — A producer ships a required new field while consumers still run the previous build, so requests or events are rejected until both sides land, and the deploy order that was supposed to be free is not.
- **Shared-store creep** — Two services start reading one store for a report, and from then on they have to deploy together. The coupling is invisible until a migration exposes it.

### Readiness checklist
<!--meta polarity=check-->

- Every service owns its data store, and no other service holds credentials to it
- Every cross-service call has a timeout and a bounded retry
- A correlation id is generated at the edge and propagated on every call and every event, with traces queryable end to end
- API and event schemas are versioned with a stated compatibility policy, and consumers ignore fields they do not recognise
- One team has deployed one service to production without coordinating with another team
- Logs and metrics land in one place with a per-service label, so "which service failed" is a query rather than an investigation
- Every service has a named owner who is paged for it
- No shared library carries domain logic between services. A version bump every service must take in the same week is the coupling you split the deployable to avoid.
- Configuration arrives from outside the service, so the same build runs in every environment.
- Token validation happens at the edge rather than being re-implemented inside each service.
- Every event stands on its own: a consumer can act on it without having seen an earlier event or waiting for a later one.
- Events carry business facts, not table rows. Publishing a database entity ships your schema to every subscriber and makes the next migration their problem too.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Architecture Styles](../../themes/architecture-styles.md) — Decompose by capability, deploy independently {#fluency-architecture-styles}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [API Gateway](../distributed/routing/api-gateway.md) — Clients meet one front door rather than many services, so identity and limits are enforced once.
- [Container Orchestration](../distributed/coordination/container-orchestration.md) — Many small services need something to place, scale and restart them, or the operational cost swamps the benefit.
- [Saga](../distributed/coordination/saga.md) — Private data per service rules out a distributed transaction, so a business step spanning services needs compensations.
- [External Configuration Store](../distributed/coordination/external-configuration-store.md) — Configuration from outside the service is what lets one build run in every environment
- [Vertical Slice](./vertical-slice.md) — Slices at feature-area grain are the seam to cut along when a service is split out.
- [Strangler Fig](../distributed/coordination/strangler-fig.md) — Replacing a legacy system one capability at a time is how most services are first cut out.
- [Micro-Frontends](../frontend/micro-frontends.md) — A team that owns a service can own the matching UI slice, so the split runs the same way end to end.

**Alternative to**

- [Layered / N-Tier](./layered.md) — Both decompose one system; this cuts vertically by business capability, layered cuts horizontally by technical concern.
- [Web-Queue-Worker](./web-queue-worker.md) — The simpler answer when the domain is small: one front end, one worker, one queue, instead of many owners.

**Requires**

- [Bounded Context](../ddd/bounded-context.md) — A service that spans two contexts mixes domain models, which is the boundary error every other problem follows from.

**Exposed to**

- [Big Ball of Mud](../../hazards/big-ball-of-mud.md) — Can fall into big ball of mud when a tangled system split without untangling it becomes a distributed mess
- [Chatty I/O](../../hazards/chatty-io.md) — Can fall into chatty io when fine-grained services need many calls to render one screen
- [Distributed Monolith](../../hazards/distributed-monolith.md) — Can fall into distributed monolith when a split along technical layers with a shared schema keeps the coupling and adds the network
- [Golden Hammer](../../hazards/golden-hammer.md) — Can fall into golden hammer when the style gets applied to every system regardless of fit
- [Monolithic Persistence](../../hazards/monolithic-persistence.md) — Can fall into monolithic persistence when services that share one database keep unlike workloads on one engine
- [Shotgun Surgery](../../hazards/shotgun-surgery.md) — Can fall into shotgun surgery when a change cutting across service boundaries needs coordinated edits in many repos

<!-- relationships:end -->
