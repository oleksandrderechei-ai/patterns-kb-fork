---
title: Dummy Object
description: "Passed in to satisfy a signature, never actually used"
area: testing
owner: Oleksandr Derechei
tags: [testing, readability, isolation]
status: stable
aliases: [dummy]
solves: [my constructor takes six dependencies and this test only cares about one of them, i am building elaborate fakes for collaborators this test never even touches, my test setup is fifteen lines of noise before the one line that actually matters, i passed null just to fill an argument and now i cannot tell if the code quietly used it, i need something to fill this parameter and it genuinely does not matter what]
---

# Dummy Object

Handed to a constructor or method purely to satisfy its parameter list — the object is passed in, maybe stored, but never read, called, or asserted against by the path a test actually exercises.

## What it is
<!--meta block=description-->

A dummy object is the simplest of Meszaros' test doubles: an object passed only because a signature demands one, never read, called or asserted on by the path a test exercises. A stub returns canned values and a mock verifies usage; a dummy does neither. It resolves the mismatch between constructors that take every collaborator and a test that drives one narrow path. It is whatever is cheapest: null, an empty literal, or a class that throws if called.

## Explained
<!--meta block=explain-->

A dummy object is a placeholder you pass to satisfy a required parameter that the test's code path never uses. A constructor often asks for every helper a class will ever need, while one test drives a narrow path through it. Building a real logger or database client just to fill the slot slows the test and pulls in setup that is irrelevant to it. Choose it over a stub or fake, which are doubles that return canned or working answers, when you are sure the object is never called.

- **Silent drift.** A do-nothing dummy hides it when code starts using the object; make the dummy throw on any call.
- **Hidden coupling.** Dummies make long constructors cheap, so nothing flags too many collaborators; count the dummies a test needs and consider splitting the class.
- **Outgrown.** Once the object's behaviour matters, replace the dummy with a stub, fake or mock.

**Example.** An OrderTotal class takes a tax service it does not use in sum(). The test passes a dummy and checks that sum of 12 and 8 is 20. Later someone adds a 10% tax call inside sum(), so the real result is 22. A do-nothing dummy returns 0 tax and the test still shows 20, a green test over code that now needs the tax service. A throwing dummy fails the test the moment the call happens, with a message that the dummy was used. The cost is that you edit that test, replacing the dummy with a stub that returns a tax rate.

## How it works
<!--meta block=structure-->

```mermaid caption="The test passes the dummy only so the constructor's signature is satisfied — the path under test never calls it."
flowchart LR
    T["Test"] -->|constructs| S["System under test"]
    T -->|passes| D["Dummy Object"]
    D -.->|never invoked| S
```

## Variations
<!--meta block=variations-->

- **Null dummy** — Pass `null` or `undefined` where the type allows it. It fails once the callee validates arguments. A call on it fails with a generic null error, not a message saying the dummy was used, and it does not tell the reader why the parameter is there.
- **Throwing dummy** — Every method throws immediately, turning an accidental call into a hard test failure instead of a silent pass.
- **No-op dummy** — Every method is implemented but does nothing and returns a harmless default, so an unexpected call passes unnoticed. Use it only where the code under test legitimately calls the collaborator on an untested side path, such as best-effort logging; otherwise default to throwing.
- **Dummy value** — A placeholder primitive — an empty string, a zero, a fixed id — where a whole object isn't required, just a value the code never inspects.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Cheapest possible test double** — nothing to configure, verify, or maintain.
- **A named or throwing dummy** marks the dependency as deliberately unused, instead of quietly faking behavior for it.
- **A throwing variant turns an unexpected call** into an immediate, loud test failure, unless the code under test catches the exception.
- **Keeps a test's setup focused** on the one collaborator that actually matters.

### Cons
<!--meta polarity=con-->

- **Valid only while unused** — Valid only while the path never touches it; once it does, a no-op dummy passes silently.
- **Easy to reach for by default**, papering over a constructor that takes too many collaborators.
- **Every test that builds the class** must supply the dummy, so adding a constructor parameter touches all of them.
- **Doesn't help once the parameter's behavior matters** — that call belongs to a Stub, Fake, or Mock instead.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The signature requires an argument** that this test's particular path never touches.
- **You want the lightest possible double** — no return values to configure, no calls to verify.
- **You want a broken "never used" assumption** to fail the test loudly: use the throwing variant. It does not fail if the code under test catches exceptions around the collaborator.

### Avoid when
<!--meta polarity=avoid-->

- **The code under test reads a value** from the object — supply canned data with a Test Stub instead.
- **You need to assert** the object was called in a particular way — reach for a Mock or Spy.
- **Every test needs the collaborator's real behavior** — a Fake is worth the extra setup.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a throwing dummy logger"
interface Logger {
  log(message: string): void;
}

// Dummy: satisfies the Logger parameter, must never actually be called.
class DummyLogger implements Logger {
  log(): never {
    throw new Error("DummyLogger.log() should never be invoked");
  }
}

class OrderTotal {
  constructor(private readonly logger: Logger) {}

  // This path never logs, so the dummy is safe here.
  sum(items: { price: number }[]): number {
    return items.reduce((total, item) => total + item.price, 0);
  }
}

test("sums item prices without touching the logger", () => {
  const order = new OrderTotal(new DummyLogger());
  expect(order.sum([{ price: 12 }, { price: 8 }])).toBe(20);
});
```

## In the wild
<!--meta block=wild-->

- **Mockito** — A mock created with \`mock(Type.class)\` and never stubbed returns default values (null, zero, empty collections) from every method, so it serves as a no-op dummy for a parameter the code under test does not use. {#wild-mockito}
- **Python unittest.mock.sentinel** — \`sentinel.NAME\` returns one unique object per name (the same object each time that name is used), which makes a handy dummy value for an argument the test never inspects; its repr shows the name when a failure prints it. {#wild-python-sentinel}

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Testing](../../themes/testing.md) — Pass a placeholder where a signature needs an argument the test never uses. {#fluency-testing}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Test Stub](./test-stub.md) — Never used vs. returns canned values
- [Null Object](../gof/extra/null-object.md) — Test-only filler vs. a production do-nothing collaborator
- [Mock Object](./mock-object.md) — Never called at all vs. programmed expectations

<!-- relationships:end -->
