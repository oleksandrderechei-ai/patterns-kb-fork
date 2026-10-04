---
title: Service Locator
description: A registry that hands back shared services on request
area: gof-extra
owner: Oleksandr Derechei
tags: [low-level-design, decoupling, state-management, composition]
status: stable
solves: [a framework constructs my objects for me so I have nowhere to pass collaborators in, I am threading a logger through eight constructor layers just to reach the class that needs it, plugins loaded at runtime need to find services that did not exist at compile time, the same few helpers show up in nearly every class and constructors keep growing to carry them, legacy code calls new on my class directly and I cannot change its signature]
---

# Service Locator

A central registry you ask for a service by name or type — it hands back a shared, ready-made instance, so callers look things up instead of wiring them by hand.

## What it is
<!--meta block=description-->

When a framework or plugin host builds your classes, there is no constructor to pass a service through, so callers build concrete services themselves. A service locator is a central registry, keyed by interface, type or name, that hands a shared service back on request, as in `locator.get(PaymentGateway)`; one startup place picks the implementation. The price: a class's real dependencies no longer show in its signature, and a missing registration fails only when the call runs.

## Explained
<!--meta block=explain-->

A service locator is a central registry that your code asks for a shared service by type or name, for example \`locator.get(PaymentGateway)\`, instead of building it or receiving it in a constructor. Callers know only the interface, and one place at startup decides which class answers. Choose it only where you do not own construction: a framework, a plugin host or a legacy call site creates your objects and there is no constructor to pass anything through. Where you do own it, dependency injection, which hands the objects in from outside, gives the same freedom without these costs, at the price of passing dependencies through constructors.

- **Hidden needs.** A class's needs vanish from its signature, so pass the locator in rather than using a global one, and tests can substitute it.
- **Late failure.** A missing registration fails at the moment of the call, so check at startup that every key is registered, without building lazy services.
- **God object.** The registry attracts unrelated services, so cap and review the key list or split it by module.

**Example.** A plugin host creates your ReportPlugin with no arguments, so it cannot receive a database, then calls the plugin's init(locator) hook. The plugin calls locator.get(Database) when it runs. A teammate renames the registration to Db, and nothing fails until a user runs a report and gets an error. A startup check that all 12 keys the plugins use are registered, without building lazy services, would fail the boot instead. In tests, you call init with a locator holding a fake database, so the plugin runs without a real one. Had the locator been a global, a fake registered in one test would leak into the next.

## How it works
<!--meta block=structure-->

```mermaid caption="Services are registered once at startup. A client then pulls a service by key, and the locator returns the shared instance from its registry."
flowchart LR
    Boot["Bootstrap"] -->|"register"| Reg["Registry map"]
    Client["Client"] -->|"get by key"| SL["Service Locator"]
    SL -->|"lookup"| Reg
    SL -->|"shared instance"| Client
```

## Variations
<!--meta block=variations-->

- **Typed vs. keyed lookup** — Resolve by interface or generic type — `get<Logger>()` — for a compile-checked key and return type, or by string key for flexibility at the cost of typos surfacing only at runtime. Either way, a missing registration still fails when the service is requested.
- **Global vs. injected locator** — A single ambient locator reachable everywhere, or a locator instance passed in like any other dependency. Injecting it keeps the seam testable and confines the global reach.
- **Lazy / factory registration** — Register a ready instance, or register a factory the locator invokes on first request and caches thereafter — useful for expensive services that may never be needed.
- **Scoped / hierarchical locators** — Per-request or per-module child locators that fall back to a parent, giving each scope its own overrides while sharing common services.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Callers don't need to know the concrete types** or how they're built.
- **Gives you one place to configure**, swap, or mock every implementation.
- **Saves threading a dependency** down through many layers of constructors.
- **Supports lazy creation** — a service is built on first request, then shared.

### Cons
<!--meta polarity=con-->

- **Hides what a class depends on** — nothing shows up in its signature, so the API lies about what it needs.
- **Harder to test** when the locator is global: every class quietly leans on shared state that must be set up first. Hand the locator in and it stubs like any other collaborator, though you must read the class to learn which keys to fake.
- **One shared locator attracts everything** and slowly drifts into a god object.
- **Late failure on missing registration** — a forgotten registration only fails when the service is requested, not at startup or compile time.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You don't control construction** — a framework, plugin host, or legacy code creates your objects for you.
- **A few cross-cutting services** — logging, config, a clock — are needed almost everywhere, and the framework-created class cannot take them by constructor.
- **Code loaded after startup**, such as a plugin, has to resolve its services when it runs, because it cannot be given them at construction.

### Avoid when
<!--meta polarity=avoid-->

- **You control construction and can hand dependencies in** — prefer [Dependency Injection](./dependency-injection.md).
- **You want each class's requirements visible** in its signature and checked by the compiler.
- **The locator is turning into a dumping ground** for unrelated services.

Left unchecked, a locator that answers every request accretes responsibilities until it becomes a [God Object](../../../hazards/god-object.md) the whole codebase reaches into.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal locator with typed keys and lazy factories"
// A key carries its service type, so get() stays type-safe.
type Key<T> = symbol & { readonly __service?: T };

class ServiceLocator {
  private readonly instances = new Map<symbol, unknown>();
  private readonly factories = new Map<symbol, () => unknown>();

  register<T>(key: Key<T>, factory: () => T): void {
    this.factories.set(key, factory);
  }

  get<T>(key: Key<T>): T {
    if (!this.instances.has(key)) {
      const make = this.factories.get(key);
      if (!make) throw new Error(`no service registered for ${String(key.description)}`);
      this.instances.set(key, make());   // build once, share thereafter
    }
    return this.instances.get(key) as T;
  }
}

interface Clock { now(): Date }
const CLOCK = Symbol("Clock") as Key<Clock>;

const locator = new ServiceLocator();
locator.register(CLOCK, () => ({ now: () => new Date() }));

// Callers pull the service out instead of receiving it.
const stamp = locator.get(CLOCK).now();
```

## In the wild
<!--meta block=wild-->

- **Android Context.getSystemService** — Framework services (LayoutInflater, ConnectivityManager, AlarmManager, and so on) are fetched by name constant or class from a Context rather than handed to an Activity the platform constructs. It is the canonical locator seam in Android, since the framework owns instantiation of your components. {#wild-android-getsystemservice}
- **Spring ApplicationContext.getBean** — Exposes locator-style lookup over the IoC container, letting code that Spring did not wire pull a bean by type or name. The Spring team treats it as an escape hatch: constructor injection is the recommended path, and reaching for getBean is a smell outside framework-integration code. {#wild-spring-getbean}
- **.NET IServiceProvider** — GetService (or the throwing GetRequiredService) resolves a registered implementation on demand — the escape hatch for code the ASP.NET Core container cannot constructor-inject into. Resolving a scoped service from the root provider is a documented error the container guards against in development. {#wild-dotnet-iserviceprovider}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Registration lifetime / scope** — Each service is registered as a shared singleton, a per-scope instance, or a fresh one per request (e.g. .NET AddSingleton / AddScoped / AddTransient over ServiceCollection). Governs how long a located object lives and whether state is shared across callers. Use singleton for a shared stateless service, scoped for per-request state, and never let a singleton hold a scoped service.
- **Lazy vs eager registration** — Register a ready instance (eager) or a factory called on first request and cached (lazy). Eager surfaces a construction error at startup; lazy defers services a run may never ask for, but a failing factory shows up on first request.

### Signals to watch
<!--meta polarity=signal-->

- **Unresolved-service errors** — Count of get() calls for a key with no registration. Because a locator fails at call time rather than at construction, this is the observable symptom of a missing or misspelled binding — watch it in logs after each deploy. Throw a distinct error type or fixed log message from get() so the count is one query. With a startup check in place, any nonzero count after boot is a defect to alert on.

### Failure modes under load
<!--meta polarity=failure-->

- **Missing registration at call time** — A service is requested that was never registered; the lookup throws deep in a request path instead of at startup or compile time, so gaps hide until the exact code path runs. With a nullable lookup such as .NET GetService the call returns null instead, and the failure surfaces at first use.
- **Scope mismatch** — A shorter-lived (scoped/per-request) service is resolved from a global or singleton locator; it either leaks across requests as a captive dependency or, in stricter containers, throws when resolved from the root.
- **God-object drift** — The locator answers every request, so unrelated services accrete onto it until the whole codebase reaches through one ambient object that is impossible to reason about or test around.
- **Racy, slow or circular first resolution** — Two threads making the first get() together can each run the factory, the first user request pays the construction cost, and factories that call each other recurse forever. Lock per key, warm expensive services at startup, and detect a key already being built.

### Readiness checklist
<!--meta polarity=check-->

- Every service the code resolves has a registration, verified at startup from each module's declared keys without building lazy services, rather than discovered at call time
- The locator is injected rather than reached as an ambient global, so tests can substitute it
- Scoped services are resolved from a matching scope, never from the root or singleton locator
- The registered key set is bounded and reviewed, not a growing dumping ground of unrelated services

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Creation](../../../themes/object-creation.md) — Fetch shared services from a central registry when you need them. {#fluency-object-creation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Lazy Initialization](./lazy-initialization.md) — Services are typically created on first lookup, not at startup

**Alternative to**

- [Dependency Injection](./dependency-injection.md) — Push dependencies in vs. pull them from a registry
- [Provider](../../frontend/provider.md) — A service locator is the global-registry alternative to a scoped provider

**Often confused with**

- [Singleton](../creational/singleton.md) — A singleton is one class that is its own sole instance; a locator is a registry that returns many services by key, each with its own lifetime.

**Exposed to**

- [Static Cling](../../../hazards/static-cling.md) — Can fall into static cling when a static registry lookup hides dependencies behind a call that cannot be swapped
- [God Object](../../../hazards/god-object.md) — Can become a god object when one shared registry attracts every unrelated service

<!-- relationships:end -->
