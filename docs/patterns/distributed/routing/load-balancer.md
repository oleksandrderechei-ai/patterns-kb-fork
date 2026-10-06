---
title: Load Balancer
description: Spreads requests across many identical instances
area: distributed-scale
owner: Oleksandr Derechei
tags: [routing, availability, load-balancing]
status: stable
aliases: [LB]
solves: [one server is maxed out and there is no bigger machine to buy, every deploy means downtime because a single box serves all the traffic, when a machine dies users get errors until somebody notices and reboots it, clients hardcode server addresses and break whenever we replace a machine, one instance is pegged at 100% CPU while the others sit idle]
---

# Load Balancer

Sits in front of a fleet of interchangeable instances and spreads every incoming request across them, steering around any instance that health checks mark as down, so no single machine carries all the traffic and the fleet can grow or shrink without a caller ever noticing.

## What it is
<!--meta block=description-->

A load balancer presents one stable address in front of a pool of identical backend instances and decides, per request or connection, which one handles it. It tracks which instances exist, polls their health and applies a routing algorithm across the survivors. It lifts the per-machine capacity ceiling and removes one instance as a single point of failure, though the balancer itself must be made redundant.

## Explained
<!--meta block=explain-->

A load balancer is one stable address that spreads requests across a group of identical copies of your service and skips the ones that are down. Callers talk to the balancer, never to a copy, so you can add copies, restart them and deploy without callers noticing, provided health checks drop dead copies quickly and draining lets in-flight requests finish. Without it, one machine caps your capacity and its crash ends the service, and clients picking copies themselves would each need a current list and would hit dead copies. The balancer keeps the list, polls a health check on each copy, and picks among the healthy ones by a rule such as round-robin (take turns) or least connections. Choose it over buying a bigger machine once one box cannot hold the load or must not be your single point of failure. Layer 4 forwards connections without reading them; Layer 7 reads the request to route by path, header or cookie, at more cost per request.

- **Single point of failure.** The balancer can fail too, so run two behind a shared address.
- **Blind turns.** Taking turns ignores real load, so use least connections when requests differ in cost.
- **Sticky sessions.** Pinning a user to one copy unbalances load, so keep session data outside the copies.

**Example.** Three copies each handle 100 requests a second, and traffic is 240 a second, so each gets 80. One copy crashes. The balancer checks every 5 s and drops a copy after 2 misses, so for about 10 s a third of traffic, 80 a second, goes to a dead copy and about 800 requests fail. Then the two survivors get 120 each, over their 100, so the site slows anyway. With 4 copies, each takes 60, and after a loss the other three take 80. The cost is the extra copy kept spare, plus the 10 s detection gap.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a caller reach a fleet whose members come and go? The balancer holds the only current list of who is alive (1, 3), so the client learns one address and an instance that stops answering is simply skipped instead of seen."
flowchart LR
    C["Client"]:::ext
    LB["Load balancer"]
    Pool[("Pool membership and health")]
    subgraph Fleet["One pool of interchangeable instances"]
        A["Instance A"]
        B["Instance B"]
        D["Instance C"]
    end
    A -->|"1 health probe answers, stays in rotation"| Pool
    C -->|"2 request to the one stable address"| LB
    Pool -->|"3 who is healthy right now"| LB
    LB -->|"4 forward to instance B"| B
    B -->|"5 response"| LB
    LB -->|"6 answer the client"| C
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Layer 4 vs. Layer 7** — L4 balances raw TCP/UDP connections by IP and port; L7 reads the HTTP request itself, so it can route on path, header, or cookie, not just on load.
- **Round-robin / weighted round-robin** — Cycle through instances in order, optionally weighting by declared capacity so a bigger instance is handed a proportionally bigger share.
- **Least connections / least response time** — Send the next request to whichever instance currently holds the fewest open connections or answers fastest — adapts better than round-robin when request costs vary.
- **Balancing at name resolution** — Some of the spreading happens in DNS, before any balancer is reached: return several addresses for one hostname, or answer each resolver with the address of the nearest healthy site. It needs no middlebox, and it is how traffic is divided between regions in the first place, since no single device can sit in front of all of them. It is also the bluntest instrument available — resolvers and clients cache answers and disregard the TTL (time to live) you set, so a site withdrawn from rotation keeps receiving traffic for minutes and the shares are approximate. Use it as the layer above real balancers, not instead of one.
- **[Consistent Hashing](./consistent-hashing.md)** — Hash a request key — client IP, session id — so the same client lands on the same instance, trading perfectly even distribution for stickiness without central session state.
- **[Sticky Session](./sticky-session.md)** — Pin a client's whole session to one instance, typically via a cookie the balancer sets, so in-memory session state doesn't need to be shared or externalized.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Turns many small instances into one logical service** — capacity scales by adding instances, not by upsizing one box.
- **Removes a single instance** as a single point of failure; once health checks mark it down (interval times miss count) it is skipped, but requests sent in that gap fail.
- **Centralizes health checking** and instance discovery so callers never track the current pool themselves.
- **Enables near-zero-downtime deploys** — with draining and readiness checks, roll instances out of and back into rotation one at a time.

### Cons
<!--meta polarity=con-->

- **Single point of failure** — the balancer itself becomes one unless it's made redundant in turn.
- **Naive algorithms ignore real load** — round-robin can overload a slow instance as readily as a fast one.
- **Sticky sessions reintroduce affinity to one instance**, undoing some of the flexibility scaling was meant to buy.
- **Adds a network hop**, and at Layer 7 a place where Transport Layer Security (TLS) termination and request parsing add latency and bugs.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You run more than one interchangeable instance** of a service and need one stable entry point to it.
- **You need to scale horizontally** past what a single instance can serve.
- **Instances can fail**, redeploy, or be added and removed, and callers should not have to track or retry against the changing pool.

### Avoid when
<!--meta polarity=avoid-->

- **There is only ever one instance** — the balancer is pure overhead with nothing to spread across.
- **Requests need one stateful process** — requests must reach one specific stateful process; route directly or shard instead of balancing.
- **Need routing, not spreading** — what you actually need is request routing by path or tenant, not capacity spreading; that's closer to an [API Gateway](./api-gateway.md)'s job.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — least-connections routing over a health-filtered pool"
interface Instance { id: string; healthy: boolean; connections: number }

class LoadBalancer {
  constructor(private readonly instances: Instance[]) {}

  // Picks the healthy instance with the fewest open connections.
  private next(): Instance {
    const healthy = this.instances.filter((i) => i.healthy);
    if (healthy.length === 0) throw new Error("no healthy instances");
    return healthy.reduce((best, i) =>
      i.connections < best.connections ? i : best
    );
  }

  async route<T>(fn: (i: Instance) => Promise<T>): Promise<T> {
    const inst = this.next();
    inst.connections++;
    try {
      return await fn(inst);
    } finally {
      inst.connections--; // freed whether the call succeeded or not
    }
  }

  markUnhealthy(id: string): void {
    const inst = this.instances.find((i) => i.id === id);
    if (inst) inst.healthy = false; // dropped from rotation, not removed
  }
}
```

## In the wild
<!--meta block=wild-->

- **HAProxy** — A dedicated L4/L7 proxy: the balance directive selects roundrobin, leastconn, or source hashing, option httpchk drives active health checks, and per-server maxconn caps how many concurrent connections each backend absorbs. {#wild-haproxy}
- **NGINX** — Its upstream block pools servers with round-robin by default, or least_conn and ip_hash; open-source NGINX passively marks a server unavailable after max_fails failures within fail_timeout and retries it later. {#wild-nginx}
- **AWS Elastic Load Balancing** — Its Application (L7) and Network (L4) balancers route to target groups, run configurable health checks, spread across Availability Zones, and drain in-flight requests via a deregistration delay when a target leaves an auto-scaling group. {#wild-aws-elb}
- **MetalLB** — Supplies the load-balancer address that a bare-metal cluster has no cloud provider to hand out, announcing the service address over ARP or BGP so traffic reaches the cluster at all. {#wild-metallb}
- **NGINX Ingress Controller** — The same proxy in the cluster-ingress role: it watches the API for routing rules and rewrites its own configuration, so balancing targets follow pod lifecycle without anyone editing a config file. {#wild-nginx-ingress}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Balancing algorithm** — Round-robin, weighted round-robin, least-connections, least-response-time, or hash-based; the choice decides how evenly work spreads when request costs vary.
- **Health-check interval and thresholds** — How often the pool is probed, the per-probe timeout, and how many consecutive passes or failures flip an instance in or out of rotation. Interval times fail threshold is the outage you accept before ejection (5 s times 2 is the 10 s in the example); keep the timeout below the interval.
- **Connection draining delay** — Grace window during which an instance being removed keeps serving in-flight requests but receives no new ones, so deploys do not cut live connections.
- **Idle connection timeout** — How long an idle client or upstream connection is held open before the balancer closes it and frees the slot.
- **Per-backend connection limit** — Maximum concurrent connections routed to one instance before the balancer treats it as full and looks elsewhere.

### Signals to watch
<!--meta polarity=signal-->

- **Per-instance request distribution** — Requests or connections landing on each backend; a lopsided spread means the algorithm, weights, or stickiness are concentrating load.
- **Healthy backend count** — Instances currently passing health checks versus the pool total — the number that must never quietly reach zero.
- **Balancer error rate and latency** — 5xx returned by the balancer and its added p99, distinguishing balancer-side faults from slow or failing backends.
- **Active connections per backend** — Open connections each instance is holding; sustained imbalance flags a slow instance still passing health checks.

### Failure modes under load
<!--meta polarity=failure-->

- **Empty pool** — If every backend fails health checks at once the balancer has nowhere to route and returns errors for all traffic — an overly strict or dependency-coupled check can trigger this fleet-wide.
- **Slow instance absorbs its share** — A naive algorithm like round-robin keeps sending an even share to an instance that is passing health checks but responding slowly, dragging tail latency.
- **Thundering herd on recovery** — A just-added or just-recovered cold instance is handed its full share immediately and is overwhelmed before caches and pools warm up. Ramp its weight up over a warm-up window, or cap its connections until it is warm.
- **Sticky-session concentration** — Session affinity pins load unevenly, and a recycled instance drops the in-memory sessions pinned to it.

### Readiness checklist
<!--meta polarity=check-->

- The balancer itself is redundant — multiple nodes or a managed multi-AZ service — so it is not a single point of failure
- Health checks exercise a real dependency path, not just a static 200, but are not so coupled that a shared outage empties the pool
- Connection draining is enabled so in-flight requests finish before an instance leaves rotation
- Backends are genuinely interchangeable — no local state, or state externalized — before load is spread across them
- Alerting fires when the healthy-backend count drops below a safe threshold

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [System Design Interview](../../../themes/system-design-interview.md) — Spread requests across the fleet {#fluency-system-design-interview}
- [Performance](../../../themes/performance.md) — Spread work across many instances {#fluency-performance}
- [Scalability](../../../themes/scalability.md) — Distribute across a horizontal fleet {#fluency-scalability}
- [Global Traffic & Ingress](../../../themes/global-traffic-and-ingress.md) — Choose a healthy region for every request {#fluency-global-traffic-and-ingress}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [API Gateway](./api-gateway.md) — The gateway fronts, the balancer spreads
- [Consistent Hashing](./consistent-hashing.md) — Hash to pin a client to an instance
- [Autoscaling](./autoscaling.md) — Balance across the pool autoscaling resizes
- [Stateless Service](./stateless-service.md) — A stateless backend lets the balancer treat every replica as interchangeable.
- [API Routing](./api-routing.md) — The balancer spreads load across one service's instances after routing has chosen the service
- [Reverse Proxy](./reverse-proxy.md) — The balancer is usually a reverse proxy doing the spreading
- [Service Mesh](./service-mesh.md) — A mesh pushes the policy into every sidecar so east-west traffic balances at the source
- [Make Everything Redundant](../../../principles/redundancy.md) — The balancer is what turns a spare instance into a serving one
- [Design to Scale Out](../../../principles/scale-out.md) — The balancer is what turns instance count into usable capacity
- [Deployment Stamp](./deployment-stamp.md) — The pool it balances across can be whole stamps, not just instances
- [Blue-Green Deployment](./blue-green-deployment.md) — The pool it fronts can be a whole release, swapped in one call
- [Geode](./geode.md) — Chooses the node by proximity and health, since every node can serve every request
- [Service Discovery](./service-discovery.md) — Needs a live instance list, which is what discovery produces
- [Rolling Deployment](./rolling-deployment.md) — Rolling deployments rely on its readiness and draining of instances

**Has variant**

- [Sticky Session](./sticky-session.md) — Session affinity pins a user to one instance

**Enables**

- [Canary Release](./canary-release.md) — Weighted routing is what makes a gradual release possible

**Requires**

- [Health Endpoint Monitoring](../resilience/health-endpoint.md) — Load balancers route only to healthy instances

**Exposed to**

- [Cascading Failure](../../../hazards/cascading-failure.md) — Can fall into cascading failure when redistributing a dead node's share overloads the survivors
- [Host Header Rewriting](../../../hazards/host-header-rewriting.md) — Can fall into host header rewriting when host rewriting at the balancer breaks cookies and redirects behind it

**Demonstrated by**

- [WhatsApp](../../../designs/whatsapp.md) — distributing many persistent connections evenly over a horizontally scaled tier is textbook load balancing
- [Facebook Live Comments](../../../designs/fb-live-comments.md) — it shows content-aware routing at the connection layer, not merely even distribution of traffic
- [Ad Click Aggregator](../../../designs/ad-click-aggregator.md) — The design puts one in front of a stateless ingest tier so the stream, not the web tier, is the limit
- [Dropbox](../../../designs/dropbox.md) — Shows a load balancer fronting a control plane while the bulk bytes bypass it
- [Facebook News Feed](../../../designs/fb-news-feed.md) — Replicating a cache behind a load balancer beats sharding it when one key is hot
- [Google News](../../../designs/google-news.md) — A load balancer in front of stateless app servers is the first lever for connection count
- [Instagram](../../../designs/instagram.md) — Shows the load balancer as the spreader in front of stateless tiers that scale by count
- [Robinhood](../../../designs/robinhood.md) — Long-lived connections make the balancer's job affinity, not even spread
- [Ticketmaster](../../../designs/ticketmaster.md) — A load balancer spreads event-page traffic, but memory per instance is the real limit

**Implemented by**

- [Networking](../../../capabilities/networking.md) — Every cloud sells this at both layers.
- [Load balancers, proxies & gateways](../../../comparisons/load-balancers-and-gateways.md) — Which balancer answers on port 443 — the cloud's own against NGINX, HAProxy, Envoy and Traefik.

<!-- relationships:end -->
