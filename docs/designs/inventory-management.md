---
title: Inventory Management
description: "Track stock across fixed warehouses, move it atomically, and alert when it runs low — an object-oriented design about where mutation and locking belong"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [low-level-design, decoupling, encapsulation]
status: stable
aliases: [stock management, warehouse inventory]
solves: [two threads bump the same counter and one update silently overwrites the other, moving items between two locations sometimes shows them missing from both or counted twice, my low-stock notification fires over and over once the count sits below the limit, "I want to change how stock alerts are delivered, by email or webhook, without touching the quantity-tracking code", I hold a lock while a callback makes a network call and every other operation stalls behind it]
---

# Inventory Management

A fixed set of warehouses each hold a per-product count. The system receives shipments, deducts on fulfilment, moves stock between locations, answers "who can ship this?", and alerts a manager when a product runs low. There is no distributed scale to reason about — it is one process — so the whole exercise is concurrency and placement: which object mutates state, where the lock sits, and how a slow notification stays off the critical path.

## Understanding the problem
<!--meta block=description-->

An in-memory model that counts stock per product across a fixed set of warehouses: add on receipt, remove on fulfilment, transfer between two locations, never below zero. Products come from an external catalogue, and orders, payments and persistence are out of scope. The hard part is two constraints: every operation is thread-safe, and a transfer is atomic.

## Explained
<!--meta block=explain-->

An inventory model gives each warehouse its own counts, its own lock and its own low-stock alert settings, and a manager object that routes calls and handles the one job that spans two warehouses: moving stock between them. A transfer takes both locks before it changes anything, always in the same order, such as sorted by warehouse id, so no other thread ever sees stock missing from both ends and two opposite transfers cannot each hold one lock and wait for the other. The locks must be reentrant, meaning a thread can take a lock it already holds, because the transfer calls methods that lock again. Decide which alerts a change tripped while holding the lock, but send them after releasing it, since a listener may spend seconds on a webhook.

- **Contention.** Two whole-warehouse locks freeze every product in both warehouses, so move to per-product locks only when a busy pair measurably queues.
- **No in-transit stock.** The model says nothing about stock on the road, so add an in-transit holder when you need it.
- **Overselling.** Deducting only at fulfilment can oversell, so add a reservation step when orders race.

**Example.** Warehouse A holds 50 units and B holds 0. A transfer of 50 takes the lock of A, then B, sorted by id, removes 50, adds 50 and releases both; no reader sees 0 in total. Without the locks, thread 1 checks that A has 50, thread 2 removes them, and thread 1 then adds 50 phantom units to B. For alerts with a threshold of 10, stock going 12 to 8 fires once, 8 to 5 stays silent, and 15 to 9 fires again, with no flag to reset.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Track a per-product quantity across a fixed set of named warehouses set at initialization.
2. Add stock to a warehouse (receiving) and remove stock from one (fulfilling), rejecting any removal that would go negative.
3. Transfer stock between two warehouses as one atomic move.
4. Given a product and a quantity, return the warehouses that can currently fulfil it.
5. Register low-stock thresholds per product per warehouse that fire a pluggable callback when the count crosses down through the threshold.

Out of scope: product-catalogue management, order/payment/serviceability, and persistence. Products exist externally; the system only counts them.

### Non-functional (constraints)
<!--meta requirement=nfr-->

- **Thread safety** — concurrent adds, removes, and transfers stay correct with no lost updates.
- **No negative inventory** — validate before mutating; an operation that can't succeed changes nothing.
- **Atomic transfer** — stock leaves the source and arrives at the destination as one indivisible step, with no phantom or double-counted state.
- **Alert discipline** — a threshold fires once on the way down, not on every operation while the count sits low.
- **Pluggable delivery** — email, webhook, or log is chosen by the caller and swapped without touching stock-tracking code.

## Core entities
<!--meta block=entities-->

Four types survive the "does it hold changing state or enforce a rule?" test — and one obvious noun does not:

- **InventoryManager** — the orchestrator and the only public surface. Owns a `Map<warehouseId, Warehouse>`, routes single-warehouse calls straight through by id, and owns the genuinely cross-warehouse logic: the atomic transfer and the availability scan.
- **Warehouse** — one storage location. Holds a `Map<productId, int>` of quantities and, per product, a list of alert configs. It enforces "no negative stock," owns its own lock, and decides which alerts a change has tripped — but knows nothing about any other warehouse.
- **AlertConfig** — an immutable [value object](../patterns/ddd/value-object.md) pairing a `threshold` with an `AlertListener`. Keeping the two together reads better than parallel maps and leaves no room for them to drift apart.
- **AlertListener** — the interface a notification implements: a single `onLowStock(warehouseId, productId, currentQuantity)`. It is what makes delivery pluggable; the warehouse never learns whether an email or a webhook is on the other side.
- **Product — not a class.** The catalogue is external, so a product collapses to a string key. Modelling it here would be state with no owner and no behaviour.

## The interface
<!--meta block=interface-->

Everything external goes through `InventoryManager`. The return types encode a deliberate asymmetry: you can always receive more stock, so `addStock` returns nothing; removing and transferring can fail on insufficient stock, so they return a boolean rather than throw for an ordinary shortfall.

```python summary="Pseudocode — the public API"
class InventoryManager:                                  # the only public surface
    addStock(warehouseId, productId, qty)          -> void      # receiving; always succeeds
    removeStock(warehouseId, productId, qty)       -> boolean   # fulfilling; false if short
    transfer(productId, fromId, toId, qty)         -> boolean   # atomic move; false if short/invalid
    getWarehousesWithAvailability(productId, qty)  -> List      # warehouse ids that can fulfil qty
    setLowStockAlert(warehouseId, productId, threshold, listener) -> void
```

## How the system is built
<!--meta block=architecture-->

The manager is a thin router over the warehouse map. `addStock`, `removeStock`, and `setLowStockAlert` look up one warehouse by id and delegate; a missing warehouse id throws. Only two operations are genuinely the manager's own work: `getWarehousesWithAvailability` iterates every warehouse and collects the ids that can fulfil the quantity, and `transfer` coordinates two warehouses at once. All the real state — the quantity map, the alert configs, and a reentrant lock — lives inside each `Warehouse`, which serialises its own mutations and decides which alerts to fire while holding the lock but leaves the actual firing to its caller after the lock is released.

```mermaid caption="The manager routes and coordinates; each warehouse owns its counts, its alert configs, and its lock. Listeners plug in behind an interface the warehouse never has to know the shape of."
classDiagram
    class InventoryManager {
        -Map~String,Warehouse~ warehouses
        +addStock(warehouseId, productId, qty) void
        +removeStock(warehouseId, productId, qty) boolean
        +transfer(productId, fromId, toId, qty) boolean
        +getWarehousesWithAvailability(productId, qty) List
        +setLowStockAlert(warehouseId, productId, threshold, listener) void
    }
    class Warehouse {
        -String id
        -Map~String,int~ inventory
        -Map~String,List~ alertConfigs
        -ReentrantLock lock
        +addStock(productId, qty) void
        +removeStock(productId, qty) boolean
        +checkAvailability(productId, qty) boolean
        -getAlertsToFire(productId, prevQty, newQty) List
    }
    class AlertConfig {
        -int threshold
        -AlertListener listener
    }
    class AlertListener {
        +onLowStock(warehouseId, productId, currentQty) void
    }
    class EmailAlertListener {
        +onLowStock(warehouseId, productId, currentQty) void
    }
    InventoryManager "1" o-- "*" Warehouse : owns
    Warehouse "1" o-- "*" AlertConfig : holds
    AlertConfig ..> AlertListener : notifies
    EmailAlertListener ..|> AlertListener : implements
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Making a transfer atomic

A transfer is the one operation touching two warehouses, and it is where correctness is easiest to lose. Each version below closes a gap the one above it leaves open:

- **Check, then move.** Ask the source `checkAvailability`, and if it passes, `removeStock` from source and `addStock` to destination. This is a textbook time-of-check-to-time-of-use [race](../hazards/race-condition.md): the source lock is released between the check and the removal, so another thread can drain the stock in that gap. Thread A confirms 50 units are available, Thread B removes them, and Thread A proceeds anyway — the removal quietly fails and A adds phantom units to the destination. It is a correctness bug.
- **Trust the return value.** Skip the separate check and let `removeStock` validate while it holds the source lock, moving on only if it returns true. That closes the check-then-act window. But a gap remains: between the successful removal and the destination's `addStock`, the units belong to neither warehouse, so any thread that sums total inventory in that instant is short — and if the add throws for an unknown destination id, or the process stops before it runs, the stock is simply lost, with no rollback.
- **Lock both, in order (chosen).** Acquire the locks on both warehouses before touching anything, do the remove-and-add while holding both, then release. No other thread can observe the in-between state. Two details make it safe: the warehouse lock must be reentrant, because `transfer` calls the already-synchronised `removeStock`/`addStock` and the thread re-acquires locks it already holds; and the two locks must always be taken in a consistent order — sort by warehouse id — or a pair of opposite-direction transfers can each hold one lock and wait on the other, a classic [deadlock](../hazards/deadlock.md). This is [pessimistic locking](../patterns/distributed/coordination/pessimistic-locking.md): assume the conflict and take both locks up front.

The cost is real — while both locks are held, no other thread can touch either warehouse even for an unrelated product — so a hot warehouse pair under heavy transfers will serialise. The alternative (the "trust the return value" version) is a legitimate choice when brief intermediate states are acceptable and you want the extra concurrency; it just is not truly atomic.

### 2 · Firing an alert once, not on every dip

The tempting rule — fire whenever the new count is below the threshold — floods the channel: with stock at 5 and a threshold of 10, every single removal re-fires, turning a warning into noise. The fix is to compare the two quantities and fire only on a downward crossing: `previousQty >= threshold AND newQty < threshold`. Stock 12→8 fires (crossed); 8→5 does not (already below); 5→15 does not (recovering, and rising anyway); 15→9 fires again. It is self-resetting — no `hasFired` flag to track and reset, because recovering above the threshold naturally re-arms the next drop. The same comparison has to run in `addStock` as well as `removeStock`, since a count can move either way, and the previous-versus-new test correctly stays silent when it crosses upward. The warehouse notifying an external observer only on this state change is the [Observer](../patterns/gof/behavioral/observer.md) pattern, and the listener sits behind an abstraction the warehouse depends on rather than a concrete email or webhook client — [dependency inversion](../principles/dependency-inversion.md) is what keeps delivery swappable.

### 3 · Where the lock goes

Without synchronisation, `addStock` is a read-modify-write race: two threads read 20, one writes 30, the other writes 25, and ten units vanish. The safe default is to make each `Warehouse` guard all of its state behind one lock and run every public method — writes and reads, since an unsynchronised read can see a torn value — under it. That is the [Monitor Object](../patterns/concurrency/monitor-object.md) pattern: the object owns its mutex and admits one thread at a time. A per-product lock would let different products proceed in parallel, but it needs concurrent maps, grows an unbounded lock table, and reintroduces the same lock-ordering problem for transfers; it pays off only under genuinely high cross-product contention, so the coarse per-warehouse lock is the right default and the fine-grained version is for extreme throughput only.

The subtlety is what the lock must not cover. A listener may send an email or POST a webhook — seconds of network I/O — and holding the warehouse lock across that blocks every other operation and can deadlock if the listener waits on another thread that calls back into the warehouse. So the warehouse splits the work: it computes the list of alerts to fire while holding the lock, then releases and fires them. "Decide under the lock, dispatch outside it" is the shape. A transfer holds both locks while it nests `removeStock` and `addStock`, so it collects the alerts from both calls and fires them only after releasing both locks.

```python summary="Pseudocode — capture under the lock, notify after it"
# Warehouse — mutate under the lock, notify only after releasing it
removeStock(productId, qty):
    alerts = null
    lock(this):                        # reentrant, so transfer() can nest add/remove
        have = inventory[productId] or 0
        if have < qty: return false    # no negative inventory — reject before mutating
        newQty = have - qty
        inventory[productId] = newQty
        alerts = getAlertsToFire(productId, have, newQty)   # decide while locked
    for a in (alerts or []):           # fire outside the lock — callbacks may do I/O
        a.listener.onLowStock(id, productId, newQty)
    return true
```

The sequence below shows the lock covering only the mutation, with listeners called after release.

```mermaid caption="Why does a low-stock listener never run while the warehouse lock is held?"
sequenceDiagram
    participant T as Caller thread
    participant W as Warehouse
    participant L as Listener
    T->>W: removeStock(productId, qty)
    W->>W: lock, reject if have < qty
    W->>W: newQty = have - qty, decide alerts to fire
    W->>W: release lock
    W->>L: onLowStock(id, productId, newQty)
    W-->>T: true
```

```mermaid caption="How does a transfer move stock across two warehouses atomically? Take both locks up front in warehouse-id order, do remove-then-add while holding both, and no thread ever observes the in-between state."
sequenceDiagram
    autonumber
    participant C as transfer(src, dst, qty)
    participant S as source warehouse
    participant D as dest warehouse
    C->>C: lock both, in warehouse-id order (avoids deadlock)
    C->>S: removeStock(qty) — reentrant, lock held
    alt source has the stock
        S-->>C: removed
        C->>D: addStock(qty) — reentrant, lock held
        D-->>C: added
        C->>C: release both locks
    else insufficient stock
        S--xC: false, nothing moved
        C->>C: release both locks, reject
    end
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Locking both warehouses in id order makes a transfer truly atomic: no single-warehouse read sees a half-done transfer. A scan across warehouses is not a snapshot.
- One coarse lock per warehouse keeps correctness reasoning trivial, and hold times stay short because the critical section is a map update and listeners run outside it.
- Crossing-based alerts self-reset with no extra state, and deciding under the lock while dispatching outside keeps slow callbacks off the critical section.
- The listener abstraction swaps email, webhook, or log without the warehouse changing at all.

### What it gives up
<!--meta polarity=con-->

- The coarse lock serialises unrelated products in the same warehouse, so a hot warehouse pair bottlenecks under heavy transfer traffic.
- It assumes reentrant locks; without them the two-lock transfer deadlocks, and the alert helper must never be separately synchronised.
- Transfer assumes stock teleports — in-transit inventory during a multi-day shipment isn't modelled until a first-class Transfer holder is added.
- Deducting only on fulfilment invites overselling under a slow checkout; fairness needs a reservation layer on top.

## What's expected at each level
<!--meta block=levels-->

- **Junior** — a working system: an `InventoryManager` coordinating `Warehouse` objects, with `addStock`/`removeStock` updating counts correctly, rejecting anything that would go negative, and handling an unknown warehouse id. Concurrency need not be spotted unprompted; a hint about locks is fine.
- **Mid-level** — clean separation without prompting (the manager orchestrates, the warehouse owns its map and alerts), recognises that concurrent operations need synchronisation and adds basic locking, and uses the `AlertListener` interface to decouple delivery. May validate a transfer but miss the time-of-check race until nudged.
- **Senior** — handles concurrency correctly on their own, catches the TOCTOU bug in the naive transfer and explains why checking a return value alone still leaves a non-atomic gap, locks both warehouses in a consistent order for deadlock-free atomicity, and weighs coarse versus per-product locking. Reaches for the reservation and in-transit-Transfer extensions when there is time.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Race Condition](../hazards/race-condition.md) — the check-then-move transfer and an unlocked addStock are read-modify-write races; the per-warehouse lock closes them
- [Deadlock](../hazards/deadlock.md) — two opposite-direction transfers each hold one warehouse lock and wait on the other unless locks are taken in sorted id order

**Demonstrates**

- [Monitor Object](../patterns/concurrency/monitor-object.md) — each Warehouse guards its quantity map and alert configs behind its own reentrant lock, admitting one thread at a time
- [Observer](../patterns/gof/behavioral/observer.md) — a warehouse notifies registered listeners only when a count crosses down through a threshold, decoupling 'stock is low' from 'what to do about it'
- [Dependency Inversion Principle](../principles/dependency-inversion.md) — Warehouse depends on the AlertListener interface, never on a concrete email or webhook client, so delivery is swappable without touching stock code
- [Pessimistic Locking](../patterns/distributed/coordination/pessimistic-locking.md) — transfer acquires both warehouse locks up front, in sorted id order, and holds them across the move to guarantee atomicity
- [Facade](../patterns/gof/structural/facade.md) — InventoryManager is the single public surface that routes and coordinates over the hidden warehouse map
- [Value Object](../patterns/ddd/value-object.md) — AlertConfig is an immutable pairing of threshold and listener, with duplicate-suppression handled by the crossing check rather than any state on the config
- [Separation of Concerns](../principles/separation-of-concerns.md) — cross-warehouse orchestration lives in the manager while per-location counts, locking, and alerts stay inside each warehouse

<!-- relationships:end -->
