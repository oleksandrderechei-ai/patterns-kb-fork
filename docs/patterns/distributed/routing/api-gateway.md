---
title: API Gateway
description: Single entry point that routes to backing services
area: distributed-routing
owner: Oleksandr Derechei
tags: [routing, separation-of-concerns, decoupling, edge]
status: stable
aliases: [gateway, edge gateway]
solves: [our mobile app hardcodes the hostname of every backend service, every team wrote its own auth check and one of them got it wrong, we split a service in two and every client broke, the app makes twelve calls just to draw one screen, rate limiting lives in six codebases and none of them agree]
favourite: true
---

# API Gateway

A single front door for a constellation of backend services — every request lands here first, gets authenticated, rate-limited, and routed to the right service, so clients never learn the internal topology behind it.

## What it is
<!--meta block=description-->

A mobile app that knows the address of nine services, and proves the user's identity to each, breaks in the field when one service splits. An API gateway gives clients one address. It checks the caller once, decides from the request which service should answer, and forwards it. Clients keep a stable surface while the services behind it move.

## Explained
<!--meta block=explain-->

An API gateway gives clients one address for many backend services: it checks who the caller is once, decides from the request which service should answer, and forwards it. A [reverse proxy](reverse-proxy.md) forwards bytes, while a gateway chooses by what the request means, such as its path, API version or tenant, and applies login, quota, logging and caching on the way. Choose it when many services face outside clients and one set of rules must hold identically across all of them, so clients keep a stable surface while the services behind it are split, merged and moved. The rules then live in one deployable instead of a dozen copies that drift apart.

- **Shared release schedule.** Every team depends on one program, so split it by client type, one gateway per frontend.
- **Business logic creeps in.** Anything a second client would have to copy belongs in a service, so check this at each release.
- **On every call.** It adds a hop and a failure point, so run it scaled across zones with a timeout and circuit breaker per backend.
- **Edge-deep only.** Service-to-service traffic needs something else, such as a service mesh.

**Example.** A gateway shares 200 connections to its backends across all routes. The reports service slows to 20 s a call while receiving 10 calls a second, so after 20 s it holds all 200 connections and login and search, on the same pool, get none. With a cap of 40 connections for reports, the cap fills in 4 s. Later report calls fail at once with a 503, and the other 160 connections stay free for login and search. The cost is that reports users now see errors during the slowdown instead of long waits, and you must pick the 40 by measuring the service's normal peak.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a client reach nine services while knowing only one address? The edge takes every request, applies the shared rules once, then dispatches on what the request means."
flowchart LR
    C["Client — web, mobile, partner"]:::ext
    subgraph Edge["One entry point, one set of rules"]
        GW["API Gateway"]
        Policy["Authenticate · rate limit · log"]
    end
    S1["Orders Service"]
    S2["Users Service"]
    S3["Inventory Service"]
    C -->|"1 one address, any request"| GW
    GW -->|"2 authenticate, meter, log"| Policy
    Policy -->|"3 admitted"| GW
    GW -->|"4 dispatch on /orders"| S1
    GW -->|"5 or /users"| S2
    GW -->|"6 or /inventory"| S3
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Gateway Routing** — Pure request dispatch with no aggregation or reshaping — the thinnest form of the pattern. What the gateway reads to choose a service is a decision of its own, with its own trade-offs: a path prefix gives consumers one address and every team a shared configuration, a hostname gives each team its own name and each consumer another one to remember, and a header carries versions and variants on top of either. See [API Routing](./api-routing.md).
- **Gateway Aggregation** — Fans a single client request out to several backend calls and composes the results into one response, cutting round trips for slow or mobile clients. Response time is that of the slowest fan-out call, so set a timeout and a partial-result rule per call.
- **Gateway Offloading** — Moves shared infrastructure concerns — Transport Layer Security (TLS) termination, compression, caching, auth — out of every service and into the gateway itself.
- **[Backend-for-Frontend](./bff.md)** — One gateway per client type — web, mobile, partner — instead of a single universal gateway trying to satisfy all of their conflicting needs at once.
- **Streaming Gateway** — Carries a long-lived streaming response — server-sent events, chunked transfer, or a WebSocket upgrade — rather than buffering one payload and returning it. It shifts the gateway's job from request/response to holding an open flow, which forces different read timeouts, disables response buffering, and often needs connection affinity (see [Sticky Session](./sticky-session.md)) so the stream isn't cut mid-flight by a rebalance.
- **Agent-Facing Gateway** — Exposes backing capabilities as discoverable, self-describing tools an autonomous AI agent can enumerate and invoke at runtime, instead of fixed endpoints a human wired up ahead of time. The agent is just another client class — a [Backend-for-Frontend](./bff.md) for software that decides its own calls. Anthropic's Model Context Protocol (MCP) is an example of this tool-server shape.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One place to enforce auth**, rate limiting, and logging for edge traffic instead of duplicating it in every service; internal calls still need their own enforcement.
- **Clients depend on a stable surface**, not the internal service topology, which is free to change behind it.
- **Central point** for protocol translation and API versioning as backends evolve independently.
- **Aggregation can cut chatty round trips** for clients on slow or high-latency networks.

### Cons
<!--meta polarity=con-->

- **A single point of failure** and a potential bottleneck — run it as a horizontally scaled tier across zones, or it relocates the outage it was meant to prevent.
- **Prone to becoming a dumping** ground for business logic that belongs in the services behind it — anything a second client would have to duplicate is a service's job, not the edge's.
- **Adds a network hop** and a layer of latency to every single request.
- **Yet another highly-available deployable to build and operate**, and a shared release cadence every team routing through it now depends on — give each client class its own [backend for frontend](./bff.md) rather than negotiating one config between teams that want different things.
- **Edge policy is only edge-deep**. Service-to-service calls, batch jobs and internal tools never cross the gateway, so enforce inside the perimeter too, which is the work a [service mesh](./service-mesh.md) exists to do. Backends must also refuse traffic that skipped the gateway, or it is bypassable.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Clients — web, mobile, partners —** need one stable entry point across many backend services.
- **You need auth**, rate limiting, or logging enforced consistently without repeating it per service.
- **Backend services are being split**, merged, or migrated and clients shouldn't feel any of that churn.

### Avoid when
<!--meta polarity=avoid-->

- **There's a single backend service** — there's no fan-out to front, just call it directly.
- **Client types have sharply different aggregation needs** — one shared gateway becomes a tangle of conflicting requirements; split it with a [Backend-for-Frontend](./bff.md) per client instead.
- **The team can't yet run one more highly-available**, horizontally-scaled service — an under-resourced gateway just becomes the new single point of failure.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal routing gateway"
type Route = { prefix: string; target: string };

const routes: Route[] = [
  { prefix: "/orders", target: "http://orders-svc:3000" },
  { prefix: "/users", target: "http://users-svc:3000" },
  { prefix: "/inventory", target: "http://inventory-svc:3000" },
];

app.use(authenticate);              // once, at the edge
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

app.use(async (req, res) => {
  // no per-upstream connection pool here, see production knobs
  const route = routes.find((r) => req.path.startsWith(r.prefix));
  if (!route) return res.status(404).json({ error: "no route" });

  try {
    const upstream = await fetch(route.target + req.path, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: req.method === "GET" ? undefined : req.body,
      signal: AbortSignal.timeout(5_000), // upstream timeout knob; no retry here
    });
    res.status(upstream.status).send(await upstream.text());
  } catch (err) {
    const status = (err as Error).name === "TimeoutError" ? 504 : 502;
    // 504 on timeout, 502 on a refused connection
    res.status(status).json({ error: "upstream unavailable" });
  }
});
```

## In the wild
<!--meta block=wild-->

- **Kong** — Built on NGINX and OpenResty; routing, authentication, and rate limiting are Lua plugins applied per route or service, with configuration stored in a database or declared in a YAML file for DB-less mode. {#wild-kong}
- **AWS API Gateway** — A managed edge that maps representational state transfer (REST) or HTTP routes onto Lambda functions, HTTP endpoints, or other AWS services, and handles authorizers, request throttling via usage plans, and per-stage response caching. {#wild-aws-api-gateway}
- **Envoy** — The C++ proxy used as the data plane in Istio and Envoy Gateway; it terminates external TLS, routes on path, header, or authority, and load-balances across endpoints with health checking and outlier detection. {#wild-envoy-gateway}
- **Azure API Management** — A managed gateway whose policy pipeline is the configuration surface: authentication, rate limiting, caching and request transformation are declared per API rather than written into a service. {#wild-azure-api-management}
- **Ocelot** — A gateway as a library inside a .NET host, configured by route table — the shape teams reach for when the gateway should be deployed as one of their own services rather than as infrastructure. {#wild-ocelot}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Rate-limit thresholds** — Requests per window per client, key or route, and the burst allowed before the edge starts refusing.
- **Upstream timeout and retry** — How long the gateway waits on a backend and whether it retries — the dial that decides if one slow service can hold the caller.
- **Upstream connection pool** — Concurrent connections held to each backend, which bounds in-flight requests per upstream and keeps one of them from taking the whole tier.
- **Response cache time to live (TTL)** — How long a cacheable response is served from the edge before the backend is asked again.
- **Body size limits** — Caps on request and response payloads, so one large upload cannot exhaust gateway memory.
- **Config rollout unit** — How route and plugin configuration is delivered — all at once, per route, or progressively — which sets how much traffic a bad change can reach.

### Signals to watch
<!--meta polarity=signal-->

- **Gateway-added latency** — The p99 of the edge hop measured against backend service time — what the seam costs every request.
- **Rejection rate per route** — Requests refused at the edge by limit or policy, per route and client, which separates one abusive caller from a limit set too low.
- **Upstream error and timeout rate** — 5xx and timeouts per upstream, so a single failing backend is still identifiable behind the single surface.
- **Tier resource and connection count** — CPU, memory and open connections on the gateway fleet — the capacity that every route shares.
- **Traffic never reaching a service** — The share answered entirely at the edge by cache, rejection or failed auth — the load the gateway is genuinely removing.

### Failure modes under load
<!--meta polarity=failure-->

- **Whole surface down** — An undersized or unhealthy gateway tier makes every route behind it unreachable at once, however healthy the services are.
- **Head-of-line blocking** — One slow upstream ties up shared connections or worker threads and starves unrelated routes, unless each upstream has its own bound.
- **Auth dependency outage** — With identity checked per request against an external provider, that provider being unreachable fails every request at the edge.
- **Bad config rollout** — A broken route or plugin reaches live traffic in one step and stays broken until someone rolls it back.
- **Retry amplification at the edge** — The gateway retrying on behalf of a client that also retries multiplies load on a backend that is already failing.

### Readiness checklist
<!--meta polarity=check-->

- Losing one gateway instance under load was tried, and traffic kept flowing — the tier is proven horizontal, not drawn that way
- One backend held slow shows unrelated routes still serving, so head-of-line blocking is ruled out by test rather than by intent
- What the edge does when the identity provider is unreachable was chosen deliberately and someone outside the team agreed to it
- Route and plugin config is validated before it ships, rolled out progressively, and reversible without a full redeploy
- Every route records its owning team, so an error at the edge is attributable without reading the config
- Nothing on the gateway holds logic a second client would have to duplicate, reviewed each release because that drift only goes one way

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [API Design](../../../themes/api-design.md) — The single front door every client meets first, so identity and limits are applied once instead of per service. {#fluency-api-design}
- [Microservices Design](../../../themes/microservices-design.md) — One front door for clients, with no domain knowledge in it {#fluency-microservices-design}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Rate Limiter](../resilience/rate-limiter.md) — The gateway is where limits are usually enforced
- [Load Balancer](./load-balancer.md) — The gateway fronts, the balancer spreads
- [Authentication Enforcer](../../security/authentication-enforcer.md) — Authenticate once at the edge
- [Gatekeeper](./gatekeeper.md) — Validate and screen requests at entry
- [Strangler Fig](../coordination/strangler-fig.md) — Route slices old-vs-new at the gateway
- [Intercepting Validator](../../security/intercepting-validator.md) — Validate input at the edge
- [Micro-Frontends](../../frontend/micro-frontends.md) — An application programming interface (API) gateway can front the services behind independently deployed frontends
- [API Routing](./api-routing.md) — Pick how a request names its service — by path, hostname or header — before deciding what the gateway does with it
- [Service Mesh](./service-mesh.md) — A gateway covers edge traffic; a mesh adds service-to-service policy
- [Federated Identity](../coordination/federated-identity.md) — The gateway validates the provider's signed token so backends need not
- [Pagination](./pagination.md) — Clamping an oversized limit is a policy the gateway can apply without every service reimplementing it
- [Prefer Managed Services](../../../principles/managed-services.md) — The gateway is edge work there is rarely a reason to build
- [Microservices](../../architecture/microservices.md) — The gateway exists because services should not be exposed to clients directly.
- [Model Context Protocol](./mcp.md) — The same aggregation and policy job, applied to capability servers
- [Context Map](../../ddd/context-map.md) — A gateway can be the open host service a map shows at a context's edge
- [Front Controller](../../enterprise/front-controller.md) — An application programming interface (API) gateway is a front controller across services
- [Sticky Session](./sticky-session.md) — A streaming gateway needs connection affinity so a rebalance does not cut the flow
- [Service Discovery](./service-discovery.md) — Behind the gateway, discovery supplies the live instances it routes to
- [Agent2Agent](../coordination/a2a.md) — Fronts agent-to-agent calls as well as service calls.

**Generalizes**

- [Backend-for-Frontend](./bff.md) — One backend per frontend, atop the gateway idea

**Specializes**

- [Single Access Point](../../security/single-access-point.md) — The gateway is this principle applied to client traffic across services

**Often confused with**

- [Reverse Proxy](./reverse-proxy.md) — Route + cross-cutting concerns vs. plain proxying
- [Ambassador](./ambassador.md) — Client-side networking proxy vs. server-side entry point

**Prevents**

- [Host Header Rewriting](../../../hazards/host-header-rewriting.md) — A managed front door often overrides the origin host by default, so the setting has to be turned off deliberately

**Exposed to**

- [Busy Front End](../../../hazards/busy-front-end.md) — Can fall into busy front end when a gateway that transforms payloads itself spends the tier's cores on that work
- [Extraneous Fetching](../../../hazards/extraneous-fetching.md) — Can fall into extraneous fetching when fixed response shapes ship fields and rows the client never shows
- [N+1 Query](../../../hazards/n-plus-1-query.md) — Can fall into n plus 1 query when composing a response by calling a backend per item repeats the pattern across services

**Demonstrated by**

- [Distributed Rate Limiter](../../../designs/distributed-rate-limiter.md) — demonstrates the gateway applying cross-cutting request policy — identify, check, admit or reject — before traffic reaches services
- [Google News](../../../designs/google-news.md) — one edge entry point absorbing cross-cutting concerns ahead of the service tier is the application programming interface (API) gateway role
- [Yelp](../../../designs/yelp.md) — one entry point does routing across two services split by their read/write shape
- [Uber](../../../designs/uber.md) — centralizing auth, rate limiting and routing at one edge is the api-gateway's whole job
- [Dropbox](../../../designs/dropbox.md) — the gateway is the single front door that authenticates and shapes traffic before it reaches the control-plane service
- [Ticketmaster](../../../designs/ticketmaster.md) — the single entry point that authenticates and routes to backend services is the API-gateway role
- [Payment System](../../../designs/payment-system.md) — the payment system uses the gateway as its one hardened, signature-verifying entry point
- [CamelCamelCamel](../../../designs/camelcamelcamel.md) — the price tracker's one public entry point shows the gateway consolidating auth, throttling and routing across a fan of backend services
- [YouTube](../../../designs/youtube.md) — An upload surface concentrates auth and limits at the single gate
- [Facebook Post Search](../../../designs/fb-post-search.md) — The gateway keeps abuse control out of the search tier
- [Google Docs](../../../designs/google-docs.md) — The gateway fronts the plain request path while editing sockets take a different route to a document's owner
- [Instagram](../../../designs/instagram.md) — One entry point keeps auth and limits out of each backend service
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — The gateway is the one entry point for requests, while internal timers never pass through it
- [Tinder](../../../designs/tinder.md) — One entry point in front of three very different request shapes

**Implemented by**

- [Networking](../../../capabilities/networking.md) — Available as a managed product on every cloud.
- [Load balancers, proxies & gateways](../../../comparisons/load-balancers-and-gateways.md) — The gateway products that sell this pattern, compared on policy surface and license.

<!-- relationships:end -->
