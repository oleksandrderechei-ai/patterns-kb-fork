---
title: MVP
description: A presenter mediates between passive view and model
area: architecture
owner: Oleksandr Derechei
tags: [ui-architecture, testability, separation-of-concerns]
status: stable
aliases: [model-view-presenter, passive-view]
solves: [I cannot test my screen logic without launching an emulator, every test needs a real window and takes forty seconds, "my activity class knows about the network, the database, and the pixels", we are porting the app to a new UI toolkit and all the logic has to be rewritten, the widget subclass is where all my business decisions ended up]
---

# MVP

A presenter sits between a passive view and the model, pulling data out, pushing formatted results back through explicit calls, and leaving the view with no logic of its own to test.

## What it is
<!--meta block=description-->

Logic inside a widget class can only be checked by running the app, because a live view is slow or impossible to start in a test. MVP puts every display decision in a presenter that sits between model and view. The presenter pushes results through a plain interface of setters, and the view only draws and reports clicks. A test swaps in a fake view.

## Explained
<!--meta block=explain-->

MVP splits a screen into a model that holds data, a view that only draws and forwards each click to the presenter it is given, and a presenter that decides everything the screen shows. The presenter talks to the view through a plain interface of calls such as showError and setLoading, so in its strict form the view holds nothing to read back and the presenter owns the screen state. A test can swap in a fake view that records those calls, so you can check every display decision without starting any UI toolkit. It is usually traced to Taligent in the 1990s. Choose it over model-view-controller ([MVC](mvc.md)) when your toolkit is slow or awkward to start in tests, or when you may swap the view technology and keep the logic. If your platform has good two-way binding, which updates the screen from your data by itself, [MVVM](mvvm.md) removes most of this wiring.

- **One setter per field.** Group fields into one state object and give the view a single render call.
- **Catch-all presenter.** Split a complex screen's presenter by area, and keep the wiring in one place so calls are not missed.
- **Full redraw.** A single render call makes the view redraw everything on each call.

**Example.** A login screen has an email and a password field. A test builds the presenter with a fake view and presses submit with an empty password. It asserts that the fake recorded one call, showError with the text Password required, and no network call. It runs on a plain test runner with no window. The real screen has 12 fields, which would need 12 setters on the interface. The team instead defines one render call that takes a state object holding all 12 values. The cost is that the view redraws everything on each call.

## How it works
<!--meta block=structure-->

```mermaid caption="Which arrow carries a decision? None that leaves the view — step 2 is a raw event, and every change on screen arrives at 5 or 6 as a call the presenter chose to make."
flowchart LR
    User["User"]
    subgraph Passive["Passive view: decides nothing"]
        View["Todo screen"]
    end
    P["Presenter, holds the screen state"]
    M[("Todo store")]
    User -->|"1 taps Add"| View
    View -->|"2 onAddClicked(text)"| P
    P -->|"3 add(text)"| M
    M -->|"4 current items"| P
    P -->|"5 setItems(items)"| View
    P -->|"6 setError(reason) if it failed"| View
    View -->|"7 draws what it was told"| User
```

```mermaid caption="How does a view event reach the model and come back — success through a setter, failure through showError — with the view never touching the model directly?"
sequenceDiagram
    autonumber
    participant V as View
    participant P as Presenter
    participant M as Model
    V->>P: onSubmit(input)
    P->>M: save(input)
    alt save succeeds
        M-->>P: result
        P->>V: setStatus(message)
    else save fails
        M--xP: error
        P->>V: showError(reason)
    end
```

## Variations
<!--meta block=variations-->

- **Passive View** — The strict form: the view holds zero logic, not even simple formatting or visibility rules — every display decision is pushed into the presenter and invoked explicitly.
- **Supervising Controller** — A looser form: the view binds directly to the model for simple, low-risk display, and the presenter only steps in for the non-trivial behavior.
- **Interface-first view** — The presenter is written against a view interface, never a concrete class, so tests substitute a fake that records calls instead of booting a real UI toolkit.
- **Presenter-per-view vs. shared presenter** — Usually one presenter backs one screen, but a single presenter can coordinate several views across a multi-step flow like a wizard.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Presenter logic is unit-testable** without a real UI toolkit by swapping in a fake view, as long as no display logic stays in the view.
- **The view stays framework-thin**, so swapping the UI layer means writing a new view against the same interface.
- **Clear roles for each part** — [separation of concerns](../../principles/separation-of-concerns.md) stays clean: the view renders, the presenter decides, the model holds data, provided the presenter is split by screen area.
- **Well suited to toolkits** where the view layer is awkward or slow to instantiate directly in tests.

### Cons
<!--meta polarity=con-->

- **Every field the view** can show needs an explicit setter — boilerplate grows with the screen.
- **Passive View pushes even trivial** formatting into the presenter, which can bloat it.
- **Without further decomposition**, a presenter for a complex screen becomes an unstructured catch-all.
- **Purely manual wiring** — no observable binding — so view and presenter can drift if calls are missed.
- **The presenter holds a reference to the view**, so a destroyed or recreated view must be detached; an async result that arrives afterwards hits a dead view or leaks it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **UI toolkit is slow in tests**, or awkward to start there, and you want the screen's logic covered without it.
- **You need to swap the view technology** while keeping the same presentation logic underneath.
- **You want one explicit seam** where every display decision for a screen lives and can be unit tested.

### Avoid when
<!--meta polarity=avoid-->

- **Platform already binds data both ways** — it gives you solid two-way data binding, and [MVVM](./mvvm.md) removes most of the setter boilerplate MVP requires.
- **The screen is a couple of static fields**; a full presenter and view-interface split is pure ceremony.
- **The codebase is already fluent** in [MVC](./mvc.md) and letting the view bind to the model directly is an acceptable trade there.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a presenter over a passive view"
interface TodoView {
  setItems(items: string[]): void;
  setError(message: string | null): void;
}

class TodoPresenter {
  private view: TodoView | null;

  constructor(view: TodoView, private readonly model: { load(): Promise<string[]>; add(t: string): Promise<void> }) {
    this.view = view;
  }

  detach(): void { this.view = null; }   // on teardown; late results are dropped

  async onLoad(): Promise<void> {
    try {
      const items = await this.model.load();
      this.view?.setItems(items);
    } catch {
      this.view?.setError("couldn't load todos");
    }
  }

  async onAddClicked(text: string): Promise<void> {
    if (!text.trim()) return;           // decision lives here, not the view
    try {
      await this.model.add(text);
      const items = await this.model.load();
      this.view?.setError(null);
      this.view?.setItems(items);
    } catch {
      this.view?.setError("couldn't add todo");
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **Google Web Toolkit** — Google published MVP as the recommended GWT architecture: presenters talk to the view only through a Display interface and communicate over an EventBus, so presenter logic runs in plain Java virtual machine (JVM) tests without the browser, where instantiating real widgets was prohibitively slow. {#wild-gwt}
- **Android Architecture Blueprints** — The Android Architecture Blueprints repo shipped a todo-mvp sample: each screen defines a Contract with View and Presenter interfaces, the Fragment implements the passive view, and the presenter is unit-tested against a mocked view. {#wild-android-blueprints}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Passive view or supervising controller** — How much the view keeps. A passive view holds no logic and tests fully through the presenter; a supervising controller lets the view bind simple data and cuts presenter code.
- **View interface granularity** — Coarse intent methods such as `showError` against one method per widget. Per-widget interfaces turn the presenter into a script of widget calls.
- **Presenter lifetime** — One presenter per view instance, or one that outlives it and re-attaches. A longer life needs explicit attach and detach.

### Signals to watch
<!--meta polarity=signal-->

- **Presenter tests that need no UI toolkit** — They should run on a plain test runner with a fake view. Needing a device or emulator usually means logic stayed in the view or toolkit types leaked into the interface.
- **Methods on the view interface** — Steady growth shows the interface mirrors the widgets instead of intent.
- **Logic lines in view classes** — Conditionals in the view that the presenter tests cannot reach.

### Failure modes under load
<!--meta polarity=failure-->

- **Presenter outlives its view** — A presenter holds a reference to a destroyed screen. You see leaks or crashes when an async result arrives after the view is gone.
- **God presenter** — One presenter owns every screen state and every call. You see a file nobody can test in parts.
- **Logic creeps back into the view** — Under deadline the view gets the quick conditional, and the presenter test no longer covers the behaviour.

### Readiness checklist
<!--meta polarity=check-->

- Presenter tests run with a fake view and no UI toolkit
- The view interface exposes no toolkit types
- The presenter detaches from the view on teardown and drops pending callbacks
- Every view event has a presenter test

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Frontend Architecture](../../themes/frontend-architecture.md) — Move screen decisions into a presenter you can test with a fake view. {#fluency-frontend-architecture}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Test Spy](../testing/test-spy.md) — A recording stand-in for the view proves the presenter without a user interface (UI)
- [Separation of Concerns](../../principles/separation-of-concerns.md) — The view renders, the presenter decides and the model holds data, one reason to change each

**Variant of**

- [MVC](./mvc.md) — Model-view-presenter (MVP) swaps the controller for a presenter over a passive view

**Often confused with**

- [MVVM](./mvvm.md) — Presenter drives the view vs. view binds to a view-model

<!-- relationships:end -->
