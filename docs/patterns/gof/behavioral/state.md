---
title: State
description: Behavior changes as an object's internal state changes
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, state-management, polymorphism, lifecycle, extensibility]
status: stable
aliases: [Objects for States]
solves: [the same switch on a status field shows up in nine different methods, adding a new order status means hunting down every place that checks the status, nobody can tell me which statuses are allowed to follow which, my code happily cancels an order that already shipped, this class is eight hundred lines of if status equals checks]
---

# State

An object rewires its own behavior as its internal state changes — the same method call does something different depending on which state the object is in, as if it swapped class at runtime.

## What it is
<!--meta block=description-->

An object whose behavior depends on its mode grows the same switch on a status field in every method, and its transition rules smear across the class. State gives each mode its own class and forwards every request to the current one. A new mode is a new class, and the hidden machine becomes explicit.

## Explained
<!--meta block=explain-->

The state pattern gives each mode of an object its own class, and the object (the context) forwards every request to the class for its current mode. Behaviour that was a switch on a status field in every method becomes one method per state class, and each state also says which state comes next. Choose it over an enum and one switch when the rules for what may follow what are the hard part, because they now sit where you can read and test them one state at a time.

- **Scattered machine.** No single file shows all transitions, so tracing a bug means hopping between classes. Keep the state diagram beside the code.
- **Outgrown classes.** When states multiply or you need guards, history or an audit log, move to a transition table or a state machine library.
- **Shared data.** A state must reach back into the context object for it, so pass the data in as an argument.

**Example.** An order has four states: New, Paid, Shipped and Cancelled, and four requests: pay, ship, cancel and refund. A switch checks the status in each of 4 methods: 16 branches. State classes give 4 classes of 4 methods, still 16, but each class holds one state's rules: Shipped refuses cancel; Paid allows cancel and refund, both ending in Cancelled. The cost shows when you ask what leads to Cancelled: you open all four classes to learn that only New and Paid do. A table of 4 rows (New to Paid, New to Cancelled, Paid to Shipped, Paid to Cancelled) shows it at once, and once refunds need a guard such as a time limit, a table is better.

## How it works
<!--meta block=structure-->

```mermaid caption="A document's states as concrete objects. The context delegates each request to the current state, which handles it and returns the next state."
stateDiagram-v2
    [*] --> Draft
    Draft --> Moderation: submit
    Moderation --> Published: approve
    Moderation --> Draft: reject
    Published --> Draft: edit
    Published --> Archived: archive
    Archived --> [*]
    note right of Draft: each state handles the same request its own way
    note right of Moderation: the current state decides the next transition
```

## Variations
<!--meta block=variations-->

- **State objects vs. transition table** — Model states as polymorphic classes, or as a data table mapping (state, event) to a next state and action. Tables are compact and easy to inspect; objects carry richer per-state behavior.
- **Context-driven vs. state-driven transitions** — The context can decide the next state, or each state can name its own successor. Letting states transition themselves keeps the rules local, at the cost of coupling states to one another.
- **Shared vs. per-context state instances** — When states hold no data of their own, share a single flyweight instance across all contexts. When they carry per-object data, each context needs its own.
- **Hierarchical state machines (statecharts)** — Nest states so that child states inherit the transitions of their parent, so a shared transition such as cancel is written once. That trims the repeated transitions behind state explosion; independent dimensions need parallel states, not nesting.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Replaces sprawling if/switch checks** on the current mode with a set of small, focused classes.
- **Each state keeps its own transition rules** in one place, instead of scattering them across methods.
- **Adding a state** means writing one new class and editing only the states that lead to it; the others stay untouched.
- **Turns a state machine** that was only implied by scattered flags into explicit classes you can test one at a time.

### Cons
<!--meta polarity=con-->

- **More classes and indirection** than a handful of simple modes may warrant.
- **Transition logic spreads across many state classes**, so no single place shows the whole machine; keep a state diagram beside the code.
- **A state that needs shared data** has to reach back into the context object to get it.
- **Overkill when a plain enum and one switch** would read more clearly.
- **Adding a request** means editing every state class, so a fifth request in the order example is 4 edits; weigh how often states change against how often requests change.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **An object should behave differently** depending on its current mode, and that mode changes as it runs.
- **Status switch repeated everywhere** — the same `switch` on a status field is repeated across many methods.
- **You have a real state machine** with distinct states and transition rules.

### Avoid when
<!--meta polarity=avoid-->

- **There are only two states** and one branch — a boolean is clearer.
- **Behavior changes with each input**, not with any lasting internal mode.
- **The states never transition**; you just need to pick a variant once.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an article whose editorial states are objects"
interface EditorState {
  readonly name: string;
  publish(): EditorState; // returns the next state
}

class Article {
  #state: EditorState = new Draft();
  get status(): string { return this.#state.name; }
  publish(): void { this.#state = this.#state.publish(); }
}

class Draft implements EditorState {
  readonly name = "draft";
  publish(): EditorState { return new InReview(); } // submit for review
}

class InReview implements EditorState {
  readonly name = "in-review";
  publish(): EditorState { return new Published(); } // reviewer approves
}

class Published implements EditorState {
  readonly name = "published";
  publish(): EditorState { return this; }            // already live: no-op
}

const article = new Article();
article.publish(); // draft -> in-review
article.publish(); // in-review -> published
```

## In the wild
<!--meta block=wild-->

- **XState** — Models each state as an explicit node with its own transitions, following SCXML-style statechart semantics with nested (hierarchical) and parallel states. The machine is a serializable definition its inspector can visualize and step through, turning the implicit machine hiding in a component into an inspectable diagram. {#wild-xstate}
- **Spring Statemachine** — A Spring project for building state machines: states, transitions, guards and actions are configured on a builder, and the machine moves between states as events are sent to it. The behavior of each state lives in its actions, not in a growing if-else chain. {#wild-spring-statemachine}
- **Python transitions** — The transitions library lets you declare states and triggers on a plain Python object, then adds trigger methods that move the object between states. Callbacks run on entering and leaving each state, and conditions can guard a transition. {#wild-python-transitions}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **State as class, enum or table** — A class per state, an enum with a switch, or a transition table. Classes pay off when each state has many behaviors.
- **Who owns transitions** — The context, the states or a central table. States that pick the next state are easy to follow and couple them to each other.
- **Shared or per-context state objects** — A state with no data can be one shared instance. A state with data needs one per context.
- **Guards, entry and exit actions** — Conditions that allow or refuse a transition, and work run on entering or leaving a state. A failed guard should reject and log the event, which feeds the illegal-transition signal, unless ignoring it is deliberate. A few guards fit in a state's method; once they multiply, move to a table or library.

### Signals to watch
<!--meta polarity=signal-->

- **Transition coverage** — Tests that cover each allowed transition and each rejected one.
- **State count growth** — States added over time. A fast climb may mean flags were turned into states.
- **Illegal-transition logs** — Counts of events the current state refused, from logs.
- **Time in each state** — How long objects sit in each state. An object stuck in one state is a bug or a missing event.

### Failure modes under load
<!--meta polarity=failure-->

- **Hidden states in flags** — Booleans next to the state objects create combinations nobody modelled. Fold them into states.
- **Missing transition** — An event arrives in a state that has no rule for it and is dropped silently. Decide: reject or ignore, on purpose.
- **State explosion** — Combining two independent dimensions in one machine multiplies the states. Split into two machines or use parallel states; nested states only remove repeated transitions.
- **Races** — Two threads send events to one context and the transition runs twice. Serialize event handling.

### Readiness checklist
<!--meta polarity=check-->

- A diagram of states and transitions exists and matches the code
- Every state handles every event, even if it only rejects it
- Entry and exit actions are tested
- Event handling on one context is serialized

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Behavior](../../../themes/object-behavior.md) — Let an object change what it does when its internal state changes. {#fluency-object-behavior}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Flyweight](../structural/flyweight.md) — A state holding no per-object data can be one shared instance serving every context
- [Make Illegal States Unrepresentable](../../../principles/make-illegal-states-unrepresentable.md) — A state machine that offers only legal transitions is the same idea at run time

**Often confused with**

- [Strategy](./strategy.md) — Swap an algorithm vs. change behavior as state changes

**Demonstrated by**

- [BookMyShow](../../../designs/bookmyshow.md) — temporary seat holds are modelled as explicit states rather than a second boolean flag
- [Elevator](../../../designs/elevator.md) — a car's IDLE/UP/DOWN direction is an explicit state machine, held as an enum and switched in step(), not a class per state

<!-- relationships:end -->
