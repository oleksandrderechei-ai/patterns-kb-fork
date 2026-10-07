---
title: Claim Check
description: "Sends a reference to large data, not the data itself"
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling, throughput]
status: stable
solves: [the broker rejects my message because the payload is over the size limit, I am pushing twenty megabyte files through a queue and the whole thing slowed to a crawl, my consumers only need the filename but every one of them downloads the entire blob, replaying the topic takes hours because every single record is enormous, our broker bill exploded because we are using it to move bulk data around]
favourite: true
---

# Claim Check

Stores a bulky payload in durable storage and lets only a lightweight reference — the claim check — travel through the message channel, so the channel stays fast and the data moves only when a consumer actually redeems it.

## What it is
<!--meta block=description-->

A **claim check** keeps a large payload off the message channel. The producer stores the bytes once in shared storage, waits for the write to confirm, then publishes only a key or link. Only a consumer that needs the bytes fetches them, so the broker stays within its size limits and the other consumers route on metadata. The name comes from a coat check: you hand over the bulky item once and redeem a small ticket.

## Explained
<!--meta block=explain-->

A claim check stores a large payload in shared storage and sends only a small reference to it through the message channel. The producer writes the bytes to the store, waits for the write to succeed, then publishes a message holding a key or link. Only a consumer that needs the bytes fetches them, so the broker stays fast and consumers that route on metadata never move the payload. Choose it over sending the payload inline when messages regularly approach the broker size limit (Kafka defaults to 1 MB, SQS defaults to 256 KB and allows up to 1 MiB) or most consumers never open the body.

- **Two steps.** A crash between store write and publish leaves an orphaned object: write first, publish through an outbox, and sweep orphans.
- **Piling payloads.** Set a lifecycle rule that deletes them after your slowest consumer or replay window.
- **Store on the read path.** Give the store its own alert and runbook.

**Example.** Users upload 1,000 passport scans a day of 30 MB each, and 5 services listen. Inline, that is 30 MB x 1,000 x 5 = 150 GB through the broker a day, and every message is over even SQS's 1 MiB limit. With a claim check, 30 GB goes into storage once and the broker carries 1,000 messages of a few hundred bytes. Only the one service that opens the scan reads it, so the other 4 read nothing. The cost: a lifecycle rule that deletes scans after 7 days holds about 210 GB, and a replay on day 10 redeems a key for nothing.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a 30 MB scan reach the one consumer that needs it without crossing the queue? Step 2 confirms the write before step 3 publishes, so the key on the queue resolves at step 5 as long as retention has not swept the object."
flowchart LR
    Prod["Upload service"]
    Store[("Object store")]
    subgraph Ref["Reference only — the payload never crosses here"]
        Q[("Message queue")]
        Router["Metadata-only consumer"]:::ext
    end
    Scan["Scanning consumer"]:::ext
    Prod -->|"1 put the 30 MB scan"| Store
    Store -->|"2 write confirmed, key returned"| Prod
    Prod -->|"3 publish the key alone"| Q
    Q -->|"4 deliver"| Router
    Q -->|"4 deliver"| Scan
    Scan -->|"5 redeem the key for the bytes"| Store
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The payload goes straight into the store, only its claim check travels through the queue. The consumer redeems it when it needs the data."
sequenceDiagram
    autonumber
    participant P as Producer
    participant S as Store
    participant Q as Queue
    participant C as Consumer
    P->>S: put(payload)
    S-->>P: claimCheckId
    P->>Q: send(claimCheckId)
    Q->>C: deliver(claimCheckId)
    C->>S: get(claimCheckId)
    alt payload still stored
        S-->>C: payload
    else expired or purged
        S--xC: not found
        C->>C: handle missing payload
    end
```

## Variations
<!--meta block=variations-->

- **Store-first hand-off** — The producer writes the payload to the store and waits for confirmation before publishing the claim check, so the message never references data that isn't there yet.
- **Reference as [pre-signed URL](../distributed/routing/valet-key.md)** — The claim check is a time-boxed, directly fetchable URL rather than an opaque key, so any consumer can retrieve the payload without a shared client library or extra credentials. The URL is a bearer credential, so anyone who sees the message can fetch the payload, and one that expires before the slowest consumer or a replay redeems it fails like a swept object. Keep the window short but above the longest delivery delay.
- **Content-addressed claim check** — The reference is a hash of the payload itself, so identical bodies collapse to one stored object and a consumer can verify what it fetched matches what was sent.
- **Claim check with time to live (TTL) / cleanup** — Stored objects expire or get swept after a retention window, so an unredeemed or already-consumed claim check doesn't leave storage growing forever.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Keeps the message channel fast** by capping what actually crosses it to a small reference.
- **Consumers that don't care about the payload** never pay to move, deserialize, or buffer it.
- **Storage and messaging scale independently** — cheap [object storage](../distributed/routing/object-storage.md) for bulk data, a lean broker.
- **The payload can be inspected**, versioned, or reprocessed in the store without replaying the message.
- **Sensitive payloads never enter the broker** — The bytes sit behind the store's own access controls, provided the reference is an opaque key, not a pre-signed URL that anyone who sees it can redeem.

### Cons
<!--meta polarity=con-->

- **Adds a network round trip** and a second system — the store — that must be up for the message to be useful.
- **Two writes, store then queue, aren't atomic** — a crash between them leaves an orphaned object, and publishing first would leave a phantom reference. Write to the store first, and put the publish behind an [outbox](../distributed/coordination/outbox.md) when the pair genuinely has to hold.
- **Someone has to garbage-collect stored payloads** once every claim check is redeemed or expires — a lifecycle rule on the bucket, not a promise to remember.
- **Debugging is harder**: the message body only tells you where to look, not what happened.
- **Retention becomes a correctness setting rather** than a cost setting: sweep the object before the slowest consumer or a replay gets to it, and the reference redeems nothing.
- **The store is now on the critical path**. Its outage no longer loses messages — it stalls every consumer that needs a body, which is a different incident and needs its own runbook.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A payload routinely exceeds the broker's practical** or hard message-size limit.
- **Most consumers only need to route or filter** on metadata, not the full body.
- **Storage and message-channel throughput need to scale independently**.

### Avoid when
<!--meta polarity=avoid-->

- **Payloads are consistently small** enough to fit the channel without strain — the extra store round trip only adds latency.
- **The store write and the message publish** must be atomic — pair with an outbox instead of send-and-hope.
- **Only one consumer ever exists** and it always needs the full payload immediately — just send it inline.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — store the bytes, send the address"
// Producer: the file goes to storage first, and only its key goes on the queue.
async function submit(photo: Buffer) {
  const photoKey = await store.put(photo);   // wait for the write to confirm
  await queue.send({ type: "verify", photoKey });
}

// Consumer: redeem the key for the bytes, but only if you actually need them.
async function verify(msg: { photoKey: string }) {
  const photo = await store.get(msg.photoKey);
  await idVendor.verify(photo);
}
```

```typescript summary="TypeScript — flow steps that pass a photo key, never the photo"
interface ClaimCheckStore {
  put(payload: Buffer): Promise<string>;   // returns a storage key — the claim check
  get(key: string): Promise<Buffer>;
}

interface Task {
  flowId: string;
  personaId: string;
  type: "verify" | "screen";
  photoKey: string;                        // the check, not the image
}
type Queue = { send(task: Task): Promise<void> };

async function submitIdPhoto(
  flowId: string, personaId: string, photo: Buffer,
  store: ClaimCheckStore, queue: Queue,
): Promise<void> {
  const photoKey = await store.put(photo);              // bytes land in the store first
  await queue.send({ flowId, personaId, type: "verify", photoKey });
}

async function runVerify(
  task: Task, store: ClaimCheckStore, idVendor: IdVendor, queue: Queue,
): Promise<void> {
  const photo = await store.get(task.photoKey);         // redeem the check for the bytes
  await idVendor.verify(task.flowId, photo);
  await queue.send({ ...task, type: "screen" });        // hand on the key, never the image
}
```

## In the wild
<!--meta block=wild-->

- **Amazon SQS Extended Client Library** — Transparently stores oversized payloads in a Simple Storage Service (S3) bucket and sends only the object pointer on the queue — built around the classic 256 KB SQS message size, today the default rather than the cap (raised to 1 MiB in 2025). payloadSizeThreshold sets the offload cutoff and alwaysThroughS3 forces every payload through S3; the receiving client fetches the object and can delete it after processing. {#wild-sqs-extended-client}
- **Apache Camel claimCheck()** — The Claim Check enterprise integration pattern (EIP) offers Set/Get/Push/Pop operations against a keyed repository: it moves the message body into the store under a claim-check key and replaces the exchange body with that key, then a later Get or Pop step restores the body on demand within the route. {#wild-apache-camel-claim-check}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Offload size threshold** — The payload size above which the body goes to the store and only a reference is sent, versus sending it inline (SQS Extended Client payloadSizeThreshold, or an always-offload flag). Set it below the broker's size limit minus envelope overhead, from your measured p50 and p95 payload sizes.
- **Store retention / TTL** — How long a stored payload lives before a lifecycle rule reclaims it (object-store lifecycle expiration). Set it to the slowest consumer's lag plus the full replay window plus a margin; read lag as the age of the oldest queued message.
- **Reference expiry** — When the claim check is a time-boxed presigned URL, the validity window of that URL before it stops resolving. Set it above the longest delivery delay, retries and dead-letter replay included, or sign the URL when the consumer asks.
- **Store durability / class** — Which storage tier holds the payload — the durability and read-latency trade for the bytes taken off the channel.

### Signals to watch
<!--meta polarity=signal-->

- **Store fetch latency** — The added round trip a consumer spends redeeming the reference — pure overhead on every message whose body is actually needed.
- **Fetch error rate** — References that resolve to a missing or unavailable object — phantom references and premature cleanup both surface here first. Alert on any sustained non-zero miss rate.
- **Orphaned object growth** — Stored payloads no message points at — a rising floor of storage nothing will ever redeem or delete. Diff the store listing against the references published; alert on a sustained rise.
- **Offload ratio** — Fraction of messages sent by reference versus inline; it confirms the threshold is diverting the payloads you meant it to.

### Failure modes under load
<!--meta polarity=failure-->

- **Phantom reference** — Publishing the message before the store write commits leaves consumers holding a reference to data the store does not have.
- **Orphaned payload** — The store write succeeds but the publish fails, so the object sits in storage with no claim check that will ever redeem or delete it.
- **Store outage blocks consumers** — The reference is valid but the store is down, so consumers stall on messages that crossed the channel fine until it recovers. Retry with backoff, then dead-letter the message for replay.
- **Premature expiry** — A retention window shorter than a slow consumer or a replay needs sweeps the payload before it is redeemed, and the redelivery finds nothing.
- **Redemption stampede** — A fan-out means every subscriber redeems the same reference at once, so one published message becomes N concurrent reads of one object. Cache the body near the consumers or stagger the reads.

### Readiness checklist
<!--meta polarity=check-->

- The store write is confirmed before the reference is published, and the crash-between-the-two case has a decided outcome rather than an assumed one
- Retention was compared against the slowest consumer's observed lag and the full replay window, not set to a round number
- A lifecycle rule or sweep reclaims objects no claim check will redeem, and its effect is measured rather than assumed
- Consumers handle a missing object explicitly instead of treating the fetch as infallible
- Where the store write and the publish must be atomic, the publish goes through an outbox
- Access control on the store is at least as strict as on the channel, since the payload no longer travels with the message

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Put a reference on the channel and keep the large payload in storage. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Message Queue](./message-queue.md) — Keep large payloads out of the queue
- [Object Storage](../distributed/routing/object-storage.md) — The large data lives in an object store; the message carries its key, not the bytes.
- [Outbox](../distributed/coordination/outbox.md) — The store write and the publish are not atomic; the outbox is what makes the pair hold
- [Message Encoding](./message-encoding.md) — The size at which a payload becomes a reference is part of the encoding decision
- [Context Engineering](../ml/context-engineering.md) — The window is another place where the payload should live elsewhere and travel as a handle
- [Content Enricher](./content-enricher.md) — Moves a large payload out of the message into storage, which an enricher can fetch back where a step needs it
- [Valet Key](../distributed/routing/valet-key.md) — The reference can be a valet key: a pre-signed URL that carries its own access grant.
- [Asynchronous Request-Reply](../distributed/routing/async-request-reply.md) — The finished state of a long-running operation is a natural place to hand back a reference instead of a payload

**Alternative to**

- [Splitter](./splitter.md) — Send a pointer and leave the payload in a store vs. chop it into messages the channel already accepts

**Demonstrated by**

- [Web Crawler](../../designs/web-crawler.md) — a large payload is stored aside and passed by reference so the queue stays small and cheap
- [WhatsApp](../../designs/whatsapp.md) — swapping a bulky payload for a reference the recipient redeems separately is the claim-check move exactly
- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — passing a storage key for a submitted ID photo between flow steps instead of the image bytes themselves
- [YouTube](../../designs/youtube.md) — A transcode queue is the canonical claim check: the payload stays in the store
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — the key travels through the queue and the log; the payload never does

**Implemented by**

- [Storage](../../capabilities/storage.md) — Object storage holds the payload; the message carries the key.

<!-- relationships:end -->
