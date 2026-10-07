---
title: Arrange-Act-Assert
description: "Set up state, perform the action, check the outcome"
area: testing
owner: Oleksandr Derechei
tags: [testing, readability]
status: stable
aliases: [AAA, Given-When-Then, GWT]
solves: [i cannot tell what my test is actually verifying without reading every line, our tests all look different depending on who wrote them, setup and assertions are tangled together so i cannot find the actual check, i wrote a test that passes but i am not sure it checks anything at all, reviewing a test takes me longer than reviewing the code it covers]
---

# Arrange-Act-Assert

Set up the state a test needs, perform the one action under test, then check the outcome — three sections, always in that order, so any test reads the same way at a glance.

## What it is
<!--meta block=description-->

Arrange-Act-Assert is a way to shape a test body, not a library: arrange builds inputs and preconditions, act calls the one behaviour under test, assert checks the result, in that order. Tests are read far more than written, so a fixed shape shows a reader what is under test and what is expected, and exposes a missing act or assert. Bill Wake named it in 2001.

## Explained
<!--meta block=explain-->

Arrange-Act-Assert is a way to lay out a test body in three visible parts, in order: arrange builds the inputs and starting state, act calls the one behaviour under test, and assert checks the result. Tests are read far more often than written, usually by someone trying to learn what broke, and a test that mixes setup, calls and checks makes that reader trace the flow line by line. Choose it over a free-form test for any test with a fixed input and one outcome, because a failed assert points at one act and one expected result. A test with no real act or no real assert is also easy to spot.

- **Bloated assert.** An assert block can grow to check many unrelated things, so test one behaviour and assert one outcome.
- **Repeated arrange.** Long setup repeats across tests, so move it into a helper or builder.
- **Fused act.** Catching a thrown error joins act and assert, so treat the call wrapped in the expectation as the act.
- **No cleanup slot.** Cleanup has no part of its own, so give it a named fixture.

**Example.** A transfer test is written as 12 interleaved lines: create an account, check it, create another, move 30, check, move again, check. It fails at line 9, and you must read all 9 lines to learn which step is wrong. Rewritten, arrange creates accounts holding 100 and 50, act moves 30 once, and assert expects 70 and 80. A failure now names the assert and the one act above it. The cost is that, say, a 6-line arrange block repeats across 40 transfer tests, 240 lines, so it moves into one makeAccounts helper.

## How it works
<!--meta block=structure-->

```mermaid caption="Every test moves through the same three steps in order: build the world, do the one thing, check what happened."
flowchart LR
    A["Arrange, build inputs and preconditions"] -->|"inputs ready"| B["Act, invoke the behavior under test"]
    B -->|"captured outcome"| C["Assert, check the outcome matches expectation"]
    B -.->|"invokes"| D["System under test"]
```

## Variations
<!--meta block=variations-->

- **Given-When-Then** — The BDD vocabulary for the identical three-part shape — Given sets up state, When performs the action, Then checks the outcome.
- **Four-phase test** — Wraps AAA in explicit setup and teardown phases, so shared fixture management is separated from the arrange step of any single test. Teardown is for state outside the test, such as files, connections or global stubs; in-memory objects need none.
- **Table-driven / parameterized AAA** — One Arrange-Act-Assert body runs once per row of a data table, replacing many near-duplicate tests with one documented case shape. Split a row into its own test once its arrange or assert differs from the rest.
- **[Test data builders](./test-data-builder.md) / Object Mother** — Push the Arrange phase behind a builder or factory function, so each test states only the inputs that matter to the case at hand.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Every test reads the same way**, so a reviewer understands intent without tracing control flow.
- **Cleanly separates setup**, the behavior under test, and the check, so failures are easy to localize.
- **No library or framework required** — it's a naming and ordering convention on plain test functions.
- **Makes an incomplete test**, one with no real Act or no real Assert, visible on sight.

### Cons
<!--meta polarity=con-->

- **Doesn't stop a bloated Assert block** from checking many unrelated things in one test.
- **A heavy Arrange section**, repeated across many tests, is a common source of duplicated fixture code.
- **The three-way split feels forced** when acting and asserting are inseparable, like catching a thrown exception.
- **Says nothing about teardown** — teams routinely bolt on a fourth phase informally.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Writing any unit or integration test** with a fixed input, one action and one expected outcome.
- **Consistent tests across a codebase** — tests should read the same way, whoever wrote them.
- **Newcomers skimming the suite** — engineers new to the code need to skim the suite and infer behaviour fast.

### Avoid when
<!--meta polarity=avoid-->

- **The test is property-based and generates many inputs** — there's no single fixed state to arrange.
- **You compare the whole output** in one go, not discrete expectations — that is [Golden Master](./golden-master.md) territory: use it when the output is too large to list expectations one by one.
- **The test is a throwaway exploratory spike**, never meant to stay in the suite.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a test in Arrange-Act-Assert form"
import { describe, it, expect } from "vitest";
import { ShoppingCart } from "./shopping-cart";

describe("ShoppingCart", () => {
  it("applies a percentage discount to the subtotal", () => {
    // Arrange
    const cart = new ShoppingCart();
    cart.add({ sku: "sku-1", priceCents: 1000, qty: 2 });
    cart.add({ sku: "sku-2", priceCents: 500, qty: 1 });

    // Act
    const total = cart.applyDiscount(0.1); // 10% off

    // Assert
    expect(total).toBe(2250); // (2000 + 500) * 0.9
  });
});
```

## In the wild
<!--meta block=wild-->

- **Bill Wake, "3A - Arrange, Act, Assert"** — The article that named the structure for unit tests: set up the object, perform the action, and check the result. {#wild-wake-3a}
- **Cucumber** — Gherkin scenarios are written as Given, When and Then steps, the same three-part shape applied to behaviour specifications. {#wild-cucumber}

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Testing](../../themes/testing.md) — Write each test as arrange, act, assert and nothing else. {#fluency-testing}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Page Object](./page-object.md) — Page objects supply the single-line Act
- [Test Data Builder](./test-data-builder.md) — Builders collapse Arrange into one readable line
- [Test Spy](./test-spy.md) — Spies push interaction checks into Assert

**Alternative to**

- [Golden Master](./golden-master.md) — Snapshot the whole output vs. assert specifics

<!-- relationships:end -->
