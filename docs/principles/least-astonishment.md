---
title: Principle of Least Astonishment
description: Behave the way the people using your code already expect
area: principles-craft
owner: Oleksandr Derechei
tags: [api-design, readability, maintainability]
status: stable
aliases: [POLA, Principle of Least Surprise, Rule of Least Surprise]
solves: [every new person on the team gets caught by the same weird behaviour in our helper, the method is called get-something but it also writes to the database, callers keep passing the arguments in the wrong order because nothing about the signature suggests it, our library does something clever behind the scenes and people only find out during an incident, review comments on this file keep saying I did not expect that]
---

# Principle of Least Astonishment

Names, signatures, defaults and side effects should match what a reasonable user already assumes, so nobody has to read the implementation to predict what a call will do. Where behaviour and expectation disagree, the behaviour is the thing to change.

## What it says
<!--meta block=description-->

Make a thing behave the way the people using it already expect. Where behaviour and expectation disagree, change the behaviour: a documentation warning helps only readers who look it up, and the person about to be surprised usually has not. Eric Raymond states it as do the least surprising thing. Expectations come from convention, such as language idioms and your codebase, so the principle governs names, signatures, defaults and side effects, not implementation cleverness.

## Explained
<!--meta block=explain-->

The principle of least astonishment says a thing should behave the way the people using it already expect, so they can predict it from its name and signature without opening the source. Most people spend their time predicting, not reading: they see getBalance(), assume it only reads a value, and write a retry loop around it. Each deviation adds a fact that only the source or an incident will teach, and a reader burned once stops trusting the whole interface. Expectation belongs to an audience, so name whose it is first, because what is obvious in one language ecosystem astonishes a newcomer from another. Rank it below correctness and safety: where the expected behaviour is the unsafe one, ship the safe default and make callers ask for the other by name. The standing cost is conservatism, because it always votes for what already exists, even a convention that is wrong. When you must break an expectation, break it loudly with a new name, a required argument or a type that refuses to compile, never quietly.

**Example.** A function named findUser(id) also creates the user when none exists. A caller checks findUser(id) == null to detect a missing account before sign-up, never sees a null, and a typo in an id silently adds a new account. The fix is the name: findUser only reads, and a separate getOrCreateUser says what it does. The team also widens findUser's return type to allow null, so every caller that assumed a user fails to compile and is moved to getOrCreateUser or given a null check. The cost is one upgrade-time break at each call site, found by the compiler instead of in production.

## Why it helps
<!--meta block=rationale-->

Most of the time anyone spends with your code, they are predicting rather than reading. They see `account.getBalance()`, assume it reads a value and returns it, and write the retry loop around it without opening the file. Every such prediction is either free or a defect, and the name is what decides which.

Matching convention keeps the number of facts a caller has to verify at zero; each deviation adds one they can only learn from your source or from an incident. That cost lands late and on somebody else, which is why surprising behaviour survives review — the author knows the exception and pays nothing for it. It also compounds: a reader burned once stops trusting the rest of the interface and starts opening implementations, which slows down every call site, not just the one that lied.

## Applying it
<!--meta block=applying-->

Make the outside of a thing predict its inside:

- Name for the effect, not the implementation. A name that promises a read (`get`, `find`, `is`) must not write state a caller can observe, and must not send anything over a network the caller cannot see.
- Follow the local convention before your own preference: the language's idioms, the framework's lifecycle, the argument order the rest of your API already uses. One inconsistent signature costs every caller a lookup, forever.
- Make the surprise impossible to write. Two adjacent booleans or two same-typed arguments will be swapped eventually, so give them distinct types or named parameters instead of documenting the order.
- Default to what most callers would pick if asked, and to the safe option where those differ. Most callers never change a default, so the default is the behaviour.
- Do not hide side effects behind convenience — a silent retry, a background write, a swallowed error. Retrying is a reasonable thing to do and an unreasonable thing to do invisibly: a caller who needs the operation to happen once has no way to learn that it happened twice.
- When established behaviour has to change, change the name with it. A same-named function with new semantics compiles everywhere and breaks every caller who had no reason to re-read the docs; a new name plus a deprecation moves the break to upgrade time, where somebody is looking.
- Across several ecosystems there is no single convention to match. Generate each client from one specification, then adapt it to its language's idioms, because an identical interface often reads as foreign in each.
- Check it in review. Flag any `get`, `find` or `is` function whose body writes, caches or sends; any signature with two same-typed arguments next to each other; any catch that returns a default.

The test is cheap: describe the behaviour to someone who has not seen the code, using only the name and the signature. If you need to add “but note that…”, you have found the astonishment.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — findUser that creates, then split by what the name promises"
// Before: a read-named function that writes.
function findUser(id: string): User {
  return users.get(id) ?? users.create(id);   // a typo in id adds an account
}

// After: the name says what it does, and the type says a user may be missing.
function findUser(id: string): User | null {
  return users.get(id) ?? null;
}
function getOrCreateUser(id: string): User {
  return findUser(id) ?? users.create(id);
}
// Callers that assumed a User no longer compile; each picks one of the two.
```

## Taken too far
<!--meta block=overreach-->

Least astonishment is an argument about habits, and habits are sometimes wrong. Followed as a rule it preserves whatever the codebase already does: if half the flags here are named backwards, the consistent move is to name the next one backwards too, and the principle will defend it. Familiar and correct are different properties, and only one of them keeps working when the system changes.

Used as a veto it also blocks anything genuinely new. A better model astonishes everyone in its first week and nobody in its second — a one-time cost set against the permanent one of keeping the worse model. So price a surprise by how long it lasts, and when you decide to break an expectation, break it where it cannot be missed: a different name, a required argument, a type that refuses to compile. Quiet deviation is the failure mode; loud, deliberate deviation is a design decision.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Keep It Simple (KISS)](./kiss.md) — Simple designs are the ones readers predict correctly
- [Facade](../patterns/gof/structural/facade.md) — A facade helps only if it behaves as its name promises
- [Builder](../patterns/gof/creational/builder.md) — Named steps remove the swap-two-arguments surprise
- [Idempotency](../patterns/messaging/idempotency.md) — Callers assume a retry is safe; make that true
- [Design for Operations](./design-for-operations.md) — Predictability is what an operator leans on when they cannot read the source
- [Convention over Configuration](./convention-over-configuration.md) — Defaults that match what users expect surprise nobody
- [Command-Query Separation](./command-query-separation.md) — A read-named method that writes is the commonest astonishment; CQS is the rule that stops it.
- [Hyrum's Law](./hyrums-law.md) — Callers depend on whatever you actually do, so a same-name behaviour change breaks them.

<!-- relationships:end -->
