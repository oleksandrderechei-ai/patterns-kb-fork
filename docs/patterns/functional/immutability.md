---
title: Immutability
description: Never mutate — always return new data
area: functional
owner: Oleksandr Derechei
tags: [low-level-design, state-management, immutability]
status: stable
aliases: [immutable objects, immutable data]
solves: [something I passed into a function came back changed and I never asked for that, two parts of my code hold the same object and one keeps stomping on the other, I clone everything defensively before handing it out and I still miss a spot, adding undo is impossible because the previous state is already overwritten, my cached value silently drifted after someone edited the object I cached]
---

# Immutability

Never mutates data in place — every change produces a brand-new value, so every existing reference to the old one stays exactly as it was.

## What it is
<!--meta block=description-->

When two parts of a program hold the same object and either can change it, one caller edits what the other assumed was stable. Immutability means a value never changes after creation: an update returns a new value and the old one stays valid, so there is nothing to defend against and no defensive copying, provided immutability is enforced all the way down.

## Explained
<!--meta block=explain-->

Immutability means you never change data in place. A change produces a new version, and the old one stays as it was. Whoever holds the old version cannot be surprised by a change from somewhere else, you can keep earlier versions for undo, and checking whether something changed is a quick same-object test. This removes defensive copying, the habit of cloning data before handing it out, which is easy to forget where it matters. Real systems share the unchanged parts of the old version with the new one, so a change is a small allocation, not a deep copy. Choose it over changing in place when data is shared between threads, components or history.

- **Allocation per change.** Copying everything is slow, so share unchanged parts between versions and copy only the changed path.
- **Library needed.** Large structures need a persistent collection library built for that sharing.
- **Edge conversion.** Mutable libraries and databases sit at the edge, so convert once at the boundary.
- **Unenforced by default.** Use readonly types, freeze objects in development and add a lint rule.

**Example.** An app keeps 10,000 items in state and changes it 1,000 times a second. Copying the array on each change moves 10,000 x 1,000 = 10 million elements a second. A persistent vector with 32 children per node is 3 levels deep, so a change copies about 3 x 32 = 96 elements and shares the rest. You keep the old version for undo by holding one reference. A change check is old === new, one comparison instead of comparing 10,000 items. The cost is the library: you give up plain arrays, and every call into code that expects one needs a conversion.

## How it works
<!--meta block=structure-->

```mermaid caption="An update never edits v1 — it produces v2 and shares whatever structure didn't change. Callers still holding v1 see nothing move under them."
flowchart LR
    Old["v1, original object"] -->|"passed to"| Update["update(field)"]
    Update -->|"produces"| New["v2, new object"]
    Old -.->|"still valid, untouched"| CallerA["Caller A holds v1"]
    New -.->|"sees the change"| CallerB["Caller B holds v2"]
    Old -->|"shares unchanged"| Shared["Shared internal structure"]
    New -->|"reuses"| Shared
```

## Variations
<!--meta block=variations-->

- **Persistent data structures** — Trees, vectors, and hash maps built so that "updating" one node shares every other node with the previous version — an update stays cheap even for large, deeply nested data.
- **[Copy-on-write](../concurrency/copy-on-write.md)** — Keep a single mutable buffer until it's shared with a second owner, then copy on the next write. Cheap in the common single-owner case, immutable in effect from every reader's view.
- **[Value Object](../ddd/value-object.md)** — The domain-modeling face of immutability: an object with no identity, compared by its contents, that's simply never mutated after construction.
- **Freezing / defensive typing** — `Object.freeze`, `readonly` fields, or a language's built-in immutable-by-default types enforce the discipline instead of relying on convention.
- **[Lens / Optics](./lens-optics.md)** — Since nothing can be changed in place, optics give you composable, type-safe operations for "update this one nested field" without hand-writing a spread at every level.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Eliminates whole classes of bugs** from aliasing and shared mutable state, wherever the type system or freezing actually enforces it.
- **Safe to share across threads or async tasks** without locks: the value itself needs no lock, though swapping which version is current still needs one atomic reference.
- **Equality, hashing, and caching become trivial**; an immutable value is a safe map key forever.
- **Undo, redo, and time-travel debugging** are cheap to build: old versions are kept, at the memory cost of the versions you retain.

### Cons
<!--meta polarity=con-->

- **Every "change" allocates** — naive implementations copy far more than they need to.
- **Deep or large structures** need persistent, structurally-shared implementations, or updates get slow.
- **Constant translation at the boundary with mutable-by-default libraries**, ORMs (object-relational mappers), and APIs.
- **Without a type system or freezing** to enforce it, "immutable" degrades to "please don't mutate this." `Object.freeze` is shallow and `readonly` is erased at runtime, so neither stops a mutation through a cast or a nested field.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **State is shared across threads**, async callbacks, or components that must not stomp on each other.
- **You need reliable equality checks**, memoization, or safe caching by value.
- **History matters as much as the present** — undo/redo, audit trails, event-sourced systems.

### Avoid when
<!--meta polarity=avoid-->

- **The data is large and mutated extremely often**, and copying would be a genuine bottleneck — tight numeric loops, big in-memory buffers.
- **A single owner mutates a value** in a narrow, well-understood scope that no one else can observe mid-mutation, such as a local mutable builder inside a function that returns an immutable value. [Thread Confinement](../concurrency/thread-confinement.md) is the neighbour for wider cases.
- **The runtime gives you no cheap way** to share structure, so copying everything each time is wasted work.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an immutable cart update"
interface CartItem {
  readonly id: string;
  readonly priceCents: number;
}

interface CartState {
  readonly items: ReadonlyArray<CartItem>;
  readonly total: number;
}

function addItem(state: CartState, item: CartItem): CartState {
  return {
    items: [...state.items, item],   // new array (O(n) copy); old one untouched
    total: state.total + item.priceCents,
  };
}

const v1: CartState = { items: [], total: 0 };
const v2 = addItem(v1, { id: "sku-1", priceCents: 500 });

v1.items.length; // 0 — v1 never changed
v2.items.length; // 1 — v2 is a distinct object
v1 === v2;        // false — no shared identity

// A runtime guard on top of the type-level one. Shallow: it freezes v1 only, not v1.items.
Object.freeze(v1);
```

## In the wild
<!--meta block=wild-->

- **Clojure** — Every core collection is a persistent data structure built on hash array mapped tries; assoc and conj return a new value sharing the untouched nodes with the old, and transients give a controlled mutable window for batch builds before returning to immutability. {#wild-clojure}
- **Immer** — produce(base, draft => …) records mutation-looking edits against a Proxy draft and returns a new frozen state that structurally shares the untouched parts; setAutoFreeze toggles the freeze cost, and produceWithPatches emits the diff for undo/redo or sync. {#wild-immer}
- **Immutable.js** — Persistent List, Map, and Set backed by hash array mapped tries and bit-partitioned vector tries; withMutations batches several edits without allocating each intermediate, and value-based equals/hashCode make an immutable collection a stable map key. {#wild-immutable-js}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Structural sharing vs. deep copy** — Whether an "update" allocates a small delta against a shared persistent structure or deep-copies the whole value. Naive copy is fine for small flat records; large or deeply nested data needs structural sharing or every write copies the world.
- **Auto-freeze** — Freezing produced values (Object.freeze, a readonly type, or a library's auto-freeze switch) turns accidental mutation into a thrown error, at the cost of walking the new structure on each update. Common to enable in development and at boundaries, and disable on hot production paths.
- **Batched updates** — Coalescing several field changes into one new-value production, instead of one allocation per set, to keep intermediate garbage down in hot paths (e.g. a transient or withMutations window that returns to immutable at the end).
- **Retained-history depth** — How many past versions you keep alive — undo-stack length, snapshot count, versions held by a value-keyed cache. Each retained version pins its structure in memory until released.

### Signals to watch
<!--meta polarity=signal-->

- **Allocation rate / minor-GC frequency** — Immutable updates allocate; a hot path that rebuilds state per event drives up allocation rate and how often the collector runs a minor cycle.
- **Garbage collection (GC) pause time (p99)** — Time spent in garbage collection, especially pause duration — the direct latency cost of high allocation churn from copying on every change.
- **Retained (live) heap** — Live-set size over time: retained old versions — undo history, caches keyed by value — keep memory pinned until nothing references them and it can be reclaimed.

### Failure modes under load
<!--meta polarity=failure-->

- **Unbounded memory from retained versions** — Holding references to old immutable versions — an ever-growing undo stack, a cache that never evicts — never lets the collector reclaim them. Memory climbs steadily until it hits the ceiling; it looks like a leak but is retention by design.
- **Allocation storm in hot loops** — Naive copy-on-every-change inside a tight loop or a per-event handler turns one logical update into a full-structure copy each iteration, spiking allocation rate and GC pressure well before the logic itself is the bottleneck.
- **Boundary translation cost** — Constantly converting between immutable structures and the mutable shapes an ORM, JSON serializer, or DOM API expects — deep freeze/thaw at the edge — can dominate the actual work on high-throughput paths.

### Readiness checklist
<!--meta polarity=check-->

- Profile one update on your largest state; if it copies more than the changed path, switch to a persistent structure and keep naive copy for small, flat records.
- Bound every retained-version store — undo stacks, snapshot lists, value-keyed caches — so old versions can be collected.
- Confirm hot loops and per-event handlers don't deep-copy a whole structure per iteration; batch updates where they do.
- Make freezing an explicit decision per environment (on in dev and at boundaries, off on hot paths), not an accident.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Functional Programming](../../themes/functional-programming.md) — Treat values as unchangeable and return a new one for every update. {#fluency-functional-programming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Event Sourcing](../architecture/event-sourcing.md) — Events are append-only and never mutated
- [Value Object](../ddd/value-object.md) — Value objects are immutable by nature
- [Memento](../gof/behavioral/memento.md) — Immutable snapshots make undo trivial
- [Actor Model](../concurrency/actor-model.md) — No shared mutable state to guard
- [Lens / Optics](./lens-optics.md) — Optics update nested immutable data
- [Functor](./functor.md) — Every map yields a fresh container instead of mutating
- [Make Illegal States Unrepresentable](../../principles/make-illegal-states-unrepresentable.md) — An immutable value stays as valid as it was when built
- [DTO](../enterprise/dto.md) — A DTO is the everyday carrier that is built once and never changed
- [Builder](../gof/creational/builder.md) — A builder assembles a many-field immutable object before it is frozen
- [Flyweight](../gof/structural/flyweight.md) — Flyweight puts one never-changed copy behind many objects
- [Pipeline / Composition](./pipeline.md) — Pipelines of pure stages are the usual way to chain transformations of immutable values

**Alternative to**

- [Thread Confinement](../concurrency/thread-confinement.md) — Keeps shared state safe by never changing it after creation, so any thread may read it

**Generalizes**

- [Copy-on-Write](../concurrency/copy-on-write.md) — Copy-on-write is the lazy implementation strategy that makes immutability affordable on large structures

**Prevents**

- [Race Condition](../../hazards/race-condition.md) — Data that never changes in place has nothing for two threads to race over

**Demonstrated by**

- [Logging Service](../../designs/logging-service.md) — immutability turning shared state into safe-to-share state is the property the concurrency design rests on
- [BookMyShow](../../designs/bookmyshow.md) — immutable records make the concurrent booking path safe to reason about
- [Bitly](../../designs/bitly.md) — Immutable mappings let three cache tiers stack with no consistency argument at each boundary
- [Rate Limiter](../../designs/design-rate-limiter.md) — A small result object kept immutable so concurrent callers never see a half-updated answer

<!-- relationships:end -->
