---
title: Prototype
description: Clone an existing object instead of building new
area: gof-creational
owner: Oleksandr Derechei
tags: [low-level-design, lifecycle, extensibility]
status: stable
solves: [rebuilding this object costs another database round trip when I already have one just like it, I copied an object and then editing the copy silently changed the original too, I need fifty near-identical variations of a configured template where only two fields differ, "I am holding an object, I do not know its concrete class, and I need another one like it", every test case rebuilds the same expensive fixture from scratch and the suite crawls]
---

# Prototype

Builds a new object by copying a fully-formed example — cloning a configured instance instead of constructing one from scratch.

## What it is
<!--meta block=description-->

Building every object from scratch repeats a costly database read or parse, and a [factory subclass](factory-method.md) per variant adds a class for each one. A prototype creates a new object by copying an existing example, so the client asks it for a clone and gets the right concrete type without naming its class. Variants become examples you register at run time, which suits a class chosen only then.

## Explained
<!--meta block=explain-->

A prototype creates a new object by copying an existing one, so the client asks an example object for a copy and gets the right type back without naming its class. Keep a few pre-built examples, clone the one you need, and add or drop variants at run time by changing that set. Choose it over a constructor or a factory when building from scratch is expensive, such as a database read or a heavy parse, or when the concrete class is known only at run time. Where construction is cheap and explicit, a constructor tells the reader more than a clone call.

- **Copy rules.** Every type must copy itself, and a new field is easy to forget. Test that changing a clone leaves the original alone.
- **Shallow copies.** A copy that shares inner objects causes bugs far from the clone, so copy inner objects too.
- **Drifted examples.** A clone inherits whatever state the example has drifted into, so keep the examples unchanged.

**Example.** A game spawns goblins. Building one loads a model and balance numbers and takes 40 ms. A goblin prototype is built once and each spawn clones it in about 1 ms, so 50 goblins cost 90 ms (40 + 50) instead of 2,000 ms. The first version of the clone copies the goblin but shares its loot list. Goblin 1 picks up a sword and all 50 goblins now carry it. The fix is to copy the list inside the clone. A test that changes a clone's loot and checks the prototype's loot is unchanged would have caught it.

## How it works
<!--meta block=structure-->

```mermaid caption="The client depends only on the Prototype interface. It calls clone() and receives a copy of the concrete type without knowing which one it is."
classDiagram
    class Prototype {
      +clone() Prototype
    }
    class ConcretePrototype {
      +clone() ConcretePrototype
    }
    class Client
    Prototype <|.. ConcretePrototype
    Client --> Prototype : clone()
```

## Variations
<!--meta block=variations-->

- **Shallow vs. deep clone** — A shallow copy shares nested references; a deep copy duplicates the whole object graph. The right choice depends on which state must be independent.
- **Prototype registry** — A named manager holds ready-made prototypes so clients fetch and clone by key — variants become data you can register at runtime.
- **Copy constructor** — Instead of a `clone()` method, a constructor that takes an instance of the same class and copies its fields; it is idiomatic in C++. The caller must name the class, so a `clone()` method that calls the constructor is what lets a client copy without naming it.
- **Serialize-and-rebuild** — Round-trip through a serialized form (JSON, binary) to produce a detached deep copy without hand-writing per-field logic. JSON drops methods and the class, turns dates into strings and throws on cycles, so rebuild the typed object after reading.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Add or drop product variants** while the program runs, by registering example instances to copy.
- **Skips expensive setup** by copying an already-built instance instead of rebuilding it.
- **Produces complex, pre-configured objects** without needing to know their concrete class.
- **Avoids the parallel hierarchy** of factory subclasses that would otherwise mirror every product.

### Cons
<!--meta polarity=con-->

- **Deep-copying object graphs with cycles or shared resources** is error-prone. Track visited objects while copying, or rule cycles out.
- **Every type has to implement** its own clone correctly, or copies come out half-built. Test each clone against its original.
- **A clone can duplicate references** you meant to share, or share ones you meant to duplicate. Decide per field which it is.
- **Mutable state in the example**, such as an id, a timestamp or a cache, carries into the clone and ties it to the original. Reset those fields in the copy.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Building an object is expensive** and you already have a suitable instance to copy.
- **Which concrete class to create** is decided at runtime, not at compile time.
- **You need many objects that differ only slightly** from one configured template.

### Avoid when
<!--meta polarity=avoid-->

- **Objects are cheap to build directly** and carry no heavy setup. Compare the time to build with the time to clone the same object; the pattern pays only when the clone is much cheaper, as with the goblin's 1 ms against 40 ms.
- **Instances hold resources that can't be copied** — open sockets, file handles — so cloning is ambiguous.
- **A plain factory or builder** says what you mean more clearly than "copy this one."

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — cloning configured shapes from a prototype registry"
interface Cloneable<T> {
  clone(): T;
}

interface Style {
  readonly fill: string;
  readonly stroke: string;
}

// Setup is the expensive part. The registry entry below is built once; clone() copies the result.
class Shape implements Cloneable<Shape> {
  constructor(
    public x: number,
    public y: number,
    public style: Style,
    public points: readonly (readonly [number, number])[] = [],
  ) {}

  clone(): Shape {
    // copy the mutable style and the points array; the readonly tuples are safe to share
    return new Shape(this.x, this.y, { ...this.style }, [...this.points]);
  }
}

// A registry of ready-made prototypes to copy from.
const registry = new Map<string, Shape>();
registry.set("node", new Shape(0, 0, { fill: "#eee", stroke: "#333" }));

const copy = registry.get("node")!.clone();
copy.x = 120;                  // the stored prototype is untouched
```

## In the wild
<!--meta block=wild-->

- **Java Cloneable / Object.clone()** — Object.clone() is a protected native method that produces a field-by-field shallow copy; a class must implement the Cloneable marker interface or the call throws CloneNotSupportedException. Deep copies require overriding clone() to duplicate nested mutable state by hand, since the default only copies references. {#wild-java-cloneable}
- **Python copy module** — copy.copy() makes a shallow copy and copy.deepcopy() a deep one; deepcopy tracks already-copied objects in a memo dict so shared and cyclic references are reproduced once rather than recursing forever. A class customises either by implementing \_\_copy\_\_ or \_\_deepcopy\_\_ (the latter receives the memo). {#wild-python-copy}
- **Rust Clone trait** — Types implement Clone (usually via `#[derive(Clone)]`, which requires every field to be Clone) so .clone() yields an explicit, independent duplicate. It is distinct from Copy: Clone is always an explicit call and may be arbitrarily deep, whereas Copy is an implicit bitwise duplication for trivial values. {#wild-rust-clone-trait}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Shallow or deep copy** — Which fields copy by reference and which by value. Copy what the clone will edit and share what is immutable. Deep copy isolates the clone but costs more time and memory, and duplicates resources meant to be shared.
- **Copy method** — A copy constructor, a clone method, or a serialization round trip.
- **Registry of prototypes** — Named prototypes held in one place, versus passing the instance to copy.
- **Which fields reset on copy** — Identifiers, timestamps and caches that must not carry over.

### Signals to watch
<!--meta polarity=signal-->

- **Shared-reference bugs** — Edits to a copy appear in the original, which says a copy was shallow where it should be deep.
- **Copy time and size** — Time and memory per clone, from a profiler, for large objects.
- **Prototype count in the registry** — Entries held, and which are used.
- **Copy tests** — A test that edits a copy and checks the original is unchanged.

### Failure modes under load
<!--meta polarity=failure-->

- **Shared mutable state** — A shallow copy shares a list or map with the original and edits cross over.
- **Cycles** — A deep copy of a graph with cycles loops forever unless the copier tracks visited objects.
- **Duplicate identity** — A copy keeps the original's id and two records collide.
- **Subclass slice** — A clone method in the base class returns the base type and drops the subclass's fields.

### Readiness checklist
<!--meta polarity=check-->

- Each clone is tested for independence from the original
- Ids, timestamps and caches are reset in the copy
- Cyclic structures are handled or ruled out
- Subclasses override the copy method

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Creation](../../../themes/object-creation.md) — Make new objects by copying an existing instance. {#fluency-object-creation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Abstract Factory](./abstract-factory.md) — Registered prototypes are what a family factory clones on request

**Alternative to**

- [Factory Method](./factory-method.md) — Clone a configured instance vs. subclass to create
- [Builder](./builder.md) — Copy a configured example vs. assemble a new object step by step

<!-- relationships:end -->
