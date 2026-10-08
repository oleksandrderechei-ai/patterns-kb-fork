---
title: Google News
description: Aggregate thousands of publishers into precomputed regional feeds and serve an infinite scroll to 100M users in under 200 ms
area: designs-intermediate
owner: Oleksandr Derechei
tags: [caching, read-optimization, latency]
status: stable
aliases: [news aggregator, news feed]
solves: [my feed takes seconds to load because I query and rank millions of rows on every request, new items keep shifting my pages so users see the same post twice or skip past others while scrolling, reads outnumber writes a million to one and one database cannot survive a traffic spike, content shows up hours late because I only poll each source every few hours, my cache expires and every request for the same page stampedes the database at once]
---

# Google News

A news aggregator pulls articles from thousands of publishers and presents each reader a single, endlessly scrollable feed for their region. Nobody reads the whole catalogue — they read the top of a regional slice, over and over — so the design is read-first: precompute the feed each region needs and keep it in memory, rather than assembling it from millions of rows on every request.

## Understanding the problem
<!--meta block=description-->

A news aggregator ingests content from thousands of publishers, each with its own feed format and cadence, and serves a scrollable feed to hundreds of millions of readers who click through to the publisher's site. It hosts the index, not the articles. A trickle of new articles meets a flood of feed reads, so the page walks through the read-heavy design that delivers each region's feed fast and fresh.

## Explained
<!--meta block=explain-->

A news aggregator stores no articles, only an index of them, and keeps each region's newest 2,000 or so as a ready-made list in memory, updated the moment an article is saved, so reading a feed page is one lookup. News reading is regional, so you deploy each region on its own and a spike in one leaves the others at normal load. A region's list is only a few megabytes, so do not split the data across servers; the limit is read throughput, and you meet it with many read-only copies of the one list. Choose this over caching each feed for 30 minutes when you need seconds of freshness: when a hot entry expires, every request misses together and floods the database.

- **Pipeline to run.** A change feed, queue and workers keep lists current, so keep a way to rebuild one when a worker dies.
- **Publisher-bound freshness.** Pushes arrive in seconds but polling takes minutes, so poll big publishers every 5 to 10 minutes.
- **Category pairs.** Caching every category and region pair multiplies entries, so filter categories in memory instead.

**Example.** A breaking story puts 10 million readers in one region, each fetching about one page a second. One Redis instance serves about 100,000 requests a second, so 10,000,000 / 100,000 = 100 read copies of that region's list. Each copy holds about 2,000 articles, a few megabytes. A publisher posts a new article: a worker adds it to the list and trims it back to 2,000, and a reader's next page of 20 is one lookup under 5 ms. The database sees none of the 10 million reads.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. View an aggregated feed of recent articles drawn from thousands of publishers, scoped to the reader's region.
2. Scroll that feed “infinitely” — page after page, without duplicates or gaps.
3. Click an article and be redirected to the publisher's website for the full content.

Out of scope: interest-based customisation, saving articles, and social sharing — named explicitly so the core stays narrow. (Categories and personalisation return as extensions at the end.)

### Non-functional
<!--meta requirement=nfr-->

- **Availability > consistency** — a reader would rather see a slightly stale feed than an error page, so the CAP (consistency, availability, partition tolerance) trade tips toward availability.
- **Latency** — a feed page returns in under 200&nbsp;ms.
- **Freshness** — a published article reaches the relevant feeds within about 30&nbsp;minutes (tightened to seconds for cooperating publishers).
- **Scale** — 100M daily actives, spiking toward 500M, and up to ~10M concurrent readers in one region during a major story.

## Right-sizing
<!--meta block=sizing-->

**Reads.** 100M DAU (daily active users) refreshing 5–10 times a day is 0.5–1B feed requests/day ≈ **5,800–11,500 req/s** on average. News is bursty, so the breaking-news peak of **~10M concurrent readers in one region** sizes the system.

**Writes.** Across thousands of publishers, even a busy news hour yields only 50–100 new articles, which is 0.014–0.028 writes a second. Reads outrun writes by roughly 200,000 to 800,000 to one (5,800 ÷ 0.028 up to 11,500 ÷ 0.014), so the design is built around a read cache, not a fast database.

**Working set.** A reader only ever sees the top of the feed, so what has to be fast is the last **~1,000–2,000 articles per region**, not the whole archive. As sorted article ids plus light metadata that is a few megabytes per region — it fits in memory, no sharding required.

**Cache fan-out.** One Redis instance serves on the order of **~100k req/s**. Assume each reader fetches one page a second, so peak is ~10M req/s; at ~100k req/s per instance that is 10M ÷ 100k ≈ 100 replicas of that region's feed. A reader who refreshes every 10 s would need ~10. This is a read-throughput problem, not a storage one, since the data itself is tiny.

## Core entities
<!--meta block=entities-->

Three entities carry the whole system:

- **Article** — the unit of content: `id`, `title`, `summary`, `thumbnail_url`, `published_at`, `publisher_id`, `region`, and the canonical `url` on the publisher's site. Note there is no article body — the aggregator only indexes, it does not host.
- **Publisher** — a content source: `id`, `name`, `site_url`, `feed_url`, `region`, and a priority tier that decides how often it is polled.
- **User** — `id` and `region`, the latter inferred from IP or set explicitly. Tracked even for anonymous readers, because region alone selects which feed to serve.

## The interface
<!--meta block=interface-->

One read endpoint does the work. It starts as offset pagination and is upgraded, in the first deep dive, to an opaque cursor — the client just echoes back whatever `next_cursor` it was handed:

```http summary="HTTP — fetch a feed page, then click through"
GET /feed?region=US&limit=20&cursor={opaque}
→ 200 {
     "articles": [ { "id", "title", "summary",
                     "thumbnail_url", "url", "published_at" }, ... ],
     "next_cursor": "opaque-token-for-the-next-page"
   }

# Clicking an article is client-side: the browser navigates to
# article.url on the publisher's site. A real product would route
# the click through a tracking redirect for analytics:
GET /article/{id}   → 302 Found  Location: https://publisher.example/story
```

There is deliberately no “get one article” endpoint — the full story lives on the publisher, and the feed row already carries the URL the browser needs.

## How the system is built
<!--meta block=architecture-->

Split the system along its load asymmetry into an **ingestion side** and a **serving side**, deployed and scaled independently because they have nothing in common: one is write-light, batchy and background; the other is read-heavy, spiky and user-facing.

The **Data Collection Service** polls each publisher's RSS feed (a lightweight XML-over-HTTP syndication format), extracts and normalises each article, downloads its lead image, and writes two places: article metadata to the **article store**, and a resized thumbnail to [object storage](../patterns/distributed/routing/object-storage.md) — the system keeps its own copy rather than hotlinking, so a slow or vanished publisher image never breaks the feed UI. Every write to the store emits a [change-data-capture](../patterns/distributed/coordination/change-data-capture.md) event; **Feed Generation Workers** consume those events and splice the new article into each affected region's feed. That regional feed is the heart of the design — a Redis sorted set, ordered by publish time, holding just the recent articles a region needs. It is a [materialized view](../patterns/distributed/coordination/materialized-view.md) of the store, maintained incrementally, so a read never has to assemble it.

On the serving side, the client hits an [API gateway](../patterns/distributed/routing/api-gateway.md) (routing, auth, rate limiting, validation), which forwards to the **Feed Service**. That service does almost nothing: one read of the newest slice of the region's sorted set and it has the page. Thumbnails are served straight from a [content delivery network (CDN)](../patterns/distributed/routing/cdn.md) in front of object storage, never touching the application tier.

```mermaid caption="How does a published article reach a reader's feed? Ingestion writes the store and, via CDC, keeps each region's feed set current; serving is one sorted-set read, and thumbnails go client↔CDN, bypassing the app tier."
flowchart TB
    Pub["Publishers · RSS feeds"]:::ext
    Ingest["Data Collection Service"]
    DB[("Article store")]
    Obj[("Object storage + CDN · thumbnails")]
    Workers["Feed Generation Workers"]
    Redis[("Redis · regional feed sorted sets")]
    Feed["Feed Service · behind API gateway"]
    Client["Client / browser"]
    Pub -->|"poll RSS feed"| Ingest
    Ingest -->|"write article"| DB
    Ingest -->|"store thumbnail"| Obj
    DB -->|"change-data-capture event"| Workers
    Workers -->|"add to region feed, trim to newest"| Redis
    Client -->|"GET /feed"| Feed
    Feed -->|"read newest page of region set"| Redis
    Obj -->|"thumbnail bytes via edge"| Client
    classDef ext stroke-dasharray:4 4;
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Keeping pagination stable while the feed grows

Offset pagination (`OFFSET (page-1)*limit`) is the obvious first move and it quietly breaks. New articles are inserted at the top while a reader scrolls, which shifts every row down: articles they already saw reappear on the next page, and articles in between get skipped entirely. During a busy news hour that drift hits within a single browsing session.

- **Timestamp cursor.** Return the `published_at` of the last row and page with `WHERE published_at < cursor ORDER BY published_at DESC`. Because the query anchors to a fixed point instead of a moving offset, inserts no longer shift the window. But batch imports produce many articles sharing one timestamp, and a strict `<` silently skips same-timestamp siblings.
- **Composite cursor.** Break the tie by pairing timestamp with id — `WHERE (published_at, id) < (cur_ts, cur_id)` with a composite index on `(published_at, id)`. This is the tuple-comparison approach large timelines use; it is correct but adds cursor encoding and a slightly larger index.
- **Monotonic ids (chosen).** If article ids are time-ordered from birth — ULIDs, or a sequence — the id alone is the ordering. The cursor collapses to `WHERE id < cursor_id ORDER BY id DESC` against one index: no timestamps, no ties. For chronological data like a news feed this is both the simplest and the fastest, at the cost of committing to the id scheme up front (a real migration if you started with random UUIDs (universally unique identifiers)).

### 2 · Serving a feed page in under 200&nbsp;ms

At 0.5–1B feed requests a day, a per-request database query — filter millions of articles by region, sort by time, paginate — will blow the latency budget even with perfect indexing. The fix is to stop querying on read and serve a precomputed feed from memory.

- **TTL cache-aside.** Cache each region's feed in a Redis sorted set (`feed:US`) with, say, a 30-minute TTL (time to live); on a miss, query the store, populate, return. This is [cache-aside](../patterns/caching/cache-aside.md), and it has two problems. Up to 30 minutes of staleness fights the freshness goal, and — worse — when a hot region's entry expires, every concurrent request misses at once and stampedes the database, a [cache stampede](../hazards/cache-stampede.md) that degrades latency for minutes at a time.
- **CDC-driven precompute (chosen).** Drop the TTL and keep the feed continuously fresh instead. When ingestion writes an article, a change-data-capture event reaches the Feed Generation Workers, which `ZADD` it (score = the article's numeric sequence id, which must fit in 53 bits because a Redis score is a double; a 128-bit ULID cannot be the score; member = the article id, with the body in a separate hash, so an edited article replaces rather than duplicates) into every affected regional set and then `ZREMRANGEBYRANK` to trim back to the recent ~1–2k — bounding memory without any TTL. Reads become a pure `ZREVRANGE` in under 5&nbsp;ms, freshness is measured in seconds, and there is no expiry to stampede. The cost is a real pipeline (CDC, a queue, workers) to operate and a rebuild path: re-read a region's newest ~2,000 articles from the store and ZADD them into a fresh set, while readers keep using the old one.

```python summary="Redis — maintain a regional feed, then read a page"
# worker, on a CDC "new article" event
for region in affected_regions(article):
    ZADD  f"feed:{region}"  score=article.id  member=article.id
    ZREMRANGEBYRANK  f"feed:{region}"  0  -2001   # keep newest ~2000

# Feed Service, on GET /feed?region=US&cursor=ID
#   ids are monotonic, so the cursor is just an id / score
ZREVRANGEBYSCORE  "feed:US"  (cursor_id  -inf  LIMIT 0 20
```

The chosen precompute has two halves: a write-side worker that maintains the sorted set, and a read that never touches the database.

```mermaid caption="How does a new article reach a regional feed without any read touching the database?"
sequenceDiagram
    participant Ing as Ingestion
    participant W as Feed Generation Workers
    participant R as Redis feed:US
    participant FS as Feed Service
    participant C as Client
    Ing->>W: CDC new-article event
    W->>R: ZADD (score = monotonic article id)
    W->>R: ZREMRANGEBYRANK (trim to recent ~2k)
    C->>FS: GET /feed?region=US&cursor=ID
    FS->>R: ZREVRANGEBYSCORE (cursor, LIMIT 20)
    R-->>FS: 20 articles
    FS-->>C: feed page
```

### 3 · Getting breaking news in within 30 minutes

Baseline polling runs every 3–6 hours — fine for a magazine, useless for a fast-moving story readers already saw on social media. Freshness is a spectrum of cooperation with the publisher.

- **Tiered polling.** Poll by priority — major outlets every 5–10 minutes, mid-tier every 30, niche every few hours — and use ETags / `Last-Modified` to skip unchanged feeds. Cheap and unilateral, but still reactive: even 5-minute polling lags real time, and newer publishers may have no RSS at all.
- **Intelligent scraping.** For publishers without a feed, crawl their homepage for new links via known selectors and a fingerprint set of seen URLs, then normalise into the same ingestion pipeline. A fallback, not a primary path — HTML changes break extractors, and it raises legal questions.
- **Webhooks + fallback (chosen).** Flip pull to push: cooperating publishers `POST /webhooks/article-published` the instant they publish, authenticated by an HMAC signature over the body plus a timestamp check to reject replays. Ingestion dedupes by a hash of the canonical URL, so a polled and a pushed copy of one article become one. Content lands in feeds within ~30 seconds via the same CDC-to-cache path. It needs publisher buy-in, so it can't be rolled out unilaterally — hence the hybrid: webhooks for premium partners, frequent polling for cooperative feeds, scraping for the rest.

### 4 · Thumbnails without melting the origin

Only thumbnails render in-feed (the full story is on the publisher), but at 100M+ readers even thumbnails are a delivery problem.

- **Blobs in the database.** Storing 20–50&nbsp;KB of image bytes per row alongside metadata bloats backups, evicts real query workload from memory, and collapses past a few thousand articles. A textbook example of what object storage exists to prevent — rejected outright.
- **Simple Storage Service (S3) with direct links.** Downsize once, upload to object storage, store the URL; browsers load images directly, off the app tier. Better, but distant readers pay latency to a single region and there is one fixed size for every screen.
- **Object storage + CDN, multiple sizes (chosen).** Keep object storage as origin, front it with a CDN (content delivery network), and generate a few sizes (mobile / desktop / retina) chosen client-side via `srcset`. With a high edge hit rate, edge caching cuts origin requests by an order of magnitude and keeps global loads fast, so serving more variants costs less overall.

### 5 · Surviving a breaking-news spike

News consumption is inherently regional — Americans want US news, Europeans want EU news — which is the structural gift that makes 10M concurrent tractable. Deploy per region so each cluster handles only its own traffic; a spike in one region leaves the others at baseline. Then walk each tier under peak load:

- **Feed Service.** One app server handles tens of thousands of connections, nowhere near 10M. Because instances are [stateless](../patterns/distributed/routing/stateless-service.md), they scale out horizontally behind a [load balancer](../patterns/distributed/routing/load-balancer.md) — [auto-scaling](../patterns/distributed/routing/autoscaling.md) groups spin instances up on CPU pressure and back down when the story cools.
- **Cache tier.** This is the real scaling target, since it now absorbs essentially all read traffic. A region holds only ~2,000 articles, so a single master fits the whole dataset — no sharding needed. The axis is pure read throughput, solved by [replication](../patterns/distributed/coordination/replication.md): writes hit the master, reads fan out across a fleet of read replicas (~100 at one request per reader per second, see sizing), replicate through intermediate replicas so the master feeds only a few directly, and Redis Sentinel promotes a replica if the master dies. Replication lag is usually well under a second; a failover can lose the last few writes, which the rebuild path repairs.
- **Database.** Never in the read path once the cache is precomputed, so it never sees 10M concurrent reads at all — the cache shields it entirely.

```mermaid caption="How does one region's cache tier absorb ~10M concurrent readers without sharding? Replicate the single master, fan reads across replicas."
flowchart TB
    Workers["Feed Generation Workers"] -->|"ZADD + trim, writes only"| Master[("Redis master · region feed")]
    Master -->|"replicate, lag <200 ms"| R1["Read replica 1"]
    Master -->|"replicate, lag <200 ms"| R2["Read replica ~100"]
    Feed["Feed Service fleet"] -->|"ZREVRANGE reads"| R1
    Feed -->|"ZREVRANGE reads"| R2
    Sentinel["Redis Sentinel"] -->|"monitor"| Master
    Sentinel -.->|"promote on master failure"| R1
```

### 6 · Beyond one regional feed — categories and personalisation

Two common extensions, and in both the tempting answer over-builds:

- **Categories.** Rather than maintain a separate sorted set per category-and-region pair (25 categories × 10 regions = 250 caches to invalidate), store full article metadata as the cached member and filter in memory: pull the region's top ~1,000 with one `ZREVRANGE` and keep the ones tagged `sports`. Reading 1,000 members plus filtering is ~10&nbsp;ms, each article is still stored once, and the CDC cache is reused unchanged — the straightforward option wins.
- **Personalisation.** Scoring thousands of articles against 100M profiles on every request is billions of calculations an hour — hopeless inside 200&nbsp;ms. Per-user feed caches explode memory (1,000 articles × 50M active users). The workable answer stores a tiny per-user preference vector and assembles a feed on demand by mixing a handful of existing category caches (e.g. 60% tech + 30% business + 10% trending), boosting trending weight during breaking news. Roughly 100× less memory than per-user caches, with an ML model tuning the mix — the heavy ranking itself is left as a black box, out of scope here.

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- A feed page is one in-memory sorted-set read (~5&nbsp;ms), so the 200&nbsp;ms budget holds even at a 10M-concurrent regional peak.
- CDC keeps feeds fresh within seconds of ingestion (end to end, seconds for webhook publishers, 5–10 minutes for polled majors) and removes the TTL-expiry stampede that plagues cache-aside.
- Ingestion and serving scale on independent axes — one batchy and write-light, the other spiky and read-heavy.
- Regional deployment contains blast radius: a spike in one region never touches another's capacity.

### What it gives up
<!--meta polarity=con-->

- The precomputed feed duplicates article data across regional (and category) caches — more memory and a pipeline to keep in sync.
- Availability is chosen over consistency: a just-published article is briefly absent, and a replica can trail the master by ~200&nbsp;ms.
- CDC, a queue and workers are real operational surface — corruption or a worker crash needs an explicit cache-rebuild path.
- Seconds-level freshness depends on publisher cooperation; without webhooks you fall back to polling and its minutes-to-hours lag.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end flow: a collector polls sources into a store, a feed service returns a region's recent articles, pagination works, and clicks redirect to the publisher. Recognises that reads dominate and that a cache helps.
- **Senior** — drives the read-first framing, replaces offset pagination with cursors unprompted, designs the precomputed feed cache and its freshness mechanism (why TTL isn't enough, why CDC is), and separates ingestion from serving on their different scaling profiles.
- **Staff+** — treats the system as regional from the first minute, volunteers the CDC pipeline with its failure and rebuild story, sizes the Redis replica fleet for a breaking-news spike, and reasons about the freshness ladder, thumbnail delivery, and categories/personalisation as extensions of the same cache rather than rewrites.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Cache Stampede](../hazards/cache-stampede.md) — The baseline TTL expires a hot region's feed and every reader misses at once.

**Demonstrates**

- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — each region's feed is a Redis sorted set precomputed and maintained incrementally, so a read never assembles it from the store
- [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) — every article write emits a change event that workers consume to splice the article into affected regional feeds within seconds
- [Cache-Aside](../patterns/caching/cache-aside.md) — the baseline serves each regional feed from Redis with misses falling through to the article store before the design upgrades to change data capture (CDC)
- [CDN](../patterns/distributed/routing/cdn.md) — thumbnails are cached at edge point of presences (POPs) in front of object storage, giving sub-200ms global loads and cutting origin requests by 90%+
- [Object Storage](../patterns/distributed/routing/object-storage.md) — the system downloads its own resized thumbnail copy into S3-style object storage and keeps binary blobs out of the database
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — a single gateway fronts the Feed Service for routing, auth, rate limiting, and request validation before requests reach it
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — Feed Service instances hold no per-request state, so auto-scaling groups add and drop them freely during a breaking-news spike
- [Replication](../patterns/distributed/coordination/replication.md) — a regional Redis master takes writes while ~100 read replicas absorb the feed reads, with Sentinel promoting on master failure
- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — Stateless Feed Service instances scale out behind a load balancer to reach 10M connections
- [Autoscaling](../patterns/distributed/routing/autoscaling.md) — Instance groups spin up on central processing unit (CPU) pressure and back down, so the Feed Service tracks the daily load curve

<!-- relationships:end -->
