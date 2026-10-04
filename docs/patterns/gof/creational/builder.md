---
title: Builder
description: Construct a complex object step by step
area: gof-creational
owner: Oleksandr Derechei
tags: [low-level-design, lifecycle, readability, validation, immutability]
status: stable
solves: [my constructor takes eleven arguments and half of them are null at every call site, "nobody reading new Pizza(true, false, true, 12) can tell what those flags mean", I already have six overloaded constructors and one more optional field means a seventh, every test fixture repeats twenty lines of setup just to change one field, I have to assemble this thing in several steps but callers can grab it while it is still half-finished]
---

# Builder

Assembles a complex object through a sequence of small, readable steps — so construction logic lives apart from the object's final shape, and the same steps can yield different representations.

## What it is
<!--meta block=description-->

An object with many fields, several of them optional, ends up with a wall of positional constructor arguments no one can read, and each new option adds an overload. A builder replaces them with named, order-independent steps and a final build call. In the classic form a Director scripts the steps; most code drops it.

## Explained
<!--meta block=explain-->

A builder assembles an object through small named steps, such as timeout(30), and then hands back the finished object from a build() call. It replaces one constructor with a long list of positional arguments, where you cannot tell which number means what. Choose it over constructor overloads when many fields are optional or must be checked together, because the call site then describes itself and, when build() validates, the object is valid the moment it exists. If your language has named and default arguments, those give the same readability without a second class.

- **Duplicated field list.** The builder repeats the product fields, so every schema change is two edits. Generate the builder or test that both lists match.
- **Unforced steps.** A plain chain cannot force required steps, so check them in build() and throw a clear error, or use a staged builder.
- **Leaky reuse.** A reused builder keeps the first object's values, so create one per object or clear its state in build().

**Example.** An HTTP request has 8 fields and one is required, the url. The call get("/a", 30, null, null, true, null, 3, false) cannot be read. With a builder it reads request.url("/a").timeout(30).retries(3).build(). A developer leaves out url(), and \`build()\` throws "url is required" at once instead of sending a half-made request. Another developer reuses one builder for two requests, and the second request inherits retries(3) from the first. The fix is one builder per request. The cost is that adding a ninth field means editing both the request class and its builder.

## How it works
<!--meta block=structure-->

```mermaid caption="The Director scripts the steps, the Builder accumulates the parts, and the finished Product is handed back only at the end."
sequenceDiagram
    autonumber
    participant C as Client
    participant D as Director
    participant B as Builder
    C->>D: construct()
    D->>B: buildPartA()
    D->>B: buildPartB()
    D->>B: getResult()
    alt all required parts set
        B-->>C: finished Product
    else missing required part
        B--xC: build error
    end
```

## Variations
<!--meta block=variations-->

- **Fluent (chained) builder** — Each step returns `this`, so calls chain into one readable expression ending in `build()`. The most common modern form.
- **Director-driven vs. builder-only** — Keep a Director to encapsulate a canonical build recipe, or drop it and let the client sequence the steps itself. Most code today skips the Director.
- **Staged (step) builder** — Return a different interface from each step so the type system enforces required fields and ordering — you can't call `build()` until the mandatory steps are done.
- **[Test Data Builder](../../testing/test-data-builder.md)** — A builder seeded with sensible defaults, where a test overrides only the one field it cares about — fixtures stay terse and intention-revealing.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Assembles a complex object** one step at a time, so construction reads top to bottom.
- **Separates how an object is built** from what it ends up as; in the classic form one Director drives different builders to different products, while a fluent builder makes one.
- **Replaces telescoping constructors** and long positional argument lists with named, chained steps.
- **Can check required fields and rules** before it hands back the finished object.

### Cons
<!--meta polarity=con-->

- **More code**: a separate builder class for each product repeats its fields, so every schema change is two edits. Generate the builder, or use named arguments where the language has them.
- **Overkill for simple objects** that have only a few fields.
- **Without guards**, a half-configured builder can hand back an incomplete object.
- **A builder holds mutable state**, so reusing one instance across builds can leak values between them; create one per object or reset it in build().
- **Each build allocates a throwaway builder** beside the product. That is cheap once, but a parser or serializer building one object per row allocates twice on a hot path; construct directly there, or reuse one builder that resets its state.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **An object takes many parameters**, several of them optional.
- **Building it is multi-step**, order-sensitive, or needs validation along the way.
- **You want one build process** to produce several different representations of the result.

### Avoid when
<!--meta polarity=avoid-->

- **The object is simple** — a plain constructor or factory reads better.
- **All fields are required** and there are only a few; positional arguments are clear enough.
- **Immutable records with named arguments** already express the intent clearly.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a fluent builder that validates before producing an immutable request"
interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}
// Each step returns `this`, so calls chain into one readable expression.
class RequestBuilder {
  private method: HttpRequest["method"] = "GET";
  private url?: string;
  private readonly headers: Record<string, string> = {};
  private body?: string;
  to(url: string): this { this.url = url; return this; }
  using(method: HttpRequest["method"]): this { this.method = method; return this; }
  json(payload: unknown): this {
    this.headers["Content-Type"] = "application/json";
    this.body = JSON.stringify(payload);
    return this;
  }
  build(): HttpRequest {
    if (!this.url) throw new Error("a request needs a URL");   // validate first
    return { method: this.method, url: this.url, headers: { ...this.headers }, body: this.body };
  }
}
const request = new RequestBuilder()
  .to("https://api.example.com/orders")
  .using("POST")
  .json({ sku: "A-17", qty: 2 })
  .build();
```

## In the wild
<!--meta block=wild-->

- **java.net.http.HttpRequest.Builder** — Part of the java.net.http client (Java 11+): HttpRequest.newBuilder() returns a Builder whose uri, header, timeout and GET/POST steps chain, and build() snapshots the current state into an immutable HttpRequest. The same builder can be reconfigured and built again to produce related requests. {#wild-java-httprequest-builder}
- **Rust std::process::Command** — Command::new(program) then .arg/.args, .env/.env_remove, .current_dir and the .stdin/.stdout/.stderr steps mutate the builder in place; .spawn() launches the child asynchronously while .output() runs it to completion and captures stdout and stderr, and .status() waits for the exit code. {#wild-rust-process-command}
- **Project Lombok @Builder** — Annotating a Java class with @Builder generates a static builder() method and a nested Builder with a setter per field plus build(), at compile time. @Builder.Default supplies field defaults and @Singular generates add-one and add-all methods for collection fields, removing the boilerplate the pattern normally costs. {#wild-lombok-builder}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Required versus optional fields** — What the builder constructor demands and what has a default. Required fields in the constructor stop a half-built object, and a typed language rejects the omission at compile time. Rules between several fields still need the check in build.
- **Validation point** — At each setter or once in build. Checking in build lets fields depend on each other.
- **Reusable builder** — Whether one builder can produce many objects, and whether build copies state or hands it over. Copy when one builder serves many objects, since handed-over state is shared with earlier products. Hand it over only for a builder used once, which saves the copy.
- **Fluent or stepwise** — A chained interface, or a staged builder that forces an order with one interface per step. Choose staged when a missing required field must fail at compile time; stay with the chain when the check in build is enough.

### Signals to watch
<!--meta polarity=signal-->

- **Constructor argument counts** — Constructors with many parameters, or telescoping overloads, are where a builder pays off. Count parameters per constructor and overloads per class, then set your team's own limit for when a class gets a builder.
- **Build-time failures** — Count of errors raised in build, one counter per validation rule. A rising count means callers pass invalid combinations that build catches early; zero while products still fail later means build checks too little.
- **Allocation per object** — The builder creates extra objects on a hot path, shown by a profiler.
- **Fields added without builder change** — Count of product fields the builder never sets. A test that checks both field lists match turns each gap into a failure.

### Failure modes under load
<!--meta polarity=failure-->

- **Half-built object** — A builder lets build run with a required field unset and the product fails later. Validate in build.
- **Builder reuse leaks** — A builder reused for a second object carries fields from the first.
- **Mutable product** — The product exposes setters after build and the builder bought no safety.
- **Builder drift** — The builder and the product fall out of step when fields are added. Generate the builder or test that every field is set.

### Readiness checklist
<!--meta polarity=check-->

- build validates required fields and rules between fields
- A reused builder resets or copies its state
- The built object is immutable, or the exposure is on purpose
- Tests build the object through every optional field

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Creation](../../../themes/object-creation.md) — Construct a complex object step by step instead of one huge constructor. {#fluency-object-creation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Principle of Least Astonishment](../../../principles/least-astonishment.md) — Named construction makes an unexpected argument order impossible
- [Make Illegal States Unrepresentable](../../../principles/make-illegal-states-unrepresentable.md) — A staged builder makes the compiler reject build() until required fields are set
- [Immutability](../../functional/immutability.md) — The steps mutate the builder; build() hands back one immutable product

**Alternative to**

- [Abstract Factory](./abstract-factory.md) — Families of products vs. one product built in steps
- [Factory Method](./factory-method.md) — Stepwise assembly vs. a single creating call
- [Prototype](./prototype.md) — Assemble explicitly vs. clone something already assembled

**Generalizes**

- [Test Data Builder](../../testing/test-data-builder.md) — A builder pattern for test fixtures

<!-- relationships:end -->
