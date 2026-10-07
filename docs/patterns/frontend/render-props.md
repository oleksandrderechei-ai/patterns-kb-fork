---
title: Render Props
description: Inject rendering behavior as a function
area: frontend
owner: Oleksandr Derechei
tags: [ui-architecture, composition, extensibility]
status: stable
aliases: [function-as-child]
solves: [I keep copying the same stateful logic between components that look nothing alike, I want to share behavior without a deep class-inheritance hierarchy, two components need the same mouse-tracking logic but render completely differently, the only way to reuse this logic was a base class and now unrelated views are stuck with it, I want the data-loading in one place but each screen has to draw the result its own way]
---

# Render Props

A component owns some state or behavior and calls a function you hand it to produce the output — inverting control over rendering so one piece of logic can drive many different UIs.

## What it is
<!--meta block=description-->

The same stateful behavior, such as tracking the mouse or fetching data, sometimes has to power components that look nothing alike, and inheriting it from a base class ties unrelated views together. With render props, one component owns the behavior and calls a function you pass as a prop with the current state, leaving the markup to you.

## Explained
<!--meta block=explain-->

A render prop is a function passed to a component as a prop. The component does the work, such as tracking the mouse or loading data, and calls your function with the result so you decide what to draw. The behavior lives in one place, and each caller supplies its own look, so the same logic can drive a list on one screen, a chart on another and a debug readout on a third, with no shared base class. Choose it over copying the behavior into each screen when several views share logic but differ in markup. In new code a hook usually does the same job without nesting, so keep render props for class components or for cases where the behavior must wrap a piece of the tree.

- **Nesting.** Combining several behaviors nests functions inside functions, so move them into hooks.
- **Unclear origin.** Where a value comes from is harder to see, so name the function's parameters clearly.
- **Inline redraws.** An inline function is new each render, so a memoized component redraws. Hoist it, or use useCallback if it reads props.

**Example.** A Fetch component loads a URL and calls your function with the data. One screen draws a list, another a count badge. Adding mouse tracking and window size makes three nested callbacks; as hooks it is three lines in a row. The inline function costs you too. Say a parent updates 10 times a second (an illustrative rate). Each update creates a new function, so a memoized Fetch re-renders 10 times a second instead of only when its own props or state change. If the function needs nothing from the parent, define it outside the parent to keep one reference. If it reads parent state or props, wrap it in useCallback with those values as dependencies.

## How it works
<!--meta block=structure-->

```mermaid caption="The behavior component computes state and passes it to a caller-supplied function, which returns the UI."
flowchart LR
    B["Behavior component<br/>owns & computes state"] -->|"calls render(state)"| F["render function<br/>(supplied by caller)"]
    F -->|"returns UI"| U["Rendered output"]
    B -.->|"state changes"| B
```

## Variations
<!--meta block=variations-->

- **Render prop / function-as-child** — A prop whose value is a function that receives the state and returns markup. When that prop is `children`, the call site reads as nested JSX — the "function as a child" idiom — but it is the same mechanism.
- **Higher-Order Component (HOC)** — Instead of calling a function you pass in, a function wraps your component and injects the behavior as extra props. The logic reuse is the same; the wiring is fixed where the component is defined, and injected prop names can collide.
- **Hooks** — A custom hook extracts the same stateful logic into a plain function call inside the component, with no wrapper component and no nesting.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Reuses stateful logic across unrelated views** — without a class-inheritance hierarchy joining them.
- **Flexible composition** — the same behavior component drives any markup the caller supplies, a list in one screen and a chart in another.
- **Behavior and view stay decoupled** — either can change freely while the state object's shape stays the same; changing that shape breaks callers, so type it.
- **Works on any component model that passes functions** — it needs no compiler support or special syntax, only a function-valued prop.

### Cons
<!--meta polarity=con-->

- **Wrapper hell** — combining several render props nests callbacks until the JSX is hard to read. As a rule of thumb, move the logic into hooks past two levels; each team sets its own limit.
- **Obscured value origins** — a value named in a callback parameter is hard to trace back to the component that produced it. Name the parameters after what they carry.
- **Hooks now supersede it** — they express the same reuse without nesting, so new code rarely needs the pattern. Keep it for class components, or where the behavior must wrap part of the tree.
- **Inline function is a new value on every render** — a shallow prop comparison never matches and memoization on the behavior component stops paying. Hoist the function to a stable reference if it reads nothing from the parent; otherwise wrap it in useCallback. React Compiler, where enabled, memoizes inline callbacks automatically, so the cost applies to code built without it.
- **Client components only** — a plain function cannot be passed as a prop from a Server Component to a Client Component, so the render function and the component that calls it must both run on the client.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Shared stateful behavior, different markup** — mouse position, data fetching or a toggle powers views that render completely differently.
- **Logic must stay independent of markup** — the reused code cannot know what it will draw, and the caller decides at each use site.
- **You maintain class components** — hooks are not available there, and a render prop is the cleanest way to share logic.

### Avoid when
<!--meta polarity=avoid-->

- **A hook expresses the same reuse more simply** — the case for most new code.
- **Several render props would nest more than two levels** — move the shared logic into a custom hook and call it in the component.
- **The render function needs a performance budget** — a memoized behavior component receives an inline function, a new prop on every render, so the memo never skips work.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a Toggle that owns the flag and lets the caller render it"
import { useState, type ReactNode } from "react";

type ToggleProps = {
  // The render prop: Toggle owns the state, the caller owns the markup.
  children: (on: boolean, toggle: () => void) => ReactNode;
};

function Toggle({ children }: ToggleProps) {
  const [on, setOn] = useState(false);
  const toggle = () => setOn((v) => !v);
  return <>{children(on, toggle)}</>; // hand state to the caller's function
}

// One behavior, two completely different views:
function Settings() {
  return (
    <Toggle>
      {(on, toggle) => (
        <button onClick={toggle}>
          Notifications: {on ? "on" : "off"}
        </button>
      )}
    </Toggle>
  );
}

```

## In the wild
<!--meta block=wild-->

- **React** — Render props, function-as-child, and later Hooks all share stateful logic without inheritance. {#wild-react}
- **React Context.Consumer** — The Consumer component takes a function as its child and calls it with the current context value, so the consumer decides what to render while Context owns the value. It is the render-prop form that predates the useContext hook. {#wild-context-consumer}
- **Downshift** — Kent C. Dodds' library for autocomplete, combobox and select inputs. It owns the input, selection and keyboard state and hands them to a render function, so the caller supplies all the markup and styling. Its README now recommends the useSelect and useCombobox hooks over the render-prop component, which does not follow the latest ARIA combobox pattern. {#wild-downshift}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Prop name** — A named prop such as render, or children as a function. A named prop reads clearer when a component takes more than one.
- **What the function receives** — One object of state and callbacks, or separate arguments. One object lets you add fields without breaking callers.
- **Reference stability of the function** — Inline at the call site or hoisted. Hoisting keeps memoization on the behavior component working; use useCallback when the function reads props or state.
- **Nesting depth you allow** — The level of render-prop nesting at which the team moves logic into hooks. Start at two levels, as in the checklist, and raise it only if the team accepts the readability cost.

### Signals to watch
<!--meta polarity=signal-->

- **Re-renders of the behavior component** — Count of renders per parent update in a render profiler. A memoized component that renders with unchanged props points to a changing function reference.
- **Nesting depth in JSX** — Levels of function children in one tree. Past your team's limit (two is a common start), move logic into hooks.
- **Hook-replaceable uses** — Render-prop uses in function components that a hook could replace with no nesting.
- **Wrapper components in the tree** — Number of render-prop wrapper components in the React tree, visible in dev tools. Each is a nesting level counted by signal 2; past your limit on one screen path, move that logic into a hook.

### Failure modes under load
<!--meta polarity=failure-->

- **New function every render** — The inline function breaks shallow comparison, so a memoized behavior component re-renders. Hoist it if it reads nothing from the parent, otherwise wrap it in useCallback.
- **Wrapper hell** — Several render props nest into a pyramid of callbacks that hides where each value came from.
- **Lost typing** — In untyped code the callback parameter has no type and a misuse is not caught until run time. Type the render function.
- **Hidden coupling** — The render function relies on fields in the state object, so a change to those fields breaks callers silently. Share one type for the state object so a change fails the type check.

### Readiness checklist
<!--meta polarity=check-->

- The function's parameter is typed and named for what it carries
- Call sites with a memoized behavior component use a stable function reference
- No render-prop nest goes deeper than two levels
- Function components that can use a hook do so instead

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Frontend Architecture](../../themes/frontend-architecture.md) — Inject rendering behavior as a function {#fluency-frontend-architecture}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Strategy](../gof/behavioral/strategy.md) — The render function is a rendering strategy handed in from outside
- [Decorator](../gof/structural/decorator.md) — Higher-order components wrap and augment, the way a decorator adds behavior

**Alternative to**

- [Container / Presentational](./container-presentational.md) — One component with a render function vs. a container pair
- [Template Method](../gof/behavioral/template-method.md) — Vary the rendering by argument, not by subclassing

<!-- relationships:end -->
