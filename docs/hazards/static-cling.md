---
title: Static Cling
description: "A static call to something stateful, with no seam to replace it"
area: hazards
owner: Oleksandr Derechei
tags: [low-level-design, testability, decoupling, code-smell, state-management]
status: stable
aliases: [hidden static dependency, static coupling]
solves: [I cannot unit test this class because it calls a static method that hits the database, our tests pass alone and fail when the whole suite runs, the constructor takes nothing but the class clearly depends on half the system, I need to fake the current time in a test and there is nothing to substitute, two tests interfere through some shared state I cannot find]
---

# Static Cling

A static member that reads a clock, opens a connection or mutates shared state welds every caller to that one implementation — and because the dependency appears in no constructor, parameter or interface, nothing in the caller's signature admits it is there.

## What it is
<!--meta block=description-->

Static cling is a caller stuck to one implementation because it reached it through a static call, leaving no receiver to substitute and no parameter or interface to pass another through. You recognise it when a test cannot control the clock, connection or settings a method reads. The trait is not the keyword but what the member touches: a pure function should stay static, while one with hidden inputs or mutable state is the hazard.

## Explained
<!--meta block=explain-->

Static cling is code stuck to one specific implementation because it reached it through a static call, a call on a class rather than on an object you were given. There is no object to swap, no parameter to pass a stand-in through and no interface to implement, so no test or configuration can get between the caller and the thing it calls. The hazard is not the keyword but what the member touches. A pure function, one that returns the same output for the same input and touches nothing else, should stay static. A static member that reads the clock, opens a connection or reads settings has hidden inputs, and learning what a method depends on means reading its body. It spreads because a static call needs no wiring, so the first person who must test around it pays for all of them. Move anything whose answer depends on the world behind a dependency the caller declares, using [dependency injection](../patterns/gof/extra/dependency-injection.md). Wrap a third-party static API in a thin adapter.

- **More parameters.** Constructors gain collaborators and every builder must supply them; a composition root keeps the wiring in one place.
- **Service locator trap.** Swapping a static call for a global lookup is the same hazard behind an interface.

**Example.** A late-fee class calls LocalDate.now() in 5 places. To test a fee at 31 days overdue you must wait 31 days or change the machine's clock, so its 12 tests cover only today. You pass it a Clock in its constructor instead. Production passes the system clock, and a test passes a fixed date, so all 12 cases run in milliseconds on any day. The cost is one extra line in each of the 3 modules that build the class.

## How it happens
<!--meta block=causes-->

Nobody sets out to hide a dependency. Every instance starts as the shortest way to get something the code needs — the current time, a configuration value, a shared connection — and a static call is genuinely the shortest way. The forms below are the ones that recur, and they differ in how obvious the hidden dependency is: the first two look harmless, the last two are usually adopted on purpose.

A static call is also asymmetric in effort in a way that shapes codebases over time. Adding one is free; the first person who needs to test around it pays for all of them. That imbalance means the hazard is almost never introduced by the person who has to remove it, which is why it survives code review and shows up as an untestable module later.

```mermaid caption="Steps 1 to 3 are invisible from the signature at the top, which is the whole hazard — and step 4 is the bill: a test can construct the caller but cannot get between it and any of the three, so the only way to exercise it is to make the real clock, real config and real shared state cooperate."
flowchart LR
    subgraph Vis["What the signature says"]
        C["Caller.process(order)"]
    end
    subgraph Hid["What it actually depends on"]
        CLK["Clock.now"]
        CFG["Config.get"]
        ST[("static mutable field")]
    end
    C -->|"1 static call, no parameter"| CLK
    C -->|"2 static call, no parameter"| CFG
    C -->|"3 reads and writes"| ST
    T["Test"] -->|"4 has nothing to substitute"| C
```

- **A static clock or environment read.** The current time, an environment variable or a configuration singleton read directly at the point of use, so behaviour depends on when and where the code runs.
- **A static gateway to the outside world.** A static method that opens a connection, reads a file or calls a service — the dependency is a whole external system, declared nowhere.
- **A static mutable field.** Shared state with no owner and no lifetime, written from anywhere, which couples callers to each other through data neither of them mentions.
- **A static accessor over one shared instance.** The [singleton](../patterns/gof/creational/singleton.md) form: the dependency wears an interface, but it is still fetched statically, so the seam is decorative.
- **A global lookup registry.** A [service locator](../patterns/gof/extra/service-locator.md) hides the same dependency behind a lookup call — the signature still says nothing about what will be asked for.
- **A third-party static API.** A library that only exposes static entry points imposes the hazard from outside, and the only remedy is an adapter you own.

## What it costs
<!--meta block=cost-->

- **The unit cannot be tested in isolation.** Exercising the caller means making the real clock, connection or file cooperate, so a unit test becomes an integration test by force.
- **Tests stop being independent.** Static state carries between tests in the same process, so a suite passes in one order and fails in another — and the failure is attributed to the wrong test.
- **The dependency graph is no longer readable.** Signatures stop telling you what a class needs, so estimating the blast radius of a change means reading implementations.
- **Removal is a wide change.** Every call site is its own edit, and there are more of them than an injected dependency would have accumulated, because adding each one was free.
- **Temporal coupling fails at run time.** Calls that must happen in a particular order have no compile-time protection, so the break lands on the paths tests exercise least.

Against all of that, be honest about what makes it attractive: a static call is the cheapest thing to write and among the easiest to read, and a codebase that injects every last thing pays in ceremony and indirection that has its own real cost. That is why the useful rule is narrow rather than absolute — purity, not the keyword. Deterministic static helpers are good design and should not be refactored into injected collaborators to satisfy a lint rule; what has to move is anything whose answer depends on the world. Drawing the line there keeps the convenience where it is free and pays only where it buys a seam.

## Getting out
<!--meta block=mitigation-->

Sort the static members into two piles first. Deterministic functions of their arguments stay exactly as they are — moving them buys nothing. Everything that touches time, configuration, storage, the network or a static field becomes an instance dependency the caller declares, which is what [dependency injection](../patterns/gof/extra/dependency-injection.md) is for: the seam appears because the collaborator arrives as a parameter.

Make signatures honest as you go. Pass what a method needs and return what it produces, rather than reading and writing shared state, which removes the ordering constraint along with the hidden dependency. For a third-party static API you cannot change, wrap it in a thin instance-level adapter and depend on the adapter — the wrapper is not tested, and does not need to be, because it contains no decisions.

Two traps on the way out. A global lookup registry is the same hazard wearing an interface, so replacing a static accessor with a static locator call moves nothing. And where a single shared instance really is needed, own its lifetime in the composition root rather than in a static field, so exactly one place decides when it exists — which also gives tests somewhere to substitute.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Mitigated by**

- [Dependency Injection](../patterns/gof/extra/dependency-injection.md) — The seam appears the moment the collaborator arrives as a parameter
- [Adapter](../patterns/gof/structural/adapter.md) — A thin instance-level wrapper is the whole fix for a third-party static application programming interface (API)
- [Dependency Inversion Principle](../principles/dependency-inversion.md) — Depending on an abstraction the caller owns is the general form of the fix
- [Gateway](../patterns/enterprise/gateway.md) — An injected gateway turns a hidden static call to the outside world into a visible dependency
- [Test Stub](../patterns/testing/test-stub.md) — Code that takes its collaborator at a seam, so a stub can stand in, has no static call to cling to

**Threatens**

- [Singleton](../patterns/gof/creational/singleton.md) — A global accessor is a static call that tests and callers cannot substitute
- [Service Locator](../patterns/gof/extra/service-locator.md) — A static registry lookup hides dependencies behind a call that cannot be swapped
- [Factory Method](../patterns/gof/creational/factory-method.md) — A static factory call fixes the concrete type at the call site

<!-- relationships:end -->
