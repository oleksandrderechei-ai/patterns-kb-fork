---
title: Yelp
description: "Search ten million local businesses by name, geography, and category under 500 ms on a read-dominated workload"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [scalability, read-optimization, latency]
status: stable
aliases: [local business search, business review app]
solves: [recomputing an average rating with a JOIN on every search result is melting my database, two people reviewing the same place at once keep clobbering each others rating update, the same person can spam one business with a dozen reviews and my app-level guard keeps losing the race, my search crawls the moment I filter by a location box and a name keyword at the same time, I want to search pizza in the Mission but a radius from a point cannot describe a lopsided neighborhood]
---

# Yelp

A local-business platform lets people search for restaurants and services near them and read the reviews that decide where they go. Almost every request is a read — a search or a page view — while reviews trickle in slowly. The design turns on two things: making search understand geography, text, and category at once, and keeping each business's average rating cheap to serve without ever going stale.

## Understanding the problem
<!--meta block=description-->

A local-business search lets users find places by name, location and category, then read reviews and leave one. The workload is overwhelmingly read, about a thousand reads to one write, and the query is hard: it filters on a geographic box, a fuzzy name and a category at once. The page walks through keeping search fast and ratings honest.

## Explained
<!--meta block=explain-->

A local-business search keeps each business's average rating and review count as stored columns, updated as each review is written, and answers a search that combines place, name and category with an index built for each. A plain index on latitude and longitude cannot do a two-dimensional area lookup, so location needs a spatial index, name a full-text ([inverted](../patterns/distributed/coordination/inverted-index.md)) index and category a simple one. Size it before building: about 100,000 reviews a day is about 1 write a second, so you need no queue or consumer pipeline, and 10 GB of businesses and 1 TB of reviews need no sharding. The read shape is the problem, not the volume. Choose one database with spatial and text extensions over a separate search engine, until full-text speed forces the split.

- **Sync gap.** A separate search index is faster but trails the database by seconds and needs a CDC stream; one database needs neither.
- **Rating races.** Two writers can overwrite each other's rating. Make the update conditional on the review count being unchanged, as [optimistic concurrency](../patterns/distributed/coordination/optimistic-concurrency-control.md) does, and retry.
- **Area lookups.** Finding a neighbourhood per query is slow. Look up its area once when the business is written and store its names.

**Example.** A café has 100 reviews averaging 4.0. Two reviews arrive together, a 5 and a 1, and both read count 100. The first writes (4.0 x 100 + 5) / 101 = 4.0099 and sets the count to 101. The second's update fails because the count is no longer 100; it re-reads and computes (405 + 1) / 102 = 3.98. Without the condition, the second write would silently erase the 5. At 1 write a second the retry almost never fires.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Search for businesses by name, location (latitude/longitude), and category.
2. View a business and its reviews.
3. Leave a review on a business — a required 1–5 star rating plus optional text.

A constraint carried through the whole design: a user may leave **only one review per business**. Out of scope: adding or editing the business catalogue, map views, and recommendations.

### Non-functional
<!--meta requirement=nfr-->

- **Latency** — search returns in under 500&nbsp;ms.
- **Availability** — highly available; [eventual consistency](../themes/consistency-and-replication.md) is acceptable (a rating that lags a few seconds is fine).
- **Scale** — 100M daily users and 10M businesses, with reads dwarfing writes by roughly 1000:1.

The interesting non-functionals here are latency and the query shape — every system claims to be fault-tolerant and scalable, so the design focuses on what is specifically hard about search.

## Right-sizing
<!--meta block=sizing-->

**Reads.** 100M daily users issuing searches and page views dominate the load — the read shape, not the volume, is the problem. 100k reviews/day x 1000 reads each is about 100M reads/day, roughly 1,200 reads/s on average, which one primary plus a read replica or cache can carry; a separate search engine is optional.

**Writes.** Reviews are rare next to reads: at a ~1000:1 ratio, 100M users produce on the order of **~100k reviews/day ≈ 1 write/sec**. Even a large surge stays trivial for a single database. This one figure quietly rules out a [message queue](../patterns/messaging/message-queue.md) and a separate write pipeline later on.

**Storage.** 10M businesses × ~1&nbsp;KB ≈ **10&nbsp;GB** of business data. Reviews are larger: 10M businesses × ~100 reviews × ~1&nbsp;KB ≈ **1&nbsp;TB** — still comfortably inside one modern instance. Nothing here forces sharding; the read shape, not the data volume, is the real problem to solve.

## Core entities
<!--meta block=entities-->

Three entities carry the whole model:

- **Business** — `name`, `location` (latitude/longitude), `category`, and a maintained `average_rating` plus `num_reviews`.
- **User** — the person who searches and reviews; present mainly to attribute reviews and enforce the one-per-business rule.
- **Review** — a `rating` (1–5) with optional `text`, joined to one user and one business.

The `average_rating` and `num_reviews` columns on Business are the quiet centre of the design: search results must show a rating, so it has to be a stored value, not something recomputed per query.

## The interface
<!--meta block=interface-->

A small representational state transfer (REST) surface, paginated wherever a call can return many rows:

```http summary="HTTP — search, view, review"
GET /businesses?query&location&category&page
→ 200 Business[]

GET /businesses/{businessId}
→ 200 Business          # business details only

GET /businesses/{businessId}/reviews?page
→ 200 Review[]          # reviews paginated independently

POST /businesses/{businessId}/reviews
{ "rating": 5, "text": "optional" }
→ 201 Created
  (409 Conflict if this user already reviewed this business)
```

Business details and reviews are split into two calls rather than one combined response. A popular business can have thousands of reviews; splitting them lets the review list paginate on its own without bloating every business fetch. The **409** on a duplicate review is the client-visible face of the store-level rule enforced in the second deep dive.

## How the system is built
<!--meta block=architecture-->

An [API gateway](../patterns/distributed/routing/api-gateway.md) fronts everything and routes each request to a service. Search and view are closely related and both read-heavy, so they share a single **Business Service**. Reviews behave completely differently — rare, write-side, and tied to the rating maths — so they get their own **Review Service**; splitting a service is justified when the halves scale differently, and this is exactly that case. Businesses and reviews live together in one primary database, because they are tightly coupled and, at 1&nbsp;TB, small enough that a shared store beats cross-service joins. A dedicated **search index** (Elasticsearch, or Postgres with geospatial and trigram extensions) answers the hard multi-filter queries, and a [change-data-capture](../patterns/distributed/coordination/change-data-capture.md) stream keeps it current with the primary store. At this size the baseline is one Postgres database with spatial and text extensions; the search index and CDC stream above are the scale-up path, taken when full-text speed forces the split (deep dive 3).

```mermaid caption="The read path (gateway → Business Service → search index) carries the load; writes go through the Review Service and propagate to the index via CDC."
flowchart TB
    Client["Client"]
    Gateway["API gateway"]
    Biz["Business Service"]
    Rev["Review Service"]
    DB[("Primary DB — businesses + reviews")]
    Search[("Search index — geo, text, category")]
    CDC["CDC pipeline"]
    Client -->|"search / view"| Gateway
    Client -->|"POST review"| Gateway
    Gateway -->|"read"| Biz
    Gateway -->|"write"| Rev
    Biz -->|"multi-filter query"| Search
    Biz -->|"business + reviews"| DB
    Rev -->|"insert review, bump rating"| DB
    DB -->|"change stream"| CDC
    CDC -->|"index updates"| Search
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Keeping the average rating fresh and cheap

Search results show a rating, so serving it must be cheap. The naïve option — a `JOIN` and `AVG` over the reviews table on every query — gets more expensive as popular businesses accumulate reviews, recomputes work that has not changed, and competes with real reads. A periodic cron that writes an `average_rating` column fixes the cost but introduces staleness: a fresh five-star review on a struggling café would not show up for hours. The right move is to update the rating synchronously as each review is written, incrementally: keep `num_reviews` alongside the average and compute `new_avg = (old_avg × n + new_rating) / (n + 1)` — a few CPU cycles, cheap enough to do inline. This is a maintained [materialized view](../patterns/distributed/coordination/materialized-view.md) of the reviews, one column that turns an aggregate query into a single column read.

The incremental update opens a race: two reviews for the same business read `n = 100, avg = 4.0` at once, each computes a new average from that stale pair, and the second write silently overwrites the first — one review vanishes from the maths. The fix is [optimistic concurrency control](../patterns/distributed/coordination/optimistic-concurrency-control.md): read the current `num_reviews`, attempt the update conditioned on it being unchanged, and if the count moved, re-read and retry. Because writes run at about one per second, contention is essentially nil and a retry practically never fires — which is also why a message queue and a separate consumer, a defensible answer at high write volume, is unneeded complexity here.

### 2 · One review per user, enforced where it can't be bypassed

Checking in application code for an existing review before inserting looks fine and is quietly broken two ways. It is fragile — any other write path (a new service, a data backfill) that does not know the rule can violate it — and it races: two submissions from the same user can both pass the check before either insert lands, producing two reviews. Push the rule down to the store as a unique constraint on `(user_id, business_id)` and both problems dissolve. A duplicate insert now fails deterministically with a database error, surfaced to the client as the 409 from the interface. This is a [conditional write](../patterns/distributed/coordination/conditional-write.md) — the engine, not the application, is the arbiter — and it reflects a general rule of thumb: enforce data constraints as close to persistence as possible so no code path can drift around them.

### 3 · Search that understands geography, text, and category at once

The query is the crux. A latitude/longitude bounding box combined with a wildcard name match is a full table scan without the right index, and a plain B-tree composite index on `(latitude, longitude)` does not help — B-trees model single-dimension ranges and are blind to two-dimensional spatial relationships. Each filter wants its own kind of index: location needs a spatial index built on a [geohash](../patterns/distributed/routing/geohash.md), quadtree, or R-tree; name needs a full-text inverted index; category needs a simple B-tree. A search engine like Elasticsearch supports all three natively and answers the combined query in one shot.

```json summary="Search query — three filters, three index types"
{
  "query": {
    "bool": {
      "must": [
        { "match":        { "name": "coffee" } },
        { "geo_distance": { "distance": "10km",
                            "location": { "lat": 40.7128, "lon": -74.0060 } } },
        { "term":         { "category": "coffee shop" } }
      ]
    }
  }
}
```

The engine must not be the system of record — it is not built for transactional integrity, and losing an index node should never lose data. So the primary database stays authoritative and CDC feeds changes into the index; the index is a read model, and consistency with the store is eventual. There is a simpler alternative worth naming: since the dataset is only ~10&nbsp;GB of businesses, Postgres with its PostGIS (geospatial) and `pg_trgm` (trigram fuzzy match) extensions plus built-in full-text search; PostGIS indexes space with GiST (an R-tree) can serve all three filters from the primary store itself — no second system, no sync pipeline, no consistency gap. It trades some full-text performance at extreme scale for a much simpler operation, and at this data volume that is the better bet. When forced to reason about the geospatial index directly, a quadtree suits businesses well — they cluster densely in cities, and updates are infrequent — followed by a precise second pass with the Haversine great-circle distance, applying the most selective filter (distance) first to shrink the candidate set before the rest.

### 4 · Searching by neighbourhood, not just a radius

People search by place name — "pizza in NYC", "bars in The Mission" — and neighbourhoods are irregular shapes a radius-from-a-point cannot describe. Model each named place as a **polygon**. A `locations` table holds `name`, `type` (city, neighbourhood), and a `polygon` (GeoJSON, sourced from public datasets), indexed by name for a fast text lookup. Both PostGIS and Elasticsearch can test whether a point falls inside a polygon, but computing that membership on every request is wasteful. Instead, precompute it once: when a business is created, resolve which named areas contain it and store the list — `location_names: ["bay_area", "san_francisco", "mission_district"]` — as keyword terms on the record. A neighbourhood search then becomes an inverted-index lookup on `location_names`, the expensive geometry paid once at write time rather than on every query.

```mermaid caption="How does optimistic concurrency stop a concurrent rating update from silently dropping a review? The conditional update fails when the count has moved, forcing a re-read and retry."
sequenceDiagram
    autonumber
    participant A as Review write A
    participant B as Review write B
    participant DB as Business row (num_reviews, avg)
    A->>DB: read n=100, avg=4.0
    B->>DB: read n=100, avg=4.0
    A->>DB: update avg where num_reviews=100
    DB-->>A: applied, num_reviews now 101
    B->>DB: update avg where num_reviews=100
    alt count unchanged
        DB-->>B: applied
    else count moved
        DB--xB: rejected, num_reviews is 101
        B->>DB: re-read n=101, recompute
        B->>DB: update avg where num_reviews=101
        DB-->>B: applied, num_reviews now 102
    end
```

Precomputed `location_names` turn it into an inverted-index lookup; the geometry is paid once, when the business is written.

```mermaid caption="How is a neighbourhood search answered without testing polygons on every request?"
flowchart LR
    New["Business created"] -->|"resolve containing areas"| Locations[("locations table: name, type, polygon")]
    Locations -->|"store location_names as keyword terms"| Biz[("Business record")]
    Query["Search: pizza in The Mission"] -->|"inverted-index lookup on location_names"| Biz
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Multi-filter search — geography, text, and category — answered in one query under 500&nbsp;ms.
- Ratings served as a single column read, updated incrementally and safely under concurrent writes.
- The one-review rule cannot be bypassed by any write path, because the store enforces it.
- Tiny write volume keeps the design simple — no queue, no sharding, no separate rating pipeline.

### What it gives up
<!--meta polarity=con-->

- A separate search index adds a CDC pipeline and an eventual-consistency gap between store and index.
- Choosing Postgres extensions instead keeps it simple but caps full-text performance at very large scale.
- Precomputed `location_names` must be recomputed if a business moves or a neighbourhood boundary changes.
- The design leans on writes staying rare; many writes a second to one business would make the rating retry fire often and reopen the queue-versus-inline question.
- The stored average can drift if a bug skips an update; a periodic recount from the reviews table repairs average_rating and num_reviews.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end design (search → view → review), a sensible answer on average ratings, and, when nudged, the instinct to move the one-review rule toward the store and to reach for the right category of index rather than a plain B-tree.
- **Senior** — nails most deep dives, weighs the index types and picks the right technology with reasons, and is watched for over-engineering: every added component needs a clear justification.
- **Staff+** — spots the simplifying insights and states the conditions under which the complex version would be warranted: Postgres extensions to dodge the search-engine consistency gap, ~1 write/sec meaning no message queue, and ~1&nbsp;TB meaning a read replica or cache instead of sharding.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — the incremental average-rating update reads num_reviews, writes conditioned on it being unchanged, and retries on a lost race
- [Conditional Write](../patterns/distributed/coordination/conditional-write.md) — the one-review-per-user rule is a UNIQUE (user_id, business_id) constraint the engine enforces on insert
- [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) — a change data capture (CDC) stream keeps the search index current with the authoritative primary database
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — a single gateway fronts every request and routes reads to the Business Service and writes to the Review Service
- [Geohash](../patterns/distributed/routing/geohash.md) — location search rides a spatial index (geohash/quadtree/R-tree) that a plain B-tree cannot provide
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — average_rating and precomputed location_names turn expensive aggregates and polygon geometry into single column reads
- [Keep It Simple (KISS)](../principles/kiss.md) — ~1 write/sec rules out a message queue and ~1TB rules out sharding, and Postgres extensions avoid a second search system entirely
- [Inverted Index](../patterns/distributed/coordination/inverted-index.md) — name matching rides a full-text inverted index, not a B-tree scan

<!-- relationships:end -->
