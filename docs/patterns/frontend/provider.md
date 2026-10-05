---
title: Provider
description: Push shared dependencies down the tree without prop-drilling
area: frontend
owner: Oleksandr Derechei
tags: [ui-architecture, decoupling, state-management]
status: stable
aliases: [context-provider]
solves: [I am passing the same prop through five layers of components that do not use it, every component needs the current theme and I am threading it everywhere, I want to swap the auth service in tests without rewiring the whole tree, adding one field to a deeply nested component means editing six files that only forward it, something buried deep in the tree needs the logged-in user and there is no clean way to get it there]
---

# Provider

A provider holds a value — a service, theme, store, or config — and makes it available to any descendant that asks for it, instead of threading it through every intermediate component as props.

## What it is
<!--meta block=description-->

A value needed deep in a component tree must be passed as a prop through every level in between, even those that only forward it. A provider holds the value, such as a theme or the signed-in user, near the root of a subtree, and any descendant reads it directly. The levels between never know it exists.

## Explained
<!--meta block=explain-->

A provider is a component that holds a value, such as a theme, the signed-in user or a setting, and makes it available to every component below it without passing it through each level in between. A component reads the value from the nearest provider above it. The layers in between do not see it, and the provider is the one place to swap the implementation, for a different theme, a stubbed service in tests or a per-request config. Choose it over passing props when many components at different depths need the same value and it changes rarely, because the alternative is editing every component on the path to hand it down.

- **Hidden dependency.** A signature never says a component needs the value, so read it through one named hook that errors when no provider exists.
- **Wide re-renders.** Every consumer re-renders when the value changes, so keep its reference stable, keep fast-changing values such as mouse position out and split providers.
- **Test wrapper.** Tests need the provider around the component, so write one helper that wraps with defaults.

**Example.** A theme is read by 40 components, up to 6 levels deep. Passing it as a prop edits every component on those paths. One provider at the root removes those edits. Someone then puts the mouse position, which changes 60 times a second, into the same provider. All 40 consumers re-render on each change, 40 x 60 = 2,400 re-renders a second, to read a theme that never changed. Moving it into its own provider, used by 2 components, cuts that to 2 x 60 = 120. Those 2 still re-render 60 times a second, so a per-frame value belongs in a store with selectors. The split costs a second provider and a second wrapper in tests.

## How it works
<!--meta block=structure-->

```mermaid caption="A Provider wraps a subtree and a deep Consumer reads the value directly, skipping the intermediate components that would otherwise have to forward it as props."
flowchart TB
    Provider["Provider (holds the value)"] -->|"renders"| Middle1["Intermediate (ignorant)"]
    Middle1 -->|"renders"| Middle2["Intermediate (ignorant)"]
    Middle2 -->|"renders"| Consumer["Consumer (reads the value)"]
    Provider -.->|"value, no props drilled"| Consumer
```

## Variations
<!--meta block=variations-->

- **React Context** — A `Provider` supplies a value and `useContext` reads it from any descendant. The canonical implementation of the pattern in React.
- **Angular hierarchical dependency injection (DI)** — [Dependency injection](../gof/extra/dependency-injection.md) resolves a token from the nearest provider up the component tree. Providers declared at a component scope override those higher up, so the same token can mean different things in different subtrees.
- **Vue provide / inject** — An ancestor calls `provide` to expose a value and any descendant calls `inject` to consume it, bypassing the intermediate components.
- **Svelte setContext / getContext** — A component calls `setContext` with a key during initialisation and any descendant calls `getContext` with the same key. The lookup is by key, not by type, so a shared constant or symbol for the key keeps two providers from colliding.
- **Stacked providers** — Several providers nest at the root, one per concern: theme, auth, locale. Each carries one value, so a change to one re-renders only its own consumers, provided each value keeps a stable reference between renders. The cost is a deep tree at the app entry. A small composing helper can flatten it.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No prop-drilling** — intermediate components stay ignorant of the value and keep a small prop surface.
- **One swap point** — a test replaces the real service with a stub at the provider, and no consumer changes.
- **Fits cross-cutting values** — theme, auth, locale and per-request config are read by many components at many depths, which is the case it was made for.
- **Scoped overrides** — nesting a second provider changes the value for one subtree only, so a dark panel can sit inside a light page.

### Cons
<!--meta polarity=con-->

- **Implicit dependency** — nothing in a component's signature says it needs the value. Wrap the read in a named hook that throws a clear error when no provider is above it.
- **Re-render fan-out** — a changed provider value can re-render every consumer below it. Split frequently changing values from stable ones into separate providers, and keep the value reference stable between renders.
- **Test setup cost** — a consumer needs its provider to render, so every test wraps it. Ship a shared test wrapper with sensible defaults.
- **Hidden global in disguise** — a provider at the root used for everything becomes a global store with worse tooling. Keep each provider small and named for one concern.
- **Tree-bound reach** — code outside the subtree cannot read the value, and stacked providers that depend on each other must nest with the dependent below what it needs.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Many components at varying depths need one value** — passing it as a prop would run through layers that only forward it.
- **Cross-cutting concern to distribute** — theme, auth, locale or feature flags that most of the tree reads.
- **You want one seam to swap an implementation** — a stubbed service in tests, or a different backend per environment.

### Avoid when
<!--meta polarity=avoid-->

- **One nearby child uses the value** — pass a prop; the call site stays honest about what it needs.
- **The value changes on every keystroke or frame** — it would re-render a large subtree on every change. Use a store with selector subscriptions instead.
- **The reader cannot tell where the value comes from** — unnamed providers make the code hard to trace. Name each provider for its concern.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a ThemeProvider and a deep useTheme() consumer"
type Theme = "light" | "dark";

// The provider publishes a value at a subtree root.
// No default: a consumer outside a provider must fail, not guess.
const ThemeContext = createContext<Theme | undefined>(undefined);

function ThemeProvider({ value, children }: {
  value: Theme;
  children: ReactNode;
}) {
  // React 19 renders the context object itself
  // (before 19: <ThemeContext.Provider value={value}>).
  return (
    <ThemeContext value={value}>
      {children}
    </ThemeContext>
  );
}

// Any descendant consumes it directly — no props threaded through.
function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === undefined) throw new Error("useTheme outside ThemeProvider");
  return theme;
}

// Deep in the tree, and none of the layers above passed a prop:
function ThemedButton() {
  const theme = useTheme();
  return <button className={theme}>Save</button>;
}

```

## In the wild
<!--meta block=wild-->

- **React Context** — Provider plus useContext supply a value to any descendant without prop-drilling. {#wild-react-context}
- **Angular DI** — Hierarchical injectors resolve a dependency from the nearest provider up the component tree. {#wild-angular-di}
- **Vue provide / inject** — A component calls provide to expose a value and any descendant calls inject to read it, skipping every component in between. Vue also lets the app itself provide a value to every component. {#wild-vue-provide-inject}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Provider granularity** — One provider for a whole concern or one per value. Smaller providers re-render fewer consumers.
- **Placement in the tree** — At the root for the whole app or around one subtree. A lower provider scopes the value and lets a subtree override it.
- **Default value** — What a consumer gets with no provider above: a safe default, or an error. An error finds missing wiring early.
- **Value stability** — Whether the provided object is created once or on every render of the provider's parent. Memoize it or create it outside the render path, and check the effect with a render profiler.

### Signals to watch
<!--meta polarity=signal-->

- **Consumer re-renders per change** — How many components re-render when a provided value changes, shown by a render profiler.
- **Provider count at the root** — A long stack of nested providers at app entry. Check that each carries a distinct concern and rate of change; merge only values that always change together.
- **Tests needing wrappers** — Share of component tests that must wrap their subject in providers. A high share can point to a heavy hidden dependency, unless one shared wrapper makes each test cheap.
- **Missing-provider errors** — Runtime errors where a consumer rendered outside its provider.

### Failure modes under load
<!--meta polarity=failure-->

- **Consumer-wide re-render** — A provider builds a new value object on each render and every consumer re-renders though nothing changed. Memoize the value.
- **Silent default** — A consumer outside the provider reads a default and shows wrong data with no error. Make the hook throw.
- **Provider as global store** — Everything goes into one context and every update touches every consumer. Split by concern and rate of change.
- **Tangled override** — Nested providers override each other and nobody can say which value a component sees. Name the hook for each provider and override only at a deliberate subtree boundary.

### Readiness checklist
<!--meta polarity=check-->

- Provided values are memoized or created outside the render path
- Each provider carries one concern, and a named hook reads it
- The hook throws a clear error when no provider is present
- A shared test wrapper supplies defaults so tests stay short

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Frontend Architecture](../../themes/frontend-architecture.md) — Push shared dependencies down the tree without prop-drilling {#fluency-frontend-architecture}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Container / Presentational](./container-presentational.md) — A container consumes provided values and passes them to presentational children

**Alternative to**

- [Service Locator](../gof/extra/service-locator.md) — A provider is scoped to a subtree and swappable per subtree where a service locator is one global lookup
- [Flux](./flux.md) — Use a provider for rarely changing dependencies; fast-changing shared state belongs in a store

**Variant of**

- [Dependency Injection](../gof/extra/dependency-injection.md) — Dependency injection expressed in a component tree — inject a value at a subtree root

<!-- relationships:end -->
