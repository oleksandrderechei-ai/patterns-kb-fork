---
title: Facebook Post Search
description: "Search trillions of posts by keyword in under 500 ms with in-memory inverted indexes, while absorbing a write-heavy firehose of posts and likes"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [partitioning, read-optimization, batching]
status: stable
aliases: [post search, keyword search]
solves: [searching billions of rows with LIKE %keyword% scans the whole table and takes seconds, the same popular searches run over and over and I keep recomputing identical results, I need results sorted by both recency and popularity but re-sorting millions of matches per query is too slow, a viral post takes thousands of like-writes a second and they all hit the same counter, my index has grown to petabytes but almost nobody ever searches most of the terms in it]
---

# Facebook Post Search

A user types a keyword and gets matching posts back in under half a second, ranked by recency or by likes. The twist is that this search is write-heavy rather than read-heavy: posts and likes pour in far faster than searches, so the real problem is maintaining an in-memory inverted index cheaply as the firehose arrives — and doing it without a ready-made search engine.

## Understanding the problem
<!--meta block=description-->

A search box over short posts that people write, like and share, with no Elasticsearch, no Postgres full-text index and nothing pre-built. The constraint moves the question to how you lay out data so a keyword lookup is fast across trillions of posts. Writes dwarf reads, so the engineering sits on the ingestion side, keeping a queryable structure fresh under a torrent of posts and likes.

## Explained
<!--meta block=explain-->

Post search keeps a ready-made dictionary from each keyword to the ids of the posts containing it ([inverted index](../patterns/distributed/coordination/inverted-index.md)), held in memory, so a search is one dictionary lookup instead of a scan. Each entry keeps two copies already ordered, one by time and one by like count. Likes arrive at 100,000 a second against 10,000 searches, so this is a write problem dressed as a search. Copy the shape only where every user gets the same answer to the same query, because then one cached response serves everyone and a cache lifetime under a minute is honest when the contract allows a minute of staleness.

- **Approximate likes.** Writing counts only at milestones like 1, 2, 4, 8 saves writes. Fetch twice the results you need and re-sort by exact count.
- **Lost tail.** Capping entries at a few thousand ids drops the long tail of common keywords. Move rare keywords to object storage, answering in seconds.

**Example.** A post gets 1,000 likes. Writing each one would be 1,000 updates; writing at powers of two, 1 up to 512, is 10 writes, and the stored count is approximate. A user searches taylor sorted by likes and wants 10 results. You read the top 20 from the likes list, ask the like service for each post's exact count, re-sort, and return 10. Storage for ten years is 1 billion posts a day x 365 x 10, about 3.6 trillion posts, which is why entries are capped.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Users can create posts and like posts.
2. Users can search posts by keyword.
3. Users can get results sorted either by recency or by like count.

Out of scope: fuzzy or semantic matching, personalized ranking, privacy filtering, media, and a live-updating result page. Dropping personalization is the load-bearing simplification — with no per-user ranking, the same query returns the same results for everyone, which is what makes the whole thing cacheable.

### Non-functional
<!--meta requirement=nfr-->

- **Latency** — median search under 500&nbsp;ms.
- **Freshness** — a new post is searchable within 1&nbsp;minute of creation.
- **Completeness** — every post is discoverable, including old and unpopular ones; more latency is tolerated for this cold tail than for hot, in-memory results.
- **Availability** — the search path stays up under load.
- **Scale** — write-heavy: roughly 10k posts/sec and 100k likes/sec against ~10k searches/sec that can burst 10× or more.

## Right-sizing
<!--meta block=sizing-->

**Writes.** With 1B users and ~100k seconds in a day, an average of one post per user per day gives 1B ÷ 100k ≈ **10k posts/sec**. Likes run ~10× higher — about **100k likes/sec**. Likes, not posts, are the true firehose, and each one may touch many index entries. Each like updates the likes entry of every keyword in its post, so 100k likes/sec × 10–1,000 keywords is up to 10^6–10^8 score updates/sec before milestone writes; the milestones cut this for popular posts only.

**Reads.** One search per user per day is another 1B ÷ 100k ≈ **10k searches/sec**, spiking 10× on a breaking news event. So reads and writes are the same order of magnitude and the [write-heavy](../themes/scaling-writes.md) like stream is larger than either.

**Storage.** Assume ten years of history at ~1KB of metadata per post: 1B/day × 365 × 10 ≈ **3.6 trillion posts**, or roughly **3.6&nbsp;PB** raw. Nothing that size lives in memory, so the design has to decide what is hot enough to keep there and what can go cold.

## Core entities
<!--meta block=entities-->

Three entities, plus the computed structure the whole design is built around:

- **Post** — the searchable unit: `content`, an author (**User**), a `created_at` timestamp, and an implicit like count.
- **User** — creates posts and likes; present mainly as the author reference.
- **Like** — an event fired when a user likes a post. The system rarely cares about individual likes, only the running count per post.
- **Inverted index — not an entity, the point of the exercise.** A dictionary from keyword to the list of post IDs that contain it, maintained on every write. Everything downstream is about building, ranking, and affording this structure.

## The interface
<!--meta block=interface-->

Two writes and one read. In a real deployment the writes would likely be events on a stream rather than direct calls, but exposing them as endpoints keeps the two paths legible:

```http summary="HTTP — write and query paths"
POST /posts
{ "content": "I saw Taylor Swift at the concert" }
→ 201 { "postId": "p_8f2c" }

POST /posts/:postId/likes
→ 202 Accepted

GET /search?keyword=taylor&sortBy=likes   # sortBy = recency | likes
→ 200 { "postIds": ["p_8f2c", "p_5a11", ...] }
```

Search returns post IDs; hydrating them into full posts is a separate lookup against the Post service, kept off the ranking path so the index only ever moves IDs around.

## How the system is built
<!--meta block=architecture-->

The two paths are wired independently because they scale differently. On the **write path**, posts and likes are published to a Kafka log; an **Ingestion service** consumes it, tokenizes each post into keywords, and appends the post ID into two Redis-backed inverted indexes — a creation index ordered by time and a likes index ordered by score. On the **read path**, requests hit an [API gateway](../patterns/distributed/routing/api-gateway.md) for auth and [rate limiting](../patterns/distributed/resilience/rate-limiter.md), fan out to a horizontally scaled, [stateless](../patterns/distributed/routing/stateless-service.md) Search service, and read the relevant index — fronted by a cache so identical queries never re-touch it. Splitting ingestion from queries, and creation writes from like writes, is what lets each side absorb its own very different volume.

```mermaid caption="Reads flow gateway → search → cache → index; writes flow through Kafka into the ingestion tokenizer, which fans each post out across many keyword entries in both indexes."
flowchart TB
    Gateway["API gateway (auth, rate limit)"]
    Search["Search service (stateless)"]
    Cache[("Search cache / CDN edge")]
    PostSvc["Post and Like service"]
    Kafka[["Kafka ingestion log"]]
    Ingest["Ingestion service (tokenizer)"]
    Creation[("Creation index (Redis list)")]
    Likes[("Likes index (Redis sorted set)")]

    Gateway -->|"GET /search"| Search
    Search -->|"hit"| Cache
    Search -->|"miss"| Creation
    Search -->|"miss"| Likes
    PostSvc -->|"publish posts + likes"| Kafka
    Kafka -->|"consume + tokenize"| Ingest
    Ingest -->|"append post id per keyword"| Creation
    Ingest -->|"update score per keyword"| Likes
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Finding a keyword without a search engine

The naïve answer is to keep posts in a relational table and run `SELECT * FROM posts WHERE content LIKE '%keyword%'`. That scans every row on every query; sharding across M nodes only divides the work by M, so at trillions of rows it is still hopeless — a dead end, not a starting point. The fix is to invert the layout: instead of storing posts and searching their text, precompute a dictionary from each keyword to the post IDs that contain it. This is a maintained [materialized view](../patterns/distributed/coordination/materialized-view.md) over the corpus — the ingestion tokenizer appends to it on every write, so a query is a single dictionary lookup instead of a scan. It lives in Redis, in memory, for speed; durability comes from a Redis-compatible durable store such as MemoryDB rather than plain Redis. The cost it introduces is on the write side: a single post can carry 10–1,000 keywords, so each creation triggers that many index appends.

### 2 · Two sort orders without sorting at query time

A keyword like "taylor" might match tens of millions of posts; fetching every ID, looking up its timestamp and like count, and sorting in the Search service means hundreds of megabytes on the wire and millions of lookups — nowhere near the 500&nbsp;ms budget. Instead, keep the results pre-ordered by storing two indexes per keyword. The **creation index** is a Redis list: writes append, and because posts arrive roughly in time order, the most recent results are simply the tail. The **likes index** is a Redis sorted set keyed on the like count, which keeps entries ordered as scores change with O(log N) per score update, against O(1) for a list append. A search reads from whichever index matches `sortBy` and takes the top slice — no query-time sort at all. The price is doubled index storage and, because likes are so frequent, a steady stream of score updates into the sorted set.

### 3 · Multi-word phrases

A query like "Taylor Swift" is two keywords that must appear together. The straightforward approach is intersect and filter: pull the ID set for each word, intersect them, hydrate the survivors, and keep only those where the words are actually adjacent (ruling out "my friend Taylor made a swift exit"). It works but the per-word sets are enormous, so the intersection and the false-positive filtering are both expensive. The sharper move is to index **bigrams** (adjacent word pairs, borrowing Lucene's "shingles"): "I saw Taylor Swift" yields "i saw", "saw taylor", "taylor swift", so the phrase query hits a single entry directly with no intersection. Bigrams are far more numerous than single words, though — the key space can jump from ~10M to 100M+ — so you only index the pairs likely to be searched, estimating that frequency with a [count-min sketch](../patterns/distributed/coordination/count-min-sketch.md) and falling back to intersect-and-filter when no bigram entry exists.

```mermaid caption="How is a two-word phrase answered — a direct bigram hit, or fall back to intersect-and-filter?"
sequenceDiagram
    autonumber
    participant C as Client
    participant S as Search service
    participant I as Inverted index
    C->>S: GET /search phrase taylor swift
    S->>I: lookup bigram taylor swift
    alt bigram indexed
        I-->>S: post ids from one entry
    else no bigram entry
        S->>I: fetch ids for taylor and swift
        I-->>S: two large id sets
        S->>S: intersect, then adjacency filter
    end
    S-->>C: matching post ids
```

### 4 · Absorbing the write firehose

Two write sources stress the index for different reasons. **Post creation** is heavy because each post fans out into many keyword appends, and a burst can overwhelm a single ingester and drop events. Putting a Kafka log in front turns that burst into a buffer — [queue-based load levelling](../patterns/distributed/resilience/load-leveling.md) — so many ingestion workers can consume in parallel, and [sharding](../patterns/distributed/routing/sharding.md) the indexes by keyword spreads the appends across Redis instances instead of hot-spotting one. **Likes** are worse: far more frequent, and each one is a score update. Two tactics compound. First, [batch](../patterns/concurrency/batching.md) likes over a short window — 500 likes on a viral post in 30 seconds collapse into one `+500` — though this does nothing for a post that gets one like a minute all day. Second, and more powerful, only write the count at milestones: persist at 1, 2, 4, 8, … (powers of two or ten) rather than on every increment, turning 1,000 writes into ten. The stored count is now deliberately approximate — labelled something like `approxLikes` so nobody mistakes it for exact — but ordering stays roughly right (10k likes still outranks 1). To return N precise results you over-fetch the top N×2 from the likes index, ask the Like service for each post's exact current count, and re-rank on the fresh numbers. The 2× over-fetch is a recall bound, not a guarantee. Counts inside one power-of-two bucket tie, and stored counts lag, so a post can sit outside the top 2N and be missed; raise the factor if the exact re-rank often pulls posts from the edge of the slice.

Likes are stored approximately, so the answer is exact only within the fetched slice.

```mermaid caption="How does approximate stored like counts still produce a precise top N?"
sequenceDiagram
    autonumber
    participant S as Search service
    participant L as Likes index
    participant K as Like service
    S->>L: top N x 2 by approxLikes
    L-->>S: 2N post ids
    S->>K: exact current like count per post
    K-->>S: exact counts
    S->>S: re-rank on fresh counts
    S-->>S: keep top N
```

### 5 · Serving reads and storing 3.6&nbsp;PB

On [**reads**](../themes/scaling-reads.md), the no-personalization decision pays off: identical queries have identical answers, and a minute of staleness is allowed, so results are cacheable. A [distributed cache](../patterns/caching/distributed-cache.md) in front of the Search service serves repeated queries with a TTL (time to live) under one minute — checked first, populated on [miss](../patterns/caching/cache-aside.md) — so fresh-enough results never re-touch the index within the TTL. End-to-end staleness is ingest lag plus TTL, so set the TTL to 1 minute minus the measured lag to meet the freshness requirement. Layering a [content delivery network (CDN)](../patterns/distributed/routing/cdn.md) in front and setting `cache-control` on the `/search` response pushes hits to the edge, returning in tens of milliseconds versus the hundreds a full origin round trip costs. On **storage**, most of the 3.6&nbsp;PB is dead weight — nobody searches most keywords, and no one scrolls millions of results deep. So cap each index entry at roughly 1k–10k IDs instead of storing every match, which cuts size by orders of magnitude. Choose the cap from the deepest result page users reach. and run a periodic job over search analytics to evict rarely-searched keywords from Redis into cheap [object storage](../patterns/distributed/routing/object-storage.md) such as Simple Storage Service (S3) or R2. Queries hit Redis first and fall back to the cold tier with a latency penalty — exactly the hot/cold split the completeness requirement allows.

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Median keyword search under 500&nbsp;ms over trillions of posts for hot keywords, served from in-memory inverted indexes and, for hot queries, the edge; cold-tier keywords take seconds.
- Ranking costs no query-time sort over the match set: the creation list and likes sorted set are pre-ordered. Likes ordering still pays a re-rank of the top 2N.
- The write firehose is survivable: Kafka buffers bursts, keyword shards spread appends, and milestone counts cut a popular post's like-writes from N to about log2 N; posts with few likes gain little.

### What it gives up
<!--meta polarity=con-->

- Stored like counts are intentionally approximate; exact ordering needs a query-time re-rank against the Like service.
- Everything hinges on the index staying in memory — durability leans on MemoryDB, and cold-tiered keywords pay a real latency penalty.
- Bigrams and doubled indexes multiply storage, and capping entries silently drops the long tail of matches for very common keywords.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end design: clear API and data model, both the ingestion and query sides built, and a real inverted index rather than a table scan. Proposing a "bad" solution first is fine if it is discussed well; expect the interviewer to probe basics, like a cache's eviction policy.
- **Senior** — moves quickly through the high-level design to spend time on the critical paths. Recognizes the pressure points unprompted — write volume, storage size, and the high rate of duplicate queries — and lands an inverted index plus a caching strategy with the trade-offs argued out loud.
- **Staff+** — treats the system as write-heavy from the first minute and volunteers the hard parts: Kafka fan-out, milestone/approximate counts with a precise re-rank, bigram indexing, and cold tiering, at a config-level of familiarity.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — the inverted index is a precomputed keyword-to-post-ID view the ingestion tokenizer maintains on every write, so a query is a lookup not a scan
- [Cache-Aside](../patterns/caching/cache-aside.md) — the search service checks a distributed cache first and populates it on a miss, with a sub-minute time to live (TTL) matching the freshness service level agreement (SLA)
- [CDN](../patterns/distributed/routing/cdn.md) — hot /search responses are pushed to the edge via cache-control headers, returning in tens of milliseconds
- [Sharding](../patterns/distributed/routing/sharding.md) — the inverted indexes are partitioned by keyword so appends spread across many Redis instances instead of hot-spotting one
- [Batching](../patterns/concurrency/batching.md) — like events are aggregated over a short window so hundreds of likes collapse into a single increment
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — a Kafka log buffers write bursts so parallel ingestion workers drain them without dropping posts
- [Count-Min Sketch](../patterns/distributed/coordination/count-min-sketch.md) — bigram search frequency is estimated with a count-min sketch so only pairs worth indexing get stored
- [Object Storage](../patterns/distributed/routing/object-storage.md) — rarely-searched keyword entries are evicted from Redis into cheap blob storage and read back on a cache miss
- [Message Queue](../patterns/messaging/message-queue.md) — posts and likes are published to a Kafka log the ingestion service consumes, so tokenizing and the two index appends never sit on the write request
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — The read path enters through a gateway that handles auth and rate limiting before the Search service
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — Search requests are rate limited at the gateway so one caller cannot exhaust the query path
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — The Search service holds no state, so instances scale horizontally behind the gateway and read the shared indexes
- [Distributed Cache](../patterns/caching/distributed-cache.md) — A cache with a time to live (TTL) under one minute serves repeated identical queries so they never reach the index
- [Inverted Index](../patterns/distributed/coordination/inverted-index.md) — Keeps keyword-to-post lists in memory so a keyword query reads only its lists, not all posts

<!-- relationships:end -->
