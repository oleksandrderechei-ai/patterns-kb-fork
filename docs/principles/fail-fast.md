---
title: Fail Fast
description: Stop at the first broken assumption instead of running on with bad state
area: principles-craft
owner: Oleksandr Derechei
tags: [low-level-design, error-handling, validation, boundaries]
status: stable
aliases: [fail early]
solves: [a bad value from one API call surfaces as a null pointer three services later, the stack trace points at code that has nothing to do with the actual mistake, we shipped a config typo and only found out a week later when the numbers looked odd, half the rows in yesterday's import are garbage and I cannot tell where they came from, the service starts up healthy with a missing environment variable and dies on the first real request]
favourite: true
---

# Fail Fast

Check what you assume as early as you can check it, and stop loudly when a check fails. Carrying on past a violated assumption does not buy survival — it buys a later failure somewhere that can no longer explain what went wrong.

## What it says
<!--meta block=description-->

Detect a fault at the earliest point you can, and report it where the context that explains it still exists. The alternative is carrying on with state you no longer trust until something far away reports a symptom instead of a cause. Jim Shore made the case in IEEE Software. The rule is about detection, not handling: the caller may still retry or degrade, but only if the fault arrived with its field, value and origin.

## Explained
<!--meta block=explain-->

Fail fast means you detect a broken assumption at the first point you can and report it with the field, the value and the caller still attached, instead of running on with state you can no longer trust. A malformed order stopped at the door is one rejected request naming the bad field. Carried inward, it becomes a half-written row and a support ticket next week whose stack trace blames code that did nothing wrong. It decides where to notice, not what to do next, so the caller may still retry or fall back. Choose it over carrying on when a rejected request is cheaper than a wrong one, such as an unbalanced ledger entry; for a missing thumbnail, degrade instead. It costs availability and, if applied too widely, granularity. Failing on a timeout turns a blip into an outage, so retry after a pause when the identical input could succeed. Failing a whole batch for one bad record is too wide, so park that record in a dead-letter queue (a holding area someone drains) and let the rest through.

**Example.** A billing job reads 1 million payment records each night. Record 412,008 has a negative amount. Carried on, the bad value flows into a total, the books are off by 90 dollars, and finance finds it 6 days later with no clue which record did it. Failing the whole job leaves 999,999 good payments waiting for a rerun. Instead the amount check rejects that single record at read time with its id and value, writes it to a dead-letter table and raises one alert. The job finishes in its usual 40 minutes. The cost is a person who must clear the dead-letter table each morning.

## Why it helps
<!--meta block=rationale-->

What a defect costs is set by how far it travels before anyone notices. Caught at the boundary, a malformed order is one rejected request naming the offending field; carried inward, the same order becomes a wrong total and a support ticket next week that blames the wrong code. The debugging then starts from the symptom and works backwards through everything the bad value touched.

Stopping early also makes the checks worth something. Where a system halts on the first violated assumption, a clean run shows the checked invariants held on that path; unchecked ones stay unknown. Where it limps on, silence means nothing: you cannot tell a run with no problems from a run whose problems were swallowed, so every later diagnosis has to begin by reconstructing what the state was supposed to be.

## Applying it
<!--meta block=applying-->

Push each check as early as the information allows:

- Validate at the boundary and reject with the specifics — the field, the value, what was expected. Everything inside is then entitled to assume the input is well-formed, which is what makes that assumption safe to write.
- Check configuration and dependencies at start-up rather than on first use. A process that cannot possibly serve traffic should fail its readiness check, not accept a request and discover the missing secret halfway through it.
- Parse once into a type, then rely on it. If the type can express “non-empty”, “positive” or “already validated” and cannot be built without the check, an illegal value stops existing past the boundary instead of being re-checked, or not, at every call site.
- Assert the invariants you would otherwise write as a comment. Assertions that fire in tests are cheap, but some runtimes can strip them in production, so use an explicit check that throws for input and invariants that matter; the same violation reaching production costs whatever the corrupted data touched before anyone looked.
- Never swallow an error to keep going. If the work genuinely must continue, the failed item goes somewhere visible — a dead-letter queue, a quarantine table, a counter with an alert — so the failure is bounded rather than erased.
- At the process boundary, prefer restarting to repairing. A supervisor bringing the process back into a known-good state is more predictable than code trying to mend state it cannot inspect, provided callers retry and the work is idempotent — which is the part that actually costs you design effort.
- Spot a breach in review: a catch that logs and carries on, a default filling a required field, a null returned for an error, a validation re-run at each call site. Each hides the fault until something distant breaks.

The ladder is worth walking in order: compile time is cheaper than start-up, start-up is cheaper than the request boundary, and the boundary is cheaper than production. Move every check to the highest rung it can honestly sit on.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — a payment record parsed into a positive amount at read time, bad ones parked with id and value"
type Cents = number & { readonly __brand: "Cents" };

class BadRecord extends Error {
  constructor(
    readonly id: string,
    readonly field: string,
    readonly value: unknown,
    readonly expected: string,
  ) {
    super(`record ${id}: ${field}=${String(value)}, expected ${expected}`);
  }
}

// The only way to get a Cents; the check cannot be skipped.
export function parseCents(id: string, raw: unknown): Cents {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new BadRecord(id, "amount", raw, "positive integer cents");
  }
  return raw as Cents;
}

// One bad record fails alone; the rest of the batch goes through.
for (const rec of records) {
  try { total += parseCents(rec.id, rec.amount); }
  catch (e) { if (e instanceof BadRecord) deadLetter.insert(e); else throw e; }
}
```

## Taken too far
<!--meta block=overreach-->

Failing fast means noticing early, not giving up early. Applied to things that are merely late or briefly unavailable — a timeout, a rate limit, a rolling restart — it turns a blip into an outage, and it does so everywhere at once, because instances that share a dependency and a trigger tend to fail together. The question that separates the two is whether retrying the identical input could succeed: if it could, back off and retry; if it could not, stop now.

Granularity is the other trap. One malformed record should fail its own processing, not the batch of a million behind it, so put the failure boundary around the smallest unit that can fail on its own, park the bad unit where someone will see it, and let the rest through. The same care applies to input you do not control: a check that halts the process is a good thing in a test harness and a denial-of-service lever on a public endpoint, where the right move is to reject the request rather than to abort the server.

Price the trade per path: failing fast buys diagnosability with availability, and that is only a good deal where a rejected request is cheaper than a wrong one. A ledger entry that does not balance should stop everything; a missing profile thumbnail should not take down the page that would otherwise have rendered. The same service can honestly do both, and deciding which paths get which is design work rather than a matter of discipline.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Intercepting Validator](../patterns/security/intercepting-validator.md) — Reject bad input at the door, not three layers in
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — A deadline turns an unbounded wait into a prompt failure
- [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) — Once a dependency is known down, fail now, not later
- [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) — Park the poison record so one row fails alone
- [Design for Self-Healing](./self-healing.md) — Failing fast is the detection half; healing is what happens next
- [Make Illegal States Unrepresentable](./make-illegal-states-unrepresentable.md) — Checks at run time and stops at once, for what a type cannot rule out
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — Retry the blip, fail fast on the fault that cannot clear.
- [Idempotency](../patterns/messaging/idempotency.md) — Restart-on-fault is only safe if the rerun does no harm.

**Alternative to**

- [Fallback](../patterns/distributed/resilience/fallback.md) — A fallback returns a lesser answer where fail fast reports the error at once; choose a fallback when part of the answer is optional or an old answer is nearly as good.

**Prevents**

- [Unbounded Queue](../hazards/unbounded-queue.md) — A bounded queue rejects now instead of exhausting memory later
- [Leaky Abstraction](../hazards/leaky-abstraction.md) — An abstraction that reports its real failure is one a caller can handle

<!-- relationships:end -->
