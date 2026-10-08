---
title: Amazon Locker
description: "Match a package to a compartment, issue a one-time code that expires in a week — an object-oriented design about where occupancy and access control live"
area: designs-foundational
owner: Oleksandr Derechei
tags: [low-level-design, access-control, lifecycle, state-management]
status: stable
aliases: [parcel locker, package locker]
solves: ["a courier drops a parcel and the recipient collects it later with a one-time code, but I cannot split classes", "my access code must stop working after some days, and an expired one should fail differently from a wrong one", should the is-it-taken flag live on the physical slot itself or on the manager that assigns slots, "an outside object adds only one attribute to my operation, so I wonder whether it needs its own class", a code already redeemed and one never valid must both be rejected without a separate used-codes list]
---

# Amazon Locker

Amazon Locker lets a delivery driver drop a package into an exact-size compartment and hands back a code the customer later types to open the door; the code lapses after a week. As a low-level design it is almost entirely about ownership: which object holds occupancy, what a temporary access code really is, and which facts you can safely compute rather than store.

## Understanding the problem
<!--meta block=description-->

A pickup locker hands a package from a driver to a customer who never meet. The driver deposits into a free door of the right size and the system issues a code; the customer enters it and the door opens. One station and a few dozen doors mean no scale story, so the page is object modelling: which fact belongs on the door, the code, or the object that ties them together.

## Explained
<!--meta block=explain-->

A pickup locker design keeps each fact on the object that owns it: the door tracks whether it holds a parcel, the access code tracks its own expiry and which one door it opens, and the locker object ties the two together and decides. A driver deposits by size, and a linear scan finds a free door of that exact size. Choose this simple scan over an index of free doors by size while the station has a few dozen doors, because the index must be updated on every deposit and pickup and only pays back at hundreds of doors.

- **Idle doors.** Exact-size matching turns away a medium parcel while large doors stand empty, so add a fallback that scans up the size ladder.
- **Lazy expiry.** An uncollected parcel stays in its door until staff open it; the expired code stays on file so the customer hears expired.
- **Trusting the driver.** A driver who opens a door and walks away leaves a live code for an empty box; add a timed reservation step.

**Example.** A station has 30 doors: 10 small, 10 medium, 10 large. All 10 medium doors are full, 4 large doors are free, and a driver arrives with a medium parcel. The exact-size scan checks 30 doors, finds none and refuses, so 4 free doors go unused. With the fallback it takes a large door and the code is valid for 7 days. The customer returns on day 8: the code is still on file, so the reply is expired, not invalid, and support pulls the parcel. The cost is that the large door stays blocked until a person clears it.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. A driver deposits a package by size (small, medium, large); the system assigns a free compartment of that exact size, opens it, and returns one access code — or errors if none is free.
2. A customer retrieves a package by entering the code; the system validates it and opens the door, or throws a specific error for a code that is invalid or expired.
3. Codes expire after seven days; an expired code is rejected on pickup and the package stays put until staff remove it.
4. Staff can trigger every compartment whose code has expired to open, so stuck packages can be pulled and returned to sender.

Out of scope, and named out loud rather than ignored: delivery logistics, getting the code to the customer, a lockout after repeated wrong codes, the UI, multiple stations, and payment.

### Non-functional (constraints)
<!--meta requirement=nfr-->

- **Correctness** — one compartment holds one package, and only the right code opens it.
- **Exact fit** — a size is matched exactly; the base design never upgrades a medium into a free large door.
- **Actionable errors** — an expired code fails differently from a plain invalid one, because the customer can act on it.
- **Simplicity** — no queueing for a full station, no lockout, no proactive cleanup; a full door or a bad code just errors.

## Core entities
<!--meta block=entities-->

Three classes, one enum, and one deliberate refusal:

- **Locker** — the orchestrator and the only public surface. Owns the compartments and a map from code to token, and runs both workflows: deposit, pickup, and the staff sweep.
- **AccessToken** — a bearer credential, not just a string on something else. It holds its `code`, an `expiration` timestamp, and a reference to the one `compartment` it unlocks, and it answers `isExpired()` itself. It is built once at deposit and never mutated afterwards, which makes it read as an immutable [value object](../patterns/ddd/value-object.md). Read as an access grant, it is a [valet key](../patterns/distributed/routing/valet-key.md) and a study in [least privilege](../patterns/security/least-privilege.md): it opens exactly one door, for exactly one week, and confers nothing else.
- **Compartment** — a physical slot with a `size`, an `id`, and an `occupied` flag. It knows how to open its own door and track whether a package is inside; it knows nothing about codes or expiry.
- **Package — not a class.** The parcel is owned and tracked by Amazon's fulfilment system, which already holds its id, shipping details, and recipient. This system needs only its size, so size collapses to a `Size` enum passed into `depositPackage`. Modelling Package as a class here would be state with no owner and no behaviour.

Splitting the work this way is the GRASP Information Expert heuristic in the small: the Locker owns allocation and the code lookup because it can see every compartment, the AccessToken owns expiry because it holds the timestamp, and the Compartment owns its physical condition because that is literally its own state.

## The interface
<!--meta block=interface-->

The Locker exposes three operations and nothing else — no `getFreeCompartments()` or `getStatus()`, which would leak internals the workflow never needs. Deposit returns only the code (the door already popped open, so the driver sees which one); a valid pickup returns nothing, because the opening door is the feedback; bad codes throw instead.

```python summary="Pseudocode — the public API"
class Locker:
    depositPackage(size)          -> code   # matches a free door of exactly this size, opens it, returns a one-time code; raises if none free
    pickup(code)                  -> void   # validates the code and opens the door; raises "invalid" or "expired"
    openExpiredCompartments()     -> void   # staff sweep: opens every door whose code has expired, so packages can be pulled
```

## How the system is built
<!--meta block=architecture-->

The Locker holds its list of compartments and a `tokens` map keyed by code. `depositPackage` scans for a free compartment of the requested size, opens it, marks it occupied, issues a token, files the token under its code, and returns the code. `pickup` looks the code up, checks expiry, and on success opens the door and clears both the occupancy flag and the map entry. The AccessToken carries expiry and its target door; the Compartment carries its own physical state; the rules live in the Locker.

```mermaid caption="The Locker orchestrates; the token is an expiring credential that names one door; the compartment owns its own occupancy. Package is absent by design."
classDiagram
    class Locker {
        -List~Compartment~ compartments
        -Map~String,AccessToken~ tokens
        +depositPackage(size) String
        +pickup(code) void
        +openExpiredCompartments() void
        -findFree(size) Compartment
    }
    class AccessToken {
        -String code
        -long expiration
        -Compartment compartment
        +isExpired() boolean
        +getCompartment() Compartment
        +getCode() String
    }
    class Compartment {
        -String id
        -Size size
        -boolean occupied
        +open() void
        +markOccupied() void
        +markFree() void
        +isOccupied() boolean
    }
    class Size {
        <<enumeration>>
        SMALL
        MEDIUM
        LARGE
    }
    Locker "1" o-- "*" Compartment : owns
    Locker "1" ..> "*" AccessToken : issues
    AccessToken --> Compartment : unlocks
    Compartment --> Size : sized
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Where does occupancy live?

Occupancy is the design's fault line. The tell is whether a fact is an intrinsic physical condition or a relationship the system manages.

- **Compute it from the tokens.** A door is occupied if and only if some live token points at it — no stored flag at all. It looks clean and quietly breaks, because physical occupancy and code validity are different facts that drift apart. An expired token cannot be deleted at the seven-day mark (pickup must still be able to answer "expired"), and the package is physically still inside, so the scan happens to report the door occupied. The moment you "fix" the scan to count only non-expired tokens, it falsely frees a door that still holds a parcel. You cannot compute a physical fact from an access-control fact.
- **Index the free doors by size.** Keep a `Map<Size, Queue<Compartment>>` of what is available: deposit dequeues, pickup re-enqueues, and allocation is O(1) with a FIFO (first in, first out) queue spreading wear evenly across doors. But now truth lives in two places — the compartment list and the queues — and they must move in lockstep; forget to enqueue on pickup and a perfectly good door looks full forever. It pays back only at hundreds or thousands of doors with constant traffic. At twenty to fifty doors, O(1) against O(50) is noise, so the [extra bookkeeping](../principles/yagni.md) buys nothing.
- **A boolean on the Compartment.** Put `occupied` on the entity and scan linearly to allocate. That is this design's answer: physical state lives where the physics is, there is a [single source of truth](../principles/dry.md), and the code stays simple. This is [separation of concerns](../principles/separation-of-concerns.md): a physical condition (occupied, and later broken or out of service) belongs on the thing, while a managed relationship (this code opens that door) belongs in the orchestrator. It is not a universal rule — the [Parking Lot](./parking-lot.md) design makes the opposite call and treats occupancy as a relationship in a central set — but here occupancy really is physical, so the flag goes on the door.

### 2 · One error for invalid, a distinct one for expired

Pickup has three failure shapes but only two messages, and the collapse is deliberate.

- **Never issued and already used both return "invalid".** A successful pickup removes the token from the map, so a reused code is indistinguishable from a code that was never valid — both simply miss the map. Telling them apart would mean keeping a `usedTokens` set or an `isUsed` flag alive forever, extra state for a marginal message. Not worth it, so both throw the same generic error. Each class here changes for exactly one reason — a nod to the [single-responsibility principle](../principles/single-responsibility.md) — and adding a used-code ledger would hand the Locker a second job.
- **Expired gets its own message.** "Access token has expired" is distinct because it is actionable: it tells the customer the parcel is still sitting in the door and to contact support, rather than implying the code was garbage. The token stays mapped and the door stays occupied precisely so this answer is possible.

```python summary="Pseudocode — deposit and pickup"
depositPackage(size):
    c = firstFreeCompartmentOfExactly(size)     # linear scan; null if none
    if c is null: raise "No compartment of size " + size
    c.open(); c.markOccupied()
    token = AccessToken(randomCode(), now + 7d, c)
    tokens[token.code] = token
    return token.code

pickup(code):
    token = tokens[code]
    if token is null:      raise "Invalid access token code"   # never issued OR already redeemed
    if token.isExpired():  raise "Access token has expired"    # actionable: parcel still inside
    token.compartment.open()
    token.compartment.markFree(); tokens.remove(code)          # clear the deposit
```

```mermaid caption="Which answer does a pickup get? A missing code is invalid whether never issued or already redeemed, a mapped but expired token says so, and only a live token opens the door."
sequenceDiagram
    participant C as Customer
    participant L as Locker
    participant T as AccessToken
    participant D as Compartment
    C->>L: pickup(code)
    L->>L: look up code in token map
    alt code not in map
        L--xC: Invalid access token code
    else token found
        L->>T: isExpired()
        alt expired
            L--xC: Access token has expired
        else live
            L->>D: open(), markFree()
            L->>L: remove code from map
            L-->>C: door open
        end
    end
```

### 3 · Lazy expiry, and the deposit you have to trust

Expiry is lazy on purpose. Nothing sweeps the map at the seven-day mark; a token lingers so a late pickup gets "expired" instead of "invalid", and the package is still inside, so the door stays occupied. The staff tool `openExpiredCompartments()` opens every expired door but does not free the compartment or drop the token — the real cleanup waits until a human has physically pulled the parcel and run a separate, out-of-scope step. Deposit also trusts the driver: it opens the door, marks it occupied, and issues the code all on the assumption the driver actually put the package in. A driver who opens the door and walks away leaves a valid code for an empty compartment. In production that becomes a two-step deposit — `reserve` the door and return a reservation id, then `confirmDeposit` only once a sensor or a manual tap registers the parcel, with a short reservation timeout to reclaim an abandoned door. That buys a `RESERVED` state and a second map, correctly deferred here because the single-phase flow is simpler and enough here.

```mermaid caption="What states does a deposit's access token pass through, and how does each end? Expired is a live state, not deletion — the door stays occupied so a late pickup hears \"expired\", not \"invalid\"."
stateDiagram-v2
    [*] --> Active: deposit issues code, door occupied
    Active --> Redeemed: valid pickup — open, free door, drop token
    Active --> Expired: seven days elapse (lazy, token lingers)
    Expired --> Cleared: staff opens, human pulls parcel (out of scope)
    Redeemed --> [*]
    Cleared --> [*]
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Occupancy on the Compartment is a single source of truth — no index to keep in sync, and a linear scan over a few dozen doors is effectively free.
- The code is a self-contained expiring credential: it names its own door and enforces its own seven-day life, so the Locker just looks it up and trusts it.
- A distinct, actionable "expired" error separates a still-present parcel from a plain bad code, without any extra bookkeeping.

### What it gives up
<!--meta polarity=con-->

- Exact-size-only allocation rejects a medium deposit while large doors sit empty, until a size-fallback scan is added, and the fallback itself holds a large door for a medium parcel until that parcel is picked up.
- "Never issued" and "already redeemed" collapse into one generic error; splitting them needs a used-token set kept alive indefinitely.
- Expiry is lazy: expired tokens linger and their doors stay occupied until staff physically clear them; nothing reclaims space on its own.
- Single-phase deposit trusts the driver actually deposited; an open-and-walk-away leaves a valid code for an empty door until two-phase confirmation is added.
- `randomCode()` is never checked against stored tokens, so a repeat overwrites a live token and strands its parcel; code length is unstated and lockout is out of scope, so only a long random code makes 'only the right code opens it' hold.
- Nothing guards concurrent deposits: two that scan at once can pick the same free door, breaking one compartment, one package, so the scan-then-mark step needs a lock or a single-threaded kiosk.

## What's expected at each level
<!--meta block=levels-->

- **Junior** — a sensible class breakdown and a working happy path: name the three entities, wire deposit and pickup end to end, and show awareness that edge cases exist. Working through the entity design with a few hints is fine.
- **Mid-level** — reaches the three-entity model by reasoning and rejects Package as a class; keeps the concerns clean (Locker orchestrates, AccessToken owns access and expiry, Compartment owns physical state); handles invalid, expired, and full-station cases; and justifies where occupancy lives rather than just placing it.
- **Senior** — drives the conversation, rejects Package fast with a clear reason, and names the Information Expert framing. Volunteers the trade-offs unprompted: where occupancy belongs, why lazy cleanup is acceptable, and when a Package entity finally becomes necessary (multiple parcels per compartment). Anticipates the follow-ups — size fallback, out-of-service doors, two-phase deposit — before being asked.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Parking Lot](./parking-lot.md) — Amazon Locker puts occupancy on the compartment itself, where Parking Lot computes it in the orchestrator

**Demonstrates**

- [Single Responsibility Principle](../principles/single-responsibility.md) — each class changes for one reason — Locker allocates, AccessToken owns expiry, Compartment owns physical state
- [Separation of Concerns](../principles/separation-of-concerns.md) — the intrinsic physical fact (occupied) lives on the Compartment while the managed relationship (code opens door) lives in the orchestrator
- [Valet Key](../patterns/distributed/routing/valet-key.md) — the access code is a scoped bearer credential that opens exactly one compartment and nothing else
- [Least Privilege](../patterns/security/least-privilege.md) — the token grants the minimum authority that still works — one door, for one week
- [Value Object](../patterns/ddd/value-object.md) — the AccessToken is built once at deposit and never mutated; code, expiry and target door are read-only
- [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) — the O(1) size index, a used-token set, lockout, and two-phase deposit are all deferred until scale actually demands them

<!-- relationships:end -->
