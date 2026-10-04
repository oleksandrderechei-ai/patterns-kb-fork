---
title: Singleton
description: "Exactly one instance, globally accessible"
area: gof-creational
owner: Oleksandr Derechei
tags: [low-level-design, state-management, resource-management, lifecycle, decoupling]
status: stable
solves: [two parts of my app each opened their own connection pool and now I have double the connections, I am threading the same logger through five layers of constructors just to reach the bottom one, my config file gets read and parsed again every time another module needs a setting, something quietly created a second cache and the two copies disagree with each other, I need one shared object everywhere but I do not want a naked global variable]
---

# Singleton

Guarantees a class is instantiated exactly once and hands every caller that same shared object through a single global access point.

## What it is
<!--meta block=description-->

A singleton is a class that permits one instance of itself and gives the whole program a fixed way to reach it: a hidden constructor, a static field and an accessor such as `getInstance()`. It suits truly singular resources, such as a hardware handle or one connection pool. It is a controlled global variable, so overuse hides dependencies and blocks test isolation.

## Explained
<!--meta block=explain-->

A singleton gives the whole program one shared object without passing it around: the class hides its constructor and hands out its single instance through a static accessor. Choose it only for a resource that is truly one per process and holds no state that tests or requests need to keep separate, such as a logger. For everything else, create one instance where the app starts and pass it to whoever needs it, which gives the same single copy without the global access. The count is rarely the problem. The reach is: every class that calls the singleton depends on it without saying so, so tests share its state, pass or fail depending on order, and cannot swap in a fake.

- **Hidden coupling.** Callers depend on it without saying so, so let a container or your startup code own the instance and hand it in.
- **Not global.** Each process and server holds its own copy, so use a database or lock service for anything that must be unique across servers.
- **Racy creation.** Creating it lazily from two threads at once can make two, so create it at startup.

**Example.** A settings class is a singleton holding a theme name. Test A sets the theme to dark and finishes, and test B expects the default but sees dark. B passes alone and fails after A, so the suite goes red depending on order. Run on 3 servers, each holds its own settings, so a change made through one server never reaches the other two. The fix is to create one Settings at startup and pass it into each class that needs it. Tests then build a fresh one each, and any setting that must be shared across servers lives in a database.

## How it works
<!--meta block=structure-->

```mermaid caption="The class hides its constructor and hands out its own single instance through a static accessor. Every client that asks receives the same object."
classDiagram
    class Singleton {
        -static instance
        -constructor()
        +getInstance() Singleton
        +operation()
    }
    Client ..> Singleton : gets the one instance
```

## Variations
<!--meta block=variations-->

- **Eager initialization** — The instance is built at class-load time. Simplest and inherently thread-safe, but the object is created even if it's never used.
- **[Lazy initialization](../extra/lazy-initialization.md)** — The instance is created on the first `getInstance()` call, deferring expensive setup — at the cost of needing care under concurrency.
- **Thread-safe / [double-checked locking](../../concurrency/double-checked-locking.md)** — Guard the lazy creation with a lock and re-check inside it, so two concurrent callers can't each build an instance. On the JVM the shared field must be `volatile`, or another thread can see a half-built object.
- **Idiom-supplied singleton** — Some languages already solve the initialization race, so you write no guard by hand. A single-element `enum` in Java is constructed once, at class initialization, and is safe against serialization and reflection attacks; Effective Java calls it often the best way to implement a singleton. A function-local `static` inside the accessor does the same job in C++ since C++11, where the standard requires exactly one thread to run the initializer while the others wait; it is known as the Meyers singleton. Both leave the once-only guarantee to the runtime, so there is no lock and no double-check to get subtly wrong. You give up constructor arguments: neither form takes one, and the Java enum cannot extend a class.
- **[Monostate](../extra/monostate.md) (Borg)** — Allow many instances but back them all with shared static state, so every object behaves as one — uniqueness of state without uniqueness of object.
- **Module-level singleton** — In module systems the module is cached after first load, so a plain module-level value is a de facto singleton with none of the boilerplate.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Guarantees one authoritative instance** for something that really is single — a config, a connection pool, a logger.
- **Reachable from anywhere** without passing the object through every constructor and call.
- **Lazy creation** puts off expensive setup until the instance is first actually needed.
- **Controls creation**, so code outside the class cannot build a second instance by calling the constructor; an unguarded lazy race, reflection or serialization can still make one.

### Cons
<!--meta polarity=con-->

- **Hidden global state** — every user depends on the singleton without ever declaring it.
- **Hard to test**: shared mutable state leaks between test cases, and swapping in a mock is awkward.
- **It lives for the whole process**, so you can't cleanly scope, reset, or replace it per request.
- **Lazy creation** invites race conditions between threads if the guard is done carelessly.
- **Often just a global variable in disguise**, used where explicit wiring would be clearer.
- **The class takes on a second job** — policing how many of itself exist, on top of the work it was written for — which is why counting instances from the outside, in whatever assembles the application, is usually the cleaner split.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **There is genuinely only one of the resource** — a hardware device, an OS handle, one log sink.
- **An expensive, shared object** needs to be reused everywhere, like a connection pool. If it also holds a cache, bound the cache and add a test reset seam.
- **You need exactly one coordination point** per process that must never be duplicated; across servers use a database or lock service instead.

### Avoid when
<!--meta polarity=avoid-->

- **You only want convenient access** — prefer [Dependency Injection](../extra/dependency-injection.md) so dependencies stay visible and testable.
- **The object holds changing state** that tests or individual requests need to keep separate.
- **More than one configuration or scope is plausible** later — per-tenant, per-request, per-thread.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a lazily-created, single-instance app config"
interface Settings {
  readonly port: number;
  readonly env: "dev" | "prod";
}

class AppConfig {
  private static instance: AppConfig | null = null;
  readonly settings: Settings;

  // private is a compile-time check only: plain JS or a cast can still call new.
  private constructor() {
    this.settings = Object.freeze({
      port: Number(process.env.PORT ?? 8080),
      env: process.env.NODE_ENV === "production" ? "prod" : "dev",
    });
  }

  static getInstance(): AppConfig {
    return (AppConfig.instance ??= new AppConfig());   // built once, on first access; race-free only because JS runs one thread, so build eagerly on a threaded runtime
  }
}

// Every caller shares the one instance.
const a = AppConfig.getInstance();
const b = AppConfig.getInstance();
console.log(a === b);          // true
```

## In the wild
<!--meta block=wild-->

- **java.lang.Runtime** — Runtime.getRuntime() returns the one Runtime object for the Java virtual machine (JVM), held in a private static final field so creation is eager and race-free; the constructor is private, and the instance exposes process-wide operations like addShutdownHook and availableProcessors. {#wild-java-runtime}
- **Node.js module cache** — CommonJS caches a module in require.cache keyed by its resolved absolute path, so every require returns the same exports object; deleting the cache entry forces re-evaluation, which is how tests reset a module singleton. ES modules are likewise evaluated once per resolved specifier. {#wild-nodejs-module-cache}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Initialization timing** — Eager construction in a static field at class load has no first-access race; lazy construction on first access defers expensive setup but needs a concurrency guard. Eager still carries the static-initialization deadlock listed under failure modes. Prefer eager unless the object is costly and may go unused.
- **Thread-safe accessor strategy** — How concurrent first callers are serialized: a fully synchronized accessor, double-checked locking on a volatile field, or the initialization-on-demand holder idiom that leans on class-load semantics for lazy, lock-free init.
- **Reset / replacement seam** — A test-only hook to clear or swap the stored instance so each case starts clean. Without it the one instance persists for the whole process, including across an entire test suite.

### Signals to watch
<!--meta polarity=signal-->

- **Accessor lock contention** — If every getInstance() acquires a lock, threads block on that monitor under high call rates; visible as wait time on the lock in a contention profile.
- **Constructor invocation count** — Instrument the private constructor and count how often it runs; it must fire exactly once per class loader, or per resolved module path in Node. A second construction means the uniqueness guard is broken or the class was loaded twice.
- **Order sensitivity** — Run the suite in shuffled order and each case alone; a case that fails only after another points to state leaked through the instance.

### Failure modes under load
<!--meta polarity=failure-->

- **Duplicate instances from an init race** — Under concurrent first access, unsynchronized lazy creation lets two threads each construct one instance; the extras leak and cause intermittent, hard-to-reproduce inconsistency.
- **Static-initialization deadlock** — Two singletons that reference each other during static initialization can deadlock or expose a half-constructed instance, since class init holds a per-class lock until it completes.
- **State leaks across tests** — The process-wide instance carries mutable state from one test into the next, producing order-dependent flakiness that vanishes when a case runs in isolation.
- **Duplicate instances from a doubled module** — One module resolved from two paths, a second installed copy of a package, or a second class loader builds two instances; the constructor count above shows it.

### Readiness checklist
<!--meta polarity=check-->

- Confirm the resource is singular by nature — one device, one pool — not merely convenient to reach globally.
- Exercise first access from multiple threads and assert exactly one instance is constructed.
- Expose a reset or injection seam so tests can isolate the instance state.
- Bound any cache or collection the instance holds — it is never collected before the process exits.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Creation](../../../themes/object-creation.md) — Permit only one instance of a class and give it a well-known access point. {#fluency-object-creation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Lazy Initialization](../extra/lazy-initialization.md) — The classic lazily-created single instance
- [Abstract Factory](./abstract-factory.md) — A concrete factory is the classic single-instance object
- [Null Object](../extra/null-object.md) — A stateless do-nothing stand-in is the safest thing to share

**Alternative to**

- [Dependency Injection](../extra/dependency-injection.md) — A global instance vs. handing the instance in
- [Double-Checked Locking](../../concurrency/double-checked-locking.md) — A singleton needs one instance, and a holder class or once primitive gives it safely

**Often confused with**

- [Monostate](../extra/monostate.md) — Shared state vs. a single object — often conflated
- [Service Locator](../extra/service-locator.md) — A singleton fixes one class as its only instance; a service locator is a registry that returns many services by key.

**Prevents**

- [Improper Instantiation](../../../hazards/improper-instantiation.md) — The right lifetime for a broker that manages its own connections

**Exposed to**

- [Race Condition](../../../hazards/race-condition.md) — Can fall into race condition when lazy initialisation can create two instances when threads check at once
- [Static Cling](../../../hazards/static-cling.md) — Can fall into static cling when a global accessor is a static call that tests and callers cannot substitute

<!-- relationships:end -->
