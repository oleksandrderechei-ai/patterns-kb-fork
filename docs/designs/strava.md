---
title: Strava
description: "Record a run entirely on the phone, offline, then sync it in one batched upload — the client absorbs the write load so the backend barely sees it"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [scalability, availability, asynchrony, batching]
status: stable
aliases: [fitness tracker, activity tracker, run tracking app]
solves: [my app has to keep tracking a workout even when the phone has no signal for miles, I ping the server with a GPS point every few seconds and it is melting my backend and the battery, my elapsed-time counter keeps running through pauses so the total time comes out wrong, a year of GPS traces is hundreds of terabytes and one database cannot hold it hot, friends want to watch a workout live but standing up a websocket push tier feels like overkill]
---

# Strava

A fitness tracker records a run or a ride — GPS route, distance, elapsed time — shows those numbers updating live during the workout, and shares the finished activity with the athlete's friends. Two requirements pull the design away from the usual server-centric instinct: it must work with no signal at all, and it must show exact live stats every second. Both point the same way — do the work on the phone.

## Understanding the problem
<!--meta block=description-->

A running and cycling app starts a workout, tracks route and stats while it runs, saves it and shows it to friends. Tracking must work in dead zones and update every second, so the phone records the whole activity itself and the backend accepts a finished file. The page walks through that inversion and what it costs.

## Explained
<!--meta block=explain-->

A workout tracker lets the phone record the whole activity itself, using its own sensors and storage with no network, then uploads the finished route in one batch. The athlete's live stats come from local data, so they update every second and survive tunnels, and the server only accepts finished files. Choose this when the client can hold the truth and few people read a live activity. For spectators, poll on the known 2 to 5 second cadence and show a position 5 to 10 seconds behind, smoothed by interpolation, instead of running a push tier.

- **Lost buffer.** A dead battery loses unsaved points, so save the buffer to the phone every 10 seconds and accept up to 10 seconds lost.
- **Storage.** Storage, not request rate, is the limit at about 550 TB a year, so split by completion date and archive old years.
- **Phone bugs.** Hard bugs now sit on the phone, so make uploads chunked, resumable and safe to repeat, with the server discarding known points.

**Example.** A 30-minute run with a GPS point every 3 seconds makes 1,800 / 3 = 600 points. Sending each as it happens is 600 requests; recording locally sends 1 upload, so backend writes drop about 600 times. At about 24 bytes a point that is about 15 KB a run. For 100 million runs a day, 36.5 billion a year, that is about 550 TB a year. If the battery dies at minute 20, you lose at most the last 10 seconds of points.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Start, pause, resume, stop, and save a run or a ride.
2. During an activity, show the live route, distance, and elapsed time.
3. Browse the details of one's own completed activities and of friends' activities.

Out of scope: managing the friend graph, authentication, and likes or comments — named explicitly so the design stays narrow.

### Non-functional
<!--meta requirement=nfr-->

- **Availability** — heavily favoured over consistency: a few seconds of staleness is fine; a dropped recording is not, though losing up to 10 seconds of trailing points on a crash is accepted.
- **Offline** — tracking must work end-to-end with zero connectivity.
- **Live accuracy** — the athlete's own stats update every second, exactly, during the workout.
- **Scale** — 10&nbsp;million activities in progress at once.

## Right-sizing
<!--meta block=sizing-->

**Write path.** The naïve version pings the server with a GPS point every few seconds — for a 30-minute run at a point every ~3&nbsp;seconds that is ~600 tiny writes per activity. Recording locally and syncing once at the end collapses those 600 into **one** request, cutting backend write volume by roughly **600×** before any scaling work begins. Upload rate. 100M uploads a day is about 1,160 a second on average, about 17 MB/s at 15 KB each; the peak is not sized here.

**Storage.** Assume ~100M daily actives, one activity each, so ~100M new activities/day ≈ **36.5&nbsp;billion/year**. Metadata (type, user, timestamps, status) is ~100&nbsp;bytes — a rounding error. The route dominates: ~600 points, each a lat + lon + timestamp ≈ 24&nbsp;bytes, so ~**15&nbsp;KB/activity**. 15&nbsp;KB × 36.5B ≈ **~550&nbsp;TB/year**. That number, not the request rate, drives the storage design. The 3-second cadence blends 2 seconds cycling and 5 seconds running. A pure run is 1,800 / 5 = 360 points, about 9 KB; a pure ride is 1,800 / 2 = 900 points, about 22 KB. The 550 TB figure scales with the mix.

**Concurrency.** Ten million "concurrent" activities sounds terrifying but costs the server almost nothing: while each one is being tracked it lives on a phone, and the only write lands when it finishes. Concurrency is a client-side number here, not a backend one.

## Core entities
<!--meta block=entities-->

Four entities, one of them only a scoping edge:

- **User** — the athlete: profile and settings.
- **Activity** — one run or ride: `type` (RUN&nbsp;|&nbsp;RIDE), start and end time, a `status` log, `distance`, `duration`, and its route.
- **Route** — the ordered list of GPS points (`lat`, `lon`, `ts`) recorded during the activity. Modelled as its own rows because it is the bulk of the data.
- **Friend** — a connection between two users. The friend graph itself is out of scope, but the edge is needed to scope the "friends' activities" query. It is stored bidirectionally — each friendship is two rows with a composite key on `(userId, friendId)` — so a lookup by `userId` finds it whichever direction it was created.

## The interface
<!--meta block=interface-->

A small representational state transfer (REST) surface. Lifecycle changes are a `PATCH` rather than a `PUT` because only a subset of fields moves; saving and sharing are the same `COMPLETE` transition — there is no separate "share" call, completing an activity publishes it to friends.

```http summary="HTTP — activity lifecycle and reads"
POST /activities                       → Activity
{ "type": "RUN" | "RIDE" }

PATCH /activities/:id                   → Activity     # lifecycle transition
{ "state": "STARTED" | "PAUSED" | "RESUMED" | "COMPLETE" }

POST /activities/:id/routes             → Activity     # append a GPS point
{ "location": { "lat": 40.7, "lon": -74.0, "ts": "..." } }

GET /activities?mode=USER|FRIENDS&page=&pageSize=  → Partial<Activity>[]
GET /activities/:id                     → Activity     # full detail, for the map
```

The list endpoint returns a thin projection — distance, duration, date per row — so a feed page stays small; the full coordinate array loads only when a single activity is opened for its map. In the offline-first design that follows, the phone makes the activity id, so `POST /activities` carries it and recording needs no network. One upload, `POST /activities/:id/routes` with a points array, replaces the per-point call: each point is keyed by its `ts`, a long ride sends several chunks, and the server discards points it already holds.

## How the system is built
<!--meta block=architecture-->

The backend is deliberately plain: one stateless **Activity Service** in front of a relational store. No microservice fan-out — offloading the write path to the phone leaves too little server work to justify it, and there is no read/write skew across paths worth splitting. During a workout the **phone runs the show**. On-device location services (Core Location on iOS, the fused location provider on Android) sample GPS on a fixed cadence — about every 2&nbsp;seconds cycling, every 5&nbsp;running — append each point to an in-memory buffer, and update distance incrementally with the Haversine formula between consecutive points. Nothing leaves the device until the activity is done; when it completes and the phone has a connection, the buffer flushes to the service in one batched upload, which appends the route and metadata to the store. Reads — your own feed and a friend's — are ordinary paginated queries filtered to `state = COMPLETE`; opening one hands its coordinate array to a map-tiles API to draw the line.

Elapsed time hides a subtlety. Subtracting start-from-now keeps counting through pauses, so instead the activity carries a **status log** — `STARTED`, `PAUSED`, `RESUMED`, `COMPLETE` with timestamps — and active time is the sum of the running intervals. Storing the events and computing the number from them, rather than mutating a running counter, is [event-sourcing](../patterns/architecture/event-sourcing.md) in miniature: it makes "moving time vs. total time" come directly from the log and leaves an audit trail of the workout.

```mermaid caption="The phone records the whole activity locally; the server sees one batched write on completion, plus light paginated reads. Live-viewer polling is the only path that touches the server mid-activity."
flowchart TB
    App["Athlete's phone — on-device GPS, local buffer, live stats"]
    Svc["Activity Service — stateless, scaled horizontally"]
    DB[("Activity + Route store — sharded by completion time")]
    Cold[("Object storage / S3 — cold archive tier")]
    Friend["Friend's phone — live viewer"]
    Maps["Map tiles API"]
    App -->|"batched sync on completion or reconnect"| Svc
    App -->|"GET recent + friends' activities"| Svc
    Svc -->|"append / query activities"| DB
    DB -->|"age out traces older than a year"| Cold
    Friend -->|"poll live position every 2-5s"| Svc
    App -->|"draw route polyline"| Maps
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Tracking through a dead zone

The unlock is that, as long as nobody is watching live, an activity is a purely local recording that needs the network exactly once — at the end. That removes the network from the critical path entirely and lets live stats come straight off local state, instantly and exactly.

- **Survive a dead battery.** The buffer lives in memory, but a phone can die mid-run, so it is persisted to on-device storage every ~10&nbsp;seconds (Core&nbsp;Data or Room for the structured trace, a SQLite file once it grows; UserDefaults / SharedPreferences only for tiny key-values). The worst case is losing ~10&nbsp;seconds of points on a crash — a deliberate trade against the battery cost of persisting more often. On reopen or resume, the saved buffer is loaded back before recording continues.
- **Sync once, retriably.** On completion with a connection, everything ships at once; very long rides are chunked so a single request stays manageable. An optional background sync opportunistically uploads whenever connectivity appears mid-activity, buying durability without giving up the offline guarantee. Once the server acks, the local copy is dropped. Because any of those uploads can be retried — a dropped ack, a resumed chunk, a background attempt — the append must be [idempotent](../patterns/messaging/idempotency.md): the server dedupes by activity and point so a re-send never double-counts the route.
- **It is write-behind, on the client.** Accept the write locally, acknowledge it to the athlete immediately from on-device state, and reconcile with the system of record later — that is [write-behind](../patterns/caching/write-behind.md) moved onto the phone. The device is a [client-side cache](../patterns/caching/client-side-cache.md) that happens to be the source of truth until sync, and the flush is one [batched](../patterns/concurrency/batching.md) upload instead of 600 pings.

### 2 · Storing 550&nbsp;TB of GPS a year

Route rows dominate; metadata is negligible. Hundreds of terabytes a year is too much to keep uniformly hot, but the access pattern is forgiving — almost every query is for recent activities.

- **Shard by completion time.** Partitioning the store on completion date keeps this-week's runs — yours and your friends' — on a handful of [shards](../patterns/distributed/routing/sharding.md), so the working set stays small even as the archive grows without bound.
- **Tier by age.** Hot recent data on fast storage; warm (a few months to a year) on cheaper disk; cold (older than a year) pushed to [object storage](../patterns/distributed/routing/object-storage.md) like Simple Storage Service (S3), where a rarely-opened trace costs pennies to keep and is fetched on the rare occasion someone scrolls that far back.
- **Don't cache speculatively.** Read throughput is genuinely low — people open a handful of activities, not thousands a second — so a cache earns its keep only if load times degrade. It is deferred, not designed in.
- **Keep the service [stateless](../patterns/distributed/routing/stateless-service.md).** With no hot path and no per-request state, the Activity Service just scales horizontally on CPU, memory and network; there is no reason to carve it into independently-scaling pieces.

### 3 · Letting friends watch live

The extension is that friends follow an activity as it happens, not just its summary. That reintroduces the very pings the offline design removed: location goes up every 2–5&nbsp;seconds so the server can persist it and fan it out to watchers, while the athlete's own screen still runs off local state.

- **Polling beats push here.** Updates land every 2-5 seconds, so unlike chat the next one is predictable, and a few seconds of lag is fine for a spectator. A real-time tier (WebSockets or SSE plus pub/sub) is not needed: the watcher's phone polls the same endpoint on that cadence, offset a couple of seconds. Cost: each watcher adds 0.2-0.5 requests a second.
- **Smart buffering.** Deliberately display the position one or two intervals behind (5–10&nbsp;seconds) and interpolate between points, turning a jerky sequence of jumps into smooth continuous motion — trading a little real-time accuracy for a live-stream feel and absorbing network jitter for free.

The two phones meet only at the Activity Service:

```mermaid caption="How does a friend watch live with plain polling and still see smooth motion?"
sequenceDiagram
    autonumber
    participant A as Athlete phone
    participant S as Activity Service
    participant W as Watcher phone
    loop every 2-5s
        A->>S: location ping (persisted, shown to watchers)
    end
    loop same cadence, offset a couple of seconds
        W->>S: poll the same endpoint
        S-->>W: latest points
    end
    W->>W: show position 5-10s behind, interpolate between points
```

### 4 · A leaderboard of top athletes

Ranking athletes by distance for an activity type, filterable by country, region or city.

- **Naïve.** Sort the activities table on every request — fine at toy scale, a full table scan at real scale. Rejected.
- **Periodic aggregation.** Precompute the rankings on a schedule into a [materialized view](../patterns/distributed/coordination/materialized-view.md) the reads hit directly. A [leaderboard](./top-k.md) that is a few minutes stale is perfectly acceptable, and the read becomes a single indexed lookup.
- **Real-time with Redis.** A sorted set keyed by segment and region, updated as activities complete, gives O(log&nbsp;n) rank updates and instant top-N reads — the answer when the board must be genuinely live.

```mermaid caption="How does a recording survive a dead battery and a dropped connection while touching the network only once?"
sequenceDiagram
    autonumber
    participant P as Recorder (phone)
    participant S as On-device storage
    participant A as Activity Service
    loop every ~2-5s while recording
        P->>P: sample GPS, append to buffer, update distance
    end
    loop every ~10s
        P->>S: persist buffer (survive a dead battery)
    end
    alt connection on completion
        P->>A: upload batched route (chunked)
        A->>A: dedupe by activity + point (idempotent)
        A-->>P: ack
        P->>S: drop local copy
    else no connection
        A--xP: upload fails
        P->>P: retry on reconnect / background sync
    end
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Tracking lives entirely on the phone: no network dependency during a workout, exact live stats for free, and roughly 600× less backend traffic while nobody watches live.
- One batched sync per activity, not a point every few seconds, so 10M concurrent activities barely touch the server unless live sharing is on.
- Time-sharding plus cold tiering keeps hundreds of TB/year affordable while the hot working set stays small.

### What it gives up
<!--meta polarity=con-->

- Durability is bounded by the persistence interval — an unexpected shutdown can lose the last ~10 seconds of a route.
- Nothing a friend sees is live until the athlete finishes, unless live-sharing is switched on — which re-adds the very pings the design worked to remove.
- Polling wastes requests when nothing has changed, and smart buffering means "live" is really a few seconds behind.
- Sharding by completion date sends every new write to the newest shard. 100M uploads a day is about 1,160 a second on average, all landing on today's partition; the peak is not sized here.
- The client is now complex — buffering, local persistence, resume, chunked retriable upload — moving hard bugs onto the least controllable part of the stack, across many device and OS versions.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end flow: create, pause and complete an activity, append GPS points, store a route, then list and open completed activities — plus the realization that the client can record locally rather than streaming every point.
- **Senior** — drives the offline-first framing unprompted, reaches for a status log instead of naïve elapsed time, sizes the ~550&nbsp;TB/year storage and picks time-sharding plus age tiering, and argues polling over WebSockets for live sharing with concrete reasons.
- **Staff+** — treats the client as the primary compute from the first minute, works the durability-vs-battery trade in the buffer, specifies idempotent chunked retriable sync, and volunteers the Redis leaderboard and smart-buffering as operational polish.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Write-Behind](../patterns/caching/write-behind.md) — the phone accepts each Global Positioning System (GPS) write locally and flushes to the system of record only when the activity ends
- [Batching](../patterns/concurrency/batching.md) — a whole activity's ~600-point trace uploads in one request on completion instead of a point every few seconds
- [Client-Side Cache](../patterns/caching/client-side-cache.md) — the activity lives in an on-device buffer persisted to local storage, so tracking and live stats never need the network
- [Event Sourcing](../patterns/architecture/event-sourcing.md) — active time is computed by summing a STARTED/PAUSED/RESUMED status log rather than mutating an elapsed counter
- [Sharding](../patterns/distributed/routing/sharding.md) — the activity store is partitioned by completion time so recent-activity queries hit only a few shards
- [Object Storage](../patterns/distributed/routing/object-storage.md) — traces older than a year are tiered off to cheap object storage like S3
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — the single Activity Service holds no per-request state and scales horizontally under load
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — the leaderboard is a precomputed ranking refreshed on a schedule rather than sorted per request
- [Idempotency](../patterns/messaging/idempotency.md) — chunked, background and retried uploads can all deliver the same points twice, so the server dedupes by activity and point and a re-send never double-counts the route

<!-- relationships:end -->
