---
title: Test Data Builder
description: Fluent construction of valid objects for test setup
area: testing
owner: Oleksandr Derechei
tags: [testing, readability, maintainability]
status: stable
solves: [i added one required field to a domain object and three hundred tests stopped compiling, every test opens with twenty lines of object setup that has nothing to do with what i am checking, i cannot tell which field in this fixture is the one the test actually cares about, our named factory methods have exploded into one per combination of fields, my test fixtures are copy-pasted across files and half of them are subtly invalid]
---

# Test Data Builder

Builds a fully valid instance of a domain object through a chain of readable `with*` calls, so a test states only the one or two fields its scenario actually cares about.

## What it is
<!--meta block=description-->

A test data builder is a small class that constructs one kind of domain object for tests. It starts from a complete, valid default and offers fluent withX() methods that override one field at a time, with build() assembling the result. It resolves the coupling of every test to the constructor's full shape: when a new field has a sensible default, only the builder changes. It is the alternative to Object Mother, whose factory methods multiply with each scenario.

## Explained
<!--meta block=explain-->

A test data builder is a small class that builds one kind of domain object for tests. It starts from a complete, valid default with every required field filled in, and offers methods such as withStatus that change only the fields a test cares about. A real order may have a dozen required fields, while a test looks at one, and building it by hand in every test ties all tests to the full constructor. Choose it over calling the constructor directly, or over a fixed set of premade objects, when tests vary different fields of a large object, because each test then shows only what is different.

- **Support code.** It is test code to write and keep right; build one only for objects used in many tests.
- **Hidden defaults.** Defaults can hide which field matters; name every override a test depends on.
- **Shared state.** A mutable builder shared between tests leaks overrides; create one per test, or make withX() return a copy.
- **Drift.** Defaults that drift from production data give false coverage; check them against real samples.

**Example.** An Order has 12 required fields and 80 tests construct it directly. A new required field, currency, makes all 80 fail to compile. With a builder that supplies a default currency, you add one line and the 80 tests are untouched. A test of cancelled orders reads anOrder().withStatus(cancelled) and nothing else. The cost shows when a shipping test passes only because the default status happens to suit it, and the test never says so. The fix is to state withStatus(paid) in that test.

## How it works
<!--meta block=structure-->

```mermaid caption="Start from a valid default instance, override the one field the scenario cares about, then build. The test never states the fields it doesn't care about."
flowchart LR
    T["Test"] -->|"anOrder()"| D["Builder, valid defaults"]
    D -->|"withStatus(cancelled)"| M["Builder, one field overridden"]
    M -->|"build()"| O["valid Order object"]
    O -->|"used by assertion"| T
```

## Variations
<!--meta block=variations-->

- **Mutable, in-place builder** — Each `withX()` mutates the builder's internal state and returns `this`. Simplest to write, but sharing one builder instance across tests risks one test's overrides leaking into another's.
- **Immutable / [copy-on-write](../concurrency/copy-on-write.md) builder** — Each `withX()` returns a new builder wrapping a copied state. A base builder can be defined once per suite and forked per test, as long as the copy is deep for collections or the state holds only immutable values.
- **Named scenario shortcuts** — Layer static factories like `aCancelledOrder()` on top of the general builder, borrowing Object Mother's readability for common cases while keeping arbitrary overrides available underneath.
- **Composite / nested builders** — A builder for an aggregate holds builders for its children — an `OrderBuilder` wrapping a list of `LineItemBuilder` — so a whole valid object graph can be built and overridden at any depth.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Every test gets a fully valid object** by default — only the relevant field needs stating.
- **Reads like the scenario itself**: `aUser().withRole(admin).build()` states intent, hides constructor plumbing.
- **Absorbs constructor and validation changes** into one place when the new field has a sensible default.
- **Composes — nested builders** let a whole valid object graph stay easy to construct and override.

### Cons
<!--meta polarity=con-->

- **It's extra test-support code that itself needs writing**, reviewing, and maintaining.
- **Sensible defaults can hide** from the reader which fields actually matter to a given test.
- **A mutable, shared builder** instance can leak overrides between tests if reused carelessly.
- **Defaults that drift** from real production data give a false sense of coverage.
- **A builder can skip invariants** the real constructor enforces, so tests may build states the domain forbids.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The domain object has several required fields** but most tests only care about one or two.
- **Constructors or validation rules change often enough** that hand-written fixtures keep rotting.
- **You want tests to read as "everything normal**, except this one thing."

### Avoid when
<!--meta polarity=avoid-->

- **The object is trivial to construct** — a builder just adds ceremony over a two-argument call.
- **You need to drive UI interactions** rather than assemble data — that's [Page Object](./page-object.md)'s job.
- **A few fixed, well-named scenarios cover every test**, so a plain Object Mother factory is simpler.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a builder for a test order"
type Status = "pending" | "paid" | "cancelled";

interface Order {
  id: string;
  status: Status;
  items: { sku: string; qty: number }[];
}

class OrderBuilder {
  constructor(private readonly order: Order = { id: "ord_1", status: "pending", items: [{ sku: "widget", qty: 1 }] }) {}

  withStatus(status: Status): OrderBuilder {
    return new OrderBuilder({ ...this.order, status });
  }

  build(): Order {
    return { ...this.order, items: [...this.order.items] };
  }
}

const anOrder = () => new OrderBuilder();

// The test states only what's different from a valid default.
const base = anOrder(); // shared, never mutated
const cancelled = base.withStatus("cancelled").build();
const paid = base.withStatus("paid").build(); // base is unchanged
```

## In the wild
<!--meta block=wild-->

- **factory_bot** — The Ruby fixture library; each factory defines a valid default with a \`factory\` block, a test overrides only the attributes its scenario needs, and traits and associations compose whole object graphs. {#wild-factory-bot}
- **factory_boy** — Brings defaults-plus-overrides fixture construction to Python; \`SubFactory\` builds nested objects and Faker or sequences fill fields, so a test states only what differs from a valid default. {#wild-factory-boy}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Default field values** — The complete, valid baseline every build starts from — the object a test gets before it overrides anything.
- **Mutable vs copy-on-write** — A mutable builder mutates internal state and returns this; an immutable one returns a new builder per withX(), so a shared base builder can be forked per test without contamination.

### Failure modes under load
<!--meta polarity=failure-->

- **Shared mutable state leak** — Reusing one mutable builder instance across tests lets one test's overrides bleed into another, creating order-dependent, flaky failures.
- **Drifting defaults** — Builder defaults that diverge from real production data let tests pass against unrealistic objects and give a false sense of coverage.

### Readiness checklist
<!--meta polarity=check-->

- The default build() produces a fully valid object that passes the domain's own validation, and a test runs it through that validation.
- The builder is immutable or reset per test so no override leaks across cases.
- Defaults are reviewed against real production shape as the domain type evolves.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Testing](../../themes/testing.md) — Build test data from valid defaults, overriding only what the test cares about. {#fluency-testing}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Page Object](./page-object.md) — Build data, drive the page object
- [Arrange-Act-Assert](./arrange-act-assert.md) — Fills the Arrange step without constructor ceremony

**Specializes**

- [Builder](../gof/creational/builder.md) — A builder pattern for test fixtures

<!-- relationships:end -->
