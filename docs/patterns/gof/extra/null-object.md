---
title: Null Object
description: A do-nothing stand-in instead of a null check
area: gof-extra
owner: Oleksandr Derechei
tags: [low-level-design, polymorphism, readability, error-handling]
status: stable
solves: [every method starts with three lines of guards before the real work begins, I keep getting crashes because someone forgot to check for nothing again, the same absence check is copy-pasted at forty call sites and one of them is wrong, an optional logger forces me to test it exists before every single call, my business logic is buried under branches that only handle the missing case]
---

# Null Object

Replaces a null reference with an object that honours the same interface but quietly does nothing — so callers drop the guards and treat "absent" as just another valid collaborator.

## What it is
<!--meta block=description-->

Without it, every caller of an optional collaborator repeats an `if (x != null)` guard, and one missed guard crashes the call. A null object is a real object with the same interface whose methods do nothing or return a harmless value, and a factory or default returns it instead of null. Callers then run one code path, so a missing dependency stops spreading guards. It is a common idiom that the Gang of Four catalogue omits.

## Explained
<!--meta block=explain-->

A null object is a real object with the same interface as the thing it replaces, whose methods do nothing or return a harmless value, so code that would otherwise get null calls it like any other. It removes the \`if (x != null)\` guard from every caller and leaves one code path. Choose it over a null check when having nothing is a normal state and doing nothing is the correct response, such as a logger with no output.

- **Silent failure.** A real failure becomes a write that goes nowhere, with no stack trace. Count or log calls where absence would be a surprise.
- **Extra class.** It adds one empty class per interface; where callers must notice and decide on absence, an optional type keeps that branch visible.

**Example.** A checkout sends a receipt through a Mailer. Guests have no email, so the code uses a NullMailer whose send does nothing, and checkout loses its 6 null checks. That works for guests. Then a bug gives registered users a NullMailer too, because their profile lookup failed. 400 receipts are never sent and nothing throws. The fix is to let a failed lookup throw, and to have the NullMailer report each call, tagged by call site, to an injected counter, with an alert on any hit from the registered-user path. The cost is one extra class and a counter.

## How it works
<!--meta block=structure-->

```mermaid caption="Both implementations satisfy the same interface. The null variant honours the contract but its body is empty, so callers never branch on which one they hold."
classDiagram
    class Logger {
        <<interface>>
        +log(msg)
    }
    class FileLogger {
        +log(msg)
    }
    class NullLogger {
        +log(msg)
    }
    Logger <|.. FileLogger
    Logger <|.. NullLogger
    note for NullLogger "log does nothing, returns nothing"
```

## Variations
<!--meta block=variations-->

- **Do-nothing vs. safe-default** — Some null objects are pure no-ops; others return neutral values — an empty collection, a zero, an unchanged input — so downstream arithmetic and iteration still work.
- **Special Case** — Fowler's generalisation: instead of one "nothing" object, return a dedicated object per known condition — UnknownCustomer, MissingUser — each with its own sensible behaviour.
- **Shared [singleton](../creational/singleton.md) instance** — Because a null object holds no state, one immutable instance can be reused everywhere rather than allocating a fresh one at each call site.
- **[Strategy](../behavioral/strategy.md)** — Wire a do-nothing implementation as the default strategy, so a component behaves harmlessly before anyone configures the real algorithm in.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Gets rid of the repetitive null checks** scattered across every caller.
- **Leaves a single code path with no branches** — just call the object and move on.
- **One unchanging instance** serves every call site while the object holds no state, so nothing is allocated per use.
- **Turns "nothing here" into real, testable behaviour** instead of a special case.

### Cons
<!--meta polarity=con-->

- **Can hide real errors**: a missing value quietly turns into a do-nothing call, so count or log each call made where absence would be a surprise.
- **Needs a new class** for every interface you want a do-nothing version of.
- **The do-nothing behaviour can surprise callers** who expected a failure.
- **It's the wrong choice** when a missing value genuinely needs different handling.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A collaborator is optional**, and when it's missing the right response is simply to do nothing.
- **The same null check** is copy-pasted across many call sites.
- **You want a safe default** in place before the real dependency is wired in.

### Avoid when
<!--meta polarity=avoid-->

- **A missing value is an error** the caller must notice and handle. Throw, or return an optional type; when each kind of absence needs its own behaviour, use Special Case.
- **The do-nothing behaviour would mask a bug** or silently drop data.
- **There's only one call site**, where a single plain guard is simpler and clearer.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a null logger as a safe default"
interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

class ConsoleLogger implements Logger {
  info(message: string): void { console.log(`[info] ${message}`); }
  warn(message: string): void { console.warn(`[warn] ${message}`); }
}

// The do-nothing stand-in: same shape, every method an empty body.
// It holds no state, so one frozen instance is shared everywhere.
const NULL_LOGGER: Logger = Object.freeze({
  info(_message: string): void {},
  warn(_message: string): void {},
});

// Logging is optional, so it defaults to the null object.
function processOrder(id: string, logger: Logger = NULL_LOGGER): void {
  // No `if (logger)` guard anywhere below — just call it.
  logger.info(`processing order ${id}`);
  // ... work ...
}

processOrder("A-1");                       // silent — uses NULL_LOGGER
processOrder("A-2", new ConsoleLogger());  // logs to the console
```

## In the wild
<!--meta block=wild-->

- **Python logging.NullHandler** — A stdlib handler whose emit() does nothing, discarding every record. The documented convention is for a library to attach it to its top-level logger so the library can log unconditionally, prints nothing when the host application has configured no logging, and forces no logging config on it. {#wild-python-nullhandler}
- **SLF4J NOPLogger** — The slf4j-nop binding makes NOPLogger the active logger, with level checks that all return false and log methods that are empty, so every call is a no-op. Dropping the slf4j-nop jar on the classpath silences all SLF4J output without any backend present or any code change at the call sites. {#wild-slf4j-nop}
- **/dev/null** — The Unix null device: every write() succeeds and is discarded, and every read returns EOF. It stands in wherever a real file or stream would go — redirecting a noisy command to it silences output while keeping the program writing normally. {#wild-dev-null}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Shared instance or new each time** — A stateless null object can be a single shared instance.
- **What counts as absent** — Which lookup results become a null object and which stay errors. Expected absence, such as a guest with no email, becomes a null object; a failed or timed-out lookup of something that should exist stays an error.
- **Detection method** — Whether callers may ask if an object is a null object, or never need to. Default to never asking: a null-test method brings back the branch you removed, so allow it only for the rare caller that must treat absence differently.

### Signals to watch
<!--meta polarity=signal-->

- **Null checks left in callers** — Null checks on this type that remain in callers mean adoption is partial.
- **Silent no-op counts** — How often the null object handles a call. A rise can mean data is going missing. Report each call from the null object to an injected counter, tagged by call site; alert on any hit from a path that should hold a real object, and on a rise over that site's baseline.
- **Wrong-reason absence** — Cases where the null object stood in for an error and not an expected absence. Record the reason where the factory picks the null object, and count the failed-lookup reason.

### Failure modes under load
<!--meta polarity=failure-->

- **Masked failure** — A lookup that failed returns a null object, and work silently does nothing. Log when it is used in a place that needs the real thing.
- **Wrong default** — The null object returns a value the caller then treats as real, such as an empty total.
- **Mixed conventions** — Some methods return null and some return the null object, so callers check both.
- **Broken contract** — The null object breaks the interface contract and a caller crashes on its return value.

### Readiness checklist
<!--meta polarity=check-->

- Every method on the null object returns a safe value for its contract
- Callers have no null checks for this type left
- Places where absence is an error use an exception, not a null object
- The null object is stateless and shared; any call counter lives outside it, in an injected metrics sink.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Behavior](../../../themes/object-behavior.md) — Return a harmless do-nothing object instead of null. {#fluency-object-behavior}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Strategy](../behavioral/strategy.md) — Null Object is a neutral strategy
- [Singleton](../creational/singleton.md) — It holds no state, so one shared instance serves every call site
- [Factory Method](../creational/factory-method.md) — A factory hands back the neutral instance instead of a null
- [Liskov Substitution Principle](../../../principles/liskov-substitution.md) — Doing nothing is only a valid substitute where the contract allows nothing as an answer
- [Fallback](../../distributed/resilience/fallback.md) — A fallback's static default, such as an empty list, can be a null object, so callers keep one call shape

**Often confused with**

- [Dummy Object](../../testing/dummy-object.md) — Ships in production; a dummy never leaves the test

<!-- relationships:end -->
