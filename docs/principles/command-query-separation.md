---
title: Command-Query Separation
description: "A method either changes state or returns a value, never both"
area: principles-craft
owner: Oleksandr Derechei
tags: [low-level-design, separation-of-concerns]
status: stable
aliases: [CQS, Meyer's rule]
solves: [calling a getter twice gives different answers because reading the value also changes it, adding a log line that reads a value changed how the program behaves, I cannot tell from its name whether calling this method changes anything, a test that checks a value moves the thing it is checking]
---

# Command-Query Separation

Every method does one of two things: it changes state and returns nothing, or it returns a value and changes nothing. Asking a question must never change the answer, so a caller can ask as often as it likes without effect.

## What it says
<!--meta block=description-->

Bertrand Meyer gave the rule in Object-Oriented Software Construction (1988). A command changes state and returns no value; a query returns a value and leaves state alone. It governs the methods you design, with small documented exceptions such as a stack's pop() or an atomic compare-and-swap. It is not command query responsibility segregation (CQRS), which separates whole read and write models; this rule needs no infrastructure, though it adds calls where one method did both.

## Explained
<!--meta block=explain-->

Command-query separation is a rule for one method: it either changes state and returns nothing, or it returns a value and changes nothing. Bertrand Meyer set it out in 1988. It matters because a read that quietly changes state is no longer safe to repeat, so you cannot log it, test it, cache it or evaluate it twice without changing what the program does. Use it when you cannot see every caller. The first cost is that some steps must be atomic. A stack pop or a compare-and-swap returns and changes at once, because splitting it lets two threads take the same item. Keep those combined and name them so no reader takes them for a plain read. The second cost is more calls to learn a result, such as asking for the new id after an insert. Accept that, or return the id and document the exception.

**Example.** A counter has nextId(), which returns the current number and adds 1. A developer adds a debug line that logs counter.nextId(), and now every request skips one id, so ids 1, 3, 5 are issued and an audit finds a gap. After the split, current() returns 7 any number of times, and advance() is the only call that moves it to 8. The log line is safe. The cost is two calls where there was one, and in threaded code, two calls leave a gap, so a combined takeNext() with its own lock is kept for that case.

## Why it helps
<!--meta block=rationale-->

A query that changes state makes the program harder to reason about, because reading it is no longer safe. You cannot add a log line that calls it, evaluate it twice in a condition, show it in a debugger watch window or cache its result without changing what the program does.

With the separation, queries are safe to call anywhere, any number of times, in any order, and a reviewer or a test can treat them as pure reads, and a language that marks pure functions can check it. That lets you reorder, cache and run them in parallel, and it makes assertions in tests trustworthy: checking a value does not move the thing under test. Commands, being the only place state changes, are a short list you can read to find where behaviour comes from, and each can be tested by asking afterwards what changed.

It also leaves a clear place for the returned value. A method named `getBalance` that is a query tells the reader what it does by its shape. A method that returns and mutates forces every reader to open the body, and a missing note in the name becomes a bug in somebody else's code.

## Applying it
<!--meta block=applying-->

Make the signature say which kind of method it is:

- Name queries as nouns or questions (`balance`, `isEmpty`) and commands as verbs (`deposit`, `clear`). The name then tells the caller whether it is safe to call twice.
- Return nothing from a command. If the caller needs the result, expose a query for it and let the caller ask after the command.
- Keep queries free of side effects, including hidden ones such as updating a last-read timestamp, filling a cache that other code can see, or advancing a cursor. In review, flag any get, is or find method that assigns a field, writes a cache, bumps a counter or writes a database row.
- Split a mixed method in two where you can: `next()` that advances and returns becomes `current` plus `advance()`.
- Where you cannot split a method, because the two steps must be atomic, keep it and name it for what it does (`takeNext`, `popAndReturn`), so no reader takes it for a query.
- Let a command report failure by throwing, or by returning a success flag or error code, and keep the data out of it. A bare success flag is the limit: anything the caller then uses as data is a result and belongs in a query.
- Remember what this is not for: if reads and writes need different models, schemas or scaling, that is a decision about [separation of concerns](./separation-of-concerns.md) at a larger scale, and CQRS is the pattern, not this rule.

The compact test: does calling the method change anything a later call or another caller can observe? If it does, it is a command and must return nothing. Getting the same answer twice is necessary, not sufficient: a lazy cache fill passes that check and still breaches the rule, and a clock gives different answers while changing nothing.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — a method that reads and writes, and the same job split into a query and a command"
// Before: nextId() returns the number and adds 1.
class IdsBefore {
  private n = 0;
  nextId(): number { return ++this.n; }
}
const old = new IdsBefore();
console.log(old.nextId());     // debug line: prints 1 and uses it up
const first = old.nextId();    // 2, not 1: the log line skipped an id

// After: a query that is safe to repeat, and a command that returns nothing.
class Ids {
  private n = 0;
  current(): number { return this.n; }        // query: no side effect
  advance(): void { this.n += 1; }            // command: no return value
  // Threaded code needs read-and-advance as one step: combine on purpose, name it, lock it.
  takeNext(): number { return ++this.n; }
}
const ids = new Ids();
console.log(ids.current());    // the log line is safe: still 0, any number of times
ids.advance();                 // only this call moves it
```

## Taken too far
<!--meta block=overreach-->

The rule bends where two steps must be one. A stack's `pop()` returns the top item and removes it. Split into `peek()` then `remove()`, it works for one thread and breaks for two: both threads peek the same item, and both remove, so one item is handled twice and another is skipped. The same holds for a compare-and-swap, which checks a value and sets it in one atomic step; split in two, there is a gap another thread can use. In concurrent code the combined method is the correct design, so leave it combined and name it clearly. A queue's `dequeue`, and an iterator's `next()` when threads share it, are the same case.

Rigid application also bloats an API. Making `insert` return nothing forces a follow-up query to learn the generated id, which costs a second round trip and a race on who else inserted. A fluent builder returns `this` from every setter, which is a command that returns a value, and is a deliberate style that is safe because the value is the same object.

Treat the rule as a default that earns exceptions, not a law. The cost of a method that mixes the two is that readers cannot tell what a call does; if you keep one, say so in the name and the documentation, and keep it rare.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Separation of Concerns](./separation-of-concerns.md) — It separates the concern of changing state from reading it at method level.
- [Encapsulation](./encapsulation.md) — Commands are the only door that changes an object's state.
- [Idempotency](../patterns/messaging/idempotency.md) — A query is the safest idempotent call; commands need care to repeat.
- [Principle of Least Astonishment](./least-astonishment.md) — A query that stays side-effect free is what callers assume from its name.

**Often confused with**

- [CQRS](../patterns/architecture/cqrs.md) — Command-query separation (CQS) is a rule for one method; command query responsibility segregation (CQRS) applies the idea to whole models.

<!-- relationships:end -->
