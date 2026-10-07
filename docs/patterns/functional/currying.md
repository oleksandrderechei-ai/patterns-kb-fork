---
title: Currying
description: "Pre-fill some arguments, get back a function"
area: functional
owner: Oleksandr Derechei
tags: [low-level-design, composition, abstraction]
status: stable
aliases: [partial application]
solves: [I pass the same config as the first argument on every single call and it is pure noise, every callback I write is a throwaway wrapper that just forwards one captured variable, I want a version of this function with the connection and the logger already baked in, my pipeline steps take two arguments each so nothing composes without glue lambdas, I have five near-identical helpers that differ only in one constant]
---

# Currying

Turns a function of several arguments into a chain of one-argument functions, so pre-filling the early ones hands you back a function that's just waiting for the rest.

## What it is
<!--meta block=description-->

Some arguments, like a config or a conversion rate, are known early, while others arrive later inside a loop or callback, and re-passing the early ones on every call is noise. Currying turns a function of several arguments into a chain of one-argument functions, f(a)(b)(c). Calling with fewer arguments returns a new function waiting for the rest.

## Explained
<!--meta block=explain-->

A curried function takes its arguments one at a time and gives back a new function after each, until the last one arrives and the real work runs. Fixing the first arguments therefore gives you a ready-made function that waits only for the rest. Every curried function takes one value and returns one value, so it composes like any unary function, which is the shape a pipeline needs. It is close to partial application, which binds some arguments of an n-ary function in one step; a curried function takes one argument per call, so binding several at once needs a variadic helper. Choose it over writing a small wrapper function at each call site when you reuse the same leading arguments across many calls, such as a configuration first and the data last, which fits map and filter well.

- **Order is the contract.** Reordering parameters breaks every partly filled copy, so put stable settings first, data last, and treat the order as public.
- **Long chains read badly.** Curry two or three parameters and pass an options object beyond that.
- **Awkward types.** TypeScript checks a long chain poorly, so write the types out or use a typed helper.
- **Hard to debug.** A stack of returned functions is hard to see, so name the middle functions.

**Example.** A function formatPrice(currency, locale, amount) is curried. You write eur = formatPrice("EUR", "de") once, then prices.map(eur) formats 1,000 prices without repeating the currency and locale. Later someone reorders the parameters to (amount, currency, locale) because it reads better. The 14 places that call formatPrice("EUR", "de") still compile in a loosely typed codebase, but they now treat "EUR" as the amount, and the output is wrong with no error. The fix is distinct types: a number for the amount and separate Currency and Locale types, so a swap fails to compile, plus a rule that the order does not change.

## How it works
<!--meta block=structure-->

```mermaid caption="Each call supplies one argument and returns a new function closed over it, until the chain has enough arguments to run the original function."
flowchart LR
    ADD["add a, b, c"] -->|"wrap"| CURRY["curry add"]
    CURRY -->|"apply first arg"| S1["add 1"]
    S1 -->|"closes over a=1, returns fn"| S2["fn 2"]
    S2 -->|"closes over b=2, returns fn"| S3["fn 3"]
    S3 -->|"closes over c=3, applies add"| R["6"]
```

## Variations
<!--meta block=variations-->

- **Manual currying** — Write the nested closures by hand: `a => b => c => …`. No dependency, full clarity, but tedious past two or three arguments.
- **Auto-currying** — A helper like `curry(fn)` inspects `fn.length` and returns a function that keeps collecting arguments until it has enough, then invokes the original in one shot.
- **Curry with placeholders** — Accept a placeholder token (Ramda's `R.__`) so a caller can fix a later argument first and leave an earlier one open, instead of currying strictly left to right.
- **Data-last argument order** — Functional libraries put the data being transformed last, so `map(fn)` curries the transformer and leaves a unary function ready to receive the collection inside a pipeline.
- **Uncurrying** — The inverse transform: collapse a chain of unary functions back into one call taking all the arguments at once, useful when interoperating with ordinary n-ary APIs.
- **Explicit-arity currying** — Pass the argument count, as in _.curry(fn, arity), for functions with default or rest parameters where fn.length miscounts.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Specializes a general function** into a reusable one by fixing arguments once, not on every call.
- **Every curried function is unary**, so it composes directly with other unary functions.
- **Supports point-free style** — the data argument stays implicit until the final call.
- **Plays well with lazy pipelines**: intermediate calls only build closures; the original function runs when the last argument arrives, so a partly applied step does no work until then.

### Cons
<!--meta polarity=con-->

- **Argument order becomes load-bearing** — reordering a curried function's parameters breaks every partial application of it.
- **Deep curry chains** are harder to read and step through than one call with named arguments.
- **Type inference across a long curried chain** can be awkward in TypeScript without explicit overloads or a curry-aware helper type.
- **A stack of returned closures** is less legible in a debugger than a single stack frame.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You repeatedly call the same function** with the same first few arguments and vary only the last one.
- **You're building a composition pipeline** and need every step to be a unary function.
- **You want to build specialized functions** — a logger bound to one prefix, a validator bound to one schema — from one general one.

### Avoid when
<!--meta polarity=avoid-->

- **The function only has one call site** with all its arguments at hand — currying adds indirection with no reuse to show for it.
- **Argument order in your domain is unstable**, or arguments are optional and named — a single object parameter serves better.
- **Curried style would slow down code review** more than the reuse is worth for a team unfamiliar with it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a small curry helper"
function curry<A, B, C, R>(
  fn: (a: A, b: B, c: C) => R,
): (a: A) => (b: B) => (c: C) => R {
  return (a: A) => (b: B) => (c: C) => fn(a, b, c);
}

function add(a: number, b: number, c: number): number {
  return a + b + c;
}

const curriedAdd = curry(add);
const addFive = curriedAdd(5);       // fix the first argument
const addFiveAndTwo = addFive(2);    // fix the second
addFiveAndTwo(3);                    // 10 — runs on the last call

// A pipeline step: bind the config, leave the record for later
const withTax = (rate: number) => (price: number) => price * (1 + rate);
const addVat = withTax(0.2);
[10, 20, 30].map(addVat);            // [12, 24, 36]

// Auto-curry helpers read fn.length, which stops at the first default parameter.
const greet = (name: string, greeting = "Hi") => `${greeting}, ${name}`;
greet.length;                        // 1, so an fn.length curry calls greet after one argument
```

## In the wild
<!--meta block=wild-->

- **Haskell** — Every function is curried by default: the type a -> b -> c is really a -> (b -> c), so applying fewer than all arguments yields a partially applied function with no helper, and operator sections like (+1) fall out of the same rule. {#wild-haskell}
- **Ramda** — Every function ships auto-curried and data-last, so calling with fewer arguments returns a specialized function ready for a pipeline; the R.\_\_ placeholder lets you fix a later argument and leave an earlier one open. {#wild-ramda}
- **Lodash curry** — \_.curry(fn) reads fn.length to decide when it has collected enough arguments across calls before invoking; the \_ placeholder holds a position open, and \_.curryRight applies arguments from the right instead of the left. {#wild-lodash-curry}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Argument order** — Put the configuration first and the data last, so partial application yields a reusable function. A wrong order makes every partial application awkward.
- **Fixed arity** — Declare the argument count curry relies on. For functions with default or rest parameters, pass the count explicitly, as in _.curry(fn, arity), and test it against the call; a wrong count makes the helper call the function too early or wait forever.
- **Auto-curry or explicit** — Libraries that curry every function, or functions curried by hand at the definitions that need it.

### Signals to watch
<!--meta polarity=signal-->

- **Partial applications reused** — Partially applied functions that appear in more than one place show the order is right.
- **Wrappers written to reorder arguments** — Lambdas that only swap argument order say the signatures are in the wrong order.
- **Call-site readability** — Reviewers who have to count parentheses to read a call say currying went too far.

### Failure modes under load
<!--meta polarity=failure-->

- **Default and rest arguments** — A curry helper that reads function length miscounts functions with default or rest parameters, so it calls too early or never.
- **Silent partial result** — Forgetting an argument returns a function instead of a value, and the bug surfaces far from the call. A typed signature that expects a value catches it; untyped or `any` code does not.
- **Stack traces** — Curried calls produce anonymous intermediate functions, so a trace shows little about which step failed.
- **Allocation in hot loops** — Each partial application allocates a closure. Usually negligible; in a measured hot path, apply once outside the loop.

### Readiness checklist
<!--meta polarity=check-->

- Argument order is configuration first, data last across the module
- Curry helpers are tested with default and rest parameters
- Types flag a call that returns a function where a value is expected
- Hot paths apply the curried function once, outside the loop

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Functional Programming](../../themes/functional-programming.md) — Turn a many-argument function into a chain of one-argument functions. {#fluency-functional-programming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Pipeline / Composition](./pipeline.md) — Curried functions compose cleanly in a pipeline
- [Functor](./functor.md) — Data-last currying makes map a ready unary stage

**Alternative to**

- [Dependency Injection](../gof/extra/dependency-injection.md) — Bind the config early instead of injecting a collaborator

<!-- relationships:end -->
