---
title: Visitor
description: Adds operations without changing the classes visited
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, polymorphism, composition, extensibility, separation-of-concerns]
status: stable
solves: [every new operation over my node types means editing all twenty classes, my serialization code is one long chain of instanceof checks, I keep bolting methods onto a class hierarchy that have nothing to do with what those classes are for, I want to walk this tree and total something up but the logic is scattered across the nodes, when I add a new node type nothing tells me which handlers I forgot to update]
---

# Visitor

Packages a new operation as an object you push through a stable class hierarchy — so you can teach a fixed set of types new tricks without editing a single one of them.

## What it is
<!--meta block=description-->

Operations such as printing, type-checking and cost estimates keep multiplying over a stable set of types, and each one means editing every class. Visitor moves each operation into its own object with one method per element type, and each element routes the call to the right method through accept. The price: a new element type touches every visitor.

## Explained
<!--meta block=explain-->

A visitor moves an operation out of the classes it works on and into its own object, which has one method for each type of element. Each element has an accept method that calls back the visitor method for its own type, so the right code runs without a chain of type checks. Adding an operation is then one new visitor and no edit to the elements. Choose it over a method on each element when the set of types is stable and operations keep multiplying: printing, type-checking, cost estimates. Where your language has exhaustive pattern matching over a small closed set of types, use that instead, with less machinery.

- **New element types.** Each one needs a new method in every visitor. Use a visitor interface so the compiler flags any visitor that missed one.
- **Boilerplate.** Every element needs an accept method. Where that hurts, dispatch on runtime type; instanceof checks lose the exhaustiveness check the compiler gives.
- **Exposed internals.** Visitors need element internals, which weakens encapsulation, so expose read access only.

**Example.** A syntax tree has 4 node types: number, add, multiply and variable. You need 3 operations: evaluate, print and count nodes. As visitors that is 3 classes with 4 methods each, 12 methods, and the node classes never change. Add a fifth node type, power, and all 3 visitors need a new method, so 3 edits. If the visitor interface declares the method, the compiler lists the 3 visitors that lack it. Had you put the operations inside the nodes, a fourth operation would have meant editing all 4 node classes you started with.

## How it works
<!--meta block=structure-->

```mermaid caption="Double dispatch. The first call resolves the concrete element type, the second resolves the concrete operation — together they select exactly one method."
sequenceDiagram
    autonumber
    participant C as Client
    participant E as Element
    participant V as Visitor
    C->>E: accept(visitor)
    E->>V: visitConcrete(this)
    alt visitor overrides this type
        V-->>E: run operation, return result
    else no override (base visitor)
        V-->>E: default no-op
    end
    E-->>C: result
```

## Variations
<!--meta block=variations-->

- **Classic double dispatch** — Every element implements `accept` and calls back the visitor's type-specific method. Fully type-safe, but the object structure must know about the visitor interface.
- **Acyclic Visitor** — Splits the monolithic visitor interface into one small interface per element, so a visitor implements only the types it cares about and new element types don't force a recompile of every visitor. The cost is run-time dispatch, because each element checks whether the visitor implements its interface, so a visitor that ignores a new element type still compiles and the pass skips it. Pick it over classic double dispatch when recompiling every visitor is what hurts.
- **Reflective / dynamic Visitor** — Skips `accept` and dispatches on runtime type — `instanceof` checks or pattern matching. Less boilerplate, but `instanceof` and type-tag checks lose the compiler's exhaustiveness guarantee, and pattern matching keeps it only where the language checks it over a closed set of types.
- **Default (base) Visitor** — Provides no-op defaults for every element so a concrete visitor overrides only the handful of nodes it needs — handy over large or generated hierarchies.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Add a new operation** as one new visitor, with no edit to the element classes, once each element has `accept` and exposes what the visitor reads.
- **Keeps all of one operation's logic** in a single object, instead of scattered across the element classes.
- **Can build up state across a whole traversal** — running totals, reports, symbol tables.
- **Routes each concrete element** to its handler with no manual type checks; with a visitor interface the compiler flags a visitor that lacks a handler.

### Cons
<!--meta polarity=con-->

- **Adding a new element type** forces a change to every visitor that must handle it. A visitor interface makes the compiler list the visitors that missed it, and a base visitor with defaults limits the edits, at the cost of silent skips.
- **Boilerplate**: every element needs an `accept` method to route the call back (double dispatch).
- **Visitors often need to see an element's internals**, which weakens its [encapsulation](../../../principles/encapsulation.md).
- **Overkill when there is only one operation**, or when it belongs on the element itself.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The set of element types is stable**, but you keep adding new operations over them.
- **The operation doesn't really belong on the elements** — think serialization, pretty-printing, or type-checking.
- **You want a family of related operations** gathered together, separate from the data.

### Avoid when
<!--meta polarity=avoid-->

- **New element types appear often** — each one forces a change to every visitor.
- **There is a single operation**, or it sits naturally as a method on the element.
- **A plain switch or pattern match** over a small closed type set reads more clearly.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an area visitor over a shape hierarchy"
interface ShapeVisitor<T> {
  circle(shape: Circle): T;
  square(shape: Square): T;
}
interface Shape {
  accept<T>(visitor: ShapeVisitor<T>): T;
}

class Circle implements Shape {
  constructor(readonly radius: number) {}
  accept<T>(visitor: ShapeVisitor<T>): T { return visitor.circle(this); }
}
class Square implements Shape {
  constructor(readonly side: number) {}
  accept<T>(visitor: ShapeVisitor<T>): T { return visitor.square(this); }
}

// A new operation, added with no change to any Shape class.
class AreaVisitor implements ShapeVisitor<number> {
  circle(shape: Circle): number { return Math.PI * shape.radius ** 2; }
  square(shape: Square): number { return shape.side ** 2; }
}

const shapes: readonly Shape[] = [new Circle(2), new Square(3)];
const area = new AreaVisitor();
const total = shapes.reduce((sum, shape) => sum + shape.accept(area), 0);
```

## In the wild
<!--meta block=wild-->

- **ANTLR** — When generated with the -visitor option (the listener is the default), ANTLR produces a base visitor with one visit method per grammar rule, so each new pass over the parse tree is a visitor subclass overriding only the rules it cares about, with visitChildren as the walk-everything default. {#wild-antlr}
- **Babel** — A transform plugin returns a visitor object keyed by abstract syntax tree (AST) node type (Identifier, CallExpression, ...); Babel walks the tree and invokes matching enter/exit handlers by node-type name, with no accept method, the reflective variant above. The NodePath handed to each gives scope and mutation helpers without touching the parser's node definitions. {#wild-babel}
- **Roslyn** — Exposes CSharpSyntaxVisitor for dispatching on node type, CSharpSyntaxWalker (a subclass of it) for read-only descent of the tree, and CSharpSyntaxRewriter for producing a modified tree. Because syntax nodes are immutable, a rewriter returns a new tree rather than mutating nodes, so analyzers and refactorings compose over the same tree without one pass mutating a tree another is reading. {#wild-roslyn}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Double dispatch form** — An accept method on each element, or a type switch in the visitor. The switch avoids touching elements; an instanceof or tag switch loses the compiler check, and a match over a closed type set keeps it where the language checks it.
- **Return values** — Visitors that return a result, carry state in fields, or take a context argument.
- **Traversal ownership** — The elements walk their children, or the visitor does. The visitor-driven walk lets one visitor skip a subtree.
- **Default behavior** — A base visitor with empty or default visit methods, so a subclass handles only the nodes it cares about. Defaults hide the compile error a new element type raises, so make the default log or throw.

### Signals to watch
<!--meta polarity=signal-->

- **Element type changes** — How often new element types are added, counted per release from version history and compared with how often new visitors are added. Each addition touches every visitor, so when types change as often as operations the stable-types condition no longer holds.
- **Visitor count** — Number of visitors, read against the element types. Growth over a stable type set is expected, but each added visitor is one more edit when an element type is added. Visitors that each override a few methods point to a base visitor.
- **Traversal cost** — Time spent walking large structures, from a profiler.
- **Unhandled element hits** — Counts of nodes that reached a default visit method.

### Failure modes under load
<!--meta polarity=failure-->

- **New element breaks all visitors** — Adding an element type forces an edit in every visitor class. Compile errors show them if the interface is abstract; a default or acyclic visitor still compiles, and the new type is skipped unless the default logs or throws, so watch unhandled element hits.
- **Encapsulation leak** — Elements expose internals so visitors can read them. A later change to those internals breaks every visitor that reads them; expose read access only.
- **Stack depth** — A recursive walk of a deep tree overflows the stack. Use an explicit stack, which needs a visitor-driven walk (see traversal ownership), since accept-driven recursion returns through the call stack.
- **State kept in visitor fields** — A visitor reused across traversals carries old state into the next one.

### Readiness checklist
<!--meta polarity=check-->

- Adding an element type is rare, or the element set is fixed
- Visitors are created fresh per traversal or reset before use
- Deep inputs are tested for stack depth
- Each visitor has a test over a small structure that includes every element type

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Behavior](../../../themes/object-behavior.md) — Move an operation out of a class hierarchy into a separate object. {#fluency-object-behavior}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Composite](../structural/composite.md) — Apply an operation across a whole tree
- [Interpreter](./interpreter.md) — Visitors evaluate interpreter node trees
- [Iterator](./iterator.md) — A traversal walks the structure and applies the visitor to each node

<!-- relationships:end -->
