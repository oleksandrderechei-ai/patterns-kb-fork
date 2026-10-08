---
title: Elevator
description: Route a hall call to the right car and sweep its stops one way — an object-oriented design about a direction state machine and a swappable dispatch policy
area: designs-foundational
owner: Oleksandr Derechei
tags: [low-level-design, state-management, separation-of-concerns, extensibility]
status: stable
aliases: [elevator control system, lift]
solves: [my elevator scheduler picks a car for each request but keeps changing its mind and wastes trips, my scheduler thrashes by reversing direction instead of sweeping through pending stops in one pass, I stored each pending stop as a plain number and cannot tell opposite-direction requests at one floor apart, the coordinator class keeps growing because it also knows the internal movement rules of every car it manages, "I want to swap the assignment policy, wait time here and energy there, without touching the code that moves cars"]
---

# Elevator

An elevator control system moves several cars across a fixed set of floors: a hall call names a direction, the system dispatches a car, and riders inside pick destination floors. As a low-level design it is almost entirely about placement — which object owns movement, which owns the choice of car, and how a single pending stop is represented so a car never picks up a rider going the wrong way.

## Understanding the problem
<!--meta block=description-->

An elevator control system takes hall calls, which carry a direction, and destination presses, which do not, and chooses which of several cars answers each. The first question is whether this is a simulation advanced by a step() function or real control software; a low-level design wants the simulation, because discrete ticks stay deterministic and testable. The page models the classes and places movement, dispatch and request shape.

## Explained
<!--meta block=explain-->

An elevator controller gives each car its own sweep: it keeps moving one way, stops for every rider going that way, and reverses only when nothing is left ahead, while a separate rule picks which car answers a hall call. Choose the sweep over going to the nearest stop when riders trust the up and down indicator more than they value the shortest trip: it reverses less than first-come order, but ties nearest-stop on reversals and can cost a floor more. Keep dispatch a swappable rule ([Strategy](../patterns/gof/behavioral/strategy.md)) rather than part of the car, for example one rule that shortens waits in a busy tower and another that saves energy overnight.

- **Missed pass.** A rider who presses just behind the sweep waits a full pass. If that hurts, let the dispatch rule send another car.
- **Wrong car.** A rule trusting only direction and position can pick a car that reverses first. Ask whether its queued stops reach the floor.
- **Ties.** Set order is not stable, so state a rule such as the lower floor, or the simulation will not repeat exactly.
- **Parallel calls.** Hand hall calls over through a queue read once per tick: one tick of delay, where a lock makes calls wait on step().

**Example.** A car at floor 5 holds stops 8, 3 and 7. First-come order goes 5 to 8, to 3, to 7: 3 + 5 + 4 = 12 floors and two reversals. Nearest-stop goes 3, 7, 8: 2 + 4 + 1 = 7 floors and one reversal, but dives down first. The sweep goes 7, 8, then reverses to 3: 2 + 1 + 5 = 8 floors and one reversal. It beats first-come order on reversals, ties nearest-stop on them and travels one floor more, and a rider who presses down at 6 just after the car passes waits for the full pass.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Three cars serve floors 0–9; a hall call from any floor names a direction, and the system decides which car answers.
2. Riders inside a car select one or more destination floors, which carry no direction.
3. Time advances in discrete steps — one `step()` moves every car by one tick.
4. Accept many pickup requests spread across floors within a tick; truly concurrent calls are an extension (nfr-5).
5. Reject a request for a non-existent floor (return `false`); a request for the floor a car already sits on is a no-op.

Out of scope, named explicitly: weight and capacity limits, door open/close mechanics, emergency stop, dynamic floor/car reconfiguration, and any UI or rendering.

### Non-functional (constraints)
<!--meta requirement=nfr-->

- **Efficient movement** — a car sweeps through its stops rather than bouncing back and forth.
- **Direction-correct pickups** — a car heading up must not scoop a rider who pressed down.
- **Determinism** — the same inputs produce the same trace, so the simulation is testable and no hash-set iteration order leaks in.
- **Encapsulation** — one entry point for hall calls (requestElevator), destinations going to a car's addRequest; a car's movement rules stay inside the car.
- **Evolvability** — express cars, request cancellation, and truly concurrent hall calls should slot in without a rewrite.

## Core entities
<!--meta block=entities-->

Three classes, two enums, and one deliberate omission:

- **ElevatorController** — the orchestrator and the only public surface. Holds the list of cars, receives hall calls, decides which car answers, and owns the `step()` that advances the whole simulation one tick. Beyond the car list it keeps no state — hall calls are dispatched the instant they arrive.
- **Elevator** — one car. Owns its `currentFloor`, its `direction`, and a set of pending stops. Executes movement one floor per tick and knows nothing about the other cars.
- **Request** — a single stop: a `floor` plus a `RequestType`. It is an immutable value compared by both fields, so a pickup-up, a pickup-down, and a destination at the same floor are three distinct stops.
- **Direction / RequestType** — enums. `Direction` is `UP`, `DOWN`, or `IDLE`; the explicit `IDLE` matters, because a car with no work needs to represent "not moving" rather than drift up or down forever.
- **Floor — not a class.** It is just an integer index with no state or behaviour of its own; modelling it as a class would be state with no owner.

## The interface
<!--meta block=interface-->

The controller exposes two operations — issue a hall call and advance time — while destinations reach a specific car through the car's own `addRequest`:

```python summary="Pseudocode — the public API"
class ElevatorController:
    requestElevator(floor, type) -> bool   # hall call; false if floor invalid or type is DESTINATION
    step()                       -> void   # advance every car by one tick

class Elevator:
    addRequest(request)          -> bool   # queue a stop (used by hall calls and destinations alike)
    step()                       -> void   # one tick of movement
    getCurrentFloor()            -> int
    getDirection()               -> Direction
```

`requestElevator` takes a `RequestType` (`PICKUP_UP` / `PICKUP_DOWN`), **not** a `Direction`. A hall call is never `IDLE`, so accepting a `Direction` would admit a value the code then has to validate at runtime; the narrower type makes the illegal state unrepresentable. `addRequest` is deliberately one method for both callers — the car does not care why it is stopping, so a hall call and a destination flow through the same door.

## How the system is built
<!--meta block=architecture-->

Two classes carry the weight. The **controller** is a thin, near-stateless coordinator: on a hall call it validates the floor, picks the best car, and hands that car a `Request`; on `step()` it simply forwards the tick to each car and stays out of the way. Each **Elevator** is a self-contained state machine over its direction and its set of stops — all the movement logic lives here, so the controller never needs to know how a car moves. Each class has one reason to change ([single responsibility](../principles/single-responsibility.md)) — the controller for dispatch policy, the car for movement — a [separation of concerns](../principles/separation-of-concerns.md), though dispatch reads each car's floor, direction and queued stops, so a change to that state can touch the dispatch rule. The small `Request` value in the middle is what makes a car stop only for riders travelling its way.

```mermaid caption="The controller coordinates and dispatches; each car owns its own movement as a direction state machine; a Request is an immutable (floor, type) value."
classDiagram
    class ElevatorController {
        -List~Elevator~ elevators
        +requestElevator(floor, type) bool
        +step() void
        -selectBestElevator(request) Elevator
    }
    class Elevator {
        -int currentFloor
        -Direction direction
        -Set~Request~ requests
        +addRequest(request) bool
        +step() void
        +getCurrentFloor() int
        +getDirection() Direction
    }
    class Request {
        -int floor
        -RequestType type
        +getFloor() int
        +getType() RequestType
    }
    class Direction {
        <<enumeration>>
        UP
        DOWN
        IDLE
    }
    class RequestType {
        <<enumeration>>
        PICKUP_UP
        PICKUP_DOWN
        DESTINATION
    }
    ElevatorController "1" o-- "3" Elevator : dispatches to
    Elevator "1" o-- "*" Request : queues
    Elevator ..> Direction : state
    Request ..> RequestType : typed by
```

## Deep dives
<!--meta block=deepdives-->

### 1 · How is a pending stop represented?

The tempting shortcut is a `Set<Integer>` — store only which floors to visit. It is simple and dedups naturally when several people want the same floor. But it throws away direction, and that turns out to be the whole game. A car at floor 5 going up with stops at 7 and 8 will stop at floor 7 for someone who pressed down and carry them the wrong way to 8 before coming back — not merely inefficient but a broken promise, since riders trust the up/down indicator.

- **Store just floor numbers.** A `Set<Integer>` cannot tell a down-waiter from an up-waiter at the same floor. Acceptable only for a junior-level answer.
- **A Request value (chosen).** Wrap floor + `RequestType` and base equality on both, so `Request(7, PICKUP_UP)`, `Request(7, PICKUP_DOWN)`, and `Request(7, DESTINATION)` are three different stops. Now a car going up checks only for `PICKUP_UP` and `DESTINATION` at its floor, correctly passes the down-waiter, and catches them on the return sweep.

`Request` is an immutable [value object](../patterns/ddd/value-object.md) — set once, read-only, compared by content — and the entire stopping algorithm hinges on this one small modelling decision.

### 2 · How does a car move?

Three algorithms, tested on the same set of stops — 8, 3, 7 — with the car at floor 5:

- **First in, first out (FIFO).** Serve stops in arrival order: 5&nbsp;→&nbsp;8&nbsp;→&nbsp;3&nbsp;→&nbsp;7, which is 12 floors of travel and two reversals. A rider at floor 7 watches the car climb to 8, plunge all the way to 3, then return. Feels random and unfair.
- **Nearest stop.** Always head to the closest queued stop: 5&nbsp;→&nbsp;3&nbsp;→&nbsp;7&nbsp;→&nbsp;8, only 7 floors — but it still reverses needlessly, diving down to 3 before sweeping the 7 and 8 it was already positioned for.
- **SCAN (chosen).** Keep going one direction, serving every matching stop, and reverse only when nothing remains ahead — the same "elevator algorithm" used for disk-arm scheduling. Going up from 5: 7, 8, reverse, 3 — 8 floors and a single reversal. It travels a floor further than nearest-stop and reverses no more often than it does here, but a rider on the car's way sees it approach rather than flee, except at a stop it reaches only after reversing. Strictly this is the LOOK variant: classic SCAN runs to the last floor before reversing, and this car reverses when nothing remains ahead.

SCAN lives entirely inside `Elevator.step()`, driven by `direction` as an explicit three-value [state machine](../patterns/gof/behavioral/state.md). One tick is five cases: no requests → go `IDLE`; `IDLE` with work → pick a direction toward the nearest stop (ties broken by the lower floor, because a `HashSet`'s iteration order is not stable and the simulation must be deterministic); at a matching stop → remove those requests and `return` without moving (a car never moves on the tick it stops — forgetting that `return` is the classic bug); nothing ahead → flip direction and `return`; otherwise advance one floor. A subtlety worth naming: stopping is direction-aware, but travelling is not — `hasRequestsAhead` steers the car toward any stop, even one it will only serve after reversing. And there are no floor-0 or floor-9 boundary checks: once no stop remains ahead the reverse case fires on its own, so hardcoding "if floor == 9 then go down" is an anti-pattern that misfires the instant a stop is added at floor 9.

### 3 · Which car answers a hall call?

Dispatch lives in the controller's `selectBestElevator`, and there is a ladder of answers:

- **Nearest car, ignoring direction.** Thirty seconds to write and fine under light traffic, but it will send the closest car even when it is heading away — the rider watches the nearest car recede and wait for it to come back.
- **Direction-aware (chosen for the interview).** Three priorities in order: a car already moving the right way and positioned to reach the floor (an up-bound car at or below the call floor, a down-bound car at or above it); else the nearest idle car; else the nearest car of any kind; equal distances go to the lower car index, as the lower-floor rule does inside a car. A known gap remains — a car going up whose highest stop is below the requested floor still looks like a match though it will reverse first. The fix inspects the car's queue (`hasRequestsAtOrBeyond`) to confirm its committed stops actually carry it to or past the floor; flag it even if you skip the code.

Whichever rule you land on, `selectBestElevator` sits behind a fixed signature — which is exactly a [strategy](../patterns/gof/behavioral/strategy.md): a wait-time-minimizing policy for a busy office tower and an energy-saving policy for a quiet overnight building are swappable without touching a line of movement code. The controller also keeps no queue of unassigned requests; a hall call is assigned immediately. Holding pending requests for cars to pull from is the more general design, but it only earns its keep once "what if every car is busy?" is a real requirement — deferring it is a [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) call. In the same spirit, `requestElevator` and `addRequest` both read like "add a request," yet forcing them under one shared `IRequestHandler` interface would invent polymorphism that is not there: the controller is not a kind of car, and no code ever needs to treat them interchangeably.

The direction-aware rule is a ladder of three checks.

```mermaid caption="How does selectBestElevator pick a car for a hall call?"
flowchart TB
    Call["Hall call"] -->|"selectBestElevator"| P1{"car moving the right way and positioned to reach the floor?"}
    P1 -->|"yes"| A["Assign that car"]
    P1 -->|"no"| P2{"any idle car?"}
    P2 -->|"yes"| B["Assign nearest idle car"]
    P2 -->|"no"| C["Assign nearest car of any kind"]
```

### 4 · Extending it without a rewrite

The follow-ups are where the placement pays off:

- **Express cars.** Rather than bolt a `priority` field onto `Request` and feed a priority queue — which would wreck the single-direction sweep — keep the normal movement and add an `isExpress` flag plus an `expressFloors` set. The express car's `addRequest` simply rejects non-express floors, and dispatch prefers it for those floors. `Request` and `step()` never change: new behaviour by extension, not by surgery, in the spirit of [open–closed](../principles/open-closed.md).
- **Cancelling a request.** Mirror `addRequest` with a `removeRequest` that just drops the `Request` from the set; `step()` is untouched, and cancelling after arrival is a harmless no-op. (In the real world elevators do not cancel, because a lit button is a promise to other waiting riders — a good caveat to raise.)
- **Concurrent hall calls.** The simulation is single-threaded — enqueue, `step()`, repeat — but a real building fires hall calls concurrently, exposing two hazards: two dispatches racing to claim the same idle car, and `step()` mutating a car's request set while `addRequest` writes to it. A coarse lock around `requestElevator` and `step()` is correct but makes them block each other. The cleaner move is a [producer–consumer](../patterns/concurrency/producer-consumer.md) handoff: writers append to a thread-safe queue, and `step()` drains it into the working set at the top of each tick, so the writers and the mover never touch the same structure.

```mermaid caption="What direction states does a car cycle through, and what event drives each transition? SCAN holds one direction until nothing remains ahead, then reverses — never on a hardcoded floor boundary."
stateDiagram-v2
    [*] --> Idle
    Idle --> MovingUp: work above, nearest stop up
    Idle --> MovingDown: work below, nearest stop down
    MovingUp --> MovingUp: stop ahead — serve or advance a floor
    MovingDown --> MovingDown: stop ahead — serve or advance a floor
    MovingUp --> MovingDown: nothing ahead, work remains below
    MovingDown --> MovingUp: nothing ahead, work remains above
    MovingUp --> Idle: no requests left
    MovingDown --> Idle: no requests left
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Direction-correct pickups and thrash-free travel: the Request value plus the single-direction sweep mean a car never scoops a rider going the wrong way and reverses only when nothing remains ahead: once on the 8, 3, 7 example, against two for first-come order and one for nearest-stop.
- Movement and dispatch are separately ownable and separately testable — the car is a self-contained state machine, the dispatch rule a swappable strategy.
- A deterministic simulation: the explicit IDLE state and the lowest-floor tiebreak make every run reproducible from the same inputs.

### What it gives up
<!--meta polarity=con-->

- The sweep optimizes direction changes, not distance — it can travel a floor or two more than always heading for the closest stop, and a rider just behind the sweep waits a whole pass.
- The chosen dispatch check trusts a car's current direction and position, not whether its queued stops actually carry it past the floor, so it can still pick a car that reverses before arriving.
- Immediate dispatch and single-threaded ticks are simplifications: there is no pending queue to reconsider a call later, and truly concurrent hall calls need a lock or a queue bolted on.

## What's expected at each level
<!--meta block=levels-->

- **Junior** — a working simulation: a car tracking floor and direction, a controller over several cars, simple nearest-car dispatch, and basic up/down movement. Inefficient bouncing is tolerated as long as every floor is eventually served, and invalid floors are rejected. May need a nudge to reach "continue one direction, then reverse when clear."
- **Mid-level** — SCAN implemented correctly with few hints; a clean IDLE/UP/DOWN state machine with the subtle rules (no move on the tick you stop, reverse only after removing the current stop, go idle when empty); and dispatch that at least recognizes naive nearest-car is flawed. Can say where a change lives — hall-call direction touches the request representation, not the whole algorithm.
- **Senior** — proactively asks the simulation-vs-hardware question (a senior tell), designs a near-stateless controller and a well-encapsulated car, handles boundary, idle, and stop-then-reverse edges unprompted, reaches the priority-tier dispatch while flagging its remaining limitation, and sketches the express, cancel, and concurrency extensions without restructuring the classes.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Race Condition](../hazards/race-condition.md) — Two hall-call dispatches can claim the same idle car, and step() can mutate a car's stop set while addRequest writes to it.

**Demonstrates**

- [Strategy](../patterns/gof/behavioral/strategy.md) — selectBestElevator is a dispatch policy behind a fixed signature — wait-time for a busy tower, energy-saving for a quiet building — swapped without touching movement
- [Value Object](../patterns/ddd/value-object.md) — Request is immutable and compared by (floor, type), so PICKUP_UP and PICKUP_DOWN at one floor are distinct stops
- [Separation of Concerns](../principles/separation-of-concerns.md) — the controller coordinates dispatch while each car owns its own movement and knows nothing of the others
- [Single Responsibility Principle](../principles/single-responsibility.md) — the controller changes only for dispatch policy and the car only for movement — one axis of change each
- [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) — immediate dispatch is chosen over a pending-request queue, and no shared IRequestHandler interface is forced where there is no real polymorphism
- [Open/Closed Principle](../principles/open-closed.md) — an express car drops in via an isExpress flag and a restricted addRequest without editing Request or step()
- [Producer-Consumer](../patterns/concurrency/producer-consumer.md) — concurrent hall calls are handled by writers enqueueing onto a thread-safe queue that step() drains at the top of each tick
- [State](../patterns/gof/behavioral/state.md) — a car's direction is an explicit IDLE/UP/DOWN state machine, held as an enum and switched in step() together with the pending stops, not a class per state

<!-- relationships:end -->
