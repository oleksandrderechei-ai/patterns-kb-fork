---
title: Mock Object
description: "Pre-programmed with expectations, fails if they're unmet"
area: testing
owner: Oleksandr Derechei
tags: [testing, isolation, decoupling]
status: stable
aliases: [mock]
solves: [my code sends an email and there is nothing left over for the test to assert on, "the only thing this method does is call something else, so how do i test it at all", i do not want my test suite actually charging a real credit card, i want to check the right event got published but there is no queue running in my test, i cannot confirm the audit entry was written without standing up a real database]
---

# Mock Object

A test double pre-loaded with the exact calls it expects to receive — right method, right arguments, right number of times — that fails the test outright the moment reality diverges from the script.

## What it is
<!--meta block=description-->

A mock object is a test double programmed before the code runs with the calls it expects: which method, which arguments, how many times. It fails the test on an unexpected, wrong or missing call. It resolves the gap in state-based testing for collaborators with nothing to read back afterwards, such as sending an email or charging a card, where the call itself is the result. It verifies behaviour, where a stub or fake lets a test check state.

## Explained
<!--meta block=explain-->

A mock object is a test double loaded before the test runs with the calls it should receive, which method, with which arguments, how many times, and it fails the test when the code makes a different call or leaves one out. Use it when the outcome you care about is a call and nothing else shows it, such as sending an email, publishing a message or charging a card. Choose it over a stub or fake, which let you check the final state, when there is no state to read afterwards.

- **Coupling to calls.** The test is tied to how code calls its collaborator; mock only at the system edge, where the call is the result.
- **Over-specified.** Tight expectations make a harmless refactor break many tests; expect only what matters.
- **Needless mocks.** Mocking simple value objects adds nothing; use real ones.
- **Call, not effect.** It proves a call happened, not that the real effect was right; keep one test against the real service.

**Example.** A refund service must call gateway.refund with payment pay_7 and 2,500 cents exactly once. A retry bug makes it call twice, so the customer gets 5,000 cents back instead of 2,500. State shows nothing, because the gateway returns success both times. A mock expecting one call fails on the second, naming the extra call. The cost arrives when the team batches refunds into one call per hour: customers are still refunded correctly, but, say, 14 tests that expected one call per refund now fail and must be rewritten to expect the batch.

## How it works
<!--meta block=structure-->

```mermaid caption="The test programs the mock's expectations before the run, then asks it to verify them afterward — the mock itself decides whether the test passes."
sequenceDiagram
    autonumber
    participant T as Test
    participant M as Mock
    participant S as SUT
    T->>M: expect send(to, subject) once
    T->>S: run()
    S->>M: send(to, subject)
    T->>M: verify()
    alt expectation met
        M-->>T: pass
    else call missing or wrong args
        M--xT: fail, expectation unmet
    end
```

## Variations
<!--meta block=variations-->

- **Hand-rolled mock** — A small class written by hand that implements the collaborator's interface, records expected calls and has its own `verify()`. It needs no framework and gives full control, but takes more boilerplate.
- **Framework-generated mock** — Libraries like Mockito, jMock, Moq, or Sinon generate the double at runtime via reflection or proxies; expectations are set with a fluent DSL (domain-specific language) instead of hand-written code.
- **Strict vs. nice mocks** — A strict mock fails the test on any call it wasn't told to expect; a nice (lenient) mock quietly returns a default for unexpected calls, trading precision for less brittle setup.
- **Ordered expectations** — Some frameworks let a mock fail not just on the wrong call but on the right call in the wrong order — useful when the sequence of calls is itself part of the contract.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Tests behavior that has no observable return value** or state to assert on directly.
- **Fails fast and precisely** — pinpoints exactly which expected call was missed or malformed.
- **Replaces the real collaborator**, so the test avoids its latency, flakiness and side effects and gives the same result each time.
- **Forces a narrow**, explicit collaborator interface, which tends to improve its design.

### Cons
<!--meta polarity=con-->

- **Couples the test to an implementation detail** — how the SUT calls its collaborator — not just the outcome.
- **Over-specified expectations turn a harmless refactor** into a wave of broken tests.
- **Easy to overuse**: mocking every collaborator, including simple value objects that don't need it.
- **Verifies that calls happened**, not that the real-world effect behind them was correct end to end.
- **Mock and real collaborator can drift apart**: keep a contract or integration test against the real one.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A collaborator's contract is a side effect** with no return value — sending an email, publishing an event, writing a log line.
- **The real collaborator is slow**, non-deterministic, or unavailable in the test environment.
- **What you're actually testing is the interaction itself** — right method, right arguments, right count.

### Avoid when
<!--meta polarity=avoid-->

- **Collaborator result you can assert on directly**: it returns a value or updates state; a [Test Stub](./test-stub.md) only needs to answer, not be verified.
- **You're testing business logic** that happens to call a collaborator incidentally — mocking there re-asserts the implementation, not the outcome.
- **The interface under test is still unstable** — a mock's expectations lock in the exact call shape, and every refactor breaks tests that never touched behavior.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal hand-rolled mock"
interface EmailSender { send(to: string, subject: string): void }

class MockEmailSender implements EmailSender {
  private expected: { to: string; subject: string } | null = null;
  private calls = 0;

  expectSend(to: string, subject: string): void {
    this.expected = { to, subject };
  }

  send(to: string, subject: string): void {
    if (!this.expected || this.expected.to !== to || this.expected.subject !== subject) {
      throw new Error(`unexpected call: send(${to}, ${subject})`);
    }
    if (++this.calls > 1) throw new Error(`extra call: send(${to}, ${subject})`);
  }

  verify(): void {
    if (this.expected && this.calls === 0) throw new Error("expected send() was never called");
  }
}

// SignupService is the code under test; the mock expects exactly one send
// Test
const mock = new MockEmailSender();
mock.expectSend("a@x.com", "Welcome");
new SignupService(mock).signUp("a@x.com");
mock.verify(); // throws if the expectation was never met
```

## In the wild
<!--meta block=wild-->

- **jMock** — The Java library from Freeman and Pryce where the pattern was worked out; expectations are declared up front in an \`Expectations\` block and the test rule verifies them automatically at the end of the test. {#wild-jmock}
- **EasyMock** — Records expected calls during a setup phase, switches to replay with \`replay()\`, and \`verify()\` fails the test if the actual calls did not match the recorded script. {#wild-easymock}
- **Mockito** — Generates doubles at runtime; \`verify(mock, times(n))\` checks interactions after the fact and names the exact call that was missing or malformed, and strict stubbing flags expectations that were set but never used. {#wild-mockito}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Strictness** — A strict mock fails the test on any call it was not told to expect; a nice or lenient mock returns a default for the unexpected, trading precision for less brittle setup. Names and defaults differ between frameworks.
- **Argument matching** — Expectations pinned to exact argument values versus matchers (any value, a type, or a predicate), which loosen what counts as a satisfied call. Pin the arguments the contract names; loosen incidental ones such as timestamps and ids.
- **Invocation count** — How many times a call is expected (exactly once, at least, never), verified as part of the expectation. Default to exactly once for side effects like sending mail; use at least only when retries are legal.

### Failure modes under load
<!--meta polarity=failure-->

- **Over-specified expectations** — Encoding every call the system under test makes turns a harmless refactor into a wave of broken tests that never touched behavior. Signal: one behaviour-neutral refactor breaks several tests; loosen matchers or drop expectations.
- **Interaction over outcome** — The mock proves the calls happened, not that the real-world effect behind them was correct end to end.

### Readiness checklist
<!--meta polarity=check-->

- Mock only collaborators whose contract is the interaction itself — a side effect with no return value or state to read back.
- Use a strict mock where an extra call is the bug (refunds, charges); use a nice mock only for incidental calls, and pin order or count only where the contract requires it.
- Pair an interaction test with at least one test that asserts on the observable outcome.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Testing](../../themes/testing.md) — Script the calls a collaborator should receive and fail on any mismatch. {#fluency-testing}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Enables**

- [Contract Testing](./contract-testing.md) — Contract testing keeps a mock's expected calls matching what the real provider accepts

**Often confused with**

- [Test Stub](./test-stub.md) — State vs. behavior verification
- [Test Spy](./test-spy.md) — Record and assert later vs. expect up front
- [Fake Object](./fake-object.md) — Programmed expectations vs. a real lightweight impl
- [Dummy Object](./dummy-object.md) — Verifies calls; a dummy expects none

<!-- relationships:end -->
