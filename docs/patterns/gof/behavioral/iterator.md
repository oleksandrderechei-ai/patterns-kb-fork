---
title: Iterator
description: Traverses a collection without exposing its structure
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, abstraction, encapsulation, decoupling]
status: stable
aliases: [Cursor]
solves: [my class has to expose its internal array just so callers can loop over it, I swapped a list for a tree and every loop in the codebase broke, I load a million rows into memory just to process them one at a time, callers keep reimplementing the same walk because I only offer one order, two parts of my code loop over the same collection and clobber each others position]
---

# Iterator

Hands the client one element at a time through a uniform cursor — hasNext, next — so a list, a tree, or a streamed result set all traverse the same way while their internals stay sealed.

## What it is
<!--meta block=description-->

Code that loops by indexing an array or chasing node pointers is tied to that storage, so swapping it for a tree, a set or a paged query breaks every loop. An iterator holds the walk position and offers a small next-and-done protocol, so the same client code walks anything. Each iterator keeps its own cursor, so several walks can run at once.

## Explained
<!--meta block=explain-->

An iterator is a small object that walks a collection one element at a time and remembers its own position, so callers never learn how the collection stores its items. It offers next() and a way to tell it has run out. Choose it over an index loop when callers should not know how items are stored, such as an array today and a tree or a paged remote list tomorrow. Also choose it when one collection needs several walk orders. Over a small fixed array a plain loop reads better.

- **Changes mid-walk.** The position is valid only while the collection stays the same. Walk a copy, or collect changes and apply them after the loop.
- **Hidden rules.** A hand-written iterator hides call order, running out and reuse. Use built-in generators and document whether a finished iterator can restart.
- **Extra object.** Each walk allocates a cursor and adds a layer of indirection. Over a small fixed array, keep the plain index loop.

**Example.** A playlist array holds \[A (3 min), B (1 min), C (1 min)\] and a loop deletes every track under 2 minutes. The cursor reaches index 1, deletes B, and the array shifts to \[A, C\]. The cursor moves to index 2, which no longer exists, and the loop ends. C is also short but was never checked. Some iterators are fail-fast and throw a modification error instead, but they cannot always notice the change. The fix is to collect the titles to delete (B and C) during the walk and delete them after it. The cost is one extra list held in memory.

## How it works
<!--meta block=structure-->

~~~mermaid caption="The client pulls elements one at a time until `hasNext()` reports the walk is exhausted. The iterator owns the position and reads from the aggregate, which never exposes its internals."
sequenceDiagram
    autonumber
    participant C as Client
    participant A as Aggregate
    participant I as Iterator
    C->>A: createIterator()
    A-->>C: iterator (cursor at start)
    loop until exhausted
        C->>I: hasNext()
        alt more elements
            I-->>C: true
            C->>I: next()
            I->>A: read current element, advance
            I-->>C: element
        else exhausted
            I-->>C: false
        end
    end
~~~

## Variations
<!--meta block=variations-->

- **External (active) iterator** — The client drives the walk, calling `next()` when it's ready. Maximum control — you can pause, interleave, or stop early.
- **Internal (passive) iterator** — The collection drives the walk and calls back into client code, like `forEach`. Less flexible, but the traversal logic lives in one place.
- **Lazy / generator iterator** — Elements are built on demand, not all at once, so an endless or streamed sequence never has to fit in memory. The source stays open until the walk ends or the iterator is closed.
- **Bidirectional & random-access** — A richer cursor adds `prev()` or index jumps, trading the minimal contract for the ability to move both ways.
- **[Composite traversal](../structural/composite.md)** — One iterator walks a tree of nodes uniformly, hiding whether each node is a leaf or a branch.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Callers walk any collection through one interface**, without knowing how it's stored.
- **The collection's storage stays hidden**, so you can swap it for a tree, a set or a paged query without editing callers, though order and mutation rules still show.
- **Several independent cursors** can run over the same collection at once, as long as the collection is not changed while they run.
- **A new traversal order** is just a new iterator, not a change to the calling code.

### Cons
<!--meta polarity=con-->

- **It adds an extra object** and a layer of indirection for what a plain index loop would do.
- **Changing the collection mid-walk** can invalidate the cursor; walk a snapshot, use the iterator's own `remove()` where it has one, or apply changes after the walk.
- **A hand-rolled iterator exposes subtle rules** — call order, when it's exhausted, whether it can be reused; use the language's built-in generator or iterable protocol and document whether a finished iterator can restart.
- **Over a tiny fixed array** it's ceremony with little payoff.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Callers must walk a collection** without knowing how it stores its elements.
- **The same code should walk several different structures** interchangeably.
- **You want more than one traversal** running at once, or several traversal orders.

### Avoid when
<!--meta polarity=avoid-->

- **The structure is a small, fixed array** that a direct loop reads plainly.
- **The language already gives you iteration** you'd only be wrapping.
- **Callers need operations only the concrete collection offers**, such as keyed lookup or sorted ranges; give them the collection itself.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a collection that plugs into for…of via Symbol.iterator"
class Playlist implements Iterable<string> {
  private readonly tracks: string[] = [];

  add(title: string): void {
    this.tracks.push(title);
  }

  // Expose the traversal without revealing the backing array
  *[Symbol.iterator](): Iterator<string> {
    for (const title of this.tracks) {
      yield title;
    }
  }
}

const playlist = new Playlist();
playlist.add("Come Together");
playlist.add("Dreams");

// The generator makes it work with for…of, spread, and destructuring
for (const track of playlist) {
  console.log(track);
}

const titles = [...playlist];   // ["Come Together", "Dreams"]
```

## In the wild
<!--meta block=wild-->

- **java.util.Iterator** — The hasNext()/next()/remove() contract every Java collection returns. Most collection iterators are fail-fast: they track a modCount and throw ConcurrentModificationException if the collection is structurally changed mid-walk. The for-each loop desugars to this interface. {#wild-java-iterator}
- **Python generators** — A function containing yield returns a generator implementing \_\_iter\_\_/\_\_next\_\_; each next() runs to the following yield and suspends, so elements are produced lazily. next() raises StopIteration at the end, and close() releases resources held open across yields. {#wild-python-generators}
- **JavaScript Symbol.iterator** — An object is iterable if it has a \[Symbol.iterator\]() method returning an object whose next() yields {value, done}. That contract powers for...of, spread, and destructuring; generator functions (function\*) produce it automatically. {#wild-js-symbol-iterator}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Eager vs. lazy** — Whether the iterator builds every element up front (memory grows with the collection, source read once and then released) or yields on demand, one element at a time (memory stays small, but the underlying file, socket, or database cursor stays open until the walk is exhausted or closed).
- **Snapshot vs. live view** — Whether traversal walks a frozen copy or the live collection. A live cursor is cheap but breaks if the collection mutates mid-walk; a snapshot never sees later changes and costs a copy of the whole collection per walk.
- **Page size** — Items an iterator over a paged source fetches per round trip. Larger pages cut round trips but hold more items in memory; smaller pages do the reverse. Measure both under your own load before fixing a value.

### Signals to watch
<!--meta polarity=signal-->

- **Open cursor count** — For lazy iterators backed by an external source, the number of file handles, sockets, or database cursors held open, read from the open-handle count of the process or the in-use count the source reports. A count that keeps rising across requests means iterators are leaking.
- **Fail-fast exception rate** — How often iterators throw ConcurrentModificationException or the equivalent in your language. A steady nonzero rate means a writer is racing a walk.

### Failure modes under load
<!--meta polarity=failure-->

- **Concurrent modification** — Changing the collection during a walk invalidates the cursor. Fail-fast iterators usually detect the structural change and throw, but detection is best-effort: where it misses, the walk silently skips or repeats elements, so guard the mutation instead of relying on the exception.
- **Leaked lazy iterator** — A generator backed by a file or database cursor that is abandoned before exhaustion releases its resource only when it is closed or garbage-collected, which can be late or never, so handles accumulate under load.

### Readiness checklist
<!--meta polarity=check-->

- Collections are not structurally modified while an iterator walks them, or the walk runs over a snapshot copy or an iterator documented to tolerate changes; each thread gets its own iterator and none is shared.
- Lazy iterators backed by external resources are closed even when traversal stops early: the walk sits in try/finally, or the caller calls the generator close(), as in Python.
- A fresh iterator is obtained per traversal rather than reusing an exhausted one.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Behavior](../../../themes/object-behavior.md) — Walk a collection one element at a time without exposing how it is stored. {#fluency-object-behavior}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Factory Method](../creational/factory-method.md) — The aggregate's createIterator is a factory method for the right cursor
- [Visitor](./visitor.md) — Walk once, hand each element to an operation object
- [Composite](../structural/composite.md) — One iterator walks leaves and branches alike
- [Copy-on-Write](../../concurrency/copy-on-write.md) — Walk a snapshot taken at the start, so a mid-walk write never reaches the cursor

**Often confused with**

- [Aggregate](../../ddd/aggregate.md) — The domain-driven design (DDD) aggregate is a consistency boundary, not the collection being walked — the two share only a name

**Exposed to**

- [Resource Leak](../../../hazards/resource-leak.md) — A lazy iterator over a file, socket or database cursor leaks its handle when it is abandoned before it is drained or closed.

<!-- relationships:end -->
