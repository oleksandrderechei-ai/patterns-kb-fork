---
title: Future / Promise
description: A placeholder for a result that isn't ready yet
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, asynchrony, composition]
status: stable
aliases: [deferred, task]
solves: [my callbacks are nested five levels deep and I cannot follow the code anymore, the calling thread just sits there doing nothing while it waits for a response, I fire off ten independent API calls and they run one after another instead of at once, an error inside an async call gets swallowed and never reaches my error handling, I need to hand a not-yet-known result to another function without blocking on it first]
---

# Future / Promise

A placeholder for a value that doesn't exist yet — handed to the caller the moment async work starts, so it can carry on and collect the result, or the failure, whenever it actually arrives.

## What it is
<!--meta block=description-->

Asking for a result that is not ready forces a choice: block a thread until it arrives, or nest the next step inside a callback. A future is a placeholder you get back at once. The work fills it later with a value or an error, and any steps attached to it then run. You hold it, pass it around and chain steps on it like any other value.

## Explained
<!--meta block=explain-->

A future is a placeholder for a result that is not ready yet. You start the work, get the placeholder back at once, and carry on; later you read the value, or attach a step that runs when it arrives. The promise is the writing end: the work fills it exactly once, with a value or an error, and everyone holding the future sees the same outcome. Choose it over a plain callback when you chain steps, combine several results, or want errors to travel down the chain to one place. Choose it over blocking a thread to wait when many calls are in flight, because a waiting thread costs memory and does nothing.

- **No cancel** Most work cannot be cancelled once started; pass a deadline or cancellation flag that the work checks.
- **Lost errors** An error nobody handles can vanish; end every chain with an error handler.
- **Lost stack traces** Traces lose the original caller; log a request id at each step.
- **One value only** A future settles once; use a stream when you expect many values over time.

**Example.** A page needs three independent calls: user 80 ms, orders 120 ms and recommendations 200 ms. One after another they take 400 ms. Start all three, get three futures, and wait for all of them: the page takes 200 ms, the slowest. If recommendations fail at 30 ms and nothing handles that error, the join rejects at 30 ms and the page shows nothing; a handler on that future returns an empty list and the page loads at 120 ms plus rendering. The cost shows when the user leaves at 50 ms: all three calls keep running, because nothing told them to stop.

## How it works
<!--meta block=structure-->

```mermaid caption="How does the caller keep working while the answer is still missing? Step 2 hands back the placeholder immediately, and the outcome written at step 4 reaches every step attached at step 3 — whether it was attached before or after the work finished."
flowchart LR
    C["Caller"]
    W["Worker or I/O call"]:::ext
    subgraph Ph["One placeholder, written once, read by all"]
        F[("Future — pending, then a value or an error")]
    end
    N["The step attached to it"]
    C -->|"1 start the slow work"| W
    C -->|"2 take the placeholder back at once"| F
    C -->|"3 attach what comes next"| N
    W -->|"4 write the value, or the error"| F
    F -->|"5 run the waiting step with that outcome"| N
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="A future starts pending and settles exactly once. Callbacks queued before that point, or attached after, all see the same fulfilled or rejected outcome."
stateDiagram-v2
    [*] --> Pending
    Pending --> Fulfilled: resolve(value)
    Pending --> Rejected: reject(error)
    Fulfilled --> [*]
    Rejected --> [*]
    note right of Pending: then() queues callbacks
    note right of Fulfilled: queued callbacks run with the value
    note right of Rejected: queued callbacks run with the error
```

## Variations
<!--meta block=variations-->

- **Deferred** — An explicit producer/consumer split: a small object exposing `resolve`/`reject` alongside the future itself, for cases where an executor-function style doesn't fit — e.g. resolving from an event handler registered elsewhere.
- **Eager vs. lazy futures** — JS and Java promises start running the moment they're constructed. Others — C++'s `std::async` with `std::launch::deferred`, effect types in functional libraries — do nothing until something actually asks for the result, trading immediacy for control over when, and how often, the work runs.
- **Cancellable futures** — A plain `Promise` has no cancel; Java's `Future#cancel` and Guava's `ListenableFuture` expose one, at the cost of the underlying operation cooperating with interruption.
- **Combinators** — all/any/race/allSettled join many futures into one, so independent work runs concurrently without manual counters. all rejects on the first failure while the other calls keep running; allSettled waits for every outcome; any fulfils with the first success and rejects only when all fail; race settles with the first outcome of either kind.
- **Split read and write ends** — C++'s `std::future` is the read-only handle a consumer holds, written through the `std::promise` the producer keeps, and .NET pairs a `Task` with a `TaskCompletionSource`. Java's `Future` is the consumer handle (it can get and cancel, but not complete) and `CompletableFuture` is the end the producer completes. JavaScript's `Promise` joins both: the executor function you pass to its constructor is the producer side.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Non-blocking** — the caller gets a handle back immediately and keeps its thread free.
- **Composable**: chain steps with `then`/`map` instead of nesting callbacks.
- **One channel for outcomes** — success and failure both flow through the same chain.
- **Combine many async calls into one** — combinators (`all`, `race`, ...) join independent async calls into one future.

### Cons
<!--meta polarity=con-->

- **Most implementations offer no cancellation** once the work has started.
- **An unhandled rejection can vanish silently** unless the runtime flags it explicitly.
- **Stack traces across async boundaries** lose the original call site, hurting debugging.
- **A future settles once** — it can't model a stream of many values over time.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You kick off I/O**, a remote call, or work submitted to a [Thread Pool](./thread-pool.md), and want the calling thread free in the meantime.
- **Several independent async operations need to be joined** — wait for all of them, take the first, or collect whichever finish.
- **You want one uniform channel** for success and failure to flow through a chain of steps.

### Avoid when
<!--meta polarity=avoid-->

- **The value is already available**, or the computation is synchronous and fast — wrapping it just adds indirection.
- **You need a stream of many values** over time rather than one eventual result — a future settles once and is done.
- **The caller must react continuously as events occur**, which is what a [Reactor](./reactor.md) loop is for, not a single future.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal future"
type State = "pending" | "fulfilled";

class Future<T> {
  private state: State = "pending";
  private value?: T;
  private callbacks: Array<() => void> = [];

  resolve(value: T) {
    if (this.state !== "pending") return; // settles exactly once
    this.state = "fulfilled";
    this.value = value;
    this.callbacks.forEach((cb) => cb());
  }

  then<R>(onFulfilled: (v: T) => R): Future<R> {
    const next = new Future<R>();
    const run = () => next.resolve(onFulfilled(this.value as T));
    this.state === "fulfilled" ? run() : this.callbacks.push(run);
    // … no reject path or timeout here: a throwing onFulfilled leaves next pending forever
    // real Promises queue settled callbacks on the microtask queue; this sketch runs them inline
    return next;
  }
}

// Producer resolves later; consumer chains before that happens.
const price = new Future<number>();
const withTax = price.then((p) => p * 1.2);
withTax.then((total) => console.log(total)); // logs once price resolves
price.resolve(100);                           // fires the whole chain
```

## In the wild
<!--meta block=wild-->

- **JavaScript Promise** — Standardized in ES2015 as the language-level settle-once handle that async/await desugars into, with all/race/allSettled as its combinators. Continuations always run on the microtask queue — never synchronously, even when the promise is already settled — and the safety net for swallowed errors is the unhandledRejection event, which Node.js turned into a process-crashing default in v15 precisely because vanishing rejections were the ecosystem's chronic bug. {#wild-js-promise}
- **java.util.concurrent.CompletableFuture** — Merges the read-only Future handle and the resolvable producer side into one type you can chain with thenApply and thenCompose. Which thread runs each stage is the operational knob: the non-Async methods may execute on whichever thread completed the previous stage, while the \*Async variants default to the common ForkJoinPool unless you pass an explicit Executor — and orTimeout/completeOnTimeout (Java 9+) are how a pending chain gets a deadline. {#wild-completablefuture}
- **.NET Task** — Task and Task\<T> are the futures the C# async/await machinery is built on, resolved by the thread pool or by I/O completion. ConfigureAwait(false) is the dial that decides whether a continuation resumes on the captured context, cancellation flows through explicitly passed CancellationTokens rather than the handle itself, and blocking on .Result from a context the completion needs is the ecosystem's best-known deadlock. {#wild-dotnet-task}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **where continuations run** — the completer's thread, a captured context, or an explicit executor — defaults differ per runtime (thenApply vs. thenApplyAsync, ConfigureAwait), and the wrong one runs your callback on a thread you did not expect
- **completion timeout** — the deadline after which a pending future is failed or given a fallback value; without one, a lost response pends forever and quietly leaks everything awaiting it
- **cancellation propagation** — whether cancelling the handle actually stops the underlying work — most implementations need explicit cooperation (a token, an interrupt check) or the work runs to completion anyway
- **fan-out width** — how many joined futures are in flight at once; eager futures (JS, Java) start when created, so building one per item fires them all whatever the combinator does, while lazy types start only when awaited; batch, or cap with a semaphore, so the downstream does not feel the whole collection

### Signals to watch
<!--meta polarity=signal-->

- **pending-future age** — how long handles stay unresolved; a growing tail means a stalled dependency or completions that were simply never written
- **unhandled rejection count** — runtimes surface these as last-resort events or log lines — any nonzero rate means errors are disappearing between producer and consumer
- **continuation scheduling delay** — the gap between a future settling and its callback running; on a single-threaded loop this is event-loop lag, on a pool it is queue time

### Failure modes under load
<!--meta polarity=failure-->

- **forever-pending future** — one branch of the producer returns without settling — no error, no timeout, just an await that never wakes and a caller that leaks
- **swallowed rejection** — the future settles with an error but nothing is attached to observe it; the failure vanishes until a last-resort runtime event fires, or never
- **sync-over-async deadlock** — blocking on the result from the very thread or context the completion needs; a single-threaded context deadlocks on the first call, and a pool deadlocks once every one of its threads is blocked this way
- **unbounded fan-out** — joining a future per item of a large collection starts them all at once — the dependency sees the whole burst, and sockets or memory run out before the join completes

### Readiness checklist
<!--meta polarity=check-->

- settle on every code path — audit error branches for a return without a resolve or reject
- attach a rejection handler to every future, including fire-and-forget ones
- give every await a deadline; a future without a timeout is an unbounded wait
- never block synchronously on a future from a context that is needed to complete it
- bound fan-out when joining many futures — the combinator will not do it for you

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Get a placeholder now and read the result when the work finishes. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Thread Pool](./thread-pool.md) — Submitting work returns a future
- [Reactor](./reactor.md) — The loop resolves futures as events arrive
- [Fan-In](../messaging/fan-in.md) — all/race combinators join many pending results into one
- [Active Object](./active-object.md) — The future is how an active object hands back results without making the caller wait
- [Fork-Join](./fork-join.md) — A future is how a join waits for the result of a forked piece
- [Proactor](./proactor.md) — A future can be resolved by a proactor's completion event

**Specializes**

- [Monad](../functional/monad.md) — then/map is bind for the not-yet-arrived value

**Often confused with**

- [Observer](../gof/behavioral/observer.md) — A future settles once; an observable keeps pushing values over time
- [Asynchronous Request-Reply](../distributed/routing/async-request-reply.md) — A future is the in-process handle; async-request-reply hands back a pollable handle across a network boundary

**Prevents**

- [Synchronous I/O](../../hazards/synchronous-io.md) — Lets a caller compose an answer that has not arrived, instead of blocking until it does

<!-- relationships:end -->
