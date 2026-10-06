---
title: Federated Identity
description: "One identity provider, trusted across many services"
area: distributed-coordination
owner: Oleksandr Derechei
tags: [security, authentication, access-control, decoupling]
status: stable
aliases: [SSO, identity federation]
solves: [every one of our services has its own login screen and its own password reset flow, when someone leaves the company I have to remember to disable them in nine different systems, the enterprise customer will not onboard unless they can sign in with their own corporate account, I do not want to store and protect other people's passwords, we bolted MFA onto one app and now have to build it again in every other one]
---

# Federated Identity

One identity provider authenticates a user once, and every participating service accepts that provider's signed word for who they are instead of checking a password of its own.

## What it is
<!--meta block=description-->

Federated identity lets one identity provider check who a user is once, then vouch for that user to many separate services with a signed, time-limited proof, so no service sees a password. Each service verifies the signature against keys swapped beforehand. Multi-factor checks, password rules and revocation live in one place, but the provider becomes the one door every service trusts and you must defend.

## Explained
<!--meta block=explain-->

Federated identity lets one identity provider check who a user is, then vouch for that user to many separate services, which never see a password. The provider hands the user a signed, time-limited proof, and each service verifies the signature against a key (issuer address and certificate) the two sides exchanged beforehand, with no call back to the provider on each request. Choose it over a login in every service when you want multi-factor checks, password rules and revocation enforced in one place, or when a business customer will only sign in through their own provider.

- **One door.** The provider is the one door to defend, and its downtime blocks every new login. Run it highly available and watch it.
- **Trust upkeep.** Keys rotate and clock drift rejects good tokens. Rotate on a schedule that cached keys can follow, and sync clocks.
- **Revocation gap.** Disabling a user does not end issued tokens. Keep lifetimes short, and end each service session too.

**Example.** Five services trust one provider, and each accepts a signed token for 10 minutes. A user signs in once at 09:00 and uses all five with no further password prompts, because services silently fetch fresh tokens while the user's provider session is live, as at 09:15. At 09:20 an administrator disables the account. The provider refuses any new token at once, but the token issued at 09:15 is still accepted until 09:25, a gap of 5 minutes. A one-hour token would have left the user in until 10:15. Shorter tokens narrow the gap, but they send users back to the provider more often.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a service let you in without ever seeing your password? Step 6 is a local check against keys the two sides agreed on before any user logged in, so there is no callback to the provider — which is why the assertion's own expiry is the only thing that limits it."
flowchart LR
    U["User's browser"]:::ext
    SP["Service provider"]
    IdP["Identity provider"]:::ext
    subgraph Trust["Trust agreed out of band"]
        Keys[("Issuer URL + signing keys")]
    end
    Sess[("Local session store")]
    U -->|"1 ask for a protected page"| SP
    SP -->|"2 redirect to the provider"| U
    U -->|"3 sign in, prove MFA"| IdP
    IdP -->|"4 signed, time-bound assertion"| U
    U -->|"5 present the assertion"| SP
    SP -->|"6 check signature, issuer, audience, expiry"| Keys
    SP -->|"7 start a local session"| Sess
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The identity provider authenticates the user once and hands back a signed assertion. The service provider verifies the signature and issuer, then starts its own local session — it never sees a password."
sequenceDiagram
    autonumber
    participant U as User
    participant SP as Service Provider
    participant IdP as Identity Provider
    U->>SP: request a protected resource
    SP-->>U: redirect to the trusted IdP
    U->>IdP: authenticate, prove MFA
    IdP-->>U: signed assertion or ID token
    U->>SP: present the assertion
    alt signature, issuer and audience valid
        SP->>SP: start local session, no password seen
    else assertion invalid or expired
        SP--xU: reject, send back to login
    end
```

## Variations
<!--meta block=variations-->

- **SAML 2.0** — XML assertions signed by the IdP, delivered via browser redirect or POST bindings — still the default for enterprise and government SSO (single sign-on).
- **OpenID Connect (OIDC)** — OAuth 2.0 plus a signed ID token in JWT (JSON Web Token) form — lighter weight than SAML, and the default for modern web and mobile sign-in.
- **SP-initiated vs. IdP-initiated** — The flow can start when a user hits the service and gets redirected out, or from a link on the IdP's own portal. SP-initiated preserves a state parameter and resists injected-assertion attacks better.
- **Identity broker** — A middle party sits between many identity providers and many relying services, so each side integrates once instead of pairwise. Okta and Auth0 are examples.
- **Just-in-time provisioning** — The relying service creates or updates the local user record automatically on first successful assertion, so no one has to pre-register accounts by hand.
- **Workload identity federation** — The federated subject does not have to be a person. A service or a deployment pipeline presents a token issued by its own platform, the relying party validates it against that issuer, and grants short-lived access in exchange — so there is no long-lived secret stored anywhere to leak or rotate. The trust moves into the issuer's claims, which is where the care goes: pin the subject, the audience and the repository or environment conditions exactly, because a loose match federates every tenant of that platform and not just yours.
- **Back-channel logout** — The IdP calls each relying party to end its session, which narrows the logout gap without closing it.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One login serves every participating service** — users manage a single credential.
- **MFA, password policy**, and session lifetime are enforced once, at the IdP.
- **Disabling a user at the IdP blocks every new token at once**; access ends everywhere once issued tokens and service sessions expire, and short lifetimes narrow that gap.
- **Relying services can drop their own credential store**, shrinking a major breach surface.
- **Enables partner and B2B sign-in** without provisioning a fresh account per user per system.

### Cons
<!--meta polarity=con-->

- **The IdP becomes a single** point of trust and failure — compromise it and every service is compromised.
- **Trust setup is real operational overhead**: metadata exchange, certificate rotation, clock skew.
- **Global logout is unreliable** — killing the IdP session doesn't always end every SP-side session.
- **Debugging spans two systems and a redirect chain**; an audience or clock mismatch fails cryptically.
- **Every relying service depends on the IdP's uptime for new logins**; sessions already started survive until they expire.
- **Account linking and claim mapping drift**: a changed email or subject at the IdP orphans or merges local accounts.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Users need one identity across many services**, internal or partner-owned.
- **You want to centralize authentication policy** — MFA, password rules, revocation — in one place.
- **An enterprise customer requires SSO** through their own identity provider to onboard at all.

### Avoid when
<!--meta polarity=avoid-->

- **You run a single**, standalone service with nothing else to federate with — a local login is simpler.
- **The relationship is a genuinely one-off machine-to-machine call** — a scoped API key or client credential suffices. A standing automation is the opposite case: federate its workload identity rather than store a secret for it.
- **You can't tolerate the IdP** as a hard external dependency for every login, as in offline or air-gapped environments.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — verifying an OIDC assertion from a trusted IdP"
import { createRemoteJWKSet, jwtVerify } from "jose";

const idp = {
  issuer: "https://idp.example.com",
  jwks: createRemoteJWKSet(new URL("https://idp.example.com/.well-known/jwks.json")),
};

async function federatedLogin(idToken: string): Promise<LocalSession> {
  const { payload } = await jwtVerify(idToken, idp.jwks, {
    issuer: idp.issuer,
    audience: "our-service-client-id", // reject tokens issued for someone else
    algorithms: ["RS256"],
  });

  // We trust the IdP's signed claims. Key accounts on issuer plus sub;
  // treat email as an unverified attribute unless email_verified is true.
  // In a redirect flow, also compare payload.nonce to the nonce stored
  // with the login request.
  const sub = payload.sub as string;
  const email = payload.email as string;

  const user = await findOrProvisionUser(payload.iss as string, sub, email); // just-in-time provisioning
  return startLocalSession(user); // our own session, scoped to our service only
}
```

## In the wild
<!--meta block=wild-->

- **OpenID Connect** — The standard that layers a signed ID token on OAuth 2.0, and what every Sign in with Google or Apple button speaks; relying parties fetch the IdP keys from its .well-known/openid-configuration discovery document and JWKS endpoint to verify each token {#wild-openid-connect}
- **SAML 2.0** — The long-standing XML assertion standard still required by most enterprise and government SSO integrations; trust is bootstrapped by exchanging metadata XML carrying the signing certificate, entity ID and supported redirect or POST bindings {#wild-saml}
- **Keycloak** — Open-source identity provider and broker that fronts several upstream IdPs behind one OIDC or SAML endpoint; organizes users into realms, each with its own clients, signing keys and token lifetimes {#wild-keycloak}
- **Okta** — Commercial identity broker whose whole product is being the IdP that many unrelated services agree to trust, brokering SAML and OIDC federations plus SCIM provisioning between them {#wild-okta}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **token / assertion lifetime** — how long an ID token or SAML assertion stays valid after the IdP issues it; short windows shrink the replay surface but force more round-trips to the IdP, long ones do the reverse
- **clock-skew tolerance** — the leeway a relying party allows when checking exp, nbf and iat (the clockTolerance / leeway most JWT libraries expose); too tight and legitimate tokens fail on ordinary clock drift, too loose and an expired token lingers
- **JWKS cache time to live (TTL)** — how long the relying party caches the IdP signing keys before refetching; too long and a key rotation breaks every validation until the cache expires, too short and every login pays a fetch
- **accepted signing algorithms** — the allowlist of algorithms a token signature may use — pin it to what the IdP actually issues (for example RS256) and reject the none algorithm and weaker downgrades outright
- **audience and issuer validation** — the exact iss and aud values a token must carry; without a strict aud check a service will accept a valid token issued for a different relying party

### Signals to watch
<!--meta polarity=signal-->

- **login failure rate by reason** — successful versus failed federated logins at the relying party, broken out by cause — signature, audience, expiry, unknown issuer — so a bad rotation or misconfiguration shows up as a specific spike rather than a vague dip
- **token validation latency** — time to verify a token including any JWKS fetch on cache miss; a jump usually means the key cache is missing and every login is round-tripping to the IdP
- **IdP request error rate** — errors and timeouts on calls to the identity provider — the health of the dependency that gates every single login across all relying services
- **certificate / key time-to-expiry** — days remaining on the IdP signing certificate or key; it counts down silently and, unwatched, ends every login at once the moment it lapses

### Failure modes under load
<!--meta polarity=failure-->

- **IdP outage locks everyone out** — the single point of trust becomes a single point of failure — while the IdP is unreachable, no one can obtain a fresh token, so every relying service refuses new logins at once
- **key rotation without cache refresh** — the IdP rolls its signing key but relying parties are still serving a stale JWKS cache; every token signed by the new key fails signature validation until the caches expire or are purged
- **clock skew rejects valid tokens** — the IdP and relying-party clocks drift apart beyond the tolerance; freshly issued tokens are rejected as not-yet-valid or already-expired, and it fails cryptically across a whole fleet
- **global logout gap** — killing the IdP session does not reliably end each relying party session, so a user who signed out at the IdP can still be live on an SP until that local session expires on its own; back-channel logout or short local session lifetimes narrow it

### Readiness checklist
<!--meta polarity=check-->

- Validate all four of issuer, audience, signature and expiry on every token — dropping any one opens a real hole
- Pin the accepted signing algorithms and never accept the none algorithm or a weaker downgrade
- Automate signing-certificate and key rotation with JWKS cache refresh, and alert well before any certificate expires
- Bound the clock-skew tolerance and keep both sides on Network Time Protocol (NTP) so drift never silently rejects valid tokens
- Decide what happens when the IdP is down — a break-glass path or graceful degradation — before it happens, since it gates every login

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Auth & Access](../../../themes/auth-and-access.md) — Delegate sign-on to a trusted provider {#fluency-auth-and-access}
- [Securing Availability](../../../themes/securing-availability.md) — Hold fewer secrets that can expire and take everything down {#fluency-securing-availability}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Authentication Enforcer](../../security/authentication-enforcer.md) — Trust an external IdP to authenticate
- [Single Access Point](../../security/single-access-point.md) — One sign-on across many services
- [API Gateway](../routing/api-gateway.md) — The gateway verifies the IdP's token once, at the edge
- [Secure Session Manager](../../security/secure-session-manager.md) — A verified assertion is exchanged for a local, expiring session
- [Identity Is the Perimeter](../../../principles/identity-as-perimeter.md) — Federation is how a single identity crosses service boundaries

**Implemented by**

- [Identity & Access](../../../capabilities/identity.md) — Every cloud implements this for both workforce and workload identity.
- [Identity providers](../../../comparisons/identity-providers.md) — Which identity provider to run or rent — the issuer every service delegates login to.

<!-- relationships:end -->
