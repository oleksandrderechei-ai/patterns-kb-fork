---
title: Authentication Enforcer
description: Centralizes verifying who is making the request
area: security
owner: Oleksandr Derechei
tags: [security, authentication, access-control, separation-of-concerns]
status: stable
aliases: [authn]
solves: [we shipped a debug endpoint that nobody remembered to put a login check on, every route handler starts with the same copy-pasted token parsing code, I cannot prove that all of our endpoints actually require a logged-in user, moving from passwords to company SSO would mean editing every single handler, one service trusted another service was internal and now anyone can call it]
---

# Authentication Enforcer

Centralizes the work of proving who is making a request into one component, so every route and service trusts the same verified identity instead of rolling its own login check.

## What it is
<!--meta block=description-->

Without one shared check, every route, background job and script answers "is this caller who they claim to be" its own way, and one forgotten check leaves a hole. An authentication enforcer is the single gate every request passes before business logic. It verifies the credential and attaches a resolved identity that everything downstream can rely on. Its job stops at who is calling.

## Explained
<!--meta block=explain-->

An authentication enforcer is one gate that every request passes before any business code runs. It reads the credential the caller presents, such as a password, a token or a certificate, checks it, and hands the handler either a confirmed identity or a 401 refusal. Without it, each route decides for itself whether to check, and one forgotten check is open to everyone. Choose it over a check inside each handler when you have more than a handful of routes or several teams adding them, because the gate cannot be skipped by omission. It only says who is calling; what they may do is the job of an [authorization enforcer](authorization-enforcer.md).

- **Added latency** Introspection or session lookups add a round trip, so cache results briefly; a revoked credential works until the cache expires.
- **Single point of failure** Run several copies and decide that a broken gate refuses, not admits.
- **Bypass routes** Any route around the gate breaks the guarantee, so put internal calls through it too.
- **Identity only** Keep permission checks in a separate authorization step, not folded into the gate.

**Example.** An API has 40 routes. A developer adds /internal/export and forgets the check. Without a gate, an attacker who calls GET /internal/export with no token receives 50,000 customer rows with a 200. With a gate in front, the request gets a 401 before the handler runs. At 1,000 requests a second, asking the identity provider about every token costs 1,000 calls a second. Caching each verified token for 60 seconds, with 500 active tokens, cuts that to at best about 8 calls a second (500 divided by 60), if every token is reused within its window. The price is that a stolen token still works for up to 60 seconds after you revoke it.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does a handler's idea of who the caller is come from? Step 3 verifies the credential in one place and step 5 hands on a resolved identity, so no route inspects a token itself and no route can be shipped without the check."
flowchart LR
    Cl["Client"]:::ext
    IdP["Identity provider"]:::ext
    subgraph Gate["One gate, and it only answers who"]
        AE["Authentication enforcer"]
        Store[("Verification keys and sessions")]
    end
    Az["Authorization enforcer"]
    H["Request handler"]
    Cl -->|"1 request carrying a credential"| AE
    IdP -->|"2 publish signing keys and user records"| Store
    AE -->|"3 check the signature, expiry and session"| Store
    AE -->|"4 no valid credential: 401, stops here"| Cl
    AE -->|"5 attach the verified identity"| Az
    Az -->|"6 decide what that identity may do"| H
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Middleware / filter chain** — Runs in-process on every request before it reaches a handler — Express middleware, a Servlet `Filter`, an ASP.NET pipeline stage.
- **[API Gateway](../distributed/routing/api-gateway.md)** — Push the check to the edge: the gateway authenticates once, then forwards a trusted, signed identity to services that never see raw credentials.
- **[Federated Identity](../distributed/coordination/federated-identity.md)** — Delegate verification to an external identity provider via OAuth2, OIDC (OpenID Connect), or SAML (Security Assertion Markup Language) — the enforcer's job shifts from checking a password to validating the IdP's signed assertion.
- **Token-based, stateless verification** — A signed JWT (JSON Web Token) or PASETO is verified locally by signature and expiry, with no round trip to a session store on every request. The cost is revocation: a signed token stays valid until it expires, so keep lifetimes short or check a deny list.
- **[Secure Session Manager](./secure-session-manager.md)** — Verify credentials once at login, then trust a signed session cookie or handle for subsequent requests instead of re-checking every time.
- **Step-up on a dangerous route** — The enforcer records not only who the caller is but how strongly and how recently they proved it. A route marked dangerous — changing the password or the email on the account, acting immediately after a recovery, arriving from an unfamiliar device — then refuses an identity that is merely valid and demands fresh or stronger proof first. This is the answer to a verified session outliving the moment it was trustworthy, and it is paid for in friction: every step-up interrupts a signed-in user, so the set of routes that trigger one stays short.
- **Service-mesh sidecar** — A proxy beside each service checks the caller's certificate (mutual TLS, or mTLS) before traffic reaches the service. It authenticates service-to-service calls with no code in the service.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One auditable choke point** instead of a login check copy-pasted into every handler.
- **Swapping how identity is verified** — password, token, mTLS, an external IdP — touches one component, not the whole codebase.
- **Produces a single, trusted** principal object downstream code can rely on without re-checking.
- **Nothing reaches business logic** without passing the same gate. Routes wired through the gate cannot skip it by omission; a route mounted outside it still can, so audit the route table.

### Cons
<!--meta polarity=con-->

- **A single point of failure**: misconfigure or crash it and every request behind it is exposed or locked out.
- **Adds latency to every request** unless verification results are cached sensibly.
- **Any path that bypasses** it — a debug route, a service call assumed "internal and trusted" — breaks the guarantee entirely.
- **Tempting to fold authorization logic** in alongside it, blurring identity with permission.
- **With a gateway, services must reject** identity headers from any source but the gateway, or a direct call can forge identity.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Same check on many routes** — multiple routes or services all need to answer the same question — is this caller who they claim to be — and you don't want that logic duplicated.
- **You must guarantee nothing** on your public surface is reachable without a verified identity, and want one auditable place to prove it.
- **You expect the verification mechanism to change later** — password today, [Federated Identity](../distributed/coordination/federated-identity.md) tomorrow — without rewriting every handler.

### Avoid when
<!--meta polarity=avoid-->

- **A call never leaves** a boundary you already trust and crosses no network hop where identity could be forged. Skip it only when no network hop exists, such as an in-process call. Inside a mesh, use the service-mesh sidecar variation instead.
- **You need to decide** what an already-identified caller is allowed to do — that's [Authorization Enforcer (role-based access control, RBAC)](./authorization-enforcer.md), a distinct step from identity.
- **Every request already funnels** through a [Single Access Point](./single-access-point.md) doing its own inline check — a second dedicated component is redundant ceremony.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal enforcement middleware"
type Principal = { userId: string; scopes: string[] };

interface AuthProvider {
  verify(token: string): Promise<Principal | null>;
}

// handlers read identity here, never from a header
const principals = new WeakMap<Request, Principal>();

// One place every request passes through before a handler runs.
function authenticationEnforcer(provider: AuthProvider) {
  return async (
    req: Request,
    next: () => Promise<Response>,
  ): Promise<Response> => {
    const header = req.headers.get("authorization") ?? "";
    const token = header.replace(/^Bearer\s+/, "");
    if (!token) {
      return new Response("missing credentials", { status: 401 });
    }

    let principal: Principal | null;
    try {
      principal = await provider.verify(token);
    } catch {
      // fail closed
      return new Response("auth unavailable", { status: 503 });
    }
    if (!principal) {
      return new Response("invalid or expired credentials", { status: 401 });
    }

    principals.set(req, principal);
    return next();
  };
}
```

## In the wild
<!--meta block=wild-->

- **Spring Security** — Its FilterChainProxy dispatches each request through an ordered SecurityFilterChain; an AuthenticationManager verifies the credential and the resulting Authentication is stored in the SecurityContextHolder (a ThreadLocal by default) so controllers read the principal without re-checking. {#wild-spring-security}
- **Django AuthenticationMiddleware** — Paired with SessionMiddleware, it lazily resolves the session key into request.user on every request via the configured auth backend, so views trust request.user instead of verifying credentials themselves. {#wild-django-auth-middleware}
- **Envoy ext_authz filter** — An HTTP filter that calls an external authorization service (gRPC or HTTP) for each proxied request and, on allow, adds the headers the authorization service returns to the upstream request. Its failure_mode_allow flag makes the fail-open/fail-closed choice an explicit configuration decision. {#wild-envoy-ext-authz}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Credential/token lifetime (time to live, TTL)** — How long a verified identity stays valid before re-verification is forced. Shorter limits exposure of a stolen token; longer cuts re-auth traffic to the IdP or session store. Without a deny list, this is how long a stolen token keeps working after you revoke it.
- **Verification-result cache TTL** — Cache introspection results, JSON Web Key Set (JWKS) keys, or session lookups so every request is not a round trip. Trades staleness (a revoked token still accepted) against latency and load on the identity backend. Set it to the longest delay after revocation you accept; the explain example accepts 60 seconds.
- **Clock-skew leeway** — Tolerance applied when checking token exp/nbf across machines with unsynced clocks. Too tight rejects valid tokens near expiry; too loose extends a token past its intended life. Set it from the measured clock drift between enforcer and issuer hosts.
- **Failure policy (fail-open vs fail-closed)** — What the enforcer does when the IdP or key endpoint is unreachable. Fail-closed rejects everything (availability hit); fail-open lets traffic through unauthenticated (security hole). Almost always fail closed.
- **Signing-key rotation / JWKS refresh interval** — How often the enforcer refetches the provider public keys used to verify signatures. Must be short enough to pick up a rotated key before old ones expire, or valid tokens start failing verification.

### Signals to watch
<!--meta polarity=signal-->

- **401 / authentication-failure rate** — A spike means an expired key, a broken IdP, or an attack. A drop with no matching drop in traffic can mean a bypass path skips the check; compare against that route's baseline.
- **Added auth latency (p99)** — Per-request time the enforcer adds — signature verify plus any introspection round trip. Watch p99, where cache misses and IdP slowness surface.
- **Verification cache hit ratio** — Fraction of requests served from the token/session/JWKS cache versus hitting the identity backend. A falling ratio predicts rising IdP load and latency.
- **IdP / introspection endpoint error rate and latency** — Health of the upstream the enforcer depends on. Its degradation is what drives the fail-open/fail-closed decision.

### Failure modes under load
<!--meta polarity=failure-->

- **Enforcer down or misconfigured** — The single choke point becomes a single point of failure: a crash or bad config locks every request out (fail-closed) or exposes them (fail-open). Blast radius is the whole surface.
- **Bypass path** — A debug route, health endpoint, or service call assumed internal is wired outside the filter chain and reaches business logic with no verified identity. The guarantee silently breaks for that path only.
- **Key-fetch / JWKS failure after rotation** — The provider rotates signing keys and the enforcer cannot refresh them (network, cache too long); every otherwise-valid token fails signature verification and 401s surge.
- **Clock skew rejects valid tokens** — Enforcer host drifts from the token issuer; tokens are seen as expired or not-yet-valid and rejected en masse until Network Time Protocol (NTP) or leeway is corrected.

### Readiness checklist
<!--meta polarity=check-->

- Audit the route table: prove every reachable endpoint — including debug, health, and internal-to-internal calls — passes through the enforcer.
- Confirm the failure policy is fail-closed unless a specific route has a documented reason to fail open.
- Test signing-key rotation end to end: rotate a key and confirm tokens keep verifying without a restart.
- Measure the per-request latency the enforcer adds under load and confirm it fits the budget with the cache cold.
- Keep 401 (unauthenticated) distinct from 403 (unauthorized) so identity and permission failures are diagnosable separately.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Auth & Access](../../themes/auth-and-access.md) — Establish who is calling {#fluency-auth-and-access}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [API Gateway](../distributed/routing/api-gateway.md) — Authenticate once at the edge
- [Federated Identity](../distributed/coordination/federated-identity.md) — Trust an external IdP to authenticate
- [Secure Session Manager](./secure-session-manager.md) — Authenticate, then carry a secure session
- [Single Access Point](./single-access-point.md) — Authenticate at the one entry
- [Identity Is the Perimeter](../../principles/identity-as-perimeter.md) — The enforcer is where the identity claim actually gets checked

**Enables**

- [Authorization Enforcer (RBAC)](./authorization-enforcer.md) — Establishes who is asking, which the authorization check then builds on; the two are often mistaken for one step

**Demonstrated by**

- [Payment System](../../designs/payment-system.md) — request signing at the gate is enforcement of authenticity and integrity centralized in one place

**Implemented by**

- [Identity & Access](../../capabilities/identity.md) — The cloud's identity service is this, operated for you.
- [Identity providers](../../comparisons/identity-providers.md) — The provider products whose tokens this pattern verifies.

<!-- relationships:end -->
