---
title: Canonical Data Model
description: One shared message format that every application translates to and from
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling, transformation]
status: stable
aliases: [common data model, canonical schema]
solves: [Every pair of systems has its own format translator and adding one more system means writing a dozen more, One system renames a field and translators in five other places break, Each team calls the same order or customer something different and we cannot agree on a shared shape, Replacing one application means rewriting every integration that talks to it]
---

# Canonical Data Model

Defines one shared message format for every application in an integration, so each application translates only to and from that format and never to each other.

## What it is
<!--meta block=description-->

Applications that exchange data each use their own format, and translating between every pair needs up to N × (N − 1) translators for N applications. A new application adds 2N more. A **canonical data model** is one shared format for messages between applications. Each application translates only to and from it, so you write 2N translators and a new application adds two. The price is a shared model that every team has to agree on and keep stable.

## Explained
<!--meta block=explain-->

A canonical data model is one agreed message format that every application in an integration speaks. Each application keeps its own internal format and translates at its edge, to and from the shared one, with a [message translator](./message-translator.md). Choose it over pairwise translation when many systems exchange the same business concepts, such as customer and order, and systems come and go. Choose direct translation for two or three systems, where agreeing on a model costs more than it saves. Without it, one field change in one system ripples into every translator that touches it, and nobody keeps a current list of which ones those are.

- **The model needs an owner.** Every change is a negotiation; name one owning group and publish a versioning policy.
- **Lowest common denominator.** It can drop what one system needs; keep it to shared concepts and allow named extension fields.
- **Two translations per message.** Each message is translated in and out; skip the model where only two systems talk.

**Example.** A retailer has 6 systems: web shop, ERP, warehouse, CRM, billing and shipping. Pairwise translation needs up to 6 × 5 = 30 translators, and a 7th system adds 12 more. With one canonical Order, it needs 6 × 2 = 12 translators, and a 7th system adds 2. When the warehouse changes its order format, 2 translators change instead of up to 10. The cost: the shop needs a gift note the model lacks. Adding it as an optional field needs all six teams to agree, which is a meeting, not a sprint.

## How it works
<!--meta block=structure-->

```mermaid caption="Who has to know whose format? Nobody knows another system's format. At steps 1 and 3 each application talks to its own translator only, and the channel between applications carries one shared shape, so a new application adds one more pair of translators at its edge and touches no other system."
flowchart LR
    A["Web shop"]:::ext
    TA["Translator: shop to canonical"]
    Bus[("Canonical Order message")]
    TB["Translator: canonical to warehouse"]
    B["Warehouse system"]:::ext
    C["Billing system"]:::ext
    TC["Translator: canonical to billing"]
    A -->|"1 shop's own order format"| TA
    TA -->|"2 canonical order"| Bus
    Bus -->|"3 canonical order"| TB
    TB -->|"4 warehouse's own format"| B
    Bus -->|"5 canonical order"| TC
    TC -->|"6 billing's own format"| C
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="How does the model change without breaking anyone? Add an optional field. Producers start sending it at step 1, and consumers that do not know it ignore it at step 2, so each side upgrades on its own schedule."
sequenceDiagram
    autonumber
    participant P as Producer, model v2
    participant Bus as Canonical channel
    participant O as Consumer, still on v1
    participant N as Consumer, upgraded to v2
    P->>Bus: Order with new optional field giftNote
    Bus->>O: Order, giftNote ignored
    Bus->>N: Order, giftNote used
```

The model describes business concepts that several systems share, such as Customer, Order and Invoice. It leaves out what only one system cares about. Each application keeps its own internal format and database, and the translators sit at the edge, so the model governs messages and does not reach into storage.

A model is a contract, and it needs the rules of a contract: one owner, a versioning policy, and a rule for what may change without breaking readers. Adding an optional field is safe, and removing or renaming a field breaks every consumer that reads it. Consumers and the shared schema must accept fields they do not know; if a strict check rejects unknown fields, adding an optional field is a breaking change.

## Variations
<!--meta block=variations-->

- **Enterprise-wide model** — One model for every concept in the company. It gives the cleanest picture and is the hardest to finish or agree, because every team has a say in every entity.
- **Per-domain model** — One model per related group of systems, such as ordering or billing, in the spirit of a [bounded context](../ddd/bounded-context.md). The agreement stays small enough to reach, and the translation between domains is still needed at the seams.
- **Standards-based model** — Adopt an industry standard as the canonical format, such as ISO 20022 for payments or FHIR for health records. It gives the agreement for free and brings the standard's size and pace of change with it.
- **Edge translation** — Each application, or a thin adapter beside it, translates at its own boundary. Nothing central needs to scale, and every team owns its translators.
- **Hub translation** — A central integration hub runs all the translators. Changes are in one place and the hub becomes a component every flow depends on and every team queues behind.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Translators grow as 2N, not N × (N − 1)** — six applications need 12 translators, not up to 30, because 30 counts every pair talking in both directions.
- **A new application adds two translators** — one to the model and one from it, with no change to the others when its data fits the model. A concept the model lacks needs a model change.
- **A change stays local** — when one application changes its format, only its own two translators change and no other application notices. A change to the model itself still reaches every consumer.
- **The business vocabulary is written down once** — each field has one documented meaning on the channel, whatever each system calls it inside. Writing it down does not stop systems filling it differently.
- **Messages can be checked in one place** — one schema validates every message on the channel.

### Cons
<!--meta polarity=con-->

- **The model needs one owner and a change process.** Every change is a negotiation, so name an owning group and publish a versioning policy.
- **It drifts to the lowest common denominator** or grows to hold everything. Keep it to shared concepts and allow named extension fields.
- **Every message is translated twice**, once in and once out, which adds latency and CPU. Skip the model where only two systems talk.
- **A breaking change hits every consumer** at once. Add fields as optional, and run the old and new versions side by side for a stated period.
- **Designing it up front is slow**, and a model made without real flows is usually wrong. Start with the two or three concepts that already move between systems.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Many systems exchange the same business concepts**, and each pair currently has its own translation.
- **Systems are added or replaced often**, and each change should cost two translators and not a round of changes everywhere.
- **No one system is the natural owner of the format**, so a neutral shared one is the fair choice.

### Avoid when
<!--meta polarity=avoid-->

- **Only two or three systems talk**, so direct translation costs less than agreeing and owning a model.
- **The concepts are not truly shared**, and the model would hold the union of every system's fields.
- **You cannot name an owner** for the model, so it would drift and nobody could rule on a change.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — one canonical Order, with a translator in for the shop and out for the warehouse"
// The canonical shape: only what several systems share.
interface CanonicalOrder {
  orderId: string;
  customerId: string;
  lines: { sku: string; quantity: number }[];
  placedAt: string;                // ISO 8601 timestamp
  extensions?: Record<string, unknown>; // named extras, ignored by readers that do not know them
}

// Shop to canonical: the shop's names stay inside this function.
function fromShop(o: { id: number; cust: string; items: { code: string; qty: number }[]; ts: number }): CanonicalOrder {
  return {
    orderId: String(o.id),
    customerId: o.cust,
    lines: o.items.map(i => ({ sku: i.code, quantity: i.qty })),
    placedAt: new Date(o.ts).toISOString(),
  };
}

// Canonical to warehouse: the warehouse's names stay inside this one.
function toWarehouse(o: CanonicalOrder) {
  return { ref: o.orderId, pick: o.lines.map(l => ({ article: l.sku, count: l.quantity })) };
}
```

## In the wild
<!--meta block=wild-->

- **ISO 20022** — An international standard for financial messages, with a shared business model of payments and securities that banks translate to and from at their edges. {#wild-iso-20022}
- **HL7 FHIR** — A standard set of resources, such as Patient and Observation, that health systems use as a shared format when exchanging records. {#wild-hl7-fhir}
- **Microsoft Common Data Model** — A published set of standard business entities, such as Account and Contact, that apps and data services share so they need not map to each other pairwise. {#wild-microsoft-cdm}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Compatibility policy** — Which changes are allowed without a new version, such as adding an optional field. It decides whether consumers can upgrade on their own schedule.
- **Version retention window** — How long an old version stays supported once a new one ships. Too short breaks slow teams; too long multiplies translators.
- **Extension field rules** — How a system may add its own named fields. Loose rules turn the extension area into a second model.
- **Where translation runs** — At each application edge or in a central hub. Edge spreads ownership; a hub concentrates load and change.

### Signals to watch
<!--meta polarity=signal-->

- **Translation failure rate per application** — Messages a translator could not convert. A rise after a release points at the application that changed.
- **Schema validation rejects** — Messages that fail the canonical schema. It shows producers that drift from the contract.
- **Share of traffic per model version** — How many messages still use each old version, tagged by model version and sending application. Retire a version when its share stays at zero for longer than the slowest sender's release cycle; the tags name who still sends it.
- **Translation latency** — Time spent in translators per message, which adds to every flow.
- **Reconciliation mismatches** — Sampled counts or totals compared between source and consumer for the same entity. A gap with no schema validation rejects points to meaning drift.

### Failure modes under load
<!--meta polarity=failure-->

- **Breaking change** — A renamed or removed field fails every consumer that read it, at once.
- **Meaning drift** — Two systems fill the same field with different meanings, so messages pass validation and still give wrong results.
- **Hub bottleneck** — A central translator becomes the slowest part of every flow and every change waits on its team.
- **Extension sprawl** — Systems add private fields until the real model lives in the extensions.

### Readiness checklist
<!--meta polarity=check-->

- The model has a named owner and a change process
- Each field has a written meaning, a unit and an owner
- Versioning rules say which changes need a new version
- Translators sit at the edge, with tests that use real sample messages
- The model covers only concepts shared by at least two systems

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Translate every application to one shared format instead of to each other. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Message Translator](./message-translator.md) — Each application needs only one translator, to and from the shared format
- [Anti-Corruption Layer](../ddd/acl.md) — One shared model reduces the translation each context needs at its border
- [Message Encoding](./message-encoding.md) — Fixes the meaning of the fields every application agrees on

**Alternative to**

- [Bounded Context](../ddd/bounded-context.md) — Imposes one model on every application, at the cost of agreement between teams

<!-- relationships:end -->
