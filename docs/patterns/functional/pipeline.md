---
title: Pipeline / Composition
description: Builds behavior by composing small functions
area: functional
owner: Oleksandr Derechei
tags: [low-level-design, composition, readability]
status: stable
aliases: [pipe, compose]
solves: [reading h(g(f(x))) inside-out makes my head hurt every time I open this file, adding one more step in the middle means rewrapping a nest of parentheses, "my 200-line function parses, cleans and formats in one block so I cannot test any step alone", I want to reorder two processing steps and it turns into a rewrite, every step here is tangled with the next one so I cannot reuse any of them elsewhere]
---

# Pipeline / Composition

Builds complex behavior out of small, single-purpose functions, chaining each one's output directly into the next's input to form one straight-line transformation.

## What it is
<!--meta block=description-->

A pipeline builds a larger transformation from smaller ones: `pipe(f, g, h)` is `x => h(g(f(x)))`, with each stage's output feeding the next. It resolves the clash between reading order and execution order, because nested calls read inside out. Stages are small and pure, so you add, remove or reorder one in a single line and test each alone.

## Explained
<!--meta block=explain-->

A pipeline builds behavior by passing a value through a list of small functions, where each takes the previous one's output. Data moves left to right, each stage does one job, and you can test each stage alone. Choose it over one large function, or over nested calls such as f(g(h(x))) that read inside out, when the work is a clear sequence of transformations.

- **Hidden middle values.** You cannot see values between stages, so add a tap stage that logs the value and passes it on.
- **Shape agreement.** Every stage must agree on the shape it passes, so add a small adapter stage where two do not match.
- **Slow typing.** Type inference over many generic stages gets slow and confusing, so type each stage and split a long pipe into named sub-pipes.
- **Straight line only.** Branches, side effects and errors do not fit, so wrap values in a result type or split the pipeline.

**Example.** A pipeline cleans a price from a CSV: trim, parse, add 20% VAT, format with two decimals. The input " 50 " becomes "50", then 50, then 60, then "60.00". A row reads "5O" with a letter O, and the output is "NaN". The pipeline gives no hint which of 4 stages failed. Adding a tap after each stage shows that the parse stage produced NaN, and the VAT and format stages only passed it on. The fix is a check in the parse stage that returns an error value, which later stages skip. The cost is that the check needs an error path, and a plain straight line cannot hold one without a result type.

## How it works
<!--meta block=structure-->

```mermaid caption="Each stage takes the previous stage's output as its own input. The chain is just the reduction of that rule over an ordered list of functions."
flowchart LR
    In["input value"] -->|"raw"| F1["stage 1, e.g. parse"]
    F1 -->|"parsed"| F2["stage 2, e.g. transform"]
    F2 -->|"transformed"| F3["stage 3, e.g. format"]
    F3 -->|"formatted"| Out["output value"]
```

## Variations
<!--meta block=variations-->

- **Point-free (tacit) style** — Compose functions without ever naming the intermediate value — `pipe(parse, double, format)` instead of `x => format(double(parse(x)))`. Reads as data flow, not variable bookkeeping.
- **[Currying](./currying.md)** — Curried functions compose cleanly in a pipeline — partially applying every stage down to a single argument keeps the whole chain unary end to end.
- **[Unix pipe](../architecture/pipe-filter.md)** — The same idea across processes instead of functions: `cat file | grep x | sort` streams one program's stdout into the next's stdin, stage by stage.
- **[Monad](./monad.md)** — Monadic bind is pipeline composition with context — each stage returns a wrapped value (`Result`, `Option`, a `Promise`) and bind threads it through, short-circuiting on failure instead of throwing mid-chain.
- **Native pipe operator** — Some languages build the chain into the syntax itself — F#'s `|>`, a staged JS/TS proposal — so `x |> f |> g` reads left to right with no helper function at all.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Reads in the order operations actually execute** — left to right, not inside-out.
- **Each stage is a small, pure, independently testable** unit with no shared state.
- **Inserting, removing, or reordering a step** is a local edit, not a rewrap of nested calls.
- **Encourages single-responsibility functions** and referential transparency by construction.

### Cons
<!--meta polarity=con-->

- **Opaque long chains** — a long chain still runs as one opaque call; inspecting an intermediate value means logging or stepping into each stage by hand.
- **Every stage must agree** on the same input/output shape, or the chain needs an adapter stage to bridge them.
- **Type inference across many generic stages** gets unwieldy in strongly typed languages without helper overloads.
- **Branching, side effects, and error handling** don't fit a straight line without a monadic escape hatch.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You're transforming one value** through a sequence of independent steps — parse, validate, normalize, format.
- **The steps are naturally unary and composable**: each takes one input and produces one output.
- **You want to add, remove, or reorder** processing stages without touching the ones you keep.

### Avoid when
<!--meta polarity=avoid-->

- **The logic branches heavily or needs to short-circuit** — an explicit conditional reads clearer than composing around it.
- **Steps share complex mutable state** that a straight pipe can't express without smuggling it through the value.
- **A single well-named function** already does the whole job — composing two steps to save one function isn't a win.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a generic pipe helper"
type Fn<A, B> = (a: A) => B;

// Chains any number of unary functions, left to right.
// The any signature is untyped: it drops per-stage type checks.
// Typed overloads such as pipe<A, B, C>(f: Fn<A, B>, g: Fn<B, C>) keep them.
function pipe(...fns: Fn<any, any>[]): Fn<any, any> {
  return (input: any) =>
    fns.reduce((value, fn) => fn(value), input);
}

// A tap stage logs the value and passes it on unchanged.
const tap = <T>(label: string) => (v: T): T => { console.log(label, v); return v; };

const parse = (raw: string): number => Number(raw.trim());
const double = (n: number): number => n * 2;
const format = (n: number): string => `total: ${n}`;

const process = pipe(parse, tap<number>("parsed"), double, format);

console.log(process("  21 ")); // logs "parsed 21", then prints "total: 42"
```

## In the wild
<!--meta block=wild-->

- **Unix shell pipelines** — The | operator wires one program's stdout into the next's stdin; stages run concurrently and a fixed-size kernel pipe buffer applies backpressure, blocking the writer when the reader falls behind. set -o pipefail surfaces a failure from any stage rather than just the last. {#wild-unix-pipes}
- **RxJS pipe()** — Observables compose by passing unary operators to pipe(); for cold observables the chain stays lazy until subscribe, each operator returns a new Observable, and tap() inserts a side-effecting stage for logging without altering the stream. {#wild-rxjs-pipe}
- **java.util.stream** — Intermediate operations such as map and filter are lazy and fused into a single pass that runs only when a terminal operation (collect, reduce) pulls; a stream is single-use, and parallel() hands the pipeline to the common ForkJoin pool. {#wild-java-streams}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Lazy vs. eager evaluation** — Whether stages run eagerly — each producing a full intermediate collection — or lazily, fused into one pass that pulls a single element at a time until a terminal step. Eager is simpler to reason about; lazy avoids materializing intermediates and can short-circuit early over large inputs.
- **Debug / tap stage** — An identity stage with a side effect (a tap/trace step) inserted to observe or log the value flowing between stages without altering the data. The dial is how many taps and whether they stay on in production or are compiled out.

### Signals to watch
<!--meta polarity=signal-->

- **Intermediate-collection memory (eager pipelines)** — In an eager collection pipeline each stage materializes a full copy of its output, so peak memory is about two copies of the input at once (a stage's input and its output), more if earlier copies stay referenced. Observable as allocation and live-heap growth over a large input.
- **Per-stage latency (once instrumented)** — A composed chain reports one total time; attributing that latency to a specific stage is only observable if a timing tap sits between stages, otherwise the whole pipe is one opaque number.

### Failure modes under load
<!--meta polarity=failure-->

- **Opaque chain, poor observability** — A failure deep in a long composed chain shows a stack trace pointing at the generic pipe/reduce helper, not the failing stage.
- **Deferred errors in lazy pipelines** — In a lazy pipeline nothing runs until the terminal step, so a fault built into an early stage only throws when the terminal operation pulls — far from where the pipeline was assembled, and easy to misattribute to the wrong stage.
- **Intermediate blow-up over large inputs** — An eager collection pipeline materializes a full intermediate collection at every stage; over a large input each copy stays live until the next stage finishes with it, spiking memory versus a lazy or fused single pass.

### Readiness checklist
<!--meta polarity=check-->

- For large inputs, choose lazy / fused evaluation so stages don't each materialize a full intermediate collection.
- Keep a way to observe intermediates — a tap/trace stage or per-stage logging — before a long chain ships, since a failure mid-chain won't point at the stage.
- Ensure adjacent stages agree on input/output shape, or insert an explicit adapter stage rather than a silent coercion.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Functional Programming](../../themes/functional-programming.md) — Compose small unary functions so a value flows through each in turn. {#fluency-functional-programming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Currying](./currying.md) — Curried functions compose cleanly in a pipeline
- [Monad](./monad.md) — Monadic bind is pipeline composition with context
- [Functor](./functor.md) — Mapping inside a wrapper keeps stages unary
- [Immutability](./immutability.md) — Pure stages only compose safely when values are never edited in place

**Often confused with**

- [Pipe-and-Filter](../architecture/pipe-filter.md) — Composed functions in one process vs. decoupled stages

<!-- relationships:end -->
