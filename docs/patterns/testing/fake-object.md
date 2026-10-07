---
title: Fake Object
description: "A working lightweight stand-in, like an in-memory database"
area: testing
owner: Oleksandr Derechei
tags: [testing, testability, isolation]
status: stable
aliases: [fake]
solves: [my tests need a real database running and ci keeps timing out waiting for it, writing a fixed answer for every database query means my test no longer exercises my logic, my tests leave rows behind and the next run fails on dirty state, spinning up docker containers for every test run has destroyed my feedback loop, my tests write real files to disk and litter my working directory]
---

# Fake Object

A working, lightweight implementation of a dependency — an in-memory database standing in for the real one — real enough to exercise actual logic, simple enough to never touch production infrastructure.

## What it is
<!--meta block=description-->

A fake object is a test double that actually works: it implements the real dependency's interface and computes real results, but takes a shortcut that makes it unfit for production, such as an in-memory map standing in for a database. It spares tests the cost of slow, flaky, stateful databases, brokers and third-party APIs. Because the fake runs real logic, you must keep it from drifting from the real behaviour.

## Explained
<!--meta block=explain-->

A fake object is a test double that really works: it has the same interface as the dependency and computes real answers, but takes a shortcut that makes it unfit for production, such as an in-memory map in place of a database. Real databases, message brokers and third-party APIs are slow to start, flaky over a network and keep state between runs, which a fast and repeatable test suite cannot afford. Choose a fake over a stub, which returns canned answers, when the code under test does several related calls, such as save then find, because a fake keeps state and so runs the real logic.

- **Second implementation.** A fake needs upkeep; use one only for stable interfaces many tests share.
- **Drift.** It misses the real thing's edge cases and gives false confidence; run the same tests against both.
- **No call record.** It does not show that a call happened or in what order; use a mock when the call is the point.

**Example.** A suite of 400 tests each needs a user repository. Say resetting a real Postgres takes about 250 ms a test, so 400 times 250 ms is 100 seconds. Against an in-memory fake, say it takes about 1 ms, so 0.4 seconds. The fake allows two saves with the same email, while the real table has a unique index and rejects the second. Three tests pass on the fake and fail in production. The fix is one shared test, saving a duplicate email must fail, run against both in CI, so the fake is changed to match and later drift fails the build.

## How it works
<!--meta block=structure-->

```mermaid caption="The system under test only knows the interface. Production wires in the real implementation; the test wires in a fake with the same behavior and none of the infrastructure."
flowchart LR
    SUT["System under test"] -->|depends on| IF["Repository interface"]
    IF -.->|in production| Real["Real impl, e.g. Postgres"]
    IF -.->|in tests| Fake["Fake impl, in-memory Map"]
    Test["Test"] -->|wires in| Fake
```

## Variations
<!--meta block=variations-->

- **In-memory [repository](../enterprise/repository.md)** — Backs a repository or DAO (data access object) interface with a plain in-memory collection instead of a real database — the most common fake in application code.
- **In-memory file system** — Stands in for disk I/O so tests read and write without touching the real filesystem or leaving artifacts behind.
- **In-process fake service** — A small server that speaks the real wire protocol over a loopback socket, letting integration-style tests exercise real HTTP or RPC (remote procedure call) handling without the network.
- **Shared, maintained fake** — Some libraries ship an official in-memory driver alongside the real one, maintained by the same authors, which lowers drift but does not remove it; only a shared contract test proves parity.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Tests run fast and deterministically**, with no real network, disk, or database involved.
- **Exercises genuine logic** instead of just confirming that expected calls were made.
- **Written once and reused across many tests**, unlike per-test mock expectations.
- **Decouples the test suite** from the availability of external infrastructure.

### Cons
<!--meta polarity=con-->

- **A faithful fake is real engineering work** — building and maintaining one means another implementation to keep correct.
- **Can drift from the real dependency's edge cases**, giving false confidence unless checked with contract tests.
- **No call verification** — a fake doesn't verify that a specific call happened or in what order; that's a mock's job, not a fake's.
- **Only pays off** for interfaces stable and widely used enough to justify a second implementation.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The real dependency is slow**, flaky, remote, or hard to set up in a test environment.
- **Tests need real dependency logic** — many tests need to exercise real logic against the dependency, not just confirm one call.
- **The interface is stable** and used widely enough that one lightweight implementation pays for itself.

### Avoid when
<!--meta polarity=avoid-->

- **The dependency only appears** in one or two tests — a canned stub is quicker to write. Switch to a fake once several tests need the same canned data, or once a stub starts holding state.
- **The point of the test is verifying** that a particular call happened, in order — use a Mock Object instead.
- **Real integration still needs proof** — a fake removes unit-level friction, not the need for a contract test against the real thing.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an in-memory repository fake"
interface UserRepository {
  save(user: User): Promise<void>;
  findById(id: string): Promise<User | null>;
}

// Production: PostgresUserRepository implements this against real SQL.

class FakeUserRepository implements UserRepository {
  private readonly rows = new Map<string, User>();

  async save(user: User): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.email === user.email && row.id !== user.id) throw new Error("duplicate email"); // production-knob-2: enforce the unique index
    }
    this.rows.set(user.id, { ...user });
  }

  async findById(id: string): Promise<User | null> {
    return this.rows.get(id) ?? null;
  }
}

// Test: the service under test never knows it's not talking to Postgres.
const repo = new FakeUserRepository();
const service = new UserService(repo);

await service.register({ id: "u1", email: "a@example.com" });
const found = await repo.findById("u1");
assert(found?.email === "a@example.com");
```

## In the wild
<!--meta block=wild-->

- **LocalStack** — Emulates AWS service APIs — Simple Storage Service (S3), Simple Queue Service (SQS), DynamoDB, Lambda and more — in a local container; the SDK points at its endpoint URL instead of the real AWS endpoint, so the same client code runs unchanged. {#wild-localstack}
- **Firebase Local Emulator Suite** — Officially maintained emulators for Firestore, Authentication, Functions and the Realtime Database, started with \`firebase emulators:start\`; client SDKs connect to the local host and port, and emulator state can be imported and exported between runs. {#wild-firebase-emulator}
- **pyfakefs** — Replaces the standard os, io and pathlib calls with a fake filesystem; drops in as the pytest \`fs\` fixture or via patchfs, so file-handling code runs unchanged and leaves nothing on disk. {#wild-pyfakefs}
- **fakeredis** — Implements a large subset of the Redis command set in-process, acting as a drop-in for the redis-py client so code using real Redis operations runs without a redis-server. {#wild-fakeredis}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Seeded initial state** — The data the fake is preloaded with before each test — an empty store, or a fixture set shared across a suite. Default to an empty store per test; use a shared fixture only for read-only suites, reset between tests.
- **Constraint enforcement** — Whether the fake enforces the invariants the real store does — unique keys, required fields, referential integrity — or silently accepts anything.
- **Fault injection** — A switch to make the fake return the same errors the real dependency does — timeouts, conflict responses — so error-handling paths still get exercised.
- **Concurrency semantics** — Whether the fake models atomicity and isolation or treats every operation as independent and serial.

### Signals to watch
<!--meta polarity=signal-->

- **Contract-test divergence** — Run the same behavioral suite against the fake and the real dependency; a case that passes on one and fails on the other is drift. Any divergence fails CI; run it on every change to the interface or the fake.
- **Fake-only green** — Bugs caught in integration against the real dependency but missed by every test using the fake — count them to size the drift, and add a contract case for each one.

### Failure modes under load
<!--meta polarity=failure-->

- **Behavioral drift** — The fake and the real dependency diverge on an edge case; tests pass against a fiction and the bug ships.
- **Missing constraints** — The fake accepts data the real store would reject — a duplicate key, an over-long field — so a validation bug only surfaces in production.
- **Unmodeled concurrency** — The fake serializes every operation, hiding the race conditions the real store would expose under concurrent access.

### Readiness checklist
<!--meta polarity=check-->

- A contract test runs the identical behavioral suite against the fake and the real dependency in continuous integration (CI).
- The fake enforces the invariants the code under test relies on — uniqueness, required fields, ordering.
- One owner keeps the fake in lockstep whenever the real interface changes.
- Integration tests against the real dependency still cover what the fake abstracts away.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Testing](../../themes/testing.md) — Swap in a working but simplified implementation, such as an in-memory store. {#fluency-testing}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Repository](../enterprise/repository.md) — An in-memory Map repository is the canonical fake
- [Golden Master](./golden-master.md) — A deterministic fake keeps a golden diff stable
- [Contract Testing](./contract-testing.md) — Stays honest only while something checks it against the real provider
- [Gateway](../enterprise/gateway.md) — The fake stands in for a gateway so tests need no network

**Often confused with**

- [Mock Object](./mock-object.md) — Programmed expectations vs. a real lightweight impl
- [Test Stub](./test-stub.md) — Real working logic vs. hard-coded canned answers

<!-- relationships:end -->
