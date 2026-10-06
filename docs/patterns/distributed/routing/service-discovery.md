---
title: Service Discovery
description: Resolve a logical service name to an instance that is alive right now
area: distributed-routing
owner: Oleksandr Derechei
tags: [routing, availability]
status: stable
aliases: [service registry, client-side discovery, server-side discovery]
solves: [my service holds a hard-coded host and port that keeps going stale after deploys, new instances come up but nothing sends traffic to them until I redeploy the callers, requests keep going to an instance that was terminated ten minutes ago, I have no single answer to which instances are actually running right now, every scale-out event means editing a config file full of addresses]
---

# Service Discovery

Keeps a registry of which service instances are currently running and where, so a caller asks for a service by name and gets an address that works — instead of holding a host and port that was true when the config was written.

## What it is
<!--meta block=description-->

Service discovery replaces a configured address with a question asked at call time. A registry holds the current instances of each service, instances add themselves as they start and drop out as they stop, and a caller names a service and gets somewhere to send the request. It resolves instances that move and multiply. The lookup runs either in the caller, which then also balances load, or in a router.

## Explained
<!--meta block=explain-->

Service discovery replaces a configured address with a question asked at call time: instances register themselves in a registry when they start and drop out when they stop, and a caller asks for a service by name and gets somewhere to send the request. It exists because instances no longer stay put: a scheduler places them where there is room, scaling doubles them and a rolling deploy can replace all of them in minutes, so any fixed host and port is a snapshot of a fleet that has already changed. Run an explicit registry only when your platform does not already turn a virtual address into healthy instances; two registries give two answers to one question.

- **Registry on every path.** Callers should cache the last good list and keep serving from it during a registry outage.
- **Stale views.** Caching makes each list slightly stale, so try another instance when a connection is refused.
- **Lease length.** Short evicts healthy instances during a pause and long routes to dead ones, so separate alive from ready.

**Example.** A service has 5 instances, a 30 s lease and 50 calls a second. Instance 3 crashes, and callers keep it in their list until the lease runs out and their cache refreshes. One call in five hits it, 10 failures a second, at most about 300 over the 30 s lease. If callers retry another instance when a connection is refused, those calls succeed on the second try, so these are extra attempts, not failed requests. Shortening the lease to 10 s would cut the failures to 100, but a 12 s garbage-collection pause on a healthy instance would then evict it, which is why lease length alone does not fix it.

## How it works
<!--meta block=structure-->

```mermaid caption="What happens when instance A dies without saying so? Step 2 is the only answer — no heartbeat, so the registry evicts it and the list at step 4 no longer contains it. How fast a dead instance stops receiving traffic is a property of that loop alone."
flowchart LR
    subgraph Fleet["Instances — addresses assigned at start"]
        I1["Orders instance A"]
        I2["Orders instance B"]
    end
    REG[("Instance registry")]
    CL["Caller"]
    I1 -->|"1 register, then heartbeat"| REG
    I2 -->|"1 register, then heartbeat"| REG
    REG -->|"2 health check, evict on silence"| I1
    CL -->|"3 resolve 'orders'"| REG
    REG -->|"4 live instance list"| CL
    CL -->|"5 request to a chosen instance"| I2
```

```mermaid caption="The failure branch the happy path hides: between B terminating and the cache refreshing, the caller still holds B's address. Discovery narrows that window but never closes it, which is why the caller needs its own retry-and-eject behaviour rather than trusting the list."
sequenceDiagram
    participant C as Caller
    participant R as Registry
    participant B as Instance B
    C->>R: resolve "orders"
    R-->>C: [A, B] (cached with TTL)
    C->>B: request
    B-->>C: 200
    Note over B: B is terminated by the scheduler
    C->>B: request (from cache, B is gone)
    B--x C: connection refused
    C->>C: drop B, try next from cache
    C->>R: refresh (TTL expired)
    R-->>C: [A, C]
```

## Variations
<!--meta block=variations-->

- **Caller-side lookup** — The caller queries the registry, caches the list and picks an instance itself — so it also owns the [load-balancing](./load-balancer.md) policy. Fewest hops, at the cost of discovery code in every language you use.
- **Router-side lookup** — The caller sends to one fixed address; a [reverse proxy](./reverse-proxy.md) or [gateway](./api-gateway.md) does the resolution and forwards. Callers hold no discovery logic at all, which is what makes polyglot fleets practical. The router must then speak the protocol, and must itself be replicated and kept available.
- **Self-registration** — The instance registers and heartbeats itself. No extra moving part, and the instance knows things about its own readiness the platform cannot see — but every service now carries registry client code and its failure modes.
- **Third-party registration** — A platform component watches instance lifecycle and maintains the registry, so services stay unaware they are being discovered. This is what a container platform does for you, and why most teams never write registration code.
- **Name-service projection** — Project the registry into a naming service the caller already speaks, so a plain hostname resolves to live instances and nothing in the caller changes. Simplest possible client, at the price of the naming layer's own caching — which is frequently more aggressive than the eviction loop it is meant to reflect.
- **Sidecar-resolved lookup** — A [sidecar](./sidecar.md) proxy alongside each instance does the resolution, giving router-side simplicity in the caller with caller-side hop counts. The shape a [service mesh](./service-mesh.md) generalizes across the whole fleet.
- **Push-based updates** — The registry streams changes to callers instead of callers polling. The stale window shrinks to propagation delay, at the cost of a long-lived connection per caller and a resync path after a drop.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Instances can be replaced**, moved or multiplied without a config change or a redeploy anywhere else.
- **Scaling out is a registration**, so new capacity starts receiving traffic without anyone being told about it.
- **A failed instance is removed** from rotation by the same loop that added it, so eviction needs no separate mechanism, provided the lease and readiness signal are tuned.
- **The registry becomes a single** accurate inventory of what is actually running, which is useful well beyond routing.

### Cons
<!--meta polarity=con-->

- **The registry is a dependency** of every call path, so its availability bounds the availability of everything that resolves through it.
- **Caller-side lookup** means reimplementing discovery per language and framework, and every client is coupled to the registry's API.
- **Router-side lookup** adds a hop and a component to replicate, configure and keep available.
- **Health-check timing is wrong in both directions**: eager eviction removes healthy instances during a pause, lax eviction keeps routing to dead ones.
- **Cached instance lists** mean callers act on a view of the fleet that is always slightly out of date, and no setting removes that window.
- **Callers that refresh** on the same interval, or start cold together after an outage, hit the registry in bursts unless refreshes are jittered.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Instance addresses** are assigned at start rather than configured, so nothing can be written down in advance.
- **Instance count changes with load**, and callers must use new capacity without being redeployed.
- **You need one authoritative answer** to "what is running right now", for routing and for everything else that asks.

### Avoid when
<!--meta polarity=avoid-->

- **Your platform already resolves** a stable virtual address to healthy instances — it is doing this, and a second registry is a second truth.
- **The fleet is a small** fixed set of long-lived hosts, where a configured address list and a health check are simpler and have fewer failure modes.
- **Callers are outside your control** — a published, stable endpoint is the contract, and discovery belongs behind it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a registry with lease-based eviction, and a caller that caches"
type Instance = { id: string; url: string; expiresAt: number };
// the registry: registration is a lease, and a heartbeat renews it
class Registry {
  private byService = new Map<string, Map<string, Instance>>();
  // Unrenewed means expired: crash-safe, no "deregister" call to survive long enough to make.
  heartbeat(service: string, id: string, url: string, leaseMs = 10_000): void {
    const m = this.byService.get(service) ?? new Map();
    this.byService.set(service, m.set(id, { id, url, expiresAt: Date.now() + leaseMs }));
  }
  resolve(service: string): Instance[] {
    const m = this.byService.get(service) ?? new Map();
    for (const [id, i] of m) if (i.expiresAt <= Date.now()) m.delete(id);
    return [...m.values()];
  }
}
// the caller: cache the list, eject an instance the moment it refuses
class Client {
  private cache: Instance[] = []; private refreshAt = 0;
  constructor(private registry: Registry, private service: string) {}
  async call(path: string): Promise<Response> {
    if (this.cache.length === 0 || Date.now() >= this.refreshAt) { // cache for 5s; re-resolve when empty
      try { [this.cache, this.refreshAt] = [this.registry.resolve(this.service), Date.now() + 5_000]; }
      catch { /* registry down: keep serving the last good list */ }
    }
    for (const i of [...this.cache]) {  // stale cache: a refusal is expected, not exceptional
      try { return await fetch(i.url + path, { signal: AbortSignal.timeout(2_000) }); } // a hang counts as a refusal
      catch { this.cache = this.cache.filter((c) => c.id !== i.id); }
    }
    throw new Error(`no reachable instance of ${this.service}`);
  }
}
```

## In the wild
<!--meta block=wild-->

- **Consul** — Service registry with health checking, where registered services are resolvable both through an HTTP API and as ordinary DNS names — the name-service projection and the explicit-registry variants in one product. {#wild-consul}
- **Kubernetes Services and EndpointSlices** — Third-party registration taken to its conclusion: the platform watches pod lifecycle and readiness, maintains the endpoint set itself, and resolves a stable in-cluster name to it, so application code contains no registration or lookup logic at all. {#wild-kubernetes-services}
- **Netflix Eureka** — The caller-side variant in its best-known form: instances self-register and heartbeat, clients fetch and cache the full registry, and instance selection happens in the client. {#wild-eureka}
- **Apache ZooKeeper** — Used for discovery through ephemeral nodes tied to the registering session, so the session timeout plays the lease: the instance leaves the registry when its session expires, not the instant its connection drops. {#wild-zookeeper}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Lease or heartbeat interval** — How often an instance must confirm it is alive. Sets the floor on how long a dead instance stays in the registry, and the load the registry carries.
- **Client cache refresh interval** — How long a caller reuses a resolved list. Longer survives registry outages better and keeps stale addresses longer.
- **Health-check type and thresholds** — Whether the registry polls an endpoint or waits for a heartbeat, plus how many consecutive failures evict. Separating liveness from readiness lives here.
- **Instance-selection policy** — How a caller or router picks from the list — round robin, least outstanding requests, zone-preferring. Only meaningful in the caller-side variant.

### Signals to watch
<!--meta polarity=signal-->

- **Registry resolution latency and error rate** — How long a lookup takes and how often it fails. On the critical path of every first call, so it is the registry metric that reaches users.
- **Registered instance count per service** — How many instances the registry believes are live, against how many were actually deployed. A persistent gap is registration or eviction going wrong.
- **Connection failures to resolved addresses** — How often a caller reaches an address the registry gave it and finds nothing. The direct measure of how stale the fleet view is.
- **Time from instance stop to eviction** — The observed gap between an instance terminating and leaving every caller list, which is the lease interval plus the cache interval, not either alone.

### Failure modes under load
<!--meta polarity=failure-->

- **Traffic to terminated instances** — Callers hold cached addresses for instances the scheduler already removed, so a share of requests fails during every deploy or scale-in.
- **Registry outage stops new lookups** — Callers with a warm cache keep working; anything starting cold cannot resolve at all, so an outage looks fine until something restarts.
- **Mass eviction on a registry hiccup** — A registry that loses heartbeats briefly evicts healthy instances together, and callers see the fleet empty out at once — the reason registries hold instances during suspected self-failure.
- **Heartbeat storm at scale** — Renewal traffic grows with instance count and shrinking lease intervals, so the registry saturates on bookkeeping just as the fleet grows.

### Readiness checklist
<!--meta polarity=check-->

- Callers cache the last good instance list and keep serving from it when the registry is unreachable.
- A caller treats a refused connection as ordinary: it drops that instance and tries the next rather than failing the request.
- Liveness and readiness are separate, so a briefly paused instance becomes unready rather than being evicted.
- Instance stop is graceful: it goes unready and drains before terminating, rather than relying on eviction to notice.
- The registry is replicated across failure domains, since it sits on every call path.
- The observed stop-to-eviction time is measured end to end, not assumed from the lease interval.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Microservices Design](../../../themes/microservices-design.md) — Resolve a service name to an instance that is alive right now. {#fluency-microservices-design}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Load Balancer](./load-balancer.md) — Caller-side lookup makes the caller the load balancer, so the two decisions merge
- [Circuit Breaker](../resilience/circuit-breaker.md) — A resolved instance can still be failing — the list says registered, not healthy
- [Sidecar](./sidecar.md) — A sidecar proxy resolves on the instance's behalf: router simplicity at caller hop counts
- [Ambassador](./ambassador.md) — The ambassador is where an out-of-process client puts its discovery logic
- [Agent2Agent](../coordination/a2a.md) — The agent card is this pattern's record, published by the service rather than a registry
- [Reverse Proxy](./reverse-proxy.md) — A reverse proxy is the router that does the lookup for callers, so they hold a fixed address
- [API Gateway](./api-gateway.md) — A gateway resolves the service name to a live instance for callers outside the fleet

**Requires**

- [Health Endpoint Monitoring](../resilience/health-endpoint.md) — Eviction needs a readiness signal to act on, or the registry cannot tell alive from answering

**Part of**

- [Service Mesh](./service-mesh.md) — A mesh generalizes per-instance resolution across the whole fleet, plus policy and telemetry

**Implemented by**

- [Networking](../../../capabilities/networking.md) — Managed registries hold service names and healthy addresses, so you do not run the registry yourself.

<!-- relationships:end -->
