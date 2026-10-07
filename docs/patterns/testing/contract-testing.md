---
title: Contract Testing
description: Prove the test double still matches what the provider actually returns
area: testing
owner: Oleksandr Derechei
tags: [testing, boundaries]
status: stable
aliases: [consumer-driven contracts, CDC testing, Pact testing]
solves: [another team renamed a field and our service broke in production, our end-to-end suite is the only thing catching interface changes and it is slow and flaky, our stubs no longer match what the real service returns and nothing told us, I want to remove a field from our API but nobody knows who still reads it, we cannot deploy independently because we do not know what we might break]
---

# Contract Testing

Records what a consumer actually depends on from a provider's responses, then replays those expectations against the real provider in the provider's own pipeline — so a breaking change is caught by the team making it, without ever running the two systems together.

## What it is
<!--meta block=description-->

A contract test checks that calls against your test double return the same shape as calls against the real service. The consumer's recorded interactions are published to a shared store and the provider's build replays them against the real implementation, so a renamed field fails the provider's pipeline before release. It works only where consumers are known and reachable; a public API needs versioned schemas instead.

## Explained
<!--meta block=explain-->

A contract test records which requests a consumer sends and which response shape it relies on, and the provider's own build replays those requests against the real service. It stops teams from testing against a stub, a stand-in that answers with canned data, that goes stale when the real service changes. Without it, the provider renames a field, every consumer test still passes against its old stub, and the break appears only in production. A failed replay names the consumer and the field before release. Choose it over a full end-to-end suite when you know your consumers and can reach their pipelines, because it is faster and points to the cause. It cannot serve a public API with unknown callers.

- **Shape only.** It checks structure, not behaviour, so keep a few tests for meaning.
- **Rotting expectations.** A consumer that stops using a field keeps blocking changes, so verify only against what consumers have deployed.
- **Broker upkeep.** The broker, the shared store for the recordings, must be run and kept available.
- **Two-team failures.** A failure needs a conversation between two teams, so treat it as a task, not just a red build.

**Example.** A customer service has three consumers. The billing consumer records GET /customers/42 and expects id, email and tier in the reply. The customer team renames tier to plan and runs its build. Replaying billing's recorded request finds no tier, so the build fails, naming billing, before release. Without it, billing's tests stay green against its stub and checkout breaks at night. The cost shows when billing stops using email but never updates its contract: the customer team is still held to returning a field no one reads, until someone deletes that expectation.

## How it works
<!--meta block=structure-->

```mermaid caption="Why does step 4 have to be in the provider's pipeline? Because that is the only place the check is useful — the team about to rename a field learns which consumer it breaks before shipping. Run the same assertions in the consumer's pipeline and you only find out after the provider has already deployed."
flowchart LR
    subgraph CP["Consumer's pipeline"]
        CT["Consumer tests"] -->|"1 run against"| DBL["Test double"]
        CT -->|"2 record expectations"| ART["Contract"]
    end
    BR[("Contract store")]
    subgraph PP["Provider's pipeline"]
        VER["Verification run"] -->|"5 replay each request"| IMPL["Real provider"]
    end
    ART -->|"3 publish"| BR
    BR -->|"4 fetch expectations"| VER
    IMPL -->|"6 pass, or name the broken consumer"| VER
```

## Variations
<!--meta block=variations-->

- **Consumer-driven contract** — The provider's obligation is the union of what its known consumers actually use, so it learns exactly what it may safely change. Authority moves from the provider to its consumers. That lets the provider change freely, but one unreasonable consumer can hold it back.
- **Provider contract** — The provider publishes the complete set of what it exports; consumers take what they are given. Authoritative and simple, and it tells the provider nothing about which parts are safe to remove.
- **Schema-registry compatibility checking** — A published schema is the contract, and compatibility is verified at publish time by a registry rather than by replaying interactions. Much cheaper to operate, and it cannot tell you that a field is unused.
- **Bidirectional checking** — The provider publishes its own specification and the broker compares it against each recorded consumer expectation, with no provider-side replay at all. Removes the need to run the provider in verification, at the cost of trusting the specification to match the implementation.
- **Message contract** — Consumers of events or queue messages record the message shape they read, and the producer's build checks that what it emits still fits.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Interface breakage is caught** in the pipeline of the team causing it, before deployment rather than after, for every pair that has a published contract and a recent verification.
- **The two systems never run together**, so the check is faster and far less flaky than an end-to-end suite, though provider state setup and the broker can still fail.
- **The provider gets a list of what known consumers have recorded as used**, so it can remove the rest with more confidence, provided every consumer publishes and contracts are current.
- **It makes coupling visible** without removing it, which is the first step to reducing it deliberately.

### Cons
<!--meta polarity=con-->

- **Needs known consumers** — it only works where the consumers are known and their pipelines reachable; a public API with anonymous callers cannot use it.
- **It verifies shape**, not behaviour: a provider returning the right fields with wrong semantics passes.
- **Shared infrastructure to run** — a shared artifact and a broker have to be run, versioned and kept available between two teams' pipelines.
- **Recorded expectations rot**: a consumer that stopped using a field but never updated its contract keeps the provider pinned to it.
- **A failing verification needs a conversation** rather than a commit, so the process cost lands on cross-team coordination.
- **An unreasonable consumer expectation**, once recorded, can pull a provider's interface out of shape and hold it there.
- **Replay needs setup** — Each recorded request needs the provider put in a matching state (customer 42 must exist), and those setups need upkeep.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several independently deployed services are owned** by different teams and released on different schedules.
- **End-to-end suite is the only interface check** — it has become the only thing catching interface breakage, and it is slow and flaky.
- **Knowing what is safe to remove** — a provider needs to know which parts of its interface are safe to remove.

### Avoid when
<!--meta polarity=avoid-->

- **Consumer and provider deploy together as one unit** — an integration test is cheaper and proves more.
- **The API is public with unknown callers**, where a versioned schema and a deprecation policy are the contract.
- **What you actually need is confidence** in the provider's behaviour, not its shape — this checks the interface and nothing behind it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the consumer records, the provider replays"
// ---- consumer side: the expectation IS the double's configuration ----
// Declaring it once produces both the stub the consumer tests against and the
// artifact the provider verifies, so the two cannot drift apart.
const interaction = {
  description: "a customer that exists",
  request: { method: "GET", path: "/customers/42" },
  response: { status: 200,
    // Matchers, not values: the contract asserts SHAPE. Pinning "Ada" here would
    // fail the provider for having different test data, which proves nothing.
    body: { id: like(42), email: like("a@example.com"), tier: term(/gold|silver/) },
  },
};
test("shows the customer's tier", async () => {
  await provider.addInteraction(interaction);   // stands up the stub
  const view = await customerClient.load(42);   // the real consumer code
  expect(view.tier).toBe("gold");
});
// On success the recorded interactions are published to the broker.
// ---- provider side: runs in the PROVIDER's pipeline, against the real thing ----
verifyProvider({
  providerBaseUrl: "http://localhost:8080",
  brokerUrl: process.env.BROKER_URL,
  // Only verify against what the consumer has deployed, or a rename is
  // blocked by an expectation nobody depends on any more.
  consumerVersionSelectors: [{ deployedOrReleased: true }],
  stateHandlers: {
    "a customer that exists": () => db.seed({ customers: [{ id: 42, tier: "gold" }] }),
  },
});
```

## In the wild
<!--meta block=wild-->

- **Pact** — Consumer-side interaction recording plus a broker that stores the resulting contracts and drives provider verification, including selectors that verify only against consumer versions currently deployed. {#wild-pact}
- **Spring Cloud Contract** — Contracts declared once and used to generate both the consumer-side stub and the provider-side verification test, so the double and the check come from the same definition. {#wild-spring-cloud-contract}
- **Confluent Schema Registry** — The schema-based variant for message-based interfaces: compatibility is checked when a schema is published rather than by replaying recorded requests. {#wild-confluent-schema-registry}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Consumer version selectors** — Which consumer versions a provider verifies against — all recorded, or only those currently deployed. The setting that decides whether abandoned expectations keep blocking changes.
- **Matcher strictness** — Whether a field is matched by type, by pattern, or by exact value. Exact values fail the provider for having different test data and prove nothing about the contract.
- **Verification failure policy** — Whether a failed verification breaks the provider build or raises a reconciliation task. Breaking is stricter; a task is correct where the consumer expectation may itself be wrong.
- **Provider state setup** — How the provider puts itself into the state each interaction assumes — seeded fixtures per state name, or a shared dataset. Shared datasets couple interactions to each other.

### Signals to watch
<!--meta polarity=signal-->

- **Contracts published versus verified** — Every published consumer contract should have a recent provider verification. A gap means a consumer believes it is protected and is not.
- **Verification age per consumer-provider pair** — How long since the last successful check. A stale pair is an unverified assumption dressed as a green pipeline.
- **Expectations never exercised by the consumer** — Recorded interactions whose consumer code path no longer runs. These are the ones pinning the provider for no benefit.

### Failure modes under load
<!--meta polarity=failure-->

- **Green pipelines, broken production** — A consumer records no contract, or the provider never verifies it, so the pair is unprotected while both builds pass — the failure this pattern exists to prevent, reappearing as a coverage gap.
- **Provider blocked by a dead expectation** — A consumer stopped using a field but never updated its contract, so verification fails on a field nobody reads and the provider cannot remove it.
- **Contract passes, semantics differ** — The provider returns the right fields with a changed meaning — a status code reused, a unit switched — and shape verification is blind to it.
- **Broker outage blocks both pipelines** — The shared store sits between two teams' builds, so an outage stops publishing and verification at once. Cache the last fetched contracts in the provider pipeline, and decide whether verification fails open or closed meanwhile.

### Readiness checklist
<!--meta polarity=check-->

- Every consumer-provider pair has a published contract and a verification that has run recently — the pair count is asserted, not assumed.
- Verification runs in the provider pipeline, before deployment, not only in the consumer pipeline.
- Matchers assert types and patterns rather than exact values, so provider test data can differ freely.
- Providers verify against consumer versions currently deployed, so abandoned expectations age out instead of pinning the interface.
- Provider behaviour has its own tests: this proves the interface shape and nothing behind it.
- A verification failure has an owner and a defined resolution path, since the correct answer is sometimes that the expectation was unreasonable.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Testing](../../themes/testing.md) — Check that your test double answers in the same shape as the real service. {#fluency-testing}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Fake Object](./fake-object.md) — A verified contract is what makes a lightweight in-memory stand-in trustworthy
- [Hyrum's Law](../../principles/hyrums-law.md) — Consumer-driven tests record what callers depend on, making hidden dependencies visible
- [API Versioning](../distributed/routing/api-versioning.md) — The other answer to changing a published contract, and the right one when callers are unknown

**Requires**

- [Test Stub](./test-stub.md) — The double this exists to validate: canned responses are exactly what drifts from reality
- [Mock Object](./mock-object.md) — The other double this exists to validate: a mock's expected calls can drift from what the real provider accepts

**Prevents**

- [Distributed Monolith](../../hazards/distributed-monolith.md) — Verified contracts are what let services deploy separately instead of only together

<!-- relationships:end -->
