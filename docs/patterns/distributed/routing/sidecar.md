---
title: Sidecar
description: Attaches a helper process alongside the main one
area: distributed-routing
owner: Oleksandr Derechei
tags: [modularity, separation-of-concerns, decoupling]
status: stable
aliases: [sidekick]
solves: [I need to add TLS to a service whose source I am not allowed to touch, every service links a different version of the logging library, our Rust service cannot use the internal telemetry SDK because it is Java-only, upgrading the metrics library means rebuilding and redeploying thirty services, I want logs shipped off the box without the app knowing which vendor we use]
---

# Sidecar

Deploys a helper process in lock-step beside the main application — same host, same network namespace, same fate — so cross-cutting concerns like proxying, logging, and config sync live outside the app's own code.

## What it is
<!--meta block=description-->

A sidecar is a second container deployed next to one application instance, sharing its host and network but running as its own unit, in any language. It carries cross-cutting work such as TLS termination, log shipping or secret rotation, so every service gets it without importing a library and without a release when it changes. It is never deployed or scaled apart from its partner.

## Explained
<!--meta block=explain-->

A sidecar is a second container that runs next to your application instance, sharing its host and network, and does a supporting job for it, such as shipping logs, renewing certificates or handling traffic, without any change to the application's code. Without it, the same job is a library, which means one implementation per language and a release of every service whenever the library changes. Choose it when the behaviour must attach to an application you cannot or should not modify, in whatever language it uses, so one artifact upgrades on its own schedule. Prefer a library when only one service needs the behaviour or the host has no spare room.

- **Per-instance bill.** Each application copy carries a second container whose memory and CPU multiply by fleet size, so give it a small fixed limit.
- **Start order.** The pair starts and stops in no fixed order, so make the application wait for the sidecar's readiness and drain on shutdown.
- **Shared fate.** A sick sidecar degrades a healthy application, so give it its own health check and restart policy.

**Example.** A fleet has 120 application instances, each with a 64 MB log-shipping sidecar, so the sidecars hold 7,680 MB, about 7.7 GB. Updating the shipper is one image rollout to 120 instances and touches no application, where a library would mean three services in three languages each shipping a release. If the application starts before the sidecar, its first seconds of logs go nowhere, so you make it write to a local file that the sidecar tails once it is ready.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a service get TLS, retries and log shipping without importing anything? A second container in the same pod owns both ends of its traffic and is reachable only over localhost."
flowchart LR
    Client["Client or peer service"]:::ext
    subgraph Pod["One pod — shared network namespace and lifecycle"]
        SC["Sidecar"]
        App["Main application"]
    end
    Peer["Upstream service"]:::ext
    Obs[("Log & metrics store")]:::ext
    Client -->|"1 inbound request"| SC
    SC -->|"2 terminate TLS, forward over localhost"| App
    App -->|"3 outbound call over localhost"| SC
    SC -->|"4 retry and route to the upstream"| Peer
    SC -->|"5 ship logs and metrics off-host"| Obs
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **[Ambassador](./ambassador.md)** — A sidecar specialized as an out-of-process client library — it handles retries, discovery, and TLS on behalf of the main container behind a plain local socket.
- **Mesh data-plane proxy** — An Envoy- or Linkerd-style proxy runs as a sidecar in every pod, forming the data plane of a [service mesh](./service-mesh.md) while a control plane configures them all centrally.
- **Logging or metrics sidecar** — Tails the app's log files or scrapes its metrics endpoint and ships them off-host, so the app never links a vendor's telemetry SDK.
- **Kubernetes native sidecar container** — Since Kubernetes 1.29, a container marked `restartPolicy: Always` starts before the main containers and stops after, formalizing what used to be an init-container workaround.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Adds cross-cutting behavior** without touching the main app's code or language.
- **Deploys, versions, and patches** independently from the app it serves.
- **Reusable across an entire polyglot fleet** — the app just needs a localhost socket.
- **Runs as its own process**, so its crash or resource spike doesn't directly take the app down.

### Cons
<!--meta polarity=con-->

- **Doubles the containers to deploy**, monitor, and patch on every single instance.
- **Adds latency** and CPU/memory overhead on every host it rides on.
- **Shared fate cuts both ways**: an unhealthy sidecar degrades the app it's attached to.
- **Coordinating startup order**, shutdown order, and health checks between the two is nontrivial.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need to add logging**, monitoring, proxying, or config sync across services written in different languages.
- **The main app can't or shouldn't change**, but you still need to intercept its traffic or environment.
- **You're already on an orchestrator**, like Kubernetes or Nomad, that reliably co-schedules containers.

### Avoid when
<!--meta polarity=avoid-->

- **An in-process library does the job** with far less operational overhead.
- **Only one service needs the behavior** — a whole sidecar for a single consumer rarely pays for itself.
- **The host is resource-constrained** and can't absorb another process per app instance.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal logging proxy sidecar"
import http from "node:http";

// The sidecar owns the public port; the app listens only on localhost.
const APP_PORT = 8080;
const SIDECAR_PORT = 9000;

const sidecar = http.createServer((req, res) => {
  const start = Date.now();

  const upstream = http.request(
    { host: "127.0.0.1", port: APP_PORT, path: req.url, method: req.method, headers: req.headers },
    (appRes) => {
      res.writeHead(appRes.statusCode ?? 502, appRes.headers);
      appRes.pipe(res);
      appRes.on("end", () => {
        // Logging and metrics live here, never inside the app's own code.
        console.log(`${req.method} ${req.url} ${appRes.statusCode} ${Date.now() - start}ms`);
      });
    },
  );

  req.pipe(upstream);
});

sidecar.listen(SIDECAR_PORT); // clients talk to the sidecar, not the app directly
```

## In the wild
<!--meta block=wild-->

- **Kubernetes** — A pod co-schedules its containers on one node sharing a network namespace and volumes; since 1.29 a native sidecar is an init container with restartPolicy: Always, guaranteeing it starts before and terminates after the main containers. {#wild-kubernetes}
- **Linkerd** — Injects its Rust linkerd2-proxy into every pod to transparently handle mTLS, retries, and per-request metrics; the injected proxies form the mesh data plane, configured centrally by the control plane. {#wild-linkerd}
- **Fluent Bit** — A lightweight C log forwarder that tails the app log files with its tail input plugin and ships them to a backend, so the app links no logging SDK; it is also commonly run as a node-level DaemonSet. {#wild-fluent-bit}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Sidecar resource requests and limits** — CPU and memory reserved for the sidecar container independently of the app, so neither can starve the other on the shared host.
- **Startup and shutdown ordering** — Whether the sidecar is guaranteed to be ready before the app starts and to terminate after it drains — a native sidecar container or equivalent lifecycle hooks.
- **Proxy concurrency and pool settings** — For a mesh data-plane proxy, the connection-pool sizes, timeouts, and retry budgets it applies to traffic on the app behalf.
- **Health and liveness probes** — The sidecar container gets its own probes so the orchestrator can restart it without waiting on the app, and vice versa.

### Signals to watch
<!--meta polarity=signal-->

- **Sidecar overhead per instance** — CPU and memory the sidecar consumes relative to the app; multiplied across the fleet it is the real cost of the pattern.
- **Added hop latency** — p99 added by routing through the sidecar over localhost rather than the app serving traffic directly.
- **Sidecar restart count** — Restarts or crash-loops on the sidecar container; because it shares fate with the app, its instability degrades the app it rides with.
- **Proxy pool saturation** — For a mesh proxy, connection-pool and queue occupancy — nearing the limit means the data plane is about to shed or delay requests.

### Failure modes under load
<!--meta polarity=failure-->

- **Startup race** — The app starts and serves before the sidecar proxy is ready, so early requests that depend on the sidecar fail until it comes up.
- **Shutdown order inversion** — The sidecar exits before the app finishes draining, dropping in-flight requests that still needed to route through it.
- **Shared-fate degradation** — A resource spike or crash in the sidecar degrades or takes down the co-located app, since they share host and lifecycle.
- **Fleet-wide overhead multiplication** — One extra process per app instance multiplies CPU and memory across every pod, an overhead that only shows up at fleet scale.

### Readiness checklist
<!--meta polarity=check-->

- The sidecar has its own resource requests and limits so it can neither starve the app nor be starved by it
- Startup and shutdown ordering is guaranteed — native sidecar containers or lifecycle hooks — not left to chance
- The sidecar has its own health probe and is monitored independently of the app
- Per-instance overhead is measured and multiplied across the fleet before rollout
- The app reaches the sidecar only over localhost or a shared namespace, never a routable address

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Cloud Native](../../../themes/cloud-native.md) — Cross-cutting concerns as a neighbouring process {#fluency-cloud-native}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Ambassador](./ambassador.md) — An ambassador is often deployed as a sidecar
- [Reverse Proxy](./reverse-proxy.md) — A mesh data-plane sidecar fronts its app's traffic as a local proxy
- [Design for Operations](../../../principles/design-for-operations.md) — The sidecar carries the operational concerns the service does not implement
- [Distributed Tracing](../resilience/distributed-tracing.md) — Telemetry export is a standard companion-process responsibility, alongside transport layer security (TLS) and secret rotation
- [Container Orchestration](../coordination/container-orchestration.md) — The orchestrator is what guarantees the helper starts, stops and moves with its service.
- [Service Discovery](./service-discovery.md) — One of the concerns a sidecar takes off the application, alongside retries and mutual transport layer security (TLS)

**Part of**

- [Service Mesh](./service-mesh.md) — Sidecars are the data plane of a mesh

**Implemented by**

- [Networking](../../../capabilities/networking.md) — A service mesh is the sidecar sold ready-made: an injected proxy beside each instance.

<!-- relationships:end -->
