---
title: Factory Method
description: Subclasses decide which class to instantiate
area: gof-creational
owner: Oleksandr Derechei
tags: [low-level-design, decoupling, lifecycle, extensibility, polymorphism]
status: stable
aliases: [virtual constructor]
solves: [adding a new export format means editing the same giant switch statement again, my class hard-codes new PostgresConnection() and now the tests need an in-memory one, the base class does all the real work but each subclass needs a different object built inside it, I want to plug in a new type without touching any of the code that uses it, calls to concrete constructors are scattered across a dozen files and I cannot swap the type]
---

# Factory Method

Declares a creation method on a base class but hands the choice of concrete type down to its subclasses — so the code that uses an object never names the class it actually gets.

## What it is
<!--meta block=description-->

A class must create objects it cannot name, and writing new on a concrete class welds the surrounding code to that type. Factory Method puts creation in one overridable method of a base class, and each subclass returns its own concrete product. The base logic runs unchanged against any of them.

## Explained
<!--meta block=explain-->

A factory method is a single overridable method in a base class that returns the object the base class's logic needs, with each subclass returning a different concrete class. The logic written in the base class runs unchanged against whichever product the subclass picks, so a new variant is one added subclass rather than an edit to working code. Choose it when one product type varies and you already have a class hierarchy for that variation, and the varying step sits inside logic you want to reuse. If you only need to pick a class, pass a factory function or the product itself, which costs one parameter.

- **Parallel hierarchy.** The creators mirror the products, adding one creator class per product to vary one thing. Use it only for real shared logic.
- **Harder reading.** What gets built depends on the runtime subclass, so name each creator after its product.

**Example.** A logistics app plans deliveries in a base class that picks a vehicle, loads, routes and reports, about 200 lines. Road delivery creates a truck and sea delivery creates a ship, each as one subclass with one method of about 3 lines, so the 200 lines exist once. Air delivery arrives later: one subclass, one plane, and no edit to the tested planning code. The cost is that 3 products need 3 creators, so 6 classes where a parameter taking a vehicle would need 3. A passed-in vehicle shares the 200 lines too, so the extra classes pay off only if each creator also overrides other steps; if only the vehicle varies, pass it in.

## How it works
<!--meta block=structure-->

```mermaid caption="The creator's logic calls factoryMethod against the abstract Product. A subclass overrides it to return a concrete product, without the base class ever naming that type."
classDiagram
    class Creator {
      +factoryMethod() Product
      +operation()
    }
    class ConcreteCreator {
      +factoryMethod() Product
    }
    class Product
    class ConcreteProduct
    Creator <|-- ConcreteCreator
    Product <|.. ConcreteProduct
    ConcreteCreator ..> ConcreteProduct : creates
```

## Variations
<!--meta block=variations-->

- **Parameterized factory method** — A single method takes a key or type token and switches on it to return one of several products — fewer subclasses, but a growing switch to maintain.
- **Default implementation** — The creator's factory method returns a sensible default product; subclasses override only when they need something different, rather than always.
- **Static factory method** — A named static method (`of`, `valueOf`, `from`) stands in for a constructor — an idiom that adds naming and caching, though it can't be overridden.
- **Registry-based factory** — Concrete creators register themselves in a lookup table keyed by name, so new products plug in at runtime with no changes to the calling code, as long as registration runs before the first lookup. A key with no entry fails with a named error, like an unknown type argument.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Frees the caller from concrete product classes** — it depends only on the shared interface.
- **Puts construction in one method** you can override, keeping that responsibility in a single place.
- **A new product arrives by adding a subclass**, without touching the existing creator code.
- **Gives subclasses a clean hook** to decide exactly what gets built.

### Cons
<!--meta polarity=con-->

- **May force a parallel creator hierarchy** just to vary one product, multiplying classes. Pass the product or a factory function instead when the creators differ only in the product they return.
- **Subclassing just to change what's created** is heavy-handed when passing the choice in (composition) would do.
- **The extra indirection obscures the flow** when there's really only one product anyway.
- **Abstract product type still needed** — the base creator still has to define and depend on it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A class can't know ahead of time** the concrete type of the objects it needs to create.
- **You want subclasses to decide** which objects the base-class logic works on.
- **The step that varies** sits inside base-class logic you want to reuse, and the variants already form a class hierarchy.

### Avoid when
<!--meta polarity=avoid-->

- **There's a single concrete product** and no variation in sight — just call the constructor.
- **Passing in the product or a factory** — composition or injection — is simpler than subclassing.
- **The base class holds little logic to share**, so a creator subclass per product adds classes and saves no code.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a subclass chooses which product the base logic operates on"
interface Transport {
  deliver(cargo: string): string;
}

class Truck implements Transport {
  deliver(cargo: string): string { return `${cargo} delivered by road`; }
}
class Ship implements Transport {
  deliver(cargo: string): string { return `${cargo} delivered by sea`; }
}

abstract class Logistics {
  // the factory method — the base class never names a concrete Transport
  protected abstract createTransport(): Transport;

  planDelivery(cargo: string): string {
    const transport = this.createTransport();   // defer the choice to the subclass
    return transport.deliver(cargo);
  }
}

class RoadLogistics extends Logistics {
  protected createTransport(): Transport { return new Truck(); }
}
class SeaLogistics extends Logistics {
  protected createTransport(): Transport { return new Ship(); }
}

const logistics: Logistics = new SeaLogistics();
console.log(logistics.planDelivery("40ft container"));
```

## In the wild
<!--meta block=wild-->

- **java.util.Collection.iterator()** — iterator() is declared on java.lang.Iterable (which Collection extends); ArrayList, HashSet and other collection classes override it to return their own Iterator implementation. The enhanced for-loop calls it implicitly, so callers traverse any collection without ever naming the concrete iterator class. {#wild-java-collection-iterator}
- **java.sql.Connection.createStatement()** — Connection declares createStatement, and each Java Database Connectivity (JDBC) driver implements it to return its own Statement class. Calling code holds only the java.sql interface and never names the driver's concrete type. {#wild-jdbc-create-statement}
- **.NET IEnumerable GetEnumerator()** — IEnumerable declares GetEnumerator, and each collection type returns its own enumerator. The foreach statement calls it, so callers traverse any collection without naming the concrete enumerator. {#wild-dotnet-getenumerator}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Parameterized or one per product** — One method that takes a type argument, or one method per product. The parameter form needs a closed set of values.
- **Return type** — The widest interface the caller needs, not the concrete class.
- **Default implementation** — An abstract method, or a default product that a subclass may replace.
- **Caching** — Whether the method returns a new product each call or a shared one. A shared product must be stateless or thread-safe and outlives the call; a new one costs an allocation per call but is safe to mutate.

### Signals to watch
<!--meta polarity=signal-->

- **Concrete class names in callers** — Constructor calls in code that should ask the creator.
- **Creator subclasses with one override** — Subclasses made only to pick a product, in a base class with little logic worth sharing, which a parameter could do.
- **Product class count** — New product types added, and the creators touched for each.
- **Switch statements on a type tag** — A switch that picks a class by a tag, repeated in callers, is a factory method waiting to be moved. One switch inside the factory is the parameterized form.

### Failure modes under load
<!--meta polarity=failure-->

- **Subclass explosion** — A creator subclass per product doubles the hierarchy. Use a parameter, a registry of factory functions rather than of creator subclasses, or clone a configured prototype.
- **Unknown type argument** — A parameterized factory is given a value it has no case for. Fail with a clear error.
- **Leaking concrete type** — Callers cast the result to the concrete class and the factory buys nothing.
- **Construction with side effects** — The factory opens connections or reads files, and a test cannot build the creator. Keep I/O out of the creator constructor, and in a test subclass the creator and override the factory method to return a fake product.
- **Factory method called from the constructor** — The creator constructor calls the factory method, so the override runs before the subclass state is set and builds from unset fields. Call it from a method after construction, or lazily.

### Readiness checklist
<!--meta polarity=check-->

- Callers depend on the product interface, not the concrete class
- Unknown input fails with a named error
- Each creator has a test that checks the product type it returns
- Construction has no side effects that tests cannot avoid

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Creation](../../../themes/object-creation.md) — Let a subclass decide which concrete class a base class instantiates. {#fluency-object-creation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Flyweight](../structural/flyweight.md) — A factory hands back shared flyweights
- [Template Method](../behavioral/template-method.md) — A step in the template is often a factory method
- [Iterator](../behavioral/iterator.md) — createIterator is the textbook factory method on a collection
- [Null Object](../extra/null-object.md) — The creator decides when absent means a do-nothing object, not null

**Alternative to**

- [Prototype](./prototype.md) — Clone a configured instance vs. subclass to create
- [Builder](./builder.md) — Stepwise assembly vs. a single creating call

**Part of**

- [Abstract Factory](./abstract-factory.md) — Its product methods are usually Factory Methods

**Exposed to**

- [Static Cling](../../../hazards/static-cling.md) — Can fall into static cling when a static factory call fixes the concrete type at the call site

**Demonstrated by**

- [Rate Limiter](../../../designs/design-rate-limiter.md) — LimiterFactory.create switches on a config string to pick the limiter class: the parameterized variation, with no creator subclass

<!-- relationships:end -->
