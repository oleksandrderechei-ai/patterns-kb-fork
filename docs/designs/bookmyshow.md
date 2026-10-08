---
title: BookMyShow
description: "Book specific seats across many screenings, where a per-showtime lock is the only thing standing between two shoppers and the same seat"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [low-level-design, separation-of-concerns, state-management]
status: stable
aliases: [movie ticket booking, seat reservation system]
solves: [two users both grab the last free seat at the same instant and I end up double-booking it, I cannot decide whether seat availability belongs on each seat or on the screening that owns all seats, I keep a separate already-booked set alongside my reservations and the two keep drifting out of sync, I made a class for every noun in the spec and half are just an id string, cancelling one booking forces me to scan every venue and screening to find where it lives]
---

# BookMyShow

A ticket-booking system lets a shopper search for a film, pick a screening at a theater, choose specific seats from the map, and reserve them. There is no distributed scale here — the whole exercise is object modelling under one hard constraint: when two people reach for the same seat at the same moment, exactly one may win.

## Understanding the problem
<!--meta block=description-->

A shopper searches films, picks a screening, sees the free seats and books several in one transaction that returns a confirmation code; a cancel releases them. Search is a plain substring match, seats come from a fixed grid, and payment is out of scope. The question is which object owns seat state, how availability is stored, and how concurrent bookings of one seat give one winner.

## Explained
<!--meta block=explain-->

A seat-booking system gives each screening its own lock, so the check that a seat is free and the step that records the booking happen as one unbroken step. Without the lock, two shoppers both see seat A5 as free, both record a booking, and the seat is sold twice. Choose one lock per screening over a lock per seat while the locked work stays a short scan and an append, because it is simple and different screenings never wait on each other. Availability is computed from the booked list on every check instead of kept in a second set, which costs a scan but cannot drift out of step.

- **Hot screening.** A sold-out opening night queues every buyer behind one lock; measure the wait first, then lock per seat.
- **Lock ordering.** A lock per seat needs a fixed order for taking several, so two buyers never hold one each and wait for the other.
- **Checkout hold.** Holding seats during payment needs a third seat state and a sweep that frees abandoned carts after a timeout the business chooses.

**Example.** A screening has 546 seats (rows A to Z, seats 0 to 20). Shopper 1 and shopper 2 both click A5 at once; the lock lets shopper 1 in first, A5 is booked, and shopper 2 is rejected. Shopper 3 then asks for A5, A6 and A7, but A6 is taken: every seat is checked before any change, so the whole request fails and A5 is not claimed. The cost is that all three took turns on one lock, while a show in another theater was never delayed.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Search for films by title, and browse the films playing at a given theater.
2. Theaters have several screens; every screen shares one fixed seat layout (rows A–Z, seats 0–20).
3. View the free seats for a screening and select specific ones; book several in one reservation, which returns a confirmation id.
4. When two bookings race for the same seat, exactly one succeeds; the other is rejected.
5. Cancel a reservation by confirmation id, releasing its seats back into the pool.

Out of scope: payment, seat types and pricing, rescheduling (cancel and rebook instead), and any UI or seat-map rendering — the system only exposes availability.

### Non-functional (constraints)
<!--meta requirement=nfr-->

- **Correctness** — a seat is never sold to two reservations at once, even under concurrent load.
- **Atomicity** — a multi-seat booking is all-or-nothing; one taken seat fails the whole request with no partial state.
- **Encapsulation** — mutation of a screening's seat state happens in exactly one place, so it can be reasoned about under a lock.
- **Evolvability** — extra film fields, dynamic scheduling, and checkout holds should slot in without a rewrite.

## Core entities
<!--meta block=entities-->

Five classes, and two deliberate demotions. The rule of thumb: a candidate earns a class only if it connects other entities, is searched against, or carries its own behaviour.

- **BookingSystem** — the orchestrator and top-level entry point. Owns the theaters and answers the cross-cutting queries no single entity can — global film search and booking-by-id — routing each booking or cancellation to the screening that owns the seats.
- **Theater** — a named venue with an `id` and a list of its screenings. No booking logic; users query it directly ("what's on at the Odeon tonight?").
- **Showtime** — one screening: a film, a datetime, and a screen label. It owns the seat state and is the only object that mutates it — booking and cancellation both run here under its own lock.
- **Movie** — a searchable record: an `id` and a `title`. The id exists because titles are not unique (remakes and re-releases collide), and it lets screenings across theaters point at one film.
- **Reservation** — the booking reference: a `confirmationId`, the list of seat ids, and a back-pointer to its `Showtime` so a cancellation can find its way home without scanning every venue.
- **Seat and Screen — not classes.** A seat is just a string like `"A5"`; a screen is a label like `"Screen 3"`. With one shared layout and no per-seat behaviour, string equality and hashing are all that is needed — a class would be state with no owner.

## The interface
<!--meta block=interface-->

The `BookingSystem` is the public surface; entities like `Showtime` expose their booking methods to it but not to callers. Four operations cover every requirement:

```python summary="Pseudocode — the orchestrator's public API"
class BookingSystem:
    searchMovies(title)               -> List[Showtime]   # case-insensitive substring, future screenings only
    getShowtimesAtTheater(theater)    -> List[Showtime]   # one call, no per-showtime round trip
    book(showtimeId, seatIds)         -> Reservation      # issues a confirmation id; raises if any seat is taken
    cancelReservation(confirmationId) -> None             # follows the back-reference, frees the seats
```

`book` creates the `Reservation` up front — it is only a data object at that point — then hands it to the target `Showtime` for atomic validation and storage. If the screening rejects it, the reservation is never registered, so a failed booking leaves no trace anywhere.

Both rejections raise `ValueError` today. A caller that retries only on a taken seat needs a distinct `SeatUnavailable` error carrying the taken seat ids, kept apart from the malformed-id error.

## How the system is built
<!--meta block=architecture-->

Responsibility flows one way. `BookingSystem` holds the theaters and a set of lookup indexes — `showtimesById`, `reservationsById`, and a film-to-screenings map — built once at construction so search, booking, and cancellation are index lookups rather than nested scans over every theater. Each `Showtime` owns its own `reservations` list, which is the single source of truth for both what has been booked and which seats are free. `Theater` and `Movie` are thin data holders; `Reservation` is a data record that points back at the screening that owns it. Writes to the shared indexes happen after `Showtime.book` returns and are guarded by a `BookingSystem`-level lock or a concurrent map; the screening lock covers only seat state.

```mermaid caption="The orchestrator routes; each Showtime owns its seat state and its own lock. Availability is computed from the reservations list — there is no separate booked-seats field to keep in sync."
classDiagram
    class BookingSystem {
        -List~Theater~ theaters
        -Map~String,Showtime~ showtimesById
        -Map~String,Reservation~ reservationsById
        +searchMovies(title) List~Showtime~
        +book(showtimeId, seatIds) Reservation
        +cancelReservation(confirmationId) void
    }
    class Theater {
        -String id
        -String name
        -List~Showtime~ showtimes
        +getShowtimesForMovie(movie) List~Showtime~
    }
    class Showtime {
        -String id
        -String screenLabel
        -DateTime datetime
        -List~Reservation~ reservations
        -Lock lock
        +isAvailable(seatId) bool
        +getAvailableSeats() List~String~
        +book(reservation) void
        +cancel(reservation) void
    }
    class Movie {
        -String id
        -String title
        +getTitle() String
    }
    class Reservation {
        -String confirmationId
        -List~String~ seatIds
        +getSeatIds() List~String~
    }
    BookingSystem "1" o-- "*" Theater : owns
    Theater "1" o-- "*" Showtime : schedules
    Showtime "1" o-- "*" Reservation : holds
    Showtime ..> Movie : screens
    Reservation ..> Showtime : back-ref for cancellation
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Where seat availability lives

A `Reservation` already carries its own seat list, so the screening's `reservations` list alone tells you everything: booking is an append, cancellation is a remove, and a seat is free exactly when no reservation names it. `getAvailableSeats` generates the fixed grid (A–Z × 0–20, 546 seats) and subtracts the booked set. The tempting alternative is a persistent `bookedSeats` set for O(1) checks — but that is a second piece of mutable state that must be updated in lockstep with `reservations`, and the moment the two drift you get a phantom or a double-sold seat. Computing one truth from the other keeps the invariant impossible to break; it is the [don't-repeat-yourself](../principles/dry.md) choice, trading a linear scan for a state you can never desynchronise.

### 2 · The booking race — exactly one winner

The naïve `book` checks each seat, then appends the reservation. Between the check and the append sits a classic check-then-act window: two threads both read seat `A5` as free, both append, and the seat is sold twice. The requirement demands one winner, so the check and the store must happen as one indivisible step.

The default answer wraps the whole sequence in a lock the `Showtime` owns — validate the seat ids, confirm every requested seat is free, then append — all mutually exclusive. Because `book`, `cancel`, and `isAvailable` all run under the same per-screening lock, the object is a self-contained [monitor](../patterns/concurrency/monitor-object.md): only one booking touches a given screening at a time, while different screenings never contend. This is deliberate [pessimistic](../patterns/distributed/coordination/pessimistic-locking.md) control — you assume a collision and hold the lock across the read-and-write rather than gambling on optimistic retries. The critical section is a short scan-and-append, so a coarse per-screening lock is held briefly, since the scan covers at most 546 seats per screening. The lock must be reentrant, or `book` must call an unlocked inner availability check, because `book` calls `isAvailable` while holding it. The monitor lives in one process; across several app nodes the check-and-append moves into the datastore as a conditional write or row lock. To decide when to go per-seat, watch lock wait time on one screening during an opening-night burst.

The validation is all-or-nothing: every seat is checked before any state changes, so a request for `["A5","A6","A7"]` where A6 is taken throws immediately and A5 is never claimed. A finer design gives each seat its own lock so bookings for different seats of a packed opening night proceed in parallel — real throughput, but it promotes `Seat` from a string to a class with a lock and a `bookedBy` field, and demands sorted lock acquisition to avoid [deadlock](../hazards/deadlock.md). That is the answer to a measured hot-screening bottleneck, not the starting point.

```mermaid caption="Why is there exactly one winner for seat A5? Both bookings take the same per-screening lock in turn, so the second one's availability check sees the first one's reservation."
sequenceDiagram
    participant U1 as Buyer 1
    participant U2 as Buyer 2
    participant S as Showtime
    U1->>S: book(A5)
    Note over S: lock held for Buyer 1
    S->>S: A5 is free, append reservation
    S-->>U1: confirmed
    Note over S: lock released
    U2->>S: book(A5)
    Note over S: lock held for Buyer 2
    S--xU2: seat A5 unavailable
```

```python summary="Pseudocode — Showtime.book under the lock"
def book(self, reservation):
    with self._lock:                       # the screening owns its lock
        seat_ids = reservation.get_seat_ids()
        if not seat_ids:
            raise ValueError("select at least one seat")
        for s in seat_ids:                 # every seat well-formed…
            if not self._is_valid_seat_id(s):
                raise ValueError(f"invalid seat: {s}")
        for s in seat_ids:                 # …and every seat free, before any change
            if not self.is_available(s):
                raise ValueError(f"seat {s} unavailable")
        self._reservations.append(reservation)   # only now do we mutate
```

### 3 · Modelling only what earns a class

Two decisions keep the object graph honest. First, `Seat` and `Screen` stay plain strings — with no per-seat behaviour and one shared layout, a class would add ceremony without state, so it is deferred until fine-grained locking actually needs it ([you aren't gonna need it](../principles/yagni.md)). Second, `BookingSystem` stays a pure orchestrator: it never holds seat state, only routing and the indexes that make routing cheap. Layering the rules this way — orchestration on top, seat state inside each screening, dumb records below — is textbook [separation of concerns](../principles/separation-of-concerns.md), and it is why cancellation lives on `Showtime` (which owns the list it must modify) rather than on `Reservation`, keeping every mutation of a screening in one lockable place. The indexes are denormalised state — faster reads at the cost of more careful writes — but they turn what would be an O(theaters × screenings) scan on every search or cancellation into a hash lookup, and sidestep the N+1 trap of resolving screenings one id at a time.

### 4 · Extending toward a real checkout

Today's `book` is instantaneous — succeed or fail on the spot. A real flow needs to hold seats while the shopper pays. That turns seat status from a binary into a three-way [state](../patterns/gof/behavioral/state.md) — free, held, or booked — with a `holds` map alongside `reservations`: `isAvailable` now rejects a seat claimed by either a reservation or a non-expired hold, `holdSeats` and `confirmHold` run under the same per-screening lock (no new lock type), and an expiry sweep returns abandoned holds to the pool. Expiry is checked lazily: `isAvailable` treats a hold past its expiry time as free, so the sweep only reclaims memory and no expired hold blocks a seat between sweeps. The hold timeout is a business dial — too short cancels people mid-payment, too long freezes seats other buyers want — the kind of policy a strategy would eventually own. Set it from how long the payment step takes, plus a margin. Immutability guards the records underneath all of this: `Movie` has no setters, and `Reservation` defensively copies its seat list on the way in and the way out, so shared references can never mutate a booking from the outside ([immutability](../patterns/functional/immutability.md)).

```mermaid caption="In the checkout extension, how does a seat hold end? confirmHold books it; otherwise the expiry sweep releases it — so an abandoned cart never freezes a seat forever."
stateDiagram-v2
    [*] --> Held: holdSeats (under per-screening lock)
    Held --> Booked: confirmHold — payment succeeds
    Held --> Expired: hold times out, seat returned to pool
    Booked --> [*]
    Expired --> [*]
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- One source of truth for seats: availability is computed from reservations, so there is no second field to fall out of sync.
- A per-screening lock makes booking atomic and correct under concurrency, while different screenings never contend.
- Lookup indexes make booking and cancellation by id hash lookups instead of nested scans; search still scans film titles, then reads screenings from the film map.

### What it gives up
<!--meta polarity=con-->

- A coarse per-screening lock serialises a packed opening night; per-seat locking recovers the throughput but adds a Seat class and deadlock-avoiding lock order.
- Computing availability means an O(booked-seats) scan per check instead of an O(1) set lookup. A k-seat booking repeats the scan k times, and listing free seats rebuilds all 546 seats on each call.
- The denormalised indexes are fast to read but must be updated on every structural change, and past screenings accumulate in memory with no cleanup in this in-memory build.

## What's expected at each level
<!--meta block=levels-->

- **Junior** — a working flow: BookingSystem orchestrates, Showtime tracks seats, Reservation records the booking; `book` checks availability and stores, `cancel` removes and frees, with basic rejection of bad seat ids. May need a hint to spot the concurrency issue.
- **Mid-level** — clean split between orchestrator and screening, recognises the reservations list as the single source of truth, implements synchronized booking, handles all-or-nothing multi-seat requests, and uses lookup indexes instead of scanning every theater.
- **Senior** — nails the check-then-act race unprompted and explains why the check and store must be atomic, weighs per-screening against per-seat locking (and the deadlock-avoiding sort), lets the Reservation→Showtime back-reference fall out naturally, and walks the seat-hold extension without changing the locking model.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Deadlock](../hazards/deadlock.md) — Per-seat locking needs sorted lock acquisition, or two multi-seat bookings can wait on each other.

**Demonstrates**

- [Monitor Object](../patterns/concurrency/monitor-object.md) — each Showtime encapsulates its own lock so book, cancel, and isAvailable run mutually exclusive — only one booking touches a screening at a time
- [Pessimistic Locking](../patterns/distributed/coordination/pessimistic-locking.md) — it assumes a colliding booking and holds the lock across the whole check-and-store rather than gambling on optimistic retries
- [Don't Repeat Yourself (DRY)](../principles/dry.md) — seat availability is computed from the reservations list, so there is no second booked-seats field that could drift out of sync
- [Separation of Concerns](../principles/separation-of-concerns.md) — routing lives in BookingSystem, seat-state mutation inside each Showtime, and Movie/Theater/Reservation stay dumb data
- [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) — Seat and Screen stay plain strings until fine-grained locking genuinely requires promoting Seat to a class
- [Immutability](../patterns/functional/immutability.md) — Movie has no setters and Reservation defensively copies its seat list in and out, so shared references can't mutate a booking
- [State](../patterns/gof/behavioral/state.md) — the checkout extension turns seat status into a three-way free/held/booked state machine with guarded transitions
- [Sweeper](../patterns/distributed/coordination/sweeper.md) — an expiry sweep returns abandoned seat holds to the pool, so a cart nobody finished never freezes a seat
- [Facade](../patterns/gof/structural/facade.md) — BookingSystem is the one public surface a caller touches — theaters, screenings and their seat lists all sit behind it

<!-- relationships:end -->
