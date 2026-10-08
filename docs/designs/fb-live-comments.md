---
title: Facebook Live Comments
description: "Broadcast thousands of comments a second to millions of live viewers in under 200 ms, favouring availability over consistency"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [event-driven, latency, availability]
status: stable
aliases: [live comments]
solves: [thousands watch one live stream and every new comment must reach all of them within a fraction of a second, my clients poll for updates every few seconds and hammer the database with requests that almost always come back empty, a viewer who joins late scrolls back through older comments but pages shift as new ones keep arriving, one viral broadcast has hundreds of millions of watchers and an open connection for each melts my servers, a phone loses wifi for ten seconds and the user returns to a gap in the comments they cannot recover]
---

# Facebook Live Comments

Live Comments streams a running feed of viewer comments beneath a live video: everyone watching sees each new comment within a fraction of a second, and late joiners can scroll back through what they missed. Almost all the load is broadcast — one comment fanned out to every viewer — so this is a real-time delivery problem, not a storage one.

## Understanding the problem
<!--meta block=description-->

Viewers of a live video post comments that appear near-instantly on every other viewer's screen. The write is a short string saved once, but each write must reach an audience from a handful to hundreds of millions, so the work is broadcasting, not storing. The page designs real-time distribution that keeps end-to-end delay below what people perceive as live. Authorization and moderation are out of scope.

## Explained
<!--meta block=explain-->

A live-comments system saves each comment once, then pushes it down a long-lived connection ([WebSocket](../patterns/messaging/websocket.md) or [server-sent events](../patterns/messaging/server-sent-events.md)) to every viewer of that video, so they see it in under 200 ms. Writes are cheap; the cost is fan-out, one comment multiplied by the audience. Choose pushing over having each viewer poll once the audience is large, because polling fast enough to feel live makes nearly every request return nothing. For a stream with a few hundred viewers, polling is cheaper, and every open connection is something you must monitor.

- **Lossy delivery.** Push is fire-and-forget. Persist before publishing, cache recent comments for reconnects, and have the client drop repeats by comment id.
- **Connection ceiling.** A huge stream outgrows any fleet. Past a threshold serve an edge-cached snapshot, with separate on and off thresholds to stop flapping.
- **Sticky routing.** Push needs servers grouped by video, so hash the video id at the load balancer.

**Example.** A stream has 50,000 viewers and 100 comments a second. Each comment goes to all 50,000, so the delivery tier pushes 50,000 x 100 = 5 million messages a second for this one video, while the database takes 100 writes a second. A viewer's train enters a tunnel for 5 seconds and misses 500 comments. On reconnect the browser sends the id of the last comment it saw, the server replays the later ones from the recent cache, and the client discards any it already showed.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. A viewer can post a comment on a live video.
2. A viewer sees new comments appear as they are posted, while watching.
3. A viewer who joins late can load comments made before they arrived.

Out of scope: replies and reactions to comments — named explicitly so the feed stays a flat, append-only stream.

### Non-functional
<!--meta requirement=nfr-->

- **Latency** — a comment reaches watching viewers in under 200&nbsp;ms end-to-end on the push path, a working target for feeling live. Mega-streams served from the CDN relax this to about 1–2&nbsp;s.
- **Availability** — favoured over consistency; [eventual consistency](../themes/consistency-and-replication.md) is fine, since a briefly-missing comment is harmless while a stalled feed is not.
- **Scale** — millions of concurrent videos, and thousands of comments per second on a single hot video.

## Right-sizing
<!--meta block=sizing-->

**Writes are cheap.** Even a busy stream at a few thousand comments/sec is a modest ingest load for a wide-column store — the write path is rarely the bottleneck at aggregate volume, but one hot video sends all its writes to one key, so check that key's write rate against the store's per-key limit. What matters is the multiplier on the other side.

**Fan-out is the load.** A stream with 50k concurrent viewers running at 100 comments/sec must push 50k × 100 ≈ **5M messages/sec** — for one video. Multiply by the number of live videos and the delivery tier, not the database, is what the architecture has to survive.

**Connections are the wall.** Real-time delivery means one long-lived connection held open per viewer. A well-tuned server sustains about **100k concurrent connections** before file descriptors, CPU and memory — not any TCP port limit — cap it. Millions of viewers therefore imply tens to hundreds of delivery servers, and a single mega-stream can demand more connections than a whole fleet has.

**Storage is an afterthought.** A comment is a few hundred bytes; even a million of them is well under a gigabyte. Retention policy, not disk, is the only real question.

## Core entities
<!--meta block=entities-->

Three entities, and one of them belongs to someone else:

- **User** — a viewer or the broadcaster. Identified from the session token on every request; never trusted from the request body.
- **Live Video** — the broadcast a comment attaches to. Owned and run by a different team; this system integrates with it by `liveVideoId` rather than managing the video itself.
- **Comment** — one message: a `commentId`, the `liveVideoId` it belongs to, the author's `userId`, the `message` text, and a `createdAt` timestamp. Append-only; never edited once written.

## The interface
<!--meta block=interface-->

Three surfaces, one per requirement: post a comment, load history, and subscribe to the live tail. The author is never in the request body — the server reads `userId` from the verified token, so a client cannot post as someone else.

```http summary="HTTP — create, page history, subscribe"
POST /comments/:liveVideoId
Authorization: Bearer <JWT>                 # userId comes from the token, not the body
{ "message": "Cool video!" }
→ 201 { "commentId": "c_8fa1", "createdAt": 1739479200 }

GET /comments/:liveVideoId?cursor={last_comment_id}&pageSize=10&sort=desc
→ 200 { "comments": [ … ], "nextCursor": "c_8f90" }   # history, cursor-paginated

GET /comments/:liveVideoId/stream            # the live tail (Server-Sent Events)
Last-Event-ID: c_8fa1                         # browser sets this on auto-reconnect
→ text/event-stream
   id: c_8fa2
   event: comment
   data: { "userId": "u_17", "message": "Goal!" }
```

History uses a **cursor**, not an `offset`. Offset pagination degrades as the feed grows — the store must count through every preceding row — and it is unstable: a comment inserted or removed mid-scroll shifts every offset, so viewers see duplicates or gaps. A cursor points at a specific comment id; with an index on that field there is no counting, and concurrent writes never move the cursor's target.

## How the system is built
<!--meta block=architecture-->

Write traffic and read traffic have nothing in common in shape or volume, so they run on separate tiers. The **Comment Management Service** takes a `POST`, persists the comment to a wide-column store (DynamoDB — fast, highly available, and these records need no joins or transactions), and publishes it onto a message bus. A pool of **Realtime Messaging Servers** hold the open server-sent events (SSE) connections; each subscribes only to the bus channels for the videos its viewers are watching, and pushes matching comments straight down the wire. A Layer&nbsp;7 load balancer hashes on `liveVideoId` so that viewers of the same video land on the same server, keeping each server's subscription set small. Mega-streams break out of this push model entirely and are served from the edge.

```mermaid caption="The write path (persist → publish) is small; the read path fans one comment out across the messaging tier to every subscribed viewer. Mega-streams switch from push (SSE) to pull (CDN snapshots)."
flowchart TB
    Viewer["Viewer / commenter client"]
    LB["L7 load balancer — hashes liveVideoId"]
    Write["Comment Management Service"]
    DB[("Comments DB — DynamoDB")]
    Bus["Redis pub/sub — partitioned by hash(liveVideoId)"]
    RT["Realtime Messaging Servers — hold SSE connections"]
    CDN["CDN edge — mega-streams"]
    Viewer -->|"open live tail"| LB
    LB -->|"co-locate same-video viewers"| RT
    Viewer -->|"POST /comments/:id"| Write
    Write -->|"persist"| DB
    Write -->|"publish"| Bus
    Bus -->|"deliver to subscribed channel"| RT
    RT -->|"SSE stream"| Viewer
    Write -.->|"snapshot every 1s"| CDN
    CDN -.->|"serve mega-streams"| Viewer
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Delivering comments in real time

The obvious first cut is polling: the client asks `GET /comments/:id?since={last}` every few seconds and appends whatever is new. It works as a starting point and fails at scale — to feel live you would have to poll every few milliseconds, and almost every one of those requests comes back empty, burning the database on questions with no answer. The fix is to invert the direction: the server pushes.

- **WebSockets.** A full-duplex channel per viewer. Right for balanced chat, where both sides talk constantly — but here the ratio is lopsided: a viewer reads far more than they write. Paying for a two-way socket per viewer is overhead the workload does not justify.
- **Server-Sent Events (chosen).** A one-way server-to-client stream over ordinary HTTP; the rare write is a plain `POST`. It matches the imbalance exactly — cheap frequent reads, occasional writes — and comes with built-in reconnection. The warts are operational: some proxies buffer streaming responses in ways that are hard to debug, browsers cap concurrent SSE connections per domain, and long-lived connections are harder to monitor than request/response. Browsers cap concurrent SSE connections per domain at about 6 on HTTP/1.1; HTTP/2 multiplexing largely lifts the cap.

With SSE chosen, a new comment is persisted, handed to the messaging tier, and streamed to every connected viewer of that video — a [fan-out](../patterns/messaging/fan-out.md) from one write to many readers.

### 2 · Scaling the broadcast to millions

One server cannot hold millions of connections, so delivery spreads across a fleet — and now viewers of the same video sit on different servers. A comment arriving at server&nbsp;1 reaches its local viewers but has no path to viewers of the same video parked on server&nbsp;2. Something has to carry the comment across the fleet.

- **Broadcast every comment to every server.** Publish to one channel; every messaging server subscribes and forwards to whichever of its viewers care. Dead simple, and wasteful — every server processes every comment for every video whether or not it has a single viewer for it. Impractical at this scale.
- **Partitioned pub/sub with viewer co-location (chosen).** Split the stream into N channels by `hash(liveVideoId) % N` — bounded channels, not one per video, which a broker like Kafka could not sustain — and have each server subscribe only to the channels it needs. To stop a server from accumulating every channel under round-robin, the Layer&nbsp;7 load balancer applies [consistent hashing](../patterns/distributed/routing/consistent-hashing.md) on `liveVideoId` so same-video viewers converge on the same server. This is [publish/subscribe](../patterns/messaging/pubsub.md) with intelligent routing done by the [load balancer](../patterns/distributed/routing/load-balancer.md). Consistent hashing prefers co-location; it does not force it. When one video's viewers pass a server's ceiling of about 100k connections (the same figure as the 100k-viewer flip to CDN), the balancer spreads them over several servers, each subscribing to that video's channel. If a server dies, its clients auto-reconnect with Last-Event-ID and rehash.
- **A dispatcher service.** Invert pub/sub: instead of servers subscribing to topics, a dispatcher keeps a live map of which servers hold viewers for each video and routes each comment to exactly those servers. It centralises routing and enables load-aware rules, at the cost of keeping that map accurate as viewers churn — extra machinery most designs do not need.

On technology: Redis pub/sub suits this better than Kafka, which struggles with the constantly-changing subscription patterns of viewers hopping between videos. Redis is low-latency and fire-and-forget — acceptable precisely because comments are already persisted, so a message dropped during a blip is recovered by the catch-up path below.

**Mega-streams.** A World-Cup-final stream — hundreds of millions of viewers, thousands of comments a second — breaks even the co-located design. At 5,000 comments/sec each on-screen comment lasts a few milliseconds; nobody is reading individual comments, they are feeling a crowd. That reframes the goal, and two moves follow. Sampling pushes a representative fraction — the rate adapting to velocity, biased toward followed or verified authors — giving each viewer a steady, readable trickle. The most scalable move drops push entirely: keep a ring buffer of the last ~200 comments, snapshot it to a [CDN](../patterns/distributed/routing/cdn.md) every second, and let clients poll the edge — a comment snapshot is just cacheable content, like a thumbnail. A stream auto-flips from SSE to CDN (content delivery network) once it crosses a threshold (say 100k viewers or 500 comments/sec), trading ~1–2s of latency, which the "vibe" reframing makes acceptable, for effectively unbounded reach. Hysteresis around the threshold keeps a stream hovering near the line from flapping between modes.

Past a threshold, the stream stops pushing and hands delivery to the edge.

```mermaid caption="When does a mega-stream flip from push to CDN snapshots, and how are comments then delivered?"
flowchart TB
    In["New comment"] -->|"append"| Ring["Ring buffer of last ~200 comments"]
    Ring -->|"above 100k viewers or 500 comments/sec?"| Mode{"which mode?"}
    Mode -->|"no: push over SSE"| SSE["Viewers on SSE servers"]
    Mode -->|"yes: snapshot every second"| CDN["CDN"]
    CDN -->|"clients poll the edge"| V["Viewers"]
```

### 3 · Surviving disconnects without losing the thread

Mobile networks drop — tunnels, backgrounding, wifi-to-cellular hand-offs. A viewer must be able to reconnect and recover what they missed without the feed silently skipping ahead.

- **Ignore it.** On reconnect, just resume from now; anything posted during the gap is gone. A five-second drop during a tense moment loses exactly the reactions the viewer came for. Rejected.
- **Last-Event-ID plus client tracking (chosen).** Every SSE message carries the comment id as its event id. On an auto-reconnect the browser resends the last one it saw in the `Last-Event-ID` header, and the server replays what came after before resuming the live stream. The client also stores that id, so it can ask for catch-up explicitly (`GET …?cursor={last}&pageSize=100`) and show "you missed 47 comments". The hash on `liveVideoId` sends a reconnect back to the same server, but after a server failure, deploy or rebalance it lands on another, so replay reads from a [shared Redis cache](../patterns/caching/distributed-cache.md) of recent comments, keyed by `liveVideoId`, that any server can serve. Comment ids sort in creation order, so a cursor means everything after this id. Replayed and live comments can arrive on both paths at once, so the client dedupes by comment id: receiving the same comment twice is a no-op, which keeps the merge [idempotent](../patterns/messaging/idempotency.md). Replay is bounded to the last few minutes, sized as window x comments/sec x bytes per comment: 5 minutes at 100/s is 30,000 comments, about 9 MB at 300 bytes. Beyond that window the client loads the latest comments from the history endpoint.
- **Gap detection on a live connection.** Catch-up also runs without a reconnect. The server sends a periodic heartbeat event carrying the latest comment id; if the client has not seen that id, it calls the cursor catch-up. This recovers comments Redis pub/sub dropped.

```mermaid caption="How does a viewer who drops and reconnects recover missed comments without gaps or duplicates?"
sequenceDiagram
    autonumber
    participant C as Client
    participant A as Messaging Server A
    participant B as Messaging Server B
    participant R as Redis recent-comments
    C->>A: subscribe SSE, track last id
    A-->>C: id c_42, comment
    A--xC: connection drops
    C->>B: reconnect, Last-Event-ID c_42
    alt gap within replay window
        B->>R: read comments after c_42
        R-->>B: c_43 .. c_47
        B-->>C: replay missed, then resume live
    else gap older than window
        B-->>C: resume from now, degraded
    end
    Note over C: dedupe by comment id, repeat is a no-op
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Sub-200&nbsp;ms delivery with far less overhead than a full socket per viewer, matched to a read-heavy, write-light workload.
- Consistent-hash co-location keeps each messaging server's subscription set small, so the fleet scales by adding servers rather than broadcasting everything everywhere.
- Mega-streams degrade gracefully to a cacheable CDN pull instead of melting the push tier.

### What it gives up
<!--meta polarity=con-->

- SSE carries real operational cost: proxy buffering, per-domain connection caps, and hard-to-monitor long-lived streams.
- Redis pub/sub is fire-and-forget — no-loss delivery leans entirely on the persisted store and a bounded replay cache.
- The CDN path abandons per-comment delivery for a sampled "vibe" and adds 1–2s of latency; the SSE↔CDN threshold needs hysteresis to avoid mode-flapping.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end flow (post → store → show), and the instinct to see that polling cannot be near-real-time and to start reasoning toward server push; reaches a pub/sub broadcast with a nudge and scales it with help.
- **Senior** — moves briskly through the high-level design to spend real time on scaling, reaches pub/sub with viewer co-location with minimal hints, and argues the trade-offs — SSE vs WebSockets, partitioning the channels, Redis vs Kafka — on their own.
- **Staff+** — treats the design as a delivery problem from the first minute, names concrete technologies from experience, and volunteers the failure edges unprompted: mega-stream CDN fallback, reconnect replay and dedup, bounded catch-up, and mode-flip hysteresis.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Hot Partition](../hazards/hot-partition.md) — one mega-stream's comments and connections overload the server that owns its video's channel

**Demonstrates**

- [Publish-Subscribe](../patterns/messaging/pubsub.md) — the Comment Management Service publishes each comment onto a partitioned bus that messaging servers subscribe to per video
- [Fan-Out](../patterns/messaging/fan-out.md) — a single posted comment must be delivered to every viewer of that video, from a handful to hundreds of millions
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — the L7 load balancer hashes on liveVideoId so same-video viewers converge on the same messaging server, keeping subscription sets small
- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — a Layer 7 load balancer inspects the request and routes by liveVideoId rather than blindly round-robining connections
- [CDN](../patterns/distributed/routing/cdn.md) — mega-streams snapshot recent comments to the edge every second and clients poll the content delivery network (CDN) instead of holding a live push connection
- [Distributed Cache](../patterns/caching/distributed-cache.md) — recent comments live in a shared Redis cache so any messaging server can replay them when a reconnecting viewer lands elsewhere
- [Idempotency](../patterns/messaging/idempotency.md) — on reconnect the same comment can arrive via both server-sent events (SSE) replay and the live stream, so the client dedupes by comment id
- [Server-Sent Events](../patterns/messaging/server-sent-events.md) — one-way comment stream over plain HTTP with Last-Event-ID reconnect, chosen over WebSocket for a read-heavy, write-light viewer

<!-- relationships:end -->
