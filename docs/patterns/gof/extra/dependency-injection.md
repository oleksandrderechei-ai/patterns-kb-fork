---
title: Dependency Injection
description: "Dependencies are handed in, never built inside"
area: gof-extra
owner: Oleksandr Derechei
tags: [low-level-design, decoupling, testability, composition]
status: stable
aliases: [DI, IoC]
solves: [I cannot unit test this class because it opens a real database connection inside, my tests send real emails and hit the network and I cannot stop them, swapping the payment provider means editing every class that touches it, my tests break at midnight because the code calls the system clock directly, every class builds its own collaborators and I have no seam to fake anything]
---

# Dependency Injection

An object receives its collaborators from the outside instead of building or looking them up itself — so what it talks to becomes a decision made by whoever assembles it.

## What it is
<!--meta block=description-->

Dependency injection passes an object its dependencies instead of letting it create them. A class declares what it needs, usually as an interface, and an outside party supplies the instance. Construction moves to one assembly point, the composition root, so you can swap a fake in a test or a vendor in production without editing the class.

## Explained
<!--meta block=explain-->

Dependency injection means a class receives the things it needs, such as a database client or a clock, from outside instead of creating them itself. One place, usually where the app starts and called the composition root, builds every object and wires them together. Choose it over building collaborators inside the class when they vary, such as real in production and fake in test, or one vendor against another, because a swap is then a wiring change and not an edit to working code. A missing piece also fails at startup, not in the middle of a request.

- **Assembly layer.** A reflective container hides the concrete type and slows large startups, so wire by hand until the graph is big.
- **Wide constructors.** A constructor with ten parameters means the class does too much, so split it.
- **Over-injection.** Passing a constant or a pure function only widens the constructor, so inject only what varies.

**Example.** An order service creates its own payment client, so a test of it would charge a real card. Injecting a PaymentClient interface lets the test pass a fake that records 1 charge of 40 dollars and returns success, with no network call. In production the composition root passes the real client. The cost is that the constructor now takes 4 arguments (payments, mailer, clock, repository), and a reader of the service no longer sees which payment client runs without opening the root. If the list reaches ten, split the service.

## How it works
<!--meta block=structure-->

```mermaid caption="The client depends on a port, not a concrete type. The composition root builds the real dependency and hands it in."
flowchart LR
    A["Composition Root"]
    C["Client"]
    P["Port (interface)"]
    D["Concrete Dependency"]
    A -->|builds| D
    A -->|injects| C
    C -->|depends on| P
    D -.implements.-> P
```

## Variations
<!--meta block=variations-->

- **Constructor injection** — Dependencies are passed as constructor arguments. The object is fully formed and immutable once built — the default choice for required collaborators.
- **Setter / property injection** — Dependencies are assigned after construction through setters or public fields. Useful for optional or reconfigurable collaborators, at the cost of a half-built window.
- **Method / parameter injection** — A dependency is handed to the single method that needs it rather than stored on the object. Keeps short-lived collaborators out of long-lived state.
- **Interface injection** — The client exposes an injector method that a framework calls to supply the dependency. Rare today, common in older container-driven frameworks.
- **DI container / IoC container** — A framework resolves and wires the whole object graph from registered bindings, rather than you writing the wiring by hand.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **A class no longer builds the things** it depends on, so you can swap in a different implementation without editing the class.
- **Testing gets easy**: hand in fakes or mocks instead of the real services.
- **All the wiring lives in one place** — the composition root — so the full object graph is easy to read and review.
- **Nudges each class to depend on interfaces** rather than concrete types, keeping it focused on its own behavior.

### Cons
<!--meta polarity=con-->

- **Because objects are built elsewhere**, it takes more digging to see what a class actually runs against.
- **Heavyweight DI containers add hidden "magic"**, wiring errors that only surface at runtime, and a learning curve.
- **Injecting too much** hides a design smell — a ten-parameter constructor means the class is doing too much.
- **Hard to tell what is in use** — the extra indirection can make it hard to tell which concrete type is actually in use at any moment.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A class leans on something external** — a database, a clock, an HTTP client, or another service.
- **You want to unit-test a class** on its own, feeding it stand-in test doubles.
- **The same class must run against different implementations** — production versus test, or one vendor versus another.

### Avoid when
<!--meta polarity=avoid-->

- **The dependency is a simple, fixed value** that has no reason to ever change.
- **Wiring a tiny script through a container** costs more ceremony than it saves.
- **The collaborator is a pure, predictable function** that never needs swapping out.

Handing collaborators in keeps a class from quietly accumulating everything it touches — a guard against the [God Object](../../../hazards/god-object.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — constructor injection with a composition root"
interface Clock { now(): Date }
interface Mailer { send(to: string, body: string): Promise<void> }

// The service names what it needs, but never constructs it.
class ReminderService {
  constructor(
    private readonly clock: Clock,
    private readonly mailer: Mailer,
  ) {}

  async remind(user: string): Promise<void> {
    const stamp = this.clock.now().toISOString();
    await this.mailer.send(user, `Reminder generated at ${stamp}`);
  }
}

// Real implementations, defined once.
const systemClock: Clock = { now: () => new Date() };
const consoleMailer: Mailer = {
  send: async (to, body) => console.log(`-> ${to}: ${body}`),
};

// Composition root: the one place that wires the real graph together.
const service = new ReminderService(systemClock, consoleMailer);

// A test swaps in doubles — no wall clock, no side effects.
const frozenClock: Clock = { now: () => new Date("2026-01-01T00:00:00Z") };
const sent: string[] = [];
const captureMailer: Mailer = { send: async (_to, body) => void sent.push(body) };
const underTest = new ReminderService(frozenClock, captureMailer);
```

## In the wild
<!--meta block=wild-->

- **Spring Framework** — Its ApplicationContext is an IoC container that constructs and wires the entire Java bean graph. Bindings come from annotations (@Autowired, @Component) or explicit @Bean methods; bean scopes (singleton, prototype, request, session) are the primary lifetime knob, and constructor injection is the recommended style. {#wild-spring}
- **Angular** — Ships a hierarchical injector: providers declared on the root, a module, or a component resolve services requested by constructor parameters. Child injectors inherit and can override parent providers, so scope follows the component tree. {#wild-angular}
- **Dagger** — Generates the wiring code at compile time from @Inject and @Module annotations, so an unsatisfiable or cyclic dependency graph fails the build rather than the running app. Because there is no runtime reflection, resolution has effectively zero startup cost. {#wild-dagger}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Binding lifetime / scope** — Each registration declares how long an instance lives — transient (new per resolution), scoped/per-request, or singleton. The wrong choice is the most common DI misconfiguration: a singleton holding a per-request dependency leaks state across requests.
- **Composition root placement** — The single point where the graph is wired. Keeping it at the application entry point (not scattered into libraries) determines whether wiring stays reviewable.
- **Registration strategy** — Explicit per-type bindings versus assembly/classpath scanning that auto-registers by convention. Scanning cuts boilerplate but makes it harder to see what is actually bound.

### Signals to watch
<!--meta polarity=signal-->

- **Container startup / resolution time** — Time to build the graph at boot (or first resolution for lazy graphs). A large graph resolved eagerly shows up as slower cold start.
- **Unsatisfied-dependency errors** — Count of runtime resolution failures — a binding is missing or ambiguous. Compile-time DI surfaces these at build instead.
- **Captive-dependency / scope-mismatch reports** — A longer-lived object holding a shorter-lived one. Some containers can validate and report this; it manifests as stale or cross-request state.

### Failure modes under load
<!--meta polarity=failure-->

- **Captive dependency** — A singleton captures a scoped or transient dependency; the short-lived object never gets released or refreshed, leaking state or connections across requests.
- **Runtime resolution error** — With reflection/runtime containers, a missing or ambiguous binding fails when the object is first resolved — often deep in a request path rather than at startup.
- **Over-injection** — A constructor accumulates ten collaborators; the class is doing too much and the graph becomes slow and confusing to trace.

### Readiness checklist
<!--meta polarity=check-->

- Every dependency has exactly one unambiguous binding, verified at startup or build time
- Lifetimes are deliberate: no singleton captures a scoped or transient dependency
- Composition root lives at the entry point, not scattered through libraries
- The concrete graph a class runs against can be traced from the registrations alone

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Creation](../../../themes/object-creation.md) — Pass an object its dependencies instead of letting it create or find them. {#fluency-object-creation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Hexagonal](../../architecture/hexagonal.md) — Adapters are injected into the core's ports
- [Dependency Inversion Principle](../../../principles/dependency-inversion.md) — The wiring-time mechanism that realises dependency inversion.
- [Convention over Configuration](../../../principles/convention-over-configuration.md) — Autowiring is dependency injection steered by convention
- [Abstract Factory](../creational/abstract-factory.md) — A whole factory family is a collaborator worth handing in, so the client never picks a family itself
- [Strategy](../behavioral/strategy.md) — A swappable algorithm is a typical thing to inject, so the caller never builds it

**Alternative to**

- [Singleton](../creational/singleton.md) — A global instance vs. handing the instance in
- [Service Locator](./service-locator.md) — Push dependencies in vs. pull them from a registry
- [Monostate](./monostate.md) — Explicit collaborator vs. instances secretly sharing static state
- [Currying](../../functional/currying.md) — A curried function closes over what a constructor would take

**Has variant**

- [Provider](../../frontend/provider.md) — The provider pattern is dependency injection (DI) scoped to a user interface (UI) component subtree

**Prevents**

- [God Object](../../../hazards/god-object.md) — Injected collaborators keep one class from owning everything
- [Improper Instantiation](../../../hazards/improper-instantiation.md) — One place that states whether a collaborator is a singleton, pooled or per-request
- [Static Cling](../../../hazards/static-cling.md) — Turns a hidden static dependency into a declared one a test can substitute

<!-- relationships:end -->
