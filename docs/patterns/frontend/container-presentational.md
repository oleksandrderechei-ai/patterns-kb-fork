---
title: Container / Presentational
description: Split the component that fetches from the one that renders
area: frontend
owner: Oleksandr Derechei
tags: [ui-architecture, separation-of-concerns, composition]
status: stable
aliases: [smart-dumb-components]
solves: [my component both fetches data and renders it and is impossible to test, I cannot reuse this view because the data-loading is baked into it, every UI component reaches straight into the store and I cannot swap the data source, I want to render this screen from fake data but the fetch is welded into it, the same list has to show data from two different endpoints and I ended up copying the markup]
---

# Container / Presentational

A container component owns data-fetching and state; a presentational component below it only takes props and renders — so rendering stays pure, reusable, and easy to test.

## What it is
<!--meta block=description-->

A component that both fetches its data and draws it is hard to test and reuse: every test stubs a network call and the markup is welded to one source. This pattern splits it in two. A container gets the data and holds the state; a presentational component receives plain props and only draws them.

## Explained
<!--meta block=explain-->

Split the component that fetches from the one that draws, so the view takes plain props. The container gets the data and holds loading and error state and side effects. The presentational component only receives values as props and draws them, as a pure function of those props apart from small UI state such as open or closed. Because the drawing part knows nothing about where data comes from, you can show it with fake data, test every state without a server, and reuse it over a different source. Choose it over one component that fetches and draws when the same view serves several data sources, or when you want to preview and test its states in isolation. In React, a custom hook that holds the data logic often replaces the container.

- **More files.** One more layer to trace, so split only a view that is reused or hard to test.
- **Nothing gained when trivial.** A component that neither fetches nor holds state stays whole.
- **Line not enforced.** The framework does not hold the split, so add a review rule that presentational files import no fetching or store code.

**Example.** A user profile component fetches /users/42 and draws the result. To test its loading, error and empty states, you must mock the network three times. You split it: UserView takes a user and a status as props, and UserContainer fetches and passes them in. Now the three states are three tests with plain props and no mock, and a design preview can render each one by hand. The cost is two files instead of one and a few lines of wiring between them. A Divider that takes no data would not be worth the split.

## How it works
<!--meta block=structure-->

```mermaid caption="The container fetches from the store or API and passes plain props down to a pure presentational child, which renders them without knowing where they came from."
flowchart LR
    Store[("Store / API")] -->|fetch| Container["Container<br/>(owns data + state)"]
    Container -->|plain props| View["Presentational<br/>(pure render)"]
    View -->|markup| DOM["Rendered UI"]
```

## Variations
<!--meta block=variations-->

- **Hooks-era split** — Instead of a wrapping component, a custom hook holds the "container" logic (the fetch, the state, the effects) and returns plain data. Same boundary, less nesting. The view stays pure only if a thin wrapper calls the hook and passes props; a view that calls the hook itself needs the hook mocked in tests.
- **Route / page-level container** — The container sits at a route or page boundary, loading everything the page needs and distributing props to several presentational children below it. Keeps data-loading at the edges of a feature.
- **Higher-Order-Component container** — A HOC wraps a presentational component and injects the fetched data as props (the classic `connect()` shape). Older style; react-redux is the best-known example (see In the wild).

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Views test with props only** — pass props, assert on output, with no network stubs and no fake timers, as long as the view imports no data client (see Convention, not enforcement).
- **Views reuse with any source** — one presentational component renders live data in the app, fixtures in a catalog and mocks in tests.
- **A clear boundary** — fetching, loading and error state live above, markup lives below, so a reviewer knows where each change goes.
- **Designers can work on views alone** — a component that takes plain props runs in a component catalog without a backend.

### Cons
<!--meta polarity=con-->

- **More files and a layer to trace** — a change to one screen touches two components. Colocate the pair in one folder and name them the same way.
- **Overkill for trivial components** — a label that neither fetches nor holds state gains nothing from a wrapper. Split only when one component mixes both jobs.
- **Convention, not enforcement** — the framework does not stop a presentational component from fetching. Back it with a lint rule or a review checklist item.
- **Prop plumbing grows** — the container passes down everything the view needs, and long prop lists appear. Group related props into one object, or let a hook feed the view directly; a view that calls the hook itself loses props-only testing (see Hooks-era split), so keep a thin wrapper. A memoized view skips a re-render when its props are unchanged, so memoize a grouped object, or the view re-renders on every container render.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A component mixes fetching and rendering** — and it is hard to test because every test has to stub the network.
- **One view, several data sources** — the same UI renders from an API, a cache or mock data.
- **You need stories or snapshots** — rendering the UI from fixed data in a catalog or visual test needs a view that takes plain props.

### Avoid when
<!--meta polarity=avoid-->

- **The component is trivial** — it neither fetches nor holds state; keep it as one component.
- **A hook already colocates the loading logic** — and nothing else needs the view, so a second component adds a file and no reuse.
- **The view is used in exactly one place** — and no test or story needs it apart from its data.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a container fetches, a pure view renders"
interface User { id: string; name: string; email: string; }

// Presentational: a pure function of its props. No fetching, no state.
function UserView({ user }: { user: User }) {
  return (
    <article>
      <h2>{user.name}</h2>
      <p>{user.email}</p>
    </article>
  );
}

// Container: owns the data source, the loading state and the error state.
function UserContainer({ id }: { id: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let ignore = false;   // a slow reply for an old id must not overwrite a newer one
    setUser(null);
    setError(null);
    fetchUser(id)
      .then(u => { if (!ignore) setUser(u); })
      .catch(e => { if (!ignore) setError(e); });
    return () => { ignore = true; };
  }, [id]);

  if (error) return <ErrorView error={error} />;
  if (!user) return <Spinner />;
  return <UserView user={user} />;   // hand plain props to the pure view
}

```

## In the wild
<!--meta block=wild-->

- **react-redux connect()** — connect(mapStateToProps, mapDispatchToProps) wraps a component and generates the container: it subscribes to the store and passes state and action callbacks down as plain props, so the wrapped component stays presentational. {#wild-react-redux-connect}
- **Presentational and Container Components** — Dan Abramov's 2015 article that gave the pattern its common names. He later added a note that he no longer pushes the split, because hooks let one component keep logic and view apart without the extra layer. {#wild-abramov-article}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Where the container sits** — At a route or page boundary, or around each widget. The nearer the route, the fewer and larger the fetches, and the longer the prop lists.
- **Container form** — A wrapping component, a higher-order component, or a custom hook that returns plain data. The hook form removes a nesting level.
- **Prop shape between the two** — A flat list of props, or one grouped object. Grouping shortens signatures, but a changed field no longer shows in the prop list, and a grouped object rebuilt each render defeats memoized views.
- **Who owns loading and error state** — The container shows spinners and errors, or it passes flags and the view decides. Settle it once for the whole app.

### Signals to watch
<!--meta polarity=signal-->

- **Presentational tests without mocks** — Views tested by passing props alone. If a view test needs a network stub, the boundary has leaked. Count view test files that import a network stub or mock; the target is zero.
- **Imports of data clients in view files** — A fetch, store or router import inside a presentational file says it has taken on a container job.
- **Prop count on views** — Count props declared per view and set a team cap. A view over the cap means the container passes down more than one view needs; split the view or group props (see the prop shape knob).
- **Catalog entries** — Presentational components that render in the component catalog with fixed data show the seam works. Count catalog entries that lack fixed data; each is a view still tied to a source.

### Failure modes under load
<!--meta polarity=failure-->

- **Prop drilling through containers** — A container hands props through several layers that never use them. Move the container down to the subtree that needs the data, or use a provider when distant views share it.
- **Container that renders** — Markup creeps into the container and the view loses its reuse. Review for tags in container files.
- **View that fetches** — Someone adds a quick fetch to a view and the next test needs a network stub. A lint rule on imports catches it.
- **Re-render storms** — A container rebuilds a new object or function prop each render, so memoized views re-render every time. Keep prop identity stable by memoizing values and callbacks in the container.

### Readiness checklist
<!--meta polarity=check-->

- No presentational file imports a data client, store or router
- Catalog count of presentational components without fixed props is zero
- Container and view sit in one folder and share a naming rule
- Loading and error states are decided in one place and tested

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Frontend Architecture](../../themes/frontend-architecture.md) — Separate the component that fetches from the one that renders {#fluency-frontend-architecture}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Provider](./provider.md) — Data comes down through a provider; the container reads it and hands plain props to the view
- [MVVM](../architecture/mvvm.md) — The presentational component is the view; the container plays the view-model's data-owning role
- [Flux](./flux.md) — The container is the piece that subscribes to the store
- [Atomic Design](./atomic-design.md) — Presentational components are what the tiers are made of
- [Separation of Concerns](../../principles/separation-of-concerns.md) — Fetching and state live in the container, markup in the view: one reason to change each

**Alternative to**

- [Render Props](./render-props.md) — Split across two components vs. one that takes a function

**Often confused with**

- [MVP](../architecture/mvp.md) — Both pull logic out of the view; this splits by who fetches, MVP by a presenter driving a view interface

<!-- relationships:end -->
