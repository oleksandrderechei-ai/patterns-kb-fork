---
title: Strategy
description: Swaps an algorithm's implementation at runtime
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, polymorphism, extensibility, composition]
status: stable
aliases: [Policy]
solves: [adding a new export format means editing a giant switch statement, this one method has a branch for every payment provider we support, I want to A/B test two ranking algorithms without forking the code, I cannot test the discount rules without spinning up the whole checkout, a customer wants their own pricing rule and I do not want their special case in our core code]
---

# Strategy

Wraps a family of interchangeable algorithms behind one interface, so a program can swap which one it runs at runtime without touching the code that calls it.

## What it is
<!--meta block=description-->

One method keeps growing a switch over a mode or type, and every new variant means editing it and risking the others. Strategy moves each branch behind a common interface as its own class or function. The caller holds one and can swap it at run time, so behavior follows a setting or a request without branching at the call site.

## Explained
<!--meta block=explain-->

A strategy is one interchangeable way of doing a job, behind a single interface, that the calling object receives from outside and calls without knowing which one it has. Each branch of what used to be one growing switch becomes its own class or function, so a new variant is a new file and the tested method stays untouched. Choose it when the variants are truly interchangeable, more will arrive, and the choice belongs to whoever uses the code. With two fixed variants, a plain if reads better. Where your language has first-class functions, pass a function or keep a map of them, which gives the same extension with less ceremony.

- **Volume and indirection.** Each trivial branch becomes a named piece with its own wiring, and the reader must follow a reference to see what ran.
- **Hidden choice.** Log the chosen variant name on each call, so you can see which one ran.
- **Caller must pick.** The caller needs enough knowledge to choose, so give it a default and one place that decides.

**Example.** A shop computes shipping with a switch on carrier: flat rate, weight-based and express. Adding a fourth carrier means editing and retesting that method, which puts the other three at risk. With strategies, each carrier is a function that takes the order and returns a price, kept in a map keyed by carrier name. A new carrier is one entry and one test. The cost is that a wrong key now fails at run time, so look it up with a clear error such as unknown carrier dhl, and test that every carrier named in the config exists in the map.

## How it works
<!--meta block=structure-->

```mermaid caption="The context (the calling object) holds one Strategy and calls its interface. Concrete strategies implement that interface and are freely interchangeable."
classDiagram
    class Context {
      -strategy
      +run()
    }
    class Strategy {
      <<interface>>
      +execute()
    }
    class QuickSort
    class MergeSort
    Context o-- Strategy : holds
    Strategy <|.. QuickSort
    Strategy <|.. MergeSort
```

## Variations
<!--meta block=variations-->

- **Function strategies** — In languages with closures, a strategy is just a function passed in — no interface or class ceremony, only a callable with the right signature.
- **[Null Object](../extra/null-object.md) default** — A do-nothing strategy stands in when none is configured, so callers never have to branch on a missing one.
- **Strategy registry** — Register named strategies in a map and select one by key from config, a feature flag, or the request itself.
- **Policy-based design** — Bind the strategy at compile time through templates or generics the compiler specialises per type, trading runtime flexibility for calls it can inline. Where generics are erased, the call still dispatches at run time.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Switch between algorithms while the program runs**, without changing the code that calls them.
- **Replaces one sprawling if/switch** with small, single-purpose units.
- **Each algorithm is isolated**, so you can test it on its own.
- **Add a new algorithm** without editing the existing ones (open for extension).

### Cons
<!--meta polarity=con-->

- **More types and indirection** than a simple inline branch when there are only two trivial cases.
- **The caller has to know enough** to pick the right algorithm, so give it a default and keep the choice in one place that decides.
- **Algorithms that share data** need a common context object, or awkward parameter passing.
- **Overkill when the set of algorithms** is fixed and will never grow.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You have several interchangeable ways** to do one job and choose between them while running.
- **Growing kind-based branching** — a method is turning into a growing `switch` or `if/else` over a "kind" or "mode".
- **You want to add new behaviors** without editing the code that invokes them.

### Avoid when
<!--meta polarity=avoid-->

- **There is only one algorithm**, or two that will never grow into more.
- **The variants differ only in a single constant** — pass a parameter instead.
- **The behavior really tracks an object's lifecycle changes** — that is State, not Strategy.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — swappable pricing strategies"
interface PricingStrategy {
  price(subtotal: number): number;
}

// Interchangeable algorithms behind one interface
const listPrice: PricingStrategy = { price: (s) => s };
const memberPrice: PricingStrategy = { price: (s) => s * 0.9 };

class Checkout {
  #strategy: PricingStrategy;

  constructor(strategy: PricingStrategy) {
    this.#strategy = strategy;
  }

  use(next: PricingStrategy): void {   // swap at runtime
    this.#strategy = next;
  }

  total(subtotal: number): number {
    return this.#strategy.price(subtotal);
  }
}

const cart = new Checkout(listPrice);
cart.use(memberPrice);   // now 10% off
cart.total(100);         // => 90
```

## In the wild
<!--meta block=wild-->

- **java.util.Comparator** — Sorting order is passed in as an interchangeable object, so one sort routine — Collections.sort, Arrays.sort, Stream.sorted — handles any ordering the caller supplies. Combinators like comparing, thenComparing and reversed compose new orderings without writing a new class. {#wild-java-comparator}
- **Passport.js** — Calls its authentication mechanisms strategies outright: each provider — local, OAuth, JSON Web Token (JWT) — is a plug-in object registered with passport.use() that the middleware delegates to via passport.authenticate(name), never knowing which one it holds. {#wild-passport}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **How the strategy is chosen** — Passed in by the caller, picked from config, or selected by a registry keyed by name. A registry fits when the set grows.
- **Interface width** — One method or several. A one-method strategy can be a plain function.
- **Stateless or stateful** — A stateless strategy can be shared across threads. A stateful one needs one instance per use.
- **Default strategy** — What runs when none is chosen, and whether a missing choice is an error.

### Signals to watch
<!--meta polarity=signal-->

- **Strategy count** — Number of implementations. Ones that differ only in a constant suggest data would do instead of classes.
- **Branches left on the type** — if or switch statements elsewhere that still test which strategy is in use mean the abstraction leaks.
- **Selection logs** — Which strategy ran for each call, so a surprising result traces to a choice.
- **Per-strategy latency** — Timing grouped by strategy, since they may differ in cost.

### Failure modes under load
<!--meta polarity=failure-->

- **Leaky interface** — One strategy needs an argument the others ignore and the interface grows a parameter for it.
- **Wrong choice at run time** — The selection rule picks a strategy for an input it was not made for. Test the selector on its own.
- **Shared mutable state** — A stateful strategy is reused across threads and corrupts its own fields.
- **Strategy for two cases** — A class hierarchy exists for two variants that a flag would handle, adding files with no gain.
- **Unknown name** — A configured name is missing from the map, so the lookup fails at run time. Look it up with a clear error and test that every configured name exists.
- **Swapped shared context** — One request calls use() on a context other requests share, and its choice leaks into theirs. Pass the strategy per call or build a context per request.

### Readiness checklist
<!--meta polarity=check-->

- Every strategy passes the same contract tests
- The selection rule has its own tests and a default
- Stateful strategies are never shared across threads
- No branch outside the selector tests which strategy is in use, logging and metric tags excepted
- Every configured strategy name resolves to a strategy or fails with a clear error
- A context shared between requests is never re-pointed with use()

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Behavior](../../../themes/object-behavior.md) — Put each algorithm behind one interface and let the client pick. {#fluency-object-behavior}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Null Object](../extra/null-object.md) — A do-nothing strategy is a common default
- [Microkernel / Plugin](../../architecture/microkernel.md) — Plug-ins are swappable strategies for the core
- [Open/Closed Principle](../../../principles/open-closed.md) — The textbook way to be open to new behaviour and closed to modification.
- [Composition over Inheritance](../../../principles/composition-over-inheritance.md) — A direct application: hold a behaviour, do not inherit it.
- [Render Props](../../frontend/render-props.md) — Render props is strategy applied to how a component renders
- [Dependency Injection](../extra/dependency-injection.md) — The strategy is the collaborator handed to the context from outside, which is what injection supplies

**Alternative to**

- [Template Method](./template-method.md) — Compose an algorithm vs. subclass to fill steps
- [Feature Flag](../../distributed/routing/feature-flag.md) — When the variation is a domain concept, a polymorphic strategy beats a conditional
- [Specification](../../enterprise/specification.md) — A specification is a strategy whose only job is a boolean and that joins with and, or, not.

**Often confused with**

- [State](./state.md) — Swap an algorithm vs. change behavior as state changes
- [Bridge](../structural/bridge.md) — Interchangeable behaviour vs. a permanent split between what and how
- [Command](./command.md) — Swap interchangeable ways of doing one job vs. reify one operation to defer, queue or log it

**Prevents**

- [Shotgun Surgery](../../../hazards/shotgun-surgery.md) — Puts each variant, such as a payment type, in one class, so adding one touches one place

**Demonstrated by**

- [Parking Lot](../../../designs/parking-lot.md) — Parking Lot reaches for a pricing/allocation Strategy only when flat hourly pricing outgrows a single rule
- [Elevator](../../../designs/elevator.md) — the choice of which car answers is an interchangeable algorithm selected at the boundary and varied independently of its caller
- [Logging Service](../../../designs/logging-service.md) — two interchangeable, swap-at-construction algorithm families is strategy's core move
- [Rate Limiter](../../../designs/design-rate-limiter.md) — the limiter swaps Token Bucket for Sliding Window Log per endpoint with no change to calling code — Strategy's whole point
- [Connect Four](../../../designs/connect-four.md) — Shows the refusal: four directional checkers whose bodies differ only in step values are data, not strategies

<!-- relationships:end -->
