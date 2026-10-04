---
title: Observer
description: Notifies dependents automatically on state change
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, decoupling, extensibility]
status: stable
aliases: [Dependents, Listener]
solves: [every time something new needs to react to this change I have to edit the class that owns the data, my model calls the view directly and now I cannot test it on its own, three parts of the UI keep showing stale data after an update, adding an analytics hook means touching the core save function again, I want a cache and an audit log to update on change without hardwiring them in]
---

# Observer

When one object's state changes, every dependent that registered interest hears about it automatically — no polling, no manual wiring, just a single notify that fans out.

## What it is
<!--meta block=description-->

A piece of data that many parts care about, such as a view, a logger and a cache, forces its owner to name each of them and be edited for every new one. An observer setup lets the owner keep a list of listeners and broadcast each change, so listeners come and go at run time. You trade traceable calls for loose coupling.

## Explained
<!--meta block=explain-->

An observer setup lets one object, the subject, keep a list of listeners (the observers) and call each of them whenever its state changes, so the subject never needs to know who they are. Listeners subscribe and unsubscribe while the program runs, and a new reaction is a new listener rather than an edit to the subject. Choose it over calling each dependent directly when the set of dependents changes at run time and the subject must not name them. When the same three things always react, direct calls are easier to trace. At system scale the same trade appears as [event-driven design](../../architecture/eda.md): less coupling, harder tracing of cause.

- **No order.** The pattern promises no listener order, and subscribe order is incidental, so never let one listener rely on running before another.
- **Cascades.** A listener may change another subject, so keep chains shallow and log each notification.
- **Lapsed listeners.** One that forgets to unsubscribe leaks memory and keeps running on dead data, so unsubscribe when its owner closes.

**Example.** A price object notifies a chart, a log and a cache when the price changes. A screen opens a new chart each time you visit it and subscribes it, but never unsubscribes. After 100 visits the list holds 103 listeners, each price change redraws 100 charts nobody sees, and their memory is never freed. The fix is to unsubscribe when the screen closes, which returns the list to 3. Separately, if the log listener writes a rounded price back, the price notifies all three again, and a guard that ignores a change to the same value ends the loop after one extra round.

## How it works
<!--meta block=structure-->

```mermaid caption="One state change fans out to every registered observer — the subject either pushes the new state into each or just pings them to pull back what they need."
sequenceDiagram
    autonumber
    participant Sub as Subject
    participant A as Observer A
    participant B as Observer B
    Note over Sub: internal state changes
    Sub->>A: notify()
    Sub->>B: notify()
    alt push model
        Sub->>A: update(newState)
        Sub->>B: update(newState)
    else pull model
        A->>Sub: getState()
        Sub-->>A: current state
        B->>Sub: getState()
        Sub-->>B: current state
    end
```

## Variations
<!--meta block=variations-->

- **Push vs. pull** — The subject either pushes the changed data into `update(payload)`, or just pings observers and lets each pull what it needs via `getState()`. Push is convenient, pull keeps the subject ignorant of what observers want.
- **[Publish-Subscribe](../../messaging/pubsub.md)** — Insert a broker or event channel between subject and observers so neither holds a reference to the other — the same idea stretched across modules or processes.
- **Typed / per-aspect events** — Notify with a topic or property name so observers subscribe to parts of the state and skip changes they don't care about.
- **Weak references / auto-unsubscribe** — Hold observers weakly so one nothing else references can be collected, though it can then stop firing without warning, or return a disposer from `subscribe` so teardown is one call that the owner must still make.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The subject stays loosely coupled** — it knows only an interface, never the concrete objects listening to it.
- **You can add or drop listeners** while the program runs, without changing the subject.
- **A single call fans one change out** to every listener, one after another under synchronous dispatch, so no caller loops over them.
- **Adding a new kind of listener needs no subject edit**, which is the [open/closed principle](../../../principles/open-closed.md).

### Cons
<!--meta polarity=con-->

- **The pattern promises no order among listeners**, and subscribe order is incidental, so no listener can rely on running before another.
- **Updates can cascade** — one notification triggers another — and the chain is hard to follow, so keep chains shallow and guard against re-entry.
- **Listeners that forget to unsubscribe** (lapsed listeners) stay in memory as long as the subject lives and keep firing on state nobody uses, so unsubscribe when the owner closes or return a disposer from `subscribe`.
- **Control flow is indirect and implicit**, so stepping through it in a debugger is harder.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several objects need to react** each time one object's state changes.
- **You want the source to stay independent** of exactly which objects depend on it.
- **Listeners come and go** while the program is running.

### Avoid when
<!--meta polarity=avoid-->

- **There is only one dependent** and it never changes — a direct call is simpler and clearer.
- **You need listeners to run** in a fixed order, or to update all-or-nothing as one transaction.
- **Notifications must travel between separate processes or machines** — use [Publish-Subscribe](../../messaging/pubsub.md) with a message broker instead.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a price feed notifying its subscribers"
type Unsubscribe = () => void;

interface PriceObserver {
  onPrice(symbol: string, price: number): void;
}

class PriceFeed {
  readonly #observers = new Set<PriceObserver>();
  readonly #last = new Map<string, number>();

  subscribe(observer: PriceObserver): Unsubscribe {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer); // caller owns teardown
  }

  publish(symbol: string, price: number): void {
    if (this.#last.get(symbol) === price) return;  // skip unchanged ticks
    this.#last.set(symbol, price);
    // a throw here skips later observers, and a retry of this price is dropped: #last is already set
    for (const observer of this.#observers) observer.onPrice(symbol, price);
  }
}

const feed = new PriceFeed();
const stop = feed.subscribe({
  onPrice: (symbol, price) => console.log(`${symbol} -> ${price}`),
});

feed.publish("ACME", 41.2);
stop(); // unsubscribed: no further callbacks
```

## In the wild
<!--meta block=wild-->

- **DOM addEventListener** — An element keeps a list of listeners per event type and calls each when the event fires. removeEventListener only detaches when handed the exact same function reference; the { once: true } option auto-removes after the first call, and passing an AbortSignal via { signal } lets a single AbortController.abort() tear down many listeners at once. {#wild-dom-events}
- **Node.js EventEmitter** — The on/emit contract underlying streams and servers. A default ceiling of 10 listeners per event raises a MaxListenersExceededWarning to flag likely leaks, raised or lifted with setMaxListeners; once() self-detaches after one call and removeListener detaches explicitly. {#wild-node-eventemitter}
- **RxJS** — Builds the whole library on Observable and Subscriber. subscribe() returns a Subscription whose unsubscribe() tears down the operator chain, Subject multicasts one source to many observers, and operators like takeUntil bound a subscription's lifetime declaratively. {#wild-rxjs}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Max-listeners threshold** — A cap on how many observers one subject holds before it warns; Node's EventEmitter defaults to 10 per event, warns past it, and setMaxListeners raises or removes the ceiling. Treat the cap as a leak tripwire, not a limit to keep bumping.
- **Dispatch mode: sync vs. async** — Whether the subject's broadcast call (notify here, publish in the sketch) fires each observer synchronously inline with the state change, or schedules them on a microtask/queue. Sync keeps ordering and causality tight; async returns control to the subject sooner, but a microtask runs on the same thread, so only a queue drained elsewhere isolates a slow observer.
- **Replay of last value** — Whether the subject retains its current value and hands it to a late subscriber on attach, or only forwards future changes. Replay avoids a cold observer sitting on stale defaults; plain forwarding keeps the subject stateless.
- **Observer-error isolation** — Whether one throwing observer aborts the whole broadcast or is caught so the remaining observers still run. Isolation trades a swallowed exception for the assurance that one throwing listener cannot abort the rest, so route each caught error to a logger rather than drop it; a blocking listener still delays later ones under sync dispatch.

### Signals to watch
<!--meta polarity=signal-->

- **Listener count per subject** — How many observers are attached to each subject. A count that keeps climbing while load is steady is the signature of subscriptions that never detach.
- **Notify fan-out duration** — Wall time spent inside one broadcast cycle. Under synchronous dispatch a single slow observer inflates it, and every later observer waits behind it.
- **Notification nesting depth** — How deep cascading notifications nest when one observer's reaction mutates the subject and re-triggers notify. A depth that grows per event warns of a re-entrant loop.

### Failure modes under load
<!--meta polarity=failure-->

- **Lapsed-listener leak** — Observers that never unsubscribe accumulate on the subject; heap and listener count climb, and observers whose owner has closed keep firing on state they no longer care about. Shows up as a rising max-listeners warning or growing retained memory.
- **Re-entrant cascade** — An observer mutates the subject inside its own update, re-entering notify before the first pass finishes. Unbounded, it recurses until the stack overflows under synchronous dispatch, or keeps the queue busy forever under async; bounded, it still produces surprising duplicate deliveries.
- **Slow or throwing observer stalls the broadcast** — Under synchronous dispatch one blocking observer delays every later one, and one that throws — without isolation — aborts the rest of the list, so downstream observers silently miss the event.

### Readiness checklist
<!--meta polarity=check-->

- Every subscribe has a matching unsubscribe or dispose path, tied to the observer's lifecycle rather than left to chance.
- Bound the listener count and treat the max-listeners warning as a leak signal to investigate, not noise to silence.
- Decide sync vs. async dispatch deliberately, and isolate observer exceptions so one failure cannot halt the broadcast.
- Guard against mutating subject state inside a notification, or the update path can re-enter and cascade.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Frontend Architecture](../../../themes/frontend-architecture.md) — Re-render when observed state changes {#fluency-frontend-architecture}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Flux](../../frontend/flux.md) — A Flux store is an observable; views subscribe and re-render on change
- [MVC](../../architecture/mvc.md) — Classic model-view-controller (MVC) notifies its views through exactly this registration
- [Open/Closed Principle](../../../principles/open-closed.md) — New listeners plug in without editing the subject, which is the open/closed shape.

**Generalizes**

- [Publish-Subscribe](../../messaging/pubsub.md) — Pub/Sub is Observer across process boundaries

**Often confused with**

- [Mediator](./mediator.md) — Broadcast changes vs. centralize interactions
- [Future / Promise](../../concurrency/future-promise.md) — Observers fire on every change; a future has exactly one outcome

**Demonstrated by**

- [Inventory Management](../../../designs/inventory-management.md) — low-stock alerts are subjects-and-observers: the warehouse publishes a state-change event and listeners react without it knowing them

<!-- relationships:end -->
