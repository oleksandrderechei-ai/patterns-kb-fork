---
title: CamelCamelCamel
description: "Track prices on 500M no-API products by crowdsourcing a browser extension, validating the reports, and alerting on drops within the hour"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [event-driven, read-optimization, availability, validation]
status: stable
aliases: [price tracker, price history tracker]
solves: [I need to watch prices on a site that has no API and blocks scrapers, my notification cron scans the whole table every couple of hours and still misses the alerts people care about, rendering a price chart means aggregating thousands of raw points on every request and blows my latency budget, I have to track hundreds of millions of items but I can only poll a few per second per IP, some of my crowdsourced data is wrong or malicious and it fires false alerts that erode trust]
---

# CamelCamelCamel

CamelCamelCamel watches the price of Amazon products over time and emails a subscriber the moment one drops below their threshold. Amazon has no public API and rate-limits scrapers hard, so the defining move is to turn a million-user browser extension into the price-collection network — then validate what it reports, react to changes as events, and serve history from a time-series store.

## Understanding the problem
<!--meta block=description-->

A price tracker shows a chart of an Amazon product's price history and alerts a user when the price falls below a threshold they set, from a website and a Chrome extension. The hard part is invisible: Amazon has no price API and throttles to about one request a second per IP, yet 500 million products need fresh prices. This page walks through collecting that data and sending alerts reliably.

## Explained
<!--meta block=explain-->

A price tracker for a site with no price feed gets its readings from the browsers of people already visiting the pages: an extension reports each price it sees, and a slow crawler fills only the gaps. Choose this over crawling everything when you have a crowd of users and the site limits you to about 1 request a second per address, because crawling alone cannot keep up, however many servers you add. For storage, choose a time-series add-on to the database you already run over a second engine, because one system to operate matters more at this size.

- **Uneven coverage.** Rarely viewed products go stale, so treat any subscribed product with no recent reading as the crawler queue.
- **Hostile prices.** Accept a change and alert, but send big drops to a verification crawl within 5 minutes; a wrong alert can fire briefly.
- **Stale charts.** Charts trail the true price, so show the time of each reading beside it.

**Example.** The site has 500 million products and allows 1 request a second per address. One crawler needs 500 million seconds, about 16 years, for one pass; 1,000 addresses still need about 6 days. With 1 million extension users, a reading arrives whenever someone views a product. A report says a phone costs 1 cent, a huge drop, so the alert goes out and a verification crawl starts. It finds 999 dollars within minutes, you send a correction, and that reporter loses trust.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. View the price history of an Amazon product, from the website or the extension.
2. Subscribe to a price-drop notification with a user-set threshold, from either surface.
3. Receive the alert (email) once a tracked price falls below the threshold.

Out of scope: product search and discovery, cross-retailer price comparison, and reviews/ratings — named so the design stays on collection and alerting.

### Non-functional
<!--meta requirement=nfr-->

- **Availability over consistency** — eventual consistency for price data is acceptable; the read and alert paths must stay up.
- **Scale** — ~500M products tracked; a ~1M-user extension feeding data.
- **Latency** — price-history chart queries under 500&nbsp;ms.
- **Freshness of alerts** — a price drop reaches the subscriber within 1&nbsp;hour of being reported or crawled; products no one views rely on the backstop crawler (see Coverage in the tradeoffs).
- **Politeness** — stay inside Amazon's ~1 req/sec/IP limit while serving millions of users.

## Right-sizing
<!--meta block=sizing-->

**Why crawling alone is hopeless.** At ~1 request/sec/IP, a single crawler needs ~500M seconds — about **16 years** — for one full pass over 500M products. Throw 1,000 IPs at it and a full catalogue refresh still takes **~6 days**, during which most price moves go unseen; and Amazon adds ~3,000 new products a day that a crawl order may not reach for weeks. Brute force does not close the gap, so the million-user extension becomes the lever, not an afterthought.

**Reads.** Chart queries must return under 500&nbsp;ms. A popular product accumulates years of observations — many thousands of raw points — that have to be bucketed into daily or weekly averages per chart. Aggregating that on every request is exactly what blows the latency budget, so reads want precomputed or time-series-native aggregation.

**Writes.** Price observations are append-only and reach into the **billions of rows**, but they are cheap, uniform, and — crucially — most products change price rarely. That means the stream of genuine price changes is far smaller than the write volume, which is what keeps event-driven alerting affordable.

## Core entities
<!--meta block=entities-->

Four entities, split across two stores by access pattern:

- **Product** — an Amazon item being tracked: `product_id` (the ASIN), title, current price, page metadata. ~500M of them.
- **Price** — one time-series observation: `product_id`, `observed_at`, `price_cents`, `source`. Append-only, billions of rows, and the raw material behind every chart.
- **User** — a subscriber, with contact info and notification preferences.
- **Subscription** — links a user to a product with a `price_threshold` and `notification_type`; it is the thing an incoming price change is checked against.

Product, User and Subscription are ordinary CRUD (create, read, update, delete) records that live in a **Primary DB**. Price is a different animal — high-volume, append-only, read as time ranges — so it gets its own time-series **Price DB**. Keeping them apart is the first sign of separating concerns by load shape rather than by domain noun.

## The interface
<!--meta block=interface-->

Two public endpoints — one per functional requirement — plus one internal endpoint the extension calls to report what it sees. The product id sits in the path (cache- and REST-friendly), and a `granularity` parameter lets long ranges return coarse buckets and recent ranges return fine ones. Money is integer cents, never floats.

```http summary="HTTP — read history, subscribe, and report a price"
GET /products/{product_id}/price?period=30d&granularity=daily
→ 200 [ { "t": "2026-07-01", "avg": 1299, "min": 1249, "max": 1319 }, … ]

POST /subscriptions
{ "product_id": "B0ABC123",
  "price_threshold": 999,
  "notification_type": "email" }
→ 200 { "subscription_id": "sub_8f2a" }

POST /prices           # extension → backend, not public
{ "product_id": "B0ABC123",
  "price": 1249,
  "observed_at": "2026-07-19T10:15:00Z",
  "source": "extension" }
→ 202 Accepted     # accepted at once; a suspicious report is re-crawled within minutes
```

## How the system is built
<!--meta block=architecture-->

Everything enters through an [API gateway](../patterns/distributed/routing/api-gateway.md) that authenticates, throttles, and routes. Behind it the system splits along its natural seams, because the pieces scale on completely different curves — this is [separation of concerns](../principles/separation-of-concerns.md) drawn along load shape. The **collection** path (extension reports plus a backstop crawler) writes append-only into the time-series Price DB. The **read** path — a Price History Service — does nothing but turn a product id and range into a chart, which it answers by bucketing the raw points on demand in the time-series store rather than scanning them row by row. The **subscription** path is ordinary CRUD against the Primary DB. And the **notification** path is event-driven: a price change in the Price DB becomes an event, and a notification consumer decides who cares.

The crawler and the reporting endpoint are deliberately the throttled boundary: outbound scraping stays inside Amazon's ~1 req/sec/IP ceiling with a [rate limiter](../patterns/distributed/resilience/rate-limiter.md), so the extension — not more crawler hardware — is what provides scale.

```mermaid caption="Collection (left) feeds an append-only time-series store; reads serve charts from it; a change stream drives who-cares alerting. The crawler is the one rate-limited boundary."
flowchart LR
    Client["Extension + website"] -->|"report price"| GW["API gateway · auth, throttle"]
    Client -->|"GET price history"| GW
    Client -->|"POST subscription"| GW
    GW -->|"append point"| PriceDB[("Price DB · time-series")]
    Crawler["Backstop crawler · ≤1 req/s to Amazon"] -->|"append point"| PriceDB
    GW -->|"chart read"| History["Price history service · bucket aggregation"]
    GW -->|"manage subs"| Subs["Subscription service"]
    History -->|"range query"| PriceDB
    Subs -->|"CRUD"| PrimaryDB[("Primary DB · users, subs")]
    PriceDB -->|"price-change event"| Notifier["Notification consumer"]
    Notifier -->|"who subscribed?"| PrimaryDB
    Notifier -->|"email alert"| Client
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Discovering and tracking 500M products under a rate limit

There are two sub-problems, both hard for the same reason — the ~1 req/sec/IP ceiling: discovery (find all 500M products, plus ~3,000 new ones a day) and monitoring (re-check prices often enough to catch drops).

- **Naïve crawling.** Seed URLs, extract product links, follow recursively with a frontier queue and a visited set. The math kills it: 16 years per pass on one IP, ~6 days even with a thousand, and new products can go undiscovered for weeks. Thousands of crawl servers are also economically silly. Rejected.
- **Prioritised crawling.** Popularity follows a Pareto curve, so score products by interest — more subscriptions, more searches — and refresh high-interest items every few hours, mid tier daily, the long tail weekly. Successful alerts feed the score back. Much cheaper, but there is a cold-start gap: a hot new release has no interest signal yet, exactly when its price is most volatile.
- **Extension + selective crawling — this design's answer.** Reuse the million-user extension as a crowdsourced sensor network. While a user browses Amazon, the extension parses the product id, current price and metadata from the DOM (Document Object Model) and reports it to the internal `POST /prices` endpoint. This naturally weights collection toward what people actually look at, and it turns the extension's scale from a constraint into the advantage. The crawler drops to a backstop: covering products no one has viewed lately and registering brand-new pages when a user first lands on them. The catch — niche, low-traffic products still update rarely, and now some reports are wrong or hostile, which is the next dive.

### 2 · Trusting a million strangers' price reports

With a million reporters, some fraction will be mistaken, glitching, or malicious. The nightmare case is someone reporting the latest iPhone at $0.01 and firing thousands of false alerts, sending users to Amazon to find the real price — trust gone.

- **Consensus validation.** Hold each report in a pending state and count how many distinct users reported the same price for a product inside a window. Accept once a threshold is met — say 3 confirmations for a popular item, 2 for an obscure one, more when the impact is large (a $500 drop needs more corroboration than a $2 one). Reputation can weight trusted reporters higher. It defends against a lone bad actor, but it delays legitimate changes on thinly-watched products (missing flash sales), and a coordinated group could still beat the threshold.
- **Trust-but-verify — this design's answer.** Accept a reported change immediately and alert right away, but flag suspicious ones — a big drop, an unreliable reporter, a high-subscriber product — for a high-priority verification crawl that runs within 1–5 minutes on the existing crawler at elevated priority. If the crawl contradicts the report, send a correction and dock the reporter's trust score. Most data flows instantly for fast alerts, while bad data is caught in minutes before it does lasting damage. The cost is complexity and extra verification load on Amazon, which nudges back against the rate limit.

### 3 · From polling scans to event-driven alerts

The naïve notifier is a cron every two hours that scans the Price table for recent changes, then joins against subscriptions. It misses the 1-hour SLA (service-level agreement) and its full scans get heavier as the data grows. The reframe is to stop asking "what changed in the last two hours?" and instead react to "who cares about this change?" the instant it lands — an [event-driven](../patterns/architecture/eda.md) pipeline.

- **Change data capture.** [CDC](../patterns/distributed/coordination/change-data-capture.md) reads the database's write-ahead log and publishes each price insert as a change event (product id, old price, new price). No trigger runs on the write path, and no collection service has to remember to emit an event; the log is the source.
- **Dual writes.** Collection services write the DB and publish the event in one step. More control — you can drop insignificant fluctuations or batch a rapid flurry before publishing, and skip trigger overhead — at the cost of writing the emit logic yourself. The two writes are not atomic: a crash between them drops the event, and a retry can duplicate it. A transactional outbox table closes the gap.

Either way, price-change events land on a Kafka topic that notification consumers subscribe to — [publish/subscribe](../patterns/messaging/pubsub.md) that decouples collection from alerting. A consumer looks up only the subscriptions for that one product and emails the ones whose threshold is now met. Per-event lookups replace full-table scans, and because most products rarely move, event volume stays modest even at billions of rows.

```mermaid caption="How does a price change reach the right inboxes inside the hour? The change is published once, and a consumer looks up only that product's subscriptions instead of scanning them all."
flowchart LR
    Coll["Collection service"]
    Price[("Price table")]
    Topic[("Kafka price-change topic")]
    Cons["Notification consumer"]
    Subs[("Subscriptions")]
    Email["Email to subscribers"]:::ext
    Coll -->|"1 insert price"| Price
    Price -->|"2 publish product id, old price, new price"| Topic
    Topic -->|"3 deliver event"| Cons
    Cons -->|"4 look up one product's subscriptions"| Subs
    Cons -->|"5 email where threshold is met"| Email
    classDef ext stroke-dasharray:4 4;
```

### 4 · Serving chart queries under 500&nbsp;ms

Plain PostgreSQL indexed on `(product_id, timestamp)` misses the target for popular products: a two-year chart aggregates thousands of raw points on the fly.

- **Scheduled pre-aggregation.** A nightly job computes daily/weekly/monthly summaries — average, min, max, open, close — into a `price_aggregations` table keyed by `(product_id, granularity, date)`. The chart API reads a few dozen precomputed rows in milliseconds instead of aggregating thousands. This is a classic [materialized view](../patterns/distributed/coordination/materialized-view.md): it trades storage and up-to-24-hour staleness for read speed — fine for historical trends.
- **TimescaleDB (chosen).** A time-series extension for the same Postgres that already holds users and subscriptions, so there is no second system to run. It aggregates on demand — `time_bucket('1 day', ts), avg(price) … GROUP BY 1` — returning millisecond results over billions of rows via automatic partitioning and compression, at any range or granularity, with no pre-aggregation job to maintain. ClickHouse was considered for raw analytical throughput, but TimescaleDB won on the operational simplicity of one unified Postgres stack.

```mermaid caption="Trust-but-verify (dive 2): how does a stranger's report become an alert without a bad one doing lasting damage? Alert fires first; only suspicious reports pay for a verification crawl."
flowchart TB
    R["Price report arrives"] -->|"accept immediately"| A["Alert subscribers now"]
    A -->|"big drop / weak reporter / hot product"| V["Verification crawl — 1–5 min, elevated priority"]
    A -->|"looks routine"| Keep["Kept as-is"]
    V -->|"crawl confirms"| Keep
    V -->|"crawl contradicts"| C["Send correction, dock trust score"]
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- A million browsers become the collection fleet, weighted to the products people actually watch, with no crawler army; verification and backstop crawls still share the ~1 req/sec/IP budget.
- Event-driven delivery via CDC and Kafka replaces full-table polling scans with per-change lookups, comfortably inside the 1-hour alert SLA.
- Time-series partitioning and on-demand bucket aggregation keep chart queries under 500&nbsp;ms even over billions of price rows.

### What it gives up
<!--meta polarity=con-->

- Coverage is uneven — niche, low-traffic products the extension rarely sees go stale, and brand-new items lag until someone views them.
- Trust-but-verify alerts on unverified data first, so a bad report can fire a false alert in the minutes before a verification crawl corrects it.
- Availability is chosen over consistency: price data is eventually consistent, and charts trail the true price by the reporting and verification delay; niche products trail until someone views them.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working high-level design covering both requirements (history display and alert subscriptions), a sound schema (products, users, subscriptions, prices), and a simple scraper for collection. Recognises, with a nudge, that polling every product does not scale and that some prioritisation is needed.
- **Senior** — names data collection as the core challenge and drives toward the extension; reasons through the crawl-strategy trade-offs and the 500M-at-1-req/sec math; explains why polling notifications don't scale and proposes an event-driven queue; goes deep on a couple of dives.
- **Staff+** — treats the extension as the key to the data problem, not just a feature; discusses starting simple while designing for eventual scale; ties data-validation quality to user trust and retention; and surfaces the unasked — anti-scraping countermeasures, extension-user privacy, and resilience to Amazon changing its page structure.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [API Gateway](../patterns/distributed/routing/api-gateway.md) — a single gateway fronts every client request, authenticating, rate-limiting, and routing chart reads, subscriptions and price reports to the right service
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — Amazon caps scraping near one request per second per Internet Protocol (IP), so the crawler and reporting boundary are throttled and the whole design is built to stay polite
- [Event-Driven Architecture](../patterns/architecture/eda.md) — notifications flip from a two-hour polling scan to reacting to each price-change event the instant it lands
- [Publish-Subscribe](../patterns/messaging/pubsub.md) — price-change events land on a Kafka topic that notification consumers subscribe to, decoupling collection from alerting
- [Separation of Concerns](../principles/separation-of-concerns.md) — collection, history reads, subscriptions and notification each become their own service because their scaling profiles diverge
- [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) — the database's write-ahead log is read for each price insert and published as a change event, so no collection service has to remember to publish

<!-- relationships:end -->
