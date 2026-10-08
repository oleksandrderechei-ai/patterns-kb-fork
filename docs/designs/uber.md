---
title: Uber
description: "Match a rider to the nearest free driver within a minute — at millions of location pings a second, and never double-booking a driver"
area: designs-advanced
owner: Oleksandr Derechei
tags: [coordination, latency, throughput]
status: stable
aliases: [ride-sharing, ride-hailing, Lyft]
solves: [millions of devices report their location every few seconds and writing every ping straight to the database is melting it, I need the nearest available options to a point but scanning a latitude/longitude table is far too slow, the same worker keeps getting handed two jobs at once because my instances do not coordinate their locks, a request times out and is lost because its timer lived in memory on a server that crashed, a sudden surge of requests overwhelms my matching service and some silently get dropped]
---

# Uber

A ride-sharing platform quotes a fare, matches the rider to a nearby available driver, and tracks the trip to its destination. The hard parts are all real-time and geospatial: absorb a flood of driver-location updates, search them by proximity in milliseconds, and hand each ride to exactly one driver without two matchers colliding.

## Understanding the problem
<!--meta block=description-->

A rider requests a ride, and the system finds a nearby available driver, offers the trip and guides both to the destination. The hard part is constantly moving drivers: 10 million drivers broadcast their position continuously, matching must finish within about a minute, and a driver can only do one thing at a time. Three problems: ingesting location pings, searching them geographically, and never offering one driver two rides.

## Explained
<!--meta block=explain-->

Uber matches a rider to a nearby driver while 10 million drivers report their position every 5 seconds, which is 2 million writes a second. Two moves make it work. Driver positions live in Redis (an in-memory store with built-in location search), where each ping overwrites the last and one query returns the closest drivers in milliseconds. A matching job then offers the ride to one driver at a time and holds that driver in a [lock](../patterns/distributed/coordination/distributed-lock.md) that expires on its own after the 10-second offer window. Choose memory over a database for positions: writing every ping to a database costs too much before speed even matters, and a lost store rebuilds in seconds as drivers re-report. Without the expiring lock, a silent driver would stay reserved and a second request could be offered to the same driver.

- **Ping volume.** Parked drivers still send pings. Send them slower pings with a tuned rule, such as every 30 seconds when stationary.
- **Surge bursts.** 100,000 requests from one spot overload matching. Hold them in a durable [queue](../patterns/messaging/message-queue.md) so each request waits its turn.
- **Fall-through engine.** Moving to the next driver after a decline must survive a crash. A [durable workflow](../patterns/distributed/coordination/workflow-orchestration.md) saves progress, but you now run that engine.

**Example.** 2 million pings a second times 86,400 seconds is about 173 billion writes a day. At 1.25 dollars per million writes, that is about 216,000 dollars a day for a managed database, so the pings go to Redis. A rider at a concert requests a ride. The matcher searches 3 km and offers driver D1, locking D1 for 10 seconds. D1 stays silent, so the lock expires and D1 is free. The workflow offers D2, who accepts, and the lock is released. No second ride was ever offered to D1. If D1 accepts at 10.0 seconds, after the lock expired, the ride-state check rejects the accept. The cost is the workflow engine to operate.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. A rider enters a pickup and destination and gets back a fare estimate.
2. A rider requests a ride against that estimate, which triggers matching.
3. Matching pairs the request with a nearby available driver.
4. The chosen driver can accept or decline; on accept, they receive pickup and drop-off details to navigate.

Out of scope: post-trip ratings, scheduling rides in advance, and ride categories (X, XL, Comfort) — named explicitly so the core stays narrow.

### Non-functional
<!--meta requirement=nfr-->

- **Low-latency matching** — a request matches (or fails) within about a minute.
- **Consistency in matching** — a driver is never assigned two rides at the same time; each is offered exactly one request at a time.
- **Throughput** — survives peak-hour and special-event surges, up to ~100k requests from a single location at once.
- **Out of scope** — GDPR (General Data Protection Regulation)-style compliance, failover/redundancy, and observability, so the design stays on the load-bearing decisions.

## Right-sizing
<!--meta block=sizing-->

**Location writes.** Roughly 10M drivers online, each reporting position about every 5&nbsp;seconds, is **~2M location updates/second**. This single number, not the rider traffic, is what dictates the architecture — it is orders of magnitude larger than the request rate.

**Cost sanity check.** Push those 2M writes/sec of \~100-byte records straight at a managed key-value store on on-demand pricing (\~$1.25 per million writes) and you are looking at **north of $200k/day** just to record where cars are. The naïve "write every ping to the database" design is dead on arrival on cost alone, before latency even enters the picture.

**Requests and peaks.** Ride requests are far rarer than pings — one [proximity search](../themes/proximity-search.md) per request, gated by a <1-minute match SLA (service-level agreement) and a 10-second-per-driver accept window. But demand is violently spiky: a concert letting out can fire **~100k requests from one spot** in a moment, so the request path has to buffer and drain rather than drop.

## Core entities
<!--meta block=entities-->

Each entity has one clear owner:

- **Rider** — a passenger requesting rides: contact and payment details.
- **Driver** — a registered driver: personal and vehicle details, plus an availability status.
- **Fare** — a quote for a prospective trip: pickup, destination, estimated amount, and estimated time of arrival (ETA). Created before the ride exists so the rider can accept or decline it.
- **Ride** — a single trip from confirmation to completion: the rider and driver, the state (`requested`, `accepted`, `in_progress`, `completed`), the route, the charged fare, and pickup/drop-off timestamps.
- **Location** — a driver's live position: latitude, longitude, and the time it was last reported. This is the high-churn entity that never belongs in the primary database.

## The interface
<!--meta block=interface-->

Four endpoints cover the whole flow. Matching itself has no endpoint — it is a backend process the request triggers.

```http summary="HTTP — quote, request, locate, respond"
POST /fare
{ "pickup": {lat, long}, "destination": {lat, long} }
→ 200 { "fareId", "amount", "etaSeconds" }

POST /rides
{ "fareId" }
→ 200 { "rideId", "status": "requested" }   // triggers matching

POST /drivers/location            // driverId comes from the token, never the body
{ "lat", "long" }
→ 200 OK

PATCH /rides/{rideId}
{ "action": "accept" | "decline" }
→ 200 { "rideId", "status": "accepted", "pickup": {lat, long} }
```

One security note that separates a passing answer from a sloppy one: the driver's identity on a location update must be read from the session token, not accepted from the request body. Timestamps are stamped by the server, and the charged fare is read back from the database — a client that can post its own `driverId`, `timestamp`, or `fareEstimate` is a client that can spoof its position or its price.

## How the system is built
<!--meta block=architecture-->

Every rider and driver call enters through an [API gateway](../patterns/distributed/routing/api-gateway.md) that authenticates, rate-limits, and routes to the right service. The **Ride Service** owns fares and ride state — it calls a third-party **Mapping API** for distance and travel time, applies the pricing model, and persists fares and rides. Requesting a ride does not call the matcher synchronously; it drops the request onto a **queue**, and the **Ride Matching Service** drains it. Meanwhile the **Location Service** swallows the position firehose into an in-memory geospatial store, which the matcher searches by proximity. When a match is found, the **Notification Service** pushes the offer to the driver's phone over APNs or FCM, and the driver's accept flows back through the gateway to the Ride Service.

```mermaid caption="The request path (gateway → queue → matcher) is decoupled from the location path (pings → Location Service → geo store); the matcher joins them by searching live positions."
flowchart TB
    Rider["Rider app"]
    Driver["Driver app"]
    GW["API Gateway"]
    Ride["Ride Service"]
    Q[["Request queue"]]
    Match["Ride Matching Service"]
    Loc["Location Service"]
    Geo[("Redis · geo + locks")]

    Rider -->|"POST /rides"| GW
    Driver -->|"POST /drivers/location"| GW
    GW -->|"ride request"| Ride
    Ride -->|"enqueue request"| Q
    Q -->|"drain"| Match
    GW -->|"location pings"| Loc
    Loc -->|"GEOADD"| Geo
    Match -->|"GEOSEARCH · lock"| Geo
    Match -->|"push offer (APNs / FCM)"| Driver
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Absorbing the location firehose and searching it fast

The naïve design fails twice over: 2M writes/sec buries any general-purpose database, and even if it did not, a proximity query over raw latitude/longitude is a full table scan — a B-tree on two independent columns cannot index a 2D neighbourhood, so "who is within 3&nbsp;km" degrades to reading everything.

- **Batch into a geospatial store.** The first real improvement is to coalesce updates over a short window and [batch](../patterns/concurrency/batching.md)-write them, cutting the transaction count sharply, and to store them in a spatial index — a quad-tree, or PostgreSQL with the PostGIS extension. This works, but the batch interval buys throughput at the cost of staleness: the stored position now lags the car, and the matcher can pick a driver who has already moved on.
- **Real-time in-memory geo — this design's answer.** Keep positions in an in-memory store with native geospatial support, Redis. A [geohash](../patterns/distributed/routing/geohash.md) encodes each driver's lat/long into a single 52-bit score in a sorted set keyed by `driverId`. `GEOADD` upserts a position and each write overwrites the last, so data is always current and no batching is needed. `GEOSEARCH` returns everyone within a radius in milliseconds. A companion last-seen key per driver with a TTL, or a periodic sweep that `ZREM`s drivers silent for a few ping intervals, removes stale drivers and keeps storage small. `GEOSEARCH` also returns busy drivers, so remove a driver from the set on accept and re-add it at trip end, or over-fetch `COUNT` and filter by status. One geo key cannot take about 2M writes/s, so shard the set by region (see deep dive 5). Durability, the usual worry with an in-memory store, matters little here: drivers re-report every ~5 seconds, so even a total flush rebuilds current state in seconds. Back it with snapshotting and a replica for failover and the risk is bounded.

```text summary="Redis — upsert a position, then search it"
# driver client pings; each GEOADD overwrites the prior position
GEOADD drivers:geo <long> <lat> <driverId>

# matcher asks for the closest available drivers to the pickup
GEOSEARCH drivers:geo FROMLONLAT <long> <lat> BYRADIUS 3 km ASC COUNT 10
```

A companion optimisation attacks the write volume at its source: **adaptive ping intervals**. Instead of a fixed 5-second beat, the driver client decides how often to report from on-device context — slow when parked, faster when moving quickly or turning often. It pushes work to the edge (the same instinct as a file-upload client chunking before it sends) and can cut update volume substantially, at the cost of a genuinely fiddly interval algorithm to tune.

### 2 · Never offering one driver two rides at once

The consistency requirement is really a locking problem: a driver gets a 10-second window to answer one offer before the system moves on, and no two matcher instances may offer the same driver simultaneously. It is the same shape as reserving a concert ticket for a limited window and selling it only once.

- **In-memory timers per instance.** Each matcher marks a request "locked" and runs its own local countdown. With many instances there is no shared truth, so two can lock the same driver, and if an instance crashes mid-window the lock is simply lost. A cron to sweep orphaned locks papers over it but adds delay and complexity.
- **A status column with a timeout.** Move the lock into the database and lean on its transactions so only one instance wins. Better, but the release still depends on an in-memory timeout somewhere — if that process dies, the driver can stay "outstanding" forever.
- **Distributed lock with TTL — this design's answer.** Acquire a [distributed lock](../patterns/distributed/coordination/distributed-lock.md) in Redis keyed by `driverId`, with the TTL (time to live) set to the 10-second window: `SET lock:driver:<driverId> <matcherToken> NX PX 10000`. Winning the key means no other instance can offer that driver a ride. Accept within the window and you release it only if the stored value equals your token, then mark the ride `accepted`. Stay silent and the key simply expires, freeing the driver with zero bookkeeping. A Redis failover can drop lock keys, so an accept also checks ride state in the Ride Service. The system now leans on the lock store's availability, but because every lock is short-lived, recovery from a hiccup is cheap.

Two matcher instances race for the same driver, and the lock key decides:

```mermaid caption="How does a Redis lock with a 10-second TTL stop two matchers offering the same driver, and free the driver on silence?"
sequenceDiagram
    autonumber
    participant A as Matcher A
    participant B as Matcher B
    participant R as Redis lock
    participant D as Driver
    A->>R: acquire lock on driverId, TTL 10s
    R-->>A: lock won
    B->>R: acquire lock on driverId
    R--xB: key held, cannot offer this driver
    A->>D: offer the ride
    alt driver accepts within the window
        D-->>A: accept
        A->>R: release lock, mark ride accepted
    else driver stays silent
        R->>R: key expires after 10s, driver freed
    end
```

### 3 · Not dropping requests when demand spikes

Processing requests the instant they arrive is fine until 100k of them land at once and the matcher — or an instance of it — falls over, taking its in-flight work with it. The fix is to stop coupling arrival rate to processing rate.

- **Queue between request and match (chosen).** Put a durable [message queue](../patterns/messaging/message-queue.md) — Kafka, or a managed equivalent — in front of the matcher. Requests are enqueued and drained at the matcher's own pace. This is [queue-based load leveling](../patterns/distributed/resilience/load-leveling.md): the buffer absorbs the spike while the consumer works steadily, and [autoscaling](../patterns/distributed/routing/autoscaling.md) adds matcher instances when the backlog grows, so autoscale on consumer lag per partition. Commit each message's offset only after the durable workflow has started, so an instance that dies mid-request leaves the message in the queue for another to pick up — nothing is lost. The consumer only starts the durable workflow (deep dive 4) and then commits the offset. The workflow owns the long per-driver waits, so a consumer is not kicked out of its group for polling too slowly.
- **Refinements.** Partition the queue by geographic region so unrelated cities scale independently. And because strict FIFO (first in, first out) lets one slow request head-of-line-block the rest, order by priority (proximity, driver rating). Partitions are FIFO only, so priority needs a separate topic per tier, or a priority queue in the matcher after consumption, with an aging rule so low-priority requests are not starved.

### 4 · When the chosen driver just doesn't answer

A phone dies, a driver steps away — the offer times out and the system must fall through to the next-best driver cleanly, across crashes, without ever double-assigning. Chaining delayed messages (schedule a 10-second timer alongside each offer, and on fire, advance to the next driver if still unassigned) works but is a minefield of race conditions: an accept landing just as the timer fires can reassign a ride that was already taken.

- **Durable execution (chosen).** Model the whole match as a durable workflow on an [orchestration](../patterns/distributed/coordination/workflow-orchestration.md) engine — Temporal (Uber authored its precursor, Cadence) or AWS Step Functions. The workflow is: offer to the top driver → wait up to 10 seconds → if accepted, done; if declined or timed out, advance to the next → repeat until matched or the list is exhausted. Timeouts, retries, and state are the framework's job, and the state is persisted, so a matcher that crashes mid-ride resumes exactly where it left off. The price is another moving part to run and reason about — worth it for a revenue-critical flow that must never silently drop a rider.

### 5 · Scaling out to cut latency

Vertical scaling is barely worth the breath at this size — expensive, capped, and a single point of failure. The real lever is geography. [Shard](../patterns/distributed/routing/sharding.md) services, queues, and stores by region so a rider in one city talks to nearby infrastructure, which both scales horizontally and shortens the physical round-trip. [Consistent hashing](../patterns/distributed/routing/consistent-hashing.md) spreads load evenly and makes rebalancing survivable, and read replicas lift read throughput. The only cross-shard cost is a [Scatter-Gather](../patterns/messaging/scatter-gather.md) when a proximity search straddles a shard boundary near a city edge — rare enough to handle as the exception rather than design around.

```mermaid caption="How does the match fall through to the next driver on a decline or timeout without ever dropping the rider or double-assigning?"
stateDiagram-v2
    [*] --> Offering: rider request, offer top driver
    Offering --> Offering: declined / timed out, advance to next driver
    Offering --> Accepted: driver accepts within 10s
    Offering --> Exhausted: driver list exhausted
    Accepted --> [*]
    Exhausted --> [*]
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Millions of location writes a second land in memory and answer proximity queries in milliseconds, at a fraction of a database's cost.
- A TTL lock gives one offer per driver across matcher instances while the lock key survives, with self-cleaning expiry and no timer bookkeeping. A lock-store failover can drop keys, so an accept also checks ride state.
- The queue plus durable workflow means peaks are absorbed, not dropped, and a crashed matcher resumes without losing an in-flight ride.

### What it gives up
<!--meta polarity=con-->

- The system now hangs on the availability of in-memory infrastructure — the geo store and the lock store both need robust failover.
- Durable execution and partitioned queues add real operational surface: more components to run, monitor, and reason about.
- Positions can still be seconds stale between pings, and cross-shard proximity searches near a boundary pay a Scatter-Gather tax.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a clear API and data model and a working end-to-end design that meets the functional requirements. Recognises that location search needs some spatial index, even without landing on a specific one, and lands at least the database-status solution for one-driver-at-a-time locking.
- **Senior** — moves briskly through the high-level design to spend real time on at least two of the hard problems (geospatial search, the locking race, the demand-spike queue), naming concrete tech and arguing the trade-offs in scalability, performance, and maintainability rather than just listing options.
- **Staff+** — drives depth on three or more areas with practical, real-world judgement: why an in-memory geo store over PostGIS here, why a TTL lock over a swept status column, why durable execution earns its complexity. Anticipates the failure and staleness modes unprompted, and leaves the interviewer with a sharper picture than they walked in with.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Geohash](../patterns/distributed/routing/geohash.md) — each driver's live lat/long is encoded into a sortable geohash score in Redis so the matcher finds the nearest available drivers by radius in milliseconds
- [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) — a Redis key per driverId with a 10-second time to live (TTL) guarantees no two matcher instances offer the same driver a ride at once, and expiry frees the driver with no timer bookkeeping
- [Workflow Orchestration](../patterns/distributed/coordination/workflow-orchestration.md) — the offer-timeout-and-fall-through-to-the-next-driver sequence runs as a durable Temporal workflow whose persisted state survives a matcher crash mid-ride
- [Message Queue](../patterns/messaging/message-queue.md) — ride requests are enqueued and their offset committed only after a successful match, so a surge is buffered and a dead worker's message is re-picked by another instance
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — the request queue absorbs 100k-at-once demand spikes while the matcher drains at its own pace and autoscaling adds instances behind it
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — a single front door authenticates, rate-limits, and routes every rider and driver call to the correct internal service
- [Sharding](../patterns/distributed/routing/sharding.md) — services, queues and stores are partitioned by region so riders reach nearby infrastructure and most proximity searches stay within a single shard
- [Scatter-Gather](../patterns/messaging/scatter-gather.md) — A proximity search that straddles a shard boundary near a city edge queries both shards and merges
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — Services, queues and stores partitioned by region use a hash ring so load spreads and rebalancing survives a host change
- [Batching](../patterns/concurrency/batching.md) — the rejected first option: coalescing location pings over a short window trades throughput for stale positions, so the chosen design overwrites in Redis instead

<!-- relationships:end -->
