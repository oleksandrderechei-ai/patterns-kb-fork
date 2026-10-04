---
title: Ambassador
description: A proxy that handles networking concerns for a service
area: distributed-routing
owner: Oleksandr Derechei
tags: [modularity, separation-of-concerns, decoupling]
status: stable
solves: ["we wrote the same retry and timeout logic in Go, Python, and Java and all three behave differently", rolling out mutual TLS means editing and redeploying forty services, our Python service is pinned to an ancient version of the internal client library, I need tracing on a legacy service whose source nobody wants to touch, every language handles connection pooling differently and no one knows which is right]
---

# Ambassador

Runs a small helper process next to a service that owns every networking concern — retries, Transport Layer Security (TLS), service discovery, circuit breaking, metrics — so the service's own code never has to touch the wire.

## What it is
<!--meta block=description-->

Every service that calls the network needs retries, timeouts and secure connections, and a client library per language drifts out of date. An ambassador is a small proxy that runs beside each copy of the service, on the same host. The service calls a local address and the proxy does the real talking, so one artifact carries the policy for every language.

## Explained
<!--meta block=explain-->

An ambassador is a small proxy that runs beside each copy of your service, on the same host, and handles its outbound network work, such as retries, timeouts, encrypted connections and finding the other service, so your code calls a local address and the proxy does the real talking. Each instance has its own copy, so there is no shared chokepoint. Choose it over client libraries when networking policy must change without redeploying application code and you run several languages: a switch to mutual TLS, where both sides prove who they are, becomes one artifact shipped everywhere. It is the idea a [sidecar](sidecar.md) deploys.

- **Less control.** The proxy decides when to retry and whom to trust, and changing that means rolling a new artifact past every instance.
- **Silent drift.** App and proxy versions can part ways, so report the proxy version with each deploy.
- **Two hops.** Each request crosses two processes, so pass one trace id through both.
- **One more process.** It must stay alive per instance, so tie its health check to the app's.

**Example.** Forty services in Go, Java and Python call a payment API with one policy: 3 retries, a 2 s timeout, mutual TLS. As libraries that is 3 codebases to change. To cut the timeout to 1 s, you ship one proxy configuration to 40 services with 5 copies each, 200 proxies, and touch no application code. The cost is 200 extra processes: at 50 MB each that is 10 GB of memory, plus a local hop on every call and two places to look when a request fails.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does the retry, TLS and discovery logic live? Beside the service, not inside it — the app makes a plain localhost call at step 1, and the proxy does every piece of network work from step 2 on."
flowchart LR
    subgraph Pod["One pod — app and proxy share a lifecycle"]
        App["Service"]
        Amb["Ambassador proxy"]
    end
    Disc[("Service registry")]:::ext
    Remote["Remote dependency"]:::ext
    Mon[("Metrics and traces")]
    App -->|"1 plain call to localhost"| Amb
    Amb -->|"2 resolve the real destination"| Disc
    Amb -->|"3 originate mTLS, apply retry and timeout policy"| Remote
    Remote -->|"4 response back over the same hop"| Amb
    Amb -->|"5 hand the response to the app"| App
    Amb -->|"6 emit per-call metrics and traces"| Mon
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **[Sidecar](./sidecar.md)** — The ambassador runs as a second container in the same pod, sharing the network namespace and lifecycle with the app — the standard cloud-native deployment, and the form most service meshes use.
- **Host-level ambassador** — One ambassador process per host, shared by every service instance running there — fewer processes to run, but less isolation between tenants.
- **Embedded library fallback** — Where a sidecar can't run — some serverless or legacy platforms — the same policy ships as an in-process library instead. Less polyglot-friendly, but works where a second process isn't an option.
- **Per-concern ambassadors** — Split responsibilities across several small ambassadors — one for mTLS, one for rate limiting — instead of one do-everything proxy, so each can be versioned and scaled independently.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Keeps retries**, TLS, discovery, and metrics out of application code entirely, written once regardless of language.
- **Lets a polyglot fleet share** identical networking behavior without a client library per language.
- **Upgraded, patched, or reconfigured** independently of the application it serves.
- **Centralizes network policy changes** — like a mutual TLS rollout — to one artifact deployed everywhere.

### Cons
<!--meta polarity=con-->

- **Adds an extra hop** and an extra process per service instance — small latency, but real resource overhead at scale.
- **One more moving part to deploy**, monitor, and keep alive alongside every instance of every service.
- **Ambassador and application** can drift out of version sync even though they're meant to ship together.
- **Debugging a request** means tracing through two processes instead of one.
- **The proxy cannot tell** a safe repeat from a duplicate write, so a blanket retry policy re-sends non-idempotent calls unless the caller can bound or disable it per request.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You run a polyglot fleet and duplicating retry**, TLS, and discovery logic per language client library is unsustainable.
- **You need consistent networking behavior** across many services without touching their source.
- **You want to evolve networking policy** — add mTLS, change discovery — without redeploying application code.

### Avoid when
<!--meta polarity=avoid-->

- **A single language or framework** covers all your services — a shared library is simpler than a process per instance.
- **The concern is a shared**, server-side entry point for all clients — that's the job of an [API Gateway](./api-gateway.md), not an ambassador.
- **You just need to reach** a remote system through a stand-in, with no extra policy layered on — a plain [Proxy](../../gof/structural/proxy.md) is enough.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal HTTP ambassador"
import http from "node:http";

// Listens on localhost; the app calls this instead of the network directly.
const REMOTE = "backend.internal:8443";
const MAX_ATTEMPTS = 3;

http.createServer(async (req, res) => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const upstream = await fetch(`https://${REMOTE}${req.url}`, {
        method: req.method,
        headers: { ...req.headers, host: REMOTE },
        // TLS origination happens here — the app spoke plain HTTP.
      });
      res.writeHead(upstream.status);
      res.end(await upstream.text());
      return; // success, stop retrying
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        res.writeHead(502);
        res.end("ambassador: upstream unreachable");
        return;
      }
      await new Promise(r => setTimeout(r, 100 * attempt)); // backoff
    }
  }
}).listen(9000, "127.0.0.1"); // app calls localhost:9000
```

## In the wild
<!--meta block=wild-->

- **Istio** — Its injector adds an Envoy proxy to every pod and redirects the pod's inbound and outbound traffic to it via iptables; Envoy originates mutual TLS to peer sidecars, applies retry, timeout, and outlier-detection policy pushed from the istiod control plane, and reports per-call telemetry. {#wild-istio-envoy}
- **Dapr** — Runs as a sidecar the app calls over localhost HTTP or gRPC; it resolves service names, retries with configurable resiliency policies, encrypts sidecar-to-sidecar traffic with mTLS, and exposes the same building-block APIs from any language, so nothing is linked into the app. {#wild-dapr}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Retry policy** — How many times the sidecar retries a failed upstream call and the per-attempt timeout before it gives up. Unbounded retries turn one slow dependency into a retry storm.
- **Circuit-breaker limits** — Caps on concurrent connections, pending requests, and active requests to an upstream, above which the sidecar sheds load instead of queueing it.
- **Connection pool and keep-alive** — Upstream pool size and idle timeout, so the sidecar reuses connections instead of paying TLS setup on every call.
- **Sidecar resource requests and limits** — CPU and memory reserved for the proxy container. Too little and it gets CPU-throttled, adding latency to every request it fronts.

### Signals to watch
<!--meta polarity=signal-->

- **Added per-hop latency** — The gap between the app's view of a call and the upstream's actual service time — the tax the extra process adds.
- **Upstream retry and error rate** — Connection errors and retries the sidecar sees toward the remote dependency.
- **Circuit-breaker overflow count** — Requests rejected because a connection or pending-request limit was hit.
- **Sidecar CPU and memory usage** — Proxy resource use relative to its limit; approaching the limit means throttling and latency.

### Failure modes under load
<!--meta polarity=failure-->

- **Sidecar saturation** — The proxy runs out of CPU or connection-pool slots and becomes the bottleneck for the app it is meant to protect.
- **Startup and shutdown ordering** — The app begins serving before the sidecar is ready, or the sidecar exits first on shutdown, so early or in-flight requests fail.
- **Config or version drift** — A control-plane push fails or the sidecar image lags the app, so routing and TLS policy silently diverge from intent.
- **Retry amplification** — An aggressive retry policy multiplies load on an already-struggling upstream.

### Readiness checklist
<!--meta polarity=check-->

- The app calls the local sidecar address, not the remote dependency directly.
- Sidecar CPU and memory sized so it is not throttled at peak load.
- Startup and shutdown ordering handled — sidecar ready before app traffic, drains after the app stops.
- Retry, timeout, and circuit-breaker limits set to bounded values.
- Sidecar metrics and traces exported with dashboards in place.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Microservices Design](../../../themes/microservices-design.md) — Move the network concerns into a proxy beside the service {#fluency-microservices-design}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Sidecar](./sidecar.md) — An ambassador is often deployed as a sidecar
- [Service Discovery](./service-discovery.md) — Discovery is a standard job to move out of the application and into the proxy

**Specializes**

- [Proxy](../../gof/structural/proxy.md) — Ambassador is a network proxy deployed beside a service

**Often confused with**

- [API Gateway](./api-gateway.md) — Client-side networking proxy vs. server-side entry point

**Implemented by**

- [Networking](../../../capabilities/networking.md) — A mesh proxy is the ambassador sold ready-made, though it sits beside every service rather than one client.

<!-- relationships:end -->
