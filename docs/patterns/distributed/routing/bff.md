---
title: Backend-for-Frontend
description: One backend tailored to each client type
area: distributed-routing
owner: Oleksandr Derechei
tags: [api-design, edge]
status: stable
aliases: [BFF]
solves: [the mobile app downloads a huge payload and throws away most of the fields, our shared API is riddled with optional fields and if-client-is-ios branches, the app team is blocked for weeks waiting on the platform team to add one field, every screen fires five calls and stitches the results together in the UI, adding a field for the web dashboard broke the partner integration]
---

# Backend-for-Frontend

Gives each class of client — mobile app, web app, third-party partner — its own backend, shaped around exactly the calls and payloads its screens need, instead of forcing every client through one general-purpose API.

## What it is
<!--meta block=description-->

A **backend-for-frontend** is a thin service, owned by the team that builds one client, between that client and the shared services. One general API serving the iOS app, the web app and a partner collects optional fields, client checks and version flags until every change risks breaking another consumer. A backend per client returns exactly the shape its own screens expect.

## Explained
<!--meta block=explain-->

A backend-for-frontend is a thin service, owned by the team that builds one client such as the iOS app, that sits between that client and the shared services. It calls what it needs and returns exactly the shape that client's screens expect. Without one, a single general API serves mobile, web and partners, and its contract moves with every client's needs. Mobile wants a small payload to save battery, a dashboard wants rich data, and a partner wants a contract that never shifts. Choose it over one generic API when clients differ so much in payload, aggregation and release rhythm that no single contract fits, and when the frontend team will run a service. The shared services stay generic.

- **More services.** Each client gets one more deployable with its own pipeline and on-call, so create one only where the divergence is real.
- **Copied logic.** Login, error mapping and caching get repeated in each; a shared library fixes it but couples releases, so share only stable concerns.
- **Drift.** One entity can take a different shape behind each client, so name an owner for the shared meaning of core entities.

**Example.** The mobile order screen needs 4 fields: id, status, total and delivery estimate. The generic API returns 25 fields, 6 KB, across three services, which the app fetches in 3 sequential calls of 150 ms over cellular, 450 ms in all. A mobile BFF calls the same three services in parallel inside the data centre at 20 ms each, so the app makes one 150 ms call and waits about 170 ms. The latency gain comes from fan-out and co-location; a generic aggregating endpoint would match it, but only the BFF cuts the payload to 0.5 KB. The cost: one more service for the mobile team to run, and a second place where the order shape is defined.

## How it works
<!--meta block=structure-->

```mermaid caption="How do two clients that want different payloads share the same services? Each client's own team runs the backend that shapes its response, so the shared services stay generic and never branch on who is calling."
flowchart LR
    subgraph Team["Owned by the mobile team"]
        M["Mobile app"]
        MB["Mobile BFF"]
    end
    W["Web app"]
    WB["Web BFF"]
    Users["User Service"]:::ext
    Orders["Order Service"]:::ext
    M -->|"1 GET /mobile/home"| MB
    MB -->|"2 fetch the profile"| Users
    MB -->|"3 fetch recent orders"| Orders
    MB -->|"4 return one small payload"| M
    W -->|"5 GET /web/dashboard"| WB
    WB -->|"6 fetch the same data, richer shape"| Users
    WB -->|"7 return the dashboard payload"| W
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Per-platform BFF** — One BFF per platform — iOS, Android, web — each tuned to that platform's payload size, latency budget, and release cadence.
- **One BFF per experience** — Count BFFs by experience, not by app store: if iOS and Android present the same experience, one mobile BFF serves both. A BFF that two teams change is a shared backend again, and as its client list grows, conflicting per-client shaping forces the split anyway.
- **GraphQL BFF** — The BFF exposes one GraphQL schema instead of several representational state transfer (REST) endpoints, so each screen queries exactly the fields it needs in a single round trip.
- **Team-owned BFF** — The BFF lives in the same repo and on-call rotation as the frontend it serves, so the frontend team ships both without waiting on a shared backend team.
- **Edge-deployed BFF** — Runs as an edge function (Lambda@Edge, Cloudflare Workers) close to the client, so aggregation happens near the request instead of after a long backbone hop. It pays off only when the downstream services or their data are cached or replicated near the edge; otherwise each fan-out call crosses the long hop.
- **Agent BFF** — An autonomous AI agent is its own class of client: it discovers operations at runtime and needs self-describing, coarse-grained tools rather than the fine-grained calls a screen makes. A BFF shaped for it, exposing tools over the Model Context Protocol (MCP), can serve it better than a human-facing API.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Each client gets a payload** shaped for its screens, with far fewer unused fields and less client-side reshaping, as long as one team owns that shape.
- **Frontend teams own their BFF** and ship on their own schedule, without queuing behind a shared backend roadmap.
- **Aggregates several downstream calls into one round trip**, cutting chattiness for bandwidth-constrained clients.
- **Keeps client-specific branching out of the shared services**, which stay generic and simpler to reason about.

### Cons
<!--meta polarity=con-->

- **Multiplies backend services** — one per client type — each with its own deploy, monitoring, and on-call.
- **Cross-cutting logic** (auth, error mapping, caching) tends to duplicate across BFFs unless it's factored into a shared library.
- **The same downstream data** can end up in different shapes across BFFs unless someone owns the shared meaning.
- **Adds one more hop** and one more moving part between the client and the services it ultimately needs.
- **Fan-out ties latency and availability to the slowest downstream call**, so each call needs its own timeout and a rule for partial responses.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You serve genuinely different client** types whose data shape, aggregation, or performance needs diverge sharply.
- **A shared general-purpose API** has accreted so many client-specific branches that no one client is well served.
- **A frontend team wants** to own its own backend contract and ship on its own schedule.

### Avoid when
<!--meta polarity=avoid-->

- **There's only one client type** — a single well-designed API is simpler, with nothing to specialize for.
- **Clients' needs are similar enough** that optional fields or partial responses on one API cover them without duplication.
- **You lack the operational capacity to run**, deploy, and monitor another service per client.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a mobile BFF aggregating two services"
// timeout + partial response: see the readiness checklist
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
const ok = <T,>(r: PromiseSettledResult<T>) => r.status === "fulfilled" ? r.value : null;

// Mobile BFF: one call, shaped for the app's home screen
app.get("/mobile/home/:userId", async (req, res) => {
  const { userId } = req.params;

  // Fan out in parallel; each call gets its own timeout
  const [p, ord] = await Promise.allSettled([
    withTimeout(userService.getProfile(userId), 300),
    withTimeout(orderService.getRecentOrders(userId, { limit: 3 }), 300),
  ]);
  const profile = ok(p);
  if (!profile) return res.status(502).end(); // profile is required

  // Reshape into exactly what the mobile UI renders — nothing more
  res.json({
    name: profile.displayName,
    avatarUrl: profile.avatarSmallUrl,  // small asset, not the desktop one
    recentOrders: ok(ord)?.map(o => ({
      id: o.id,
      total: o.totalFormatted,
      status: o.status,
    })) ?? null, // orders degrade to null
  });
});
```

## In the wild
<!--meta block=wild-->

- **SoundCloud** — The team coined the term after a single monolithic public API could not serve both the web app and native mobile clients well; they split it into a backend per client experience, each owned by the team building that client. {#wild-soundcloud}
- **Netflix edge API** — Device teams wrote server-side adapter code running in the edge API layer, each tailoring the response for one class of device — TV, mobile, browser — instead of a single one-size API. {#wild-netflix-edge}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Per-downstream call timeout** — How long the BFF waits on each backend before giving up, so the slowest dependency bounds the aggregated response.
- **Fan-out concurrency** — Whether downstream calls run in parallel and any cap on simultaneous in-flight calls per request.
- **Response cache time to live (TTL)** — How long a client-shaped response or a downstream result is cached before it is refetched.
- **Downstream connection pool size** — Bounds the concurrent connections the BFF holds to each shared service.

### Signals to watch
<!--meta polarity=signal-->

- **Aggregated endpoint p99 latency** — Tracks the slowest downstream in the fan-out, which dominates the response.
- **Per-dependency error and timeout rate** — Failure rate the BFF sees toward each shared service it aggregates.
- **Response payload size** — Bytes returned to the client — the thing a mobile BFF exists to keep small.
- **Fan-out call count per request** — Downstream calls made per request, to catch accidental N+1 fan-out.

### Failure modes under load
<!--meta polarity=failure-->

- **Slowest-call stall** — One lagging downstream in a fan-out holds up the whole response unless per-call timeouts and a partial or degraded response are in place.
- **Duplicated cross-cutting logic** — Auth, error mapping, and caching drift apart across per-client BFFs when they are not factored into a shared library.
- **Shape drift** — The same downstream data ends up subtly different across BFFs, so clients disagree about the same entity.
- **BFF as a logic sink** — Business rules accrete in the BFF that belong in the shared services behind it.

### Readiness checklist
<!--meta polarity=check-->

- Per-downstream timeouts with a partial or degraded response path when a dependency is slow or down.
- Downstream calls fanned out in parallel, not chained sequentially.
- Owned by the frontend team with its own deploy pipeline and on-call.
- Shared cross-cutting concerns factored into a common library, not copy-pasted per BFF.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [API Design](../../../themes/api-design.md) — One tailored application programming interface (API) per client type instead of one universal one {#fluency-api-design}
- [Frontend Architecture](../../../themes/frontend-architecture.md) — Give each frontend its own tailored backend {#fluency-frontend-architecture}
- [Microservices Design](../../../themes/microservices-design.md) — A separate backend per class of client {#fluency-microservices-design}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Micro-Frontends](../../frontend/micro-frontends.md) — A backend for frontend (BFF) pairs naturally with a micro-frontend slice
- [API Routing](./api-routing.md) — Each client-specific backend needs its own name at the edge — a hostname, a path prefix, or a header
- [DTO](../../enterprise/dto.md) — The tailored response shape is what a client-specific backend returns
- [Interface Segregation Principle](../../../principles/interface-segregation.md) — A backend per client is the same split along who-uses-what, applied to an application programming interface (API)
- [Model Context Protocol](./mcp.md) — An agent is its own client class; a BFF exposing coarse MCP tools serves it instead of the human-facing API

**Specializes**

- [API Gateway](./api-gateway.md) — One backend per frontend, atop the gateway idea

**Prevents**

- [Chatty I/O](../../../hazards/chatty-io.md) — Aggregating per screen turns six round-trips over a slow link into one

<!-- relationships:end -->
