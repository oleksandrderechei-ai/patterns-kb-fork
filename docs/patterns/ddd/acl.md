---
title: Anti-Corruption Layer
description: Translates between two different domain models
area: ddd
owner: Oleksandr Derechei
tags: [integration, decoupling, transformation, boundaries]
status: stable
aliases: [ACL]
solves: [the vendor's cryptic status codes are leaking into my business logic everywhere, our shiny new service is slowly turning into a copy of the legacy system, the third party renamed a field and I had to touch forty files to fix it, I cannot test my own logic without standing up someone else's system first, I am stuck modeling my domain around a schema I did not design and cannot change]
---

# Anti-Corruption Layer

Sits at the boundary between your bounded context and an external system or legacy model, translating every call in both directions — so foreign concepts, names, and quirks never leak into your own domain model.

## What it is
<!--meta block=description-->

A new system that talks straight to a legacy system or vendor API slowly takes on its quirks, until your model is a copy of theirs. An anti-corruption layer sits between them and translates every call and response that crosses. A gateway makes the call and a translator maps their shapes and names onto your types, so your domain code only sees its own.

## Explained
<!--meta block=explain-->

An anti-corruption layer is a translator that sits between your code and a model you do not control, such as a legacy system or a vendor API, so your own types and names never carry theirs. Without it, their quirks arrive one call at a time: a status enum built from their error codes, a workflow bent to fit their state machine, until your model is a copy of theirs. Choose it over calling the other system directly when its concepts would otherwise set the shape of yours, and size it to the exposure: one call site needs only a small adapter, a multi-year migration needs a full layer.

- **Extra hop** The translation hop adds the far side's slow responses to your own; put a timeout and a circuit breaker on the gateway.
- **Two models** Holding two models in your head is a standing cost; keep the mapping a plain table rather than branching code.
- **Shared bottleneck** One layer shared by several contexts becomes a bottleneck; give each context its own translator.

**Example.** A legacy customer relationship management (CRM) system returns 12 account status codes, and billing needs three states: active, inactive, suspended. The layer holds one 12-row table mapping codes to states, so no other file in billing mentions a CRM code. When the CRM adds a 13th code, the translator rejects that record, raises one alert, and billing keeps running on the rest. Without the layer, the 12 codes would be tested at each of the 40 places billing reads a customer. The wrapped CRM call takes about 80 ms, so the gateway times out at 300 ms and serves the last cached customer for reads; writes fail rather than use stale data.

## How it works
<!--meta block=structure-->

```mermaid caption="The ACL absorbs translation in both directions, so your domain never sees the far system's shapes or names."
flowchart LR
    Y["Your domain model"] -->|calls in your terms| ACL["Anti-Corruption Layer"]
    ACL -->|translated call| X["External model, legacy or foreign"]
    X -->|foreign response| ACL
    ACL -->|your domain types| Y
```

## Variations
<!--meta block=variations-->

- **[Gateway](../enterprise/gateway.md)** — The wire-level concerns — auth, retries, serialization — stay in the gateway, so the translator behind it is a pure function over data you can test without the network.
- **[Strangler Fig](../distributed/coordination/strangler-fig.md)** — A temporary ACL raised in front of a legacy system during a strangler migration, torn down once the new implementation fully replaces it. Eric Evans defined the anti-corruption layer for this case: a new, carefully modeled context talking to an older system built under different concerns.
- **One-way vs. two-way translation** — Translate only inbound reads from the foreign system, or convert both directions — outbound calls into its terms and responses back into yours.
- **Per-context vs. shared integration layer** — One ACL per external system it talks to, or a single shared translation layer serving several contexts — sharing risks becoming its own leaky, overloaded abstraction.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Keeps your domain model pure** — while the mapping is complete and contract-tested, the ubiquitous language never absorbs a legacy or third-party vocabulary.
- **Confines the blast radius of change**: an upstream schema or API shift touches the ACL, not domain code, once contract tests catch the break.
- **Makes the integration an explicit**, testable seam you can mock or contract-test in isolation.
- **Lets a legacy system be migrated off**, or a new one migrated onto, gradually — without every consumer feeling the seam.

### Cons
<!--meta polarity=con-->

- **Extra code to maintain**, plus one in-process mapping on every call and a network hop when the gateway wraps a remote system.
- **Easy to under-build**: a thin or partial ACL still lets foreign concepts leak through in edge cases.
- **Two models to hold in your head** at once — yours, and the one you're being protected from.
- **A shared ACL serving many contexts** can calcify into its own bottleneck and leaky abstraction.
- **Just as easy to over-build**: the layer is the one place both models are visible, so decisions and call ordering drift into it until the translator owns behaviour that belongs in the domain.
- **Lossy, stale mapping**: Mappings lose detail (12 codes become 3 states) and need an owner; a cached fallback also serves stale reads.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You integrate with a legacy system**, external service, or another bounded context whose model doesn't match yours.
- **You don't control the other side's model** and refuse to let its concepts leak into your domain.
- **You're migrating off an old system gradually** and need new code shielded from its shape in the meantime.

### Avoid when
<!--meta polarity=avoid-->

- **Both sides already share the same model** and ubiquitous language — translation would be pure ceremony.
- **You control both systems** and can align their models directly instead of maintaining a permanent seam.
- **The integration is small and one-off** — a single [Adapter](../gof/structural/adapter.md) at the call site is enough.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — their shape and ours"
// External system's shape — not ours to change
interface LegacyCustomerRecord {
  cust_id: string;
  full_nm: string;
  acct_status: "A" | "I" | "S";
}

// Our own domain model, our own vocabulary
interface Customer {
  id: string;
  name: string;
  status: "active" | "inactive" | "suspended";
}

const STATUS: Record<LegacyCustomerRecord["acct_status"], Customer["status"]> = {
  A: "active", I: "inactive", S: "suspended",
};
```

```typescript summary="TypeScript — the layer that calls and translates"
class CustomerAcl {
  constructor(private readonly legacy: LegacyClient) {}
  async getCustomer(id: string): Promise<Customer> {
    const r = await this.legacy.fetchRecord(id);
    const status = STATUS[r.acct_status];
    if (!status) throw new Error(`unmapped acct_status: ${r.acct_status}`);
    return { id: r.cust_id, name: r.full_nm, status };
  }
}
```

## In the wild
<!--meta block=wild-->

- **Azure Architecture Center: Anti-corruption Layer pattern** — Microsoft documents the pattern as a facade or adapter layer between a modern application and a legacy subsystem, translating between the two models so the new design is not shaped by the old one. {#wild-azure-acl}
- **Eric Evans, Domain-Driven Design** — The 2003 book where the Anti-Corruption Layer is defined as one of the context-mapping patterns, a translation layer a downstream context builds to protect its model from an upstream one. {#wild-evans-ddd}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Upstream call timeout** — Time budget for the wrapped external call before the gateway gives up. Too generous and a slow upstream stalls your own request threads; too tight and healthy-but-slow responses fail.
- **Retry and failure policy** — How many times, and with what backoff, a transient upstream failure is retried, and what happens once retries are exhausted. Aggressive retries multiply load on an upstream that is already struggling.
- **Unmapped-value handling** — What the translator does with a code or field it has no mapping for: reject the crossing, substitute a documented default, or pass it through raw. This choice decides whether a new upstream value fails loudly or leaks silently.

### Signals to watch
<!--meta polarity=signal-->

- **Translation miss rate** — Fraction of crossings the translator cannot map because of unknown codes or missing fields. A rising rate is the earliest sign the upstream model has drifted.
- **Upstream call latency (p99)** — Tail latency of the wrapped external call, which is the cost the ACL wraps on every request across the boundary.
- **Upstream error and timeout rate** — Share of crossings that fail or time out at the gateway, distinct from translation misses, showing the health of the far side.

### Failure modes under load
<!--meta polarity=failure-->

- **Upstream adds an unmapped value** — The far system introduces a new status code or field the translator has never seen. Depending on the unmapped-value policy it either throws on every affected record or silently coerces to a default, corrupting downstream logic.
- **Upstream contract change** — A renamed or restructured field breaks the mapping. The ACL is the seam meant to absorb this, but only if contract tests catch it before production.
- **ACL becomes a latency bottleneck** — Per-call translation plus the synchronous upstream hop dominates response time under load, and a shared ACL serving several contexts turns into a single congestion point.

### Readiness checklist
<!--meta polarity=check-->

- Contract-test the translation against real upstream responses, including error and edge-case payloads, not just the happy path.
- Decide and document what happens on an unmapped value before shipping, rather than leaving it implicit.
- Put a timeout and a failure policy on the wrapped upstream call so its outages do not cascade into your domain.
- Version the translation so an upstream contract change is an explicit, reviewed edit in one place.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Service Boundaries](../../themes/service-boundaries.md) — Translate at the seam so a foreign model stays foreign {#fluency-service-boundaries}
- [Event Storming](../../themes/event-storming.md) — What to build where two contexts meet {#fluency-event-storming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Hexagonal](../architecture/hexagonal.md) — Adapters often carry an anti-corruption layer
- [Strangler Fig](../distributed/coordination/strangler-fig.md) — An anticorruption layer (ACL) shields new code from the legacy model
- [Message Translator](../messaging/message-translator.md) — Translation is the anticorruption layer (ACL)'s core job
- [Bounded Context](./bounded-context.md) — An anticorruption layer (ACL) guards a context's boundary
- [Adapter](../gof/structural/adapter.md) — Adapters implement the translation
- [Postel's Law](../../principles/postels-law.md) — Contains liberal acceptance in a single translating boundary
- [API Versioning](../distributed/routing/api-versioning.md) — Versioning an application programming interface (API) is the same translation problem pointed outward: the old contract is the foreign model
- [Design for Evolution](../../principles/design-for-evolution.md) — The layer stops an external change from becoming an internal one
- [Context Map](./context-map.md) — The context map shows which borders need an anticorruption layer
- [Canonical Data Model](../messaging/canonical-data-model.md) — An anticorruption layer (ACL) can translate a legacy model into the canonical one

**Composed of**

- [Gateway](../enterprise/gateway.md) — An anti-corruption layer is built from gateways and translators

**Prevents**

- [Distributed Monolith](../../hazards/distributed-monolith.md) — Without translation, two contexts share a model and have to be redeployed in step.

**Demonstrated by**

- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — each vendor gets a translator that parses its payload and maps it onto our own three-valued outcome — and stamps provider and policy version onto the transition, so the history can answer how a person was verified
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — a translator that runs ahead of BEGIN on purpose, because a parse failure inside the transaction rolls back the record that the callback was ever seen

<!-- relationships:end -->
