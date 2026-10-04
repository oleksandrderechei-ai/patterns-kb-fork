---
title: REPR
description: "One class per operation, holding its route, its input and its output"
area: architecture
owner: Oleksandr Derechei
tags: [api-design, separation-of-concerns, testability, maintainability]
status: stable
aliases: [Request-Endpoint-Response, REPR pattern, API endpoints]
solves: [our controller has fifteen constructor dependencies and each action uses two of them, four of us keep colliding in the same controller file, I cannot test one endpoint without spinning up the whole web host, the routing table and the handler live in different files and have drifted apart, adding one operation to this class means everything else in it gets retested]
---

# REPR

Gives every operation its own class — the request model it accepts, the handler that runs it, and the response model it returns — instead of accumulating a method per operation on a shared controller that ends up depending on everything any of them needs.

## What it is
<!--meta block=description-->

A controller with a method per operation collects every action's dependencies, so a fifteen-dependency constructor serves methods that each use two. REPR (Request, Endpoint, Response) gives each operation its own class: a request model, an endpoint that handles exactly that request, and a response model. The route and verb sit inside the endpoint, so one operation lives in one file.

## Explained
<!--meta block=explain-->

REPR gives each web operation its own small class: a request model that says what comes in, an endpoint that handles exactly that request, and a response model for what goes out. Steve Smith is credited with the pattern. The route and verb sit inside the endpoint, so everything about one operation lives in one file. Choose it over a controller that holds many actions when that controller has grown a long list of dependencies that each action uses only two of, or when several people keep editing the same file. Each endpoint asks only for what it needs, so you can build it with fakes and call it with a request object, with no web host running. Where your framework already handles one route per unit, you are doing this already.

- **Many small classes.** A forty-operation API becomes forty endpoints plus models, so keep names and folders strict.
- **Shared behaviour has no home.** Attach login checks and validation once as a pipeline step wrapping each endpoint, not copied in.
- **Misnamed classes may get no route.** They fail as a 404, so test that each route answers.

**Example.** An orders controller has 12 actions and a 15-dependency constructor, and cancelling an order uses 2 of them. Its test must fake all 15 dependencies to build the controller. As a CancelOrder endpoint it takes just the order store and a clock, so a test passes two fakes and a request object and runs in-process with no web host. Checking that the caller owns the order is needed by all 12 operations. Copied into 12 endpoints it is 12 places to fix, so the team writes it once as a pipeline step. The cost is 12 endpoint files plus their request and response models in place of one controller.

## How it works
<!--meta block=structure-->

```mermaid caption="What does adding a sixteenth operation cost here? One new class. No shared constructor grows, and no existing endpoint's code changes. The subgraph needs the most care: with no base controller, it is the only place shared behaviour can live once."
flowchart LR
    C["Client"]
    B["Bind + validate"]
    subgraph P["Pipeline — where shared behaviour lives"]
        E["Endpoint for this operation"]
    end
    D[("Store or service")]
    R["Serialize"]
    C -->|"1 POST /orders"| B
    B -->|"2 typed request model"| E
    E -->|"3 only its own dependencies"| D
    E -->|"4 typed response model"| R
    R -->|"5 HTTP response"| C
```

## Variations
<!--meta block=variations-->

- **Function per route** — The minimal form: a route and its handler declared together, with the request and response types being the function's signature. No library, no class, and the same one-operation-one-place property — the right starting point if the framework supports it.
- **Framework base class** — An abstract endpoint generic over its request and response types, with per-endpoint configuration overridden rather than declared centrally. Most of the boilerplate disappears, at the cost of a library dependency and its conventions.
- **Endpoint over a dispatched request** — The endpoint only translates transport into a request object and hands it to a separate handler, so the same handler serves an HTTP call, a queue consumer and a scheduled job. This is where the pattern meets the [vertical slice](./vertical-slice.md) and stops being only about the web edge.
- **Hand-rolled with convention scanning** — One class per route, registered by scanning an assembly or directory. No dependency at all, and the trade is explicitness: a mis-named class simply never gets a route, and nothing fails at build time.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No dependency pile-up** — each operation declares only the dependencies it actually uses, so no constructor accumulates the union of everything.
- **An endpoint is testable without a web host**: construct it, hand it a request model, assert on the response.
- **Merge conflicts drop** for operations that touch only their own file, because two people adding two operations are adding two files. An explicit registration list or a shared model still collides.
- **The route, the binding** and the handler are in one file, so they cannot drift apart the way a separate routing table does.
- **Adding an operation touches no existing endpoint's code**, so review and regression risk stay local. Build and test scope shrink only if the code is split into separately built modules, and changing a pipeline stage or shared type still affects every endpoint.

### Cons
<!--meta polarity=con-->

- **Many small files** instead of a few large ones: a forty-operation API becomes forty endpoint classes plus their models.
- **Genuinely shared behaviour has no obvious home**, and without a pipeline it gets copied into every endpoint.
- **There is no single class** listing an area's operations, so navigating the API depends entirely on naming and folder layout.
- **Per-operation request and response models** add mapping code that a controller sharing one model does not pay.
- **Convention-scanned registration is quieter than a routing table**: a mis-named class gets no route, and the failure is a 404 rather than a build error.
- **Some ecosystems have no idiomatic support**, so the pattern arrives as a library dependency with its own conventions and lifecycle.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A controller has grown enough constructor dependencies** that most of its actions use only a couple of them.
- **Several people edit the same controller** and keep colliding in it.
- **An operation should be testable** without starting a web host or building a route table.
- **Operations in one area differ enough** that a shared base class fits none of them well.

### Avoid when
<!--meta polarity=avoid-->

- **The framework's own request-handling unit** is already one per route — you have this, and a library would add ceremony to it.
- **The API is a handful of operations** that genuinely share the same dependencies.
- **There is no mechanism available to wrap endpoints**, because then shared behaviour will be copied and the pattern costs more than it saves.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — two endpoints and the pipeline that wraps both"
interface Endpoint<Req, Res> {
  method: "GET" | "POST";
  route: string;                       // the route lives WITH the handler
  handle(req: Req): Promise<Res>;
}
// ---- endpoints/place-order.ts ----
type PlaceOrder = { sku: string; qty: number };
class PlaceOrderEndpoint implements Endpoint<PlaceOrder, { orderId: string }> {
  method = "POST" as const;
  route = "/orders";
  // Declares ONE dependency, because this operation needs one. A controller
  // hosting this action alongside nine others would declare all ten.
  constructor(private orders: OrderStore) {}
  async handle(r: PlaceOrder) { return { orderId: await this.orders.place(r.sku, r.qty) }; }
}
// ---- endpoints/get-order.ts: same shape, a different dependency entirely ----
class GetOrderEndpoint implements Endpoint<{ id: string }, OrderView> {
  method = "GET" as const;
  route = "/orders/:id";
  constructor(private views: OrderViewStore) {}
  handle(req: { id: string }) { return this.views.byId(req.id); }
}
// ---- the pipeline: the ONLY place cross-cutting behaviour belongs ----
const defaultStages: Stage[] = [authz, validate, txScope];
function register<Req, Res>(app: App, e: Endpoint<Req, Res>, ...extra: Stage[]) {
  const stages = [...defaultStages, ...extra];   // a new endpoint cannot skip the defaults
  app.route(e.method, e.route, async (http) => {
    let ctx = { body: http.body as Req, user: http.user };
    for (const stage of stages) ctx = await stage(ctx);
    http.json(await e.handle(ctx.body));
  });
}
// ---- one list, one loop: every endpoint is registered the same way ----
[new PlaceOrderEndpoint(orders), new GetOrderEndpoint(views)].forEach((e) => register(app, e));
```

## In the wild
<!--meta block=wild-->

- **FastEndpoints** — Provides an endpoint base class generic over request and response types, with per-endpoint route and configuration declared by overriding rather than in a central table — the library the pattern is most often written with. {#wild-fastendpoints}
- **ASP.NET Core minimal APIs** — The function-per-route form: a route and its handler are declared together, and the handler signature is the request and response contract. {#wild-aspnet-minimal-apis}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Endpoint registration mode** — Explicit registration versus a convention scan over endpoint classes. A scan is less code; an explicit list fails loudly when a class is renamed.
- **Pipeline stage order** — The sequence of wrapping behaviours — authentication, authorization, validation, transaction scope, logging. Order changes semantics: validating before authorizing leaks information about what exists.
- **Request-model binding strictness** — Whether unknown fields in a request body are ignored or rejected. Strict binding turns a client mistake into a clear error instead of a silently dropped value.

### Signals to watch
<!--meta polarity=signal-->

- **Routes registered versus endpoint classes present** — The two counts should match exactly. Take the registered count from the framework's route dump or the app's own register() calls and the class count from the same directory or assembly scan, and fail startup on a mismatch. A gap is the direct symptom of convention-based registration silently skipping a class.
- **Per-endpoint latency and error rate** — Keyed by route this matches per-action metrics on a controller. The gain is attribution: a slow operation maps to one class and file rather than a method inside a shared controller.
- **Endpoints not covered by the pipeline** — Any endpoint registered without the standard stages. This is where an authorization gap hides.

### Failure modes under load
<!--meta polarity=failure-->

- **A renamed endpoint silently loses its route** — Convention scanning stops matching the class, so the operation returns not-found in production while the build and every unit test pass.
- **Cross-cutting behaviour copied per endpoint** — Without a pipeline, authorization and logging get pasted into each class — and the one that was added last does not have them.
- **Pipeline stage skipped on a new endpoint** — An endpoint registered by hand omits a stage the others have, so one operation is unauthenticated or untransacted while nothing looks wrong.

### Readiness checklist
<!--meta polarity=check-->

- Cross-cutting behaviour is applied by a pipeline every endpoint goes through, not copied into endpoint classes.
- Registration is verified: the number of routes registered is asserted against the number of endpoint classes, so a rename fails the build rather than a request.
- Endpoints are grouped in folders named after the API area, since there is no longer a class listing an area's operations.
- Each endpoint has a unit test that constructs it directly with fakes, with no web host involved.
- Pipeline stage order is written down, because authorization before validation and the reverse have different disclosure behaviour.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Architecture Styles](../../themes/architecture-styles.md) — Give each operation its own request, endpoint and response. {#fluency-architecture-styles}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Vertical Slice](./vertical-slice.md) — The same one-per-request instinct, applied at the transport edge rather than to the whole feature
- [Single Responsibility Principle](../../principles/single-responsibility.md) — The unit of responsibility becomes one operation, which is the granularity the maxim actually implies
- [DTO](../enterprise/dto.md) — The request and response models are purpose-shaped carriers, one pair per operation

**Alternative to**

- [MVC](./mvc.md) — Both organize the transport edge: a class per operation, or a class per area with a method each

**Prevents**

- [God Object](../../hazards/god-object.md) — An operation cannot accumulate onto a shared class if each one has its own

<!-- relationships:end -->
