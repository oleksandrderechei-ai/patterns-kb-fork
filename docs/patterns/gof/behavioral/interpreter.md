---
title: Interpreter
description: Represents grammar rules as a class hierarchy
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, composition, extensibility]
status: stable
solves: [my users want to write their own filter rules and I hardcode a new one every week, the business asks for a new condition and I have to ship a release for it, my little query syntax turned into a nest of ifs and string splitting, I am calling eval on user input and it terrifies me, I want to show the user a readable version of the rule they just built]
---

# Interpreter

Turns each rule of a small language into its own class, so a sentence becomes a tree of objects that knows how to evaluate itself.

## What it is
<!--meta block=description-->

A small language, such as a filter or a pricing rule, sprawls into tangled if and switch code where every new rule touches everything. Interpreter gives each grammar rule its own class, so a sentence a parser has read becomes a tree of those objects, which you evaluate by calling one method on the root. It pays off only for small, stable grammars.

## Explained
<!--meta block=explain-->

An interpreter gives a tiny language one class per grammar rule, and a sentence in that language becomes a tree of those objects. Every class has one method, such as evaluate(context), and calling it on the root makes each node call its children, so the code reads like the grammar. Choose it over a parser generator, a tool that builds a parser from a grammar file, only when the language is small and stable: a filter, a pricing rule, a rule for who sees a feature. Interpreter does not read text, so you still need a parser to build the tree, which you write by hand or have a generator write.

- **Class count.** Each rule adds a class, so a rich grammar becomes a pile. When the rule count keeps climbing, switch to a generator.
- **Shared method.** A change to the shared method touches every class, so settle its signature early and keep one method per node.
- **Slow on big inputs.** A deep tree costs a call per node, so parse once and reuse it; a cached result fits only one context.

**Example.** A shop writes a free-shipping rule as: order over 100 dollars OR member, AND NOT sale item. That is 6 nodes: three checks and three operators (OR, AND, NOT). For a member ordering 80 dollars of non-sale goods, the first check fails and the member check passes, so the OR is true. The NOT of a false sale flag is true, so the AND is true and shipping is free. Each evaluation visits at most 6 nodes, so 10 rules per customer cost at most 60 node calls, which is fine. If the rules grow loops and functions, the classes multiply and a parser generator is the better tool.

## How it works
<!--meta block=structure-->

~~~mermaid caption="Each grammar rule is a class. A terminal is a leaf rule with no children, a nonterminal combines other rules, and `evaluate` walks the tree against a shared context."
flowchart TB
    AE["AbstractExpression with evaluate(ctx)"]
    TE["TerminalExpression, a literal or variable"]
    NE["NonterminalExpression, a rule over children"]
    CTX["Context, holds the variable bindings"]
    AE -->|"implemented by"| TE
    AE -->|"implemented by"| NE
    NE -->|"composes"| AE
    TE -->|"reads"| CTX
    NE -->|"reads"| CTX
~~~

## Variations
<!--meta block=variations-->

- **Terminal vs. nonterminal expressions** — The core split: leaf nodes that resolve directly (a number, a variable) versus composite nodes whose result is defined in terms of their children.
- **Context object** — External state — variable bindings, an input cursor, accumulated output — is threaded through as an explicit `Context` argument rather than hidden in the nodes.
- **[Visitor](./visitor.md)** — Move the `evaluate` logic out of the node classes into a separate visitor, so you can add operations such as print and type-check without editing every expression. The price: a new rule class then needs a new method in every visitor, so pick it when operations change more often than rules.
- **[Flyweight](../structural/flyweight.md) terminals** — Terminal symbols repeat constantly across an expression; share single instances of them to shrink the tree, as GoF pairs Interpreter with Flyweight.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Each grammar rule becomes its own class**, so the code reads like the grammar itself.
- **Adding a new rule** means adding a class; the existing rules stay untouched.
- **The parsed tree is plain data**, so a visitor can evaluate, print or transform it without editing the node classes.
- **Each rule's behaviour** lives in one small, focused class you can test on its own.

### Cons
<!--meta polarity=con-->

- **Every rule is a class**, so a rich grammar sprawls into a pile of classes fast; past that point, move to a parser generator.
- **Building and walking a deep tree of objects** is slow over large inputs; parse once and reuse the tree, or compile the hot ones.
- **It only stays practical** for small, stable grammars, not evolving real languages.
- **Changing the shared node interface** ripples across every expression class; settle it early, or move operations into a visitor.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The mini-language is small and well-bounded** — a search filter, a rules engine, arithmetic.
- **The grammar is stable**, and clear code matters more than raw speed.
- **You evaluate the same expressions again and again**, or manipulate them as trees.

### Avoid when
<!--meta polarity=avoid-->

- **The grammar is large or changing fast**: the class count keeps climbing, one change to the shared method touches every class, or authors ask for loops and functions. Reach for a parser generator like ANTLR instead.
- **Speed over big inputs** is critical, and profiling shows tree walking, not parsing, is the cost. Cache the parsed tree first; if the walk is still the cost, compile hot expressions, as Spring Expression Language's `SpelCompilerMode` does.
- **A regular expression or a simple lookup** already does the job.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a small rule language evaluated against a user context"
type Context = Readonly<Record<string, boolean>>;

interface Rule {
  evaluate(ctx: Context): boolean;
}

class Flag implements Rule {                       // terminal: read one fact
  constructor(private readonly name: string) {}
  evaluate(ctx: Context): boolean { return ctx[this.name] ?? false; }
}

class And implements Rule {                        // composite of two rules
  constructor(private readonly left: Rule, private readonly right: Rule) {}
  evaluate(ctx: Context): boolean {
    return this.left.evaluate(ctx) && this.right.evaluate(ctx);
  }
}

class Not implements Rule {                         // composite of one rule
  constructor(private readonly inner: Rule) {}
  evaluate(ctx: Context): boolean { return !this.inner.evaluate(ctx); }
}

// "beta tester AND NOT suspended"
const rule = new And(new Flag("betaTester"), new Not(new Flag("suspended")));
rule.evaluate({ betaTester: true, suspended: false });   // => true
```

## In the wild
<!--meta block=wild-->

- **Common Expression Language (CEL)** — A non-Turing-complete expression language with no unbounded loops, so evaluation is guaranteed to terminate. Kubernetes runs CEL in CRD validation rules (x-kubernetes-validations) and ValidatingAdmissionPolicy; Envoy uses it for role-based access control (RBAC) and access-log filters. Expressions parse to a protobuf AST that can be type-checked against a declared environment before running against a runtime activation. {#wild-cel}
- **Spring Expression Language** — Parses expression strings into an AST evaluated against an EvaluationContext holding variables and a root object. SpelCompilerMode (OFF, IMMEDIATE, MIXED) can compile hot expressions to bytecode for speed, and SimpleEvaluationContext narrows what an expression may reach when the input is not fully trusted. {#wild-spel}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Max nesting depth** — A cap on how deeply an expression tree may nest, bounding recursion so a deeply nested input cannot exhaust the call stack of the evaluating thread. Start from the deepest legitimate expression in your own data plus headroom, and measure the stack each nesting level uses on your runtime.
- **Evaluation budget** — A ceiling on time or step count for interpreting one expression, guarding against runaway or adversarial input, especially when the grammar allows repetition. Start from the slowest legitimate expression plus headroom, and keep the step count in per-evaluation state, not in the cached tree, which is shared.
- **AST caching** — Whether parsed expression trees are cached and reused or rebuilt on every evaluation. Reparsing per call is the usual throughput cliff. Key the cache by expression text, bound its size with eviction, and cache the parsed tree, not results, because a result depends on the context.
- **Context scope** — What variables, functions, and objects an expression may reach through its context. A restricted context is the guard when the expressions come from untrusted input.

### Signals to watch
<!--meta polarity=signal-->

- **Evaluation latency** — p99 time to walk one expression tree; it grows with tree size and nesting depth and is an early sign of a slow input.
- **Parse-to-evaluate ratio** — How often expressions are parsed versus evaluated. A parse count that tracks the evaluate count means the AST cache is absent or never hit.
- **Limit rejections** — Expressions refused by the depth cap or evaluation budget, per source. A burst from one source points at an attack; a rise across all sources points at a cap set too tight. Baseline p99 evaluation latency from legitimate expressions.

### Failure modes under load
<!--meta polarity=failure-->

- **Stack overflow on deep nesting** — An adversarial deeply nested expression recurses past the stack limit and crashes the evaluating thread.
- **Runaway evaluation** — An expression with large repetition or expansion runs far longer than intended, tying up a thread with no budget to stop it.
- **Reparse under load** — Building the AST on every call instead of caching it collapses throughput once evaluation volume rises.

### Readiness checklist
<!--meta polarity=check-->

- Expression nesting depth is capped before evaluation.
- Untrusted expressions run under a time or step budget and against a restricted context.
- Parsed ASTs are cached and reused rather than rebuilt per evaluation.
- The grammar is confirmed simple and stable enough that an object tree beats a parser generator.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Behavior](../../../themes/object-behavior.md) — Model a small language as a tree of rule objects and evaluate it recursively. {#fluency-object-behavior}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Visitor](./visitor.md) — Visitors evaluate interpreter node trees
- [Flyweight](../structural/flyweight.md) — Terminal symbols repeat all over a tree — share one instance each
- [Composite](../structural/composite.md) — The syntax tree is a composite of terminal and nonterminal nodes

<!-- relationships:end -->
