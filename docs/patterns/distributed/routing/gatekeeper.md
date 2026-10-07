---
title: Gatekeeper
description: A dedicated broker validates requests before they reach the service
area: distributed-routing
owner: Oleksandr Derechei
tags: [security, validation, boundaries, isolation, edge]
status: stable
solves: [the process that holds our data is also the one parsing input from strangers, a parsing bug in the request handler gave an attacker the whole database, our backend is reachable straight from the internet and it keeps failing audits, token checking is copy-pasted into every service and I cannot audit them all, compliance wants a hard boundary between the open network and our records]
---

# Gatekeeper

A dedicated, hardened broker sits at the network edge and validates every request — credentials, shape, rate — before forwarding it on, so the protected service behind it never has to trust an unchecked client directly.

## What it is
<!--meta block=description-->

A gatekeeper is a small, low-privilege broker between untrusted clients and a protected service. It is the only component that talks to the service: it authenticates, authorizes, rate-limits and validates each request against a strict schema before forwarding it, or hands the client scoped, temporary access. It keeps hostile-input parsing out of the process that holds your data.

## Explained
<!--meta block=explain-->

A gatekeeper is a small, low-privilege service that stands between untrusted clients and the service holding your data. It checks who the caller is, applies limits, validates the request against a strict schema and only then forwards it. Without it, the process that holds your data and business logic also parses hostile input and checks credentials, so a bug in that exposed surface is a bug in the process you can least afford to lose. Use it when callers are untrusted. Hostile parsing then runs in a process you can throw away, with no route to the data store.

- **Added hop.** Every call pays a hop and a validation pass, so measure the added delay.
- **Single point of failure.** It carries all traffic to the service, so run several copies.
- **Schema drift.** Validation out of step with the service rejects legitimate traffic, so test both against one shared schema.
- **Bypass routes.** It protects only the path through it, so close every other route to the service.

**Example.** An orders service accepts JSON bodies up to 10 KB. The gatekeeper rejects larger bodies, bad tokens and bad schemas, and allows 50 requests a minute per client, counted in a store the 3 copies share. A crafted 4 KB body of deeply nested JSON crashes the parser in one copy, which restarts in 2 s while the others serve, and the data store stays out of reach. The cost shows when the service adds a coupon field and the gatekeeper schema is not yet updated: every order with a coupon is rejected for the 40 minutes until the schema ships.

## How it works
<!--meta block=structure-->

```mermaid caption="How does the process holding the data avoid ever parsing a stranger's input? The gate authenticates at 2, applies its rate limits and schema checks in place, and only a narrowed, well-formed call crosses into the private network at 3 — the client has no route to the service or its store."
flowchart LR
    C["Client — untrusted"]:::ext
    GK["Gatekeeper"]
    IdP[("Credential store")]
    subgraph Private["Private network — only the gate can reach it"]
        SV["Protected service"]
        DB[("Service data store")]
    end
    C -->|"1 request from the open network"| GK
    GK -->|"2 check the caller's credential"| IdP
    GK -->|"3 forward the narrowed, validated call"| SV
    SV -->|"4 read and write business data"| DB
    SV -->|"5 result"| GK
    GK -->|"6 response"| C
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Reverse-proxy gatekeeper** — The classic form: a hardened [reverse proxy](./reverse-proxy.md) terminates Transport Layer Security (TLS), strips and re-checks headers, and forwards only well-formed requests to the service sitting behind it.
- **Gatekeepers in series** — A layered request path rather than a single gate: two gatekeepers in series, each with its own trust scope. The outer stage judges raw traffic — request shape and size, rate, known attack signatures — and never looks at your API; the inner stage knows the API and enforces tokens, quotas and schema on what survives. Neither has to be good at the other's job, which is what keeps each one small enough to reason about. It costs a second hop on every request and a second policy to keep current, so a service whose whole rule set fits comfortably in one gatekeeper should keep one.
- **[Sidecar](./sidecar.md) gatekeeper** — Co-located with each service instance as a sidecar, reachable only on localhost or a private network, so each instance has its own edge instead of a shared one. It shares the instance's host and trust domain, so it narrows input but does not isolate the service.
- **Protocol-narrowing gatekeeper** — Translates a broad, attacker-facing protocol into a small, fixed set of internal calls, so the service never has more surface exposed than the gatekeeper chooses to forward.
- **[Valet Key](./valet-key.md) handoff** — Instead of proxying every call, the gatekeeper validates once and issues a short-lived, scoped credential for direct client access — trading a per-request hop for a one-time check.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Centralizes security-sensitive validation in one small**, auditable component instead of spreading it across every service.
- **Shrinks the surface the internal** service exposes to untrusted clients — only the gatekeeper ever talks to it directly.
- **If it holds no data and no credentials beyond forwarding**, a compromised gatekeeper exposes only what it may forward and the traffic it sees, not the store.
- **Doing one job well** makes it easy to keep the code path narrow, tested, and simple to reason about.

### Cons
<!--meta polarity=con-->

- **Adds a network hop** and processing cost to every proxied request; a [Valet Key](./valet-key.md) handoff pays it only on the first check.
- **Becomes a single point** of failure and a scaling bottleneck unless it's built and run highly available.
- **Validation logic** must be kept in lockstep with what the service actually expects, or the two drift apart.
- **Only protects the path that goes through it** — any other route into the service bypasses it entirely.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Clients are untrusted** or external and the service must never be exposed to the raw network directly.
- **You want one hardened**, well-tested place to enforce auth, schema, and rate limits ahead of business logic.
- **Compliance or data-sensitivity requirements demand a distinct**, isolated trust boundary in front of a resource.

### Avoid when
<!--meta polarity=avoid-->

- **All callers are already trusted and internal** — the extra hop buys nothing.
- **You need broad routing or aggregation across many backends**: that is an [API Gateway](./api-gateway.md)'s job. A gatekeeper only screens and narrows what it forwards.
- **Latency budgets** are so tight that one more network hop per request is unacceptable.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal validating gate"
type GateResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; reason: string };

async function gatekeep(req: Request): Promise<GateResult> {
  if (Number(req.headers.get("content-length") ?? 0) > 10_240) {
    return { ok: false, status: 413, reason: "body too large" };
  }
  const token = req.headers.get("authorization");
  try {
    if (!token || !(await verifyToken(token))) {
      return { ok: false, status: 401, reason: "invalid credentials" };
    }
  } catch {
    return { ok: false, status: 401, reason: "invalid credentials" };
  }
  if (!withinRateLimit(clientIp(req))) {
    return { ok: false, status: 429, reason: "rate limit exceeded" };
  }
  let parsed;
  try {
    parsed = RequestSchema.safeParse(await req.json());
  } catch {
    return { ok: false, status: 400, reason: "malformed request" };
  }
  if (!parsed.success) {
    return { ok: false, status: 400, reason: "malformed request" };
  }
  return { ok: true, body: parsed.data }; // narrow, validated shape only
}

// The internal service is never reached except through this gate.
async function handle(req: Request): Promise<Response> {
  const gate = await gatekeep(req);
  if (!gate.ok) return new Response(gate.reason, { status: gate.status });
  return forwardToService(gate.body); // service still re-checks authorisation
}
```

## In the wild
<!--meta block=wild-->

- **OpenSSH privilege separation** — sshd handles pre-authentication network traffic in an unprivileged, chrooted child process, and a privileged parent performs only the few sensitive operations that child asks for — so the code parsing hostile input is not the code holding the privileges. {#wild-openssh-privsep}
- **Postfix** — Built as a set of small, separate programs rather than one privileged daemon: the network-facing components run at low privilege and in a chroot, apart from the parts that own the mail queue. {#wild-postfix}
- **Azure Bastion** — A managed hardened host that brokers RDP and Secure Shell (SSH) to virtual machines holding no public IP, so the only path to the protected machines runs through a component built for that one job. {#wild-azure-bastion}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Rate-limit threshold** — Requests per second (or concurrent in-flight) allowed per client identity before the gate returns 429. Work it out from the load-tested backend maximum divided by expected active clients, with headroom. Key it by authenticated identity, not by IP behind shared NAT.
- **Max request/body size** — Hard cap on payload bytes and header size so oversized or malformed input is rejected at the gate rather than parsed by the backend.
- **Upstream connect and read timeouts** — How long the gate waits to open a connection to the protected service and to read its response. Set the read timeout just above the backend p99 and the connect timeout shorter. Return 504 on expiry and never auto-retry non-idempotent calls.
- **TLS minimum version and cipher policy** — The floor for negotiated protocol version and the allowed cipher suites when terminating client TLS at the gate.
- **Replica count** — Number of stateless gatekeeper instances run behind a balancer so the gate is not itself a single point of failure.

### Signals to watch
<!--meta polarity=signal-->

- **Rejection rate by reason** — Counts of 401 (auth), 429 (rate limit), and 400 (schema) responses, tracked separately — a spike in one points at credential problems, abuse, or contract drift.
- **Added latency of the gate hop** — p99 processing time inside the gatekeeper (auth plus validation plus TLS), the tax every request pays for the extra boundary.
- **Gatekeeper CPU utilization** — TLS termination and input parsing are CPU-bound; saturation here is what turns the gate into the bottleneck.
- **Upstream in-flight requests** — Concurrent requests forwarded to the protected service; nearing the connection or pool limit means the gate is about to queue or shed.

### Failure modes under load
<!--meta polarity=failure-->

- **Gate becomes the bottleneck** — Under load the gatekeeper saturates CPU on TLS and parsing and slows every request, since all traffic must pass through it.
- **Validation drift** — The gate schema and the backend contract fall out of lockstep — valid requests get rejected, or malformed ones slip through to a backend that trusts them. Detect it with CI contract tests of the gate schema against the backend schema, and watch the 400 rate after each deploy.
- **Bypass path** — Any network route that reaches the backend without passing the gate leaves it entirely unprotected.
- **Fail-open on error** — If the gate passes requests through when its own checks error instead of failing closed, an internal fault silently disables validation.

### Readiness checklist
<!--meta polarity=check-->

- Backend is network-isolated so the gatekeeper is the only component that can reach it
- Gatekeeper runs low-privilege with no direct access to the backend data store
- Validation fails closed — any error rejects the request rather than forwarding it unchecked
- Redundant instances run behind a balancer so the gate is not a single point of failure
- Gate schema and version are pinned in lockstep with the backend contract and tested together

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Auth & Access](../../../themes/auth-and-access.md) — Validate and screen at that entry {#fluency-auth-and-access}
- [Global Traffic & Ingress](../../../themes/global-traffic-and-ingress.md) — Screen once at the edge, for every region behind it {#fluency-global-traffic-and-ingress}
- [Securing Availability](../../../themes/securing-availability.md) — Reject bad traffic before it costs capacity {#fluency-securing-availability}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [API Gateway](./api-gateway.md) — Validate and screen requests at entry
- [Valet Key](./valet-key.md) — Screen at the gate, then hand out scoped keys
- [Intercepting Validator](../../security/intercepting-validator.md) — The gatekeeper validates before forwarding
- [Identity Is the Perimeter](../../../principles/identity-as-perimeter.md) — The gate is one checkpoint, not the whole boundary
- [Authorization Enforcer (RBAC)](../../security/authorization-enforcer.md) — Screening at the broker is one decision point; the enforcer holds the role-to-permission rules each service applies.

**Specializes**

- [Single Access Point](../../security/single-access-point.md) — A gatekeeper is a hardened single entry

**Often confused with**

- [Quarantine](../../security/quarantine.md) — Guards the request path, not the supply chain that built the service

**Prevents**

- [Host Header Rewriting](../../../hazards/host-header-rewriting.md) — Restricting the backend to accept traffic only from the front door turns a leaked internal URL into a cosmetic bug

**Demonstrated by**

- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — a single edge that owns three different refusals — unauthenticated, over the limit, and behind on the drain

**Implemented by**

- [Networking](../../../capabilities/networking.md) — A web application firewall in front of the service is the managed form of the gatekeeper.

<!-- relationships:end -->
