---
title: Interface Segregation Principle
description: "Many small, client-specific interfaces beat one fat general-purpose one"
area: principles-craft
owner: Oleksandr Derechei
tags: [low-level-design, decoupling]
status: stable
aliases: [ISP]
solves: [implementing this interface forces me to stub out methods I never use, a change to a method my class doesn't even call still makes it recompile, every class that implements this has half its methods throwing not-supported, this interface is so big no caller uses more than a third of it, faking this dependency in a test means implementing forty methods to exercise two]
---

# Interface Segregation Principle

No client should be forced to depend on methods it does not use. Split a fat, general-purpose interface into several small ones, each shaped to the role a particular client actually plays — so that what a client sees is only what it needs.

## What it says
<!--meta block=description-->

“Clients should not be forced to depend on methods they do not use.” The I in SOLID, named by Robert C. Martin. A caller of a wide interface is coupled to every method it declares, not just those it calls, so split the interface by who uses what. Martin met it on a Xerox printer: one Job class held every operation, so a client that only stapled was bound to printing and faxing too.

## Explained
<!--meta block=explain-->

The interface segregation principle says no caller should have to depend on methods it never uses, so you split one wide interface into narrow ones along the roles of its callers. With a wide interface, each caller is tied to every method it declares, so a change to a method nobody here calls still forces implementers and test fakes to change, and in compiled languages a rebuild. One class can still implement several narrow interfaces at once, because the split lives in what each caller sees. Choose it over one shared interface when you can name two callers that never use the same subset of methods. An implementation with empty methods, or one that throws UnsupportedOperationException, is the sign. Overdone, it makes a wall of one-method interfaces to name, import and mock, which hides the shape of the thing without simplifying any caller. The counter-move is to split only on an observed difference in use: if every caller uses the same handful of operations together, keep one interface.

**Example.** A Store interface has 5 methods: get, put, delete, listAll and backup. A report page only reads, yet its test fake must implement all 5, 3 of them stubbed to throw. A cache layer implements Store and leaves backup empty. The team defines Reader with get and listAll and Writer with put and delete, and moves backup to an Admin interface used by one job. The report depends on Reader alone, so its fake shrinks from 5 methods to 2. The cost is three new interface names (Reader, Writer, Admin) in place of Store. The team does not split Reader further into get and listAll, since every reader uses both.

## Why it helps
<!--meta block=rationale-->

A fat interface makes unrelated clients share a fate. Because each depends on the whole declaration, a change made for one client, such as a new method or a changed signature, ripples out to every other, forcing them to recompile or update their test fakes even though the behaviour they rely on never moved. The dependency is on the interface, so unrelated clients are tied together through it.

Cut the interface along role boundaries and a change aimed at one role no longer reaches clients in other roles. Each client depends only on the operations it genuinely calls. Small interfaces are also honest documentation: the signature tells a caller exactly what is expected of it, with no dead methods to puzzle over.

## Applying it
<!--meta block=applying-->

Shape interfaces around the caller, not the implementer:

- Group methods by the role a client plays. A type that is read in one place and written in another wants a `Reader` and a `Writer`, not a single `Store` that every caller drags around whole.
- Let one class implement several small interfaces. Segregation lives in what callers see; a single concrete class can still satisfy all of them at once.
- Review check: an implementer with empty or throwing methods, or a test fake that stubs methods its test never calls. Fix: move those methods to a separate interface. A throwing stub also breaks [Liskov substitution](liskov-substitution.md); narrowing the interface removes it.
- Define the interface from the consumer's side. The client that needs three methods declares an interface of exactly those three. In structural typing (TypeScript, Go) the provider conforms without change; in nominal typing (Java) the provider must name the interface.
- Review check: compare each interface-typed parameter with the methods its body calls. One call against a wide declaration means a narrower type is due. Existing callers of the concrete class keep compiling, so split one caller at a time.

The rule of thumb: if you can name two clients that would never both use the same subset of methods, that is two interfaces.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — one wide interface every client drags around, then role-sized ones"
// Before: one wide interface; a basic stapler must stub what it cannot do.
interface Job { print(): void; fax(): void; staple(): void }
class BasicStapler implements Job {
  print() { throw new Error("unsupported"); }   // the tell: a forced stub
  fax() { throw new Error("unsupported"); }     // the tell: a forced stub
  staple() { /* feed and press */ }
}
function finish(job: Job) { job.staple(); }

// After: each client declares only its slice; one class still serves all.
interface Stapler { staple(): void }
interface Printer { print(): void }
interface Fax { fax(): void }
class Machine implements Stapler, Printer, Fax {
  staple() { /* feed and press */ }
  print() { /* render pages */ }
  fax() { /* dial and send */ }
}
function finish(s: Stapler) { s.staple(); }
const fake: Stapler = { staple: () => {} };   // a test fake needs one method
finish(fake);
```

## Taken too far
<!--meta block=overreach-->

Segregation answers to real diversity among clients. Split an interface when nobody actually needs it split and you get interface explosion: a swarm of one-method interfaces, a wall of tiny types to name and import and mock, and a layer of indirection that hides the shape of the thing without simplifying any caller. Ceremony is not cohesion.

So let the split be driven by an observed difference in how clients use the type, not by a reflex to keep every interface at one method. If every caller uses the same handful of operations together, one interface is the right grain — carving it up serves no client and only adds surfaces to keep in sync. Segregate where the roles genuinely differ; leave whole what is genuinely used whole.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Single Responsibility Principle](./single-responsibility.md) — One responsibility, applied to an interface: keep unrelated client roles from sharing one contract.
- [Dependency Inversion Principle](./dependency-inversion.md) — Those small role interfaces are exactly the abstractions high-level policy should depend on.
- [DTO](../patterns/enterprise/dto.md) — A data transfer object (DTO) names the narrow shape one caller needs, so it does not depend on the full record
- [Backend-for-Frontend](../patterns/distributed/routing/bff.md) — Each client type gets its own backend surface instead of one wide application programming interface (API) serving all of them
- [Liskov Substitution Principle](./liskov-substitution.md) — A throwing or empty stub is a subtype that breaks the contract; narrowing the interface removes the stub.

**Prevents**

- [Partial Object](../hazards/partial-object.md) — Narrow, client-shaped types keep unrelated consumers from sharing one wide type, so no consumer depends on parts it never uses.

**Demonstrated by**

- [Rate Limiter](../designs/design-rate-limiter.md) — a one-method contract instead of a fat abstract base is interface segregation in the small

<!-- relationships:end -->
