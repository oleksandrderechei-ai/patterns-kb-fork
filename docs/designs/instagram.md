---
title: Instagram
description: Serve a 500M-user chronological feed in under 500 ms by precomputing feeds on write and pushing media to the edge
area: designs-intermediate
owner: Oleksandr Derechei
tags: [scalability, read-optimization, latency]
status: stable
aliases: [IG]
solves: [my feed takes seconds to load because I recompute it from every account a user follows on each request, one popular account posts and it triggers millions of feed writes that grind my system to a halt, users far from my storage region wait several seconds for photos and videos to appear, uploading a multi-gigabyte video in a single request fails and hammers my application servers, every popular post gets re-queried independently by millions of separate feed requests]
---

# Instagram

A photo and video sharing platform where people post media, follow each other, and scroll a chronological feed. Almost all the load is reading feeds and viewing media, so the design pushes work off the read path: feeds are assembled when someone posts, and media is served from the edge rather than the origin.

## Understanding the problem
<!--meta block=description-->

Instagram lets a user post a photo or video, follow accounts and see a chronological feed of what those accounts posted. Half a billion people open it daily and refresh often but post rarely, with heavy media on top. The two hard problems are assembling a feed fast enough and delivering media fast enough everywhere, and the page walks through both.

## Explained
<!--meta block=explain-->

Instagram builds each follower's feed when someone posts, not when the follower reads: a background worker adds the new post's id to a stored list for every follower, and a read slices that list. Media never passes through your servers; the client uploads straight to object storage and viewers download from edge caches near them. Size the two loads separately: about 150,000 feed requests a second against about 1,200 posts a second, and media is the storage bill. Choose building on write over assembling at read time because one refresh would otherwise need about 100 parallel batch reads.

- **Celebrity fan-out.** An account with 200 million followers means 200 million writes, so above a threshold merge its posts at read time.
- **Two feed paths.** The threshold leaves two paths and slower reads for people who follow many giants, so retune it as the network grows.
- **Feed store loss.** Feeds sit in Redis, so run replicas with persistence; rebuild a lost feed on its next read, at about 10,000 candidate reads.
- **Delay.** A new post may take up to 2 minutes to appear, which the availability goal accepts.

**Example.** A user follows 1,000 accounts that each post about 10 times a day, so one refresh would gather about 10,000 candidate posts; at 150,000 refreshes a second that cannot work. Instead, an ordinary author with 500 followers causes 500 list writes in the background. A celebrity with 200 million followers is over a 100,000 threshold, so no list is written, and at read time the follower's page merges that celebrity's latest posts with the stored list. Media is 100 million posts a day x 2 MB = 200 TB a day.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Create a post with a photo or video and a simple caption.
2. Follow another user — a one-directional relationship.
3. See a chronological feed of posts from the accounts you follow.

Out of scope, named on purpose to keep the design narrow: likes and comments, search over users or hashtags, ephemeral stories, and live streaming.

### Non-functional
<!--meta requirement=nfr-->

- **Availability over consistency** — a new post appearing in followers' feeds within ~2 minutes is fine; the system must not go dark.
- **Feed latency** — a feed request returns end-to-end in under 500&nbsp;ms.
- **Media latency** — photos and videos render effectively instantly, wherever the viewer is.
- **Scale** — 500M daily actives, ~100M posts/day.

## Right-sizing
<!--meta block=sizing-->

**Feed reads.** 500M DAU (daily active users) × ~5 refreshes/day ≈ 2.5&nbsp;billion feed generations per day ≈ ~29k/s on average. Traffic is spiky and time-zone-clustered, so budget for a peak of **150k+ feed requests/second**. That number is the one the read path must survive.

**The cost of computing at read time.** A user following 1,000 accounts, each posting ~10 times a day, has ~10,000 candidate posts behind a single refresh. Fetching those on demand means many database reads per refresh — and DynamoDB batch reads cap at 100 items, so even one refresh needs ~100 parallel batch calls. Multiply by 150k/s and read-time assembly cannot keep up. The computation has to move to write time.

**Writes.** 100M posts/day ≈ **~1,200 posts/second** on average. Small next to reads — but each post can fan out to a poster's entire follower set, so the write path is where amplification hides. Fan-out writes per second = 1,200 posts/s × average followers per author, so an ordinary author with 500 followers adds 500 list writes.

**Storage.** Media dominates: at ~2&nbsp;MB average, 100M posts/day ≈ **200&nbsp;TB/day** of bytes, roughly **750&nbsp;PB over ten years**. Metadata is a rounding error by comparison — ~1&nbsp;KB/post ≈ **100&nbsp;GB/day**. The media number forces object storage plus cold tiers; the metadata number fits any scalable key-value store. The 200 TB/day counts originals only; per-upload variants add to it.

## Core entities
<!--meta block=entities-->

Four entities, kept thin:

- **User** — username and profile details.
- **Post** — a caption, a creator, a created-at timestamp, and a reference to its media. One Post type covers both photos and videos; the media kind is just a field.
- **Media** — the actual bytes, kept out of the database and in an object store.
- **Follow** — a one-directional edge from follower to followee. Following `@leomessi` puts his posts in your feed, not yours in his.

## The interface
<!--meta block=interface-->

A small representational state transfer (REST) surface — one verb per requirement. The create-post call returns metadata plus a place to upload the bytes; it never carries the file itself through the app tier.

```http summary="HTTP — post, follow, feed"
POST /posts
{ "media_type": "video", "media_size": 52428800, "caption": "My cool photo!" }
→ 201 { "post_id": "p_123", "upload_url": "https://s3...<one pre-signed URL per part, or a multipart upload id>" }

POST /follows
{ "followed_id": "u_456" }          // follower_id comes from the auth token, not the body
→ 201

GET /feed?cursor={cursor}&limit={page_size}
→ 200 { "posts": [ ... ], "next_cursor": "..." }
```

The follower's identity is taken from the session or JWT (JSON Web Token) rather than the request body — a small application of [least privilege](../patterns/security/least-privilege.md) that stops a caller from writing follow edges on behalf of anyone else. The feed uses **cursor**-based pagination, not offsets, so a page stays stable while new posts arrive at the top.

## How the system is built
<!--meta block=architecture-->

Clients hit an [API gateway](../patterns/distributed/routing/api-gateway.md) that routes, authenticates, and rate-limits. Behind it, the write and read halves of the feed are deliberately separate. A **Post Service** stores metadata and hands out a pre-signed URL so the client uploads media directly to the [object store](../patterns/distributed/routing/object-storage.md) (Simple Storage Service, S3), keeping multi-gigabyte transfers off the app servers. A **Follow Service** owns the (much lower-frequency) follow graph. The pivotal piece is the **Feed Fan-out workers**: every new post is enqueued, and whichever worker claims it pushes that post's id into the precomputed feed of each follower, held in Redis as a per-user sorted set. They are interchangeable [competing consumers](../patterns/messaging/competing-consumers.md) on one queue, so throughput is a question of how many you run. A **Feed Service** then serves a read by slicing the top of that sorted set and hydrating post ids into full posts. Media is fronted by a [content delivery network (CDN)](../patterns/distributed/routing/cdn.md) so bytes are served from an edge near the viewer.

Post metadata lives in a horizontally scalable store — DynamoDB here for its scale and tolerance of [eventual consistency](../themes/consistency-and-replication.md), though the real Instagram famously runs PostgreSQL at this scale, a reminder that "SQL doesn't scale" is folklore, not fact. Post and Follow services may even share a database: the domains are naturally coupled, and the textbook "database per service" rule is one large systems routinely break where the coupling is real.

```mermaid caption="The write path fans a new post out to followers' precomputed feeds asynchronously; the read path slices Redis and hydrates ids. Media flows directly between client and the blob store's CDN edge, never through the app tier."
flowchart TB
    Client["Client / app"]
    Post["Post Service"]
    Feed["Feed Service"]
    Q[["Fan-out queue"]]
    Fanout["Feed Fan-out workers"]
    DDB[("Posts DB")]
    Redis[("Redis feeds (ZSET)")]
    Media["Blob store + CDN edge · S3"]:::ext
    Client -->|"POST /posts"| Post
    Client -->|"GET /feed"| Feed
    Post -->|"write metadata"| DDB
    Post -->|"pre-signed upload URL"| Media
    Post -->|"enqueue post_id"| Q
    Q -->|"deliver post"| Fanout
    Fanout -->|"prepend to each follower feed"| Redis
    Feed -->|"top N post_ids"| Redis
    Feed -->|"hydrate ids"| DDB
    Media -->|"media bytes from edge"| Client
    classDef ext stroke-dasharray:4 4;
```

## Deep dives
<!--meta block=deepdives-->

### 1 · A feed under 500&nbsp;ms

The naïve design assembles the feed on read: look up who you follow, query each of their recent posts, merge, sort by time, return. It is correct and it does not scale. Three things go wrong at once — **read amplification** (one refresh needs about 100 parallel batch calls, times 150k/s), **repeated work** (a single popular post is independently re-fetched by millions of separate feeds), and **unpredictable latency** (your feed is only as fast as the busiest account you follow).

So flip it: compute the feed **when someone posts**, not when a follower reads — a [fan-out](../patterns/messaging/fan-out.md) on write. On a new post, look up the poster's followers (via a secondary index keyed by `followed_id`) and prepend the new post id to each follower's feed. Because a post can have millions of followers, this is a long-running job that must be asynchronous: the post is durably stored, a job is dropped on a [message queue](../patterns/messaging/message-queue.md), and workers do the fan-out off the critical path. Each follower's feed is a Redis sorted set — `feed:{user_id}`, members are post ids, scores are timestamps — an incrementally maintained [materialized view](../patterns/distributed/coordination/materialized-view.md) of "what this user should see," ready to slice in a single call.

Reads then hydrate ids into posts. Doing one lookup per id re-introduces an N+1 read; instead, keep a short-lived Redis hash of post metadata and treat it [cache-aside](../patterns/caching/cache-aside.md) — read the hash, batch-fetch only the misses from DynamoDB with `BatchGetItem`, backfill the hash. A caption edit just invalidates that one entry.

```python summary="Pseudocode — fan-out on write, then read"
# on new post (async worker)
followers = follows_gsi.query(followed_id=post.author)   # secondary index
for f in followers:
    redis.zadd(f"feed:{f}", {post.id: post.created_at})   # sorted set, score = time
    redis.zremrangebyrank(f"feed:{f}", 0, -1001)          # keep newest ~1000

# on read
ids   = redis.zrevrange(f"feed:{user}", start, start + limit - 1)   # top N by score
# use the last score as the cursor for keyset paging
metas = redis.hmget("post:meta", ids)                          # cache-aside
miss  = [i for i, m in zip(ids, metas) if m is None]
metas += dynamo.batch_get_item(miss)                          # only the misses
```

One flaw remains: **write amplification, the "[celebrity problem](../hazards/hot-key.md)."** A user with 200M followers posts once and the fan-out is 200M Redis writes — a self-inflicted [thundering herd](../hazards/thundering-herd.md) that stalls the queue and slows every other poster. The fix is a **hybrid**: fan out on write for ordinary accounts, but for anyone over a threshold (say **100k followers**) skip the fan-out entirely and store the post only. At read time, the Feed Service serves the precomputed feed and merges in the recent posts of the handful of celebrities you follow, fetched live. Most accounts get instant precomputed feeds; the few enormous ones get a live merge of their recent posts. The threshold needs tuning — too low and write amplification returns, too high and too many users pay the read-time merge cost.

Storing feeds in Redis invites the durability question. Run it as a real datastore: append-only-file persistence with everysec fsync, so a crash loses up to about a second of writes, Redis Cluster to shard feeds, with a replica per shard for automatic failover. If a feed is lost, it can be rebuilt from the source of truth in the Posts DB — the sorted set is a cache of a derivation, not the derivation itself. A lost feed is rebuilt lazily on its owner's next read, at about 10,000 candidate reads.

### 2 · Rendering media instantly

Two distinct problems: getting big files in, and getting them out fast everywhere.

**Upload.** A single HTTP request tops out well below the 4&nbsp;GB a video can reach, and routing gigabytes through the app tier wastes bandwidth and app-server memory. So `POST /posts` returns a **pre-signed URL** — a scoped, time-boxed credential (a [valet key](../patterns/distributed/routing/valet-key.md)) that lets the client upload straight to S3 using its multipart API, chunk by chunk, with retries per chunk. The post is created with status `pending`; when the upload finishes, an **S3 event notification** fires a background job that records the object key and flips status to `complete`. This server-driven completion is more work than trusting a client `PATCH`, but the backend stays the source of truth for whether media actually landed.

**Download.** Serving raw S3 URLs means a viewer in Singapore waits on a bucket in `us-east-1` — multi-second stalls, every request hitting the origin, and the same full-resolution file shipped to a phone on 4G as to a desktop. A CDN (content delivery network) fixes the distance: edge caches hold media near viewers, fetch from S3 only on a miss, and cache images for hours since they never change. The best version adds a media-processing step that generates variants per upload — multiple resolutions, WebP for browsers that take it, adaptive bitrate ladders for video — and the CDN serves the variant that fits the requesting device and network. More storage and a processing pipeline to run, but it is what every large media platform actually does.

A video never passes through the app tier; the sequence below shows how a post becomes complete.

```mermaid caption="How does a large upload reach S3 and flip the post from pending to complete without crossing the app tier?"
sequenceDiagram
    participant C as Client
    participant A as App tier
    participant S as S3
    participant J as Background job
    C->>A: POST /posts
    A-->>C: pre-signed URL (post status pending)
    C->>S: multipart upload, chunk by chunk
    S->>J: event notification
    J->>A: record object key, status complete
```

### 3 · Holding at 500M DAU

Precomputed hybrid feeds keep the read path a single Redis slice plus one live read per celebrity the user follows. The CDN keeps media latency flat as the audience globalizes. Chunked, direct uploads keep large writes off the app tier. Metadata sits in a store [sharded](../patterns/distributed/routing/sharding.md) by user id, with a composite `(created_at, post_id)` sort key so a user's posts come back already in chronological order. And cost is managed by **tiering**: warm bytes sit at the edge and in cache, cold media ages down to cheaper storage such as Glacier — walking the ladder from CDN → memory → solid-state drive (SSD) → hard disk drive (HDD) → tape as access frequency drops. Every service tier autoscales horizontally behind a [load balancer](../patterns/distributed/routing/load-balancer.md) on CPU and memory pressure.

```mermaid caption="The celebrity hybrid: ordinary authors fan out to followers' feeds on write; huge accounts (≥ 100k) skip the fan-out storm and are merged into each feed live at read time."
flowchart TB
    Post["New post"] -->|"always store post_id"| DDB[("Posts DB")]
    Post -->|"author < 100k followers: enqueue"| Q[["Fan-out queue"]]
    Q -->|"deliver"| Fanout["Feed Fan-out workers"]
    Fanout -->|"prepend to each follower feed"| Redis[("Redis feeds (ZSET)")]
    Feed["Feed Service"] -->|"top N precomputed"| Redis
    Feed -->|"merge celebrities' recent posts live"| DDB
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Feeds return from one Redis slice; the 500&nbsp;ms budget holds while hydration misses and the celebrity merge fit inside it.
- Read-time cost is paid per follower at write time, instead of re-computed on each of 2.5B daily refreshes.
- Media is served from an edge near the viewer, and multi-gigabyte uploads bypass the app tier entirely.
- Every tier scales horizontally and independently, matched to a lopsided read/write load.

### What it gives up
<!--meta polarity=con-->

- The celebrity split forces a hybrid with a follower threshold that must be tuned and re-tuned as the network grows.
- Two feed paths (precomputed plus live celebrity merge) run in parallel — more storage, more moving parts, uneven latency for users who follow many celebrities.
- Feeds are eventually consistent: a new post may take up to ~2 minutes to reach followers on the precomputed path.
- Keeping feeds in Redis demands real durability engineering, and per-upload media variants multiply storage cost.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end design covering upload, follows, and feed; a simple schema for storing and retrieving posts; may start with fan-out on read but, prompted, recognizes its limits and reaches fan-out on write; grasps S3 for media and why a CDN helps, even without the optimization details.
- **Senior** — nails the two deep dives; argues fan-out on read vs. write vs. hybrid and why the hybrid solves the celebrity problem; handles large-file upload properly; details an indexing strategy for a read-heavy workload and justifies each technology choice.
- **Staff+** — identifies feed generation and media delivery as the real bottlenecks within minutes and spends the time there; discusses how the design evolves from 1M to 500M users, favouring simpler solutions until scale genuinely forces complexity; shows operational instinct — failure modes, durability, and user experience above all.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Hot Key](../hazards/hot-key.md) — A 200M-follower account concentrates one post's traffic on a single fan-out job and its cached entries.
- [Thundering Herd](../hazards/thundering-herd.md) — One celebrity post triggers 200M feed writes at once and stalls the queue; the follower threshold is the mitigation.

**Demonstrates**

- [Fan-Out](../patterns/messaging/fan-out.md) — a new post is fanned out on write, prepending its id into every follower's precomputed feed
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — each user's Redis sorted-set feed is an incrementally maintained projection of what they should see, ready to slice in one call
- [Message Queue](../patterns/messaging/message-queue.md) — fan-out is a long-running job dropped on a queue so millions of follower writes stay off the post's critical path
- [Cache-Aside](../patterns/caching/cache-aside.md) — post metadata is served from a short-lived Redis hash, with only the misses batch-fetched from DynamoDB and backfilled
- [Valet Key](../patterns/distributed/routing/valet-key.md) — POST /posts returns a scoped, time-boxed pre-signed URL so the client uploads media straight to S3
- [Object Storage](../patterns/distributed/routing/object-storage.md) — media bytes live in S3 rather than the database, referenced from post metadata by object key
- [CDN](../patterns/distributed/routing/cdn.md) — media is fronted by edge caches so photos and videos are served from a location near each viewer
- [Sharding](../patterns/distributed/routing/sharding.md) — post metadata is partitioned by user id with a composite time-ordered sort key for chronological reads
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — a fleet of fan-out workers drains the post queue in parallel, each prepending the new post id to one follower's feed
- [Least Privilege](../patterns/security/least-privilege.md) — The follower id comes from the session or JSON Web Token (JWT), never the request body, so a caller cannot write follow edges for someone else
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — Clients hit a gateway that routes, authenticates and rate limits before the Post, Feed and Follow services
- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — Every service tier autoscales horizontally behind a load balancer on central processing unit (CPU) and memory pressure

<!-- relationships:end -->
