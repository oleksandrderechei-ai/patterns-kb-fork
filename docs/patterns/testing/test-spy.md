---
title: Test Spy
description: Records how it was called so the test can check later
area: testing
owner: Oleksandr Derechei
tags: [testing, isolation, testability]
status: stable
aliases: [spy]
solves: [i suspect this function runs twice on every request but i cannot prove it, i want to check what arguments my code passed to the logger and nothing records them, my callback fires somewhere deep in the call chain and i have no way to tell if it ran, i need to know how many times my code retried before it gave up, declaring every expected call before the code even runs makes my tests unreadable]
---

# Test Spy

A test spy stands in for a real collaborator during the exercise phase and records every call it receives — arguments, order, count — so the test can inspect that history afterward and assert on how the code under test actually behaved.

## What it is
<!--meta block=description-->

A test spy replaces a real collaborator and quietly records each call it receives: which method, which arguments, how many times and in what order. The test runs the code as normal, then asserts on the recorded history. It makes invisible interactions, such as an email sent or an event published, inspectable. Unlike a mock it does not fail on an unexpected call itself, and unlike a stub it remembers.

## Explained
<!--meta block=explain-->

A test spy stands in for a real collaborator and quietly records every call it receives, which method, with which arguments, how many times and in what order. The test runs the code as usual, then reads the record and judges it. Use it when the behaviour leaves no trace the test can read, such as an email sent or an event published. Choose it over a [mock](mock-object.md) when you want the test, not the double, to decide pass or fail, because a classic mock fails in the middle of the call, while a spy records and leaves the verdict to the test, though a call-through spy still raises whatever the real object raises. Choose it over a [stub](test-stub.md), which keeps no record, when the call itself matters.

- **Brittle call shapes.** Exact call shapes break on harmless refactors, so assert only the fields that matter.
- **Outcome blindness.** Checking how the code called its helper says nothing about what it achieved, so also check the outcome.
- **Argument matching.** Complex arguments need matching logic, so compare one field at a time.
- **Change detector.** Many spies with no outcome checks make the suite fail on refactors that change no behaviour, so add outcome checks or cut spies.

**Example.** placeOrder should send one confirmation. A retry bug sends it twice for the 3% of orders that retry, 30 duplicate emails a day across 1,000 orders. No return value or stored state shows this. A spy records two send calls, and the test asserts the record holds exactly one. The test then fails with a count of 2. The cost: when the team later sends confirmations in batches, the spy sees one call with many orders and the test breaks although every customer still gets the email, so you rewrite it to check recipients sent, not number of calls.

## How it works
<!--meta block=structure-->

```mermaid caption="The spy stands in during the exercise phase and records what happened. Only after execution finishes does the test read that history back and assert on it."
sequenceDiagram
    autonumber
    participant T as Test
    participant S as Spy
    participant R as Real collaborator
    T->>S: inject spy in place of collaborator
    Note over S: exercise phase, spy records each call
    S-->>R: optional call-through
    T->>S: read recorded call history
    alt call matches expectation
        S-->>T: history confirms it, assert passes
    else missing or wrong call
        S--xT: assert fails after the fact
    end
```

## Variations
<!--meta block=variations-->

- **Recording spy** — Pure record-only: implements the collaborator's interface, does nothing but push each call onto a list, returns nothing meaningful.
- **Call-through spy** — Wraps a real object and delegates every call after recording. It checks the wiring and adds no expectations; this is the shape behind `sinon.spy(obj, "method")` or Jest's `spyOn`.
- **Spy with canned return** — Records calls and answers with a fixed value, so a single object covers both the input side (stub) and the observation side (spy) of the same collaborator.
- **Framework-generated spy** — Auto-created by the test framework (`jest.fn()`) rather than hand-written; records the same way, with no hand-written class.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Makes invisible interactions visible**: you can assert on arguments, call count, and order, not just return values.
- **Verification happens after the exercise phase**, so setup and assertion stay cleanly separated.
- **Works on silent collaborators** that have no return value or observable state.
- **Can call through to the real implementation**, checking the wiring without declaring expectations up front.

### Cons
<!--meta polarity=con-->

- **Couples the test to implementation details** — exact call shape breaks on harmless refactors.
- **Tests how, not what** — overused, it tests how code called a collaborator instead of what the code accomplished.
- **Matching recorded arguments against** expected ones needs its own logic once arguments get complex.
- **A pile of spies** with no assertions on outcome turns a test suite into a change-detector.
- **Captures references** — The spy stores argument references, so a later mutation by the code under test changes what the record shows; copy the arguments when recording.
- **Leaks between tests** — Spies on shared objects keep recorded calls and patches across tests unless reset or restored after each one, so order-dependent failures appear.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need to verify a call happened** — its arguments, count, or order — and nothing else reveals it.
- **Assertions belong after the exercise phase**, not declared as expectations beforehand.
- **The collaborator's own behavior is irrelevant**; you only care that it was invoked correctly.

### Avoid when
<!--meta polarity=avoid-->

- **The interaction isn't part of the contract** — assert on the observable outcome instead of the call.
- **Failure must be raised** the instant an unexpected call happens — use a [Mock Object](./mock-object.md) with expectations set in advance.
- **A canned response is all the test needs** — reach for a [Test Stub](./test-stub.md) instead of adding recording machinery.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a hand-rolled recording spy"
interface Notifier {
  send(to: string, subject: string): void;
}

// Implements the real interface, just records what it's given
class NotifierSpy implements Notifier {
  readonly calls: Array<{ to: string; subject: string }> = [];
  send(to: string, subject: string): void {
    this.calls.push({ to, subject });
  }
}

class OrderService {
  constructor(private readonly notifier: Notifier) {}
  placeOrder(order: { id: string; email: string }): void {
    this.notifier.send(order.email, `Order ${order.id} confirmed`);
  }
}

test("placing an order notifies the customer", () => {
  const spy = new NotifierSpy();                    // exercise
  new OrderService(spy).placeOrder({ id: "42", email: "a@b.com" });

  expect(spy.calls).toHaveLength(1);                 // verify, after the fact
  expect(spy.calls[0].to).toBe("a@b.com");
});
```

## In the wild
<!--meta block=wild-->

- **Jest jest.fn() / jest.spyOn** — \`jest.fn()\` and \`jest.spyOn\` create functions that record every call and its arguments; the test inspects them afterwards with matchers like \`toHaveBeenCalledWith\` and \`toHaveBeenCalledTimes\`, and \`spyOn\` calls through to the original unless a mock implementation is supplied. {#wild-jest-fn}
- **Sinon.JS sinon.spy** — \`sinon.spy(obj, 'method')\` wraps an existing method, recording calls in \`spy.args\` and \`spy.callCount\` while passing through to the real implementation, or \`sinon.spy()\` creates a standalone recording function. {#wild-sinon-spy}
- **Python unittest.mock** — Its \`Mock\` objects expose \`call_args\`, \`call_args_list\` and \`call_count\` so a test can assert on the recorded calls after the exercise phase, and \`assert_called_with\` checks the last call. The same object also takes canned return values, so it serves as stub and spy at once. {#wild-unittest-mock}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Record-only vs call-through** — A pure spy records calls and returns nothing meaningful; a call-through spy wraps the real object and delegates after recording, verifying the wiring without adding expectations.
- **Argument matching** — Whether recorded arguments are compared exactly or against a looser matcher — a subset of fields, a type, a predicate — when asserting after the fact.

### Failure modes under load
<!--meta polarity=failure-->

- **Coupling to call shape** — Asserting on the exact recorded call breaks on a harmless refactor that changed how, not whether, the collaborator was called.
- **Change-detector suite** — A pile of spies with no assertion on the observable outcome tests how code called a collaborator instead of what it accomplished.
- **Mutable-argument capture** — A spy stores the argument reference, not a copy; if the code under test mutates that object after the call, the recorded value reflects the later state, not what was actually passed.

### Readiness checklist
<!--meta polarity=check-->

- Assert on the spy only when the interaction itself is the contract — a side effect with no return value or state.
- Keep an outcome assertion alongside the call assertion so the test proves the effect, not just the call.
- Match the minimal facets that matter — count, key arguments — not the whole recorded call.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Testing](../../themes/testing.md) — Record how a collaborator was called and check it after the act. {#fluency-testing}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Arrange-Act-Assert](./arrange-act-assert.md) — Recorded calls are read back in the Assert step
- [MVP](../architecture/mvp.md) — A view interface of plain setters is trivial to record calls on

**Often confused with**

- [Test Stub](./test-stub.md) — Canned answers vs. recorded calls
- [Mock Object](./mock-object.md) — Record and assert later vs. expect up front

<!-- relationships:end -->
