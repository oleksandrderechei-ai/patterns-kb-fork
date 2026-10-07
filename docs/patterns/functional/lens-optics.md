---
title: Lens / Optics
description: A composable getter/setter into nested data
area: functional
owner: Oleksandr Derechei
tags: [low-level-design, composition, immutability, state-management, data-access]
status: stable
aliases: [functional references]
solves: [changing one field four levels down means a tower of spread operators I cannot read, I have written the same nested update in a dozen reducers and one of them has a typo, reshaping my state object forced me to fix every place that reaches into it, I want to bump one field inside every element of a nested array without hand-cloning the whole tree, reading a deep value needs a chain of optional checks and writing it needs a full rebuild]
---

# Lens / Optics

A lens pairs a getter and a setter for one field into a single composable value, so reading or immutably updating a field three levels deep takes one expression instead of a tower of nested spreads.

## What it is
<!--meta block=description-->

A lens pairs a get function, which reads one field of a nested structure, with a set function, which returns a new structure with that field replaced. Lenses compose, so the lens for `user.address.city` is built once from two smaller ones and reused. It replaces the unreadable spread tower that deep immutable updates need. Prisms and traversals extend the idea to variants and many elements.

## Explained
<!--meta block=explain-->

A lens is a pair of get and set bound to one path into nested data. Get reads the value at that path. Set returns a new copy of the whole structure with only that value changed, so the original is untouched. Lenses compose, so a lens to the address and a lens to the city join into one lens to the city. Choose it over nested copy-with-spread when the same deep path is read and updated in many places, or when the path is chosen while the program runs. For one or two levels a plain spread is clearer.

- **Extra concept.** It adds a concept and often a library, though a hand-written lens needs none; use it only for deep paths.
- **Unreadable type errors.** Composed lenses give long type errors, so annotate each lens with its types.
- **Call overhead.** Each call costs a little more than a property access, so measure it on hot paths.
- **Hidden path.** A lens hides a path that a spread shows, so name each one after what it points at.

**Example.** A settings object nests 4 levels deep, down to user.profile.address.geo.city. Updating the city with spreads takes 4 nested braces, repeated at 7 call sites, so 28 braces to maintain. Later the address moves from profile.address to profile.location. That is 7 edits with spreads, and one edit to the lens. With the lens, each call site reads set("Lviv", settings) and the structure stays untouched. The cost is one more concept for a newcomer to learn and a library to add, which is not worth it for a flat two-field object.

## How it works
<!--meta block=structure-->

```mermaid caption="Composing lensA (S to A) with lensB (A to B) yields one lens from S to B. A read drills straight down; a write rebuilds each ancestor bottom-up, leaving everything else untouched."
flowchart LR
    S["S, whole struct"] -->|lensA.get| A["A, nested field"]
    A -->|lensB.get| B["B, deeper field"]
    B -->|apply f| B2["B, new value"]
    B2 -->|lensB.set| A2["A, rebuilt"]
    A2 -->|lensA.set| S2["S, rebuilt"]
```

## Variations
<!--meta block=variations-->

- **Prism** — Focuses on one case of a sum type or discriminated union — `get` returns an optional value, and `set` only takes effect when the shape actually matches.
- **Traversal** — Targets zero or more foci at once, such as every element of an array, and lifts a single update across all of them in one pass.
- **Optional (affine traversal)** — A lens-and-prism hybrid with at most one focus that may or may not exist — an array index, a map key, an optional field.
- **Iso** — A lossless, reversible view between two equivalent representations — a wrapped newtype and its raw value, a tuple and a record — with no failure and no information loss.
- **Read-only optics** — Not every optic writes. A getter reads one focus and a fold reads many; both compose with the read-write optics through the same operators. Composing two kinds yields the weakest capability the pair share: a traversal composed with a getter is a fold, which reads the collection and cannot set anything through it. The loss shows only when you try to write.
- **Concrete pair vs. van Laarhoven encoding** — Optics can be plain `{ get, set }` objects, as in monocle-ts, or encoded as higher-order functions over a [functor](./functor.md) (a wrapper type with map) or a profunctor, the van Laarhoven style, which composes the same way for every optic kind but is harder to read and debug.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Replaces nested spread towers** with one composed, reusable accessor.
- **Composes exactly like the paths it targets** — build once, reuse everywhere that path is read or written.
- **One update**, view, and modify interface, so call sites don't hard-code the shape of the data.
- **Extends cleanly** to optional (Prism) and multi-focus (Traversal) access under the same composition rules.

### Cons
<!--meta polarity=con-->

- **Extra abstraction** — and often a library — for what a plain field access already does.
- **Composition-type errors**, especially in profunctor encodings, can produce unreadable inferred types.
- **A small per-call overhead** versus a raw property read or assignment; it grows with the number of levels copied, so profile hot updates before dropping the lens.
- **Overkill for shallow**, one- or two-level structures where a spread is already clear.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **State is deeply nested** and updated immutably from many places, like a large reducer or app state tree.
- **The same nested path** is read and written from more than a couple of call sites.
- **You want one reusable accessor whose definition** — not every call site — absorbs a future reshape of the data.

### Avoid when
<!--meta polarity=avoid-->

- **The structure is one or two levels deep** — a direct spread is already clear.
- **Mutation is safe and local**, and there's no immutability constraint to satisfy.
- **The team isn't fluent in functional composition** and a plain update helper would read better.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal composable lens"
interface Lens<S, A> {
  get(s: S): A;
  set(a: A, s: S): S;
}

const lens = <S, A>(get: (s: S) => A, set: (a: A, s: S) => S): Lens<S, A> =>
  ({ get, set });

function compose<S, A, B>(sa: Lens<S, A>, ab: Lens<A, B>): Lens<S, B> {
  return lens(
    (s) => ab.get(sa.get(s)),
    (b, s) => sa.set(ab.set(b, sa.get(s)), s),
  );
}

const over = <S, A>(l: Lens<S, A>, f: (a: A) => A, s: S): S =>
  l.set(f(l.get(s)), s);

interface Address { city: string }
interface User { address: Address }

const addressL: Lens<User, Address> =
  lens((u) => u.address, (a, u) => ({ ...u, address: a }));
const cityL: Lens<Address, string> =
  lens((a) => a.city, (c, a) => ({ ...a, city: c }));

const userCityL = compose(addressL, cityL);
const user: User = { address: { city: "Lviv" } };
const shouted = over(userCityL, (c) => c.toUpperCase(), user);

// Laws on cityL: get-set, set-get, set-set.
const a: Address = { city: "Lviv" };
console.assert(cityL.get(cityL.set("Kyiv", a)) === "Kyiv");
console.assert(cityL.set(cityL.get(a), a).city === a.city);
console.assert(cityL.set("Odesa", cityL.set("Kyiv", a)).city === cityL.set("Odesa", a).city);

// A prism focuses on one case of a union: get may miss, set leaves a miss unchanged.
interface Prism<S, A> { get(s: S): A | undefined; set(a: A, s: S): S }
type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };
const circleR: Prism<Shape, number> = {
  get: (s) => (s.kind === "circle" ? s.r : undefined),
  set: (r, s) => (s.kind === "circle" ? { ...s, r } : s),
};
```

## In the wild
<!--meta block=wild-->

- **Haskell lens** — Encodes lenses, prisms, traversals, and isos as van Laarhoven functions so every optic composes with ordinary (.) function composition; view (^.), set (.\~), and over (%\~) all operate through whichever optic you compose. {#wild-haskell-lens}
- **Monocle (Scala)** — Provides Lens, Prism, Optional, Traversal, and Iso values; GenLens (and the @Lenses annotation) generate optics from case-class fields, composed with andThen for deep immutable updates. {#wild-monocle}
- **monocle-ts** — Ports the optics family to TypeScript as composable get/set pairs over readonly data; helpers like Lens.fromProp and fromPath build optics from property keys, composing through the fp-ts ecosystem. {#wild-monocle-ts}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Optic kind** — A lens for a field that always exists, a prism for one variant of a sum type, an optional for a field that may be missing, a traversal for many targets.
- **How lenses are made** — Written by hand from a getter and setter, or generated by a library or generator from the data type.
- **Where they live** — Beside the data type they focus on, or in one module per domain. Beside the type keeps a rename in view.

### Signals to watch
<!--meta polarity=signal-->

- **Spread-copy depth** — Hand-written nested spread or copy expressions in code review show a spot where a lens would help.
- **Composition depth** — How many lenses chain in one expression. Long chains are hard to read and debug.
- **Allocation per update** — Objects copied on a hot update path, shown by a profiler.

### Failure modes under load
<!--meta polarity=failure-->

- **Lens law violation** — A hand-written lens whose set and get do not agree gives surprising results on composition. Test the get-set, set-get and set-set laws; set-set means setting twice equals setting the last value.
- **Silent miss on a prism** — A prism over a variant that does not match returns nothing and the update silently does nothing. Handle the miss on purpose.
- **Unfamiliar to the team** — Optic jargon in a codebase nobody else reads costs more than the nested updates it replaces.
- **Deep copy cost** — Updating through a deep path still copies each level on the way, and large collections make that slow.

### Readiness checklist
<!--meta polarity=check-->

- Each hand-written lens has a test for the get-set, set-get and set-set laws
- Optional and prism misses are handled in the calling code
- Lenses sit beside their data types
- The team has read the module's conventions, or plain updates are used instead

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Functional Programming](../../themes/functional-programming.md) — Read and replace a nested field through a reusable, composable value. {#fluency-functional-programming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Immutability](./immutability.md) — Optics update nested immutable data
- [Flux](../frontend/flux.md) — Targets one path inside a big reducer's state tree
- [Value Object](../ddd/value-object.md) — Replace a nested value object without a spread tower
- [Functor](./functor.md) — Traversals and the van Laarhoven encoding are built on map over a context

<!-- relationships:end -->
