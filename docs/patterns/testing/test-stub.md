---
title: Test Stub
description: "Returns canned answers, doesn't care how it's called"
area: testing
owner: Oleksandr Derechei
tags: [testing, testability, isolation]
status: stable
aliases: [stub]
solves: [my test fails at random because it calls a real service over the network, i cannot make the payment provider return a 500 on demand to test my error path, every one of my unit tests hits the database and the suite takes minutes, i need to see what my code does with an empty result set but the real data always has rows, the third-party api is not reachable from ci so my tests just fail there]
---

# Test Stub

Stands in for a real collaborator and answers every call with a fixed, precomputed value — it never inspects what it was asked, never records that it was called, and makes no attempt to behave like the thing it replaces.

## What it is
<!--meta block=description-->

A test stub is a test double that replaces a real collaborator and returns pre-arranged answers whenever the system under test calls it, whatever the arguments and however often. It resolves indirect input: the real collaborator is slow, remote, random or cannot return the edge case the test needs, such as a stale cache or an empty result. A stub asserts nothing about its own use; that is the job of a mock or spy.

## Explained
<!--meta block=explain-->

A test stub is a test double that returns the same prepared answers whenever your code calls it, whatever the arguments and however many times. It lets you feed the code under test a situation you could not otherwise produce, because the real collaborator is slow, remote, random, or cannot return the awkward case you need, such as a stale cache or an expired token. Choose it over a fake, which keeps real working state, when one fixed answer is enough, and over the real dependency when that is slow or unpredictable.

- **No usage check.** A caller that stops calling the stub still passes; add a spy when the call must happen.
- **Drift.** Canned data diverges from what the real service returns; back it with a contract test.
- **Self-testing.** Stubbing part of what you test checks your own canned value; draw the boundary first.
- **Multiplication.** One stub per scenario piles up; make one stub that takes the answer as a parameter.

**Example.** A pricing function converts euros using an exchange-rate service. A stub returns 1.10, so 100 euros must give 110.00 dollars, and the test runs with no network call, so it is fast and the same every run. A second stub throws a timeout, to test the fallback to yesterday's rate, which the real service rarely produces on demand. The cost: the real service starts returning the rate as the string 1.10, the stubs still return a number, and both tests stay green while production breaks. A contract test that checks the response type against the real service would catch it.

## How it works
<!--meta block=structure-->

```mermaid caption="The stub answers with whatever value the test wired in beforehand, regardless of what it's asked or how often."
sequenceDiagram
    autonumber
    participant SUT
    participant Stub as Test Stub
    SUT->>Stub: getBalance(accountId)
    alt happy-path stub
        Stub-->>SUT: 500, canned value
    else saboteur stub
        Stub--xSUT: throws AccountError
    end
    Note over Stub: answer wired in advance, ignores the argument
```

## Variations
<!--meta block=variations-->

- **Fixed-response stub** — Returns the same canned value on every call regardless of arguments — the simplest and most common form.
- **Parameterized / sequenced stub** — Returns a different canned answer depending on the input, or the next value in a preloaded sequence — useful for polling or pagination scenarios. A sequenced or argument-keyed stub still holds only a preloaded table; once it computes answers or keeps state, it is a fake.
- **Saboteur stub** — Throws an exception or returns an error code instead of a value, to exercise error-handling paths that the real collaborator rarely fails on demand.
- **Recorded / fixture-replay stub** — Canned answers captured verbatim from a real call (an HTTP fixture, a database snapshot) and replayed. The stub keeps the real response shape without a live dependency. Re-record on a schedule and scrub secrets and personal data from the capture.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Removes dependence on slow**, flaky, or unavailable collaborators — networks, databases, third-party APIs.
- **Makes hard-to-trigger conditions trivial to construct**: errors, timeouts, empty results, edge-case data.
- **Deterministic and fast**: the same canned answer every run, with no side effects in the collaborator; process-wide patches still need teardown.
- **The simplest double to write**: no expectation-setting DSL (domain-specific language), no call-matching logic.

### Cons
<!--meta polarity=con-->

- **Verifies nothing about interaction** — a caller that stops calling the collaborator entirely still passes.
- **Canned data can drift** from what the real dependency actually returns, letting tests pass against a stale contract.
- **Overuse encourages testing against your own fixtures** rather than real integration behavior.
- **One stub per scenario tends to multiply**, adding maintenance surface when the real interface changes.
- **Stubbing part of what you test** makes the assertion check your own canned value; the logic never runs. Draw the boundary before you replace anything.
- **Hides missing interaction checks** — Stubbing a command (a call with side effects) hides that it never ran; use a stub for queries and a spy or mock for commands.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The collaborator is slow**, remote, non-deterministic, or unavailable in the test environment.
- **You need to force** the SUT down a path that's hard to trigger for real — an error, a timeout, an edge case.
- **Only the SUT's output matters** — you only care what it does with a given input, not what it does to the collaborator.

### Avoid when
<!--meta polarity=avoid-->

- **The test's whole point** is verifying the SUT calls the collaborator correctly — use a [Mock Object](./mock-object.md) instead.
- **You need to assert** on the arguments or count of calls made — reach for a [Test Spy](./test-spy.md).
- **The parameter only satisfies a signature** and is never touched — a [Dummy Object](./dummy-object.md) is enough and cheaper to write.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a fixed-response stub"
interface AccountRepository {
  findById(id: string): Promise<{ balanceCents: number }>;
}

// Always answers the same way, whatever id it's asked for.
class StubAccountRepository implements AccountRepository {
  constructor(private readonly canned = { balanceCents: 500 }) {}
  async findById(_id: string) {
    return this.canned; // argument is ignored entirely
  }
}

// Test: does the service format the balance correctly?
const service = new AccountService(new StubAccountRepository());
expect(await service.getFormattedBalance("acc_1")).toBe("$5.00");
```

```typescript summary="TypeScript — a saboteur stub"
// Simulates a failure the real repository rarely produces on demand.
class SaboteurAccountRepository implements AccountRepository {
  async findById(_id: string): Promise<never> {
    throw new Error("connection reset");
  }
}

// Test: does the service handle a repository failure gracefully?
const brittle = new AccountService(new SaboteurAccountRepository());
await expect(brittle.getFormattedBalance("acc_1")).rejects.toThrow();
```

## In the wild
<!--meta block=wild-->

- **WireMock** — Stands in for an HTTP API by replaying canned responses, including forced errors and delays, that you configure per test. {#wild-wiremock}
- **nock** — Intercepts outgoing Node.js HTTP requests and answers them with pre-arranged status codes and bodies instead of hitting the network. {#wild-nock}
- **Sinon.JS** — Its sinon.stub() replaces a method with one that returns configured values or throws, without recording expectations about how it was called. {#wild-sinon}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Hand-written vs recorded fixtures** — Canned answers typed by hand are cheap to make and quick to drift; answers captured from a real call and replayed stay honest to a real response shape, at the cost of a re-recording workflow.
- **Simulated latency and faults** — Whether the stub can inject delays, timeouts and connection failures. Instant answers keep the suite fast but leave the code's timeout and retry paths unexercised.
- **Behavior on unmatched calls** — What happens when the system under test makes a call the stub has no canned answer for — return a bland default, or fail loudly. Defaults hide wiring mistakes; loud failure catches calls you did not anticipate.

### Signals to watch
<!--meta polarity=signal-->

- **Bugs that only integration catches** — Defects the stubbed suite misses and the real dependency exposes. Each one is a canned answer that has drifted.
- **Age of recorded fixtures** — Time since each captured response was last re-recorded against the live dependency; the older the capture, the more API evolution it has silently missed.
- **Stub count per collaborator** — How many distinct stubs exist for one interface. A rising count means the next change to that interface touches many files.

### Failure modes under load
<!--meta polarity=failure-->

- **Contract drift** — The real dependency renames a field, adds an enum value or changes its error shape. Stubbed tests keep passing while production breaks.
- **The stub is kinder than the real thing** — Real collaborators fail slowly, paginate and return partial data. A stub that always answers instantly and fully leaves timeout, retry and pagination logic untested.
- **Leaked interceptors** — Stubs installed process-wide — patched modules, intercepted HTTP — outlive their test when teardown is missed, so an unrelated test later passes or fails depending on run order.

### Readiness checklist
<!--meta polarity=check-->

- Back every stubbed interface with at least one contract or integration test against the real dependency in continuous integration (CI), so drift surfaces there instead of in production. The contract test covers each field and error shape the stubs return, and runs on every provider version bump.
- Re-record captured fixtures on a schedule or on provider version bumps, and keep the capture date visible next to the fixture. Fail CI when a fixture's capture date is older than the interval you set.
- Configure unmatched calls to fail loudly rather than answer with defaults.
- Tear stubs down after every test — restore patched methods and clear interceptors so no canned answer leaks into the next test.
- Give every collaborator a saboteur variant — errors, timeouts, empty results — not just the happy-path canned answer.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Testing](../../themes/testing.md) — Replace a collaborator with one that returns fixed answers. {#fluency-testing}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Enables**

- [Contract Testing](./contract-testing.md) — Contract testing is what keeps a stub honest as the real provider moves

**Often confused with**

- [Dummy Object](./dummy-object.md) — Never used vs. returns canned values
- [Mock Object](./mock-object.md) — State vs. behavior verification
- [Test Spy](./test-spy.md) — Canned answers vs. recorded calls
- [Fake Object](./fake-object.md) — Canned returns vs. a working in-memory implementation

**Prevents**

- [Static Cling](../../hazards/static-cling.md) — Wanting to stub a collaborator forces it behind an injected seam, which leaves no static call to cling to
- [Static Cling](../../hazards/static-cling.md) — Stands in for the static call only once a seam exists, so inject first

<!-- relationships:end -->
