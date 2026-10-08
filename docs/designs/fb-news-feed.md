---
title: Facebook News Feed
description: Assemble each user's reverse-chronological feed at two-billion-user scale by mixing fan-out-on-write with fan-out-on-read
area: designs-intermediate
owner: Oleksandr Derechei
tags: [scalability, read-optimization, asynchrony]
status: stable
aliases: [news feed, social feed, timeline]
solves: [my feed takes seconds to load because I recompute it from scratch on every request, assembling one feed means querying the hundreds of people someone follows and merge-sorting all their posts, "when a user with millions of followers posts, I would have to write to millions of feeds at once", a single viral post gets hammered so hard that one database shard falls over while the rest sit idle, one account with a huge following brings my whole write path to its knees every time it posts]
---

# Facebook News Feed

A social news feed shows a user the recent posts of everyone they follow, newest first, with infinite scroll. At two billion users the whole design turns on one word — fan-out: do you assemble each feed when a post is written, when it is read, or in a blend of the two?

## Understanding the problem
<!--meta block=description-->

A news feed pulls recent posts from a user's follows into one reverse-chronological stream. Get the followed accounts, get their posts, sort by time: simple until one reader follows thousands of accounts or one author has tens of millions of followers. Either extreme turns one request into an avalanche of downstream work, called fan-out. The page designs for that, drawing on the Scaling Reads playbook.

## Explained
<!--meta block=explain-->

A news feed builds each reader's list ahead of time: when someone posts, background workers add the post id to a stored list for every follower ([fan-out on write](../patterns/messaging/fan-out.md)), so reading a feed is one lookup however many accounts the reader follows. Choose this over assembling the feed at read time once readers follow thousands of accounts, because one request would otherwise fan out into thousands of queries. The lists are cheap: 200 ids at 10 bytes is 2 KB a user. Set the cutoff for skipping precomputation by measuring your follower counts.

- **Celebrity writes.** A post from an account with 90 million followers means 90 million writes. Skip those accounts and merge their posts at read time.
- **Shallow paging.** Scrolling past the stored 200 posts falls back to the slow query; the design bets few readers go that deep.
- **Hot cache shard.** One viral post can overload its shard. Keep full cache copies on several machines, accepting colder starts and fewer posts cached.

**Example.** You follow 2,000 accounts, one of them with 90 million followers. A friend with 300 followers posts: 300 list updates run in the background. The big account posts: workers skip it, so there are 0 list updates instead of 90 million. When you open the feed, one lookup returns your 200 stored ids and one live query adds the big account's recent posts, merged by time. Storage for all of it is 2 KB x 2 billion users, about 4 TB. A viral post read 500 times a second splits across 10 cache copies at 50 each.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Create a post.
2. Follow another user — a uni-directional link (unfollow is out of scope).
3. View a feed of posts from followed users, newest first.
4. Page through that feed indefinitely (infinite scroll).

Out of scope: likes, comments, and private or restricted-visibility posts. Users are assumed already authenticated, with a `userId` available in the session or JWT (JSON Web Token).

### Non-functional
<!--meta requirement=nfr-->

- **Availability over consistency** — a stale feed is harmless; a feed that fails to load is not. The classic CAP (consistency, availability, partition tolerance) lean.
- **Bounded staleness** — a new post may take up to ~1&nbsp;minute to surface in a follower's feed.
- **Latency** — both post creation and feed reads target under 500&nbsp;ms.
- **Scale** — 2B users, with no cap on follows per user or followers per account.

## Right-sizing
<!--meta block=sizing-->

**Reads dominate.** With a large fraction of 2B users opening the feed several times a day, the read path faces on the order of hundreds of thousands of feed assemblies per second at peak. The saving grace is that almost everyone reads only the first handful of items before losing interest. Caching the top of each feed pays off enormously.

**Writes amplify.** A post is one write until you ask who must see it. An author with F followers turns a single post into F feed updates. For an ordinary account that is a few hundred; for a mega-account with 90M+ followers it is 90M writes for one post — the number that breaks the naive design and forces everything downstream. To land inside the one-minute window, a 90M-follower post needs about 1.5M feed writes a second and a 1M-follower post about 17k a second. Set the skip cutoff where the write rate your workers sustain no longer meets that.

**Storage is the easy part.** Precompute each user's feed as a list of ~200 post IDs at ~10&nbsp;bytes each ≈ 2&nbsp;KB/user; across 2B users that is roughly **4&nbsp;TB** — trivial for a modern fleet. Taking a fraction of a cent per user per month (an assumption) against about $100 a year of ad revenue per active user (an assumption), storage is small next to the latency it buys. The 4&nbsp;TB is one copy of the ids; multiply by the replication factor.

## Core entities
<!--meta block=entities-->

Three domain entities, plus one computed structure the deep dives build toward:

- **User** — an account in the system.
- **Follow** — a uni-directional edge from `userFollowing` to `userFollowed`. Many-to-many, but a purpose-built graph database would be overkill; a plain key-value table with the right indexes answers every query we need.
- **Post** — authored by a user, with a `creatorId`, a `createdAt`, and an intentionally generic `content` body so rich formats can be added later.
- **PrecomputedFeed — can be rebuilt.** A per-user list of ~200 post IDs in reverse-chronological order, keyed only by `userId`. It is not a source of truth but a materialization of the two entities above; it earns its own section below.

## The interface
<!--meta block=interface-->

One endpoint per requirement. The auth token rides in the header and is not spelled out here.

```http summary="HTTP — post, follow, read"
POST /posts
{ "content": { } }
→ 200 { "postId": "..." }

PUT /users/{userId}/follow
→ 200 OK          // PUT, so a double-click is idempotent; unfollow would be DELETE

GET /feed?pageSize={n}&cursor={oldestSeenTimestamp}
→ 200 { "items": [ Post ], "nextCursor": "..." }
```

The follow verb is a **PUT** on purpose: following someone twice must be the same as following them once. Pagination uses a **cursor** rather than a page number — because the feed is strictly chronological, the timestamp of the oldest post you have already seen is all the state a page needs, and each request returns the next n posts older than it. Two posts can share a timestamp, so the cursor carries the oldest seen postId as well; a request past the 200th post is served by the slow path.

## How the system is built
<!--meta block=architecture-->

Writes and reads have opposite shapes, so they get separate services behind a shared gateway. A horizontally scaled, [stateless](../patterns/distributed/routing/stateless-service.md) **Post Service** persists posts to a key-value store partitioned for even load; a secondary index on `(creatorId, createdAt)` lets anyone's posts be read back in time order. Rather than assemble feeds at read time, post creation drops a small message onto a [queue](../patterns/messaging/message-queue.md) and returns immediately; a fleet of fan-out workers does the heavy lifting asynchronously, writing each new post into its followers' precomputed feeds. The **Feed Service** then reads a user's precomputed feed and hydrates the post bodies through a cache — so a feed request rarely touches the primary store at all.

```mermaid caption="The write path returns as soon as the post is queued; workers fan it out off the critical path, and the read path is served almost entirely from precomputed feeds and the cache."
flowchart TB
    Client["Client / app"]
    PostSvc["Post Service (stateless)"]
    PostDB[("Post store + creatorId/createdAt index")]
    Queue[["Fan-out queue"]]
    Workers["Fan-out workers"]
    FeedDB[("Precomputed feed store")]
    FeedSvc["Feed Service"]
    Cache[("Replicated post cache")]
    Client -->|"POST /posts"| PostSvc
    Client -->|"GET /feed"| FeedSvc
    PostSvc -->|"write post + index"| PostDB
    PostSvc -->|"enqueue postId + creatorId"| Queue
    Queue -->|"deliver to worker"| Workers
    Workers -->|"prepend to each follower's feed"| FeedDB
    FeedSvc -->|"read post IDs"| FeedDB
    FeedSvc -->|"hydrate bodies + live celebrity posts"| Cache
    Cache -->|"miss"| PostDB
```

## Deep dives
<!--meta block=deepdives-->

### 1 · A user who follows thousands of accounts

Assembling a feed at read time fans out on read: one request explodes into a query per followed account, then a merge-sort of everything they posted. Tens to hundreds of downstream queries is tolerable; thousands is not, given a 500&nbsp;ms budget. Flip the work to write time instead. Maintain a [materialized view](../patterns/distributed/coordination/materialized-view.md) of each feed — the **PrecomputedFeed** table, keyed by `userId`, holding roughly the last 200 post IDs in reverse-chronological order. A read becomes a single point lookup plus a cache hydration, no matter how many accounts the user follows. Paging past the 200th post is deliberately unsupported and falls back to the slow naive query; real users almost never scroll that deep, the same bet a search engine makes by refusing to show you page 100 of results. The cost of this move is that all the work now lands on the write side — which is the next problem.

### 2 · An author with millions of followers

Precomputing feeds means a single post from a high-follower account must be written into millions of feed records, all inside the one-minute staleness window.

- **Bad — blast synchronously.** Have the Post Service push all the fan-out writes itself at creation time. It collapses on connection limits and the latency budget, and load lands wildly unevenly — one host drowning in millions of writes while the rest idle — which is exactly what you cannot scale.
- **Good — async workers.** Enqueue `{ postId, creatorId }` and let a fleet of [competing consumers](../patterns/messaging/competing-consumers.md) drain the [queue](../patterns/messaging/message-queue.md), each looking up the author's followers and prepending the post to their feeds. The queue smooths the burst so post creation never blocks. At-least-once delivery means a message can be redelivered, so the prepend must be [idempotent](../patterns/messaging/idempotency.md) — applying the same post to a feed twice has to be a no-op. Worker load still varies enormously between a small account and a giant one, so very large fan-outs may be split into smaller tasks. Make the prepend a no-op by skipping it when the postId is already in the feed. Alarm on queue age against the one-minute staleness window.
- **Great — hybrid feeds.** Stop precomputing for the extreme accounts. Flag specific follow edges as "not precomputed" (a Justin-Bieber-scale account with 90M+ followers), and the workers simply skip them. At read time the Feed Service merges the precomputed feed with the recent posts of those few celebrity accounts, fetched live. In other words, choose [fan-out](../patterns/messaging/fan-out.md)-on-write for the many ordinary authors and fan-out-on-read for the handful of giants — the precomputation threshold is a tunable knob. The price is more work at read time and a more complex Feed Service. Each read looks up which followed accounts are flagged, fetches their recent posts live and merges by time, so read cost grows with the number of flagged accounts a user follows; cap or batch those live queries.

The async option moves fan-out off the write path, and the hybrid skips the biggest accounts.

```mermaid caption="How does one post reach followers' feeds without blocking post creation, and which follow edges are skipped?"
flowchart TB
    PS["Post Service"] -->|"enqueue postId, creatorId"| Q[("Message queue")]
    Q -->|"deliver"| W["Fan-out workers"]
    W -->|"look up followers"| W
    W -->|"prepend postId, idempotent"| PF[("PrecomputedFeed")]
    W -.->|"skip edges flagged not precomputed"| Skip["Celebrity posts fetched live at read time"]
```

### 3 · Uneven reads on the post store

Whichever way feeds are built, the Feed Service eventually reads post bodies from the key-value store, and those reads are lopsided: most posts are read hard for a day or two then never again, while a viral post draws a spike of traffic in its first hours. A key-value store sustains throughput only when load is spread evenly across the keyspace; one post ID at 500&nbsp;req/s against its neighbours at 0 is a textbook [hot key](../hazards/hot-key.md) that pins a single physical shard.

- **Good — a post cache.** Put a [cache-aside](../patterns/caching/cache-aside.md) layer (Redis, keyed by post ID) in front of the store, with a long TTL (time to live) because posts are rarely edited, and invalidate an entry only on the occasional edit. It absorbs most reads — but the hot key just moves to whichever cache shard owns the viral post, which is as hard to scale as the store shard was.
- **Great — replicate, don't shard, the cache.** Keep the same long-TTL scheme but [replicate](../patterns/distributed/coordination/replication.md) the cache so every instance can serve any post ID, with a [load balancer](../patterns/distributed/routing/load-balancer.md) spreading requests across all of them. A viral post's traffic now splits across all N replicas with zero coordination between them — N× the headroom for a hot key. The trade is a colder start (a newly viral post can miss on up to N instances, costing N store reads instead of 1) and fewer distinct posts cached overall; both are dwarfed by the millions of origin reads avoided.

```mermaid caption="How does a viral post's read traffic split instead of pinning one shard? Replicate, not shard, so any replica serves any id."
flowchart TB
    FS["Feed Service"] -->|"get viral post body"| LB["Load balancer"]
    LB -->|"spread across replicas"| C1["Post cache replica 1"]
    LB -->|"spread across replicas"| C2["Post cache replica 2"]
    LB -->|"spread across replicas"| C3["Post cache replica N"]
    C1 -.->|"cold miss: long-TTL fill"| DB[("Post store")]
    C3 -.->|"cold miss: long-TTL fill"| DB
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Feed reads collapse to a single lookup plus cache hydration, holding under 500&nbsp;ms however many accounts a user follows, as long as the user follows only a few skipped celebrity accounts and the post cache is warm.
- The queue absorbs write bursts, so a post is created in milliseconds while fan-out happens off the critical path.
- Hybrid fan-out means a celebrity post costs one write, not ninety million, and a replicated cache spreads viral reads without coordination.

### What it gives up
<!--meta polarity=con-->

- [Eventual consistency](../themes/consistency-and-replication.md) — a new post can take up to a minute to appear in a follower's feed.
- Precomputed feeds are millions of computed copies that must be kept updated, paying real storage and write amplification for the read speed.
- The read path is no longer simple: it merges precomputed feeds with live celebrity posts, and deep pagination past ~200 posts drops back to the slow naive query.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — clearly defined endpoints and data model, landing on a working high-level design that meets the functional requirements. May reach fan-out-on-write as the fix for expensive reads, but is not expected to work through every scaling edge case; mostly breadth, some depth.
- **Senior** — moves briskly through the high-level design to spend real time on two or more deep dives. Surfaces the fan-out and hot-key bottlenecks without being prompted, argues the write-time versus read-time trade-off, and justifies each choice on scalability and latency.
- **Staff+** — covers essentially all the deep dives, including ones not enumerated here (thundering herds on a newly viral post, where feed ranking would slot in), volunteers the hybrid fan-out and replicated-cache mitigations up front, and talks concretely about tuning the precomputation threshold and cache replication factor.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Hot Key](../hazards/hot-key.md) — A viral post's reads land on one postID; the replicated post cache spreads them across replicas.

**Demonstrates**

- [Fan-Out](../patterns/messaging/fan-out.md) — precomputes each follower's feed at post time, the core write-time strategy the design turns on
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — the PrecomputedFeed table is a maintained, reverse-chronological view of each user's feed keyed by userId
- [Message Queue](../patterns/messaging/message-queue.md) — post creation enqueues {postId, creatorId} so fan-out happens off the critical path and the write returns in milliseconds
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — a fleet of fan-out workers drains the queue in parallel, each writing a post into its followers' feeds
- [Idempotency](../patterns/messaging/idempotency.md) — at-least-once delivery plus the idempotent PUT /follow mean redelivered fan-out writes must be safe no-ops
- [Cache-Aside](../patterns/caching/cache-aside.md) — a long-time to live (TTL) Redis post cache keyed by postID fronts the store and is invalidated only on the rare edit
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — the Post and Feed services hold no per-request state, so they scale horizontally behind the gateway
- [Replication](../patterns/distributed/coordination/replication.md) — the post cache is replicated rather than sharded so any instance serves any postID, spreading a viral post's reads
- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — A replicated post cache is fronted by a load balancer, so a viral post's reads split across every replica

<!-- relationships:end -->
