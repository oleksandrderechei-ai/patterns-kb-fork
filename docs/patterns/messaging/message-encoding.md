---
title: Message Encoding
description: "Agree how a message is written down, and how that shape is allowed to change"
area: messaging
owner: Oleksandr Derechei
tags: [messaging, transformation]
status: stable
aliases: [serialization format, wire format, schema registry, schema evolution]
solves: [renaming a field in the producer silently broke three consumers, every consumer stops as soon as one message it cannot parse reaches the partition, we cannot deploy the producer and the consumers separately without a coordination meeting, the payloads are mostly repeated field names and the broker bill reflects it, nobody knows which version of the message shape is on the queue right now]
---

# Message Encoding

Fixes the wire contract between a producer and consumers it never meets: the format the payload is written in, the schema that says what the fields mean, and the compatibility rules that decide which changes are safe to deploy. Get the rules right and either side can be released alone; get them wrong and every schema change is a coordinated outage.

## What it is
<!--meta block=description-->

**Message encoding** is the agreement on how a message is written as bytes: the format, the schema that names each field, and the rules for changing that schema. Producer and consumer deploy separately, so this agreement is all they share. It is separate from the transport, which moves bytes without caring what they mean. The compatibility rule decides which schema changes may ship, and the message carries its schema identity so a consumer knows how to read it.

## Explained
<!--meta block=explain-->

Message encoding is the agreed way to write a message as bytes: the format, the schema that names each field and its type, and the rules for changing that schema. Producer and consumer are deployed apart, so this agreement is all they share, and a registry (a service that stores schemas and refuses incompatible changes) holds it. Choose a text format such as JSON for low-volume events that people read in a terminal. Choose a schema-first binary format when volume makes payload size and decode time show up in the bill: Protobuf identifies fields by number, Avro matches them by name against the schema the message was written with.

- **Unreadable bytes.** A binary message needs its schema, so build the tool that fetches it and prints the message before the first incident.
- **Change rules.** Add fields with a default, remove only optional ones, never reuse a field number; a registry check in CI rejects bad changes.
- **Registry dependency.** A cache protects running consumers only; a cold start needs the registry up, so pre-warm or persist the cache.

**Example.** Suppose an order-placed event is 300 bytes as JSON, because every copy repeats the field names, and 120 bytes in binary (illustrative; real ratios vary with the schema). At 5,000 events a second that is 1.5 MB a second against 0.6 MB, or about 130 GB a day against 52 GB. The cost shows at 3 a.m., when a binary message in the dead-letter queue is unreadable bytes. Its header carries a schema id, and only a tool that asks the registry for that schema can turn the bytes into fields, so that tool has to exist before the incident.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a consumer read a message written by a producer it never met? The envelope carries the schema id, so the consumer resolves the exact definition the message was written with, and the registry has already refused any change that would have made it unreadable."
flowchart LR
    P["Producer"]
    subgraph Contract["One definition, checked before it ships"]
        R[("Schema registry")]
    end
    Q[("Topic")]
    C["Consumer"]
    P -->|"1 register the schema, build fails if incompatible"| R
    R -->|"2 schema id"| P
    P -->|"3 publish: envelope with the id, plus encoded payload"| Q
    Q -->|"4 deliver"| C
    C -->|"5 fetch the writer schema by id, cached"| R
    R -->|"6 read using writer and reader schemas together"| C
```

```mermaid caption="Why is a reused tag number different from an added field? An added optional field is invisible to an old reader, while a reused tag number changes what an existing position means. If the wire types differ, decoding fails; if they match, the old reader silently reads the wrong field. The partition stops only when a failed decode is retried in place instead of dead-lettered."
sequenceDiagram
    participant P as Producer v2
    participant Q as Topic
    participant C as Consumer v1
    P->>Q: message with a new optional field, default supplied
    Q->>C: deliver
    C-->>C: unknown field ignored, decode succeeds
    Note over P,C: forward compatible — old reader, new message
    P->>Q: field renamed, tag number reused
    Q->>C: deliver
    C--xC: wrong type at that tag, decode fails
    Note over C: every message on the partition now fails the same way
```

## Variations
<!--meta block=variations-->

- **Self-describing text encoding** — Each message carries its own field names, so anything can read it without a schema in hand and a human can inspect it with a terminal. That makes it the right default for low-volume integration events, where debuggability beats bytes. You pay for it on every message — the names are repeated in every copy, parsing is slower, and with no schema anywhere the contract lives only in whatever documentation people remember to update.
- **Schema-first binary encoding** — Protobuf identifies fields by number, so payloads are smaller and decode faster than text (the explain example assumes 2.5 times smaller; measure your own schema), and both sides generate code from one definition. Avro has no field numbers and matches fields by name against the writer's schema, so a rename needs an alias. The definition must reach every consumer, a message is opaque without it, and in Protobuf the tag number is permanent identity: retire a field and its number is retired with it.
- **Registry-resolved schema** — The message carries a small schema id and the consumer resolves the full definition from a registry, caching it. Payloads stay compact while every message remains exactly readable, and the registry can refuse an incompatible change before it is ever published. Its compatibility mode decides who upgrades first: with backward, consumers; with forward, producers; full allows either order. A running consumer's cache survives an outage, but a cold consumer needs the registry up, so the registry must be highly available.
- **Envelope and payload separated** — Identity, correlation id, timestamp, content type and schema version live in headers, distinct from the encoded body. A router, a filter or a [dead-letter](./dead-letter-channel.md) handler can then act on a message without deserialising a body it may not be able to read. It is two things to keep consistent, and metadata put in the envelope that belongs in the payload tends to end up duplicated in both.
- **Reference instead of payload** — When the content is genuinely large, the message encodes a pointer to it and the bytes go to object storage — the [claim check](./claim-check.md). The broker keeps carrying small messages, so throughput and retention stay predictable no matter how big the content gets. The reference has a lifetime, and a consumer that reads it after the object expires fails in a way no schema check will catch.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Producers and consumers can be released independently**, because the compatibility rule says in advance which changes are safe.
- **The contract stops living in documentation** and becomes a definition both sides compile against.
- **A registry whose compatibility check runs in CI catches an incompatible change** at build time, turning a poison message (one no consumer can decode) into a failed pipeline; without that check it fails at first publish.
- **A binary format cuts payload size** and decode cost, which shows up directly in broker storage, egress and consumer CPU.
- **Metadata in the envelope** lets routing, filtering and dead-lettering work without deserialising the body.

### Cons
<!--meta polarity=con-->

- **A binary payload cannot be read** without its schema, so inspecting a message during an incident needs tooling you must have already built.
- **The schema becomes a shared artifact** with its own repository, release process and ownership question.
- **Renaming is unsafe** wherever readers match fields by name (JSON, Avro without aliases, JSON-mapped Protobuf, generated code), so early naming mistakes tend to stay.
- **A registry on the critical path** is another dependency a cold consumer needs before it can read anything.
- **Retired tag numbers stay retired** forever, and reusing one produces a decode failure that looks like data corruption.
- **Compatibility rules bound what the schema can express**, so the model drifts toward what is safe to change rather than what is accurate.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Producer and consumer are deployed** separately, by different people, on different schedules.
- **A queue or log holds messages long enough** that a consumer will read something written before its own release.
- **Volume is high enough that payload size** and decode cost are visible in the bill or the latency.
- **Consumers are written in several languages** and need generated types rather than hand-written parsers.

### Avoid when
<!--meta polarity=avoid-->

- **Both sides ship in one deployment**, where a shared type already is the contract.
- **The volume is tiny** and the shape is stable, where a registry costs more to run than the drift it prevents.
- **The schema is still changing** shape daily, where freezing compatibility rules over a draft blocks the exploration.

## Code sketch
<!--meta block=sketch-->

```protobuf summary="Schema evolution — which changes are safe, and why the tag number is the identity"
// v1 — the shape both sides were built against.
message OrderPlaced {
  string order_id = 1;
  string sku      = 2;
  int32  quantity = 3;
}

// v2 — SAFE. A new field at a new number: an old consumer never looks at tag 4
// and ignores it; a new consumer reading a v1 message gets the default.
message OrderPlaced {
  string order_id = 1;
  string sku      = 2;
  int32  quantity = 3;
  string currency = 4;          // added, optional, defaults cleanly
  reserved 9;                   // retired earlier — the NUMBER can never return
  reserved "discount_code";     // and neither can the name
}

// v3 — UNSAFE, and it compiles. `sku` was renamed and its number handed to a new
// field of a different type. An old consumer still reads tag 2 as a string and
// gets bytes that are not one, so the decode fails or silently misreads, for
// every message written with v3 (behaviour varies by parser and wire type).
message OrderPlaced {
  string order_id     = 1;
  int64  product_ref  = 2;      // WRONG: tag 2 already means "sku", as a string
  int32  quantity     = 3;
}

```

```typescript summary="TypeScript — publish with the schema id in the envelope, and refuse to guess on read"
// Register on the way out. An incompatible schema is rejected HERE, in CI if
// registration runs there, otherwise at first publish — which is the whole point.
// Catching it in review does not scale.
const schemaId = await registry.register("order-placed-value", ORDER_PLACED_SCHEMA, {
  compatibility: "FULL",   // old consumer reads new message AND new reads old
});

await producer.send({
  topic: "orders",
  // The envelope is readable without decoding the body, so a router or a
  // dead-letter handler can act on a message it cannot itself parse.
  headers: { "schema-id": String(schemaId), "content-type": "application/x-protobuf",
             "correlation-id": correlationId },
  value: encode(ORDER_PLACED_SCHEMA, event),
});

// On the way in, resolve the schema the message was WRITTEN with — never assume
// it matches the one this service was compiled against.
async function handle(msg: Message) {
  const id = msg.headers["schema-id"];
  if (!id) throw new PoisonMessage("no schema id");   // dead-letter, do not guess

  const writerSchema = await registry.get(Number(id));   // cache this call by schema id (production knob 3), or an outage stops every cold start
  const event = decode(writerSchema, READER_SCHEMA, msg.value);
  await process(event);
}

```

## In the wild
<!--meta block=wild-->

- **Protocol Buffers** — Fields are identified by tag number, not by name, so payloads are compact and the number is the identity — the language provides `reserved` precisely so a retired tag or name can never be reused by accident. {#wild-protobuf}
- **Apache Avro** — A message is decoded with both the schema it was written with and the schema the reader expects, and the resolution rules between them are part of the specification. That is why it is the common choice for long-lived event logs where old messages must stay readable. {#wild-avro}
- **Schema registries** — Confluent Schema Registry and comparable services store schemas by subject, hand out an id the message carries, and enforce a configured compatibility mode — so an incompatible schema is rejected at registration rather than discovered by a stalled consumer. {#wild-schema-registry}
- **CloudEvents** — A Cloud Native Computing Foundation (CNCF) specification for the envelope rather than the payload: it standardises the metadata around an event — id, source, type, time, datacontenttype — so routing and dead-lettering work without decoding the body. {#wild-cloudevents}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Compatibility mode** — Backward (new readers read old messages), forward (old readers read new ones) or full (both). Full checks only the adjacent version, so where the queue retains messages across several releases use the transitive form, which checks every earlier version. Independent deploys plus a queue that retains messages means full or full-transitive; anything weaker is a rule that will be broken by a deployment order nobody controls.
- **Format choice per topic** — Text or binary, decided per traffic class rather than once for the estate. High-volume streams pay for readability on every message; low-volume integration events pay for tooling on every incident.
- **Schema cache lifetime in the consumer** — How long a resolved schema is kept locally. Schema ids never change, so cache without expiry and warm the cache at startup; that decides whether a registry outage stops new consumers only, or everything.
- **Envelope contents** — Which fields live in headers rather than the body — schema id, content type, correlation id, timestamp. Anything a router or a dead-letter handler needs must be readable without decoding the payload.
- **Maximum message size** — The point past which a payload becomes a reference instead. Set it below the broker limit, so the switch is a design decision rather than a rejected publish.

### Signals to watch
<!--meta polarity=signal-->

- **Deserialisation failure rate** — Messages that could not be decoded. It is normally exactly zero, so any non-zero value is a schema incident rather than noise.
- **Dead-letter arrivals by schema id** — Which schema version the undecodable messages were written with. It names the offending deploy immediately.
- **Average payload size by topic** — Bytes per message over time. A step change usually means a field carrying something that should have been a reference.
- **Registry lookup latency and error rate** — How the schema resolution path is behaving. A cold consumer cannot start without it, so it belongs on the same dashboard as the broker.
- **Count of live schema versions per subject** — How many definitions are actually in flight. It bounds what a consumer must be able to read.

### Failure modes under load
<!--meta polarity=failure-->

- **Poison message stops a partition** — One undecodable message at the head of an ordered partition blocks every message behind it. Throughput on that partition goes to zero while the rest of the topic looks healthy. Detect it as per-partition lag that rises while the decode failure rate is non-zero (signal 1); respond by dead-lettering after a few failed decodes (check 5).
- **Incompatible schema deployed** — A rename or a reused tag number ships, and every consumer on the old definition fails at once. Rolling the producer back does not help the messages already written. Recover by deploying a reader that handles the bad version, or by replaying or dead-lettering the affected range; find the range from dead-letter arrivals by schema id (signal 2).
- **Registry unavailable to a cold consumer** — A consumer restarts with an empty cache and cannot resolve any schema, so it cannot read anything at all until the registry returns.
- **Payload growth crosses the broker limit** — A field that grew quietly pushes messages past the maximum size, and publishes start failing for records that used to be fine.
- **Retired tag number reused** — A number freed by a removed field is assigned to a new field of a different type, and old consumers read the new bytes as the old type — a decode failure that reads like corruption.

### Readiness checklist
<!--meta polarity=check-->

- The schema lives in one place both sides build against, not in two hand-written copies
- Every message carries its schema identity in the envelope
- An incompatible schema change fails the build in CI, not a consumer
- Compatibility mode matches the deployment reality — full where releases are independent
- Undecodable messages go to a dead-letter destination instead of blocking the partition
- Consumers cache resolved schemas so a registry outage does not stop running work
- Retired field names and numbers are reserved so they can never be reused
- There is a documented way to inspect a binary payload during an incident

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Streaming](../../themes/streaming.md) — The wire contract that lets stages be released separately {#fluency-streaming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Message Translator](./message-translator.md) — Encoding fixes what the shape is; translation is what happens when two endpoints refuse to agree on it
- [Claim Check](./claim-check.md) — Past a size threshold the message encodes a reference and the payload goes to object storage
- [Dead Letter Channel](./dead-letter-channel.md) — A message that cannot be decoded has to leave the partition, or it blocks every message behind it
- [Canonical Data Model](./canonical-data-model.md) — Encoding rules say how the canonical fields are written on the wire and how they may change
- [Content-Based Router](./content-based-router.md) — A router that reads body fields breaks first when a field is renamed.

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — A schema registry stores each schema version and checks that a new one stays compatible.

<!-- relationships:end -->
