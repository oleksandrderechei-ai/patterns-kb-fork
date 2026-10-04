---
title: Decorator
description: Attaches behavior without changing the class
area: gof-structural
owner: Oleksandr Derechei
tags: [low-level-design, composition, extensibility, separation-of-concerns]
status: stable
aliases: [wrapper]
solves: [I need a class per combination of optional features and there are too many combinations, I want to add logging around this object without touching its class or its other callers, every method starts with the same caching and retry boilerplate copied by hand, turning compression on for one instance means subclassing the whole thing, I want to pick which extras apply at runtime instead of at compile time]
---

# Decorator

Wraps an object in another that shares its interface — layering new behavior on at runtime, one transparent shell at a time, without touching the original class or the code that already uses it.

## What it is
<!--meta block=description-->

Optional features such as logging, buffering, compression or encryption combine many ways, and a subclass for each combination multiplies classes. A decorator wraps one object of the same interface at run time, forwards each call and adds behaviour before or after, so callers using the interface cannot tell the wrapper from the original. Choose it when each layer wraps the call; use a [chain of responsibility](../behavioral/chain-of-responsibility.md) when only one handler should act, and a [proxy](./proxy.md) to control access.

## Explained
<!--meta block=explain-->

A decorator wraps an object that has the same interface, forwards each call to it and adds behaviour before or after. The caller cannot tell the wrapper from the original, so you can stack small wrappers, each doing one job such as logging, buffering or compression, and choose the stack per object at run time. Choose it over subclassing when optional features multiply: n features need n wrappers, while one subclass per combination needs up to 2 to the power n classes.

- **Order.** Wrapper order changes the result and nothing in the types records it. Build the stack in one named function and test its output.
- **Identity.** The wrapped object is not the original, so equality and type checks fail. Compare through the interface.
- **Forwarding.** On a wide interface every wrapper must pass every method along, so keep decorated interfaces small.

**Example.** A data stream has 3 optional features: compression, encryption and logging. Subclassing needs a class for each of the 2^3 = 8 combinations. With decorators you write 3 wrappers and assemble them per use. Compressing then encrypting a 1 MB log works: the repeated text shrinks, then the small result is encrypted. Reversed, encryption makes the data look random, so the compressor finds nothing to shrink and the file stays about 1 MB. Both orders compile. One function named secureStream builds the right order, and one test checks that the output is smaller than the input.

## How it works
<!--meta block=structure-->

```mermaid caption="Both the concrete object and the base decorator implement Component. A decorator holds a Component reference and delegates to it, so wrappers can be nested arbitrarily."
classDiagram
    class Component
    class ConcreteComponent
    class Decorator
    class LoggingDecorator
    Component <|.. ConcreteComponent
    Component <|.. Decorator
    Decorator o-- Component
    Decorator <|-- LoggingDecorator
```

## Variations
<!--meta block=variations-->

- **Transparent (interface-preserving)** — The classic form: the wrapper exposes exactly the wrapped interface, so it stays [substitutable](../../../principles/liskov-substitution.md) and stackable and callers never change.
- **Function / higher-order decorator** — Wrap a function in another function instead of an object — memoize, throttle, retry, or time a call. Same idea, no class hierarchy needed.
- **Language-level decorators** — Python `@decorator` syntax and TypeScript decorators apply a function to a declaration once, at definition time, and often return a wrapper. A Java annotation only marks a declaration for a framework or tool to act on. Related in spirit, but they act on a declaration, not on a live instance.
- **Stackable, order-sensitive** — Several wrappers compose into a pipeline where order is significant — compress-then-encrypt behaves differently from encrypt-then-compress.
- **Extending decorator** — The wrapper adds methods beyond the wrapped interface, as `DataInputStream` adds typed reads and `lru_cache` adds `cache_info()`. Callers that use the extras hold the decorator type, so the wrapper is no longer a drop-in substitute.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Adds behaviour at runtime** without editing the wrapped class or anyone else who uses it.
- **Builds up features by stacking small wrappers**, instead of one class for every combination.
- **Each wrapper does exactly one thing** and leaves the original class closed to edits.
- **Drops in anywhere the original goes**: callers depend on the interface, not the wrapper.

### Cons
<!--meta polarity=con-->

- **A deep stack of thin wrappers** is hard to trace — one call passes through many layers.
- **The order you stack wrappers in** changes the result, and a wrong order raises no error. Build the stack in one named function and test its output.
- **Identity breaks**: a wrapped object is no longer the original, so `===` and type checks fail.
- **Lots of tiny classes**, and the base wrapper has to forward every method faithfully.
- **A wrapper cannot be removed** from the middle of a built stack. Removing one means rebuilding every wrapper outside it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You want to add features to individual objects**, not to every instance of the class.
- **Optional features combine many ways** and you want to choose the mix at runtime.
- **Subclassing would explode** into a separate class for every feature combination.

### Avoid when
<!--meta polarity=avoid-->

- **The interface is large** — forwarding every method by hand through each wrapper gets brittle.
- **Downstream code needs the object's concrete type** or its exact identity.
- **A single flag or a strategy object** would express the variation more simply.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a transparent, stackable wrapper"
interface DataSource {
  read(): string;
  write(data: string): void;
}

class InMemorySource implements DataSource {
  private contents = "";
  read(): string { return this.contents; }
  write(data: string): void { this.contents = data; }
}

// Base decorator: same interface, forwards to the wrapped source.
abstract class SourceDecorator implements DataSource {
  constructor(protected readonly inner: DataSource) {}
  read(): string { return this.inner.read(); }
  write(data: string): void { this.inner.write(data); }
}

// A concrete wrapper: transform on the way in, undo it on the way out.
class Base64Source extends SourceDecorator {
  read(): string { return atob(this.inner.read()); }         // decode when reading
  write(data: string): void { this.inner.write(btoa(data)); } // encode when writing (btoa takes Latin-1 text only)
}

// Wrappers stack, and their order changes the result; the caller still sees a plain DataSource.
const source: DataSource = new Base64Source(new InMemorySource());
source.write("secret");   // stored encoded
source.read();            // "secret" — the encoding is invisible to the caller
```

## In the wild
<!--meta block=wild-->

- **java.io streams** — BufferedInputStream, GZIPInputStream and DataInputStream each wrap another InputStream and add buffering, decompression or typed reads while keeping the InputStream interface, so callers stack them: new DataInputStream(new BufferedInputStream(new FileInputStream(path))). {#wild-java-io-streams}
- **java.util.Collections.unmodifiableList** — Returns a view that forwards read calls to the backing list unchanged, but every mutating method (add, remove, set) throws UnsupportedOperationException — a wrapper, not a copy, so changes to the underlying list still show through. {#wild-collections-unmodifiable}
- **Python functools.lru_cache** — Wraps a function in a same-signature callable that memoizes up to maxsize results keyed by the call arguments, evicting least-recently-used entries, and exposes cache_info() and cache_clear() on the wrapped function. {#wild-functools-lru-cache}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Wrapping order** — Which wrapper acts first on a write. Put compress before encrypt, because encrypted data does not shrink.
- **Where the stack is built** — In one factory or at the composition root, so callers receive a ready stack.
- **Interface width** — A wide interface forces every decorator to forward many methods.
- **Which decorators are optional** — Those switched on by config or by feature flag.

### Signals to watch
<!--meta polarity=signal-->

- **Stack depth** — Layers in a typical call. Deep stacks make stack traces long and the call hard to follow.
- **Per-layer latency** — Time added by each decorator, from tracing.
- **Identity checks** — Code that tests the type of the wrapped object, which a decorator hides.
- **Forwarding gaps** — Methods a decorator forgets to forward.

### Failure modes under load
<!--meta polarity=failure-->

- **Wrong order** — Two decorators applied in the wrong order give wrong output with no error.
- **Forgotten forward** — A new method on the interface is added and one decorator does not forward it, so behavior is silently lost.
- **Identity loss** — Equality and type checks fail on a wrapped object.
- **Resource ownership** — Closing the outer wrapper does not close the inner one, or closes it twice.
- **Shared state** — A buffering or caching wrapper reused across threads races on its own buffer or cache, and loses unflushed data if the stack is dropped without close. Flush on close, and guard it or build one stack per request.

### Readiness checklist
<!--meta polarity=check-->

- The order of decorators is fixed in one place and tested
- Every decorator forwards every method of the interface
- Closing a wrapper closes the wrapped object exactly once
- Code does not test the type of a wrapped object

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Structure](../../../themes/object-structure.md) — Add behaviour to an object by wrapping it in one with the same interface. {#fluency-object-structure}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Open/Closed Principle](../../../principles/open-closed.md) — Extends behaviour without modifying the component — open/closed by composition.
- [Composition over Inheritance](../../../principles/composition-over-inheritance.md) — Composition of wrappers in place of a combinatorial class hierarchy.
- [Render Props](../../frontend/render-props.md) — Higher-order components (HOCs), a render-props sibling, decorate a component with extra behavior
- [Liskov Substitution Principle](../../../principles/liskov-substitution.md) — Stacking wrappers works because each one stays substitutable for the original

**Often confused with**

- [Proxy](./proxy.md) — Add behavior vs. control access — same shape
- [Adapter](./adapter.md) — Same wrapping shape, different intent
- [Composite](./composite.md) — Both wrap recursively; a decorator adds behaviour to one wrapped object, a composite combines many children
- [Chain of Responsibility](../behavioral/chain-of-responsibility.md) — Layers behaviour on a call and normally forwards it, vs. a handler that may deal with the request and stop

<!-- relationships:end -->
