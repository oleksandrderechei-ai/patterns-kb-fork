---
title: Service Layer
description: Defines an application's operations as one boundary
area: enterprise
owner: Oleksandr Derechei
tags: [api-design, separation-of-concerns, decoupling, boundaries]
status: stable
aliases: [application service]
solves: [my HTTP controller and my nightly job both re-implement the same checkout steps, I added an API next to the web UI and had to duplicate every workflow, transaction begin and commit is copy-pasted into every request handler, business workflow ended up living inside my web controllers, there is no single place to hang authorization for an operation]
---

# Service Layer

Defines every one of an application's business operations behind a single boundary, so every caller — a controller, an API endpoint, a batch job, a test — invokes the same use case the same way.

## What it is
<!--meta block=description-->

Every entry point, such as a web controller, a command line tool or a scheduled job, repeats the same steps: open a transaction, load objects, call the domain in order, map the result. A service layer is a thin set of coarse methods like placeOrder, each one use case, that does this once and returns a plain result.

## Explained
<!--meta block=explain-->

A service layer is a thin set of coarse methods, such as placeOrder or issueRefund, that each carry out one use case. A method opens the transaction, loads the objects it needs through [repositories](repository.md), calls the domain methods in the right order, and returns a plain [DTO](dto.md) so callers never see the domain model's shape. A web controller, a command line tool and a scheduled job all call the same method, so the sequence is written once. Choose it over putting that sequence in each entry point when two or more kinds of caller run the same operation or you need one place for transaction boundaries and permission checks. With a single caller and a few operations, calling the domain directly is simpler.

- **Pass-through layer.** It forwards calls and adds nothing, so create a method only when it sequences something.
- **Swallowed rules.** It gathers business rules that belong in the domain model, so keep rules on domain objects and let the service only order calls.

**Example.** Placing an order takes 4 steps: reserve stock, charge the card, save the order and send a receipt. Three entry points need it: the web form, a mobile API and a nightly import. Without a service layer that is 3 x 4 = 12 steps written out, and a fifth step, fraud check, must be added in 3 places. With placeOrder it is 4 steps once, and the fraud check is one edit. The rule that stock cannot go below zero stays in the Stock object. The cost is that every caller must go through placeOrder, even for the simplest case.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does one use case begin and end? Every caller enters by the same door (1); loading, applying rules and saving (2–6) happen inside one transaction, and step 7 hands back a plain DTO — no caller ever holds the aggregate."
flowchart LR
    Web["Web controller"]:::ext
    Job["Nightly job"]:::ext
    subgraph Tx["placeOrder — one transaction"]
        Svc["Order service"]
        Dom["Order aggregate"]
        Repo["Order repository"]
    end
    DB[("Orders database")]
    Web -->|"1 placeOrder(dto)"| Svc
    Job -->|"1 placeOrder(dto)"| Svc
    Svc -->|"2 load"| Repo
    Repo -->|"3 read rows"| DB
    Svc -->|"4 apply rules"| Dom
    Svc -->|"5 save"| Repo
    Repo -->|"6 write rows"| DB
    Svc -->|"7 return dto"| Web
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="One service-layer call coordinates the domain model and a repository inside a single transaction, then hands back a plain result — the client never touches either directly."
sequenceDiagram
    autonumber
    participant C as Client, UI or API
    participant S as Service Layer
    participant D as Domain Model
    participant R as Repository
    C->>S: placeOrder(dto)
    S->>R: load order aggregate
    S->>D: apply business rules
    alt rules satisfied
        S->>R: save aggregate
        S-->>C: return result dto
    else rule violated
        S-->>C: throw, roll back transaction
    end
```

## Variations
<!--meta block=variations-->

- **Local vs. remote interface** — A plain in-process facade the same process calls directly, or a coarse-grained boundary that marshals arguments and results across a network call.
- **Thin vs. thick service layer** — Thin delegates every rule to a rich domain model; thick absorbs the business logic itself, blurring into a set of procedures per operation.
- **Application service vs. domain service** — An application service coordinates a use case end to end; a domain service is stateless, purely domain-focused logic with no awareness of the caller.
- **[Command / query](../architecture/cqrs.md) split** — Separate service classes for state-changing operations and read-only queries, mirroring a CQRS (Command Query Responsibility Segregation)-style split without a full separate read model.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One coarse-grained entry point per use case**, callable identically from any client.
- **Centralizes transaction boundaries**, so where a [unit of work](./unit-of-work.md) starts and ends is defined once.
- **Decouples callers from the domain model's internal shape** — it can be refactored freely underneath.
- **A natural seam for cross-cutting concerns**: authorization, logging, validation, caching.

### Cons
<!--meta polarity=con-->

- **Easy to degrade into a pass-through facade** that forwards calls and adds nothing but indirection.
- **Can accumulate business rules** that belong in the domain model, becoming a god-class over time.
- **Extra layer to navigate and test** when the domain is small enough not to need one.
- **Without discipline**, validation ends up duplicated between the service and the domain objects it calls.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple client types** — a web UI, an API, a batch job — need to invoke the same business operations.
- **You need one place to define transaction boundaries**, authorization, or use-case-level workflow ordering.
- **The domain model is rich enough** that orchestration logic would otherwise crowd into it or into controllers.

### Avoid when
<!--meta polarity=avoid-->

- **There's a single client** and a handful of operations — calling the domain model directly is simpler.
- **The domain is anemic** and the operations are one procedure each — a service layer just adds a layer over nothing.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an order service coordinating one use case"
interface PlaceOrderDto { customerId: string; lines: OrderLineDto[]; }
interface OrderDto { id: string; total: number; status: string; }

class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async placeOrder(input: PlaceOrderDto): Promise<OrderDto> {
    return this.uow.transaction(async () => {
      const customer = await this.orders.findCustomer(input.customerId);
      const order = Order.create(customer, input.lines); // rules live in Order
      order.applyDiscounts();
      await this.orders.save(order);
      return toOrderDto(order); // map domain -> DTO at the boundary
    });
  }
}

// Every caller — controller, job, test — uses the same entry point:
const dto = await orderService.placeOrder({ customerId: "c1", lines });
```

## In the wild
<!--meta block=wild-->

- **Spring Framework** — Its @Service stereotype marks the use-case boundary, and @Transactional wraps the method through an aspect-oriented programming (AOP) proxy that opens and commits the transaction, with configurable propagation, isolation, timeout, and rollback rules. {#wild-spring-service}
- **NestJS providers** — Services are classes marked `@Injectable()` and injected into controllers, which is the framework's recommended place for business logic. {#wild-nestjs-providers}
- **ABP Framework application services** — An application layer of classes implementing `IApplicationService`, which the framework exposes as the use-case boundary of a .NET application. {#wild-abp-app-services}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Transaction isolation level** — The isolation the use-case transaction runs at; higher isolation cuts anomalies but raises lock contention and abort rate.
- **Transaction timeout** — Upper bound on how long the use-case transaction may hold its connection and locks before rollback.
- **Transaction propagation / nesting** — Whether a service method joins the caller transaction or starts its own; mis-set, it silently splits or merges what should be one boundary.

### Signals to watch
<!--meta polarity=signal-->

- **Transaction duration p99** — How long a use case holds its transaction; long transactions hold connections and locks.
- **Rollback rate** — Fraction of use-case transactions that roll back, from conflicts, timeouts, or validation failures.
- **Connection pool wait time** — Time callers wait for a free database connection; it rises when transactions are held too long.
- **Lock wait time** — Time transactions spend blocked on row locks held by other use cases.

### Failure modes under load
<!--meta polarity=failure-->

- **External I/O inside the transaction** — A remote call or slow computation between begin and commit holds the database connection and locks for its whole duration, throttling throughput.
- **Connection pool exhaustion** — Long-held transactions consume every pooled connection; new use cases queue and time out.
- **Deadlock between use cases** — Two service methods lock the same rows in opposite order and block each other until one is aborted.

### Readiness checklist
<!--meta polarity=check-->

- Keep transaction boundaries tight — no network or external I/O between begin and commit.
- Set an isolation level and timeout per operation instead of accepting one global default blindly.
- Make command operations idempotent so a client retry after a timeout does not double-apply.
- Keep one transaction per use case; do not let a request span several service calls each with its own.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [API Design](../../themes/api-design.md) — The operation boundary the application programming interface (API) surface sits on {#fluency-api-design}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Repository](./repository.md) — Services orchestrate repositories
- [DTO](./dto.md) — Services accept and return data transfer objects (DTOs) at the boundary
- [Front Controller](./front-controller.md) — A service layer is called by handlers that a front controller chose
- [Layered / N-Tier](../architecture/layered.md) — Layered is the tier stack whose business tier a service layer fronts.

**Alternative to**

- [Transaction Script](./transaction-script.md) — A rich operations boundary vs. one procedure per transaction
- [Domain Service](../ddd/domain-service.md) — A service layer runs use cases and calls the domain service for the rule

**Prevents**

- [Busy Database](../../hazards/busy-database.md) — Somewhere obvious for logic to live other than a stored procedure

**Exposed to**

- [Anemic Domain Model](../../hazards/anemic-domain-model.md) — Can fall into anemic domain model when a service layer that holds all the rules turns the domain classes into bags of fields
- [God Object](../../hazards/god-object.md) — Can fall into god object when a service layer tends to collect every use case into one manager class

<!-- relationships:end -->
