---
title: Frontend Architecture
description: "How a frontend divides responsibility, flows state, and ships"
area: themes-shaping
owner: Oleksandr Derechei
tags: [ui-architecture, state-management, composition]
status: stable
---

# Frontend Architecture

A frontend is not a page — it is a program that renders. As it grows from one component into a system, the same three questions recur: how components divide responsibility, how state and dependencies flow between them, and how the whole thing is composed and shipped. Most of the answers are patterns the rest of this catalog already holds, pointed at the browser.

## The question
<!--meta block=description-->

A UI of a thousand buttons wired to shared state, fed by a dozen endpoints and shipped by several teams fails like any large system: responsibilities blur and builds collide. Reason about three independent axes: what each component owns, how state and dependencies flow, and how the whole UI is composed, from shared building blocks to separately deployed slices. Model-view-controller (MVC), model-view-presenter (MVP) and model-view-view-model (MVVM) set the responsibility split, and the patterns here are finer moves around it.

## Explained
<!--meta block=explain-->

Frontend architecture is the set of choices that keep a large UI changeable as it grows from a button into thousands of parts. Judge your pain on three axes, because a fix for one does not help another. The first is what each component owns. A component that both fetches and draws is hard to test without a network, so split it into a [container](../patterns/frontend/container-presentational.md) that fetches and a view that only draws. The second is how a value travels. Passing it through five components that do not use it is fixed by a [provider](../patterns/frontend/provider.md) that publishes it to a whole subtree. State changed from everywhere is fixed by one store where changes flow one way, as in [flux](../patterns/frontend/flux.md). The third is how the whole is assembled. A shared set of building blocks keeps screens consistent, and [micro-frontends](../patterns/frontend/micro-frontends.md), slices that different teams deploy alone, let each team ship without waiting on another's build, at the price of a shell and agreed contracts. For a small app with one team, local state and props are enough.

- **More files.** Splitting fetching from drawing adds files, so split only components you must test alone.
- **Ceremony.** One-way state flow adds steps to every change, so keep local state local.
- **Duplicate code.** Slices may each bundle their own framework copy, so share one; that ties every slice to one framework version, so upgrades are agreed.
- **Wide re-renders.** A changed provider value re-renders every consumer, so publish only slow-changing values and keep fast-changing state in a store.

**Example.** A team of 5 engineers has a product list that fetches and draws in one file. To test it they need a live server. They split it into a container that fetches and a view that takes data as input, and test the view with fake data in milliseconds. That is 2 files, not 1. A theme colour passes through 5 layers, so they add a provider. Later 4 teams share one 25-minute build and a Thursday release. They split into 4 slices, each shipped alone. The cost is that each slice may bundle its own copy of the framework, so they share one and agree to upgrade it together.

## The tradespace
<!--meta block=tradespace-->

Three axes carry the tension, and the first is **where a component's responsibility stops**. Let a component both fetch and render and it is hard to test without a live server or a mock, and hard to reuse against another data source. Split it into a container that knows where data comes from and a presentational component that only knows how it looks, and you gain pure, testable views at the cost of more files. The same instinct, applied to behavior rather than data, gives you render props (and its successor, hooks): hand a component a function and let it decide what to render, so one piece of stateful logic drives many different UIs.

The second axis is about **flow**, and it has two failure modes. Passing a value down through five components that don't use it (prop-drilling) is answered by a provider that publishes a value to a whole subtree so any descendant reads it directly. This is inversion of control for dependencies, the browser's version of [dependency injection](../patterns/gof/extra/dependency-injection.md), though the consumer looks the value up rather than receiving it. The opposite failure is state that mutates from everywhere and can't be traced: the answer is Flux, a single store where change flows one way (action → reducer → view), which resembles event-sourcing in the client: actions are the events, though only devtools keep them. Underneath both sits the [observer](../patterns/gof/behavioral/observer.md): reactive re-rendering is just automatic notification on state change.

The third axis is **scale of composition**. At the small end, atomic design imposes a shared vocabulary — atoms compose into molecules into organisms — so a design system stays consistent across screens; it is the [composite](../patterns/gof/structural/composite.md) pattern applied to a UI. At the large end, when one giant build becomes a place teams collide, micro-frontends decompose the application itself into independently deployed slices — microservices for the browser — usually paired with a [backend-for-frontend](../patterns/distributed/routing/bff.md) per slice.

```mermaid caption="Three independent axes. Pick the one your pain is on before reaching for a pattern: solving a flow problem with a composition tool is a common way for frontends to over-engineer."
flowchart TD
    Q{"Which question are you answering?"}
    Q -->|"A component owns too much"| R["Responsibility: container/presentational, render-props"]
    Q -->|"A value can't reach where it's needed, cleanly"| F["Flow: provider for dependencies, flux for state"]
    Q -->|"The whole UI won't stay consistent or won't scale"| C["Composition: atomic design, then micro-frontends"]
```

## The patterns, by axis
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [MVC](../patterns/architecture/mvc.md) {#tour-mvc}

State and its rules, rendering, and input handling each get their own home, so a designer reworks the view without touching code that decides money. The view refreshes when the model changes, often by observing it.

### [MVP](../patterns/architecture/mvp.md) {#tour-mvp}

The view does no deciding: it renders what the presenter sets and reports clicks back. A recording fake in place of the view lets you test the whole presenter with no user interface (UI) framework loaded.

### [MVVM](../patterns/architecture/mvvm.md) {#tour-mvvm}

The foundation the rest sits on. A view-model exposes state and commands, and the view binds to it declaratively, so you describe what the user interface (UI) should show rather than imperatively poking the document object model (DOM). Many reactive frameworks are model-view-view-model (MVVM) engines with the binding automated, so most of the finer patterns below are moves made inside this separation.

### [Container / Presentational](../patterns/frontend/container-presentational.md) {#tour-container-presentational}

The first-axis move. A container owns data-fetching and side effects; a presentational component below it takes plain props and renders. The payoff is a pure view you can test and reuse against any data source. In the hooks era the container often becomes a custom hook, but the boundary — where data comes from versus how it looks — is the same.

### [Render Props](../patterns/frontend/render-props.md) {#tour-render-props}

Responsibility split applied to behavior instead of data. A component holds some state — a toggle, mouse position, a subscription — and calls a function you give it to render the result, so one piece of logic drives wildly different user interfaces (UIs). Hooks are the modern form of the same inversion; the idea is [strategy](../patterns/gof/behavioral/strategy.md) for rendering.

### [Provider](../patterns/frontend/provider.md) {#tour-provider}

The dependency half of the flow axis. Instead of threading a value — theme, auth, a service — through every intermediate component as props, a provider publishes it at a subtree root and any descendant consumes it directly. It is dependency injection expressed in a component tree, and the right tool for cross-cutting values that change rarely. A changed value re-renders every consumer, so fast-changing state belongs in a store.

### [Flux](../patterns/frontend/flux.md) {#tour-flux}

The state half of the flow axis. When mutations come from everywhere and no one can trace a re-render, funnel every change through one store: a view dispatches an action, a pure reducer produces new state, the store pushes it back. One direction, so every change is traceable, and replayable when reducers are pure and actions are recorded, like [event-sourcing](../patterns/architecture/event-sourcing.md) in the browser, with devtools that let you scrub history.

### [Observer](../patterns/gof/behavioral/observer.md) {#tour-observer}

The mechanism under all of the above. Reactivity — signals, subscriptions, a component re-rendering when its store slice changes — is the observer pattern: dependents register interest and are notified automatically on change. Flux stores, provider values, and framework reactivity are all observer under the hood.

### [Composite](../patterns/gof/structural/composite.md) {#tour-composite}

The composition axis, at the level of the tree itself. A component and a tree of components present the same interface, so a parent renders its children without caring whether each is a leaf or another whole subtree. This uniformity is what makes a user interface (UI) a tree you can compose without special cases — and the structural basis for atomic design.

### [Atomic Design](../patterns/frontend/atomic-design.md) {#tour-atomic-design}

Composition with a shared vocabulary. Atoms (button, input) compose into molecules (a search bar) into organisms (a header) into templates and pages, so a whole design system is assembled from consistent, reusable building blocks and designers and engineers name the same things the same way. It is composite plus a naming discipline.

### [Micro-Frontends](../patterns/frontend/micro-frontends.md) {#tour-micro-frontends}

Composition at the largest scale. When one build is a bottleneck several teams fight over, decompose the application into independently owned, independently deployed slices that a shell composes at run or build time. It buys team autonomy and incremental migration at the cost of duplicated dependencies and integration complexity — the same trade microservices make on the server.

### [Backend-for-Frontend](../patterns/distributed/routing/bff.md) {#tour-bff}

Where the frontend meets the network. Rather than every client bending one general-purpose application programming interface (API) to its needs, each frontend gets a thin backend that shapes exactly the data it renders. It pairs naturally with micro-frontends — a slice and its backend for frontend (BFF) ship together — and keeps client-specific concerns out of the shared services behind it.

<!-- tour:end -->

## How to decide
<!--meta block=decide-->

Name which axis your pain is on before reaching for a pattern: a common cause of over-engineering is a flow problem solved with a composition tool, or a small app handed a big-app pattern. Rows are grouped by axis, not ordered by simplicity, so check the last row first: if it fits, stop. Otherwise take the row whose symptom matches and reach further only when it stops holding.

| When the symptom is… | Axis | Reach for |
| --- | --- | --- |
| Screen logic buried in the click handlers and untestable without the UI | Responsibility | [MVC](../patterns/architecture/mvc.md) |
| Screen logic lives in the widget class and needs a live window to test | Responsibility | [MVP](../patterns/architecture/mvp.md) |
| Hand-written code keeps the screen in sync with state after every change | Responsibility | [MVVM](../patterns/architecture/mvvm.md) |
| A component both fetches and renders and can't be tested | Responsibility | [Container / Presentational](../patterns/frontend/container-presentational.md) |
| The same stateful logic is copied between unlike components | Responsibility | [Render props](../patterns/frontend/render-props.md) / hooks |
| A value is threaded through layers that don't use it | Flow (dependencies) | [Provider](../patterns/frontend/provider.md) |
| State mutates from everywhere and re-renders are untraceable | Flow (state) | [Flux](../patterns/frontend/flux.md) / a single store |
| UI drifts inconsistent across screens and teams | Composition (small) | [Atomic design](../patterns/frontend/atomic-design.md) |
| One build blocks many teams from shipping independently, such as a shared build queue or a shared release day | Composition (large) | [Micro-frontends](../patterns/frontend/micro-frontends.md) |
| Every client bends one general-purpose API to its needs | Composition (large) | [Backend-for-frontend](../patterns/distributed/routing/bff.md) |
| None of the above — it's a small app, one team | — | Local state and props; don't reach further |

## Related areas
<!--meta block=siblings-->

- [Real-Time Updates](./realtime-updates.md) — The other half of a live frontend: this theme structures the client; that one delivers server changes to it the instant they happen. A Flux store is frequently what a real-time push updates.
- [API Design](./api-design.md) — Where the frontend's data contract is shaped. The backend-for-frontend in this tour is one answer; how that boundary evolves, versions, and stays safely retryable is the API-design question.
- [Performance](./performance.md) — Every choice here has a performance cost — a provider value can re-render a large subtree, micro-frontends duplicate dependencies. Caching, memoization, and load-shaping are the counterweight.
