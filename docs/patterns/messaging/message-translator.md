---
title: Message Translator
description: Converts a message between two different formats
area: messaging
owner: Oleksandr Derechei
tags: [messaging, transformation, decoupling]
status: stable
solves: [the legacy system sends snake_case fields and my service expects camelCase, one side sends money as integer cents and the other wants decimal dollars, every consumer has its own copy of the code that reshapes the vendor payload, the partner renamed a field and three of my services broke at once, I cannot change the format the third-party system emits but nothing here can read it]
---

# Message Translator

Converts a message's fields, encoding, and structure from the format one endpoint produces into the format another expects, so producer and consumer never have to agree on a shared schema.

## What it is
<!--meta block=description-->

A message translator sits on the channel between a producer and a consumer and rewrites each message from the shape one side sends into the shape the other expects: field names, types, units and encoding. Neither system changes, so each evolves on its own schedule. It does no business logic and reshapes no interface; it only reshapes data in flight.

## Explained
<!--meta block=explain-->

A message translator sits on the channel between a producer and a consumer and rewrites each message from the shape one side sends into the shape the other expects: field names, types, units and encoding, such as XML to JSON. Neither system changes, so each keeps evolving on its own schedule. Choose it when two schemas must move independently and neither team will change for the other. Skip it when the two already agree, because a hop that maps a field onto itself is pure cost.

- **Silent errors.** A dropped field, cut precision or misread date passes through looking valid. Validate output against the consumer schema and test with boundary values.
- **Schema drift.** Every schema change on either side means a mapping change, so version the mappings with the schemas.
- **Pairwise growth.** One translator per pair of systems grows as N(N-1), roughly N squared. Translate everything to one canonical format and you need about 2N.

**Example.** A partner sends dates as 03/04/2026, meaning 3 April, day first. A translator written for month first outputs 2026-03-04. That is a valid date, so every schema check passes, and parcels are booked a month early. 11 of the first 12 days of each month are silently wrong, about 35% of a 31-day month, and the error runs from one to eleven months. Days 13 to 31 fail loudly, because there is no month 13. A test using 13/04/2026 catches the bug at once, and a test using 03/04/2026 alone never would. With 6 systems, pairwise translators number 30, against 12 with a canonical shape.

## How it works
<!--meta block=structure-->

```mermaid caption="Who has to know both schemas? Only what sits inside the boundary — the partner keeps its snake_case cents and billing keeps its decimals (1–3), and the mapping is the single artefact that changes when either side moves. Step 4 is what makes the conversion trustworthy: validating the output, not just parsing it, sends a dropped field or a truncated amount to step 5 instead of letting it arrive quietly wrong."
flowchart LR
    P["Partner: cust_name, amt_cents"]
    subgraph Both["The only place that knows both schemas"]
        M[("Mapping, versioned")]
        MT["Message translator"]
    end
    V{"Check against consumer schema"}
    C["Billing: customerName, decimal"]
    DL[("Dead-letter channel")]:::ext
    P -->|"1 order in the sender's shape"| MT
    M -->|"2 field names, units, encoding"| MT
    MT -->|"3 rewritten to the receiver's shape"| V
    V -->|"4 valid, deliver"| C
    V -->|"5 field lost or unmappable"| DL
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Canonical Data Model** — Translate every format to and from one shared canonical schema instead of pairwise. N systems then need about 2N translators (one each way), not N(N-1).
- **Envelope Wrapper** — Wraps or unwraps transport-specific headers and routing metadata around an unchanged payload, translating only the envelope.
- **Normalizer** — Routes several differently-shaped but semantically equivalent inputs each through its own translator, so all emerge in one common shape.
- **Declarative / schema-driven mapping** — Expresses the mapping as data (XSLT, JSONata, a field-mapping config) instead of code, so a schema change can ship as a config update if the translator reloads mappings at runtime. The mapping still needs the same tests and version pinning as code.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Decouples producer and consumer schemas** — either can evolve without breaking the other, as long as the mapping is updated and tested for each change.
- **Confines format-conversion logic to one place instead** of scattering it across every consumer.
- **Integrating a legacy or third-party format becomes additive** — one new translator, not a system-wide schema change.
- **Testable in isolation**: feed it a sample message, assert the output shape.

### Cons
<!--meta polarity=con-->

- **Adds a hop and a processing cost** on every message, more so for large payloads or heavy conversions like XML to JSON.
- **Lossy conversions** — dropped fields, truncated precision, timezone drift — can fail silently unless validated.
- **Another moving part to version**: a schema change on either side means updating the mapping too.
- **Adding translators pairwise between many** systems grows as N(N-1), roughly N², unless a canonical model cuts it to about 2N.
- **Unmappable messages** — A message that fails mapping needs a dead-letter path that keeps its original payload, or it blocks the queue or is lost.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Two systems that must exchange messages disagree** on schema, encoding, field names, or units.
- **You integrate a legacy or third-party system** whose message shape you can't change.
- **You want producer and consumer** to evolve their own schemas independently.

### Avoid when
<!--meta polarity=avoid-->

- **Both sides already share the same schema** — there's nothing left to translate.
- **The mismatch is in a synchronous call's interface**, not a message on a channel — that's [Adapter](../gof/structural/adapter.md)'s job.
- **You need broader model protection** at a bounded-context boundary, not just field mapping — reach for a full [Anti-Corruption Layer](../ddd/acl.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — translating a legacy order into the canonical shape"
// What the legacy system produces
interface LegacyOrder { ord_id: string; cust_name: string; amt_cents: number; ccy: string }

// What the rest of the system expects
interface CanonicalOrder {
  orderId: string;
  customer: { name: string };
  total: { amount: number; currency: string };
}

class OrderTranslator {
  translate(msg: LegacyOrder): CanonicalOrder {
    return {
      orderId: msg.ord_id,
      customer: { name: msg.cust_name },
      total: {
        // float division can lose precision for money; keep minor units as an integer or decimal string when the consumer allows
        amount: msg.amt_cents / 100,
        currency: msg.ccy.toUpperCase(), // check against a known currency list, not just uppercase
      },
    };
  }
}

// Sits on the channel between producer and consumer
function onLegacyOrder(raw: LegacyOrder, publish: (o: CanonicalOrder) => void) {
  const out = new OrderTranslator().translate(raw);
  // validate the output, not just the parse (structure step 4 to 5)
  if (!validAgainstConsumerSchema(out)) throw new Error("reject: send to dead-letter channel");
  publish(out);
}
```

## In the wild
<!--meta block=wild-->

- **XSLT** — A W3C language dedicated to declaring a transform from one XML shape to another: xsl:template rules match nodes by XPath, and XSLT 3.0 adds streaming for documents too large to hold in memory. The mapping stays data, editable without recompiling. {#wild-xslt}
- **Spring Integration Transformer** — A Transformer endpoint sits on a channel and converts each payload; built-in transformers cover object-to-JSON and XML marshalling, or a SpEL expression defines the mapping inline. {#wild-spring-integration-transformer}
- **MuleSoft DataWeave** — A functional mapping language used in the Mule Transform Message component; one script converts between JSON, XML, CSV and flat-file payloads, with input and output formats declared in the script header. {#wild-dataweave}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Strict vs. lenient validation** — Whether the translator rejects a message with unknown or missing fields, or passes it through best-effort.
- **Streaming vs. in-memory parsing threshold** — Payload size above which the document is streamed rather than loaded whole, bounding memory on heavy conversions like XML to JSON.
- **Mapping / schema version** — Which mapping revision is applied, so a schema change on either side can be pinned and rolled forward deliberately.

### Signals to watch
<!--meta polarity=signal-->

- **Translation error / rejection rate** — Messages that fail to parse or map; a step change flags schema drift on the producer or consumer.
- **Translation latency (p99)** — Time to convert per message, which climbs with payload size and conversion weight.
- **Output validation failures** — Converted messages that fail the consumer schema check — the guard against silent lossy conversions.

### Failure modes under load
<!--meta polarity=failure-->

- **Silent lossy conversion** — Dropped fields, truncated precision, or timezone drift pass through unnoticed unless the output is validated, not just parsed.
- **Schema drift** — A field the mapping expects disappears or changes type on one side, producing malformed output or a mapping error.
- **Large-payload memory blowup** — A conversion that loads the whole document into memory can exhaust the translator on an oversized message.

### Readiness checklist
<!--meta polarity=check-->

- Output is validated against the consumer schema, not just parsed
- The mapping is tested with edge cases: missing fields, boundary values, unit extremes
- Schema changes on either side have a versioned-mapping path
- Oversized or malformed payloads have a bounded handling path — a size limit or reject to a dead-letter channel

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Convert a message from one side's format to the other's on the channel. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Anti-Corruption Layer](../ddd/acl.md) — The anticorruption layer (ACL) translates between models
- [Content-Based Router](./content-based-router.md) — A normalizer routes each incoming shape to its own translator
- [Postel's Law](../../principles/postels-law.md) — Turns tolerated input variety into one internal format
- [Message Encoding](./message-encoding.md) — A translator converts between formats; the compatibility rules decide when a translation is needed at all
- [Canonical Data Model](./canonical-data-model.md) — A translator converts an application's own format to and from the canonical one
- [Dead Letter Channel](./dead-letter-channel.md) — A message the mapping cannot convert is moved aside, not retried.
- [Design for Evolution](../../principles/design-for-evolution.md) — The translator is how a consumer takes a neighbour's schema change without touching its own code

**Often confused with**

- [Adapter](../gof/structural/adapter.md) — Reshape a message vs. convert an interface
- [Messaging Bridge](./messaging-bridge.md) — Reshapes the message; a bridge only moves it between infrastructures
- [Content Enricher](./content-enricher.md) — Changes the format of what the message already carries, and adds nothing

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that converts a message between formats as a ready-made building block.

<!-- relationships:end -->
