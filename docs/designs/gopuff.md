---
title: Gopuff
description: "Aggregate deliverable inventory across hundreds of micro-warehouses — reads under 100 ms, orders serialized so no physical unit is sold twice"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [transactions, latency, read-optimization]
status: stable
aliases: [local delivery service, rapid delivery, q-commerce]
solves: [I must show which products reach a customer within the hour but my stock sits in hundreds of tiny warehouses, two customers keep buying the same last physical unit and one of the orders can never be fulfilled, my availability page must answer in under 100 ms even though every request fans out to dozens of warehouses, a warehouse that looks close on a map is unreachable in an hour because of a river or rush-hour traffic, people browsing generate far more traffic than people buying and my inventory database cannot keep up]
favourite: true
---

# Gopuff

A rapid local-delivery service stocks convenience goods in hundreds of small distribution centers placed close to customers. The interesting engineering is not the catalog — it is answering "what can reach me within the hour?" by uniting inventory across every nearby warehouse, fast, while never promising the same physical unit to two buyers.

## Understanding the problem
<!--meta block=description-->

Stock sits in hundreds of micro distribution centers inside the cities they serve, so what a customer can buy is the union of stock across every center that can reach their address within the hour. The system answers two questions: what can reach me, and reserve these units for me. The hard part is selling each physical unit once under a surge while reads stay fast.

## Explained
<!--meta block=explain-->

Gopuff answers what you can buy from copies of the stock that the order path never touches, and takes each order in one transaction that claims the physical units, so a unit sells once. It works because browsing outnumbers buying 200 to one, so you keep browsing on a cache and read-only copies, and keep the one writable database per region for orders. Reachability is decided by drive time to the few nearby warehouses, not by distance. Choose it over one table where reads and orders share a database, because 20,000 reads a second would otherwise land on the machine that arbitrates orders. Under a surge, browsing is shed first and the order path is protected.

- **Leader failure.** A failed regional leader stops ordering there, so keep browsing off it and the outage stays partial.
- **Hot rows.** Orders on one item fight over a row and aborts waste work, so retry with random delays.
- **Stale counts.** A cached count is up to a minute old, so checkout is the authority and answers 409 when stock is gone.

**Example.** Gopuff takes 10 million orders a day, about 116 a second. At 200 page views per order that is about 20,000 availability reads a second, served from the cache and replicas. Two carts both see the last carton, a count up to 60 seconds old. Both orders run; strict isolation commits one and aborts the other, which retries after a short random delay, finds 0 left and gets a 409. The five-line order that won wrote about 11 rows.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Query, by location, the items deliverable within one hour — the effective availability being the union of inventory across all DCs in range of that location.
2. Place a single order containing multiple items.

Out of scope, named on purpose: payments, driver routing and delivery, catalog/search APIs, and cancellations/returns. The focus is aggregating availability and preventing double-booking of physical stock.

### Non-functional
<!--meta requirement=nfr-->

- **Fast reads** — availability lookups under **100&nbsp;ms**, because they back a search-like browsing experience.
- **Strong consistency** — no two customers ever purchase the same physical unit of inventory, and a unit is never held by nobody.
- **Scale** — up to **10k DCs** and **100k catalog items**, at roughly **10M orders/day**.
- **Burst tolerance** — evening peaks and weather events concentrate several times the mean load on a few neighbourhoods; browsing may degrade, ordering may not.
- **Drive-time reachability** — a DC counts only if its drive time to the address fits the hour; straight-line distance promises deliveries no rider can make.
- **Reads off the order path** — browsing outnumbers buying 200 to one, so availability reads never touch the database that arbitrates orders.
- Out of scope: privacy/security hardening and disaster recovery.

## Right-sizing
<!--meta block=sizing-->

Three things fall out of the arithmetic. Almost nobody is buying compared with the number of people looking, the stock data itself is small, and the traffic is lumpy in both place and time — a few neighbourhoods in a few hours carry most of it. Everything this design spends money on is there to make looking cheap and to keep looking away from the machine that takes orders.

**The problem:** 10M orders/day across up to 10k DCs, where the load that decides the architecture is people browsing, not people buying. **The shape:** synchronous request/response on both paths — an availability query is one fan-out answered in one hop, and an order must tell a waiting customer yes or no, so nothing here may be handed to a worker and confirmed later. **The stores:** two that we run — the regional inventory-and-orders store, leader plus replicas, and the availability cache — plus a rented travel-time service, which is capacity bought rather than operated.

**Required capabilities:**

- Durable transactional store with serializable isolation — the reservation, the order and the decrement must commit together or not at all. → non-functional requirement (NFR): strong consistency; functional requirement (FR): order.
- Read replicas of that store — availability reads must not land on the node that arbitrates orders. → NFR: fast reads.
- Read cache with per-key invalidation — the same neighbourhood asks the same question hundreds of times a minute. → NFR: fast reads.
- Region-partitioned inventory — a location touches only nearby DCs, so a query and a write should each stay inside one partition. → NFR: scale; burst tolerance.
- In-process copy of the DC table — the prune runs on every availability query and cannot afford a round trip. → NFR: fast reads.
- Spatial keying over that table — turns "which DCs are near this point" into a cell lookup instead of a scan over 10k rows. → NFR: fast reads.
- External drive-time estimate — reachability is a road-network question and we do not own a road network. → FR: availability by location.
- Scheduled reclaim of expired holds — a unit held by an order that stalled must return to sale without a human. → NFR: strong consistency.
- Admission control at the edge, keyed on source and on region — a surge has to be payable in browsing before it is payable in orders. → NFR: burst tolerance.

**The numbers:**

- Orders: 10M/day ÷ 86,400&nbsp;s ≈ 116/s mean; ×3 for evening concentration (most of the day's orders land in the dinner and late-evening windows) ≈ **350 order transactions/s at peak**, fleet-wide. → NFR: scale.
- Row-writes: a five-line order claims 5 inventory rows and inserts 1 order plus 5 order_item rows ≈ 11 row-writes; at peak ≈ **3.9k row-writes/s** across the regional leaders, against the ~10k writes/s a well-tuned relational node sustains. → NFR: scale.
- Availability reads: 10 page views per session ÷ 5% conversion = 200 page views per order; 116 × 200 ≈ **20k availability queries/s mean**, ~60k/s at the same evening peak. That 200:1 ratio is the whole shape of the design. → NFR: fast reads.
- Fan-out per read: a city address resolves to **5–15 in-range DCs** (assumed: urban density puts a handful of depots inside an hour's drive), so one query scans one partition for a dozen DC ids — never the 10k-row table. → NFR: fast reads.
- Inventory rows: 10k DCs × ~3k stocked lines each (assumed: a micro-DC carries a convenience assortment, not the 100k-item catalog) ≈ **30M rows ≈ 3&nbsp;GB** with indexes. The full cross product would be a billion rows and never exists, because a DC stocks what fits in it. → NFR: scale.
- Cache working set: an answer is keyed by (cell, keyword, page); assume 20k active cells in a busy hour and ~30 query shapes each ≈ 600k entries × ~4&nbsp;KB ≈ **2.4&nbsp;GB hot** — one cache node's memory, with room for the assumption to be wrong several times over. → NFR: fast reads.
- Hit ratio: 20k reads/s over a 60&nbsp;s TTL (time to live) is 1.2M requests per window against ~600k keys, concentrated on the busiest cells — budget **~80%**, leaving **~4k queries/s** for two or three replicas per region at the ~2k indexed queries/s a well-provisioned node sustains. Ten points off that ratio doubles replica load, which makes it the dial that sizes the tier. At the 60k/s peak, misses are ≈ 12k queries/s, three times the 4k/s mean; at ~2k/s per node that is about six replicas, so size the tier for the peak. → NFR: fast reads.
- Drive-time calls: unpruned, every query would ask about 10k DCs — 2×10⁸ calls/s, a rate no vendor sells. Pruned to ~10 candidates and memoized per (cell, 5-minute bucket), it falls to the cells going cold each bucket: 20k ÷ 300&nbsp;s ≈ **70 calls/s**. Per-call pricing makes the prune a contract term rather than an optimisation. → FR: availability by location.
- Contention is per row, not per node: 350 orders/s over ten regions is ~35/s at a leader and idle by any capacity measure, while a promoted item can draw **tens of claims a second onto one (DC, item) row family**. That number, not the transaction rate, decides the isolation strategy. → NFR: strong consistency.
- Retention: inventory is bounded by shelves and stays near 3&nbsp;GB, while orders accumulate at ~**10&nbsp;GB/day** in the same store that arbitrates ordering. Ninety days is ~0.9&nbsp;TB; older orders belong in cold storage, or the hot path drags a year of history through its buffer cache. → NFR: scale.

**Verdict per candidate:**

- Event-driven ordering (accept now, confirm later) — **rejected**: the customer needs a yes or a no while they wait, and the only step that outlives the request is fulfilment, which is out of scope. → FR: order.
- Synchronous request/response — **adopted**: both endpoints answer in one hop, and an order that queues has turned a "no" into an "unknown". → NFR: fast reads; FR: order.
- One transactional store holding orders and inventory together — **adopted**: the guarantee is that a reservation and its order commit together, and that is free only inside one transaction. → NFR: strong consistency.
- Separate best-fit stores plus a [distributed lock](../patterns/distributed/coordination/distributed-lock.md) — **rejected**: it buys a store per concern and pays with lease expiry, crash recovery and lock-ordering deadlocks (dive 1). → NFR: strong consistency.
- Read replicas — **adopted**: 20k reads/s against the node that arbitrates orders is the one thing this design refuses, and a count seconds old is harmless because the order transaction re-checks it. → NFR: fast reads.
- Region partitioning — **adopted**: locality is free here, because a location only ever touches nearby DCs; it keeps one city's surge inside one leader. → NFR: scale; burst tolerance.
- Read cache with a 60&nbsp;s TTL — **adopted**: four reads in five never reach a replica, and the price is a listing that can be a minute out of date. → NFR: fast reads.
- In-process DC table with spatial cells — **adopted**: arithmetic rather than infrastructure, and the difference between 70 drive-time calls/s and 10⁸. → NFR: fast reads.
- Dedicated spatial database — **rejected**: 10k rows that change on a weekly clock fit in a process's memory; a spatial engine would be a second store to operate for a table you can hold in your hand. → NFR: fast reads.
- Hold-expiry sweeper — **adopted**: stalled orders and crashed clients park units that no human will release. → NFR: strong consistency.
- Row-lock claiming for interchangeable units — **deferred**: serializable isolation is correct today; the trigger is a measured abort rate above a few percent on hot (DC, item) rows (dive 1). → NFR: strong consistency.
- Message broker between ordering and fulfilment — **deferred**: fulfilment is out of scope, and the constraint it inherits is that the order transaction must never wait on it. → FR: order.
- Search index over the catalog — **rejected**: catalog search is out of scope, and the availability query filters an in-range item set that is already small. → FR: availability by location.
- Sharding for capacity — **rejected**: 30M rows and 3&nbsp;GB live on one node; partitioning here is bought for locality and blast radius, not for size. → NFR: scale.
- Global replication of inventory — **rejected**: a DC's stock interests only the region it can deliver to, so there is nothing to copy across the world. → NFR: scale.
- Admission control at the edge — **adopted**: browsing is sheddable and ordering is not, and that ranking has to exist before the surge, not during it. → NFR: burst tolerance.

**When this stops being right.** Contention wears out first, and it is not the same thing as load. As promotions concentrate demand, more claims land on the same few (DC, item) rows; under serializable isolation a conflicting transaction is aborted at commit, and an abort is work already paid for, so throughput falls while the leader stays busy — the symptom is slowness, not errors, until the retry budget runs out and customers are refused stock that exists. The signal: serialization-failure rate per region against the order transaction's p99, two lines that move together well before an order is rejected. Exits in adoption order: claim interchangeable units under a row lock so concurrent claimants take different units instead of aborting; give the hottest DCs their own partitions so a promotion's contention stays local; then move to per-(DC, item) counters with an atomic conditional decrement, which surrenders the per-unit ledger the pick path depends on. → NFR: scale.

## Core entities
<!--meta block=entities-->

Start from the concrete physical nouns and work up to the abstract ones:

- **Item** — a type of product ("Cheetos"): what a customer browses and searches for. It carries name and description, not location.
- **Inventory** — a physical instance of an Item sitting at one specific DC, with the `state` that makes ordering safe: `available`, `reserved`, `picked`, `dispatched`, `missing`. Item is to Inventory as a class is to its instances; effective availability is Inventory summed across in-range DCs.
- **DistributionCenter** — a physical location holding Inventory, with a lat/long, the spatial cell it falls in, and the region it is partitioned into.
- **Order** — a collection of reserved Inventory plus shipping and billing details, expanded into `OrderItems` rows and keyed by the caller's idempotency key.
- **Reservation** — not a table: it is the `order_id` and `held_until` columns written onto an Inventory row inside the order transaction. Keeping the hold on the row rather than beside it is what makes "reserve and record" one atomic act instead of two that can disagree.

## The interface
<!--meta block=interface-->

Two endpoints cover both requirements. Location is a parameter on both — the backend has to confirm that stock is close enough to deliver within the hour before it will show an item or accept an order for it.

```http summary="HTTP — availability and ordering"
GET /availability?lat=40.68&long=-73.97&keyword=chips&page=0
→ 200 { "items": [ { "itemId": "cheetos", "name": "Cheetos",
                       "quantity": 42 }, … ], "nextPage": 1 }
  Cache-Control: private, max-age=30

POST /orders
Idempotency-Key: 8f2c-…                 // a retry returns the first order
{ "location": { "lat": 40.68, "long": -73.97 },
  "items": [ { "itemId": "cheetos", "qty": 1 },
             { "itemId": "cola",    "qty": 2 } ] }
→ 201 { "orderId": "o_9f2", "status": "confirmed" }
→ 409 { "error": "out_of_stock", "itemId": "cola" }   // whole order fails
```

Availability is paginated because it backs a browsing surface. Ordering is all-or-nothing: if any single line item is unavailable the entire order is rejected with a clear error, which is preferable to shipping an incoherent partial order (a device without its battery). The quantity in the response is a number the customer may act on but the system does not promise — the order transaction is the only place a claim becomes real.

Ordering is not naturally safe to retry, so the caller supplies an [idempotency key](../patterns/messaging/idempotency.md) and the key is stored on the order row under a uniqueness constraint. A client that times out mid-commit retries and gets the original order back rather than a second set of reservations. Without it the honest failure mode is worse than a double sale: the units are held by an order the customer never learns about, and only the hold expiry releases them.

The `Cache-Control` on availability is short and private on purpose. Availability is per-location, so a [shared cache](../patterns/caching/distributed-cache.md) keyed by URL would serve one neighbourhood's answer to another, and the 30 seconds is what stops a customer's own device showing stock that the last minute's orders already took.

## How the system is built
<!--meta block=architecture-->

Requests enter at two endpoints and take routes that share almost nothing. `GET /availability` resolves the caller's location to a handful of in-range DCs, then answers from a cache backed by regional read replicas. `POST /orders` resolves the same set of DCs and then goes to the region's writable leader inside one transaction. The structural decision is that reading and ordering share the set of in-range DCs and nothing else: reads never touch the leader, so browsing load cannot slow ordering, and an order's correctness never depends on how fresh the browsing answer was.

```mermaid caption="Which path does each endpoint take? Availability goes cache → replica and never reaches the leader; an order goes straight to the leader under one transaction. Both resolve in-range DCs through the shared Nearby Service."
flowchart TB
    Client["Customer app"]
    Client -->|"GET /availability (lat, long)"| Avail["Availability Service · stateless-service"]
    Client -->|"POST /orders"| Orders["Orders Service · stateless-service"]
    Avail -->|"which DCs reach this point?"| Nearby["Nearby Service · in-process-cache"]
    Orders -->|"which DCs reach this point?"| Nearby
    Nearby -->|"drive time for ~10 pruned DCs"| Travel["Travel Time Service"]:::ext
    Avail -->|"lookup by cell, 60s TTL"| Cache[("Availability cache · cache-aside")]
    Cache -->|"miss: scan in-range DCs"| Replica[("Regional read replicas · replication")]
    Orders -->|"SERIALIZABLE: reserve, insert, commit"| Leader[("Inventory + orders store")]
    Sweeper["Hold sweeper · sweeper"] -->|"release units past held_until"| Leader
    Leader -->|"stream changes"| Replica
    classDef ext stroke-dasharray:4 4;
```

### Components & communication {#architecture-h3-1}

- **Availability Service** — the read entry point, serving `GET /availability`; asks Nearby for the in-range DC ids, looks the answer up in the cache by (cell, keyword, page), and on a miss scans one inventory partition on a replica and backfills. [Stateless](../patterns/distributed/routing/stateless-service.md), so instances multiply with browsing load.
- **Orders Service** — the write entry point, serving `POST /orders`; resolves the same DC set, runs the reservation and the order insert as one serializable transaction against the region's leader, retries a serialization failure a bounded number of times, and answers 201 or 409. Also stateless.
- **Nearby Service** — turns a lat/long into the DC ids that can reach it inside the hour: a spatial cell lookup over an [in-process copy](../patterns/caching/in-process-cache.md) of the DC table, a radius prune, then a drive-time check on the survivors, memoized per cell.
- **Travel Time Service** — rented, not built: the road-network and congestion estimate that turns distance into an hour. Called only on the pruned candidate set, and only when a cell's memo is cold.
- **Availability cache** — holds rendered availability answers keyed by cell for 60 seconds, so a neighbourhood's repeat questions cost nothing; the Orders Service invalidates the cells a sold DC serves after its transaction commits.
- **Inventory + orders store** — the system of record for Inventory, Order and OrderItem, one writable leader per region (~30M rows, ~3&nbsp;GB per Right-sizing), partitioned by region so a query and a claim each stay in one partition.
- **Regional read replicas** — asynchronous copies that answer the fan-out scans; they carry browsing traffic and are allowed to trail the leader by seconds.
- **Hold sweeper** — a scheduled job on the leader that returns `reserved` units whose `held_until` has passed; the only actor permitted to release a hold (dive 4).

### Where each requirement lands {#architecture-h3-2}

- Query, by location, the items deliverable within one hour — `GET /availability` → Availability Service → Nearby Service (cell → pruned candidates → drive time) → Availability cache → Regional read replicas, unioned into one list. → FR: availability by location.
- Place a single order containing multiple items — `POST /orders` → Orders Service → Nearby Service → Inventory + orders store under one serializable transaction; every line is reserved or the whole order is refused with a 409. → FR: order.

## Deep dives
<!--meta block=deepdives-->

Five questions decide this design. Who gets the last carton when two people ask for it at the same moment? Which depots can really reach you inside the hour, once rivers and rush hour are counted? How do you answer twenty thousand lookups a second without going near the machine that takes orders? What happens when the shelf and the database disagree? And what gives way first when a storm doubles the traffic?

### 1 · Selling the last unit exactly once → NFR: strong consistency

**Put the reservation, the order row and the state change in one transaction, and the database decides the race — no application code holds a lock, and no window exists in which stock is promised twice.** The alternatives are worth walking, because each fails somewhere different.

- **Naïve — check, then write.** `SELECT quantity`, decide, then `UPDATE`. The window between the two statements is a network round trip wide, and two carts that both read "1 left" both write "0 left" — a textbook [race](../hazards/race-condition.md) that no amount of retrying detects, because neither transaction ever sees a conflict. Rejected on the first oversell.
- **Two stores plus a distributed lock.** Keep orders and inventory in separate best-fit databases; on each order, take a distributed lock over the inventory records, write the order, decrement, release. It buys store independence, and the failure modes are nasty: a crash between the order write and the decrement leaves stock double-promised until a sweep reverses it, a lease that expires mid-transaction hands the same units to a second holder, and two orders grabbing items in opposite order [deadlock](../hazards/deadlock.md). Workable, not clean.
- **One serializable transaction (chosen).** Colocate orders and inventory in a single ACID (atomicity, consistency, isolation, durability) store and do the whole thing at `SERIALIZABLE` isolation. Each line item claims its units with an `UPDATE … WHERE state = 'available'` whose row count is the stock check; if a concurrent order claimed the same unit, one of the two aborts at commit — [optimistic concurrency control](../patterns/distributed/coordination/optimistic-concurrency-control.md) enforced by the engine, with no lock-management code to get wrong. The price is that inventory and orders now scale together and you give up a specialised store per concern; when atomicity is the requirement, that is a good trade.

Choosing optimism means owning the retry. A serialization failure arrives at `COMMIT`, after the work is done, and the only correct response is to replay the whole transaction — which is safe precisely because the idempotency key makes a replayed order the same order. Bound the replays (three attempts with [jittered backoff](../patterns/distributed/resilience/retry-backoff.md)) and fall back to a 409, because past that point the honest answer is that the item is gone rather than that the system is busy. An unbounded loop turns contention into a [retry storm](../hazards/retry-storm.md), which is how a slow checkout becomes an outage.

The residual weakness is that aborts scale with contention rather than with load: a leader at 35 orders/s is idle, while a promoted item puts tens of claims a second on the same rows and every abort there is work already paid for. The escape hatch exploits a fact this data model has and a ticketing system does not — units of the same item at the same DC are interchangeable, so two claimants never need the same row. Claiming under `SELECT … FOR UPDATE SKIP LOCKED` at a weaker isolation level hands each claimant a different free unit: it never blocks and never aborts, at the cost of an explicit lock and the engine's whole-transaction guarantee. Keep it in reserve behind the abort-rate trigger named in Right-sizing, because the simple version is correct and the complicated one is only faster.

```sql summary="SQL — the order as one serializable transaction"
BEGIN ISOLATION LEVEL SERIALIZABLE;

-- one claim per line item; the row count IS the stock check
UPDATE inventory
   SET state = 'reserved', order_id = $order, held_until = now() + interval '2 hours'
 WHERE id IN (SELECT id FROM inventory
               WHERE item_id = $item AND dc_id = ANY($in_range_dcs)
                 AND state = 'available'
               LIMIT $qty);
-- fewer rows updated than $qty → that line is out of stock
--   → ROLLBACK and answer 409 for the whole order

INSERT INTO orders      (id, idempotency_key, location, ...) VALUES (...);
INSERT INTO order_items (order_id, inventory_id)             VALUES ...;

COMMIT;   -- a concurrent claim on the same unit aborts here (SQLSTATE 40001):
          -- replay the whole transaction, bounded attempts, jittered backoff
```

```mermaid caption="When two orders race for the last unit, how does the transaction reject exactly one? Whichever commits first wins; the loser aborts at COMMIT, replays, and gets a 409 only if the unit is really gone."
sequenceDiagram
    autonumber
    participant A as Order A
    participant B as Order B
    participant O as Orders Service
    participant DB as Inventory + orders store
    A->>O: POST /orders (last unit)
    B->>O: POST /orders (same unit)
    O->>DB: A: BEGIN SERIALIZABLE, reserve unit
    O->>DB: B: BEGIN SERIALIZABLE, reserve unit
    DB-->>O: A: rows match, COMMIT ok
    O-->>A: 201 Created
    alt B claimed the same unit
        DB--xO: B: serialization failure at COMMIT
        O-->>B: replay once, then 409 out of stock
    else B claimed a different unit
        DB-->>O: B: COMMIT ok
        O-->>B: 201 Created
    end
```

### 2 · From straight-line distance to real drive time → FR: availability by location; NFR: fast reads

**Reachability is a drive-time question, and drive time is expensive to ask, so the design's job is to ask it about ten depots instead of ten thousand.** "Close in miles" is not "deliverable in an hour": a river, a highway with no exit, or rush hour puts a nearby-by-map DC out of reach, and the customer never learns why their order was late.

- **SQL distance threshold.** Store DC lat/long, compute distance (Euclidean, or Haversine to respect the Earth's curvature), keep the DCs under a threshold. Cheap, and blind to traffic and roads — it is the answer that promises the delivery across the river.
- **Drive time against every DC.** Ask the travel-time estimator about all 10k DCs per query. Accurate and hopeless: 2×10⁸ calls/s at peak, of which essentially all are about depots in other cities.
- **A spatial database.** Put the DCs in an engine with a real spatial index and query a radius. Correct, and a second store to run, replicate and fail over — for 10k rows that change when the company signs a lease.
- **Prune, then estimate, then remember (chosen).** Hold the whole DC table in memory, refreshed every 5 minutes, keyed by [geohash](../patterns/distributed/routing/geohash.md) cell so a lat/long becomes a cell plus its neighbours rather than a scan. Filter that to a candidate set with a fixed radius (~60 miles, an upper bound on an hour's driving), ask the travel-time service about the handful that survive, and memoize the resulting DC set per (cell, 5-minute bucket). One cheap spatial pass turns thousands of DCs into the few worth asking about, and the memo turns 70 calls a second into the whole bill.

Two details decide whether this holds. The prune's errors are asymmetric: too loose and you pay for wasted drive-time calls, which shows up on an invoice; too tight and a reachable DC is silently dropped, which shows up as an item the customer never saw and nobody ever counts — so size the radius against the fastest plausible hour, not the typical one. And note which clock sets the memo's TTL: DCs move on a quarterly clock while congestion moves on a five-minute one, so the memo expires on the traffic's schedule. The general version of this locality problem is the [Proximity Search](../themes/proximity-search.md) theme.

```mermaid caption="Inside the Nearby Service: a warm cell answers from memory, and a cold one is pruned by radius before a single drive-time call is made — which is what keeps the external bill at ~70 calls/s."
flowchart TB
    Req["Availability or order request"] -->|"lat/long to cell"| Memo["Cell to DC-set memo · 5-min TTL"]
    subgraph Nearby["Nearby Service · in-process-cache"]
        Memo
        Cells["DC table by geohash cell · refreshed every 5 min"]
        Prune["Radius prune · ~60 miles"]
    end
    Memo -->|"memo cold"| Cells
    Cells -->|"cell + neighbours"| Prune
    Prune -->|"batch drive time, ~10 candidates"| Travel["Travel Time Service"]:::ext
    Travel -->|"in-range DC ids, memoized"| Memo
    classDef ext stroke-dasharray:4 4;
```

### 3 · Twenty thousand availability queries a second → NFR: fast reads; scale

**Every availability query is a fan-out across a dozen DCs, so the only way to hold 100&nbsp;ms is to answer most of them without fanning out at all.** The inventory behind those queries changes only when an order commits — roughly a hundred times a second against twenty thousand reads — so the read path is allowed to work from copies.

- **Cache in front, keyed by cell.** The Availability Service reads the cache first and, on a miss, queries the store and populates it — the [cache-aside](../patterns/caching/cache-aside.md) loop, keyed by (cell, keyword, page) rather than by raw lat/long, so two customers on the same block share an entry instead of each creating their own. A 60-second TTL bounds staleness even if every invalidation is lost.
- **Read replicas over a partitioned store.** A location only ever touches a small cluster of nearby DCs, so partition inventory by region — the first three digits of the zip code — and a query hits one or two [partitions](../patterns/distributed/routing/sharding.md) instead of the whole table. Serve those [replica](../patterns/distributed/coordination/replication.md) reads while orders keep going to the leader, and the two loads stop competing for the same buffer cache.
- **Rejected — a maintained availability table.** Precomputing a per-cell item list on every write looks attractive until you count the write amplification: one sale touches every cell that DC can serve, so the fan-out the read path was avoiding reappears on the write path, inside the transaction that must stay fast. A [materialized view](../patterns/distributed/coordination/materialized-view.md) earns its place when reads are expensive and writes are rare; here writes are the scarce, contended resource.

Invalidation is where this design is easiest to get subtly wrong. A sold-out item must leave the list quickly, so the Orders Service deletes the affected keys — a DC serves a few dozen cells, so one sale invalidates a few dozen entries. Do it after the transaction commits, never inside it: an invalidation whose transaction then rolls back has evicted a correct entry, and one sent from inside an uncommitted transaction is a [dual write](../hazards/dual-write-inconsistency.md) pretending to be atomic. Losing one to a crash is survivable because the TTL is the floor — a [stale entry](../hazards/stale-cache.md) for under a minute, on a path where the order transaction refuses the sale anyway.

The residual is worth stating to customers, not just to interviewers: a listing is an invitation, not a promise. A count served from a replica behind a cache can be seconds old, so an item may appear after its last unit is claimed and the customer meets a 409 at checkout. The design prefers that to the alternative of reserving stock for browsers, which makes a full city look sold out.

```mermaid caption="What does one availability query touch? Nearby resolves the DC set, the cache answers four times in five, and only a miss reaches a replica — the leader is never on this path."
sequenceDiagram
    autonumber
    participant C as Customer app
    participant A as Availability Service
    participant N as Nearby Service
    participant K as Availability cache · cache-aside
    participant R as Regional read replica
    C->>A: GET /availability (lat, long, keyword)
    A->>N: which DCs reach this point?
    N-->>A: ~10 in-range DC ids
    A->>K: lookup (cell, keyword, page)
    alt cache hit
        K-->>A: item list
    else cache miss
        A->>R: scan one partition for those DC ids
        R-->>A: rows, unioned per item
        A->>K: backfill, TTL 60 s + jitter
    end
    A-->>C: 200 items with quantities
```

### 4 · When the shelf disagrees with the ledger → NFR: strong consistency

**A reservation is a promise about a physical object, so the design has to say what happens when the object is not there — and when the person who reserved it never comes back.** Every strong-consistency guarantee above this line is a guarantee about rows; this dive is where those rows are made to agree with a shelf that people walk past all day.

- **Reserve nothing, just decrement a count.** The cheapest model, and it cannot express "this one is gone": the picker has no row to fail, so a unit that walked out of the building is discovered by the next customer whose order cannot be filled, and the count drifts further from the shelf every week. Rejected — a physical fact needs somewhere to be recorded.
- **Reserve when the item enters the cart.** It removes the checkout race entirely, and it lets window shoppers hold the last units of a promoted item for an hour, so a full DC advertises itself as empty. Rejected as the default; a short hold on entering checkout is the defensible version.
- **Reserve at commit, with an expiry (chosen).** Units move to `reserved` inside the order transaction carrying a `held_until`, so an order that never reaches a rider cannot park stock indefinitely. A [sweeper](../patterns/distributed/coordination/sweeper.md) is the single actor allowed to return an expired hold to `available`: one writer for releases means two components can never race to free the same unit, and the sweep is an indexed query on `held_until`.

Then the picker walks the aisle and the unit is not there. Shrinkage, misplacement and damage are ordinary in a building people work in, so the exception path belongs in the design rather than in an incident report: the unit is marked `missing`, an adjustment row records who observed it and when, and the line is re-sourced from another in-range DC or refunded. Re-sourcing is a second reservation under the same rules, which is why the state machine needs no special case for it.

Adjustments let the ledger converge without stopping the building. A full recount takes a DC offline; a rolling count of a few aisles a day writes its corrections into the same adjustment ledger the pickers use, so every correction has one shape and one audit trail whatever produced it. Watch the adjustment rate per DC: a depot whose corrections climb is either losing stock or mis-scanning it, and both are answered on the floor rather than in the schema.

```mermaid caption="What can happen to one physical unit? Every path out of Reserved is explicit — released by the sweeper, picked, or written off as missing — so no unit can be held by nobody."
stateDiagram-v2
    [*] --> Available: received at the DC
    Available --> Reserved: order commits, held_until set
    Reserved --> Available: hold expires — sweeper releases
    Reserved --> Picked: picker scans the unit
    Reserved --> Missing: picker cannot find it
    Picked --> Dispatched: handed to the rider
    Missing --> [*]: adjustment row — line re-sourced or refunded
    Dispatched --> [*]: delivered
```

### 5 · The Friday-evening surge → NFR: burst tolerance

**A surge is not more of the same traffic; it is the same neighbourhoods asking at the same moment, so the design's answer is to decide in advance what it will stop doing.** Four things give way, in a fixed order, and each has a cheap counter-move.

- **The cache expires together.** Entries written during the ramp share a TTL, so the hot cells fall out within a second of each other and every miss becomes a fan-out — a [stampede](../hazards/cache-stampede.md) aimed at the replicas. Counter: jitter the TTL, and keep one in-flight fill per key so N concurrent misses become one query.
- **The drive-time memo goes cold at the worst moment.** Congestion changes fastest exactly when traffic peaks, so memos expire sooner while the vendor's rate limit is nearest. Counter: serve the last known DC set past its TTL during a surge — a reachability answer a few minutes old degrades better than a timeout.
- **Connections pile up at the leader.** Each new service instance opens its own pool, and a store that gives every connection a process pays memory and scheduler cost for a thousand mostly-idle connections long before it runs out of CPU — [pool exhaustion](../hazards/connection-pool-exhaustion.md) that looks like a slow database. Counter: a connection pooler in front of the leader, so a surge queues at a component built to queue.
- **Retries turn contention into collapse.** An abort and a client retry are indistinguishable to the leader, so an unbounded loop multiplies the load that caused it. Counter: bounded attempts with jittered backoff, and a 409 that means gone rather than "try again" (dive 1).

Under all four sits one ranking: browsing is sheddable and ordering is not. Per-source [rate limits](../patterns/distributed/resilience/rate-limiter.md) at the edge and a smaller page of results are the first things to spend, because a customer who sees ten items instead of thirty still buys and a customer whose order times out does not. The cost is real — shedding browsing loses sales nobody can count — so the limit belongs on a dial an operator turns, not in a threshold nobody revisits.

Two reflexes are wrong here and worth rejecting out loud. [Autoscaling](../patterns/distributed/routing/autoscaling.md) does not answer this surge: the component under pressure is a single writable leader, and adding instances grows the parts that were never the problem, which is exactly why the read path carries all the elasticity. And queueing orders to smooth the peak converts a fast "no" into an indefinite "unknown" — a customer waiting for a confirmation they cannot get is worse off than one holding a rejection they can act on. Both moves generalise in the [Spike Handling](../themes/spike-handling.md) theme.

## Limitations & trade-offs
<!--meta block=tradeoffs-->

**The biggest flaw, named first: one writable leader per region owns both the inventory ledger and the orders, so every purchase in that region serializes through a single node.** Browsing survives its loss; buying does not, and a promotion that concentrates demand on one item creates contention no amount of read capacity relieves.

### Strengths
<!--meta polarity=pro-->

- **A ledger unit is sold exactly once.** The reservation, the order and the state change commit together, so no application code holds a lock (see dive 1); a shelf miscount is caught at pick time (con-4).
- **Browsing never touches the arbiter.** Availability is answered from a cache and regional replicas, so 20k queries/s cost the order path nothing (see dive 3).
- **The drive-time bill is set by a prune.** Ten thousand depots become ten candidates before a single external call is made (see dive 2).
- **No unit can be held by nobody.** Every reservation carries an expiry and one sweeper is the only actor that releases it (see dive 4).
- Contention stays inside a region, so one region's surge cannot slow another region's ordering; cities within a region share its leader.
- A retried order is the same order — the idempotency key returns the first result instead of reserving a second set of units.
- The inventory ledger is small enough to be boring: ~30M rows and ~3&nbsp;GB, with no shard map to maintain.

### Risks
<!--meta polarity=con-->

- **The regional leader is a single point of failure for buying.** A failover stops ordering in that region while availability keeps answering from replicas.
- **Aborts rise with contention, not with load.** A promoted item concentrates claims on a few rows, and every serialization failure is work already paid for (see dive 1).
- **A listing is not a reservation.** A cached, replica-served count can show an item for up to the 60 s cache TTL after its last unit is claimed, and the customer finds out at checkout (see dive 3).
- **The ledger can disagree with the shelf.** A missing unit is discovered by a human at pick time, and the correction is always after the fact (see dive 4).
- Colocating orders and inventory couples their scaling and forfeits a best-fit store per concern.
- All-or-nothing orders reject the whole basket when one line is gone — coherent, and blunt.
- Reachability depends on a vendor we do not run, and under surge the design serves a stale DC set rather than a fresh answer (see dive 5).

## What's expected at each level
<!--meta block=levels-->

### Mid-level {#levels-h3-1}

- Asks how many people browse per order before drawing anything.
- Produces a working end-to-end flow for both routes — resolve DCs, union inventory, place an order — with a clear API and data model.
- Recognises that check-then-write oversells, and reaches for some form of locking or transaction.
- Separates a type of product from a physical unit of it in the data model.

### Senior {#levels-h3-2}

- Argues distributed lock against one serializable transaction on failure modes rather than on taste.
- Sends reads to replicas behind a cache and says what each tier absorbs.
- Prunes by radius before asking anything about drive time, unprompted.
- Partitions by region for locality, and says why the row count does not force sharding.
- Places cache invalidation after the commit and explains what a lost invalidation costs.

### Staff+ {#levels-h3-3}

- Distinguishes contention from load, and states that aborts scale with the hot row rather than with the transaction rate.
- Prices the deferred exits against their triggers: row-lock claiming at a measured abort rate, a broker only when fulfilment comes in scope.
- Raises the reservation lifecycle unprompted — expiry, the single releasing actor, and the picker's missing-unit path.
- Names what gives way first under surge and what the system will stop doing, before being asked.
- Defends the single regional leader as the design's biggest flaw, chosen deliberately, and prices the exit.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Cache Stampede](../hazards/cache-stampede.md) — Entries written during a ramp share a TTL, so hot cells expire together and every miss fans out to the replicas.
- [Connection-Pool Exhaustion](../hazards/connection-pool-exhaustion.md) — Each new service instance opens its own pool against one writable leader, so a surge exhausts connections before CPU.
- [Stale Cache](../hazards/stale-cache.md) — Cached, replica-served counts run up to a minute behind, so checkout is the authority and answers 409.

**Demonstrates**

- [Scatter-Gather](../patterns/messaging/scatter-gather.md) — an availability read fans a location out to every in-range distribution centre (DC) and unions their inventory into one list
- [Cache-Aside](../patterns/caching/cache-aside.md) — a Redis layer with a one-minute time to live (TTL) absorbs the ~20k queries per second (QPS) of availability reads, misses falling through to Postgres and writes invalidating keys
- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — ordering runs as one SERIALIZABLE Postgres transaction so a concurrent double-order hits a serialization failure at commit and is rejected
- [Replication](../patterns/distributed/coordination/replication.md) — availability reads are served from Postgres read replicas while orders write to the leader for strong consistency
- [Sharding](../patterns/distributed/routing/sharding.md) — inventory is partitioned by region (first three zip digits) so a location query touches only one or two partitions
- [In-Process Cache](../patterns/caching/in-process-cache.md) — the Nearby Service holds the whole distribution centre (DC) table in memory and refreshes it every five minutes to prune candidates before any drive-time call
- [Idempotency](../patterns/messaging/idempotency.md) — POST /orders carries an idempotency key so a client that times out mid-commit replays into the same order instead of a second set of reservations
- [Sweeper](../patterns/distributed/coordination/sweeper.md) — a scheduled job is the only actor allowed to return units whose held_until has passed, so nothing races to free the same unit
- [Geohash](../patterns/distributed/routing/geohash.md) — the in-memory distribution centre (DC) table is keyed by cell, so a lat/long becomes a cell lookup instead of a scan over 10k depots
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — Availability, Orders and Nearby hold no per-request state, so browsing capacity is added by adding instances
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — a serialization abort is replayed a bounded number of times with jittered backoff, then answered 409
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — per-source limits at the edge shed browsing during a surge so the order path never queues

<!-- relationships:end -->
