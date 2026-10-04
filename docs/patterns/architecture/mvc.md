---
title: MVC
description: "Model, view, and controller kept independent"
area: architecture
owner: Oleksandr Derechei
tags: [ui-architecture, separation-of-concerns, state-management]
status: stable
aliases: [model-view-controller]
solves: [my button click handler is 400 lines and also does the math, I cannot write a single test without spinning up the whole UI, the same data has to show up on a web page and in a PDF export, the designer keeps breaking business rules by editing templates, my form validation logic lives inside the rendering code]
---

# MVC

Splits an interactive application into a model that owns state and behavior, a view that renders it, and a controller that turns user input into changes to the model — so each piece changes without dragging the others with it.

## What it is
<!--meta block=description-->

Three unrelated reasons to change, a rule, a layout and an input gesture, land on the same file when a screen is one class. MVC splits the screen in three. The model holds state and the rules for changing it, the view renders it, and the controller turns user input into model updates. When the model changes, the view refreshes, and each part gets its own owner.

## Explained
<!--meta block=explain-->

MVC splits an interactive screen into three parts. The model holds the data and the rules for changing it. The view shows the model on screen and passes raw user input along. The controller reads that input, decides what it means and updates the model, and the view then refreshes. Trygve Reenskaug devised it at Xerox PARC in the late 1970s, and web frameworks later adapted it so each request passes through a controller once. Each part should have one reason to change while the rules stay in the model, so a designer can rework a layout without opening code that decides prices. Choose it over putting everything in one screen class when rules, layout and input handling are already tangled, or when more than one screen must show the same state. For a static page it is three files for nothing.

- **The controller swells.** It is the easiest place to drop logic, so keep rules in the model and display details in the view.
- **A fuzzy view and controller line.** Web frameworks bend the names, so write down what each part may do in your project.

**Example.** A cart gives 10% off orders over 100. A team writes that rule in the controller: three items at 40 give 120, so the total is 108. A mobile screen with its own controller does not copy the rule and shows 120. The same cart now shows two totals. Moving the rule into the model gives one answer, 108, on every screen, and the controllers only pass clicks along. The cost is that the model now needs its own tests, and the team must keep spotting rules that crept back into controllers.

## How it works
<!--meta block=structure-->

```mermaid caption="How does the screen learn that the cart changed? Only through the model — the click reaches it via the controller at steps 1 and 2, and in the classic push form the model then announces the change without knowing who is listening, so a second view can subscribe at step 4 and nothing inside the box changes. In request/response MVC the next request re-renders instead."
flowchart LR
    User["User"]:::ext
    Controller["Controller"]
    subgraph Core["Knows nothing about the screen"]
        Model["Model — state and rules"]
        Store[("Database")]
    end
    View["View"]
    User -->|"1 clicks Add to cart"| Controller
    Controller -->|"2 cart.add(sku)"| Model
    Model -->|"3 persist"| Store
    Model -->|"4 changed"| View
    View -->|"5 read new total"| Model
    View -->|"6 render"| User
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Classic (Smalltalk-80) MVC** — Model and view are wired through a live observer link — the model pushes change notifications straight into every view watching it, in-process and in real time.
- **[MVP](./mvp.md)** — Swaps the controller for a presenter that owns all presentation logic; the view becomes passive, exposing only simple getters and setters the presenter drives.
- **[MVVM](./mvvm.md)** — Introduces a view-model that exposes bindable, observable state; the view declares bindings instead of being pushed to or pulled from imperatively.
- **Request-response (web) MVC** — Each HTTP request is one pass through the triad — controller updates the model, then renders a template — with no persistent live link between model and view.
- **Hierarchical MVC (HMVC)** — Nests whole MVC triads inside one another so independent sub-UIs (a widget, a panel) each keep their own model, view, and controller.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Domain logic kept in the model** is testable without any UI.
- **The same model can back multiple views** — a page, a widget, an export.
- **Designers and front-end code** can change the view without touching business rules, provided no rules sit in the view or controller.
- **A well-understood vocabulary** — most teams and frameworks already speak it.

### Cons
<!--meta polarity=con-->

- **The controller easily absorbs logic** that belongs in the model or the view, and swells.
- **The boundary between view** and controller is fuzzy and gets drawn differently by every team.
- **Live model-to-view notification needs its own wiring** — usually another pattern (Observer) underneath.
- **Web frameworks bend the names to fit request/response**, so "MVC" means something different in each one.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The application has real domain** logic worth testing independently of the UI.
- **More than one presentation** must show the same underlying state.
- **Input handling, business rules**, and rendering are already tangled and need separating.

### Avoid when
<!--meta polarity=avoid-->

- **The UI is trivial** — a static page or a single form doesn't need three parts.
- **Your framework's binding story fits** [MVVM](./mvvm.md) far better than a hand-rolled controller.
- **You need the view fully passive** and unit-testable in isolation. [MVP](./mvp.md) fits better: its presenter drives a passive view.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal triad"
interface State { count: number; }
type Action = "increment" | "reset";

class Model {
  private state: State = { count: 0 };
  private listeners = new Set<(s: State) => void>();

  get(): State { return this.state; }
  // Rules live here, not in the controller.
  increment() { this.set({ count: this.state.count + 1 }); }
  reset() { this.set({ count: 0 }); }
  private set(next: State) {
    if (next.count === this.state.count) return; // no notify when nothing changed: stops update loops
    this.state = next;
    for (const fn of this.listeners) fn(next);
  }
  onChange(fn: (s: State) => void) { this.listeners.add(fn); }
}

class Controller {
  constructor(private model: Model) {}
  handle(action: Action) {
    if (action === "increment") this.model.increment();
    if (action === "reset") this.model.reset();
  }
}

// View renders on every model change; controller owns input handling.
const model = new Model();
const view = { render: (s: State) => console.log(`count: ${s.count}`) };
model.onChange((s) => view.render(s));
new Controller(model).handle("increment"); // view logs "count: 1"
```

## In the wild
<!--meta block=wild-->

- **Ruby on Rails** — Rails wires the triad by convention: ActiveRecord models map classes to tables, ActionController actions handle each request, and ActionView renders ERB templates; the router maps a URL to a controller action, so most of the wiring is supplied rather than written. {#wild-rails}
- **Django** — Django calls its triad model-template-view: a URLconf dispatches each request to a view function (the controller role), which queries object-relational mapper (ORM) models and renders a template. {#wild-django}
- **Spring MVC** — A single front controller, the DispatcherServlet, routes each request to an @Controller handler that populates a Model and returns a logical view name, which a ViewResolver maps to a template such as Thymeleaf or JSP. {#wild-spring-mvc}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Where state lives** — Model, controller or view. State held in the view or controller cannot be tested or shared without the screen.
- **Controller thickness** — Whether a controller action calls one model or service operation or contains the steps itself. Thick controllers duplicate rules across actions.
- **How the view learns of changes** — Model pushes updates to views through observers, or the view re-reads on each request. Push gives live screens in classic and desktop MVC and brings update cycles; request/response MVC re-renders per request.

### Signals to watch
<!--meta polarity=signal-->

- **Branches and lines per controller action** — A steady climb shows rules moving into the controller.
- **Queries issued while rendering a view** — A template that loops over a lazily loaded association can cause N+1 queries, so count queries per page.
- **Model tests that run without a view or controller** — Share of rules testable with plain objects. A low share means the model is entangled with presentation.

### Failure modes under load
<!--meta polarity=failure-->

- **Fat controller** — Business rules pile up in controller actions. You see the same check copied into three actions and a bug fixed in only one of them.
- **View reaches into the model** — Templates call model methods that hit the database, so rendering cost hides in markup.
- **Update storm** — In push-style MVC, one model change notifies several views that each change the model again. You see redraw loops or stale screens. Skip the notification when the new state equals the current one, as the sketch does.

### Readiness checklist
<!--meta polarity=check-->

- Model code is testable with no view or controller imported
- Views hold no queries and no business decisions
- Each controller action delegates to one model or service operation
- The path from a model change to every view that shows it is traced for loops

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Frontend Architecture](../../themes/frontend-architecture.md) — Separate state, display and input handling on an interactive screen. {#fluency-frontend-architecture}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Separation of Concerns](../../principles/separation-of-concerns.md) — Model-view-controller (MVC) is separation of concerns applied to a user interface.
- [Observer](../gof/behavioral/observer.md) — The model-to-view refresh in the classic form is an Observer registration and nothing more
- [Front Controller](../enterprise/front-controller.md) — The single entry point that hands each request to its controller
- [Convention over Configuration](../../principles/convention-over-configuration.md) — Model-view-controller (MVC) frameworks use naming rules to connect the three parts

**Alternative to**

- [REPR](./repr.md) — The multi-action controller this splits apart into one class per operation

**Has variant**

- [MVP](./mvp.md) — Model-view-presenter (MVP) swaps the controller for a presenter over a passive view
- [MVVM](./mvvm.md) — Model-view-view-model (MVVM) binds the view to a view-model

**Specializes**

- [Layered / N-Tier](./layered.md) — Model-view-controller (MVC) is a layering of user interface (UI) concerns

<!-- relationships:end -->
