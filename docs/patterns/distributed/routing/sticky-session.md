---
title: Sticky Session
description: Pins each client to one backend for the life of its session
area: distributed-routing
owner: Oleksandr Derechei
tags: [routing, load-balancing, state-management]
status: stable
aliases: [session affinity]
solves: [users get randomly logged out when the load balancer routes them to a different server, the shopping cart looks empty on some requests but full on others behind the balancer, session state lives in one instance's memory and the next request hits a different instance, a websocket or long upload breaks when the request gets sent to another backend, I haven't moved sessions to a shared store yet but traffic bounces across instances]
---

# Sticky Session

Overrides a load balancer's free spreading so that every request from one client is routed to the same backend instance for the life of its session — pinned by a cookie or the client's address — keeping per-session state that lives in that instance's memory reachable without sharing it across the pool.

## What it is
<!--meta block=description-->

A sticky session, or session affinity, is a load-balancing policy that routes every request from one client to the same backend instance for the length of its session. It exists for backends that keep per-client state in local memory, such as a login, cart or upload, which a plain balancer would scatter. The pin is a cookie naming the backend, or a hash of the client IP address.

## Explained
<!--meta block=explain-->

A sticky session ties each client to one backend instance, so every request in its session goes to the instance that holds its state in memory. A [load balancer](load-balancer.md) assumes any instance can answer any request, which fails the moment a backend keeps something locally that a later request needs, such as a login, a cart, a half-finished upload or the handshake before a websocket. Choose it over moving that state into a shared store (see [stateless service](stateless-service.md)) when the state cannot leave the process yet. The hot path then needs no store read, though anything that must survive a crash still needs a store, written off the read path.

- **Uneven load.** A few long-lived clients can weigh down some instances while the rest idle, so cap session length.
- **Slow rebalancing.** A new instance takes only new arrivals, and retiring one means waiting for its pins to expire.
- **Lost state.** A dead instance loses whatever lived only in its memory, so keep anything that matters in a store as well.
- **Address pinning.** Pinning by client address puts a whole office behind one NAT (shared address translator) on a single backend, so pin by cookie.

**Example.** Say four instances serve 400 users with a cookie pin, 100 each. Ten users run 30-minute uploads that all happen to pin to instance 2, whose CPU reaches 95% while the others sit at 30%. You add a fifth instance, but the 400 existing users stay where they are, so it takes only new arrivals and the overload eases only as sessions end. If instance 1 crashes, its 100 users lose any cart held only in its memory, so you also save carts to a store.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does this client's session live, and how does the balancer find it again? Only in instance A's memory — so the cookie inserted at step 2 is what makes step 5 land back on the one instance that holds it."
flowchart LR
    C["Client"]
    LB["Load balancer"]
    subgraph Pinned["Instance A — the only copy of this session"]
        A["Instance A"]
        S[("Session in local memory")]
    end
    B["Instance B"]
    D["Instance C"]
    C -->|"1 first request, no cookie"| LB
    LB -->|"2 choose a backend, insert affinity cookie"| A
    A -->|"3 keep the session in local memory"| S
    C -->|"4 later request carries the cookie"| LB
    LB -->|"5 honour the pin, route back"| A
    LB -.->|"idle for this client"| B
    LB -.->|"idle for this client"| D
```

## Variations
<!--meta block=variations-->

- **Balancer-inserted cookie vs. application-cookie affinity** — The balancer either adds its own affinity cookie naming the backend, or reuses a cookie the app already sets, such as a session id, so no extra cookie is needed. For the app cookie it learns which backend each value maps to, or issues its own time-limited cookie keyed on it.
- **Source-IP / Layer-4 (transport-level, TCP/IP) affinity** — Pin by hashing the client's address; needs no cookie and works for any protocol, but collapses when many clients share one address behind NAT, a corporate proxy, or carrier-grade NAT. Cookie affinity needs a balancer that reads the HTTP request, so it must terminate TLS; under TLS passthrough only address or hash affinity is available.
- **[Consistent-hashing](./consistent-hashing.md) affinity** — Map the affinity key onto a hash ring so that adding or removing a backend re-pins only a fraction of clients, instead of reshuffling every client the moment the pool changes size. No per-client table is kept, but the re-pinned clients still lose any state held only in memory, a backend failure re-pins its keys silently, and hot keys cannot be rebalanced.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Lets each backend** keep session state in local memory, avoiding a shared session store and its network round-trip on every request.
- **Keeps a client's data warm on one instance**, so per-user caches and connections stay hot across requests.
- **Makes inherently pinned flows** work through a balancer: multi-request staged uploads, long-polling fallbacks, and the handshake before a websocket or server-sent-events stream.

### Cons
<!--meta polarity=con-->

- **Breaks even load spreading** — a handful of heavy or long-lived sessions can pin disproportionate load onto a few instances.
- **Instance failure loses pinned sessions** — an instance failing takes every session pinned to it with it, unless that state is also persisted somewhere.
- **Blunts elastic scaling**: a freshly added instance receives only new sessions, so it relieves an overloaded peer slowly, and draining one means waiting for its sessions to end.
- **Affinity is fragile at the edges** — IP affinity mis-pins a whole NAT onto one backend, and cookie affinity fails for clients that strip or reject cookies.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Backends hold per-session state** in local memory and you cannot externalize it yet.
- **A protocol or workflow is inherently pinned** — websockets, server-sent events, or a multi-step upload that must stay on one process.
- **A warm per-user cache** on one instance makes repeat requests markedly cheaper when they return to it.

### Avoid when
<!--meta polarity=avoid-->

- **Instances are genuinely stateless** — affinity only skews load and buys nothing.
- **Even spread**, fast scale-out, and quick draining matter more to you than session locality.
- **Session state already lives** in a shared store or a self-contained token — Redis, a database, a signed JWT (JSON Web Token) — so the client can land anywhere and pinning is pure downside.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — cookie-based affinity: honour an existing pin, else pick fresh"
interface Instance { id: string; healthy: boolean }

const AFFINITY_COOKIE = "srv_id";

class StickyBalancer {
  private cursor = 0;
  constructor(private readonly instances: Instance[]) {}

  // Honour an existing pin if its backend is still healthy; otherwise pick fresh.
  route(cookies: Record<string, string>): { instance: Instance; setCookie?: string } {
    const pinned = cookies[AFFINITY_COOKIE];
    if (pinned) {
      const inst = this.instances.find((i) => i.id === pinned && i.healthy);
      if (inst) return { instance: inst };           // already pinned, nothing to set
    }
    const inst = this.pickHealthy();                 // no pin, or pinned host is down
    const setCookie =
      `${AFFINITY_COOKIE}=${inst.id}; Path=/; HttpOnly; Secure; SameSite=Lax`;
    return { instance: inst, setCookie };            // tell the client where it now lives
  }

  private pickHealthy(): Instance {
    const healthy = this.instances.filter((i) => i.healthy);
    if (healthy.length === 0) throw new Error("no healthy instances");
    return healthy[this.cursor++ % healthy.length];  // round-robin for new clients
  }
}
```

## In the wild
<!--meta block=wild-->

- **HAProxy** — In a backend the cookie directive names an affinity cookie and each server tags itself (server s1 ... cookie s1); with insert indirect nocache HAProxy sets the cookie on the first response and routes every later request carrying it back to the same server. {#wild-haproxy}
- **NGINX** — Open-source NGINX pins by client address with ip_hash in an upstream block; NGINX Plus adds cookie-based affinity via sticky cookie (plus sticky route and sticky learn) so the pin survives a client changing IP. {#wild-nginx}
- **AWS Elastic Load Balancing** — Application Load Balancer target-group stickiness pins a client for a configurable duration using a load-balancer-generated cookie (AWSALB) or an application-defined cookie, keeping a session on one target. {#wild-aws-elb}
- **Traefik** — A service load balancer can enable sticky sessions with a cookie whose name, Secure, HttpOnly and SameSite attributes are configurable, pinning a client to the same server. {#wild-traefik}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Affinity mechanism** — Cookie-based versus source-IP hash — a cookie survives a client changing address and works behind NAT, while IP-hash needs no cookie but pins a whole shared address onto one backend.
- **Stickiness duration / cookie lifetime** — How long a client stays pinned before it may be rebalanced, as a cookie Max-Age or a load-balancer stickiness-duration setting. Size it from the session length seen in your logs (idle timeout plus margin), and note whether the clock is sliding (each request refreshes it) or absolute. Shorter lets the pool rebalance sooner.
- **Affinity cookie attributes** — The cookie name plus its Secure, HttpOnly and SameSite flags, which limit script access and cross-site sending. A client can still set the value by hand, so the balancer accepts a pin only for a valid backend and treats it as a hint.
- **Failover when the pinned backend is down** — Whether the balancer re-pins the client to a healthy instance — dropping any session held only in the dead one — or fails the request instead.
- **Draining / stickiness on scale-in** — Whether a backend being removed keeps serving its already-pinned sessions until they end, rather than dropping them the instant it leaves rotation.

### Signals to watch
<!--meta polarity=signal-->

- **Per-instance load skew** — Requests or active sessions per backend. Affinity concentrates load, so alert when the busiest-to-median ratio stays above a threshold you set from a baseline week of normal traffic.
- **Session-loss / re-pin rate** — How often clients are forced onto a new backend from instance churn or expiry — each event a dropped in-memory session unless that state was persisted.
- **Sessions pinned per draining instance** — How many live sessions a scale-in or deploying instance still holds, which gates how long it must stay in rotation before it can leave.

### Failure modes under load
<!--meta polarity=failure-->

- **Instance loss drops its sessions** — When an instance crashes or is recycled, every client pinned to it loses whatever lived only in its memory — logged out, cart emptied, upload restarted.
- **Hot-instance skew** — A few heavy or long-lived sessions pin onto a few backends and saturate them, while freshly added instances sit nearly idle.
- **NAT collapse under IP affinity** — Many clients behind one NAT, proxy, or carrier-grade NAT all hash to the same backend, overloading it while the rest of the pool is underused.
- **Scale-out gives no relief** — Because existing sessions stay pinned, a new instance only takes new clients, so adding capacity does little for an instance already overloaded by long-lived sessions.

### Readiness checklist
<!--meta polarity=check-->

- Decide the failure policy up front: on losing a pinned instance, re-pin and accept session loss, or persist the session so a re-pin is transparent.
- Set the stickiness duration no longer than the session actually needs, so the pool can rebalance.
- Prefer cookie affinity over source-IP affinity wherever clients sit behind NAT or shared proxies.
- Set Secure, HttpOnly and SameSite on the affinity cookie to limit exposure, and never treat the cookie as authorisation.
- Confirm connection draining holds the pinned sessions on a scale-in instance until they end or migrate, rather than cutting them.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Real-Time Updates](../../../themes/realtime-updates.md) — Pin a client's long-lived socket to one server {#fluency-realtime-updates}
- [Global Traffic & Ingress](../../../themes/global-traffic-and-ingress.md) — Stop a user flipping between versions mid-session {#fluency-global-traffic-and-ingress}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [WebSocket](../../messaging/websocket.md) — A held socket is the main reason to pin a client to one instance.
- [API Gateway](./api-gateway.md) — Long-lived streams through a gateway are the case that needs affinity
- [Consistent Hashing](./consistent-hashing.md) — Hashing the client or session key to a backend is the stateless-balancer way to get affinity; the ring keeps most pins when instances change.

**Alternative to**

- [Stateless Service](./stateless-service.md) — When a service cannot be made stateless, pin each client to the node that holds its state.

**Variant of**

- [Load Balancer](./load-balancer.md) — Sticky sessions are a load-balancing policy that pins a client to one backend, trading even spread for session locality.

**Exposed to**

- [Host Header Rewriting](../../../hazards/host-header-rewriting.md) — Cookie affinity breaks when the proxy rewrites the host, so the balancer sees a first-time visitor

**Demonstrated by**

- [Google Docs](../../../designs/google-docs.md) — all connections belonging to one session deterministically land on the same backend instance so shared state stays local
- [Robinhood](../../../designs/robinhood.md) — stateful streaming connections require session affinity so each tick reaches the right open socket

**Implemented by**

- [Networking](../../../capabilities/networking.md) — Balancer affinity pins a caller to one backend without your code holding the mapping.

<!-- relationships:end -->
