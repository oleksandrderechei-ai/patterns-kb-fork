---
title: Parking Lot
description: "Assign a compatible spot, issue a ticket, and price the stay — an object-oriented design about where each piece of state belongs"
area: designs-foundational
owner: Oleksandr Derechei
tags: [low-level-design, encapsulation, separation-of-concerns, state-management]
status: stable
aliases: [parking garage, parking system]
solves: [where should this piece of state live — on the entity or on the manager that owns it, my data class is quietly turning into a calculator with its own business rules, two requests both see the same resource as free and both claim it, how do I keep a record object from reaching deep into my domain model, every rule about which item fits where lives in one giant if-else at the top]
---

# Parking Lot

A parking lot assigns an arriving vehicle a compatible spot, issues a ticket, and charges by the hour on exit. As a low-level design it is almost entirely about placement: which object owns occupancy, where pricing lives, and how far a record is allowed to reach.

## Understanding the problem
<!--meta block=description-->

A lot assigns a compatible spot and issues a ticket on entry, then validates the ticket, charges for the time parked and frees the spot on exit. There is no distributed scale, only a few hundred spots, so the exercise is object modelling: which classes exist, what state and behaviour each owns, and how to avoid over-building.

## Explained
<!--meta block=explain-->

A parking lot design keeps spots and tickets as plain data and puts every rule in one lot object: it finds a free spot of the right type, issues an immutable ticket, and on exit prices the stay and frees the spot. Occupancy is a set of taken spot ids the lot maintains, not a flag on each spot. Choose the set over a flag when occupancy is a relationship the system manages; a locker door really holds a parcel whether or not the software agrees, so there a flag fits. Keep pricing as a method on the lot until a second fee rule exists, since a pricing-strategy interface answers a need nobody has yet.

- **Two records of one fact.** The set repeats what tickets imply, so update both inside the lock that scans, or two entrances take one bay.
- **Naive allocation.** First-match ignores walking distance and floor fullness, so add a placement rule when that matters.
- **Money.** Floating point drifts, so store fees as whole cents.

**Example.** A lot has 200 spots and cars stay about 2 hours, so entries arrive at about 200 / 7,200 = 0.03 a second. One lock around enter(), a scan of 200 entries and two memory writes, takes microseconds, so it is never the bottleneck. At 500 cents an hour, a car that stays 2 hours 10 minutes is rounded up to 3 hours and pays 1,500 cents. Exit removes the spot id from the occupied set and deletes the ticket, so a second exit with the same ticket is rejected as invalid.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Support three vehicle types — motorcycle, car, large — each matching a spot type.
2. On entry, automatically assign an available compatible spot and issue a ticket.
3. On exit, validate the ticket, charge an hourly fee rounded up, and free the spot.
4. Reject entry when no compatible spot is free; reject exit for an invalid or already-used ticket.

Out of scope: payments, gate hardware, cameras, UI, and reservations — the core is spot assignment, ticket lifecycle, and fee calculation.

### Non-functional (constraints)
<!--meta requirement=nfr-->

- **Correctness** — one spot is never assigned to two vehicles at once.
- **Encapsulation** — only the lot exposes a public API; internals stay hidden.
- **Money safety** — fees are integer cents, never floating point.
- **Evolvability** — multi-floor, per-type pricing, and concurrent entrances should slot in without a rewrite.

## Core entities
<!--meta block=entities-->

Three classes, and one deliberate omission:

- **ParkingLot** — the orchestrator and the only public surface. Owns the spots, tracks which are occupied and which tickets are active, and enforces pricing.
- **ParkingSpot** — a pure data holder: an `id` and a `spotType`. It knows nothing about tickets, pricing, or (by the chosen design) even its own occupancy.
- **Ticket** — an immutable record of one session: `id`, `spotId`, `vehicleType`, `entryTime`. Read-only after creation, with no behaviour.
- **Vehicle — not a class.** It is external and never tracked, so it collapses to a `VehicleType` enum used only to match a spot. Modelling it as a class would be state with no owner.

## The interface
<!--meta block=interface-->

The lot exposes exactly two operations — deliberately no `getAvailableSpots()` or `getStatus()`, which would leak internals the core workflow never needs:

```python summary="Pseudocode — the public API"
class ParkingLot:
    enter(vehicleType) -> Ticket   # assigns a spot, issues a ticket; raises if the lot is full
        # lock: scan spots of the matching type not in occupiedSpotIds; none -> raise; add id to occupiedSpotIds; store Ticket(id, spotId, vehicleType, entryTime) in tickets
    exit(ticketId)     -> long     # validates, charges cents, frees the spot; raises if invalid
        # lock: look up ticket (missing -> raise); fee = hours rounded up x hourlyRateCents; remove spotId and ticket; return fee
```

## How the system is built
<!--meta block=architecture-->

The lot holds its spots, an `occupiedSpotIds` set, and a map of active tickets keyed by id. `enter` scans for a free compatible spot, marks it occupied, issues a ticket, and returns it; `exit` looks the ticket up, computes the fee, and clears both the occupancy entry and the ticket. Spot and Ticket stay dumb; all the rules live in the lot.

```mermaid caption="The lot orchestrates; the spot and ticket are pure data. The ticket references its spot by id string, not by object."
classDiagram
    class ParkingLot {
        -List~ParkingSpot~ spots
        -Set~String~ occupiedSpotIds
        -Map~String,Ticket~ activeTickets
        -long hourlyRateCents
        +enter(vehicleType) Ticket
        +exit(ticketId) long
        -findAvailableSpot(vehicleType) ParkingSpot
        -computeFee(entry, exit) long
    }
    class ParkingSpot {
        -String id
        -SpotType spotType
        +getId() String
        +getSpotType() SpotType
    }
    class Ticket {
        -String id
        -String spotId
        -VehicleType vehicleType
        -long entryTime
    }
    ParkingLot "1" o-- "*" ParkingSpot : owns
    ParkingLot "1" ..> "*" Ticket : issues
    Ticket ..> ParkingSpot : references by id
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Who tracks occupancy — the spot or the lot?

The tell is whether a fact is intrinsic to an entity or a relationship the system manages.

- **Flag on the spot.** An `occupied` boolean on `ParkingSpot` is simple and the spot "knows" its own state — but it duplicates truth (the active tickets already imply occupancy), so the two must be kept in sync or a spot gets double-assigned. Defensible with discipline; it is exactly the choice the [Amazon Locker](./amazon-locker.md) design makes, because there occupancy really is physical.
- **Compute it from tickets.** A spot is occupied iff an active ticket references it — no stored state at all, conceptually the cleanest. But every entry rescans all tickets and, under concurrency, must lock the whole ticket map.
- **Occupancy index (chosen).** Keep the spot a pure data holder and let the lot maintain a `Set<String> occupiedSpotIds` — a maintained index. It is redundant with ticket data, but each spot check is O(1) (`enter()` still scans the spots, cheap at 200) and the set is a clean concurrency boundary. The chosen design still holds one lock over the set and the ticket map; locking just the set works only if the ticket map is safe for concurrent writes.

### 2 · Where does fee calculation live?

Pricing is a business policy, not a property of a receipt.

- **On the Ticket.** A `calculateFee()` method forces the ticket to also store the rate and turns a record into a calculator — two reasons to change, so it breaks [single responsibility](../principles/single-responsibility.md) and makes the ticket mutable. Rejected.
- **On the lot (chosen).** `computeFee()` lives in `ParkingLot` beside the other rules; the ticket stays a pure receipt. This is [separation of concerns](../principles/separation-of-concerns.md) — data records stay simple, policy is centralised and independently testable. The rate lives on the lot as `hourlyRateCents` (integer cents — never floats for money).
- **A PricingStrategy interface.** A [strategy](../patterns/gof/behavioral/strategy.md) pattern lets pricing be swapped at runtime — genuinely useful once rules diverge (surge, discounts, per-lot tariffs). For a single flat hourly rate it is [over-abstraction](../principles/yagni.md): hold it in reserve as the answer to "what if pricing gets complex?", don't build it up front.

### 3 · Concurrent entrances

Two entrances can both see one spot as free and both claim it — a race in the window between checking availability and recording the claim. The pragmatic interview answer is a coarse lock around the whole of `enter()`: a 200-spot lot turning over every couple of hours needs ~0.03 vehicles/sec, while a synchronised `enter()` — an uncontended monitor around a 200-entry scan and two in-memory writes — runs in microseconds so a single core can serve far more than that demand; measure before relying on it. The lock is nowhere near the bottleneck, and correctness wins over cleverness. `exit()` takes the same lock, so ticket look-up, fee, spot release and ticket removal are one step; two exits of one ticket cannot both succeed. When contention is real, a [read-write lock](../patterns/concurrency/rw-lock.md) lets many entrances search concurrently and takes the exclusive lock only to claim (release the read lock first, since upgrading it in place commonly deadlocks), re-checking after acquiring it and retrying if another thread got there first.

Without the lock the interleaving is plain. Gate A scans and finds spot `C-12` free, gate B scans and finds `C-12` free, and both add it to `occupiedSpotIds` and issue a ticket. The set accepts the second add silently, so nothing fails and two cars hold tickets for one bay. The lock closes the window by making the scan and the claim one step.

```mermaid caption="Why can two entrances not take one bay? The lock makes find-and-claim one step, so the second gate scans after the first claim is recorded and gets the next free spot."
sequenceDiagram
    participant A as Gate A
    participant B as Gate B
    participant L as ParkingLot
    A->>L: enter(car)
    Note over L: lock held for A
    L->>L: scan, find C-12 free
    L->>L: add C-12 to occupiedSpotIds
    L-->>A: Ticket(C-12)
    Note over L: lock released
    B->>L: enter(car)
    Note over L: lock held for B
    L->>L: scan, skip C-12, find C-13
    L-->>B: Ticket(C-13)
```

### 4 · Which spot does a vehicle get?

Placement is a rule about fit, so it belongs in `findAvailableSpot` and nowhere else. The first requirement says each vehicle type matches a spot type, so the baseline is an exact match: a motorcycle takes a motorcycle bay, a car takes a car bay, a large vehicle takes a large bay.

- **Exact match, first free (chosen).** One scan, one comparison per spot, and a lot that has run out of car bays turns a car away even when large bays sit empty. The cost is lost revenue on a quiet day, the benefit is a rule a new engineer reads in one line.
- **Fit-up fallback.** A car may take a large bay when no car bay is free. That raises occupancy, but a large vehicle arriving later finds no bay and the lot is full for the one type that has nowhere else to go. Add it only when the owner would rather park a car than refuse one.
- **Placement strategy.** Nearest to the exit, or the emptiest floor, needs a distance or a floor on each spot and an ordering over the free ones. That is the point where a [strategy](../patterns/gof/behavioral/strategy.md) earns its interface, and not before.

```mermaid caption="How does enter() decide? The scan filters by spot type and by the occupied set, and a miss is the only path that rejects the vehicle."
flowchart TB
    Start(["enter(vehicleType)"]) --> Next{"Spot left to check?"}
    Next -->|"no"| Full["Raise: lot is full for this type"]
    Next -->|"yes"| Type{"spotType matches vehicleType?"}
    Type -->|"no"| Next
    Type -->|"yes"| Taken{"id in occupiedSpotIds?"}
    Taken -->|"yes"| Next
    Taken -->|"no"| Claim["Add id to occupiedSpotIds, issue Ticket"]
```

### 5 · Ticket lifecycle and the second exit

A ticket has two states that matter, active and gone. The lot holds active tickets in a map keyed by id, and `exit` removes the entry in the same step that frees the spot, so presence in the map is the whole state.

That choice makes a repeated exit cheap to reject. The second call with the same id finds no entry and raises. The same lookup answers an id the lot never issued, so the two cases collapse into one "invalid ticket" error. Splitting them, for a clerk who must tell a lost ticket from a reused one, costs a `usedTicketIds` set that grows by one entry per car for ever, and the lot has no need to keep it.

```mermaid caption="What can happen to a ticket? Exit settles an active ticket once, and every later use of the same id ends in the invalid error."
stateDiagram-v2
    [*] --> Active: enter() issues the ticket
    Active --> Settled: exit() charges and frees the spot
    Settled --> [*]
    [*] --> Invalid: id never issued
    Settled --> Invalid: exit() with the same id
    Invalid --> [*]: raise, charge nothing
```

### 6 · A pricing rule changes while cars are parked

The lot stores `hourlyRateCents` once and `computeFee` reads it at exit, so a rate change at 14:00 reprices every car already inside. That is the simplest behaviour and the one a driver sees on the sign when they pay. The ticket holds `entryTime` and no rate, so it cannot disagree with the lot.

Stamping the rate on the ticket at entry makes the price match what was posted when the car arrived. It also gives the ticket a second reason to change and a field that every later pricing rule, such as a daily cap or a per-type rate, has to extend. Take that step when the business promises the entry price, and take it as the trigger for the strategy interface in dive 2, not before. Until then the rounding rule stays the only policy: a stay of 5 minutes is one hour, 500 cents at the example rate.

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Occupancy in one place (the index) — O(1) check per spot, and a set a finer lock can guard if contention is ever real; the chosen design locks all of `enter()` (dive 3).
- Dumb data classes and a rules-owning orchestrator, so pricing and allocation change without touching Spot or Ticket.
- Immutable tickets and integer-cent money remove whole classes of bug.

### What it gives up
<!--meta polarity=con-->

- The occupancy index duplicates what tickets imply — it must be updated in lockstep with them, under one lock, or it drifts.
- "Never existed" and "already used" collapse into one "invalid ticket" error; splitting them needs a used-ticket set.
- First-match allocation ignores placement quality (proximity, floor balancing) until a strategy is added.
- Exact-type matching turns a car away while large bays sit empty, so occupancy on a quiet day stays below what the spots could hold.
- A rate change reprices cars already parked, because the ticket carries no rate (see dive 6).

## What's expected at each level
<!--meta block=levels-->

- **Junior** — a working system: spots, tickets, an orchestrator; `enter` assigns and returns a ticket, `exit` charges and frees, with basic rejection of a full lot and invalid tickets. May need a hint on where pricing belongs.
- **Mid-level** — clean separation without prompting (lot orchestrates, spot holds properties, ticket is a data holder), sees that Vehicle needn't be a class, handles double-exit, and justifies the map and the pricing placement.
- **Senior** — class boundaries are obvious; volunteers the occupancy and enum trade-offs, catches edge cases unprompted, and walks the multi-floor and concurrency extensions — simple solution first, then when a Strategy pattern earns its keep.
- **Staff** — treats the lot as a policy question: argues exact match against fit-up from the owner's revenue and the stranded large vehicle, says a rate change reprices parked cars and names the trigger for stamping the rate on the ticket, and shows that the one lock stays correct as entrances multiply because the claim is a single atomic step.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Amazon Locker](./amazon-locker.md) — Both assign a resource and free it later; they differ on whether occupancy is intrinsic to the slot or a relationship the manager tracks

**Exposed to**

- [Race Condition](../hazards/race-condition.md) — Two gates scan the same spot free, both add it and both issue a ticket until find-and-claim is one locked step.

**Demonstrates**

- [Value Object](../patterns/ddd/value-object.md) — The Ticket is an immutable record — set once at entry, read-only after
- [Strategy](../patterns/gof/behavioral/strategy.md) — Held in reserve for pricing and floor-allocation once the rules genuinely diverge
- [Single Responsibility Principle](../principles/single-responsibility.md) — Fee logic stays out of Ticket so the record isn't also a pricing calculator
- [Separation of Concerns](../principles/separation-of-concerns.md) — Business rules live in the orchestrator; Spot and Ticket stay dumb data
- [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) — A PricingStrategy interface is deferred until pricing actually gets complex
- [Law of Demeter](../principles/law-of-demeter.md) — The Ticket stores a spot id string, not a spot object, so it can't reach into the model
- [Read-Write Lock](../patterns/concurrency/rw-lock.md) — Named as the next step when one coarse lock contends; the page ships a plain lock.

<!-- relationships:end -->
