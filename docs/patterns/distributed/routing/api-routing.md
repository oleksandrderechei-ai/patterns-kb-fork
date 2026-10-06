---
title: API Routing
description: Decides what in a request names the service it wants
area: distributed-routing
owner: Oleksandr Derechei
tags: [routing, decoupling, edge]
status: stable
aliases: [path routing, hostname routing, header-based routing]
solves: [our services are spread over a dozen hostnames and every client hardcodes all of them, adding a service means another entry in the client SDK and another client release, one routing config change took down every service behind it at once, I want to send a slice of traffic to the new version without asking clients to change anything, the team that owns billing has to file a ticket with us to change its own URL]
---

# API Routing

Exposes many independently owned services to outside callers by fixing what in a request names the service it wants — a path segment, a hostname, or an HTTP header. The choice decides who owns DNS, who reviews a routing change, and how much a client has to know before it can call anything.

## What it is
<!--meta block=description-->

Teams want to release alone, and callers want one thing to learn. API routing decides which part of a request, the path, the hostname or a header, names the service that answers it. Each scheme shifts the cost differently between the teams and the callers. The rules can run on your own proxy, a managed gateway or a CDN edge.

## Explained
<!--meta block=explain-->

API routing is the choice of which part of a request, the path, the hostname or a header, names the service that should answer it. Without a deliberate choice, each team picks its own and callers must learn all of them. Choose the scheme by who bears the cost of change. Hostnames, such as billing.api.example.com, push the cost onto callers, who must track one name per service, and give each team its own release schedule. Paths, such as /billing, put every service under one name, which is easier for callers but puts all routing in one shared configuration. Headers need control of the client, so they are a poor front door but a good way to carry versions and canary choices behind one. Then price the place where the rules run: your own proxy is dearest at low traffic and cheapest at very high traffic, a managed [gateway](api-gateway.md) is the reverse, and an edge function such as Lambda@Edge can take up to 30 minutes to reach every location.

- **Shared configuration.** One bad rule in a shared path file becomes an outage for everyone, so have a second person review every change to it.
- **Rule pile-up.** Rules are added faster than removed, so delete old ones on a schedule.
- **Overlap surprises.** Overlapping rules resolve by order, so put specific rules first and test one sample request per rule.

**Example.** api.example.com holds 30 path rules from 6 teams. One team adds /billing/\* at position 4, and the export team's /billing/export/\* sits at position 21. The first match wins, so about 2,000 export calls an hour land on billing and return 404, because billing has no export route. You fix it by putting specific rules first, and by running a test that sends one sample request per rule and asserts which upstream answers, before each release, which would have caught it. A quarterly review also deletes the 8 rules that point to retired services. The cost is that review and test on a shared file, which hostname routing would have avoided.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one request reach the right service out of dozens behind the same address? The routing layer reads three things — host, path prefix, header — and the first rule that matches all of them names the upstream, which is why rule order is the contract."
flowchart LR
    C["Client"]:::ext
    subgraph Front["One shared routing configuration"]
        R["Routing layer"]
        Rules[("Rule table")]
    end
    Svc["Orders service v2"]
    C -->|"1 GET api.example.com/orders/42, x-api-version: 2"| R
    R -->|"2 read the host, the path prefix, the header"| Rules
    Rules -->|"3 most specific rule names one upstream"| R
    R -->|"4 forward the request"| Svc
    Svc -->|"5 return the response"| R
    R -->|"6 answer the client"| C
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Which of the three schemes is in play? Each reads a different part of the same request, and a real API usually runs two of them at once — one to reach the service, a header on top for the version."
flowchart LR
    C["Client"] --> R{"Routing layer<br/>reads the request"}
    R -- "host: billing.api.example.com" --> B["Billing service"]
    R -- "path: /orders/*" --> O["Orders service"]
    R -- "header: x-api-version: 2" --> V["Orders service v2"]
```

## Variations
<!--meta block=variations-->

- **Path routing** — Every service sits under one hostname and a URI segment selects it — `api.example.com/billing`. Consumers learn one address and the documentation stays in one place, which is why most teams start here. The bill is operational: one shared configuration that every team's traffic passes through, an extra hop of latency, and a misconfiguration that can disrupt every service at once — so it needs a change-management process mature enough to be trusted with that.
- **Hostname routing** — Each service gets its own name — `billing.api.example.com` — and teams own everything from the DNS entry down. Nothing is shared, so nothing has to be coordinated at release time, and isolating a Region or a version is just another label on the front (`eu.billing.api.example.com`). The cost lands on the consumer, who now has to remember a different hostname per API; a client SDK hides that, and brings its own burden of versioning, multi-language support and breaking-change communication.
- **Header routing** — A header names the version, the operation, or the variant, while the path still says which resource is meant. Configuration changes are small and easy to automate, which makes it the natural fit for version routing, feature flags and A/B tests. It assumes you control the client enough to set custom headers, and proxies, CDNs and load balancers cap total header size — rarely a problem, but a real one once headers and cookies accumulate.
- **Self-managed HTTP proxy** — An HTTP server or an ingress controller maps the request onto an internal address by rule. It gives service teams full control and no per-request platform fee, and is the cheapest option at very high volume; below that it is the most expensive, because the cost moves from the invoice to the people who test and operate it. The crossover depends on request volume, the gateway's per-request price and the cost of the people who operate the proxy; work it out before choosing.
- **Managed [API gateway](./api-gateway.md)** — The same routing as a managed service, with authentication, [throttling](../resilience/rate-limiter.md), tracing and usage tiers available at the same hop. Route on a wildcard — `/billing/*` — rather than enumerating every path, so the root configuration does not have to change every time a team adds an endpoint. Per-request pricing is the constraint at high volume.
- **[CDN](./cdn.md) edge routing** — The routing decision runs as code at the edge, which is what makes canary releases, A/B tests and path rewriting expressible. It is the cheap option when you also want the responses cached. Two limits shape it: CloudFront's dynamic origin selection unifies at most 250 origins, and an edge-function change takes minutes to deploy and up to 30 minutes to reach every point of presence, blocking further updates until it finishes.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Clients bind** to a stable naming scheme while the services behind it are split, merged and moved.
- **One place for shared concerns** — auth, throttling, logging and tracing are applied once here, not reimplemented in every service.
- **Nothing behind the routing layer** has to run on the same platform, language or cloud; being HTTP-compatible is the whole contract.
- **A rule can send** a slice of traffic somewhere new, which is what makes canaries and gradual cut-overs possible without touching clients.

### Cons
<!--meta polarity=con-->

- **Path and header routing** put every team's traffic through one shared configuration, where a bad change is a shared outage.
- **Hostname routing pushes the cost onto consumers**, who must learn and track a hostname per service.
- **Path and header routing add a hop**, and its latency and availability are floors under everything behind it. Hostname routing adds none unless a shared proxy sits behind the names.
- **Header routing needs client control** — header routing only works where you control the client, which rules it out as the front door for a public API; it still carries versions and canary choices behind one.
- **Rules accumulate faster than anyone removes them**, and precedence between overlapping rules is where the surprises live.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several teams expose services** that outside callers should experience as one API.
- **The set of services behind** the boundary changes more often than the addresses clients are willing to update.
- **You need to shift traffic** — a new version, a canary, a Region — without a client release.
- **Downstream services** run on mixed platforms and only agree on HTTP.

### Avoid when
<!--meta polarity=avoid-->

- **There is one service and one client**, where a hostname and a deploy are the whole answer.
- **Callers are internal** and already discover each other through the platform's own service networking.
- **No team can own the shared routing configuration**, in which case hostname routing avoids the coordination the others require.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — one rule table, all three schemes, most specific wins"
type Rule = {
  host?: string;                    // hostname routing
  pathPrefix?: string;              // path routing
  header?: [name: string, value: string];   // header routing
  upstream: string;
};

// Order is the contract, not an accident: the first match wins, so the most
// specific rule has to be listed first. Put the version override above the
// plain path rule or it can never be reached.
const rules: Rule[] = [
  { pathPrefix: "/orders", header: ["x-api-version", "2"], upstream: "http://orders-v2.internal" },
  { host: "billing.api.example.com",                       upstream: "http://billing.internal" },
  { pathPrefix: "/orders",                                 upstream: "http://orders.internal" },
  { pathPrefix: "/",                                       upstream: "http://web.internal" },  // catch-all hides routing mistakes; delete this rule to get the 404 below
];

function resolve(req: { headers: Record<string, string>; url: string }): string | undefined {
  const host = req.headers["host"];
  const path = new URL(req.url, `http://${host}`).pathname;

  for (const rule of rules) {
    if (rule.host && rule.host !== host) continue;
    if (rule.pathPrefix && !path.startsWith(rule.pathPrefix)) continue;
    if (rule.header && req.headers[rule.header[0]] !== rule.header[1]) continue;
    return rule.upstream;   // every condition on this rule held
  }
  return undefined;         // no default route configured — answer 404, never guess
}

```

## In the wild
<!--meta block=wild-->

- **NGINX** — The self-managed end: a location block matches the request URI and proxy_pass forwards it to the internal address, with capture groups letting one rule map every /\<service>/ prefix onto \<service>.internal rather than enumerating them. A Kubernetes Ingress resource expresses the same idea declaratively, matching host and path to a Service. {#wild-nginx}
- **Amazon API Gateway** — Routing as a managed service: in HTTP proxy mode it wraps many services under one subdomain and forwards to the nested service. AWS advises mapping wildcard paths such as /billing/\* rather than every path of every service, so the root gateway does not need updating with every API change — and the same hop carries authorizers, request throttling, usage plans and tracing. {#wild-aws-api-gateway}
- **Amazon CloudFront** — Routing as code at the edge: dynamic origin selection runs a Lambda@Edge function that picks the origin per request, which is what makes A/B tests, canary releases, feature flagging and path rewriting expressible in the routing layer. It unifies at most 250 origins, and an updated function takes minutes to deploy plus up to 30 minutes to propagate to every point of presence, blocking further updates until it completes. {#wild-cloudfront}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Rule precedence and specificity** — The order overlapping rules are evaluated in. A broad prefix listed above a narrow one makes the narrow rule unreachable, and nothing errors — the traffic just goes somewhere plausible and wrong.
- **Wildcard depth** — Whether the front routes on /billing/\* or on every path the billing service exposes. Wildcards keep the shared configuration still while teams add endpoints; per-path mapping buys per-endpoint policy at the cost of a change here for every change there.
- **Default route behaviour** — What happens to a request no rule matched — a 404, or a catch-all origin. A catch-all hides routing mistakes as odd behaviour in whichever service inherited them.
- **Header size and forwarding allowance** — Which headers are forwarded to the origin and the total header budget the tier permits. Header-based routing lives inside that budget, alongside cookies and tracing headers.
- **Timeouts at the routing hop** — Connect and read timeouts to the upstream, which have to sit inside the caller-facing deadline or the hop turns a slow origin into a slow client with no error to show for it.

### Signals to watch
<!--meta polarity=signal-->

- **Per-rule request rate and error rate** — Traffic and 5xx broken down by matched rule. A rule whose rate falls to zero after a config change is the fastest way to see a routing regression.
- **Unmatched request count** — Requests that fell through to the default route or a 404. A step change here follows almost every bad rule deployment.
- **Added latency at the routing hop** — Time spent in the routing layer versus at the origin, so the extra hop is a measured cost rather than an assumed one.
- **Configuration propagation age** — How long since the current rule set was fully deployed everywhere, which matters most on an edge tier where propagation is measured in tens of minutes.

### Failure modes under load
<!--meta polarity=failure-->

- **Shared-configuration blast radius** — With path or header routing, one bad rule sits in front of every service and takes them all down together. This is the risk hostname routing does not have, and the reason path routing needs a review process.
- **Rule shadowing** — A newly added broad rule silently captures traffic meant for a narrower one already in the list. Nothing fails; requests simply arrive at the wrong service.
- **Propagation lag during an incident** — An edge routing change can take tens of minutes to reach every location and blocks further updates until it finishes, so the rollback you want is not available for the length of the outage.
- **Origin ceiling reached** — A tier with a hard cap on distinct origins stops accepting new services quietly at the edge of the limit, long after the architecture assumed it could keep adding them.
- **Header stripped in transit** — An intermediate proxy or CDN drops or truncates the custom header the routing depends on, and requests land on the default route with no obvious cause.

### Readiness checklist
<!--meta polarity=check-->

- Rule order is explicit and reviewed — the most specific rule is listed first
- An unmatched request answers 404 rather than falling into a catch-all origin
- Wildcard prefixes let teams add endpoints without editing the shared configuration
- Routing-hop timeouts sit inside the caller-facing deadline
- Per-rule traffic and unmatched counts are monitored, with an alert on a rule going to zero
- The rollback path for a routing change is rehearsed, and its propagation time is known
- Header-based routes are documented as internal — they assume a client you control

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [API Design](../../../themes/api-design.md) — What in a request names the service it wants {#fluency-api-design}
- [Global Traffic & Ingress](../../../themes/global-traffic-and-ingress.md) — Keep two application programming interface (API) versions live during a release {#fluency-global-traffic-and-ingress}
- [Continuous Validation](../../../themes/continuous-validation.md) — Route each caller to its version during the overlap {#fluency-continuous-validation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [API Gateway](./api-gateway.md) — The gateway is where a routing scheme is usually enforced, plus the policy applied on the way through
- [Reverse Proxy](./reverse-proxy.md) — A self-managed proxy is the cheapest place to run these rules, and the most work to operate
- [Load Balancer](./load-balancer.md) — Routing picks which service answers; the balancer picks which instance of it
- [Backend-for-Frontend](./bff.md) — One hostname or path prefix per client type is how a backend-for-frontend is exposed
- [API Versioning](./api-versioning.md) — Version selection is the most common reason to route on a header rather than on the path
- [Trie](../coordination/trie.md) — Routers can store path prefixes in a prefix tree to find the matching service
- [Canary Release](./canary-release.md) — A rule that sends a weighted slice of traffic to the new version is how a canary is executed
- [CDN](./cdn.md) — A CDN edge is one place routing rules can run, adding caching but slow rule propagation

**Implemented by**

- [Networking](../../../capabilities/networking.md) — Managed application programming interface (API) gateways express the route table declaratively — map wildcard prefixes rather than every path, or the gateway changes on every API change.

<!-- relationships:end -->
