---
title: Functor
description: A type you can map a function over
area: functional
owner: Oleksandr Derechei
tags: [low-level-design, composition, abstraction, transformation]
status: stable
solves: ["I unwrap the value, change it, then wrap it back up again at every single call site", transforming something that might be missing means an if-null branch before every operation, each of my container types spells apply-a-function-to-the-contents differently, I want to change what is inside a collection without hand-writing a loop that rebuilds it, my helper only works on arrays and I have to duplicate it for the optional version]
---

# Functor

A functor is any wrapped or contextual value — a list, an optional, a future, a parse result — that lets an ordinary function reach inside and transform its contents through a single `map` operation, without the caller ever unwrapping it by hand.

## What it is
<!--meta block=description-->

Transforming a value trapped in a container means checking every case first, whether the array is empty, the option is None or the promise has settled, then re-wrapping the result. A functor is a container with a map operation that applies your plain function to what is inside and returns the same kind of container, so the checking lives in the type once.

## Explained
<!--meta block=explain-->

A functor is a container with a map operation. It applies your function to the value inside and returns the same kind of container, so you transform the value without opening the container. An array and an optional value are functors, and a promise is one only for callbacks that return plain values; the word names a shape, not one class. Without it you repeat the unwrapping and re-wrapping at every call site. Two laws keep map trustworthy: mapping the identity function changes nothing, and mapping f then g equals one map of both. Choose it over unwrapping and checking by hand when the value may be missing, late or many, and you want to transform it without repeating that check in every step.

- **Nested containers.** A function that itself returns a container gives one inside another, so use flatMap, which flattens them (see [monad](monad.md)).
- **No combining.** Map cannot join two separate containers, so use zip or an applicative, which applies a wrapped function to wrapped values.
- **Unchecked laws.** Most type systems skip them, so test them for your own type.
- **Per-type interface.** Languages without generics need the interface written again for each type.

**Example.** A user lookup returns an Option, which holds a user or nothing. You write find(id).map(u => u.name).map(s => s.trim()). If the user is missing, both steps are skipped and the result is nothing, so you wrote no null checks. Now you want the email, and a function emailOf(user) itself returns an Option. Mapping it gives an Option of an Option, which no later step can use directly. You switch that step to flatMap, which flattens it to one Option. The cost is that the chain now mixes map and flatMap, and you must pick the right one at each step.

## How it works
<!--meta block=structure-->

```mermaid caption="Any type that implements a lawful map conforms to the Functor shape. Array and Option do, and Promise does for plain-value callbacks, each preserving its own structure while transforming what's inside."
classDiagram
    class Functor {
        +map(f) Functor
    }
    Array ..|> Functor : implements
    Option ..|> Functor : implements
    Promise ..|> Functor : implements
```

## Variations
<!--meta block=variations-->

- **Covariant functor** — The default direction: `map` turns a `Functor<A>` and a function `A => B` into a `Functor<B>`. This is what `Array.map` and `Option.map` do. `Promise.then` behaves this way only for callbacks that return a plain value: hand it back a promise and the result is flattened rather than nested, which is exactly the structure a map is supposed to leave alone.
- **Contravariant functor** — `contramap` runs the other way: a function `B => A` becomes a transformation over `Functor<A>`, so the functor wraps consumers rather than producers. Encoders, predicates, and comparators are typical contravariant functors.
- **Bifunctor** — Maps two independent type parameters at once, each with its own function — a `Result<E, A>`'s error and success channels can be transformed separately with `bimap`.
- **Applicative functor** — Adds the ability to apply a wrapped function to a wrapped value, so two independently-wrapped values can be combined — something plain `map` alone cannot do.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One vocabulary** — `map` — works across arrays, optionals, futures, results, and any other lawful container.
- **Preserves the surrounding structure automatically**: map an array and get an array back, same length, same order.
- **The identity and composition laws** make chained maps predictable and safe to refactor or fuse, provided the mapped functions are pure.
- **Keeps unwrapping and rewrapping logic in one place** instead of scattered through every caller.

### Cons
<!--meta polarity=con-->

- **Cannot flatten or sequence** — `map` applies one unary function to what's inside, so it cannot flatten a nested wrapper, and dependent steps need `flatMap` (a monad).
- **Can't combine two separately-wrapped values** with `map` alone; that needs an Applicative.
- **The functor laws aren't enforced by most type systems**, so a "map" that silently breaks them still type-checks.
- **Without real generics or higher-kinded types**, the interface has to be faked per-type instead of shared.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You're transforming a value** that lives inside a list, optional, future, or similar context, and want to avoid manually unwrapping it first.
- **You're designing a small, generic library** and want the leanest lawful interface before reaching for Applicative or Monad.
- **You want callers to combine your type** with ordinary functions using one familiar method name instead of bespoke conversions.

### Avoid when
<!--meta polarity=avoid-->

- **The transformation also needs to flatten** a nested wrapper or run steps that depend on each other's result — that's a Monad's job.
- **You need to combine two independently-wrapped values** into one — reach for an Applicative instead.
- **The type has no real "contents" to transform**; forcing a map onto it adds ceremony without benefit.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a Box functor, plus the laws it should satisfy"
interface Functor<T> {
  map<U>(f: (value: T) => U): Functor<U>;
}

class Box<T> implements Functor<T> {
  constructor(private readonly value: T) {}

  map<U>(f: (value: T) => U): Box<U> {
    return new Box(f(this.value)); // transform inside, keep the shape
  }

  unwrap(): T {
    return this.value;
  }
}

const result = new Box(21)
  .map((n) => n * 2)
  .map((n) => `answer: ${n}`);

console.log(result.unwrap()); // "answer: 42"

// Functor laws, spot-checked at runtime:
function id<T>(x: T): T { return x; }
console.log(new Box(5).map(id).unwrap());                        // 5 — identity
console.log(new Box(5).map((n) => n + 1).map((n) => n * 2).unwrap());
console.log(new Box(5).map((n) => (n + 1) * 2).unwrap());        // same — composition
```

## In the wild
<!--meta block=wild-->

- **Haskell Functor typeclass** — Defines fmap :: (a -> b) -> f a -> f b, also exposed as an infix operator, as the single lawful operation over lists, Maybe, IO, Either, and every other instance. GHC can generate an instance mechanically via DeriveFunctor, while the identity and composition laws remain documented conventions the compiler never checks. {#wild-haskell-functor}
- **java.util.Optional** — Introduced in Java 8. Its map applies the function only when a value is present and wraps the result as if by ofNullable, so a mapper returning null collapses to an empty Optional instead of throwing — and flatMap exists separately for mappers that already return an Optional. {#wild-java-optional}
- **Rust Option and Iterator** — Option::map eagerly transforms the value inside Some, while Iterator::map is a lazy adapter whose closure runs only as elements are pulled, so a chain of maps runs in a single pass with no intermediate collections, the same result the composition law permits. {#wild-rust-option}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Eager vs lazy map** — Whether each map in a chain materializes a new container immediately or defers into a fused pipeline that runs once per element. Eager is simpler to reason about; lazy avoids intermediate allocations but changes when the mapped functions actually execute. Switch to lazy when profiling shows a chain of n stages over m elements allocating n×m intermediate items that show up in GC time.

### Failure modes under load
<!--meta polarity=failure-->

- **Impure functions break map fusion** — Rewriting .map(f).map(g) as one map of the composition is only safe under the composition law. If f or g logs, counts, or mutates, the fused version interleaves those effects differently and behavior silently changes.
- **Intermediate copies in long chains** — With an eager map, every stage of a chain over a large collection materializes a full new collection, so memory and garbage collection (GC) cost grow with chain length multiplied by collection size. Watch allocation rate and GC pause time in a heap profile.
- **Map-shaped APIs that do more than map** — An operation that also flattens or filters violates structure preservation. JavaScript Promise.then collapses a returned promise instead of nesting it, so refactors that assume the functor laws quietly change behavior.

### Readiness checklist
<!--meta polarity=check-->

- Property-test the identity and composition laws for every hand-written map; no mainstream type system checks them for you.
- Keep functions passed to map pure — move logging, counters, and mutation to an explicit iteration step.
- In hot paths, use a lazy pipeline or hand-fuse long map chains so large collections are not copied at every stage.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Functional Programming](../../themes/functional-programming.md) — Apply a plain function inside a wrapper without unwrapping it. {#fluency-functional-programming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Pipeline / Composition](./pipeline.md) — map turns a stage into a lawful, fusable step
- [Immutability](./immutability.md) — map returns a new wrapper, never touching the original
- [Currying](./currying.md) — A curried map is the transformer waiting for its container
- [Lens / Optics](./lens-optics.md) — Optics generalize map to nested, many-focus targets

**Generalizes**

- [Monad](./monad.md) — Every monad is a functor with more structure

<!-- relationships:end -->
