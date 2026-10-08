---
title: API Versioning
description: Change a published contract while the callers built on the old one keep working
area: distributed-routing
owner: Oleksandr Derechei
tags: [api-design, extensibility, boundaries, maintainability]
status: stable
aliases: [versioned API, v2, content negotiation versioning]
solves: [I need to rename a field but partner integrations read it by name, we cannot ship the fix because we do not control the apps that call us, every release breaks somebody and we find out from their support ticket, we have five versions live and nobody knows who is still on the oldest, a shared cache served one client the response shaped for a different API version]
---

# API Versioning

Runs two contracts at once so a change you need can ship without a release from callers you do not control. What carries the caller's choice — a path segment, a query parameter, a header, or the media type — sets who can cache the response, how visible the version is in a log, and how many versions you can afford to keep alive.

## What it is
<!--meta block=description-->

You own an API but not the applications calling it, so a breaking change breaks clients you cannot make redeploy. API versioning keeps the old behaviour, publishes the new one beside it, and lets something in the request say which the caller wants. Exhaust additive change first, since most releases need no version. Each live version is code you must keep correct.

## Explained
<!--meta block=explain-->

API versioning lets you change a published contract without breaking clients you cannot make redeploy: the old behaviour stays, the new one is published beside it, and something in the request, a path segment, a query parameter, a header or a media type, says which the caller wants. Try additive changes first, because a client that ignores unknown fields survives a new field with no version at all. Version only for breaking changes such as removing or renaming a field. Choose where the version goes by your callers. A public API with unknown clients and shared caches wants it in the URL path, where caches and logs already see it. An API whose callers you control can use a header and keep one address per resource, but it must send a Vary header, so caches key on it, or a cache serves a v1 body to a v2 caller.

- **Version count.** Each live version multiplies every fix, so keep one internal model and a translation layer per published contract.
- **Versions never retire.** Publish a sunset date with each version and alert on traffic still arriving after it.
- **Behaviour unversioned.** A version does not gate behaviour, so a changed operation changes every version; ship it behind a new version or opt-in flag.

**Example.** Version 1 returns a name field, and version 2 splits it into first and last. Your internal model stores first and last. The v1 translator joins them and the v2 translator passes them through, so a fix to name handling is made once. v1 has a sunset date of 1 March. That day 4% of 50,000 daily calls, 2,000, still arrive on v1 from 3 clients, so you contact those 3 instead of switching it off blind. The cost is one translator per live version, which you keep until the count of v1 calls reaches zero.

## How it works
<!--meta block=structure-->

```mermaid caption="How do two contracts coexist without two copies of the service? The version only picks a translator at the edge; the domain model behind it is written once, so a fix lands for every version at the same time."
flowchart LR
    C1["Old client"]:::ext
    C2["New client"]:::ext
    R{"Version selector"}
    subgraph Edge["Two published shapes, one meaning"]
        V1["v1 translator"]
        V2["v2 translator"]
    end
    D["Domain model<br/>written once"]
    C1 -->|"1 request states no version"| R
    C2 -->|"2 request asks for v2"| R
    R -->|"3 unstated falls back to the oldest"| V1
    R -->|"4 stated version wins"| V2
    V1 -->|"5 map the old shape onto the model"| D
    V2 -->|"6 map the new shape onto the model"| D
    classDef ext stroke-dasharray:4 4
```

~~~mermaid caption="Why does header versioning need `Vary`? The URI is identical across versions, so a cache keyed on it alone cannot tell the two responses apart — and the failure only appears when a shared proxy sits in the path."
sequenceDiagram
    participant C as Client
    participant P as Shared cache
    participant A as API
    C->>P: GET /customers/3, Accept-Version 1
    P->>A: miss, forward
    A-->>P: 200 flat address, no Vary header
    P-->>C: 200 flat address
    Note over P: the cache keys on the URI alone
    C->>P: GET /customers/3, Accept-Version 2
    P-->>C: 200 the v1 body, served from cache
    Note over C: a v2 client parses a v1 shape and fails
~~~

## Variations
<!--meta block=variations-->

- **Additive change, no version** — Ship the change as an addition — a new field, a new resource, a new optional parameter — and version nothing. Clients that ignore what they do not recognise keep working, and you carry no second contract at all. It covers most releases and is the only strategy with no ongoing cost, so exhaust it before reaching for anything below. It stops working the moment a change is breaking: removing or renaming a field, changing its type, tightening validation, changing a default, changing what an error means, or restructuring how resources relate. Whichever mechanism you then pick needs a defined answer for the caller that asks for nothing.
- **Path versioning** — A segment of the URI names the version — `/v2/customers/3`. It is unmissable in a log, in a support ticket and in a cache key, and routing it is a rule the front door already knows how to write. In exchange, the same customer now has two addresses, and every link the API generates has to carry the version too.
- **Query-string versioning** — The version rides as a parameter — `?api-version=2025-03-27` — with a documented default for callers that omit it. One resource keeps one path, which reads better and keeps generated links simpler than path versioning does. Caches key on the full URI, so this works unless a legacy proxy or CDN rule strips or ignores the query; measure the hit rate of a read-heavy public API before choosing it.
- **Header versioning** — A request header carries the version and the URI stays canonical, keeping versioning out of resource identity entirely and making an absent header trivial to default. The cost is visibility and caching: the version no longer appears in a URL anyone can paste, and the response must declare `Vary` on that header or a shared cache will mix the versions up.
- **Media-type versioning** — The caller negotiates with `Accept: application/vnd.example.v2+json` and the response confirms in `Content-Type`; an unsupported value answers `406 Not Acceptable`. This is HTTP's own mechanism for the same resource in a different representation, so it fits hypermedia links, which can name the media type of what they point at. It also asks the most of both sides, and callers using a generic HTTP client have to be told to set it.
- **Date-pinned versioning** — The caller pins a date rather than an integer, and the server applies every transformation introduced between that date and today. Each breaking change becomes one small, testable transformer instead of another fork of the service, which is what keeps a count of live versions from becoming a count of live codebases. It needs discipline: a transformer that is not exactly inverse to the change it describes rots quietly, and the chain grows longer every year.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Breaking changes on your schedule** — callers migrate when they choose, so a breaking change ships on your timetable, not theirs.
- **The contract becomes explicit**: a caller states what it was built against instead of hoping nothing moved.
- **Fix design mistakes** — a new version can correct design mistakes that additive change cannot reach, with no coordinated cut-over.
- **Deprecation by measurement** — per-version traffic, with the caller identity on each request, shows who is still on what, which turns deprecation from a negotiation into a measurement.

### Cons
<!--meta polarity=con-->

- **Every live version is code** to keep correct and to test, so a bug in shared behaviour is a bug you fix more than once.
- **Versions accumulate faster than anyone retires them**, and the oldest one always has exactly enough traffic to be awkward to kill.
- **Header and media-type versioning** need `Vary` to be right, and the failure when it is wrong is a cached body of the wrong shape.
- **Path and query versioning** give one resource several addresses, which complicates hypermedia links and any client cache keyed on identity.
- **Versioning the representation does not version behaviour**: change what an operation does underneath, and every version quietly changes with it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Callers you cannot redeploy** are built against the current shape.
- **The change you need removes**, renames, retypes or re-means something that already exists.
- **You need the old** and new behaviour running side by side long enough to migrate callers in waves.
- **A contractual or regulatory commitment** fixes how long a published interface must keep working.

### Avoid when
<!--meta polarity=avoid-->

- **The change is additive**, where publishing a second version costs you forever and buys nothing.
- **Every caller ships inside** one deployment you release together, where changing both sides at once is cheaper and safer.
- **The API is still being designed** and has no external callers, where versioning a draft freezes mistakes you should be deleting.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — date-pinned versioning as a chain of response transformers"
// One internal model. Each breaking change is a small transformer stamped with
// the date it shipped — so N versions cost N transformers, not N services.
type Change = {
  date: string; summary: string;     // the day the change shipped, and what changed
  downgrade: (body: any) => any;     // new shape -> the shape immediately before it
};

const CHANGES: Change[] = [
  {
    date: "2025-03-27", summary: "address split into street/city/state/zip",
    downgrade: (b) => ({ ...b,
      address: [b.address.street, b.address.city, b.address.state, b.address.zip].join(" ") }),
  },
  {
    date: "2025-09-01", summary: "state renamed to status",
    downgrade: (b) => { const { status, ...rest } = b.address; return { ...b, address: { ...rest, state: status } }; },
  },
].sort((a, b) => b.date.localeCompare(a.date));   // newest first

const OLDEST = "2025-01-01";   // what an unstated version means — decide once, publish it
function render(body: unknown, pinned: string = OLDEST) {
  // Walk backwards from today, undoing every change the caller never opted into.
  return CHANGES.filter((c) => c.date > pinned).reduce((b, c) => c.downgrade(b), body);
}

// Vary is not optional here: the URI is identical across versions, so without it
// a shared cache serves one caller's shape to another and the bug is unreproducible.
res.setHeader("Vary", "Accept-Version");
const pin = req.header("Accept-Version") ?? OLDEST;
if (!/^\d{4}-\d{2}-\d{2}$/.test(pin) || pin < OLDEST || pin > new Date().toISOString().slice(0, 10)) return res.status(406).end();   // a typo must not silently get the newest shape
res.json(render(customer, pin));
```

## In the wild
<!--meta block=wild-->

- **Kubernetes API** — The version is a path segment beside the API group — `/apis/apps/v1` — and carries a maturity level in its name (alpha, beta, stable) that tells callers what stability to expect. Objects are stored in one version and converted on the way out, which is the translation-layer approach made explicit. {#wild-kubernetes}
- **Stripe API** — Versions are dates rather than integers, pinned per account and overridable per request with the `Stripe-Version` header. Upgrading is a deliberate act by the caller, not a consequence of Stripe deploying. {#wild-stripe}
- **Azure Resource Manager** — Every request must carry `?api-version=` with a dated value; there is no default, so a caller can never drift onto a contract it did not ask for. {#wild-azure-resource-manager}
- **GitHub representational state transfer (REST) API** — A dated request header, `X-GitHub-Api-Version`, selects the contract, with the media type in `Accept` still selecting the representation — the two axes kept separate. {#wild-github}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Meaning of an omitted version** — What happens when the caller states nothing — the oldest supported contract, or a rejection. Defaulting is kinder to casual callers and quietly pins them to a version you want to retire.
- **Number of live versions** — How many contracts you are willing to keep correct at once. Every one is a row in the test matrix and a place the same bug has to be fixed again.
- **Cache variance** — Which request fields the response varies on. Header and media-type versioning need `Vary` naming that header, or shared caches mix the versions.
- **Deprecation window** — How long a version keeps working after its successor ships, published with the version rather than negotiated later. Size it from the slowest caller's release cycle and any contractual commitment, and send `Deprecation` and `Sunset` response headers so callers' tooling warns before the cut-off.
- **Translation-layer placement** — Whether version shims live at the edge or leak into the domain. Kept at the edge, the business logic exists once; let them inside and every version forks the code.

### Signals to watch
<!--meta polarity=signal-->

- **Request volume per version** — Traffic split across live versions. It is the only honest input to a retirement decision, and the fastest way to see whether a migration campaign moved anything.
- **Distinct callers on the oldest version** — How many identities, not requests, are still on the version you want to remove. One heavy caller is a conversation; two hundred is a project.
- **Unsupported-version rejection rate** — Requests answered `406` or an equivalent error. A spike usually means a client was upgraded against a version you never shipped.
- **Traffic past the sunset date** — Requests still arriving on a version whose published deadline has passed. Without this the deprecation is a document, not an event.

### Failure modes under load
<!--meta polarity=failure-->

- **Cached body of the wrong shape** — A shared cache keyed on the URI alone serves one version response to a caller that asked for another. It only reproduces when a proxy is in the path, so it survives every local test.
- **Version sprawl freezes the service** — Enough live versions accumulate that no change is safe anywhere, and every fix becomes a coordinated edit across contracts.
- **Behaviour drifts under a frozen shape** — The payload of an old version is unchanged while the meaning underneath it moves — a stricter validation, a different default. The contract looks honoured and the caller is broken.
- **Sunset arrives with live traffic** — The deadline passes and the version is removed while callers are still on it. Whether that is a controlled event or an outage depends entirely on whether anyone was measuring.
- **Transformer chain rot** — Under date-pinned versioning, a transformer that is not the exact inverse of its change quietly corrupts every request pinned before it, and the oldest pins are the least tested.

### Readiness checklist
<!--meta polarity=check-->

- What an omitted version means is decided and documented
- Additive changes ship without a new version, and what counts as breaking is written down
- Header or media-type versioning sends `Vary` on the field it varies by
- Each version has a published deprecation window and sunset date
- Per-version traffic and distinct callers are on a dashboard someone reads
- Version shims live at the edge; the domain model exists once
- A contract test runs the old version against the current build on every release

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [API Design](../../../themes/api-design.md) — Change the contract without a release from callers you do not control {#fluency-api-design}
- [Continuous Delivery](../../../themes/continuous-delivery.md) — Ship a breaking change without breaking clients {#fluency-continuous-delivery}
- [Microservices Design](../../../themes/microservices-design.md) — A dependent you cannot redeploy is why both versions run at once {#fluency-microservices-design}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [API Routing](./api-routing.md) — A path segment or a header is what routing dispatches on, so the version reaches the right handler
- [Anti-Corruption Layer](../../ddd/acl.md) — A translation layer per published version keeps the domain model single while the contracts differ
- [DTO](../../enterprise/dto.md) — The payload shape is what a version actually versions, so the transfer object is where a version lives
- [Hyrum's Law](../../../principles/hyrums-law.md) — A version policy has to count what callers actually depend on, not only what is documented
- [Contract Testing](../../testing/contract-testing.md) — Where consumers cannot be enumerated, versioning stands in for per-consumer verification, but a contract test still pins each live version
- [Postel's Law](../../../principles/postels-law.md) — Negotiating an explicit version replaces sniffing the shape, and lets you later stop accepting the old one.

**Prevents**

- [Distributed Monolith](../../../hazards/distributed-monolith.md) — Old and new contracts live side by side, so a service can release without waiting for its callers

<!-- relationships:end -->
