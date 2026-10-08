---
title: Template Method
description: "Fixes the outline, lets subclasses fill in steps"
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, polymorphism, extensibility, decoupling]
status: stable
solves: [I copy-pasted this whole importer and changed two lines in the middle, the copies of this procedure have quietly drifted apart and nobody noticed, three of my jobs do the same setup and teardown and one of them forgot the cleanup, every new report reimplements the same four steps in a slightly different order, I want people to extend this without letting them skip the validation step]
---

# Template Method

Locks the shape of an algorithm in a base class — the steps and their order never change — while subclasses supply the parts that vary.

## What it is
<!--meta block=description-->

Several procedures share one overall shape but differ in a step or two, and copied versions quietly drift apart. Template Method keeps the fixed sequence in one base-class method and leaves the varying steps for subclasses to fill. The base class calls down into them, so while the skeleton is final no variant can reorder a step, though a variant can still override a step to do nothing.

## Explained
<!--meta block=explain-->

A template method puts a procedure's fixed sequence of steps in one method of a base class and leaves some steps blank for subclasses to fill. The base class calls the steps in order, and the shared steps exist once. While the skeleton is final no variant can reorder them, though a step can still be overridden to do nothing. This is the Hollywood Principle: the base class calls the subclass, never the reverse. Choose it over copying the procedure into each variant when the sequence is worth protecting and the variation is small, closed and known in advance. Choose composition when steps must change independently or at run time: hand the varying step in as an object or function, as in [strategy](./strategy.md).

- **One base class.** Each variant spends its one base class here, so in single-inheritance languages like Java it cannot inherit from anything else.
- **Frozen contract.** The overridable steps harden into a contract. Keep the list short, make fixed steps final, and turn down requests for new hooks.
- **Split flow.** Behavior spans base and subclass, so document the step order in the base class.

**Example.** A report job does four steps: load data, filter, format, send. Three jobs (sales, stock, refunds) differ only in load and format. The base class holds a run method that calls the four steps in order, and each job overrides two: filter and send are written once, so 8 step bodies instead of 12. Then someone asks for a hook before sending, then one after loading, then a flag to skip filtering. The base grows from 4 steps to 7, and since the order changed all 3 subclasses need rechecking. Passing the steps in as functions would make each request an optional argument, so no job needs rechecking.

## How it works
<!--meta block=structure-->

~~~mermaid caption="The base class fixes the call order in `templateMethod`. Abstract steps are mandatory blanks, the hook has a default, and a concrete subclass overrides only what it needs."
flowchart TB
    T["templateMethod: fixed order"]
    T -->|"1 calls"| S1["step1: abstract"]
    T -->|"2 calls"| S2["step2: abstract"]
    T -->|"3 calls"| H["hook: default no-op"]
    Sub["ConcreteClass"] -.overrides.-> S1
    Sub -.overrides.-> S2
~~~

## Variations
<!--meta block=variations-->

- **Abstract primitive operations** — Steps with no default that subclasses must implement — the compiler enforces that every variant fills them in.
- **Hook methods** — Steps with a default (often empty) body; overriding is optional, so subclasses opt into an extension point only when they need it.
- **Non-Virtual Interface (NVI)** — Keep the template method itself non-overridable and expose only the steps as virtual/protected — callers get one stable entry point.
- **[Factory Method](../creational/factory-method.md)** — When a varying step's whole job is to create an object, that step becomes a factory method the subclass supplies.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Removes duplication** by keeping the shared, unchanging steps in one place.
- **The base class owns the sequence**, so while the skeleton is final no variant can get the order wrong.
- **Variants fill in only what differs** — a new variant only has to fill in the steps that actually differ.
- **Optional hook methods give named extension points**, so a new variant adds behavior at an existing hook without editing the fixed skeleton; adding a new hook does edit it.

### Cons
<!--meta polarity=con-->

- **Built on inheritance**, so in a single-inheritance language such as Java or TypeScript each variant is locked to one base class and its lifecycle; handing the step in as a function, as in Strategy, lifts the lock.
- **The set of overridable steps** hardens into a contract that is painful to change later; keep the step list short and make fixed steps final.
- **Behavior is split** between the base class and its subclasses, so the real flow is hard to trace.
- **Deep hierarchies and many hooks** leave the skeleton rigid and brittle.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several procedures follow the same overall structure** but differ in a couple of steps.
- **You want to enforce one fixed sequence** of steps across every variant.
- **The varying steps are known up front** and stable in number.

### Avoid when
<!--meta polarity=avoid-->

- **The varying parts must swap independently** at runtime — reach for [Strategy](./strategy.md).
- **A variant must vary along two independent axes**, or already has a base class. One inheritance chain gives one axis; pass one step in as a function instead.
- **There is only one variant today** — the abstraction is premature.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a report skeleton with overridable steps"
interface Row { readonly name: string; readonly value: number }

abstract class ReportBuilder {
  // the template method: the fixed skeleton; TypeScript has no final, so subclasses must not override it (enforce by review or a test)
  build(): string {
    const body = this.loadRows()
      .map((row) => this.formatRow(row))
      .join("\n");
    return this.header() + body + this.footer();
  }

  // required steps: every variant must supply these
  protected abstract loadRows(): readonly Row[];
  protected abstract formatRow(row: Row): string;

  // hooks: sensible defaults, override only if needed
  protected header(): string { return ""; }
  protected footer(): string { return ""; }
}

class CsvReport extends ReportBuilder {
  protected loadRows(): readonly Row[] {
    return [{ name: "ada", value: 1 }, { name: "bob", value: 2 }];
  }
  protected formatRow(row: Row): string { return `${row.name},${row.value}`; }
  protected override header(): string { return "name,value\n"; }
}
```

## In the wild
<!--meta block=wild-->

- **javax.servlet.http.HttpServlet (jakarta.servlet.http.HttpServlet from Servlet 5.0)** — Its service() method owns the request-dispatch skeleton, reads the HTTP method, and calls down into the doGet/doPost/doPut steps a subclass overrides. Steps left unimplemented return a 405 Method Not Allowed by default, so the skeleton stays intact even when a variant fills in only one. {#wild-httpservlet}
- **JUnit** — JUnit 5 reaches the same fixed sequence through annotated methods, not by overriding a base class: the runner owns a fixed setup-test-teardown sequence and invokes the @BeforeEach and @AfterEach hooks you fill in around each @Test, never letting a test reorder the skeleton; @BeforeAll and @AfterAll bracket the whole class once. {#wild-junit}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Which steps are abstract** — Steps every subclass must supply, versus optional steps with a default body.
- **Hooks** — Methods with a default body, often empty, that a subclass may override to add behavior at a fixed point.
- **Final or overridable skeleton** — Whether the skeleton method can be overridden. Making it final stops a subclass from breaking the order.
- **Number of steps** — More steps give subclasses more control and more ways to misuse the skeleton.

### Signals to watch
<!--meta polarity=signal-->

- **Subclass overrides of the skeleton** — Subclasses that override the template method itself mean the skeleton does not fit.
- **Hierarchy depth** — Levels of subclassing beneath the base. Deep chains are hard to read.
- **Empty or copied overrides** — Subclasses that override a step only to copy the default or do nothing.
- **Test coverage per subclass** — Subclasses with no test that runs them through the skeleton. Count them; the target is zero.

### Failure modes under load
<!--meta polarity=failure-->

- **Fragile base class** — A change to the skeleton's order breaks every subclass in ways the compiler does not show. Pin the order with one base-class test that records the calls, and run every subclass through it.
- **Calling overridable methods in a constructor** — A subclass step runs before the subclass's fields are set, so it reads a null or default field. Move the work to an explicit init or run call made after construction, or pass the data in as arguments.
- **Skipped super call** — A subclass overrides a hook and forgets to call the parent's version, and a needed step does not run. This only happens where a hook's default body does real work; keep defaults empty, or move that work into a step the skeleton calls itself.
- **Inheritance lock-in** — A subclass wants to vary two things and the single hierarchy blocks it. Move one to a strategy.

### Readiness checklist
<!--meta polarity=check-->

- The skeleton method is final or documented as not to be overridden
- Each abstract step has a documented contract
- No constructor calls an overridable step
- Each subclass runs through the skeleton in a test

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Behavior](../../../themes/object-behavior.md) — Define an algorithm's outline in a base class and defer steps to subclasses. {#fluency-object-behavior}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Factory Method](../creational/factory-method.md) — A step in the template is often a factory method
- [Open/Closed Principle](../../../principles/open-closed.md) — The invariant skeleton is closed to change; its hooks are the extension points.
- [Liskov Substitution Principle](../../../principles/liskov-substitution.md) — The outline stays correct only if every subclass step is substitutable.

**Alternative to**

- [Strategy](./strategy.md) — Compose an algorithm vs. subclass to fill steps
- [Render Props](../../frontend/render-props.md) — Subclass hook vs. a function handed in at the call site

<!-- relationships:end -->
