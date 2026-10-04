---
title: Flyweight
description: Shares state to support huge numbers of objects
area: gof-structural
owner: Oleksandr Derechei
tags: [low-level-design, resource-management, immutability]
status: stable
aliases: [interning]
solves: [I am running out of memory holding millions of nearly identical objects, every one of my million particles carries its own copy of the same texture, the same string value is allocated thousands of times and it is bloating the heap, garbage collection is thrashing because I allocate a fresh object per grid cell, my forest scene has a million trees and each one duplicates the same mesh data]
---

# Flyweight

Pulls the identical, unchanging part of an object out into a single shared instance — so a million logical objects can ride on a handful of real ones in memory.

## What it is
<!--meta block=description-->

A flyweight splits an object's state into a shared part that never changes, such as a glyph shape or a tree mesh, and a per-use part the caller passes in, such as position or colour. A factory keeps one shared instance per distinct value. It prevents memory blowup when millions of objects carry identical heavy data.

## Explained
<!--meta block=explain-->

The flyweight pattern splits an object's data in two. The part that never changes and is the same for many objects is the intrinsic state, kept in one shared copy. The part that differs per use is the extrinsic state, which the caller passes in each time. A factory hands out the shared copy, so a million objects hold a small reference instead of a million full copies. That turns a cost per object into a cost per distinct value. Choose it when memory is the limit and the shared part is large next to the reference each object adds, and confirm the saving on the retained heap. When the shared part is small or most of each object is unique, plain objects that each hold their own copy are simpler.

- **Interface.** Every operation takes the varying data as parameters, spreading through call chains. Keep it in one small context object.
- **Mutability.** One write to the shared part corrupts every user at once, so make it read-only.
- **CPU.** Factory lookups cost time, so measure before and after.

**Example.** A forest has 1,000,000 trees of 5 kinds, and each kind has a 2 MB mesh and texture. Without sharing that is 2 TB. With a flyweight there are 5 shared kinds, 10 MB, and each tree is a reference to its kind plus x and y, about 16 bytes (an assumed 8-byte reference and two 4-byte coordinates), so 16 MB for the trees: 26 MB in all. The cost is that draw now needs x and y passed in, and a developer who changes a mesh or texture changes it for every tree of that kind.

## How it works
<!--meta block=structure-->

```mermaid caption="The factory hands out one shared flyweight per distinct intrinsic state; the client supplies the extrinsic state on every call."
flowchart LR
    C["Client"] -->|1 request a kind| F["Flyweight Factory"]
    F -->|2 reuse or create once| FW["Shared Flyweight"]
    C -->|3 pass extrinsic state| FW
    FW -->|4 operate| Out["Result"]
```

## Variations
<!--meta block=variations-->

- **Intrinsic / extrinsic split** — The core move: push everything context-free into the shared object, and pass everything context-dependent as arguments. How you draw the line decides how much you save.
- **Interning / canonicalization** — Keep exactly one canonical instance per distinct value — Java's `String` pool, small-integer caches, and `Boolean.TRUE` are flyweights by another name.
- **Factory-managed pool** — A factory caches shared instances by key and creates on first request, so callers never `new` a flyweight directly — often built as a [Factory Method](../creational/factory-method.md).
- **Shared vs. unshared flyweights** — The Gang of Four book (GoF) does not require every flyweight to be shared: unshared nodes can sit in the same structure as pooled ones, so a Composite tree can mix pooled and one-off nodes.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Cuts memory sharply** when many objects share the same unchanging data.
- **Fewer allocations mean less garbage-collector work** and better cache use.
- **Puts object creation in one factory** — a single place to cache and reuse instances.
- **The shared data never changes**, so many threads can read it safely at once.

### Cons
<!--meta polarity=con-->

- **Splitting the data complicates the API** — callers must pass the per-use part on every call.
- **The per-use part is recomputed or passed** each time — you trade CPU for memory.
- **Only pays off at scale** — for a few objects it's needless indirection.
- **The shared part must stay immutable** — one change corrupts every object using it.
- **The factory is shared state of its own** — a pool that pins every key leaks on an open key space and an unguarded get-or-create can build two copies of one key, so bound or weakly reference the pool and make lookup-and-create atomic.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need a very large number of objects** that mostly repeat the same data.
- **Memory, not CPU**, is the limiting constraint on the model.
- **The data splits cleanly** into a shared, unchanging part and a small per-use part.

### Avoid when
<!--meta polarity=avoid-->

- **You only have a handful of objects** — the indirection isn't worth it.
- **Most of each object is unique**, so there's little worth sharing.
- **The "shared" part actually needs to differ** or change per instance. If the objects must stay mutable and are costly to build, reuse whole objects instead ([Object Pool](../extra/object-pool.md)).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a forest of shared tree kinds"
// Intrinsic state — shared, immutable, context-free.
class TreeKind {
  constructor(
    readonly name: string,
    readonly mesh: string,     // heavy geometry, shared
    readonly texture: string,  // heavy bitmap, shared
  ) {}
  draw(x: number, y: number): void {
    // … render the shared mesh + texture at this position
  }
}

// The factory hands back one TreeKind per distinct look.
class TreeFactory {
  private readonly pool = new Map<string, TreeKind>();
  kindOf(name: string, mesh: string, texture: string): TreeKind {
    const key = `${name}|${mesh}|${texture}`;
    let kind = this.pool.get(key);
    if (!kind) this.pool.set(key, (kind = new TreeKind(name, mesh, texture)));
    return kind;
  }
}

// Extrinsic state — position — stays with each lightweight tree.
interface Tree { readonly x: number; readonly y: number; readonly kind: TreeKind; }

const forest = new TreeFactory();
const oak = forest.kindOf("oak", "oak.mesh", "oak.png");
const trees: Tree[] = [{ x: 1, y: 2 }, { x: 9, y: 4 }].map(p => ({ ...p, kind: oak }));
for (const t of trees) t.kind.draw(t.x, t.y); // extrinsic x, y passed in on every call
// a million trees can share this one TreeKind in memory
```

## In the wild
<!--meta block=wild-->

- **Java String pool** — String literals are interned automatically at class load and String.intern() adds a runtime string, returning one canonical instance per distinct value; the pool is a hash table whose bucket count is set with -XX:StringTableSize. {#wild-java-string-pool}
- **java.lang.Integer.valueOf** — Returns cached shared Integer instances for values in the range -128..127, so autoboxing there reuses objects rather than allocating; the upper bound is tunable via -XX:AutoBoxCacheMax (java.lang.Integer.IntegerCache.high). {#wild-java-integer-cache}
- **Python sys.intern** — Stores one shared copy of a str in the interpreter intern table so repeated identical values point at the same object; CPython auto-interns identifier-like literals, and manual interning speeds dict lookups and identity (is) comparisons. {#wild-python-sys-intern}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Intrinsic/extrinsic split** — Where you draw the line between shared, context-free state and per-use context passed on every call. A field with far fewer distinct values than objects belongs in the shared part; a field that differs per object stays passed in. More shared saves memory; more passed in costs the caller on every call.
- **Factory cache bound and eviction** — Whether the interning pool is capped and how it evicts or expires entries; an open-ended key space with no bound grows without limit.
- **Reference strength of pooled entries** — Strong references pin every distinct flyweight for the life of the factory; weak references let unused canonical instances be reclaimed by GC when no client holds them.

### Signals to watch
<!--meta polarity=signal-->

- **Distinct flyweight count / pool size** — Number of canonical instances the factory holds — the size of the interning map; a count that tracks total logical objects means sharing is not happening.
- **Reuse ratio** — Factory cache hits versus misses, or distinct keys versus total objects requested; a low ratio means the split shares little and the indirection is not paying off. Break-even: (objects minus distinct keys) times shared bytes per object must exceed objects times reference bytes plus the pool's own overhead; read the shared bytes and the pool overhead from signal 3.
- **Retained heap of the shared pool** — Memory held by the interning table and its shared instances, observed via a heap profiler — the quantity the pattern exists to shrink.
- **Lookup and per-call latency** — Time of the factory lookup and of the per-call operation, measured before and after sharing; a rise is the CPU paid for passing the per-use part in.

### Failure modes under load
<!--meta polarity=failure-->

- **Unbounded intern table** — A factory that caches every distinct key with strong references and never evicts leaks memory steadily when the key space is open-ended.
- **Mutated shared state** — If the intrinsic part is not truly immutable, one write corrupts every logical object that shares that instance, producing bugs that look impossibly non-local.
- **Miscalibrated split** — Too little pushed into the shared part yields indirection with no memory win; too much left extrinsic turns per-call recomputation of context into a CPU hot path.

### Readiness checklist
<!--meta polarity=check-->

- Confirm the intrinsic/shared part is deeply immutable before any instance is shared
- Measure the real reuse ratio (distinct keys vs total objects) to confirm sharing pays off at your scale
- Bound the factory cache or use weak references when the key space is open-ended
- Make factory lookup-and-create atomic if flyweights are requested from multiple threads

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Performance](../../../themes/performance.md) — Shrink memory by sharing immutable state. {#fluency-performance}
- [Object Structure](../../../themes/object-structure.md) — Share the unchanging part of many similar objects to save memory. {#fluency-object-structure}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Factory Method](../creational/factory-method.md) — A factory hands back shared flyweights
- [Composite](./composite.md) — Shared leaves let one tree hold millions of nodes cheaply
- [Interpreter](../behavioral/interpreter.md) — A grammar's repeated terminal symbols are shared, not duplicated per node
- [State](../behavioral/state.md) — Stateless state objects carry nothing per context, so one instance serves them all
- [Immutability](../../functional/immutability.md) — The shared part is read-only, so one copy can serve every object

**Often confused with**

- [Object Pool](../extra/object-pool.md) — Share immutable state vs. reuse whole objects

<!-- relationships:end -->
