---
title: Online Auction
description: "Hold one true highest bid under a storm of concurrent bids, lose none, and broadcast each new high in real time"
area: designs-advanced
owner: Oleksandr Derechei
tags: [concurrency, durability, latency]
status: stable
aliases: [bidding system, auction house]
solves: [two bidders submit at the same instant and both are told they are winning from a stale current value, under a last-minute bidding spike my service drops writes or falls over and I cannot lose one, my clients poll every few seconds for the latest number and still act on stale data while hammering the database, a bidder on server A and another on server B watch one item but updates on A never reach B, I overwrite the current maximum on every update and now I have no history left to settle a dispute]
---

# Online Auction

Sellers list an item with a starting price and an end date; buyers place bids that only stick if they beat the current high; the last highest bidder wins. The surface is small, but three forces pull against each other underneath it: many bids race for the same item at once, no bid may ever be lost, and every watcher must see the true high the moment it moves.

## Understanding the problem
<!--meta block=description-->

An online auction lets users list an item with a starting price and an end date and bid on it. The hard part is the bid: one number that thousands of clients read and many try to overwrite in the same second. The high bid must be strongly consistent, no bid may be dropped, and the screen must stay live. The page walks through meeting all three.

## Explained
<!--meta block=explain-->

An online auction keeps one true highest bid per item while thousands of people try to overwrite it in the same second. Each bid goes first into a durable queue, split by item, so no accepted bid is lost and bids on one item stay in order. A consumer then applies each bid with one guarded update on the item's own row: change the high only if it is still the value this bidder saw. If the guard fails, the bidder retries or is told they lost. Choose this over a lock on the bid rows, because a lock does not stop a new bid being inserted and a hot item turns into a line of stalled requests. Shard the database by item, so every guarded update stays on one shard.

- **Queue delay.** The queue adds a few milliseconds before a bid is judged, so show a pending state.
- **Retries.** Each collision costs a retry, rare per item, so cap the retries.
- **Watcher push.** Pushing a new high to up to 100 million watchers needs a channel per item that every connection server listens to, then relays.

**Example.** The peak is about 15,000 bids a second, ten times the average, because bidding bunches into the last minutes. One item sits at $50. After a consumer restart, two bids are in flight at once, $60 and $55, and both read 50. The $60 update changes the row and succeeds. The $55 update finds the high is no longer 50, so it changes zero rows. It re-reads 60, sees 55 does not beat it and rejects the bid at once. The cost is that second read and the few milliseconds the queue added.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Post an item for auction with a starting price and an end date.
2. Place a bid on an item; it is accepted only if it beats the current highest bid.
3. View an auction, including the current highest bid.

Out of scope, named up front to keep the design narrow: search, category filtering, sorting by price, and browsing an item's bid history.

### Non-functional
<!--meta requirement=nfr-->

- **Consistency** — bids are strongly consistent; every user sees the same one true high bid.
- **Durability** — fault tolerant and lossless; a bid, once acknowledged, is never dropped even if a service crashes.
- **Real-time** — the current high bid is displayed to watchers within a beat of changing.
- **Scale** — 10M concurrent auctions live at once.

## Right-sizing
<!--meta block=sizing-->

**Bid throughput.** Say each of 10M live auctions draws ~100 bids over a ~1-week life. That is 10M × 100 ÷ 7 days about 143M bids/day, about **1,650 bids/sec** on average. Bidding is bursty — auctions cluster their action into the final minutes and the evening — so design for a peak roughly 10× the mean, call it **~15k bids/sec** (10 × 1,650 is about 16.5k, rounded down to a round number). That write rate, on a single hot scalar per auction, is the number the architecture has to survive.

**Storage.** An auction row is ~1&nbsp;KB; a bid is ~500 bytes. At 10M × 52 weeks ≈ 520M auctions/year, storage is ≈ 520M × (1&nbsp;KB + 100 × 500&nbsp;B) ≈ **~25&nbsp;TB/year**. Real, but not the pressing constraint — modern solid-state drives (SSDs) swallow it and replication covers durability. Write throughput, not disk, is what forces the interesting choices.

**Fan-out.** With up to 100M users each potentially watching an auction, live connections could total on the order of 100M. No single box holds that, so the real-time layer has to spread across many servers and still deliver one bid to every watcher of that item.

## Core entities
<!--meta block=entities-->

Four entities, with one deliberate normalization choice:

- **Auction** — `starting_price`, `end_date`, a reference to the item, and — critically — a denormalized `max_bid` that we will treat as the single point of truth for the high.
- **Item** — `name`, `description`, image URL. Kept separate from Auction rather than embedded: an unsold item can be relisted, item details change independently of an auction, and item-level features (categories, search) get easier later.
- **Bid** — `amount`, the bidding user, the auction, a timestamp, and an accepted/rejected status. Every bid is written; none is overwritten.
- **User** — starts auctions or bids on them.

The tempting shortcut — keep only a single `max_bid_price` field and skip a bids table — is a trap. Overwriting the max on each bid destroys the audit trail: no way to reconstruct the sequence, investigate a dispute, or disprove a bidder's claim that their bid vanished. Keep the full, append-only bid log and the denormalized max; they answer different questions.

## The interface
<!--meta block=interface-->

Three endpoints, one per functional requirement:

```http summary="HTTP — list, bid, view"
POST /auctions
{ "item": { "name": "…", "description": "…" },
  "startDate": "…", "endDate": "…", "startingPrice": 10 }
→ 201 { "auctionId": "…", "item": { … } }

POST /auctions/{auctionId}/bids
{ "amount": 100 }
→ 202 { "status": "received" }   // durable, not yet adjudicated

GET /auctions/{auctionId}
→ 200 { "auction": { "maxBid": 100, … }, "item": { … } }

GET /auctions/{auctionId}/bid-stream   // SSE: pushes each new maxBid
```

The bid response is a **202 Accepted**, not a 200: the bid is safely captured, but whether it wins is decided a step later, and the bidder sees the result when the stream pushes the new `maxBid`: if it is not their amount, they lost. Acknowledging receipt separately from adjudication lets the durability and consistency machinery sit behind the endpoint without making the caller wait on it.

## How the system is built
<!--meta block=architecture-->

Split listing from bidding into two services with opposite shapes. The **Auction Service** is read-tuned and thin — create and fetch listings. The **Bid Service** is write-tuned and does the hard part: it never touches the database on the request path. A bid is dropped into a durable log the instant it arrives, acknowledged, and adjudicated asynchronously by a consumer that owns the auction's true high. That same consumer, on accepting a new high, publishes it so every real-time connection watching the item — wherever it is hosted — learns the new number. The split matters because bid writes (about 1,650 a second) are about 100× listing writes (520M a year, about 16 a second), and the two want to be tuned and scaled independently.

```mermaid caption="A bid is durable at the queue before it is judged; the consumer holds the true high in the auction row and broadcasts each new one through pub/sub so every SSE server sees it."
flowchart TB
    Client["Client / browser"]
    GW["API Gateway — auth, rate limit, routing"]
    Auction["Auction Service"]
    Queue[("Kafka — partitioned by auctionId")]
    Bid["Bid Service consumer"]
    DB[("Auction store — sharded by auctionId")]
    PS[("Pub/Sub channel")]
    SSE["SSE broadcaster"]
    Client -->|"POST /auctions, GET"| GW
    Client -->|"POST /bids"| GW
    GW -->|"create / read listing"| Auction
    GW -->|"append bid, ack"| Queue
    Auction -->|"persist listing"| DB
    Queue -->|"consume in order"| Bid
    Bid -->|"conditional update max_bid"| DB
    Bid -->|"publish new high"| PS
    PS -->|"fan-out to peers"| SSE
    SSE -.->|"live maxBid"| Client
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Strong consistency for bids

This is the crux. Two bids arrive on an auction whose high is $10. User&nbsp;A reads $10 and writes $100 — accepted. User&nbsp;B, reading a stale $10 through replication lag, writes $20 — also accepted, because $20 beats the $10 they saw. Now two people believe they lead. That is a textbook [race condition](../hazards/race-condition.md) on a contended value, and it must be closed.

The naïve fix — take a [pessimistic lock](../patterns/distributed/coordination/pessimistic-locking.md) over the auction's bid rows with `SELECT … FOR UPDATE` — fails twice. Locking existing rows does not stop a concurrent transaction from inserting a fresh bid, so the race survives; and the lock set grows with every bid on the item, turning a hot auction into a queue of stalled transactions.

Caching the max in Redis and comparing there is faster but relocates the problem: now the cache and the database can disagree, and there is no clean cross-system transaction to keep them honest. The clean answer collapses the two systems into one: **keep the high on the auction row itself** and guard the update. Use [optimistic concurrency control](../patterns/distributed/coordination/optimistic-concurrency-control.md), which fits because true collisions are rare. Read the row's `max_bid` as an implicit version, then issue a [conditional write](../patterns/distributed/coordination/conditional-write.md) that only lands if the max is still what you read. If it changed underneath you, the update touches zero rows — retry from the read. One row, no held lock, and the occasional retry is the whole cost.

```sql summary="SQL — optimistic compare-and-set on the auction row"
-- read the current high (this value is the "version")
SELECT max_bid FROM auctions WHERE id = :auctionId;   -- e.g. 10

-- accept only if it is still 10 AND the new bid beats it
UPDATE auctions
   SET max_bid = :amount
 WHERE id = :auctionId
   AND max_bid = :seen_max        -- 0 rows affected => someone raced us
   AND :amount > max_bid
   AND end_date > now();

-- run the UPDATE and the bid insert in one transaction; commit only when 1 row is affected (record the bid as 'accepted')
-- 0 rows affected: re-read max_bid and retry, or reject if we no longer lead
```

### 2 · Durability — never drop a bid

Adjudicating on the request path couples acceptance to the Bid Service being up and un-overloaded, and a popular auction's final minute can produce thousands of bids per second — more than the service can take head-on. Rather than drop bids, crash, or massively over-provision, get every bid into a durable [message queue](../patterns/messaging/message-queue.md) the moment it arrives, acknowledge from there, and let the consumer judge at its own pace. This is [load leveling](../patterns/distributed/resilience/load-leveling.md): the queue absorbs the surge so the service sees a smooth rate. It is also a [producer-consumer](../patterns/concurrency/producer-consumer.md) split — the API-side producer only appends; the Bid Service consumes. Kafka fits: high throughput, on-disk durability with replication, and — by partitioning the topic on `auctionId` — a total order of bids within an auction, which decides ties fairly, while different auctions process in parallel. The trade is a few milliseconds of queue latency for the guarantee that an acknowledged bid, once the broker has acknowledged the write to its in-sync replicas, outlives any single crash. If the consumer dies mid-bid, the message is still there to reprocess, so redelivery can arrive twice: each bid carries a client-supplied bid id with a unique constraint on it, and a repeat is a no-op.

### 3 · Showing the high bid in real time

Polling every few seconds is both too slow for a hot auction and wasteful — nearly every poll re-reads a number that has not moved, straight off the database. The fix is to push. Long polling works (hold the request open until the max changes) but ties up a connection per watcher and invites a [thundering herd](../hazards/thundering-herd.md) on reconnect. Cleaner is **Server-Sent Events**: one long-lived, unidirectional server-to-client stream opened when a user views the auction, over which the server pushes each accepted high. It is unidirectional traffic, so SSE is a lighter fit than full WebSockets. The catch is coordination across servers — if the watcher is on server B and the winning bid was consumed on server A, B's stream never hears about it on its own.

### 4 · Scaling the fan-out and the writes

That coordination gap is closed with [pub/sub](../patterns/messaging/pubsub.md). When the consumer accepts a new high it publishes it to a channel keyed by auction; every SSE server subscribes, and each [fans the update out](../patterns/messaging/fan-out.md) to its own connected watchers of that item. Now a bid landing anywhere reaches everyone, across up to ~100M connections spread over many boxes. The compute tier is easy: the Bid and Auction services are [stateless](../patterns/distributed/routing/stateless-service.md), so they scale horizontally under an autoscaler tracking CPU and memory. The database is the pinch — ~15k writes/sec exceeds one Postgres instance — so [shard by `auctionId`](../patterns/distributed/routing/sharding.md). Because a bid touches only its own auction's row and log, every read and write for an item stays on one shard: no [Scatter-Gather](../patterns/messaging/scatter-gather.md), and the optimistic single-row update from deep dive&nbsp;1 keeps working unchanged. Left to right, each tier scales on its own axis — queue on partitions, services on instances, storage on shards.

Pub/sub carries each accepted high from the consumer to every SSE server.

```mermaid caption="How does a bid consumed on server A reach a watcher connected to server B?"
sequenceDiagram
    participant Co as Consumer
    participant P as Pub/sub channel (per auction)
    participant A as SSE server A
    participant B as SSE server B
    participant Wa as Watcher on B
    Co->>P: publish new high
    P-->>A: new high
    P-->>B: new high
    B-->>Wa: push over SSE stream
    A-->>A: push to its own watchers
```

### 5 · Ending the auction

A fixed end date is trivial. "End an hour after the last bid" is not — it is a scheduling problem. The cheap version stores a running `end_time` on the auction row and lets a periodic sweep close whatever has expired. The precise version uses a delayed-task [scheduler](../patterns/concurrency/scheduling.md) — a Redis sorted set keyed by fire time, or a durable job queue — that on each bid schedules a check for one hour later; when it fires, it closes the auction only if that bid is still the latest. A bid that arrives after the end is rejected, because the guarded update from deep dive&nbsp;1 also requires the auction to be still open. Pitfalls: clock drift and concurrent termination attempts.

```mermaid caption="How optimistic compare-and-set resolves two bids racing on the same auction."
sequenceDiagram
    autonumber
    participant A as Bidder A
    participant B as Bidder B
    participant DB as Auction row
    A->>DB: SELECT max_bid
    DB-->>A: 10
    B->>DB: SELECT max_bid
    DB-->>B: 10 (stale read)
    A->>DB: UPDATE WHERE max_bid = 10, set 100
    DB-->>A: 1 row — A now leads
    B->>DB: UPDATE WHERE max_bid = 10, set 20
    DB--xB: 0 rows — raced, lost
    B->>DB: re-read max_bid
    DB-->>B: 100
    Note over B: 20 < 100 — reject, prompt higher bid
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- One true high per auction, enforced by a single-row conditional update with no held locks.
- No bid is ever lost: it is durable in the queue before it is acknowledged or judged.
- The surge in an auction's final minutes is absorbed by the queue, not by over-provisioned servers.
- Sharding by auction and per-auction partition ordering scale writes and fairness together.

### What it gives up
<!--meta polarity=con-->

- Asynchronous adjudication means a bidder learns win-or-lose a beat after submitting, not synchronously.
- Queue and pub/sub add a few milliseconds of latency and real operational surface — partitions, consumer lag, replication.
- Optimistic concurrency degrades on a genuinely white-hot single auction, where retries pile up under contention.
- The live layer coordinates through pub/sub, so a stream can briefly miss an update if a broadcaster drops a message; the client re-reads `GET /auctions/{auctionId}` on reconnect to catch up.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end flow (list → bid → view), a bids table rather than an overwritten scalar, and, when prompted, a sensible stab at the consistency and scaling questions.
- **Senior** — recognizes bid consistency and live broadcast as the heart of the problem and drives toward them: names the race condition, lands on a single-row optimistic update, and explains how the client stays current.
- **Staff+** — demonstrates mastery of consistency and real-time, then volunteers the adjacent hard parts unprompted — durable ingestion under surge, cross-server fan-out via pub/sub, sharding by auction, and auction-ending as its own distributed-systems problem with clock drift and concurrent termination.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — the chosen bid path reads max_bid as a version and commits only if it is still unchanged, retrying on conflict
- [Conditional Write](../patterns/distributed/coordination/conditional-write.md) — the winning update lands only WHERE max_bid still equals the value just read, closing the read-then-write race on the high bid
- [Message Queue](../patterns/messaging/message-queue.md) — every bid is appended to a partitioned Kafka topic and acknowledged before adjudication, so no bid is lost to a crash
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — the queue absorbs an auction's final-minute bid surge so the Bid Service consumes at a steady rate instead of being over-provisioned
- [Publish-Subscribe](../patterns/messaging/pubsub.md) — an accepted high is published to a per-auction channel so every server-sent events (SSE) server, not just the one that judged it, learns the new number
- [Fan-Out](../patterns/messaging/fan-out.md) — each server-sent events (SSE) server pushes the new high to all of its own connected watchers of that auction
- [Sharding](../patterns/distributed/routing/sharding.md) — the auction store is partitioned by auctionId so ~15k writes/sec spread across instances with no cross-shard reads
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — the Bid and Auction services hold no per-request state, so an autoscaler can add instances freely under bursty load
- [Producer-Consumer](../patterns/concurrency/producer-consumer.md) — the API-side producer only appends a bid to Kafka; the Bid Service consumes and adjudicates at its own pace
- [Scheduling](../patterns/concurrency/scheduling.md) — Ending an auction an hour after the last bid is a delayed-task problem, solved with a scheduler keyed by fire time

<!-- relationships:end -->
