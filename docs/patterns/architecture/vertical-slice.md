---
title: Vertical Slice
description: "Organize code by feature end to end, not by technical layer"
area: architecture
owner: Oleksandr Derechei
tags: [modularity, maintainability, boundaries, decoupling]
status: stable
aliases: [VSA, vertical slice architecture, feature folders]
solves: [a one-line feature change means editing files in five different folders, every new endpoint has to pass through a repository and a service that add nothing, two people editing the same service class keep colliding in merges, our interfaces have exactly one implementation each and exist only to satisfy the layering rule, I cannot tell where a feature lives without grepping the whole codebase for it]
---

# Vertical Slice

Files a codebase by request rather than by tier: one folder per use case holding its input model, its validation, its handler, its data access and its response — so a feature is added in one place, and the abstractions a feature does not need are never written for it.

## What it is
<!--meta block=description-->

Change requests name features, not tiers, yet filing code by tier spreads a one-line change across five folders and makes shared classes where people collide. A vertical slice keeps everything one request needs in one place: its input, validation, the work, the query or write, and the answer. You file code by feature.

## Explained
<!--meta block=explain-->

You file code by feature instead of by tier, so a change to one feature is a change in one folder. A vertical slice keeps its input shape, validation, the work itself, the query or write, and the shape of its answer together. Choose it over a [layered](layered.md) design when change requests name features, not tiers, and each tier has grown a shared class that every feature edits. The coupling rule inverts: keep coupling inside a slice high and across slices low, even if two slices each carry a nearly identical query. Proponents of the pattern warn against it for a team that cannot tell chosen duplication from neglect, since the layering rule no longer does that thinking for you.

- **Chosen duplication.** When a third slice needs the same logic, or it is a business rule, move it into a shared domain model.
- **No rule spans all slices.** Write such rules as a test that scans every slice.
- **Unwired handlers.** A misnamed handler may never be wired, so test each route once.

**Example.** Adding a gift note to an order touches five folders in a tiered codebase: controller, service, repository, transfer object and validator. In a slice layout it is one folder, PlaceOrder, with the request, the check that the note has at most 140 characters, the handler and the insert. Two slices, ListOrders and OrderDetails, each carry the same query that selects the order columns for a customer. A fix to the column list lands in one slice and not the other, so the team adds a test that both queries return the same columns. The cost is that test, and a closer look when the query appears a third time.

## How it works
<!--meta block=structure-->

```mermaid caption="What connects the two slices? Nothing — and that is the design. Each reaches the store the way its own request wants to, so the write slice can carry a domain model while the read slice carries a single projection query. In a layered version both would be forced through one repository interface that suits neither."
flowchart LR
    C["Client"]
    R["Route dispatch"]
    subgraph S1["Slice: place order"]
        H1["Handler + validation"] --> M1["Response model"]
    end
    subgraph S2["Slice: order history"]
        H2["Handler"] --> M2["Response model"]
    end
    D[("Store")]
    C -->|"1 request"| R
    R -->|"2 dispatch by request type"| H1
    R -->|"2 dispatch by request type"| H2
    H1 -->|"3 write"| D
    H2 -->|"3 read"| D
    M1 -->|"4 response"| C
    M2 -->|"4 response"| C
```

## Variations
<!--meta block=variations-->

- **Feature folders** — The safest first step: keep the layered project intact but move each feature's files into one folder per feature. Navigation improves immediately, the shared tiers stay, and no dependency rule changes yet.
- **Slice per request, with a dispatcher** — The full form. Each request is a type, each type has exactly one handler, and the transport layer only translates HTTP into a request object and hands it over — so the same handler serves a queue consumer or a scheduled job unchanged.
- **Slices over a shared domain core** — Slices own their own read and write path, but invariants stay in a domain model both sides call. The usual landing place on a system with real business rules: the slice decides how to fulfil a request, the domain still decides what is legal.
- **Asymmetric slices** — Write slices carry the full machinery — validation, domain model, transaction — and read slices carry one query and a projection. This is [command query responsibility segregation (CQRS)](./cqrs.md) arriving as a consequence of the filing rather than as a decision, which is a low-cost way to get it, since no separate read model or sync is built; separate read stores are a further, separate step.
- **Slice per feature area** — The coarser grain, where a slice is a whole feature area with its own internal structure and a published interface. At this size the slice is a module boundary, and the next step along the same axis is giving it its own deployment — which is [Microservices](./microservices.md).

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **A feature is added**, read and deleted in one place, so the cost of a change tracks the size of the change.
- **A simple request is allowed to be simple** — no repository or service layer is written for a read that does not need one.
- **Merge conflicts drop**, because two people working on two features are working in two folders rather than in one shared class.
- **Tests target the slice's own entry point**, which removes the mock-per-layer shape a layered design forces on every test.
- **Each slice can choose its own data-access approach**, so one hot query can be hand-written without every other feature paying for the escape hatch.

### Cons
<!--meta polarity=con-->

- **Duplication is accepted on purpose**, and telling deliberate duplication from neglect is a judgement no rule makes for you.
- **No single place enforces a cross-cutting rule**, so a policy change can mean touching many slices.
- **A newcomer gets no tier-shaped** map of the system, so orientation depends entirely on naming and folder layout.
- **It demands refactoring maturity**, which proponents of the pattern name as a precondition. Without it, slices drift into copies.
- **Nothing structural stops a slice** reaching into storage in a way the domain forbids, so that invariant is defended by review or by a domain model rather than by the layout.
- **Convention-driven dispatch is quieter than a routing table**: a mis-named handler simply never gets wired, and nothing fails at compile time.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The unit of change** is a feature and your folders are organized by tier, so every change is a tour of the codebase.
- **Your interfaces have exactly one implementation each** and exist to satisfy the layering rule rather than to serve a second implementation.
- **Requests differ enough** that one shared data-access shape fits none of them well.
- **A team owns a feature** area end to end and wants to move inside it without coordinating on shared classes.

### Avoid when
<!--meta polarity=avoid-->

- **The team has no refactoring habit** — the accepted duplication needs someone to notice when it has stopped being deliberate.
- **Most requests genuinely do the same thing** to the same data, so the shared layer is earning its keep.
- **One place must enforce an invariant** — a cross-cutting invariant is enforced in one place by construction, not by convention.
- **The codebase is small enough** that navigation was never the problem. A full slice-per-request move costs a rewrite; [feature folders](vertical-slice.md#variations-item-1) cost a file move and buy little here.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — one slice, and the dispatcher that finds it"
// ---- the whole seam: a request type, and a handler for exactly that type ----
interface Handler<Req, Res> {
  rules(req: Req): string | null;   // the slice's own input rules; null means valid
  handle(req: Req): Promise<Res>;
}
type Step = (req: unknown, next: () => Promise<unknown>) => Promise<unknown>;
declare const db: any, app: any;
declare const authorize: Step, inTransaction: Step, log: Step;
const handlers = new Map<string, Handler<never, unknown>>();

function slice<Req, Res>(name: string, h: Handler<Req, Res>): void {
  handlers.set(name, h as unknown as Handler<never, unknown>);
}

// ---- the dispatch pipeline: cross-cutting policy, written once for every slice ----
async function dispatch(name: string, req: unknown): Promise<unknown> {
  const h = handlers.get(name) as Handler<any, unknown> | undefined;
  if (!h) throw new Error(`no handler for ${name}`);
  const validate: Step = async (r, next) => {
    const err = h.rules(r);
    if (err) throw new Error(err);
    return next();
  };
  const steps = [log, authorize, validate, inTransaction];
  return steps.reduceRight<() => Promise<unknown>>(
    (next, step) => () => step(req, next),
    () => h.handle(req),
  )();
}

// ---- slices/place-order.ts — input, rules, work and output, all in one file ----
slice<{ sku: string; qty: number }, { orderId: string }>("place-order", {
  rules: (req) => (req.qty > 0 ? null : "qty must be positive"), // its own input rule
  async handle(req) {
    const row = await db.one(                                  // its own data access
      "insert into orders (sku, qty) values ($1, $2) returning id",
      [req.sku, req.qty],
    );
    return { orderId: row.id };                                // its own response shape
  },
});

// ---- slices/order-history.ts — a read, and none of what the write side needed ----
slice<{ customerId: string }, unknown[]>("order-history", {
  rules: () => null,
  handle: (req) => // one projection query: no repository, no domain model, no mapper
    db.many("select id, sku, placed_at from orders where customer_id = $1", [req.customerId]),
});

// ---- the transport edge stays thin: translate, dispatch, serialize ----
const routes = [{ path: "/orders", request: "place-order" }];
for (const r of routes) {            // boot-time check: a route with no handler fails here, not on a request
  if (!handlers.has(r.request)) throw new Error(`route ${r.path} has no handler`);
}
app.post("/orders", async (httpReq: any, httpRes: any) => {
  httpRes.status(201).json(await dispatch("place-order", httpReq.body));
});
```

## In the wild
<!--meta block=wild-->

- **MediatR** — In-process dispatch from a request type to the single handler registered for it, which is the mechanism most slice-per-request codebases are built on — the transport layer constructs a request object and hands it over. {#wild-mediatr}
- **FastEndpoints** — Ships an endpoint class generic over its request and response types, so the route, the binding, the handler and the response shape are declared in one file per operation. {#wild-fastendpoints}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Slice granularity** — Whether a slice is one request or one feature area. Per-request slices navigate best and duplicate most; per-area slices duplicate less and grow their own internal structure.
- **Shared-code promotion threshold** — How many copies of a shape you tolerate before extracting it. Set it explicitly — an unstated threshold defaults to whatever the last reviewer felt like. Count a copy as one more slice issuing the same query or logic, and write the number down; the third slice is the starting point this page uses.
- **Dispatch pipeline stages** — The behaviours wrapped around every handler — validation, authorization, transaction scope, logging. This is where cross-cutting policy lives once the layers are gone. Order matters: authorize before validating, so a caller who may not act learns nothing about the request shape, and open the transaction only around the handler.
- **Handler registration mode** — Explicit registration versus a convention scan over the slice folders. A scan is less code and fails silently on a mis-named handler.

### Signals to watch
<!--meta polarity=signal-->

- **Files touched per change** — How many files a typical feature change edits. The number the reorganization is supposed to move, and the one that tells you whether it worked. Count it from version-control history per merged change, and record the pre-migration baseline first.
- **Merge conflict rate per file** — Which files keep colliding. A shared file still topping this list means the layers came back under another name.
- **Near-duplicate query count** — How many slices issue substantially the same query. Rising steadily is the accepted duplication turning into neglect. Count it by searching the slice folders for the same query text.
- **Handlers not reached by any route** — Registered handlers with no traffic, and routes with no handler. The direct symptom of convention-based dispatch going wrong.

### Failure modes under load
<!--meta polarity=failure-->

- **Bug fixed in one copy only** — The same logic exists in several slices, gets corrected in the one that was reported, and stays wrong in the others. Find the other copies by searching for the same query or handler text across slices, fix them together, and promote the shape under the written rule.
- **Policy change misses a slice** — A new authorization or audit rule is added to the slices someone remembered, and the forgotten one keeps serving.
- **A slice bypasses the domain rules** — A slice writes storage directly in a way the domain model forbids, so an invariant holds on most paths and not on one.
- **Silent dispatch gap** — A renamed or mis-named handler stops being discovered by the convention scan, and the route returns not-found rather than failing at build time.

### Readiness checklist
<!--meta polarity=check-->

- Cross-cutting concerns — authorization, validation, transaction scope, logging — attach in one dispatch pipeline rather than being copied into slices.
- Invariants that span more than one slice live in a domain model both sides call, not in whichever slice touched them last.
- The promotion rule for duplicated code is written down, so extraction is a decision rather than a mood.
- Handler registration fails loudly: a request type with no handler, or a handler with no route, breaks the build rather than a request.
- Slice folders are named after what the system does, since navigation is now the only map a newcomer gets.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Architecture Styles](../../themes/architecture-styles.md) — Keep everything one request needs together, instead of in horizontal tiers. {#fluency-architecture-styles}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [CQRS](./cqrs.md) — Asymmetric slices are command query responsibility segregation (CQRS) arriving as a consequence of the filing
- [Don't Repeat Yourself (DRY)](../../principles/dry.md) — Deliberately relaxed between slices: duplication is accepted to keep them independent
- [REPR](./repr.md) — Request-endpoint-response (REPR) is what the slice's transport edge looks like when the endpoint is its own class
- [Rule of Three](../../principles/rule-of-three.md) — A slice layout accepts duplication between slices, and the rule says when to pull it out
- [Microservices](./microservices.md) — A coarse slice is a module boundary; giving it its own deployment is the next step.
- [Micro-Frontends](../frontend/micro-frontends.md) — Giving a UI slice its own build and deploy makes it a micro-frontend.

**Alternative to**

- [Layered / N-Tier](./layered.md) — The same code, filed the other way — by feature instead of by tier

**Often confused with**

- [Conway's Law](../../principles/conways-law.md) — A slice is easiest to keep when one team owns it, as Conway's law says.

**Prevents**

- [Big Ball of Mud](../../hazards/big-ball-of-mud.md) — Filing by feature keeps a change inside one folder instead of spreading it everywhere
- [Shotgun Surgery](../../hazards/shotgun-surgery.md) — Groups the code of one feature together, so a change to the feature stays inside its slice

<!-- relationships:end -->
