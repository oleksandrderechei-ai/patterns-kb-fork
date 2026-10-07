---
title: Stateless Service
description: "Keeps no per-client state in memory, so any instance can serve any request"
area: distributed-scale
owner: Oleksandr Derechei
tags: [scalability, state-management, availability, decoupling]
status: stable
solves: [when a server restarts everyone logged into it gets signed out, users have to keep hitting the same box or their session disappears, I can't just add more instances because each one keeps its own session data in memory, a crashed instance loses every in-progress request that was on it, scaling out breaks logins because sessions live in one machine's RAM]
---

# Stateless Service

Holds no client session state in its own memory between requests — everything a request needs either travels with it or lives in a shared store — so requests can hit any instance interchangeably, and the fleet can scale out, fail over, and redeploy without a user ever noticing.

## What it is
<!--meta block=description-->

A stateless service keeps no client-specific state in its own memory between requests. What a request needs, such as the caller's identity or cart, travels with it in a token or is read from a shared external store. Any instance can then serve any request, which makes adding, removing and replacing instances cheap. The state is relocated, not removed.

## Explained
<!--meta block=explain-->

A stateless service keeps nothing about a client in its own memory between requests, so any copy of it can answer any request. What a request needs, such as who the caller is or what is in the cart, travels with the request in a token or is read from a shared store and written back. Without that, a server holding a session in memory forces the client to return to the same copy, called a [sticky session](sticky-session.md), and when that copy dies the session dies with it. That blocks scaling out, makes rolling deploys drop sessions and turns removing a copy into a data move. Choose it over sticky sessions when you will run several copies behind a load balancer or add and remove them automatically. The state does not vanish: it moves somewhere shared and lasting.

- **Store round trip.** Every request pays a store trip, so cache only rarely changing values and treat the cache as disposable, never the only copy.
- **Shared dependency.** The store becomes a bottleneck and a single point of failure, so replicate it and watch its latency.
- **Heavy tokens.** Big tokens bloat every request and hit cookie size limits, so carry an ID and keep the rest in the store.
- **Poor fit.** Long-lived connections and large in-memory data do not fit, so keep those as separate stateful parts.

**Example.** A cart service runs 3 copies for 10,000 active shoppers, so about 3,333 per copy, and a deploy restarts the copies one at a time. With carts in each copy's memory, every restart wipes about 3,333 carts, 10,000 over the deploy. With carts in a shared store, no cart is lost and any copy answers any shopper. The cost is that each request spends about 2 ms reading the cart and up to 2 ms writing it back, so 500 requests a second make up to 1,000 store operations a second on a dependency that now must stay up.

## How it works
<!--meta block=structure-->

```mermaid caption="How can a request be served by an instance that has never seen this client? Step 2 picks whichever instance is free, because steps 3 and 4 keep the only copy of the session outside the tier — so killing an instance mid-deploy costs nothing."
flowchart LR
    Client["Client"]:::ext
    LB["Load balancer"]
    subgraph Tier["Interchangeable instances — no client is pinned"]
        A["Instance A"]
        B["Instance B"]
        N["Instance N"]
    end
    Store[("Shared session store")]
    Client -->|"1 request + session id"| LB
    LB -->|"2 any instance will do"| A
    LB -->|"2 any instance will do"| B
    LB -->|"2 any instance will do"| N
    B -->|"3 read the session"| Store
    B -->|"4 write it back"| Store
    B -->|"5 respond"| Client
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Externalized session store** — Session state moves to a shared store (a database, Redis, a [distributed cache](../../caching/distributed-cache.md)) that every instance reads and writes, so sessions survive an instance dying while the service itself stays stateless.
- **Token-carried state** — The request carries its own context in a signed token (such as a JWT (JSON Web Token)), so a handler needs no store lookup on the hot path — at the cost of token size and harder revocation.
- **[Sticky sessions](./sticky-session.md) (the compromise)** — A load balancer pins each client to one instance, so in-memory state still works. This is the affinity statelessness removes, kept only as a stopgap when externalizing state is impractical.
- **Stateless compute over managed storage** — The compute tier is fully disposable and all state is delegated to managed backing services — the shape behind serverless functions and twelve-factor processes.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Any instance serves any request**, so scaling out is just adding instances behind a load balancer.
- **Losing an instance loses no session state**: once health checks eject it the load balancer routes around it, though requests in flight on it fail, so keep handlers idempotent and retry.
- **Rolling deploys**, blue-green and autoscaling get much simpler because instances are disposable, once draining and readiness gating are in place.
- **No sticky-session routing needed**: round-robin or least-connections works, since any instance can serve any request.

### Cons
<!--meta polarity=con-->

- **Every request pays to load** (and write back) state from an external store, adding latency.
- **That shared store** becomes a common dependency and a new bottleneck or single point of failure.
- **Carrying large state** in tokens bloats every request and can hit header or cookie size limits.
- **Inherently stateful workloads** — long-lived connections, big in-memory working sets — do not fit cleanly.
- **Concurrent writes to one session**: any instance can write the same session at once, so concurrent updates need versioning or atomic store operations.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need to scale** a service horizontally behind a [load balancer](./load-balancer.md).
- **You want instances to be disposable** — for autoscaling, rolling deploys, and fast failover.
- **Each request can carry its context** or cheaply fetch it from a shared store.

### Avoid when
<!--meta polarity=avoid-->

- **The work is inherently stateful** — a long-lived session, a large in-memory working set, or a stateful protocol.
- **The per-request cost of loading** external state dominates and cannot be cached away.
- **A single instance is simpler** and you have no need to scale out.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a handler that keeps no local state"
// Stateless: the process keeps no per-client state between requests.
// Session state lives in a shared store, so a load balancer may route
// each request to any instance interchangeably.

type Cart = { items: string[]; version: number };

interface SessionStore {
  get(id: string): Promise<Cart | null>;
  put(id: string, cart: Cart, expectedVersion: number): Promise<boolean>; // false = stale write
}

// A pure function of (request, shared store): nothing is remembered in
// this process, so restarting or replacing the instance loses nothing.
// Any instance may write this session, so writes are versioned.
async function addToCart(
  req: { sessionId: string; item: string },
  store: SessionStore,
): Promise<Cart> {
  for (;;) {
    const current = (await store.get(req.sessionId)) ?? { items: [], version: 0 };
    const updated: Cart = { items: [...current.items, req.item], version: current.version + 1 }; // new object
    if (await store.put(req.sessionId, updated, current.version)) return updated;
    // another instance wrote first: reread and retry
  }
}

// DON'T: an in-memory map ties the client to this one instance —
// it is lost on restart and forces sticky-session routing.
// const carts = new Map<string, Cart>();

```

## In the wild
<!--meta block=wild-->

- **Twelve-Factor App** — Its sixth factor, Processes, requires apps to run as stateless, share-nothing processes; any data that must persist goes to a stateful backing service, and it explicitly warns against relying on sticky sessions. {#wild-twelve-factor}
- **AWS Lambda** — Function invocations run in execution environments that may be created fresh and are not guaranteed to be reused, so functions are written stateless, with any durable state kept in services such as DynamoDB or Simple Storage Service (S3). {#wild-aws-lambda}
- **Kubernetes** — A Deployment manages interchangeable, fungible replica Pods for stateless workloads, in contrast to a StatefulSet, which grants Pods stable identities and persistent storage for stateful ones. {#wild-kubernetes}
- **REST** — Roy Fielding's representational state transfer (REST) style makes statelessness an architectural constraint: each request must carry all the information needed to understand it, with session state kept on the client rather than the server. {#wild-rest}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Replica / instance count** — How many interchangeable instances run behind the load balancer — the primary dial for scaling a stateless tier (replicas, desiredCount).
- **Session store and its time to live (TTL)** — Where externalized state lives and how long entries survive; a shorter TTL ends idle sessions sooner and forces re-login but cuts store size, a longer one grows the store. Start from the idle timeout your product already promises users.
- **Token vs. store lookup** — Whether request context travels in a signed token or is fetched per request — trading token size and revocation lag against a store round-trip on every call.
- **Load-balancer routing policy** — Round-robin or least-connections instead of session affinity; statelessness is what lets you turn sticky sessions off.
- **State-store connection pool size** — Max connections each instance opens to the shared store; N instances multiply concurrent load on it, so set pool size to the store's max_connections divided by peak instance count, minus headroom (max_connections, pool size).

### Signals to watch
<!--meta polarity=signal-->

- **State-store latency and throughput** — Read/write latency and request rate against the shared store — the dependency every request now touches.
- **Per-instance request distribution** — Requests or CPU per instance; a lopsided spread signals leftover affinity or a routing problem.
- **Store connection saturation** — Connection-pool utilization and rejected connections at the state store as instance count grows.
- **Session cache hit rate** — Fraction of requests served from a fast session cache versus falling through to a slower backing store.

### Failure modes under load
<!--meta polarity=failure-->

- **The state store becomes the bottleneck** — Pushing all state into one shared store concentrates load there; unless it is sized for the aggregate request rate, it saturates before the stateless tier does and becomes the real scaling limit and a single point of failure.
- **Accidental in-memory state** — A cache, counter, or session quietly kept in instance memory breaks the moment a request lands on a different instance — invisible on one box, corrupt once you scale out.
- **Fat-token bloat** — Carrying too much state in tokens inflates every request and can exceed header or cookie size limits, or simply waste bandwidth.
- **Cold-cache thundering herd** — After a deploy or scale-up, fresh instances hold no warm cache and hammer the store in unison until it fills.

### Readiness checklist
<!--meta polarity=check-->

- Audit for any request-affecting state kept in instance memory across requests — caches, counters, in-process sessions.
- Externalize session state to a shared store sized for the aggregate request rate, not one instance's.
- Turn off sticky sessions / session affinity at the load balancer once state is external.
- Size the state store's capacity and connection pools for peak instance count, not today's.
- Confirm instances start clean and can serve traffic without a warm-up dependency, or gate readiness until warm.
- Drain in-flight requests on shutdown before the instance leaves the pool.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Twelve-Factor](../../../themes/twelve-factor.md) — Nothing durable held in the process {#fluency-twelve-factor}
- [System Design Interview](../../../themes/system-design-interview.md) — The precondition for horizontal scale {#fluency-system-design-interview}
- [Real-Time Updates](../../../themes/realtime-updates.md) — Keep endpoint servers stateless behind pub/sub {#fluency-realtime-updates}
- [Scalability](../../../themes/scalability.md) — Statelessness is what lets you add instances freely {#fluency-scalability}
- [Continuous Delivery](../../../themes/continuous-delivery.md) — Make an instance safe to replace mid-release {#fluency-continuous-delivery}
- [Workload Composition](../../../themes/workload-composition.md) — The precondition for splitting a workload at all {#fluency-workload-composition}
- [Scale Units & Stamps](../../../themes/scale-units-and-stamps.md) — What makes a whole unit safe to delete {#fluency-scale-units-and-stamps}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Load Balancer](./load-balancer.md) — With no per-client state on any node, a load balancer can send each request to any replica, with no affinity needed.
- [Make Everything Redundant](../../../principles/redundancy.md) — Statelessness is what makes an instance redundant rather than special
- [Prefer Managed Services](../../../principles/managed-services.md) — Statelessness is what lets the durable parts be someone else's problem
- [Container Orchestration](../coordination/container-orchestration.md) — Statelessness pays off when a scheduler is free to move instances at will.
- [Web-Queue-Worker](../../architecture/web-queue-worker.md) — Session state moves to a shared cache, which is what lets the front end scale out at all.
- [Containerization](../coordination/containerization.md) — Immutable images make replacement the normal path, which only works if nothing important lives in the process
- [WebSocket](../../messaging/websocket.md) — Sockets are the state you confine in a dedicated tier.
- [Secure Session Manager](../../security/secure-session-manager.md) — Where the session record lives when the tier keeps no per-client state.

**Alternative to**

- [Sticky Session](./sticky-session.md) — Sticky sessions keep state on one node; going stateless removes the need for affinity.

**Enables**

- [Design to Scale Out](../../../principles/scale-out.md) — Statelessness is the precondition horizontal scale is built on
- [Deployment Stamp](./deployment-stamp.md) — Statelessness is what lets a whole environment be deleted and rebuilt
- [Compute](../../../capabilities/compute.md) — This is the precondition the platform assumes; autoscaling silently corrupts state without it.
- [Geode](./geode.md) — Required before requests can be routed to whichever node happens to be nearest
- [Application Platforms](../../../comparisons/application-platforms.md) — What every managed application platform demands before it can scale or replace an instance
- [Autoscaling](./autoscaling.md) — New replicas hold no warm-up state, so the pool can grow and shrink freely with demand

**Prevents**

- [Busy Database](../../../hazards/busy-database.md) — Absorbs processing lifted off a shared store, on capacity you can add horizontally

**Demonstrated by**

- [Bitly](../../../designs/bitly.md) — Bitly's read/write services are stateless so any instance can serve any request
- [Facebook News Feed](../../../designs/fb-news-feed.md) — statelessness is what lets each tier be sized independently to its own lopsided load
- [Google News](../../../designs/google-news.md) — interchangeable instances make horizontal and elastic scaling trivial, the core payoff of a stateless service
- [Strava](../../../designs/strava.md) — a stateless service is what lets the deliberately thin backend scale by just adding instances
- [Dropbox](../../../designs/dropbox.md) — keeping the service stateless is what lets Dropbox add File Service instances freely under load
- [YouTube](../../../designs/youtube.md) — scaling a request tier freely by holding no session state is the whole point of the pattern
- [ChatGPT](../../../designs/chatgpt.md) — keeping instances stateless is what both forces and enables the runId + Redis Stream rendezvous instead of pinning a client to one box
- [Ticketmaster](../../../designs/ticketmaster.md) — horizontal read scaling works here precisely because instances are stateless and interchangeable
- [Online Auction](../../../designs/online-auction.md) — horizontally scaling the bidding tier under a spiky load is a textbook use of stateless services
- [Gopuff](../../../designs/gopuff.md) — read and write services in a delivery design multiply freely; only the regional leader stays single
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — statelessness as the reason a crash needs no special case, in a system whose whole argument is recovery
- [Facebook Post Search](../../../designs/fb-post-search.md) — Stateless query servers over shared Redis indexes scale by adding instances
- [Job Scheduler](../../../designs/job-scheduler.md) — Stateless creation servers need no queue in front until the write path actually strains

<!-- relationships:end -->
