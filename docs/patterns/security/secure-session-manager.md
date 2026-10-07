---
title: Secure Session Manager
description: "Issues, tracks, and expires session state safely"
area: security
owner: Oleksandr Derechei
tags: [security, authentication, state-management, lifecycle]
status: stable
solves: [logging out does not actually stop the old cookie from working, someone grabbed a cookie off a shared machine and it still gets them in months later, a compromised account stays logged in and I have no way to kick it out before the token expires, users get signed out at random whenever their request lands on a different server, I keep asking people to log in again on every single page because nothing remembers them]
favourite: true
---

# Secure Session Manager

Issues an opaque session token at login, keeps its real state under server control, and forces it to expire, rotate, or die outright on logout — so carrying identity across stateless HTTP requests never means handing out a permanent key to the account.

## What it is
<!--meta block=description-->

HTTP has no memory, so something must carry the sign-in decision to the next request. A secure session manager is the one component that issues the session identifier, decides how long it stays good and can cancel it on demand. It keeps the session state server-side or in a signed token, sends the client only an opaque handle, and treats that identifier as a secret. It sits downstream of authentication and decides how long that decision stays valid.

## Explained
<!--meta block=explain-->

A secure session manager gives a signed-in user an unguessable random identifier, sent with each request in a cookie, while the real state (who they are, what they may do, when it expires) stays on the server or inside a signed token. Without it, you ask for the password on every page, or you trust a value the user can edit. Treat the identifier as a secret: random from a strong source, sent only over encrypted connections, hidden from page scripts, and replaced at login so a planted one is useless. Choose a server-side store over a self-contained signed token when you must end sessions on demand, because a token cannot be revoked before it expires without a denylist.

- **Store availability.** The store is as critical as login, since its outage logs everyone out; give it that availability.
- **Sliding expiry.** It keeps a stolen session alive; add an absolute maximum age.
- **Signing key.** A leaked key exposes every session; rehearse key rotation.
- **URL leaks.** An identifier in a URL leaks through logs and shared links; keep it in a cookie.

**Example.** An attacker emails a victim the link bank.example/?sid=abc123, hoping the site keeps that identifier through login. Without regeneration the victim signs in, the server attaches the account to abc123, and the attacker, who already knows abc123, is signed in too. With regeneration, login issues a new 32-byte random id, 256 bits, and abc123 is dead. A stolen cookie is limited too: idle expiry is 30 minutes and the absolute cap is 8 hours, so an attacker who keeps it active still loses it at 8 hours. The cost is a store lookup on every request.

## How it works
<!--meta block=structure-->

```mermaid caption="How does the request after login know who you are? Step 4 hands back an opaque id and step 6 checks it in one component, so expiry and logout are one decision instead of a rule repeated on every route."
flowchart LR
    Br["Browser"]:::ext
    Auth["Authentication enforcer"]
    App["Application"]
    subgraph Mgr["One place issues, validates and revokes"]
        SM["Session manager"]
        Store[("Session store")]
    end
    Br -->|"1 sign in with credentials"| Auth
    Auth -->|"2 identity confirmed"| SM
    SM -->|"3 record subject, scopes, expiry"| Store
    SM -->|"4 fresh random id, HttpOnly cookie"| Br
    Br -->|"5 send the id with every later request"| App
    App -->|"6 validate and renew, or reject"| SM
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="A session is born at login, renewed on activity, and dies by timeout, revocation, or a hard cap on total lifetime — whichever comes first."
stateDiagram-v2
    [*] --> Anonymous
    Anonymous --> Active: login, session issued
    Active --> Active: request, sliding renewal
    Active --> Expired: idle timeout or max age reached
    Active --> Revoked: logout or misuse detected
    Expired --> [*]
    Revoked --> [*]
    note right of Active: server validates the token on every request
    note right of Revoked: store entry deleted or token blacklisted
```

## Variations
<!--meta block=variations-->

- **Opaque token, server-side store** — The session ID is a random, unguessable string; all real state — user, roles, expiry — lives server-side in Redis or a database, so the ID alone reveals nothing if intercepted.
- **Stateless signed session (JSON Web Token, JWT)** — Claims are encoded and signed directly into the token, so validation needs no store lookup — at the cost of being unable to revoke a single token before it expires without a separate denylist.
- **Sliding vs. fixed expiration** — Sliding renews the timeout on every request, keeping active users signed in indefinitely; a fixed absolute expiry caps how long a hijacked session stays usable regardless of activity.
- **Session ID rotation on privilege change** — Issue a fresh ID at login and again at any escalation, invalidating the old one immediately — the standard defense against session fixation.
- **Refresh token / access token pair** — A short-lived access token authorizes each call; a longer-lived refresh token, stored more carefully, is exchanged for new ones — narrowing the blast radius of a leaked access token. Rotate the refresh token on each use, treat a replayed one as theft, and keep it server-side so it can be revoked.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Confines identity state** to one component instead of scattering ad hoc cookies across the app.
- **Expiration and revocation are enforced in one place**, narrowing the window a stolen token stays useful to the idle and absolute limits, or to revocation.
- **Regenerating the id** at login and on privilege change defeats session fixation, provided no route accepts an id from the URL.
- **Server-side sessions are revoked** on the next request, provided every node reads the same authoritative store with no local cache; a compromised account can be locked out mid-session.

### Cons
<!--meta polarity=con-->

- **A server-side session store** adds a stateful dependency and a scaling and availability concern of its own — its outage reads to users as a total logout, so it needs the availability budget of the login path, not of a cache.
- **Stateless signed tokens can't** be revoked before expiry without an extra denylist, undermining "stateless."
- **Sliding expiration keeps hijacked sessions alive** — a hijacked-but-active session lives indefinitely unless capped by an absolute max age.
- **Session data is a high-value target** — a leaked store or signing key compromises every active session at once, so key rotation has to be an operation somebody has rehearsed rather than a paragraph in a design doc.
- **The identifier must never travel in a URL**: a session ID in a query string leaks through server logs, browser history and bookmarks, the Referer header, and any shared link — and hands an attacker a fixation vector the cookie-or-header transport doesn't expose.
- **Cookie transport makes the session ambient**, so state-changing routes need CSRF defence (SameSite plus a token).

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Identity across stateless requests** — any authenticated user needs their identity carried across multiple stateless HTTP requests.
- **You need central control to revoke sessions**, force logout, or cap how long a session can live.
- **Several app instances must recognize the same session** through a shared, server-side store.

### Avoid when
<!--meta polarity=avoid-->

- **Every call is independently self-verifying** — a signed request per call with no login step at all.
- **A single short-lived**, unrevokable token is genuinely acceptable and pre-expiry revocation doesn't matter.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — issue, validate, destroy"
import { randomBytes } from "node:crypto";

const sessions = new Map<string, { userId: string; expiresAt: number; absoluteExpiresAt: number }>();

// The id is a secret: unguessable random bytes, and nothing about the user in it.
function login(req: Request, res: Response, userId: string) {
  sessions.delete(req.cookies.sid); // drop any prior id, so a planted one dies at login
  const id = randomBytes(32).toString("base64url");
  sessions.set(id, {
    userId,
    expiresAt: Date.now() + 30 * 60_000,
    absoluteExpiresAt: Date.now() + 8 * 60 * 60_000,
  });
  res.cookie("sid", id, { httpOnly: true, secure: true, sameSite: "lax" });
}

function currentUser(req: Request): string | null {
  const s = sessions.get(req.cookies.sid);
  if (!s || s.expiresAt < Date.now() || s.absoluteExpiresAt < Date.now()) return null;  // unknown or expired
  s.expiresAt = Date.now() + 30 * 60_000; // slide the idle timeout; the absolute cap never slides
  return s.userId;
}

// Logout deletes the server's copy, so the cookie in the browser is now worthless.
function logout(req: Request) {
  sessions.delete(req.cookies.sid);
}
```

```typescript summary="TypeScript — a magic link whose session state lives on the server"
import { createHash, randomBytes } from "node:crypto";

interface Session { flowId: string; personaId: string; expiresAt: number; usedAt: number | null }
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// The onboardee has no account: the link IS the session. Storing only its hash
// is what lets the server expire, spend and revoke it — a self-validating token could expire but not be spent or revoked early without a store.
class SessionStore {
  private byHash = new Map<string, Session>();
  constructor(private readonly ttlMs = 48 * 60 * 60_000) {}

  create(flowId: string, personaId: string): string {
    const token = randomBytes(32).toString("base64url"); // only the onboardee holds this
    this.byHash.set(sha256(token), { flowId, personaId, expiresAt: Date.now() + this.ttlMs, usedAt: null });
    return token;
  }
  validate(token: string): Session | null {
    const s = this.byHash.get(sha256(token));
    if (!s || s.usedAt || s.expiresAt < Date.now()) return null; // spent, expired or unknown
    s.usedAt = Date.now();                                        // single use
    return s;
  }
  // Resend: the new link supersedes the old one the instant it is issued.
  rotate(flowId: string, personaId: string): string {
    for (const [hash, s] of this.byHash) if (s.flowId === flowId) this.byHash.delete(hash);
    return this.create(flowId, personaId);
  }
  destroy(token: string): void { this.byHash.delete(sha256(token)); }
}
```

## In the wild
<!--meta block=wild-->

- **Django session framework** — Stores a random session key in the cookie while keeping session data in the backend chosen by SESSION_ENGINE (database, cache, or signed cookie). SESSION_COOKIE_HTTPONLY defaults to on, SESSION_COOKIE_SECURE and SESSION_COOKIE_AGE are configurable, and the login flow cycles the session key to defeat fixation. {#wild-django-sessions}
- **Spring Session** — Replaces the container HttpSession with an implementation backed by a SessionRepository, with Redis, Java Database Connectivity (JDBC), and Hazelcast backends, so any application instance in a cluster can validate, look up, and revoke the same session independently of which node created it. {#wild-spring-session}
- **express-session** — Middleware that stores a session ID in a cookie signed with a configured secret and keeps state in a pluggable store (connect-redis and others). Cookie options cover httpOnly, secure, sameSite, and maxAge, and req.session.regenerate() rotates the ID on demand. {#wild-express-session}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Idle (sliding) timeout** — How long a session survives without activity before it expires. It sets the window an abandoned session on a shared machine stays usable. The example uses 30 minutes; shorten it for high-risk apps.
- **Absolute maximum session lifetime** — A hard cap on total session age regardless of activity. It bounds the worst case for a stolen identifier, because sliding renewal alone never ends an active session. The example uses 8 hours.
- **Cookie security flags (HttpOnly, Secure, SameSite)** — HttpOnly keeps script from reading the identifier, Secure keeps it off plaintext HTTP, SameSite limits cross-site sending. These decide which channels the handle can reach at all.
- **Session ID entropy** — Bytes of cryptographically strong randomness in the identifier — it is a secret, so size it like one rather than like a database key. The example uses 32 bytes (256 bits).
- **Store model (server-side vs stateless signed token)** — A server-side store allows deletion mid-session; a signed token validates without a lookup. This is the revocability-versus-dependency choice, and it is the one that shapes everything else.

### Signals to watch
<!--meta polarity=signal-->

- **Active session count / store size** — Live sessions the store holds — it drives store memory and latency, and a sharp climb can mean fixation spraying or a leaked token being exercised.
- **Session store latency** — Time to read and validate a session, paid on every authenticated request — so its tail latency is user-facing latency across the whole product.
- **Expired / invalid session rate** — Requests bounced for an expired or unknown identifier. A spike can mean a timeout misconfiguration, a store flush, or someone guessing ids.
- **Concurrent sessions per user** — How many simultaneous sessions one account holds; an unusual jump for a single user is a classic hijack or credential-sharing signal.

### Failure modes under load
<!--meta polarity=failure-->

- **Session store outage** — The store is on the path of every authenticated request, so if it goes down every user is logged out at once (or their requests hang) — a cache incident becomes a full authentication outage.
- **Leaked store or signing key** — One leak compromises every active session simultaneously rather than one, and until the key is rotated the attacker can create sessions at will.
- **Stateless token cannot be revoked before expiry** — A compromised signed token stays valid until it expires because there is no record to delete, so forced logout and mid-session lockout are simply unavailable.
- **Sliding session with no absolute cap** — An attacker holding a hijacked-but-active session keeps it alive indefinitely with periodic requests, because every request renews the idle timeout and nothing caps total age.
- **Missing rotation at login (session fixation)** — The identifier is not regenerated after authentication, so an attacker who planted a known id before login rides the victim into an authenticated session on that same id.
- **Identifier leaked through a URL** — A session id in a query string is copied into access logs, browser history, bookmarks and the Referer header — places with no expiry and no revocation.

### Readiness checklist
<!--meta polarity=check-->

- Session identifiers come from a CSPRNG — the framework default was read and confirmed, not assumed
- HttpOnly, Secure and SameSite were verified on a real response from the production configuration, not only in source
- The session id is regenerated at login and on any privilege change, and the old one stops working immediately
- An absolute lifetime is configured alongside the idle timeout, and a session was watched actually expiring under continuous activity
- Revocation was exercised end to end — a live session killed and the next request rejected — for whichever model you chose
- No route accepts or emits the session id in a URL, checked against the routing table rather than remembered

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Auth & Access](../../themes/auth-and-access.md) — Carry identity safely across requests {#fluency-auth-and-access}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Authentication Enforcer](./authentication-enforcer.md) — Authenticate, then carry a secure session
- [Federated Identity](../distributed/coordination/federated-identity.md) — Federation authenticates once; the session carries that identity forward
- [Authorization Enforcer (RBAC)](./authorization-enforcer.md) — Carries the subject and roles each check reads
- [Identity Is the Perimeter](../../principles/identity-as-perimeter.md) — Session handling is the part most often written badly in-house
- [External Configuration Store](../distributed/coordination/external-configuration-store.md) — The deliberate split: routine settings centralised, secrets kept somewhere built for them
- [Stateless Service](../distributed/routing/stateless-service.md) — A shared session store is what lets any instance serve a signed-in user.

**Demonstrated by**

- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — a know your customer (KYC) flow builds a session for a principal with no account — an opaque single-use link whose state is a stored hash, which is what lets it be expired and revoked; a self-validating token could be neither
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — a session designed around a person who will never register, and revoked by a resend rather than by a logout

**Implemented by**

- [Identity & Access](../../capabilities/identity.md) — Hosted identity services keep the session and hand your app a token, so you do not build the store.

<!-- relationships:end -->
