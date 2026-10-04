---
title: Lazy Initialization
description: Defers creating something until it's first needed
area: gof-extra
owner: Oleksandr Derechei
tags: [low-level-design, lifecycle, latency]
status: stable
aliases: [lazy loading, lazy init]
solves: [my app takes forty seconds to boot because it builds everything up front, I pay to build a huge in-memory index that most runs never touch, startup dies on a connection to a service this code path does not even use, I cannot build this in the constructor because its config is not loaded yet, the same expensive parse runs again every single time the field is read]
---

# Lazy Initialization

Holds off building a value until something first asks for it — then creates it once, caches it, and hands back the same instance ever after.

## What it is
<!--meta block=description-->

Building every value at startup slows boot and pays for objects a run never uses. Lazy initialization defers each build until the first time something needs it: an accessor checks whether the value exists, creates and stores it if not, and returns the cached copy on every later call. The cost does not vanish; it moves to the first caller.

## Explained
<!--meta block=explain-->

Lazy initialization builds a value the first time something asks for it, stores it, and returns the stored copy on every later request. It saves startup time and skips work for features a given run never touches. Choose it over building the value at startup only when construction is expensive and many runs never use the value. Otherwise a plain value set at construction is simpler and easier to reason about.

- **Slow first caller.** The first caller pays the whole build time, so warm the value on a background thread if that wait is too long.
- **Racing builds.** Two callers arriving at once can both build it, so use your language's built-in once-only lazy holder, not a hand-written lock check.
- **Late errors.** Setup errors appear mid-request, so decide whether a failed build is cached or retried, and log a failure at once.

**Example.** A service has a 400 MB search index that 30 percent of requests use. Built at startup, it adds 20 s to every boot and holds 400 MB in every instance. Built lazily, the 70 percent of requests that skip search never pay, but the first search takes 20 s. Nearly every instance soon sees a search and holds 400 MB anyway; the gain is the faster boot. Two searches arriving together both start a load, so memory briefly reaches 800 MB. A built-in once-only lazy holder makes the second search wait. A background load at boot hides the 20 s from searches after it finishes and logs a load error at once, but every instance holds 400 MB again.

## How it works
<!--meta block=structure-->

```mermaid caption="First access runs the factory and caches the result. Every later access short-circuits straight to the cached value."
flowchart TB
    A["access the value"] -->|"on access"| B{"built yet?"}
    B -->|"no"| C["run factory once"]
    C -->|"produce"| D["cache the result"]
    D -->|"return"| E["return value"]
    B -->|"yes"| E
```

## Variations
<!--meta block=variations-->

- **Lazy field / lazy getter** — A nullable backing field with a check-then-create accessor — the simplest form, inlined right where the value is read.
- **Memoized holder** — A reusable `Lazy<T>` wrapper that takes a factory, runs it at most once, and caches the outcome behind a clean `get()`.
- **Thread-safe lazy (double-checked locking)** — Guards the first-access race so two threads don't both build the value — a fast unlocked check followed by a locked one. It is safe only when the unlocked read is a volatile or atomic read; without that a thread can see a half-built object, so prefer your language's once-only primitive.
- **[Virtual Proxy](../structural/proxy.md)** — A stand-in with the real object's interface that loads the heavy subject only when a method is actually called.
- **[Lazy Singleton](../creational/singleton.md)** — The single shared instance is created on the first `getInstance()` rather than at class-load time.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Faster startup** — work for features a given run never touches is simply never done.
- **Spreads costly setup out** across the run instead of one big spike at launch.
- **Lets a value wait** until the things it needs actually exist.
- **A natural fit for expensive or rarely-used resources**.

### Cons
<!--meta polarity=con-->

- **A small check on every read** — every read pays an "is it built yet?" check.
- **The first access is slow** — a latency spike that building up front would have hidden; under a locking mode every caller arriving during the build waits too, so warm the value at startup or on a background thread.
- **If two threads reach it first at once**, they can race and build it twice unless you add locking.
- **Building at read time hides setup and errors**, so failures surface late instead of at startup.
- **Once several deferred values reference each other**, whichever one a caller touches first decides the order they all get built — an ordering nobody wrote down and easy to get subtly wrong.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Building the value is expensive** and some runs never need it at all.
- **The inputs it depends on aren't ready yet** when the object is created.
- **You want a fast startup** and can accept paying the cost on first use.

### Avoid when
<!--meta polarity=avoid-->

- **The value is always needed** — building it up front is simpler and more predictable.
- **Construction is cheap**, so the deferral guard costs more than it ever saves.
- **You'd rather a broken setup fail at startup** than surprise you on first access.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a reusable lazy holder built on a closure; single-threaded, synchronous factory, no locking"
// A small holder that runs its factory until it succeeds, then caches.
function lazy<T>(factory: () => T): () => T {
  let cached: T;
  let built = false;
  return () => {
    if (!built) {
      cached = factory();  // run the factory the first time only
      built = true;        // and remember we did
    }
    return cached;
  };
}

interface RulesTable {
  readonly lookup: (key: string) => number;
}

// Parsing the rules is costly, so defer it until someone asks.
const rules = lazy<RulesTable>(() => {
  console.log("parsing rules table…");  // prints once, on the first successful build
  const table = new Map([["standard", 1], ["priority", 3]]);
  return { lookup: (key) => table.get(key) ?? 0 };
});

// Built on the first call here; every later call reuses the same table.
export const weightOf = (tier: string): number => rules().lookup(tier);
```

## In the wild
<!--meta block=wild-->

- **Kotlin by lazy** — A property delegate that runs its initializer on first read and caches the result. The default LazyThreadSafetyMode is SYNCHRONIZED (safe under concurrent first access); PUBLICATION and NONE relax that for single-threaded or performance-sensitive cases. {#wild-kotlin-lazy}
- **.NET Lazy\<T>** — Wraps a factory so the value is built on first access to the Value property. The LazyThreadSafetyMode argument selects between None, PublicationOnly, and ExecutionAndPublication (full locking, the default). The default builds the value at most once. PublicationOnly lets several threads run the factory, and the first to finish wins while the other results are discarded. {#wild-dotnet-lazy}
- **Python functools.cached_property** — Computes the property on first access and stores it in the instance \_\_dict\_\_ so later reads bypass the descriptor entirely. Since Python 3.12 it is not thread-safe for concurrent first access, because the per-property lock earlier releases held was removed. It also requires the instance to have a writable \_\_dict\_\_ (no \_\_slots\_\_ without \_\_dict\_\_). {#wild-python-cached-property}
- **Hibernate lazy loading** — Collection associations (@OneToMany, @ManyToMany) default to FetchType.LAZY, while to-one associations (@ManyToOne, @OneToOne) default to EAGER. A lazy association is a proxy or lazy collection that issues the database fetch only when first touched. Touching it after the persistence session has closed throws LazyInitializationException, and naive iteration is the classic source of N+1 queries. {#wild-hibernate-lazy}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Thread-safety mode** — Whether the guard synchronizes first access. Real named surfaces: .NET LazyThreadSafetyMode (None / PublicationOnly / ExecutionAndPublication) and Kotlin LazyThreadSafetyMode (SYNCHRONIZED / PUBLICATION / NONE). SYNCHRONIZED is safe but serializes first access; NONE is fastest but unsafe under concurrency. Defaults are Kotlin SYNCHRONIZED and .NET ExecutionAndPublication. PUBLICATION and PublicationOnly can run the factory more than once, so use them only when the factory has no side effects.
- **Eager warm-up** — A generic dial to force construction at startup (or on a background thread) rather than on the first hot-path request, trading fast startup back for predictable first-access latency.
- **Failure caching policy** — Whether a factory that throws caches the failure permanently or lets the next access retry. Determines if one transient error at first use poisons the value for the process lifetime. Cache deterministic failures such as bad configuration; retry transient ones such as a network error, with a bounded count or delay so every caller does not rerun an expensive factory. In .NET, with a factory method, ExecutionAndPublication and None cache the exception and PublicationOnly does not, so the thread-safety mode also sets this policy.

### Signals to watch
<!--meta polarity=signal-->

- **First-access latency** — The one-time construction cost paid by whichever request touches the value first. It shows right after a deploy or scale-out, not in steady state; at volume one slow request per process barely moves p99, so time the factory itself and emit its duration.
- **Lazy-load fetch count** — For object-relational mapper (ORM) lazy associations, the number of deferred queries issued per request; a sudden multiple of the row count is the N+1 signature.
- **Factory run count** — How many times the factory has run per process for a once-only value; more than one is the race signature, and a count that rises after errors means a retry policy is firing.

### Failure modes under load
<!--meta polarity=failure-->

- **First-access latency spike** — Eager init would have absorbed the cost at startup; deferred, the first request after boot (or after a cache miss) stalls building the connection pool, index, or parsed config.
- **Concurrent first-access race** — Two threads hit the unbuilt value together; without a thread-safe mode both run the factory, producing duplicate objects or a torn write.
- **N+1 lazy loading** — An ORM proxy issues one query per element while iterating a lazily-loaded collection, turning one logical read into hundreds of round trips.

### Readiness checklist
<!--meta polarity=check-->

- Thread-safety mode is chosen deliberately for the expected concurrency at first access
- The factory's measured duration on a cold boot is under the request timeout, or the value is warmed at startup
- Decide whether a failed initialization is cached or retried on the next access
- For ORM lazy loading, confirm iteration does not fan out into N+1 queries

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Creation](../../../themes/object-creation.md) — Defer building a value until the first moment it is needed. {#fluency-object-creation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Proxy](../structural/proxy.md) — A virtual proxy defers creation until first use
- [Singleton](../creational/singleton.md) — The classic lazily-created single instance
- [Service Locator](./service-locator.md) — A registry usually builds each service the first time it is asked for

**Alternative to**

- [Double-Checked Locking](../../concurrency/double-checked-locking.md) — Lazy initialization is the wider idea, and a once primitive is the safe way to do it

**Exposed to**

- [N+1 Query](../../../hazards/n-plus-1-query.md) — Can fall into n plus 1 query when loading related data on first touch fires one query per row
- [Race Condition](../../../hazards/race-condition.md) — Two first callers both run the factory and build the value twice unless a once primitive guards it

<!-- relationships:end -->
