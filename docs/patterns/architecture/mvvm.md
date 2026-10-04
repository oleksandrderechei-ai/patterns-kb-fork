---
title: MVVM
description: View binds declaratively to a view-model
area: architecture
owner: Oleksandr Derechei
tags: [ui-architecture, testability, state-management, separation-of-concerns]
status: stable
aliases: [model-view-viewmodel, presentation-model, application-model, model-view-binder]
solves: [I write the same read-the-field-then-update-the-label glue over and over, my screen state and my widget code are the same class and I cannot test it, the checkbox and the text box get out of sync and I have to hand-wire both directions, I want the same screen logic on desktop and mobile without duplicating it, enabling and disabling this button correctly takes twenty scattered lines]
---

# MVVM

The view binds declaratively to a view-model's observable properties and commands, so the UI updates itself as state changes instead of code pushing values into widgets by hand.

## What it is
<!--meta block=description-->

UI logic buried in a window or form class can only be tested by building a real widget tree, and code keeps pushing values into widgets by hand. MVVM moves it into a view-model, a plain object that exposes values as watchable properties and actions as commands. The view is a thin template bound to them, and the framework's binding engine, not hand-written setters, carries changes both ways. A test creates the view-model and checks its properties.

## Explained
<!--meta block=explain-->

MVVM puts a screen's logic in a view-model, a plain object that exposes the values the screen shows as watchable properties and the actions it offers as commands. Martin Fowler wrote up the same design as Presentation Model. The view is a thin template tied to those properties, and the framework carries changes between view and view-model, so with two-way binding typed text lands in a property with no listener of your own. XAML, Angular and SwiftUI each supply that machinery. Because the view-model knows nothing about any window, a test creates it, sets values and checks properties with no UI running. Choose it over [MVP](mvp.md) (model-view-presenter) when your framework has a binding engine, one-way or two-way. Without one you would write the wiring by hand, and that is MVP with extra steps.

- **Bindings fail quietly.** A misspelled property name throws nothing, so turn on binding error logging.
- **The view-model grows huge.** Logic that belongs in the model or a service creeps in, so move rules out as they appear.

**Example.** A signup form has two fields. The view-model has email, password and canSubmit, which is true when the email contains an @ and the password has at least 8 characters. A test sets password to 1234567, 7 characters, and checks canSubmit is false. It sets 12345678, and checks it is true. No window opens. In the view, the button binds to a property misspelled as canSubmitt. Nothing fails: the button stays disabled. The team turns on the framework's binding error log and adds a test that opens the real form. The headless test covers logic only, so each screen still needs one real-form test for its binding paths.

## How it works
<!--meta block=structure-->

```mermaid caption="Who calls whom? No arrow the view-model wrote points at the view — steps 3 and 7 are announcements, and the binding engine is what turns them into a redraw."
flowchart LR
    User["User"]
    subgraph Bound["Kept in step by the binding engine"]
        View["Login template"]
        VM["LoginViewModel: username, canSubmit, submit"]
    end
    Auth[("Auth service")]
    User -->|"1 types a name"| View
    View -->|"2 binding writes username"| VM
    VM -->|"3 canSubmit changed"| View
    User -->|"4 taps Sign in"| View
    View -->|"5 invokes the submit command"| VM
    VM -->|"6 login(username)"| Auth
    VM -->|"7 isBusy changed"| View
```

```mermaid caption="Where does the model sit? The view-model reads and writes it and republishes what changed as bindable state, while the model raises its own domain events and knows about neither layer above it."
flowchart LR
    V["View, declarative bindings"] -->|user input, commands| VM["ViewModel, observable state"]
    VM -->|property change notifications| V
    VM -->|reads and writes| M["Model, domain data"]
    M -->|domain events| VM
```

## Variations
<!--meta block=variations-->

- **Reactive / stream-based binding** — The view-model exposes observables (RxJS, Combine, LiveData) instead of plain change events, so a view can compose, filter, or debounce state before rendering it.
- **Commanding** — User actions bind to command objects exposing `execute` and `canExecute`, so a button's enabled state and its behavior both come straight from the view-model.
- **MVVM-C (Coordinator)** — Navigation and screen-transition logic is pulled out of the view-model into a separate coordinator, since routing tangles awkwardly with a single screen's state.
- **Headless view-model** — The view-model is built and unit-tested with no UI framework loaded at all, and only wired to a real view in integration or UI-level tests.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Presentation logic lives in plain objects**, unit-testable with no UI framework running.
- **Declarative bindings remove the manual "read a value**, push it into a widget" glue code.
- **View and view-model can be built in parallel** — designers iterate on markup while logic is written and tested separately.
- **The same view-model can back multiple views** that bind to the same shape, e.g. desktop and mobile.

### Cons
<!--meta polarity=con-->

- **Depends on a real binding engine**; without one, MVVM is just MVP (model-view-presenter) with extra indirection.
- **Harder to debug**: a property change in the view-model can be several binding hops from the widget that visibly updates.
- **"Massive View Model" reappears** when logic that belongs in the model or a service creeps into the view-model instead.
- **Binding errors and type mismatches are swallowed** instead of thrown, in engines that resolve binding paths at runtime.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The UI framework has first-class two-way data binding** — WPF, Angular, Knockout, SwiftUI, Android Data Binding.
- **You want presentation logic that's unit-testable** without booting a UI runtime.
- **Several views** — desktop, mobile, web — need to share the same interaction logic against one view-model shape.

### Avoid when
<!--meta polarity=avoid-->

- **The framework has no real binding layer** — wiring it by hand is [MVP](./mvp.md) with extra steps, so pick MVP.
- **The screen is simple enough** that binding infrastructure costs more than a direct, imperative update.
- **Navigation and cross-screen state dominate the design** — layer a coordinator or router in front instead of overloading the view-model.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a login view-model with state and a command"
class LoginViewModel {
  private _username = "";
  private _isBusy = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly auth: { login(u: string): Promise<void> }) {}

  get username(): string { return this._username; }
  set username(value: string) {
    this._username = value;
    this.notify();
  }

  get canSubmit(): boolean {
    return this._username.length > 0 && !this._isBusy;
  }

  // Bound to the view's submit button as a command.
  submit = async (): Promise<void> => {
    if (!this.canSubmit) return;
    this._isBusy = true;
    this.notify();
    try {
      await this.auth.login(this._username);
    } finally {
      this._isBusy = false;
      this.notify();
    }
  };

  // Returns an unsubscribe function; the view calls it on teardown.
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify() { for (const fn of this.listeners) fn(); }
}
```

## In the wild
<!--meta block=wild-->

- **WPF / XAML** — John Gossman at Microsoft described MVVM for WPF in 2005. The XAML binding engine binds one- or two-way to view-model properties raising INotifyPropertyChanged, and ICommand carries the action a control invokes. {#wild-wpf}
- **Knockout.js** — Knockout is built on ko.observable and ko.computed properties whose reads are tracked automatically, so a data-bind attribute re-renders only when a dependency it actually read changes. {#wild-knockout}
- **Android Jetpack ViewModel** — The Jetpack ViewModel survives configuration changes such as rotation, and exposes LiveData or StateFlow that layouts observe through Data Binding or that Compose collects with collectAsStateWithLifecycle. {#wild-android-jetpack}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Notification coalescing / debounce** — How often a rapidly changing property fires change notifications before they reach bindings. Debouncing high-frequency input such as typing or scrolling collapses many updates into one render, but delays dependent state such as canSubmit by the interval, so pick the delay per field.
- **Binding direction** — Whether a property binds one-way (view-model to view) or two-way. Two-way adds write-back cost and can open update feedback loops, so restrict it to fields the user actually edits.

### Signals to watch
<!--meta polarity=signal-->

- **Retained view-models after navigation** — Count of view-model instances still on the heap after their view is gone, read from a heap snapshot. Steady growth across navigation points to an undisposed subscription.
- **Change-notification / re-render rate** — How often bindings fire and the view re-renders; a storm shows up as UI-thread busy time and dropped frames during interaction.

### Failure modes under load
<!--meta polarity=failure-->

- **Subscription leak** — A view or binding subscribes to a view-model observable and is never disposed, retaining the view-model and its object graph. Memory climbs each time the screen is opened.
- **Notification storm** — A property that notifies on every keystroke, fanned out across many bindings, saturates the UI thread and drops frames.
- **Silent binding failure** — A mistyped binding path or a type mismatch fails without throwing, so a field simply never updates and the bug surfaces only visually.

### Readiness checklist
<!--meta polarity=check-->

- Every subscription or binding has a disposal tied to the view lifecycle.
- High-frequency inputs are debounced or throttled before they reach bindings.
- The view-model holds no reference to any concrete view.
- Binding failures are logged or traced, not swallowed.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Frontend Architecture](../../themes/frontend-architecture.md) — Bind the view declaratively to a view-model {#fluency-frontend-architecture}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Container / Presentational](../frontend/container-presentational.md) — Container/presentational is one way to structure the view and its backing logic

**Variant of**

- [MVC](./mvc.md) — Model-view-view-model (MVVM) binds the view to a view-model

**Often confused with**

- [MVP](./mvp.md) — Both pull logic out of the view; MVVM relies on a binding engine, MVP on the presenter calling a view interface; without bindings MVVM degrades to MVP

<!-- relationships:end -->
