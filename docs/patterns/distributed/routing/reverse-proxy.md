---
title: Reverse Proxy
description: "Fronts hidden backends, forwarding and terminating client connections for them"
area: distributed-routing
owner: Oleksandr Derechei
tags: [routing, decoupling, edge]
status: stable
solves: [our app servers are exposed straight to the internet with no guarded entry point, I need to add HTTPS in front of several backend services without changing TLS in each one, I want one domain to serve several apps and forward each URL path to a different backend, clients need to reach services that sit on a private network they can't address directly, "every backend re-implements TLS, gzip and caching and I want that handled once at the front"]
---

# Reverse Proxy

Sits in front of one or more backend servers and receives every client request on their behalf, forwarding it inward and relaying the response back out — so clients only ever talk to the proxy, and the servers behind it stay hidden and free of cross-cutting concerns like Transport Layer Security (TLS), caching, and compression.

## What it is
<!--meta block=description-->

A reverse proxy sits in front of backends, forwards each client request to a suitable backend and returns the response as if it had produced it. The real servers stay off public addresses if network rules block direct access. It factors shared edge work, such as TLS termination and caching, out of every backend into one intermediary. Unlike a forward proxy, it acts for servers. It is also a single point of failure, so run it redundant.

## Explained
<!--meta block=explain-->

A reverse proxy is a server in front of your backends that receives every client request, forwards it to a suitable backend and returns the answer as if it had produced it, so the real servers are never addressed directly. Without it, clients learn which host and port holds each service, and every backend repeats the same edge work: encrypted connections, compression, caching and access control. Choose it over direct access when backends must not be publicly reachable, or when that edge work would otherwise be rebuilt inside every service: the internal layout can change freely while all inbound traffic passes one place you can watch and limit.

- **Extra hop.** Each request pays a hop plus parsing and TLS handshake CPU, so keep connections to backends open and reuse them.
- **Single point of failure.** Everything behind it vanishes if it dies, so run two or more behind a shared address.
- **Exposed secrets.** Ending TLS there puts plaintext and private keys on an exposed host, so restrict its rights and key access and use short-lived certificates.

**Example.** Six backends sit on private addresses and only the proxy has a public one. Of 1,000 requests a second, 60% are static files that the proxy serves from its cache, so the backends see 400. Each request pays about 1 ms for the extra hop. If a single proxy died, all six backends would vanish from the clients' view at once, so you run two behind one shared address, each sized for the full 1,000 requests a second, and one failing costs no traffic.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a client reach servers it cannot address? The proxy terminates the TLS connection at step 1 and re-issues the request inside the private network at step 3, so backends can move or multiply behind it without a client noticing."
flowchart LR
    Client["Client"]:::ext
    RP["Reverse proxy"]
    Cache[("Response cache")]
    subgraph Private["Private network — no client can address these"]
        A["Backend A"]
        B["Backend B"]
    end
    Client -->|"1 HTTPS request"| RP
    RP -->|"2 look for a cached copy"| Cache
    RP -->|"3 forward as plain HTTP"| A
    A -->|"4 response"| RP
    RP -->|"5 answer in its own name"| Client
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **TLS termination / offloading** — The proxy performs the HTTPS handshake and speaks plain HTTP to backends, so certificates and cipher configuration live in one place instead of on every server.
- **Caching reverse proxy** — Caches backend responses and serves repeat requests itself, shielding backends from load — the same edge role a [content delivery network (CDN)](./cdn.md) plays at global scale.
- **Proxy as [load balancer](./load-balancer.md)** — When it fronts several interchangeable instances and spreads requests across them, it is also a [Load Balancer](./load-balancer.md).
- **Contrast: forward proxy** — A forward proxy fronts clients reaching outward and hides who they are; a reverse proxy fronts servers being reached and hides where they are.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Hides backend topology** — servers can move, scale or be replaced without clients seeing their addresses, provided redirects and Host headers are rewritten at the proxy.
- **Factors cross-cutting concerns** — TLS termination, caching, compression, access control — into one place, configured once rather than per backend.
- **Forms a security boundary**: backends sit on a private network, reachable only through the proxy's controlled surface.
- **Gives one point** to observe and govern all inbound traffic — logging, request limits, and rate limits apply uniformly.

### Cons
<!--meta polarity=con-->

- **Adds a network hop**, and at Layer 7 the request parsing and TLS work that cost latency and CPU.
- **Becomes a single point** of failure and a single choke point unless it is made redundant in turn; the shared address needs its own failover and both proxies need identical config.
- **Is another stateful component to configure**, secure, and keep patched — at the most exposed point in the system.
- **Terminating TLS means decrypting traffic at the edge**: the plaintext and the private keys now live on the proxy.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You want clients to reach** backend servers through one stable, public entry point instead of addressing each directly.
- **Backends sit** on a private network and must not be exposed to the internet directly.
- **You want TLS termination**, caching, or compression handled once at the edge rather than re-implemented in every service.

### Avoid when
<!--meta polarity=avoid-->

- **There is a single backend** a client can safely reach directly and none of the edge concerns apply — the proxy is pure overhead.
- **You need routing**, authentication, rate limiting, and response aggregation across many services — that is an [API Gateway](./api-gateway.md)'s remit, built on top of the proxy role.
- **The extra hop's latency** is unacceptable and nothing about terminating or fronting the connection earns it back.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — forward each request to a hidden backend and stream the response back"
import http from "node:http";

// Accept a client request, forward it to a backend from a hidden pool,
// and stream the response back out.
const backends = ["http://10.0.0.1:8080", "http://10.0.0.2:8080"];
let next = 0;

const proxy = http.createServer((clientReq, clientRes) => {
  const target = new URL(clientReq.url ?? "/", backends[next]);
  next = (next + 1) % backends.length; // round-robin over the pool

  const upstream = http.request(
    target,
    { method: clientReq.method, headers: { ...clientReq.headers, host: target.host } },
    (upstreamRes) => {
      // Relay the backend's status and headers, then pipe its body through.
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    },
  );

  upstream.on("error", () => {
    clientRes.writeHead(502); // backend unreachable — the client only ever sees us
    clientRes.end("Bad Gateway");
  });

  clientReq.pipe(upstream); // forward the client's request body to the backend
});

proxy.listen(8080); // plain HTTP for brevity; production terminates TLS with https.createServer, sets an upstream timeout and adds x-forwarded-for
```

## In the wild
<!--meta block=wild-->

- **NGINX** — The proxy_pass directive forwards requests to an upstream backend; NGINX terminates TLS, can cache responses with proxy_cache, and rewrites headers so the backend never faces the client directly. {#wild-nginx}
- **Caddy** — Its reverse_proxy directive proxies to backends and, as its headline feature, provisions and renews TLS certificates automatically over ACME — so the front door is HTTPS by default with no manual certificate handling. {#wild-caddy}
- **Traefik** — An edge router that discovers backends dynamically from Docker, Kubernetes and other providers, wiring up routes and TLS as containers come and go instead of requiring a static config reload. {#wild-traefik}
- **YARP** — A reverse proxy shipped as a library rather than a server: routing, load balancing and header transforms are configured in the host application, so the proxy is deployed and versioned with the service that owns it. {#wild-yarp}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Upstream timeouts** — Connect, read and send deadlines for the backend connection (proxy_connect_timeout, proxy_read_timeout); they bound how long a slow backend can tie up a proxy worker. Set read just above the backend's slowest normal response, found in the upstream latency logs; keep connect short.
- **Upstream keepalive pool** — How many idle connections to each backend are kept open and reused, so most requests skip a fresh TCP and TLS handshake to the backend.
- **Response buffering** — Whether the proxy buffers the full backend response before relaying it (proxy_buffering) and the buffer sizes; buffering frees the backend sooner but spends proxy memory and disables streaming.
- **Response cache** — Time to live (TTL), total cache size, and the cache key for cacheable responses; a hit is served by the proxy without ever touching the backend.
- **Request size limits** — Maximum request body and header buffer sizes (client_max_body_size); they cap how much memory one request can force the proxy to hold and reject oversized uploads early.

### Signals to watch
<!--meta polarity=signal-->

- **Upstream response time vs. total time** — The backend's own latency separated from the total the client sees; a widening gap points at proxy-side buffering, TLS, or queuing rather than the backend.
- **Gateway error rate** — 502 Bad Gateway (backend unreachable) and 504 Gateway Timeout (backend too slow) returned by the proxy: upstreams are failing or saturated.
- **Active connections and worker saturation** — Concurrent client and upstream connections against the configured limits; approaching them means new clients start queuing or being refused.
- **Cache hit ratio** — Share of responses served from the proxy's cache versus forwarded to a backend, when caching is on — it quantifies the load actually shielded from backends.

### Failure modes under load
<!--meta polarity=failure-->

- **Upstream saturation** — The proxy accepts more concurrent requests than backends can serve; connections queue, read timeouts fire and clients get 504s. Cap in-flight requests per backend and shed early with 503.
- **TLS handshake CPU spikes** — A surge of new HTTPS connections makes termination CPU-bound, and in-flight requests slow because handshakes crowd out useful work.
- **Buffering memory pressure** — Large responses or many slow clients held in proxy buffers exhaust memory or spill to disk, and the proxy slows for everyone.
- **File-descriptor exhaustion** — Under high concurrency the proxy runs out of open sockets or ephemeral ports for upstream connections and can accept no new work. Raise the file-descriptor limit above client plus upstream connections and reuse upstream connections through keepalive.

### Readiness checklist
<!--meta polarity=check-->

- The proxy is redundant — multiple instances behind DNS or an L4 balancer — so it is not itself a single point of failure
- Upstream connect and read timeouts are set so a slow or hung backend cannot pin proxy workers indefinitely
- TLS is configured with current ciphers and certificates auto-renew before expiry, since the whole front door depends on them
- Request body and header size limits are set to bound per-request memory and reject abusive payloads early
- Access and error logs or metrics export upstream status codes and latency so gateway errors are visible, not silent

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Global Traffic & Ingress](../../../themes/global-traffic-and-ingress.md) — Terminate connections and enforce entry inside the region {#fluency-global-traffic-and-ingress}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [API Routing](./api-routing.md) — Routing schemes are the rules a proxy matches on: path prefix, host, or header
- [Load Balancer](./load-balancer.md) — Fronting interchangeable instances, the proxy is also spreading the load
- [CDN](./cdn.md) — A content delivery network (CDN) edge plays this same caching-proxy role at global scale
- [Sidecar](./sidecar.md) — Deployed per-instance as a sidecar, the proxy runs over localhost

**Enables**

- [Strangler Fig](../coordination/strangler-fig.md) — A reverse proxy is the seam a strangler fig uses to move routes one at a time

**Often confused with**

- [API Gateway](./api-gateway.md) — A reverse proxy forwards and terminates connections; an application programming interface (API) gateway adds routing, auth, rate limiting and aggregation on top of that role.

**Prevents**

- [Host Header Rewriting](../../../hazards/host-header-rewriting.md) — Preserving the original host is a proxy setting, and it is the whole fix

**Implemented by**

- [Networking](../../../capabilities/networking.md) — Managed load balancers are reverse proxies with the operations removed.
- [Load balancers, proxies & gateways](../../../comparisons/load-balancers-and-gateways.md) — Which proxy to actually deploy, and who operates it.

<!-- relationships:end -->
