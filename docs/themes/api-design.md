---
title: API Design
description: "Shaping a boundary that clients you don't control can discover, evolve with, and safely retry"
area: themes-shaping
owner: Oleksandr Derechei
tags: [api-design, boundaries]
status: stable
---

# API Design

An API is a contract with clients you don't own and can't redeploy — so the design problem is making a boundary that's discoverable, hard to misuse, cheap to evolve, safe under retries, and shaped to fit each client, from a mobile app to an autonomous agent.

## The question
<!--meta block=description-->

A published API is a contract that callers you have never met build against, so every change risks breaking one of them. The design questions follow. Can callers discover it without reading your source? Can it evolve without breaking them? Is a retry after a timeout safe? Does one shape fit a phone, a partner and a batch job? And what does the boundary look like when the caller is a program or an agent?

## Explained
<!--meta block=explain-->

Designing an API means shaping a boundary that callers you do not control build against, so every field you publish is a promise you must keep. Put sign-in checks, limits and routing in one [API gateway](../patterns/distributed/routing/api-gateway.md), so no service repeats them. Choose one shared API when your clients want about the same calls. Choose a backend per client type (a small server that serves only the mobile app, say) when one screen needs several calls that could be one. Each promise also brings a failure. Changing a field breaks callers, so run [versions](../patterns/distributed/routing/api-versioning.md) side by side. A write that times out may or may not have happened, so make the client send a unique key and have the server return the first result for a repeated key ([idempotency](../patterns/messaging/idempotency.md)). One busy caller can starve the rest, so cap each caller with a [rate limiter](../patterns/distributed/resilience/rate-limiter.md), an allowance that refills at a fixed rate and permits short bursts.

- **Shared shape.** One API fits unlike clients badly and each extra backend means more code, so split only where one screen needs several calls.
- **Version overhead.** Each live version adds a full test run, so run few and set the move-by date from your slowest client's release cycle.
- **Key storage.** The server keeps each key to answer a repeat, so expire keys after your longest real retry, such as a day.
- **Refused callers.** Limits turn bursts into errors, so return a retry-after hint and size bursts to real clients.

**Example.** A bank app home screen needs the balance, 10 recent payments and offers. On a shared API that is 3 calls of 100 ms each, 300 ms in sequence. A mobile backend joins them in one 120 ms call, and you now maintain a second server. A payment POST times out at 5 s and the app retries. With no key, the customer is charged 40 twice. With a key, the server returns the first attempt's result, at the price of storing each key for 24 h. A partner is capped at 100 requests a second with a burst of 200. A script sending 200 a second drains the bucket in 2 s, then only 100 a second pass.

## The trade-space
<!--meta block=tradespace-->

Most API-design decisions are the same handful of tensions wearing different clothes. **Granularity**: fine-grained endpoints are flexible but chatty — a mobile client pays for every round trip — while coarse-grained ones cut trips but couple callers to a bigger shape. **One interface vs. many**: a single universal API is simple to run but fits no client well, whereas a backend per client type fits each but multiplies what you maintain. **Stability vs. change**: every field you expose is a field you've promised to keep; evolvability comes from versioning and tolerant readers, not from freezing the contract.

Two axes matter more now than they used to. The first is **request/response vs. streaming**: some answers aren't a single payload but a long-lived flow — progress events, a token-by-token generation, a live feed — which changes timeouts, buffering, and connection affinity all at once. The second is **who the client is**: a human-driven app, a partner service, and an autonomous agent want different contracts. An agent needs operations it can enumerate and understand at runtime — self-describing, discoverable tools — where a mobile app just needs the three calls its screen makes.

None of these has a global right answer; each is a dial you set per boundary. The patterns below are the mechanisms for setting them deliberately, instead of discovering the default the first time a client outgrows it.

```mermaid caption="Every client meets the same boundary; the design work is deciding how much it shapes, protects, and streams for each."
flowchart LR
    C1["Web / mobile app"] -->|"a few coarse calls"| G
    C2["Partner service"] -->|"stable versioned contract"| G
    C3["Autonomous agent"] -->|"discoverable, self-describing tools"| G
    G["Boundary: authn · validate · rate-limit · shape · route"] -->|"route request"| S["Backing services"]
    G -.->|"long-lived flow"| ST["Streaming response"]
```

## Patterns that shape the boundary
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [API Gateway](../patterns/distributed/routing/api-gateway.md) {#tour-api-gateway}

The one entry point external clients talk to. It's where cross-cutting boundary concerns — auth, rate limiting, routing, aggregation, and increasingly streaming and agent-facing surfaces — live, so no backing service has to reimplement them.

### [Front Controller](../patterns/enterprise/front-controller.md) {#tour-front-controller}

One handler receives every request, runs the shared steps and dispatches to the right controller. An application programming interface (API) gateway is the same idea across services.

### [API Routing](../patterns/distributed/routing/api-routing.md) {#tour-api-routing}

Before deciding what the front door does, decide what it reads. A path prefix gives callers one address to learn and every team a shared configuration to change carefully; a hostname gives each team its own name and each caller another to remember; a header carries versions, variants and canaries on top of either. The choice sets who bears the cost each time a service is added.

### [Backend-for-Frontend](../patterns/distributed/routing/bff.md) {#tour-bff}

The answer to "one size fits no one". Each class of client — web, mobile, partner, or an artificial intelligence (AI) agent — gets a backend shaped around exactly the calls and payloads it needs, rather than sharing one application programming interface (API) that compromises on all of them.

### [DTO](../patterns/enterprise/dto.md) {#tour-dto}

The shape of what actually goes over the wire. A deliberate transfer object decouples the application programming interface (API)'s payload from internal domain models, so you can evolve one without breaking the other — the difference between a stable contract and leaking your database schema.

### [Facade](../patterns/gof/structural/facade.md) {#tour-facade}

The in-process ancestor of every application programming interface (API): one coarse, purpose-built interface that hides a tangle of collaborators behind it. Designing an API well is largely designing a good facade over your domain — expose the intent, not the machinery.

### [Service Layer](../patterns/enterprise/service-layer.md) {#tour-service-layer}

The set of application operations the application programming interface (API) exposes, defined in one place independent of transport. It keeps the same use cases available whether they're called over representational state transfer (REST), a message, or a gRPC method, so the API is a thin skin over a real boundary.

### [Intercepting Validator](../patterns/security/intercepting-validator.md) {#tour-intercepting-validator}

Everything crossing the boundary is attacker-controlled until proven otherwise. Validating and sanitising requests at the edge — before they reach any logic — is how an application programming interface (API) stays hard to misuse and hard to exploit.

### [Idempotency](../patterns/messaging/idempotency.md) {#tour-idempotency}

The property that lets a client retry a failed or timed-out call without fear. An idempotency key or a naturally repeatable operation turns "did that go through?" from a support ticket into a safe retry — essential for any write application programming interface (API) on a real network.

### [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) {#tour-rate-limiter}

The throttle that keeps one client — buggy, abusive, or just popular — from starving everyone else. Publishing an application programming interface (API) means publishing a limit; a token-bucket allowance is the usual way to cap the average rate while still tolerating short bursts.

### [Pagination](../patterns/distributed/routing/pagination.md) {#tour-pagination}

A collection endpoint with no upper bound is a promise you cannot keep once the table grows. Handing back a bounded page plus a way to ask for the next one caps what any single request costs. Choosing a cursor over an offset keeps the last page as cheap as the first, when the cursor column is indexed.

### [API Versioning](../patterns/distributed/routing/api-versioning.md) {#tour-api-versioning}

The answer to "we published it, so now we cannot change it". Running the old and new contracts side by side lets callers migrate on their schedule instead of yours; where the version rides — path, query, header, media type — decides who can cache the response and how many contracts you can afford to keep alive.

### [Asynchronous Request-Reply](../patterns/distributed/routing/async-request-reply.md) {#tour-async-request-reply}

Some operations take longer than any connection between you and the caller will survive. Accepting the request, returning the address of a status resource, and doing the work elsewhere keeps the boundary responsive. It also makes the idempotency key on the accepting request close to mandatory, because a timed-out accept is otherwise retried blind.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Shape | Reach for |
| --- | --- | --- |
| One entry point that routes, authenticates, and throttles | Front door | [API Gateway](../patterns/distributed/routing/api-gateway.md) |
| Each client type to get calls shaped for its screens | Per-client | [Backend-for-Frontend](../patterns/distributed/routing/bff.md) |
| A payload contract you can evolve without leaking internals | Contract | [DTO](../patterns/enterprise/dto.md) over a [Service Layer](../patterns/enterprise/service-layer.md) |
| Writes that survive a timeout-and-retry unharmed | Safe retry | [Idempotency](../patterns/messaging/idempotency.md) |
| To keep one caller from overwhelming the backend | Throttle | [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) |
| A long-lived flow or an agent-discoverable surface | Streaming / agent | [API Gateway](../patterns/distributed/routing/api-gateway.md) (the Streaming Gateway and Agent-Facing Gateway variations) |
| A list endpoint that grows without bound | Bounded reads | [Pagination](../patterns/distributed/routing/pagination.md) |
| Work that outlives a connection | Handle, not a held call | [Asynchronous Request-Reply](../patterns/distributed/routing/async-request-reply.md) |
| A field must change while live callers depend on it | Versioned contract | [API Versioning](../patterns/distributed/routing/api-versioning.md) |
| Untrusted input reaching your handlers | Edge check | [Intercepting Validator](../patterns/security/intercepting-validator.md) |

## Related areas
<!--meta block=siblings-->

- [Auth & Access](./auth-and-access.md) — Who may call the API and what they're allowed to do at the boundary.
- [Resilience](./resilience.md) — Timeouts, retries, and idempotency that keep the API dependable under failure.
- [Performance](./performance.md) — Caching and load balancing that decide how the boundary scales and how fast it answers.
- [Scalability](./scalability.md) — Growing the capacity behind the API as callers and load multiply.
- [Streaming](./streaming.md) — When the response isn't one payload but an unbounded flow the API must carry.
- [Long-Running Tasks](./long-running-tasks.md) — The queue, worker and redelivery mechanics behind an accepted request; this page covers the status-resource contract the caller sees.
