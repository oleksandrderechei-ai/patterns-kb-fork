---
title: Tinder
description: "Surface nearby profiles in under 300 ms and fire a match the moment two people both swipe right, across billions of swipes a day"
area: designs-advanced
owner: Oleksandr Derechei
tags: [consistency, latency, read-optimization]
status: stable
aliases: [dating app, swipe matching]
solves: [two users act on each other at almost the same moment and my check misses that they mutually matched, loading a stack of nearby candidates takes seconds because I scan and filter the whole users table on every request, people keep getting shown profiles they already dismissed and it looks like their actions were lost, I am writing billions of tiny records a day and a single database cannot absorb the volume, one person history of things they have already seen has grown so large that checking against it is slow]
---

# Tinder

A swipe-and-match feed shows one nearby person at a time; swipe right to like, left to pass, and when two people like each other the app announces a match. Two demands pull against each other: the candidate stack must appear almost instantly, and the mutual match behind it must be detected exactly once, immediately, at enormous write volume.

## Understanding the problem
<!--meta block=description-->

A swipe-based matching app shows a stack of nearby profiles and notifies two people when both swipe right. Two requirements pull apart: the stack must load in under 300 ms from millions of profiles filtered by preference and distance, and a match must be strongly consistent across billions of swipes a day. The page walks through the feed and the swipe.

## Explained
<!--meta block=explain-->

Tinder records about 2 billion swipes a day and must tell the second person to swipe right on a pair, right now, that they have a match. The key move is to name each swipe by the pair, with the two user ids sorted and joined, so a swipe from A to B and one from B to A land on the same partition (one slice of the data). Writing your swipe and reading theirs is then one atomic step, so two simultaneous swipes cannot both miss each other. Choose this over matching on a schedule, because the second swiper must hear now. Redis fronts the check for speed, and Cassandra, a write-heavy database, stays the system of record.

- **Round trips.** Cassandra compare-and-set writes take several round trips each, so Redis fronts the check and Cassandra holds the durable copy.
- **Lost recent swipe.** A lost Redis node loses a recent swipe, which Cassandra recovers on a miss.
- **Refresh work.** Precomputed candidate stacks cost refresh work, so build them only for users who will open them.

**Example.** Two users swipe right on each other in the same millisecond. Both writes use the key lower-id:higher-id, so both land in the same partition and run one after the other. The second one finds the first and reports a match. Under separate keys per direction, both checks would find nothing and the match would be missed. If the Redis node holding recent swipes dies just after, the swipe is gone from Redis, and a read of the pair's Cassandra partition recovers it.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Create a profile with match preferences — age range, interests, and a maximum distance.
2. Open a stack of candidate profiles that match those preferences and sit within the maximum distance of the user's current location.
3. Swipe right (yes) or left (no) on one profile at a time.
4. Receive a match notification the instant a right-swipe turns out to be mutual.

Out of scope: photo uploads, post-match chat, and paid boosts or super-likes — named so the design stays on the recommendation-and-swipe core.

### Non-functional
<!--meta requirement=nfr-->

- **Consistency (matching)** — a mutual right-swipe must always notify the person who swiped second once both swipes reach the durable store; strong consistency, not eventual reconciliation.
- **Latency** — the candidate stack loads in under 300&nbsp;ms.
- **No repeats** — never show a profile the user has already swiped on.
- **Scale** — 20M daily actives at ~100 swipes each per day, roughly 2B swipes/day.

Out of scope: fake-profile detection and monitoring/alerting.

## Right-sizing
<!--meta block=sizing-->

**Swipe writes.** 20M DAU (daily active users) × ~100 swipes/day ≈ **2B swipes/day** ≈ ~23k writes/sec on average, and considerably spikier at peak. At ~100 bytes per swipe that is ~**200&nbsp;GB/day** of new swipe data. This is the number that rules out a single B-tree store and forces a write-optimized, partitioned one.

**Feed reads.** Every swipe is preceded by a profile view, so feed generation has to produce on the order of **2B candidate cards/day**, each stack delivered inside the 300&nbsp;ms budget. Serving those from a live geospatial query on every open is what the caching path exists to avoid.

**Matches.** A tiny fraction of swipes ever become matches, but each one must be detected exactly once and surfaced immediately — so the cost is not volume, it is the atomicity of the check.

## Core entities
<!--meta block=entities-->

Three entities, and the first is the one people forget:

- **User** — both the person swiping and a profile shown to others. Carries the match preferences (age range, interests, `interested_in`) and a current location. Listed explicitly because users are the things being swiped on.
- **Swipe** — one yes/no decision, from a `swiping_user` onto a `target_user`.
- **Match** — the connection formed when two users have each swiped yes on the other.

## The interface
<!--meta block=interface-->

A small representational state transfer (REST) surface — one endpoint per requirement:

```http summary="HTTP — profile, feed, swipe"
POST /profile          Authorization: Bearer <jwt>
{ "age_min": 20, "age_max": 30, "distance_km": 10,
  "interested_in": "female" | "male" | "both" }
→ 200

GET /feed?lat={}&long={}&distance_km={}    Authorization: Bearer <jwt>
→ 200 [ User, User, ... ]   // no pagination — re-request when the stack runs low

POST /swipe/{targetUserId}                 Authorization: Bearer <jwt>
{ "decision": "yes" | "no" }
→ 200 { "match": true | false }
```

Three deliberate choices are baked in here. Identity comes from the auth header on every call, never from the body — body fields are client-forgeable, so the acting user is taken from the session token or JWT (JSON Web Token). Location rides in as a query parameter rather than being stored server-side, because it changes constantly and only the current position matters. And the feed is **not paginated**: it is a recommendation stream, not a page-able list, so the client simply re-hits `/feed` for more once it nears the end of the current batch.

## How the system is built
<!--meta block=architecture-->

Three request types with completely different shapes share one [API gateway](../patterns/distributed/routing/api-gateway.md) and then diverge. Profile writes are rare, so a plain **Profile Service** over a relational store handles them. Feed reads are the latency-critical path and need geospatial filtering, so a **Feed Service** sits over a search index and a precomputed-feed cache. Swipes are the highest-volume, consistency-critical path — billions of small writes a day plus an atomic mutual-match check — so a **Swipe Service** gets its own write-optimized store, kept separate from profiles precisely because the two read/write profiles are nothing alike. A match is announced two ways: the second swiper is told synchronously in the swipe response, while the earlier swiper — who may have swiped weeks ago — gets an asynchronous push through APNS or FCM.

```mermaid caption="How do profile, feed, and swipe requests diverge behind one gateway, each onto a store matched to its workload?"
flowchart TB
    Gateway["API Gateway"]
    Gateway -->|"profile writes (rare)"| Profile["Profile Service"]
    Gateway -->|"GET /feed"| Feed["Feed Service"]
    Gateway -->|"POST /swipe"| Swipe["Swipe Service"]
    Feed -->|"read precomputed stack"| FeedCache[("Feed cache")]
    Feed -->|"geo filter on miss"| Search[("Geo search index")]
    Swipe -->|"atomic mutual-match check"| Redis[("Redis")]
    Swipe -->|"durable append"| Cass[("Cassandra")]
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Detecting a mutual match without a race

The dangerous case is two people swiping right on each other in the same instant. Each swipe independently checks for the other's swipe, both find nothing because neither write has landed yet, and both save — a [race condition](../hazards/race-condition.md) that leaves a genuine match undetected and both people un-notified. Polling the store on a schedule for reciprocal swipes breaks the notify-immediately requirement and loads the database. The fix is to make write-and-check a single atomic step.

The durable store is [Cassandra](../patterns/distributed/coordination/lsm-tree.md) — its log-structured write path (commit log, memtables, SSTables) absorbs the ~2B swipes/day that a B-tree store could not. Cassandra offers lightweight transactions (compare-and-set writes), but only within one partition, so the trick is to force both directions of a pair into the same partition. Build the partition key from the two user ids sorted and joined — `smaller:larger` — and A→B and B→A land together, turning an insert-then-read into one single-partition, atomic operation. That is [sharding](../patterns/distributed/routing/sharding.md) chosen for atomicity, not merely for spread.

```python summary="Pseudocode (Redis variant) — co-locate a pair, then check atomically"
def pair_key(a, b):
    lo, hi = sorted([a, b])
    return f"{lo}:{hi}"          # A→B and B→A resolve to the same key

# one atomic step: run both commands inside one Lua script (EVAL)
#   HSET  swipes:{pair_key}  {me}_swipe    {decision}
#   HGET  swipes:{pair_key}  {them}_swipe
# if both sides are "yes" → it's a match, notify immediately
```

A faster variant keeps the same co-location trick but in Redis: combine the two ids into one key so [consistent hashing](../patterns/distributed/routing/consistent-hashing.md) maps both swipes to the same hash slot (or the same shard under consistent hashing), then run set-my-swipe-and-read-yours inside one Lua script, which Redis executes atomically and in memory. Cassandra stays the system of record; Redis holds only recent swipes and expires them aggressively, so losing a Redis node risks missing a very recent match, and a Redis miss reads Cassandra first, so no durable data is lost.

```mermaid caption="How is a mutual match detected atomically when two people swipe right at the same instant?"
sequenceDiagram
    autonumber
    participant U as Swiper
    participant Sw as Swipe Service
    participant C as Cassandra (system of record)
    participant R as Redis (recent swipes)
    participant P as APNS / FCM
    U->>Sw: swipe right on other
    Sw->>C: persist swipe, pair key lo:hi
    Sw->>R: Lua: set my swipe, read theirs (one atomic step)
    alt both sides yes
        R-->>Sw: reciprocal yes
        Sw-->>U: match (synchronous)
        Sw->>P: async push to the earlier swiper
    else no reciprocal yet
        R-->>Sw: their swipe absent
        Sw-->>U: swipe recorded
    end
```

### 2 · Loading the stack in under 300&nbsp;ms

The naive feed query — `SELECT … WHERE age BETWEEN … AND lat BETWEEN … AND long BETWEEN …` — is a filtered scan that blows the budget even with ordinary indexes. Two moves fix it. First, hold the candidate corpus in a search-optimized store (Elasticsearch or OpenSearch) with a [geospatial index](../patterns/distributed/routing/geohash.md), so "profiles matching these preferences within N&nbsp;km" is a fast bounded lookup rather than a scan. That index has to track the profile store, which is a separate write path, so [change data capture](../patterns/distributed/coordination/change-data-capture.md) streams profile edits into it instead of dual-writing — at the cost of a small sync lag. Second, don't compute the stack on the hot path for active users at all: a background job precomputes each active user's next stack and stores it as a [materialized view](../patterns/distributed/coordination/materialized-view.md), served straight from cache on app open.

The two combine: instant from the precomputed stack, and when a user nears the end of it the Feed Service falls back to the live geo query and refreshes the stack in the background, so the feed feels endless. The risk is a [stale feed](../hazards/stale-cache.md) — a candidate moves out of range or edits their filters and no longer qualifies. Bounding it is a set of tunable knobs: a short TTL (time to live) (well under an hour), precompute only for genuinely active users rather than everyone, and trigger a refresh when the user changes filters or moves a meaningful distance.

Both paths feed the Feed Service, which prefers the precomputed stack:

```mermaid caption="How does the Feed Service load a stack in under 300 ms and still feel endless?"
flowchart LR
    App["Client app"] -->|"open app"| Feed["Feed Service"]
    Profiles["Profile store"] -->|"CDC: profile edits"| Geo[("Geo index (Elasticsearch / OpenSearch)")]
    Job["Background job"] -->|"precompute next stack for active users"| Stack[("Materialized stack (cache)")]
    Feed -->|"serve stack straight from cache"| Stack
    Feed -->|"near end of stack: live geo query"| Geo
    Feed -->|"refresh stack in background"| Stack
```

### 3 · Never re-showing a swiped profile

Re-showing someone the user already dismissed reads as a bug, and worse, suggests their swipes weren't recorded. The obvious approach — query swipe history and filter the feed against it — has two problems: under an availability-leaning store a very recent swipe may not have replicated to the replica the feed reads from, and a heavy swiper's history grows into an ever more expensive contains-check. Two fixes run on the way to the client.

A [client-side cache](../patterns/caching/client-side-cache.md) of the last K swipes filters anything just swiped out of the next stack, closing the replication-lag window with no server-side cache to maintain. A second or new device falls back to the server-side Bloom filter or swipe history. For users whose history is genuinely enormous, keep a per-user [Bloom filter](../patterns/distributed/coordination/bloom-filter.md) of everything they've swiped and test candidates against it: it never re-shows a swiped profile (no false negatives) and only, rarely, hides a fresh one (a false positive), with the error rate traded against memory. The Bloom filter is overkill for most users; it pays off only for the heaviest swipers.

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Mutual matches are detected atomically and announced immediately — even for near-simultaneous swipes — by co-locating a pair's swipes on one partition or shard.
- The candidate stack lands well under 300&nbsp;ms: precomputed for active users, backed by a geospatial index when it depletes.
- Profile, feed, and swipe scale independently, each on a store suited to its own read/write shape.

### What it gives up
<!--meta polarity=con-->

- A Redis node that dies loses its recent swipes and can miss a very recent match. The client filter in the no-repeat path then hides that profile, so the user cannot swipe again; a Redis miss must read the pair's Cassandra partition.
- Precomputed feeds go stale between refreshes; freshness leans on TTLs and change-triggered recomputes rather than always-live data.
- The Bloom filter trades a small rate of never-shown profiles for cheap history checks, and its per-user cache is expensive to rebuild after a loss.
- Cassandra lightweight transactions take several round trips per write. At ~23k writes/s on average, that is why Redis fronts the check and Cassandra stays the system of record.
- Search-index lag, from change data capture, can briefly show a stale profile.
- Rebuilding a user's Bloom filter or client cache means rereading their full swipe history, which grows by ~100 swipes a day.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end design: profile, feed, and swipe services with their stores, a sound API and data model, geospatial as well as ordinary filters, and a scheme that avoids re-showing swiped profiles. Deep technology internals are not assumed.
- **Senior** — moves quickly past the high-level design to spend real time on scalable feed generation and reliable matching; argues index choices, names the feed-staleness problem, and reasons about caching and CDC trade-offs unprompted.
- **Staff+** — drives depth on the hard parts from experience: the single-partition-transaction trick and the Redis/Cassandra split for matching, the precompute-plus-index feed, and Bloom-filter history filtering — articulating each trade-off as a peer.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Geohash](../patterns/distributed/routing/geohash.md) — the candidate stack is a geospatial index query — profiles within N km of the user's current location
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — an active user's next stack is precomputed by a background job and served straight from cache on app open
- [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) — profile edits are streamed into the search index instead of dual-writing, keeping the geo index in sync
- [LSM Tree](../patterns/distributed/coordination/lsm-tree.md) — Cassandra's log-structured write path absorbs ~2B swipes/day that a B-tree store could not
- [Sharding](../patterns/distributed/routing/sharding.md) — the swipe partition key is the sorted user pair, forcing both directions of a pair into one partition for atomic checks
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — the Redis variant combines both ids into one key so a pair's swipes hash to the same shard for an atomic Lua check
- [Bloom Filter](../patterns/distributed/coordination/bloom-filter.md) — heavy swipers get a per-user Bloom filter of their swipe history to keep the already-seen check cheap
- [Client-Side Cache](../patterns/caching/client-side-cache.md) — the last K swipes are cached on the single device and filtered from the next stack, closing the replication-lag window
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — Profile writes, feed reads and swipes share one gateway and then diverge to services shaped for each

<!-- relationships:end -->
