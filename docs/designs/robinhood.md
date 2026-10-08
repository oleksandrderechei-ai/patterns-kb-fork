---
title: Robinhood
description: "Stream live prices to millions and route orders through an external exchange in under 200 ms, without ever losing an order's true state"
area: designs-advanced
owner: Oleksandr Derechei
tags: [consistency, durability, latency]
status: stable
aliases: [trading app, stock brokerage]
solves: [thousands of clients keep polling my upstream for the exact same price and hammering an expensive third-party feed, I need to push live updates to millions of connected clients without them constantly asking whether anything changed, an order confirmation comes back keyed by the vendor id but my database is sharded by user, "an order reached the exchange but the write that followed failed, and now my records disagree with reality", order placement has to finish in under 200 ms even when everyone trades at the opening bell]
---

# Robinhood

A commission-free trading app shows live stock prices and lets users place and cancel orders. It is a broker, not an exchange: it never matches trades itself but sits in front of an external market, so the whole design is shaped by two constraints — push prices to millions of clients fast, and keep every order's state honest across a boundary it does not own.

## Understanding the problem
<!--meta block=description-->

A trading app streams live stock prices and takes buy and sell orders, but it is not the exchange: orders match on an external market reached over an API it does not control. The hard part is fanning prices out to millions of screens without hammering the exchange, and tracking order state that the other side owns. The page walks through both.

## Explained
<!--meta block=explain-->

Robinhood shows live prices and places stock orders for millions of people while talking to an outside exchange that charges for every connection. Two moves make it work. One price service holds a single subscription per symbol and passes each tick over a publish-subscribe channel (a topic that delivers only to servers with a watcher), and those servers push it to their own users. And each order is saved as pending before the exchange sees it, so a failure at any step leaves a record. Choose this over letting each client poll the exchange, which multiplies exchange calls by the number of clients. Correct order status wins over availability here, so an order can sit pending until a background sweeper catches up.

- **Hot symbols.** One tick must reach millions of streams, so spread the watchers across many servers.
- **Lost writes.** The exchange may accept an order we never record, so give each order a client-chosen id and let a sweeper resubmit safely.
- **Foreign ids.** The exchange reports fills under its own id, so keep a small index from that id to the user's shard.

**Example.** There are 20 million daily users. If each polled the exchange every 200 ms, that is 5 calls a second each, so 100 million calls a second. One subscription per symbol means a few thousand. An order arrives and is saved as pending. The exchange accepts it, then our write of its id fails. The sweeper finds the stalled pending order, asks the exchange for it by the client id and finds it. Without that id, a resubmission could place it twice. The cost is that the user sees pending until the sweep runs.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. See the live price of a stock, updating in real time.
2. Place an order — a **market** order (buy/sell now at the going price) or a **limit** order (buy/sell only at a target price).
3. Cancel an outstanding order, and list one's own orders.

Out of scope, named to keep the design narrow: after-hours trading, ETFs / options / crypto, and showing the live order book.

### Non-functional
<!--meta requirement=nfr-->

- **Consistency** — order state is favoured over availability; a user must always see the true, up-to-date status of an order.
- **Latency** — price updates and order actions land in under 200&nbsp;ms.
- **Scale** — 20M daily actives, ~5 trades/user/day (~100M orders/day), thousands of symbols.
- **Frugal upstream** — minimise the number of live connections and calls to the external exchange; those feeds are the scarce, expensive resource.

## Right-sizing
<!--meta block=sizing-->

**Orders.** 20M DAU (daily active users) × 5 trades ≈ 100M orders/day ≈ **~1,200 orders/sec** on average. Trading is bursty — the opening bell and volatility spikes push this an order of magnitude higher, so budget for **tens of thousands/sec** at peak. Each one is consistency-critical and must clear in under 200&nbsp;ms.

**Prices.** At peak, a large share of the 20M daily users hold **an open stream at once**, each watching a handful of symbols. A few dozen symbols are hot; a single tick on one of them may have to reach millions of open connections at once — the design's real fan-out problem.

**Upstream connections.** The number that must stay small. Naïvely, 20M clients polling every 200&nbsp;ms would be ~100M requests/sec at the exchange. The system collapses that to roughly **one feed subscription per symbol**: a few thousand, not one per client.

**Storage.** An order is a few hundred bytes. 100M/day × ~300&nbsp;B ≈ 30&nbsp;GB/day ≈ **~11&nbsp;TB/year** — enough that the order store is partitioned, not single-node.

## Core entities
<!--meta block=entities-->

Three entities carry the design:

- **User** — the trader. Identity travels in a session token / JWT (JSON Web Token) header, never in the request body, so a client can't tamper with whose order it is.
- **Symbol** — a tradable stock (a ticker like `AAPL`): its current price and metadata, mirrored from the exchange's feed rather than owned here.
- **Order** — a buy/sell instruction: `position` (buy/sell), `symbol`, `numShares`, `priceInCents`, type (market/limit), a `state` that walks `pending → submitted → filled / cancelled / failed`, and the `externalOrderId` the exchange returns. It also carries a `clientOrderId`, a key the client generates, so the exchange can be asked about the order by it and a retry never places it twice. Money is stored as integer cents — a floating-point `price` would eventually round a trade wrong.

## The interface
<!--meta block=interface-->

A small representational state transfer (REST) surface for orders, plus a streaming endpoint for prices — one connection a client keeps open instead of a request it repeats:

```http summary="HTTP + SSE — prices and orders"
GET /symbols/AAPL
→ 200 { "ticker": "AAPL", "priceInCents": 21507, "asOf": 1721400000 }

GET /subscribe?symbols=AAPL,META            # Server-Sent Events, one long-lived stream
→ event: price
   data: { "ticker": "AAPL", "priceInCents": 21507 }
   event: price
   data: { "ticker": "META", "priceInCents": 52210 }

POST /order
{ "position": "buy", "symbol": "META", "priceInCents": 52210, "numShares": 10, "clientOrderId": "c_71…" }
→ 200 Order { "id": "ord_9f…", "state": "submitted", "externalOrderId": "X-…" }

DELETE /order/ord_9f…
→ 200 { "ok": true }

GET /orders?cursor=…                         # paginated, scoped to the caller
→ 200 Order[]

# Identity is read from the Authorization header (JWT), never the body.
```

Prices arrive over SSE (server-sent events) — a persistent, one-way, HTTP push — rather than by polling, because the client only ever receives price data and never sends any back; a bidirectional WebSocket would buy nothing here.

## How the system is built
<!--meta block=architecture-->

The two requirements have opposite shapes, so they get two independent paths. The **price path** is read-only and push-based: a single **price processor** holds the one expensive subscription to the exchange feed and mirrors every tick into a cache and out onto Redis. A **symbol service** holds the open SSE connections and pushes ticks to the users who care — and because those connections are long-lived, the [load balancer](../patterns/distributed/routing/load-balancer.md) uses [sticky sessions](../patterns/distributed/routing/sticky-session.md) to pin each client to the server that owns its stream.

The **order path** is a write path where correctness beats availability. The **order service** owns the user-facing order lifecycle — auth, validation, state transitions, and the order store, which is partitioned by `userId`. It reaches the exchange through an **order dispatch [gateway](../patterns/enterprise/gateway.md)** that presents a small, fixed set of egress addresses to the market and concentrates all exchange-bound traffic through one controlled point. That split is deliberate [separation of concerns](../principles/separation-of-concerns.md): the order service owns what is true for the user, while the dispatcher owns delivery to the exchange — pacing, retries, backoff, and client-order-id dedup. A **trade processor** tails the exchange's trade feed and reflects fills back into the store.

```mermaid caption="The price path: how does one exchange subscription reach every subscribed client without a client ever touching the exchange?"
flowchart LR
    Client["Client app"] -->|"GET /subscribe (SSE)"| LB["Load balancer · sticky"]
    LB -->|"pin to owning server"| Symbol["Symbol service · SSE"]
    Processor["Price processor"] -->|"one feed subscription"| Exchange["Exchange feed"]:::ext
    Processor -->|"mirror tick"| Redis[("Redis pub/sub")]
    Processor -->|"refresh snapshot"| Cache[("Price cache")]
    Symbol -->|"initial snapshot"| Cache
    Redis -->|"fan out tick"| Symbol
    Symbol -.->|"push live price"| Client
    classDef ext stroke-dasharray:4 4;
```

```mermaid caption="The order path: how does an order reach the exchange through one controlled egress, and how does a fill get reflected back into the user's state?"
flowchart LR
    Client["Client app"] -->|"POST /order"| Order["Order service"]
    Order -->|"validate, pending row"| OrderDB[("Order store · sharded by user")]
    Order -->|"submit"| Gateway["Order dispatch gateway"]
    Gateway -->|"paced, deduped order"| Exchange["Exchange"]:::ext
    Exchange -->|"trade feed"| Trades["Trade processor"]
    Trades -->|"reflect fill"| OrderDB
    classDef ext stroke-dasharray:4 4;
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Fanning live prices to millions without melting the exchange

The naïve version — each client polls the exchange — fails twice: 5,000 clients watching the same symbol make 5,000 identical upstream calls, and a poll interval short enough to meet 200&nbsp;ms is unthinkable at this scale. So the exchange is proxied: one price processor subscribes to the feed and everyone else reads from inside the system.

The routing problem is getting a symbol's tick to exactly the symbol-service servers whose users are watching it, and no others. The answer is [publish–subscribe](../patterns/messaging/pubsub.md) over Redis. Each symbol-service server keeps a `Symbol → Set<userId>` map of who is watching what; the first time it has a watcher for a symbol it subscribes to that symbol's Redis channel, and when the last watcher leaves it unsubscribes. When the processor publishes a tick, Redis delivers it only to the servers subscribed to that channel, and each of those servers [fans it out](../patterns/messaging/fan-out.md) to its own watching clients over their SSE streams. The scheme is self-regulating — subscriptions track live demand, so a cold symbol costs nothing and load spreads evenly across the fleet. Disconnects are noticed by heartbeat, which prunes the user from every set and drops now-empty channel subscriptions.

### 2 · Reflecting fills when the feed speaks a different key

Orders are stored partitioned by `userId`, so any one user's orders live on a single shard and their queries hit one node. But the exchange's trade feed reports fills keyed by `externalOrderId` — and from that id alone there is no way to know which shard, or which row, to update. Scanning every shard per trade is a non-starter.

The fix is a small secondary index: a key-value store mapping `externalOrderId → (orderId, userId)`, written by the order service the instant the exchange hands back an id. The trade processor's path is then a clean two-hop lookup — `externalOrderId` → KV store → `userId` → route to the right [shard](../patterns/distributed/routing/sharding.md) → update the order. It is the standard move when your primary partition key isn't the key your inbound events arrive on: keep a second index from the event key to the partition key.

### 3 · Keeping orders consistent across a boundary you don't own

Placing an order touches three systems that can't share one transaction — the order store, the exchange, and the KV index — so the workflow is ordered so that a failure at any step is recoverable, a [saga](../patterns/distributed/coordination/saga.md) (a chain of local steps, each with a recovery path) completed forward rather than an atomic commit:

- **Persist first.** Write the order as `pending` before anything else, so there is a durable record even if a later step dies.
- **Submit.** Call the exchange synchronously; it returns the `externalOrderId`.
- **Record.** Write the KV index entry and move the order to `submitted`, then answer the client.

Each failure has a defined resolution. A failed initial write just fails the request. A submission the exchange rejects marks the order `failed`; one with an unknown outcome, such as a timeout, stays `pending` for the clean-up job. The dangerous case is a submission that succeeded but whose follow-up write did not — the exchange now holds an order the store doesn't know the id of. A background clean-up job handles it: it scans stalled `pending` orders and asks the exchange about them using the client-supplied order id it sent along, an [idempotency](../patterns/messaging/idempotency.md) key that lets it query — and safely re-submit if needed — without ever double-placing. Cancellation mirrors the shape: flip to `pending_cancel` first, then cancel upstream, then confirm, and let the same clean-up drive any stuck cancel to completion.

```mermaid caption="How placing an order stays recoverable across the store, exchange, and index."
sequenceDiagram
    autonumber
    participant C as Client
    participant O as Order service
    participant S as Order store
    participant X as Exchange
    participant K as KV index
    C->>O: place order
    O->>S: write order, pending
    O->>X: submit order
    alt submitted and recorded
        X-->>O: externalOrderId
        O->>K: map externalOrderId to order, user
        O->>S: mark submitted
        O-->>C: accepted
    else submitted but follow-up write lost
        X-->>O: externalOrderId
        O--xK: crash before record
        Note over O,X: clean-up job re-queries by client order id, then records or re-submits
    end
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- One feed subscription per symbol serves millions of screens — about 100M polls a second collapse to a few thousand subscriptions.
- Push over SSE and Redis pub/sub delivers ticks well under 200&nbsp;ms, with load self-balancing to actual demand.
- Every order has a durable record before it ever reaches the exchange, so no fill is silently lost and stuck orders reconcile.

### What it gives up
<!--meta polarity=con-->

- Sticky SSE sessions make the symbol service stateful — rebalancing or a node failure drops connections clients must re-establish.
- The order path spans three systems with no distributed transaction, so correctness leans on an eventual clean-up rather than an atomic commit; until the sweep runs, a stalled order shows pending and misses the 200 ms target.
- The lone price processor and the narrow exchange egress are concentrated dependencies; either failing stalls all prices or all order submission.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end flow (subscribe → stream prices; place/cancel → exchange → store), a clean API and data model, and the key insight that the system must proxy the exchange rather than let clients reach it.
- **Senior** — argues push over polling, details the Redis pub/sub fan-out and why SSE needs sticky sessions, and designs the order workflow with the partition key and partial-failure consistency in mind.
- **Staff+** — frames the whole design around the two hard non-functionals from the first minute, and volunteers the `externalOrderId`↔`userId` key mismatch and its index, the reconciling clean-up with client-order-id idempotency, and the order-service-vs-dispatcher split as an operational reality.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Dual-Write Inconsistency](../hazards/dual-write-inconsistency.md) — the exchange accepts the order but our write of its id fails; the client order id and the sweeper contain it
- [Hot Key](../hazards/hot-key.md) — a few dozen hot symbols draw one tick toward millions of open streams; watchers spread across many servers

**Demonstrates**

- [Publish-Subscribe](../patterns/messaging/pubsub.md) — each symbol's price is published to a Redis channel so a tick reaches only the symbol-service servers that have a subscriber for it
- [Fan-Out](../patterns/messaging/fan-out.md) — a symbol-service server that receives one tick pushes it out to every server-sent events (SSE) client watching that symbol
- [Sticky Session](../patterns/distributed/routing/sticky-session.md) — the load balancer pins each long-lived server-sent events (SSE) client to the server that owns its stream
- [Gateway](../patterns/enterprise/gateway.md) — all exchange-bound order traffic is funnelled through one dispatch gateway with a small fixed egress
- [Sharding](../patterns/distributed/routing/sharding.md) — the order store is horizontally partitioned by userId so a user's orders and queries live on one node
- [Idempotency](../patterns/messaging/idempotency.md) — a client-supplied order id lets the clean-up job query and re-submit stuck orders without ever double-placing
- [Saga](../patterns/distributed/coordination/saga.md) — placing an order is a persist-then-submit-then-confirm sequence across three systems, reconciled forward by a background clean-up
- [Separation of Concerns](../principles/separation-of-concerns.md) — the order service owns user-facing order truth while the dispatcher owns exchange-facing delivery, retries and pacing
- [Sweeper](../patterns/distributed/coordination/sweeper.md) — a clean-up job scans stalled pending orders, asks the exchange what became of them, and drives each one to completion or failure
- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — The load balancer pins each client to the server that owns its price stream, using sticky sessions

<!-- relationships:end -->
