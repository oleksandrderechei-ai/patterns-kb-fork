---
title: Flux
description: Route all state changes through one unidirectional loop
area: frontend
owner: Oleksandr Derechei
tags: [ui-architecture, state-management]
status: stable
aliases: [redux]
solves: [state changes come from everywhere and I cannot trace who caused this re-render, two parts of the UI hold copies of the same data and they drift out of sync, I need undo and to replay what the user did to reproduce a bug, the same field gets edited from four screens and I cannot tell which one wrote last, this only breaks after a particular sequence of clicks and I cannot reproduce it]
---

# Flux

Application state lives in a store and changes only by dispatching an action through a reducer, so data flows one way — action to store to view — and every change is traceable.

## What it is
<!--meta block=description-->

When any component can change shared state, a wrong value on screen has no single cause: you cannot say who wrote it or why two panels disagree. Flux sends every change through one named event, an action, that a reducer applies to produce the next state, so what you see is the result of the events that arrived before it.

## Explained
<!--meta block=explain-->

Flux sends every state change around one loop in one direction. A view describes what happened as an action, a plain record such as "add item 7". A store applies it with one function, the reducer, which takes the old state and the action and returns the new state. The views then redraw from that state. A component cannot repair state where it noticed the problem; it can only describe what happened and wait for the next state. So a session becomes an ordered list of named changes you can log, replay or step back through, much like [event sourcing](../architecture/event-sourcing.md) on the client. Choose it over components setting shared state directly when many distant components read and write the same state and you cannot tell what changed it.

- **Ceremony.** Actions and reducers add files for what a setter did, so use a helper library that generates them.
- **Longer trail.** Following a click takes several hops, so log every action and use a tool that replays them.
- **Over-sharing.** Putting everything in the store couples unrelated parts, so keep state one component owns, such as an open dropdown, in that component.

**Example.** A shop shows the cart count in the header, on the cart page and on the checkout button. Each component sets the count itself, and one day the header shows 3 while the page shows 2. With the loop, every change is an action such as ADD_ITEM 7, and all three components read the same state. The log shows 5 actions, and replaying the first 4 reproduces the bug at the step that caused it. The cost is that adding one item now touches an action, a reducer and a selector where a single setter used to be.

## How it works
<!--meta block=structure-->

```mermaid caption="State flows one way: the view dispatches an action, a reducer produces the next state in the store, and the store pushes it back to the view — a loop with no reverse edges."
flowchart LR
    V["View"] -->|dispatch action| R["Reducer"]
    R -->|new state| S["Store"]
    S -->|render| V
```

## Variations
<!--meta block=variations-->

- **Classic Flux** — The original Facebook design: a single dispatcher fans actions out to multiple independent stores, each owning one slice of domain state. Reach for the multi-store shape when different slices have genuinely separate lifecycles and you want the dispatcher to coordinate cross-store updates.
- **Redux** — Collapses the many stores into one, and requires reducers to be pure functions of `(state, action)`. This makes the whole history a fold over an action log — essentially client-side event-sourcing — which is what enables time-travel debugging and trivial replay. The default choice when you want one auditable source of truth.
- **Redux Toolkit** — Redux's own maintainers ship the answer to the boilerplate complaint: `createSlice` generates the action creators and the reducer from a single declaration, `configureStore` assembles the store and its middleware, and an immutable update is written as though it mutated. It is presented as the standard way to write Redux rather than an optional extra, so hand-written action constants and switch statements now read as legacy code. What you give up is visibility — the actions and reducers you debug are generated, so the action log names things you never typed.
- **Lighter stores** — Libraries like Zustand, Vuex, and Pinia keep the unidirectional discipline but shed most of the ceremony — no separate action creators or dispatch strings, just typed update functions. Pick these when you want the traceability without the boilerplate, and can accept a looser contract than pure reducers.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **State transitions are predictable and traceable** — every change is a named action passing through one place.
- **Time-travel debugging**: because state is rebuilt from an action log, you can step back and forth through history.
- **No divergent copies** — a [single source of truth](../../principles/dry.md) means two parts of the UI cannot silently hold divergent copies of the same data.
- **Pure reducers are trivial to unit-test** — same input, same output, no mocking.

### Cons
<!--meta polarity=con-->

- **Boilerplate** — actions, reducers, and wiring add ceremony for what a direct setter would do.
- **Indirection**: following a click to its effect means tracing through action and reducer instead of reading one function.
- **Easy to over-centralize**. Local UI state a component could own gets hoisted into the global store, coupling unrelated parts.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **State is shared across many components** and mutated from many places.
- **You need traceability**, undo/redo, or the ability to replay what the user did.
- **You want devtools that show every state transition** as a discrete event.

### Avoid when
<!--meta polarity=avoid-->

- **The state is purely local to one component** — a `useState` or field is enough.
- **The app is small** and a shared provider or lifted local state already covers it.
- **The overhead of actions and reducers** would dwarf the coordination they buy you.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a tiny reducer + dispatch loop for a counter store"
type State = { count: number };
type Action = { type: "increment" } | { type: "add"; by: number } | { type: "reset" };

// Pure: same (state, action) always yields the same next state.
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "increment": return { count: state.count + 1 };
    case "add":       return { count: state.count + action.by };
    case "reset":     return { count: 0 };
  }
}

function createStore(reducer: (s: State, a: Action) => State, initial: State) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action: Action) {
      state = reducer(state, action); // the only place state changes
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
  };
}

const store = createStore(reducer, { count: 0 });
store.subscribe(() => console.log("count:", store.getState().count)); // the view
store.dispatch({ type: "increment" }); // count: 1
store.dispatch({ type: "add", by: 5 }); // count: 6

```

## In the wild
<!--meta block=wild-->

- **Redux** — A single store, pure reducers, and dispatched actions — the canonical unidirectional store. {#wild-redux}
- **Vuex** — Vue's flux-style store with state, mutations, and actions. {#wild-vuex}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Store granularity** — One store for the app or several by domain. One store gives a single log of changes and a bigger state tree to reason about.
- **State shape** — Nested objects or normalized entities keyed by id. Normalized state makes updates cheap and lookups explicit.
- **Where side effects live** — In action creators, middleware or a separate effects layer. Reducers stay pure only if effects live elsewhere.
- **Selector granularity** — What a component subscribes to. A narrow selector re-renders on fewer changes.

### Signals to watch
<!--meta polarity=signal-->

- **Renders per action** — How many components re-render for one dispatched action, shown by a render profiler. A large count says subscriptions are too broad.
- **Action volume** — Dispatches per second during interaction. A flood from one source, such as mouse move, shows an action that should be local state.
- **Reducer duration** — Time spent in reducers per action. Slow reducers block every update.
- **State tree size** — Size of the serialized state, since it is what you log, persist and diff.

### Failure modes under load
<!--meta polarity=failure-->

- **Boilerplate sprawl** — Every small change needs an action type, a creator and a reducer case, and the team starts to skip the pattern. Use helpers that generate them.
- **Mutation in reducers** — A reducer edits state in place, so subscribers see no change and the view goes stale. Freeze state in development.
- **Everything in the store** — Form fields and hover flags go in the store and every keystroke dispatches. Keep ephemeral state local.
- **Action ordering bugs** — Two actions dispatched from one handler or from effects arrive in an order nobody planned, and the state depends on it.

### Readiness checklist
<!--meta polarity=check-->

- Reducers are pure and covered by tests that feed them fixed actions
- State is never mutated, and development builds check it
- Only state shared across screens lives in the store
- Selectors are memoized where they compute data from a large slice

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Frontend Architecture](../../themes/frontend-architecture.md) — Route all state changes through one unidirectional loop {#fluency-frontend-architecture}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Observer](../gof/behavioral/observer.md) — The store notifies subscribed views on change — observer under the hood
- [Command](../gof/behavioral/command.md) — A dispatched action is a reified command describing an intended state change
- [Event Sourcing](../architecture/event-sourcing.md) — State is rebuilt by replaying a stream of actions — event-sourcing in the client
- [Lens / Optics](../functional/lens-optics.md) — A composable accessor for deep updates in a reducer
- [Container / Presentational](./container-presentational.md) — Only containers read the store; views stay pure props

**Alternative to**

- [Provider](./provider.md) — A store with selectors suits fast-changing state; a provider suits values that change rarely

<!-- relationships:end -->
