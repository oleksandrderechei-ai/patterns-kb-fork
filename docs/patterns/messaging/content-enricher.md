---
title: Content Enricher
description: Adds missing data to a message from another source before it moves on
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling, transformation]
status: stable
aliases: [message enricher]
solves: [The next step needs the customer name and tier but the message only carries an id, Every consumer calls the same lookup service to fill in fields the sender left out, Adding a field to every message means changing every producer that sends it, Ten services each fetch the same reference data and break together when its source changes]
---

# Content Enricher

Adds the data a message is missing, such as a customer profile or a price, by looking it up from another source before the message moves on.

## What it is
<!--meta block=description-->

A message often carries only an id or a few fields, while the next step needs the full customer, price or address. Without a dedicated step, every consumer calls the lookup itself, so each one couples to the data source and repeats the call. A **content enricher** is a filter that reads the message, fetches the missing data from a resource, merges it in and forwards the larger message. Consumers then never learn where the data lives.

## Explained
<!--meta block=explain-->

A content enricher is a step between two channels that adds missing data to a message. It reads a key from the message, such as a customer id, looks that key up in a database, a service or a cache, merges the result in and forwards the fuller message. Choose it over a lookup inside each consumer when several consumers need the same data and you want one place that knows the source. Choose [event-carried state transfer](./event-carried-state-transfer.md) instead when the producer can include the data itself at no cost. Without it, ten consumers call the customer service for each order, and one change in that service can break all ten.

- **An extra call on every message.** Latency and source load grow with traffic; cache hot keys and batch lookups.
- **Stale or missing data.** A cache serves old values and a source can fail; set a lifetime and a default or dead-letter rule.
- **A new dependency.** A down source stops the flow; use a timeout and move failed messages aside.

**Example.** Orders arrive at 3,000 a minute with a customer id only, and the fraud check needs country and tier. The enricher calls the customer service, which takes 40 ms, so each order is 40 ms slower and the service takes 3,000 calls a minute. A cache with a 10-minute lifetime and a 95% hit rate cuts that to 150 calls a minute. The cost is staleness: a customer upgraded 3 minutes ago shows the old tier for up to 7 more minutes. The team keeps the cache because the fraud check can live with a tier up to 7 minutes old. A check that needs a fresh tier would shorten the lifetime, and calls would rise toward 3,000 a minute.

## How it works
<!--meta block=structure-->

```mermaid caption="Who knows where the customer data lives? Only the enricher. Steps 3 and 4 are the one lookup, so the consumer at step 6 receives a complete message and the source can change without touching it."
flowchart LR
    Prod["Order service"]:::ext
    In[("Order channel")]
    subgraph EN["Enricher"]
        Step["Read key, merge result"]
        Cache[("Cache")]
    end
    Src[("Customer service or database")]:::ext
    Out[("Enriched channel")]
    Cons["Fraud check"]:::ext
    Prod -->|"1 order with customer id only"| In
    In -->|"2 receive"| Step
    Step -->|"3 look up the id"| Cache
    Cache -->|"4 on a miss, ask the source"| Src
    Step -->|"5 forward the fuller message"| Out
    Out -->|"6 deliver"| Cons
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What happens when the source is slow or down? The enricher bounds its wait. A timeout turns an open-ended stall into one message sent to the dead-letter channel, and the rest of the stream keeps moving."
sequenceDiagram
    autonumber
    participant E as Enricher
    participant S as Source
    participant O as Out channel
    participant D as Dead-letter channel
    E->>S: look up customer c-17
    S-->>E: profile
    E->>O: order plus profile
    E->>S: look up customer c-18
    Note over E,S: no answer within the timeout
    E->>D: order c-18, enrichment failed
```

The enricher needs a **key** in the incoming message, such as a customer id, and an agreed rule for merging the result: which fields it adds, and which existing field wins on a clash. The source can be a database table, another service or a cache. The merge is the part to keep small. An enricher that rewrites existing fields has become a [message translator](./message-translator.md), and one that decides where to send the message has become a router.

The lookup sits on the path of every message, so its latency adds to the whole flow. Fast sources and cached hot keys keep that cost low. A slow or failing source needs a defined policy: retry, send a default, or move the message aside.

## Variations
<!--meta block=variations-->

- **Lookup enricher** — Reads a key from the message and fetches the extra fields from a database or service. The common case, and the one whose cost is a call per message.
- **Self-contained enricher** — Adds data that needs no external source: a timestamp, the host name, a trace id. It costs nothing on the hot path, and it is a common way to add headers.
- **Cached enricher** — Keeps recent lookups in memory so repeated keys skip the source. It cuts calls sharply for hot keys, and it makes stale data a possibility you must price.
- **Batch enricher** — Collects a group of messages, asks the source for all their keys in one request and merges the answers back. It trades a little latency for far fewer calls.
- **Enrich at the producer** — The sender includes the data in the message itself, as [event-carried state transfer](./event-carried-state-transfer.md) does. No lookup is needed at read time, and the producer takes on the job of knowing the data.
- **Local-replica enricher** — Keeps a replicated copy of the reference data beside the enricher, so each lookup is local. The cost is keeping the copy fresh.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One place knows the data source** — consumers stay unaware of where the customer or price data lives.
- **Producers stay small** — they send an id and need no access to the data the consumers want.
- **The lookup is written once** — ten consumers no longer repeat the same call, so a source change touches one component.
- **Consumers receive complete messages** — each step can run on the message alone, without a second round trip.

### Cons
<!--meta polarity=con-->

- **Every message pays a lookup**, so latency and source load grow with traffic. Cache hot keys and use batch lookups.
- **The source becomes a dependency** of the whole flow. Guard the call with a timeout and route failures to a [dead-letter channel](./dead-letter-channel.md).
- **Cached data goes stale**, so a consumer can act on a value that has already changed. Set a lifetime from how fast the field changes.
- **The message grows**, which raises broker and network cost. Add only the fields consumers use.
- **A merge rule hides coupling** — consumers come to depend on enriched fields. Version the enriched schema as you would any other contract.
- **Replays re-enrich with current data**, so output can differ from the first run, and a message moved aside loses its place in the key's order. Store the enriched output if exact replay matters.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A downstream step needs data the producer does not have**, and the data lives in one known place.
- **Several consumers need the same extra fields**, so each one calling the source would repeat work and spread coupling.
- **The producer should stay ignorant of the consumers' needs**, so adding a consumer never means changing the sender.

### Avoid when
<!--meta polarity=avoid-->

- **The producer already has the data** and sending it costs little, so carry it in the message and skip the lookup.
- **Only one consumer needs the data**, and it can look it up itself with no loss.
- **The source cannot take the extra load or latency**, and no cache can hide it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — look up the customer with a cache and a timeout, or dead-letter the message"
interface Order { orderId: string; customerId: string }
interface EnrichedOrder extends Order { country: string; tier: string }
interface Customer { country: string; tier: string }

const TTL_MS = 10 * 60_000; // cache lifetime; also cap the map size
const cache = new Map<string, { value: Customer; expires: number }>();

async function enrich(order: Order): Promise<EnrichedOrder> {
  const hit = cache.get(order.customerId);
  let customer = hit && hit.expires > Date.now() ? hit.value : undefined;

  if (!customer) {
    customer = await withTimeout(customers.get(order.customerId), 200); // bound the wait
    cache.set(order.customerId, { value: customer, expires: Date.now() + TTL_MS });
  }
  return { ...order, country: customer.country, tier: customer.tier };
}

async function handle(order: Order) {
  try {
    await outChannel.send(await enrich(order));
  } catch {
    await deadLetter.send(order); // park it for inspection or a redrive; the stream keeps moving
  }
}
```

## In the wild
<!--meta block=wild-->

- **Apache Camel enrich and pollEnrich** — The enrich() step calls another endpoint with the current message and merges the reply through an AggregationStrategy. pollEnrich() does the same by polling a resource such as a file or queue. {#wild-camel-enrich}
- **Spring Integration enricher** — A content enricher endpoint and a header enricher add payload properties or headers to a message, with the extra values coming from a sub-flow or an expression. {#wild-spring-integration-enricher}
- **Kafka Streams stream-table join** — Joining a KStream of events with a KTable or GlobalKTable adds attributes from the table to each event as it passes, which is enrichment by lookup in a local copy of the reference data. {#wild-kafka-streams-join}
- **Amazon EventBridge Pipes enrichment** — A pipe has an optional enrichment step between source and target, which calls a function, workflow or API and passes the combined result to the target. {#wild-eventbridge-pipes}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Lookup timeout** — How long to wait for the source. Too long stalls the flow behind one slow call; too short sends healthy messages to the dead-letter channel. Start near the p99 lookup latency plus a margin, and keep it below the flow's latency budget.
- **Cache lifetime and size** — How long a looked-up value is reused and how many are kept. Sets the staleness window against the load on the source. Start from the longest age a consumer can tolerate for the fastest-changing field.
- **Failure policy** — Whether a failed lookup retries, sends a default value or moves the message aside. The default value must be safe for every consumer.
- **Batch size** — How many keys one lookup request carries, for a batch enricher. Larger batches cut calls and add waiting.

### Signals to watch
<!--meta polarity=signal-->

- **Lookup latency, tail** — p99 of the call to the source. Every cache miss adds it to flow latency.
- **Cache hit ratio** — Share of messages answered without calling the source. A fall means new keys or a lifetime too short.
- **Lookup error and timeout rate** — Share of lookups that failed or timed out. Those messages go to the dead-letter channel or take a default, which the next signal counts.
- **Messages enriched with a default** — A count of messages sent on with fallback values. A rise means consumers are quietly acting on guesses.

### Failure modes under load
<!--meta polarity=failure-->

- **Source outage stops the flow** — With no timeout or fallback, every message waits on the source and the queue behind the enricher grows.
- **Stale cache** — A value changes at the source and consumers keep acting on the old one until the lifetime ends.
- **Expiry burst** — Many hot keys expire together and the source takes a spike of lookups at once. Add random jitter to each expiry, and refresh hot keys before they expire.
- **Lookup per item on a batch** — One large message split into thousands of items makes thousands of calls to the source.

### Readiness checklist
<!--meta polarity=check-->

- The merge rule names which fields are added and which side wins on a clash
- Every lookup has a timeout
- A failed lookup has a defined outcome that is safe for every consumer
- The cache lifetime is chosen from how fast each field changes
- The enriched message schema is versioned like any other contract

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Add missing data to a message by fetching it from another source in flight. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Claim Check](./claim-check.md) — Fetches the missing data and merges it into the message
- [Cache-Aside](../caching/cache-aside.md) — The lookup an enricher repeats for every message is a natural fit for a cache in front of the data source
- [Pipe-and-Filter](../architecture/pipe-filter.md) — Is one filter in the pipeline, taking a message in and passing a larger one on
- [Dead Letter Channel](./dead-letter-channel.md) — A message whose lookup fails or times out goes to the dead-letter channel instead of stalling the flow

**Alternative to**

- [Event-Carried State Transfer](./event-carried-state-transfer.md) — Looks up the missing data in flight, so the event stays small

**Often confused with**

- [Message Translator](./message-translator.md) — Adds data the message does not carry, fetched from another source

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that adds data to a message in flight as a ready-made building block.

<!-- relationships:end -->
