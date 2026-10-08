---
title: Ticketmaster
description: "Hold a seat while a fan checks out, never sell it twice, and keep the event page fast when ten million refresh at once"
area: designs-advanced
owner: Oleksandr Derechei
tags: [concurrency, availability, backpressure, read-optimization]
status: stable
aliases: [event ticketing system, ticket booking platform]
solves: [two customers both paid for the same seat because each checkout thought it was free, a fan fills out a five-minute payment form only to find the seat is already gone, my event page melts the instant tickets go on sale and millions hit refresh at once, how do I let someone hold an item during checkout and automatically release it if they walk away, keyword search does a full table scan with LIKE and blows straight past my latency budget]
---

# Ticketmaster

An event-ticketing platform lets people browse events, search a catalogue, and buy seats to concerts, sports, and theatre. The whole design is pulled between two opposed forces: the browse paths want to stay up and scale to a stampede, while the buy path wants strict consistency on a tiny, ferociously contended set of seats.

## Understanding the problem
<!--meta block=description-->

A fan views an event's seat map, picks a seat, pays and gets a confirmed booking. Browsing is read-heavy and must stay up under a marquee on-sale; booking is low-volume but must never sell one seat twice. The page walks through scaling the reads and serialising the one contended write.

## Explained
<!--meta block=explain-->

Ticketmaster sells each seat to exactly one buyer while millions of people hit the same event in the same minute. A buyer who picks a seat takes a 10-minute hold on it in Redis, a fast in-memory store, using one atomic set-if-absent call with an expiry. The hold frees itself, so no sweeper has to run on time. The database stays the final judge: when payment confirms, a conditional update lets only one buyer win and the other is refunded. So a lost hold store hurts the experience but cannot double-sell. Choose a hold with an expiry over a database lock held through checkout, which ties up a connection for minutes. Writes are capped by seat count, so reads are the volume.

- **Read load.** Reads reach hundreds of thousands a second, so cache the event page.
- **Frenzy.** In a genuine frenzy the seat map fills faster than fans can click, so put a waiting room in front admitting people in batches.
- **Duplicate webhooks.** The payment webhook can arrive twice, so key it by booking id.

**Example.** A 60,000-seat arena draws 10 million users, so at most 60,000 of them, 0.6 percent, can ever book. Two buyers tap seat A1 in the same millisecond. The set-if-absent call succeeds for one and fails for the other. The holder is slow, and the 10-minute hold lapses mid-payment. A second buyer takes the seat and pays. Both confirms reach the database, one conditional update wins, and the loser gets a refund. The cost is that one buyer paid and was refunded; the waiting room caps how many fans contend for seats but does not stop a hold from lapsing.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. View an event — its seat map with live availability, plus performer, venue, and date details.
2. Search events by any mix of keyword, performer, location, and date.
3. Book seats — reserve, pay, and receive a confirmed booking, with no seat ever sold twice.

Out of scope: viewing one's own past bookings, admins creating events, and surge or dynamic pricing — named explicitly so the core stays narrow.

### Non-functional
<!--meta requirement=nfr-->

- **Consistency (booking)** — one seat is sold to exactly one buyer, always. This is the hard requirement.
- **Availability (view / search)** — the browse paths stay up under peak, even if the booking path degrades.
- **Scale** — a single popular event drawing on the order of **10&nbsp;million** concurrent users.
- **Latency** — search returns in under **500&nbsp;ms**.
- **Read-heavy** — reads outnumber writes by roughly **100:1**.

## Right-sizing
<!--meta block=sizing-->

**Writes are capped by inventory.** A 60,000-seat arena has exactly 60,000 tickets to sell, no matter how many people try. Total successful bookings for an event are therefore bounded and small — the challenge is never write throughput, it is write contention: thousands of requests converging on the same handful of seat rows in the same second.

**Reads are the number that hurts.** At the on-sale moment, a large fraction of 10&nbsp;million users load and re-poll the seat map. With a 100:1 read-to-write ratio and heavy refreshing, peak reads land **on the order of hundreds of thousands per second** for one event — that is the load caching and the edge have to absorb so the database never feels it.

**Storage is easy.** One ticket row per seat per event; a few thousand events at tens of thousands of seats each is on the order of tens of millions of rows. That fits a single relational primary with read replicas. The dataset does not force sharding; the contention forces the locking.

## Core entities
<!--meta block=entities-->

Six entities, with one deliberate split at the centre:

- **Event** — the thing being sold: date, description, type, and links to its performer and venue.
- **Performer** — kept generic (artist, team, company, collective): a name, a description, and links to their work.
- **Venue** — the physical place: address, capacity, and a `seatMap` (a JSON structure of sections, rows, seat numbers, and coordinates the client renders).
- **Ticket** — one row per seat, generated from the seat map when the event is created: `eventId`, seat details, price, and `status` (available / booked). The client overlays ticket status onto the seat map to draw the interactive picker.
- **Booking** — a buyer's order: `userId`, a list of ticket IDs, total price, and `status` (in-progress / confirmed). Kept separate from Ticket because one purchase can group several seats under a single payment.
- **User** — the buyer; present so bookings have an owner.

## The interface
<!--meta block=interface-->

A small representational state transfer (REST) surface. The booking naïvely wants to be one call, but the reservation problem forces it into two — hold the seats first, take payment second:

```http summary="HTTP — view, search, reserve, confirm"
GET /events/{eventId}
→ 200 { event, venue, performer, tickets: [...] }   # tickets carry seat + status so the client draws the map

GET /events/search?keyword=&start=&end=&page=&pageSize=
→ 200 { events: [...] }

# reserve first, confirm after payment
POST /bookings              { eventId, seatIds: [...] }
→ 201 { bookingId }                                  # holds the seats for 10 minutes
                                                     # 409 if a seat is already held or sold

POST /bookings/{bookingId}/confirm  { paymentToken }
→ 200 { status: "confirmed" }                        # charges, marks seats sold, releases the hold
                                                     # 402 if the payment is declined
```

Splitting reserve from confirm is what lets a fan spend five minutes at the payment form without either losing the seat or blocking anyone else on a live database transaction — the mechanism behind that hold is the first deep dive.

## How the system is built
<!--meta block=architecture-->

Everything enters through an [API gateway](../patterns/distributed/routing/api-gateway.md) that handles auth, rate limiting, and routing, then fans out to three services over one shared relational store. The **Event Service** serves the read-heavy view path, fronted by a cache. The **Search Service** answers queries out of a search index kept in sync with the database. The **Booking Service** owns the one consistency-critical path: it holds seats in a lock store, writes bookings, and talks to Stripe. Booking, ticket, and event data are tightly coupled and the booking needs ACID (atomicity, consistency, isolation, durability) transactions, so the services deliberately share one Postgres database rather than splitting it for its own sake.

```mermaid caption="Reads (cached view, CDC-synced search) scale out independently; the one consistency-critical path (seat lock → ACID booking → Stripe) runs through the Booking Service on the shared store."
flowchart TB
    Client["Client / browser"]
    Client -->|"browse / search / book"| Gateway["API Gateway — auth, rate limit"]
    Gateway -->|"GET /events/:id"| Event["Event Service — read cache"]
    Gateway -->|"GET /events/search"| Search["Search Service — CDC-synced index"]
    Gateway -->|"POST /bookings"| Booking["Booking Service"]
    Event -->|"cached read, miss → DB"| DB[("Postgres — events + bookings")]
    DB -->|"CDC stream"| Search
    Booking -->|"SET NX EX seat lock"| Redis[("Redis lock store")]
    Booking -->|"write booking, ACID"| DB
    Booking <-->|"charge + webhook"| Stripe["Stripe"]:::ext
    classDef ext stroke-dasharray:4 4;
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Holding a seat while the fan checks out

Without a hold, a buyer can fill out a five-minute payment form only to learn the seat is gone — and two buyers can reach payment for the same seat. The seat has to be locked at selection and freed if checkout is abandoned.

- **Long database lock.** A `SELECT … FOR UPDATE` that stays open for the whole checkout locks the row until commit. But database locks are built for near-instant transactions; holding one open for minutes ties up a connection, invites deadlocks, and collapses under contention. A `lock_timeout` only converts the wait into a hard user-facing error. Rejected.
- **Status field + expiry + cron.** Give the ticket a `reserved` status and an expiry timestamp, and run a cron job that sweeps expired reservations back to `available`. Better, but correctness now depends on the sweep running on time — a lagging or failed cron leaves seats stuck locked, worst exactly during a hot on-sale.
- **Distributed lock with time to live (TTL) (chosen).** Hold the seat in Redis with a [distributed lock](../patterns/distributed/coordination/distributed-lock.md) keyed by ticket ID, value set to the buyer's user ID, using an atomic `SET key value NX EX 600` so acquisition can't race. The lock auto-expires after 10&nbsp;minutes if payment never comes, so no external sweep decides correctness. Reservation state lives entirely in Redis; the ticket table needs only available and booked. For a multi-seat order, locks are taken one at a time and rolled back if any fails.

The confirm step then charges the card. The client tokenizes card data with Stripe.js so the server never touches raw card numbers; it creates a Stripe PaymentIntent, and Stripe reports the result back through a webhook. That webhook runs a transaction flipping the ticket to sold and the booking to confirmed. Because Stripe retries webhooks, the handler must be [idempotent](../patterns/messaging/idempotency.md) — it uses the booking ID as an idempotency key and checks current status before applying. The database is the final arbiter: even if the Redis TTL (time to live) lapses mid-payment and a second buyer grabs the seat, an [optimistic-concurrency](../patterns/distributed/coordination/optimistic-concurrency-control.md) check at the DB lets only one confirm win; the loser is auto-refunded. That backstop is why a lock-store outage degrades user experience (UX) but never double-sells. Release on payment failure or cancel is a compare-and-delete: the key is deleted only if its value still equals the buyer's user ID, so a late release never frees the next buyer's hold.

### 2 · Serving the event page to millions at once

When tickets drop, one event page gets hammered by thousands of simultaneous refreshes. The Event Service is [stateless](../patterns/distributed/routing/stateless-service.md), so it scales horizontally behind a [load balancer](../patterns/distributed/routing/load-balancer.md) (round-robin or least-connections) — but raw instance count isn't the answer, memory is. Event details, performer bios, and static venue and seat-map data are high-read and change rarely, so they sit in a [read-through cache](../patterns/caching/read-through.md) (Redis or Memcached) keyed `eventId → eventObject`. Static venue data gets a long TTL; fast-moving availability gets a short one, with entries deleted when an event actually changes. With a long TTL on static data, most reads never reach Postgres. Holds live only in Redis, so the seat-map read merges active holds into the cached availability.

### 3 · Surviving the on-sale stampede

For a hugely popular event the seat map goes stale the instant it loads — fans keep clicking seats that are already gone. Server-Sent Events can push seat-map changes the moment a seat is taken, which helps moderately busy events; for a genuine frenzy the map fills faster than anyone can act, and pushing updates only makes the churn more disorienting. The better answer is often the simpler, less-technical one: a **virtual waiting queue** in front of the Booking Service. On requesting the booking page a user is placed in a Redis sorted set ordered by arrival, given a live position over SSE, and admitted in controlled batches as capacity frees up; admitted sessions are marked in an `admitted:{eventId}` set and everyone else is turned away at the door. This is [queue-based load levelling](../patterns/distributed/resilience/load-leveling.md) — the spike is smoothed into a steady, survivable trickle, and the booking path only ever sees a calm crowd.

The queue admits fans in batches while everyone else waits at the door:

```mermaid caption="How does a virtual waiting queue turn an on-sale spike into a trickle the Booking Service can survive?"
sequenceDiagram
    autonumber
    participant F as Fan
    participant B as Booking Service
    participant R as Redis
    F->>B: request booking page
    B->>R: add to sorted set, ordered by arrival
    B-->>F: live position over SSE
    loop as capacity frees
        B->>R: admit next batch, mark in admitted:{eventId} set
    end
    alt fan is in the admitted set
        B-->>F: admitted to booking
    else not admitted yet
        B--xF: turned away at the door
    end
```

### 4 · Making keyword search fast

Naïve search leans on `LIKE '%taylor%'`, which forces a full table scan and cannot meet a 500&nbsp;ms budget. Plain B-tree indexes don't help partial-string matches. The real fix is a search-optimised store: Postgres full-text (`tsvector` + GIN) handles it in-database, but at high volume a dedicated **Elasticsearch** cluster with inverted indexes wins, and it adds typo-tolerant fuzzy matching that SQL struggles with. Elasticsearch is kept in sync with Postgres through [change data capture](../patterns/distributed/coordination/change-data-capture.md) — inserts, updates, and deletes stream across for near-real-time freshness. To shave repeated queries further, cache popular non-personalised result sets (keyed by search parameters, with a TTL) and push them to a [content delivery network (CDN)](../patterns/distributed/routing/cdn.md) so identical searches are answered close to the user; because the same query yields the same results for everyone, edge caching is safe here in a way it never is on the personalised booking path.

```mermaid caption="How is a seat held during checkout, and what stops a double-sell when the hold expires mid-payment?"
sequenceDiagram
    autonumber
    participant F as Fan
    participant B as Booking Service
    participant R as Redis lock store
    participant DB as Postgres
    participant S as Stripe
    F->>B: select seat
    B->>R: SET ticket=buyer NX EX 600
    R-->>B: held for 10 min
    F->>B: confirm with card token
    B->>S: create PaymentIntent
    S-->>B: webhook paid (idempotent on booking ID)
    B->>DB: flip to sold, OCC check
    alt this buyer wins the row
        DB-->>B: confirmed
    else TTL lapsed, seat already sold
        DB--xB: conflict
        B->>S: auto-refund the loser
    end
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- A seat held by a TTL lock in Redis stops two buyers holding it at once and auto-releases if the buyer abandons checkout, with no long-lived database lock; if the TTL lapses mid-payment, the database check is the guard.
- View and search scale out independently behind a read-through cache, the edge, and stateless services, absorbing the on-sale burst.
- The database's optimistic-concurrency check is the final guard, so a seat is never sold twice even if the lock store fails.

### What it gives up
<!--meta polarity=con-->

- Reservation state lives in Redis, so rendering live availability means merging lock state into the DB view — an extra hop and a source of skew.
- Search rides an Elasticsearch index synced by CDC, so a just-announced event can be briefly missing from results.
- A TTL that lapses mid-payment can let two buyers race one seat; the loser's charge has to be auto-refunded.
- The waiting queue adds real wait time and operational weight.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a clean API and data model, a working view-and-book flow, and no-double-booking solved with at least the status-field-plus-timeout-plus-cron approach. Depth beyond that is a bonus.
- **Senior** — moves briskly through the high-level design to leave room for depth: lands a distributed lock (or equal) for reservations, reaches for Elasticsearch on search unprompted, and discusses handling popular events with clear tradeoffs on scalability and reliability.
- **Staff+** — drives two or three areas deep with hands-on familiarity, volunteers the non-obvious win (the waiting queue), balances consistency, availability, and operability, and leaves the interviewer having learned something.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) — a Redis time to live (TTL) lock keyed by ticket ID holds a seat during checkout and self-releases if the buyer walks away
- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — the database (DB) confirm is guarded by an optimistic concurrency control (OCC) check so only one buyer wins a contested seat even after the lock lapses
- [Idempotency](../patterns/messaging/idempotency.md) — the Stripe webhook handler dedupes on booking ID because Stripe retries deliveries
- [Read-Through](../patterns/caching/read-through.md) — event, performer, and static venue data are served from a read-through cache so the read burst rarely reaches Postgres
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — a virtual waiting queue admits fans in controlled batches, smoothing the on-sale spike before it reaches booking
- [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) — Postgres inserts, updates, and deletes stream to Elasticsearch to keep the search index fresh
- [CDN](../patterns/distributed/routing/cdn.md) — non-personalised search results are pushed to the edge so identical queries never hit the origin
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — one gateway fronts auth, rate limiting, and routing to the event, search, and booking services
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — the Event Service holds no per-request state, so it scales horizontally behind a load balancer during the stampede
- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — The stateless Event Service scales out behind a load balancer using round-robin or least connections

<!-- relationships:end -->
