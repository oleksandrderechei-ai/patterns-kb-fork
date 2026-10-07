---
title: Single Access Point
description: "One well-guarded entry, instead of many small ones"
area: security
owner: Oleksandr Derechei
tags: [security, boundaries, access-control, edge]
status: stable
solves: [every service has its own login screen and one of them is definitely out of date, we patched a hole in one service and then found the same hole in four others, an internal admin tool is reachable from the internet and nobody remembers opening it, auditors want proof that every inbound request is logged and I cannot give it to them, each team opens its own port and I have lost track of what is actually reachable from outside]
---

# Single Access Point

Funnels every inbound request through one well-guarded entry, instead of leaving a scatter of loosely guarded doors for an attacker to try until one gives way.

## What it is
<!--meta block=description-->

A single access point makes every external interaction with a system pass through one heavily guarded channel, such as a gateway, login portal or bastion host, while internal services are reachable only through it. Attack surface grows with each entry point and the weakest door sets the real security level, so you harden one choke point with authentication, validation and audit instead of many.

## Explained
<!--meta block=explain-->

A single access point makes every outside request enter through one guarded gateway, which does authentication, input checks, rate limiting and logging once, and the services behind it accept traffic from nothing else. Without it, every service exposes its own door, each needs its own copy of those controls, and the copies drift until one is missing. Choose it over per-service protection when you have more than a few services or teams, because attack surface grows with each entry point and you can harden one gate far more thoroughly than twelve. Pair it with a network rule that backends accept only the gateway, or a service on its own port is still a second door.

- **Single point of failure.** Run several copies, sized so that losing one still carries the load.
- **Breach exposure.** A breach of it exposes everything behind it, so keep its code small and its network rules strict.
- **Added delay.** It can slow every request, so size it for peak traffic and measure the delay it adds.
- **Logic creep.** It tends to collect business logic, so keep it to security and routing only.

**Example.** A company runs 12 services, and 11 check tokens. A scan finds the forgotten reports service on port 8081, open to anyone who calls it. With a gateway, a network rule lets the backends accept connections only from the gateway's address, so the same scan from outside times out. The gateway handles 3,000 requests a second and each copy handles 1,500, so you run three copies: if one fails, two carry 3,000. The cost is about 2 ms added to every request.

## How it works
<!--meta block=structure-->

```mermaid caption="Why is one door safer than five? Steps 2 and 4 happen once for every caller, and the services behind the door have no address an attacker can reach — so there is no second path where a check could be missing."
flowchart LR
    Cl["Client"]:::ext
    Att["Attacker"]:::ext
    subgraph Gate["The only route in"]
        AP["Access point"]
        Ck["Auth, validation, rate limit"]
    end
    Log[("Audit log")]
    subgraph Priv["Private network: nothing here answers the internet"]
        S1["Service A"]
        S2["Service B"]
    end
    Cl -->|"1 every request arrives at one door"| AP
    AP -->|"2 run the checks once, for every caller"| Ck
    Ck -->|"3 failed: rejected, nothing forwarded"| Cl
    Ck -->|"4 pass or fail, both recorded"| Log
    Ck -->|"5 admitted request routed"| S1
    Ck -->|"6 or routed here"| S2
    Att -.->|"no route: nothing behind listens"| Priv
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **[Gatekeeper](../distributed/routing/gatekeeper.md)** — A minimal, hardened process built to be the single entry by design — nothing bypasses it to reach the protected system directly.
- **[API gateway](../distributed/routing/api-gateway.md)** — The network-layer version: one HTTP front door does auth, rate limiting, and routing for every downstream service in a fleet.
- **Bastion host** — The infrastructure version: one hardened, monitored host is the only machine permitted to reach an otherwise firewalled network segment.
- **Front controller** — The application version: one handler receives every web request and dispatches to per-route logic, instead of each page guarding itself.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Concentrates auth**, validation, and logging in one place instead of duplicating them everywhere.
- **Shrinks the attack surface** to one hardened door instead of many half-guarded ones.
- **Gives full, consistent audit coverage** — every request necessarily crosses one log point.
- **Security policy changes once**, at the access point, instead of once per service.

### Cons
<!--meta polarity=con-->

- **Becomes a single point of failure** — if it's down, everything behind it is unreachable.
- **Concentrates risk as well as defense**: a breach of the access point exposes everything it fronts.
- **Can become a latency** and throughput bottleneck if it isn't built for the full traffic volume.
- **Tends to accrete unrelated business logic**, drifting from a pure security chokepoint into a [god object](../../hazards/god-object.md).

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple services currently expose** their own independent entry points, each enforcing its own auth.
- **You need one place to guarantee authentication**, rate limiting, and audit logging apply consistently.
- **Compliance or threat modeling** requires a single, demonstrable chokepoint for all inbound traffic.

### Avoid when
<!--meta polarity=avoid-->

- **The system is a single small service** — there's no fan-out to funnel, and the indirection buys nothing.
- **The access point can't** itself be made highly available — you'd be trading many failure points for one worse one.
- **Per-hop latency is unacceptable** and every service already enforces its own equivalent controls.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — one guard in front of every route"
const app = express();

// Every request meets this guard before it reaches any handler below.
app.use(async (req, res, next) => {
  const token = req.headers.authorization;
  const session = await verifySession(token);
  if (!session) {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.session = session; // downstream handlers trust this
  next();
});

// Internal routers assume auth already happened — no route bypasses it.
app.use("/orders", ordersRouter);
app.use("/billing", billingRouter);
app.use("/reports", reportsRouter);

app.listen(443);
```

## In the wild
<!--meta block=wild-->

- **Cloudflare Access** — Part of Cloudflare Zero Trust: an authenticated reverse proxy that enforces identity (via an IdP over Security Assertion Markup Language (SAML), OpenID Connect (OIDC), or one-time PIN) at the edge before any request reaches the origin. Paired with a Tunnel, the origin accepts traffic only from Cloudflare and never listens on the public internet. {#wild-cloudflare-access}
- **Teleport** — A single hardened access proxy that all Secure Shell (SSH), Kubernetes, database, and web-app traffic to a protected fleet must pass through. It authenticates against an IdP, issues short-lived certificates instead of standing credentials, and records every session for audit. {#wild-teleport}
- **Kong Gateway** — Built on Nginx/OpenResty, it fronts a fleet of upstream services as one entry point and applies authentication, rate-limiting, and logging through plugins (key-auth, jwt, rate-limiting) before routing each request to its backend. {#wild-kong-gateway}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Rate-limit thresholds** — Requests allowed per client and globally before the gate starts rejecting (429s). Set too low it throttles legitimate traffic; too high it lets an abusive client saturate everything behind the one door.
- **Concurrency and timeout limits** — Maximum in-flight connections and per-request timeouts at the access point. These bound how much load reaches the fleet and stop a slow upstream from pinning all the gate connections open.
- **High-availability topology (replica count / failover)** — How many instances of the access point run behind a load balancer and how failover works. This is the direct mitigation for the patterns single-point-of-failure risk — one instance is one outage away from total unreachability.
- **Exposed-route / upstream allowlist** — Which paths and backends the gate is willing to route to. A tight allowlist keeps the surface to what is intended; a permissive default can quietly expose an internal service the moment it appears.

### Signals to watch
<!--meta polarity=signal-->

- **Gate throughput and added latency (p99)** — Requests per second the access point sustains and the latency it adds per hop. Because every request crosses it, its tail latency is the whole systems tail latency.
- **Error and rejection rate (5xx, 429)** — Rate of gate-level failures and rate-limit rejections. A 429 climb means clients are hitting the throttle; a 5xx climb points at the gate itself or a failing upstream behind it.
- **Connection saturation vs limit** — Active connections and queue depth against the configured maximum. Approaching the ceiling is the early warning that the single door is about to become the bottleneck.
- **Upstream health / routing failures** — Share of requests the gate cannot route to a healthy backend. It separates a problem at the door from a problem in the fleet behind it.

### Failure modes under load
<!--meta polarity=failure-->

- **Access point down** — The one door is a single point of failure: if it is unavailable, everything behind it is unreachable at once, no matter how healthy the backends are.
- **Access point breached** — It concentrates risk as well as defense. A compromise of the gate exposes every service it fronts, because those services trust it and no longer guard themselves.
- **Throughput bottleneck under load** — If the gate is not sized for full traffic, requests queue and time out at the entrance; the chokepoint meant to protect the fleet becomes the ceiling on serving it.
- **Bypass path behind the gate** — A backend still listening on the open network defeats the whole model — attackers walk around the hardened door to the unguarded window, and the single-entry guarantee is silently void.
- **Scope creep into a god object** — The gate accretes unrelated business logic over time, drifting from a thin, auditable security chokepoint into a sprawling component that is hard to keep hardened and reason about.

### Readiness checklist
<!--meta polarity=check-->

- Make the access point itself highly available — multiple instances behind a load balancer, never a single box.
- Verify no backend is reachable except through the gate: enforce it at the network layer, not by convention.
- Capacity-plan and load-test the gate for full traffic volume plus headroom before it fronts production.
- Keep the access point a thin security chokepoint and resist folding business logic into it.
- Confirm every inbound request crosses exactly one audit/log point at the gate.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Auth & Access](../../themes/auth-and-access.md) — Funnel access through one guarded entry {#fluency-auth-and-access}
- [Securing Availability](../../themes/securing-availability.md) — Make screening something nobody can route around {#fluency-securing-availability}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Federated Identity](../distributed/coordination/federated-identity.md) — One sign-on across many services
- [Authentication Enforcer](./authentication-enforcer.md) — Authenticate at the one entry
- [Secure Logger](./secure-logger.md) — The choke point is where the full audit trail is taken
- [Defense in Depth](../../principles/defense-in-depth.md) — One guarded entry still needs layers behind it.
- [Authorization Enforcer (RBAC)](./authorization-enforcer.md) — Everything admitted through the one channel still needs a permission check, which this enforcer supplies.

**Generalizes**

- [Gatekeeper](../distributed/routing/gatekeeper.md) — A gatekeeper is a hardened single entry
- [API Gateway](../distributed/routing/api-gateway.md) — A gateway is the usual form of the one guarded entry

**Implemented by**

- [Networking](../../capabilities/networking.md) — A managed API gateway gives all clients one entry point with auth and routing already built.

<!-- relationships:end -->
