---
title: Valet Key
description: "A token grants temporary, limited access to a resource directly"
area: distributed-routing
owner: Oleksandr Derechei
tags: [security, access-control]
status: stable
aliases: [pre-signed URL]
solves: [every file upload streams through my API server and it is melting under the load, my server is just a dumb pipe copying bytes into the storage bucket, letting the browser download the file directly would mean handing it our storage credentials, "we pay for the same bandwidth twice, once into our servers and once out", a user needs one file and I do not want to give them the whole bucket]
favourite: true
---

# Valet Key

A short-lived, narrowly scoped key lets a client reach a resource directly — one file, one queue, one row — without ever holding your master credentials or making your servers proxy the traffic.

## What it is
<!--meta block=description-->

Proxying every upload through your server pays for the bandwidth twice and ties up a connection, yet handing the browser your bucket credentials exposes everything. A valet key is a signed token naming one resource, one action and one expiry. Your server decides who gets a key; the storage service checks the signature and carries the bytes, so your server leaves the data path.

## Explained
<!--meta block=explain-->

A valet key is a signed token that lets a client use one resource directly, for one action and a few minutes, so large data flows between the client and [object storage](object-storage.md) instead of through your server. Without it, every upload crosses your server, which pays for the bandwidth twice and holds a connection for the length of a phone upload while adding nothing to the bytes. Handing the browser the bucket's own credentials would expose the whole bucket. Choose a key when the payload is large and the whole permission decision can be made when you issue the token. You win back bandwidth, connections and memory, and lose every per-request check you had while bytes passed through you. The token is a bearer credential: whoever holds it can use it, and its expiry sets the damage.

- **Hard to recall.** A bare signed URL cannot be withdrawn, so tie it to a server-side policy or a signing key you can rotate.
- **Scope from input.** Build it from the logged-in user, never from the request, or a client names someone else's file.
- **Leaks through logs.** A key in a URL lands in access logs, so keep keys out of logged URLs and expire them fast.
- **Audit gap.** Your trail ends at issuing, so make it joinable with the storage access logs.

**Example.** Users upload 200 files an hour at 50 MB each, 10 GB an hour, which a proxying server would receive and then send on, 20 GB of bandwidth. With keys, your server issues 200 tokens and moves no file bytes. Each token names uploads/u-42/ plus a random file name, allows PUT only and expires in 10 minutes, with u-42 taken from the login, not the request. If one leaks, it can write only to that one object name, repeatedly and at any size, for at most 10 minutes. The cost is that you no longer see the bytes, so a virus scan runs after the file lands.

## How it works
<!--meta block=structure-->

```mermaid caption="How do the bytes reach storage without crossing your server, and without the browser holding the bucket's credentials? The issuer signs one scoped, expiring key and then leaves the data path."
flowchart LR
    Client["Browser"]:::ext
    subgraph Decide["The issuer keeps the decision, not the bytes"]
        API["Your API"]
        Secret[("Signing key")]
    end
    Store["Object store"]:::ext
    Object[("The one object the key names")]
    Client -->|"1 ask to upload one file"| API
    API -->|"2 sign one resource, action and expiry"| Secret
    API -->|"3 hand back the key"| Client
    Client -->|"4 send the bytes, key attached"| Store
    Store -->|"5 signature checked, no callback"| Object
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The trusted server issues a scoped, expiring key up front, then steps out of the data path entirely — the client and the resource talk directly from there on."
sequenceDiagram
    autonumber
    participant C as Client
    participant S as Trusted Server
    participant R as Resource
    C->>S: request access to a resource
    S->>S: issue a key, scoped and time-limited
    S-->>C: hand back the key
    C->>R: request the resource, key attached
    alt scope, expiry, signature all valid
        R-->>C: serve the resource directly
    else expired or scope mismatch
        R--xC: reject, 403
    end
```

## Variations
<!--meta block=variations-->

- **Pre-signed URLs** — A cloud storage vendor signs a URL with an embedded expiry and permission set — Simple Storage Service (S3) pre-signed URLs and Azure SAS tokens are the canonical form.
- **Signed cookies** — The key rides in a cookie instead of the URL, so it covers a whole path prefix (a CDN (content delivery network)'s private content tree) rather than one object.
- **Single-use vs. multi-use keys** — Where the resource tracks redemption, a single-use key is invalidated after one use, which shrinks replay to the first redeemer; plain pre-signed URLs cannot do this and stay valid until expiry, which saves round trips.
- **Capability URLs** — The URL itself is the only credential — no separate login step — so possessing the link is equivalent to holding the permission.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Removes the app server from the data path**, freeing it for control-plane work only.
- **Scales bandwidth-** or storage-heavy operations without provisioning servers to carry them.
- **Scoped and time-limited**: a leaked key exposes only what its scope names and only until expiry, so scope it to one object and keep the expiry short.
- **The client never holds standing** credentials to the resource itself.

### Cons
<!--meta polarity=con-->

- **A valid key generally can't** be revoked before it expires — bind it to a server-side policy or a signing key you can rotate if you need a recall, and decide that at issuing time rather than during the incident.
- **Getting scope** or expiry wrong quietly grants broader or longer access than intended — build the scope from the authenticated identity, never from a path the client supplied.
- **Requires the resource layer to support token-based validation** — not every store does.
- **Clock skew** or an overlong expiry stretches the "temporary" window. Keep both sides on synchronized time; scope and expiry together are the blast radius.
- **Your audit trail stops at issuance**: what the holder actually did is only in the resource's own access log. Make the two joinable on a request or object id, or the record has a hole exactly where the data path used to be.
- **Caps neither the bytes transferred** nor the number of uses unless the key form carries a size condition, so a client looping on an upload runs up an egress bill on a valid key. Where the store allows it, grant create rather than write: create refuses to overwrite, which makes each key good for one object.
- **Puts a live credential in a URL**, which means it lands in every access log along the path. Restrict who can read those logs, and hold log shipping back until the keys inside have expired.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Clients need direct**, high-volume access to a resource — file upload or download — and proxying it through your servers is wasted work.
- **You want to offload bandwidth** to a CDN or blob store without ever issuing standing credentials.
- **The access need is transient and well-defined** — one object, one action, one short window.

### Avoid when
<!--meta polarity=avoid-->

- **The operation needs per-request business** logic or auditing that only your server can enforce.
- **You can't safely bound** the scope or lifetime within the resource's own access model.
- **Revocation before expiry** is a hard requirement and the resource has no way to honor it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — issuing and verifying a fifteen-minute upload key"
import { timingSafeEqual } from "node:crypto";

interface ValetKey {
  resource: string;
  action: "read" | "write";
  expiresAt: number;
  signature: string;
}

// hmacSha256 (hex digest) is assumed; "write" is used for simplicity, prefer a create-only grant where the store has one
function mintKey(resource: string, action: ValetKey["action"], ttlMs: number, secret: string): ValetKey {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${resource}:${action}:${expiresAt}`;
  return { resource, action, expiresAt, signature: hmacSha256(payload, secret) };
}

// Run by the object store itself, never by the API that issued the key
function verifyKey(key: ValetKey, requestedResource: string, requestedAction: ValetKey["action"], secret: string): boolean {
  if (Date.now() > key.expiresAt) return false;              // past the window
  if (key.resource !== requestedResource) return false;       // one key, one object
  if (key.action !== requestedAction) return false;       // one key, one action
  const payload = `${key.resource}:${key.action}:${key.expiresAt}`;
  const a = Buffer.from(hmacSha256(payload, secret)), b = Buffer.from(key.signature);
  return a.length === b.length && timingSafeEqual(a, b);   // constant-time tamper check
}

// The onboarding API issues a fifteen-minute write key for exactly one ID photo and
// hands it to the onboardee. The bytes go browser → store; this server never sees them.
const resource = `id-photos/${personaId}/${flowId}.jpg`;
const key = mintKey(resource, "write", 15 * 60_000, SECRET);
const uploadUrl = `https://blobs.example.com/${resource}?exp=${key.expiresAt}&act=${key.action}&sig=${key.signature}`;
```

## In the wild
<!--meta block=wild-->

- **Amazon S3 pre-signed URLs** — The app signs a URL with the caller credentials, scoped to one object and one HTTP method, with a bounded expiry (up to 7 days for signature v4 with long-lived IAM user credentials; a URL signed with temporary credentials stops working when they expire); the browser then uploads or downloads straight to S3 with no account key exposed. {#wild-s3-presigned}
- **Azure Shared Access Signatures** — Grants a named permission set (read, write, list) on a blob, container, or queue for a start-to-expiry window, optionally restricted by IP range and HTTPS-only; a user-delegation SAS is signed with Microsoft Entra credentials so the account key never leaves the server. {#wild-azure-sas}
- **CloudFront signed URLs and cookies** — The distribution nominates a trusted key group whose public key validates each signature, granting time-limited access to private edge content; a canned-policy signed URL covers one file while signed cookies cover a path pattern, and a custom policy can additionally restrict by IP range and date window. {#wild-cloudfront-signed}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Expiry (time to live, TTL)** — How long the key stays valid. Make it as short as the operation allows, because it is the window a leaked key stays useful for. Size it from the slowest expected transfer at the largest object size, plus a retry margin.
- **Scope** — The resource and actions the key names — one object, one method. It is the ceiling on what a leaked key can reach.
- **Single-use or multi-use** — Whether redemption invalidates the key, which closes replay only where the resource tracks redemption, or it stays usable until expiry for fewer round trips.
- **Clock-skew tolerance** — The leeway allowed on expiry checks, absorbing small differences between the issuing server and the validating resource.
- **Redemption conditions** — Extra restrictions the resource can enforce where it supports them — an IP range, HTTPS only, a start time — narrowing the same credential further.
- **Signing key rotation period** — How often the signing material changes. Rotation is the only recall some key forms have, so its period is also a security dial.

### Signals to watch
<!--meta polarity=signal-->

- **Invalid-key rejections** — Keys refused at the resource as expired, wrong-scope or badly signed. A spike is clock drift, replay attempts or a broken issuing path.
- **Issuance rate** — Keys issued per unit time, per caller. A client requesting far more keys than it uploads is worth a look.
- **Direct-to-resource share** — Bytes moving client-to-store against bytes still passing through the app server — the traffic the pattern has actually offloaded.
- **Time from issuance to redemption** — How long keys sit before use. Keys redeemed near expiry mean the TTL is protecting less than its number suggests.

### Failure modes under load
<!--meta polarity=failure-->

- **Over-broad or over-long grant** — A scope or expiry wider than the moment needed hands out access nobody reviewed, and a leaked key keeps all of it.
- **Scope built from client input** — A key whose object path comes from the request can name another user's object, and the resource will honour whatever the signature covers.
- **Revocation decided too late** — A bare signed URL cannot be withdrawn before it expires; a policy-bound or rotatable-key form can. Which form a key takes was settled when you issued it.
- **Clock skew** — Issuer and resource disagreeing on the time reject live keys or honour dead ones, and neither failure is obvious from the error.
- **Key leakage** — A credential in a URL travels into logs, referrer headers, screenshots and shared links, and whoever holds it can use it.

### Readiness checklist
<!--meta polarity=check-->

- Key issuance is authenticated and authorized by the same rules that used to guard the proxying endpoint — the decision moved, it did not disappear
- The scope of every key is built from the authenticated identity, never from a path or object id the client sent
- The signing secret lives in a secret store and its rotation has been rehearsed, since rotation is the only recall some key forms have
- Keys are kept out of access logs, referrer headers and analytics, checked against what a request actually records rather than what it should
- Clocks on the issuing and validating sides are synchronized, and the skew the resource tolerates is known rather than assumed
- Someone decided in advance what happens when a key leaks — short TTL, policy-bound issuance, or resource-side revocation where it exists
- Issuance logs and the resource access log can be joined on a request or object id, so the audit trail survives leaving the data path

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Auth & Access](../../../themes/auth-and-access.md) — Hand out scoped, expiring access, so a key that leaks opens one thing and only briefly. {#fluency-auth-and-access}
- [Securing Availability](../../../themes/securing-availability.md) — Credentials that expire without a coordinated rotation {#fluency-securing-availability}
- [Operating a Live System](../../../themes/operating-a-live-system.md) — Turn rotation into a non-event {#fluency-operating-a-live-system}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Gatekeeper](./gatekeeper.md) — Screen at the gate, then hand out scoped keys
- [Object Storage](./object-storage.md) — Grants a client temporary, direct access to a single object in the store.
- [Least Privilege](../../security/least-privilege.md) — A scoped, expiring key is least privilege in action
- [Claim Check](../../messaging/claim-check.md) — A pre-signed URL is a claim check that carries its own access grant.
- [Agent Sandboxing](../../security/agent-sandboxing.md) — The agent is a client that should hold only a short-lived token.

**Demonstrated by**

- [Instagram](../../../designs/instagram.md) — the pre-signed S3 upload URL is a valet key: a limited, expiring credential handed to the client for direct blob access
- [Dropbox](../../../designs/dropbox.md) — presigned upload/download URLs are the valet key that lets the client access storage directly without ever holding the service's real credentials
- [YouTube](../../../designs/youtube.md) — presigned direct-to-storage upload is exactly the scoped, time-limited access token the pattern grants
- [Amazon Locker](../../../designs/amazon-locker.md) — the AccessToken is a limited-scope key — direct access to a single resource, time-boxed, conferring no broader authority
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — a know your customer (KYC) flow hands the onboardee a presigned upload URL for their ID photo — one object, one action, a fifteen-minute window, and the issuing service never touches the bytes
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — a valet key whose re-issue is bounded by a counter, so the endpoint cannot become a signing oracle

**Implemented by**

- [Storage](../../../capabilities/storage.md) — Pre-signed URLs, shared access signatures and signed URLs are this pattern, already implemented.

<!-- relationships:end -->
