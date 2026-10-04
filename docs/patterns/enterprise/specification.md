---
title: Specification
description: "A business rule as a named predicate object, joined with and, or and not"
area: enterprise
owner: Oleksandr Derechei
tags: [domain-modeling, composition, encapsulation]
status: stable
aliases: [Specification pattern, predicate object]
solves: ["the same business rule is written slightly differently in the report, the job and the screen, and they disagree", a search screen lets users mix any filters and the query code is a pile of if statements, changing what counts as overdue means hunting through the code for every copy of the condition, I cannot unit test one business rule without loading a whole object graph]
---

# Specification

Put a business rule in an object of its own that answers one question, is this candidate a match, and join such objects with and, or and not, so a rule has a name, one home and can be reused for checking, selecting and building.

## What it is
<!--meta block=description-->

A rule like "an invoice is overdue" written inline in the report, the reminder job and the screen drifts: change it in two places and customers get reminders the report says are fine. A specification is a small object with one question, isSatisfiedBy(candidate), that gives the rule a name and one home, and combines with and, or and not.

## Explained
<!--meta block=explain-->

A specification is a small object with one question, is this candidate a match, that holds one business rule under a name from the domain. You join specifications with and, or and not, and the result is itself a specification, so it passes anywhere a single one can. The same rule then does three jobs. It checks one object. It selects from a set, either by testing each object or by turning into a query for a [repository](repository.md). It also states what a new object must satisfy, so a factory can build one, though this is rarer. Choose it over an inline condition when the rule is used in several places, when users combine criteria freely, or when a domain expert needs to read and own the rule.

- **Many small classes.** Each rule becomes a type, so a simple filter turns into several.
- **Loading cost in memory.** Testing is cheap but every candidate must be loaded first, so for large sets translate the tree into a query.
- **Translation limits.** The translator must cover every leaf, meaning each small rule in the tree, so keep leaves to what the query language can state.

**Example.** Finance defines an invoice as remindable when it is overdue and not disputed. The reminder job, the overdue report and the invoice screen each had their own copy of the test. When the grace period changes from 0 to 5 days, one copy is missed, and 38 customers are reminded early. With a Remindable specification built from Overdue and Not Disputed, the change is made once and all three places agree. The report selects from 200,000 invoices, so its repository turns the rule into one query instead of loading all 200,000 to test them one by one. The translator must state the 5-day cutoff too, so a test runs both forms over the same rows.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one named rule serve both a check and a query? Small specifications are built at 1 and joined at 2, the whole tree is handed to the repository at 3, and the repository either tests each candidate at 4 or turns the tree into a query, giving the same matches at 5."
flowchart LR
    Client["Client code"]
    subgraph Rule["One composed rule"]
        Overdue["Overdue"]
        NotDisputed["Not Disputed"]
        And["And"]
    end
    Repo["Repository"]
    Store[("Invoices")]
    Client -->|"1 create small specifications"| Overdue
    Overdue -->|"2 combine with and, not"| And
    NotDisputed -->|"2 combine with and, not"| And
    Client -->|"3 find where rule holds"| Repo
    Repo -->|"4 test each, or build a query"| Store
    Store -->|"5 matching invoices"| Client
```

```mermaid caption="Evaluating a composed rule on one candidate: the And asks each part in turn and stops at the first false."
sequenceDiagram
    autonumber
    participant C as Caller
    participant A as And spec
    participant O as Overdue
    participant N as Not(Disputed)
    C->>A: isSatisfiedBy(invoice)
    A->>O: isSatisfiedBy(invoice)
    O-->>A: true
    A->>N: isSatisfiedBy(invoice)
    N-->>A: true (not disputed)
    A-->>C: true
```

Combinators hold other specifications, as in the [Composite](../gof/structural/composite.md) pattern; each leaf is one small rule with one reason to change. The two paths give the same matches only if the translator copies the in-memory semantics for nulls, case, collation and time, so test both paths against the same data.

## Variations
<!--meta block=variations-->

- **In-memory specification** — `isSatisfiedBy` runs on objects you have already loaded. It is the simplest form and works for validation and for small sets, and it loads every candidate to test it.
- **Query-translating specification** — The specification exposes its shape, so a repository can write it as SQL or a criteria query. The filtering moves to the database, at the cost of a translator and of rules that cannot be expressed in the query language.
- **Parameterised specification** — A rule takes arguments, such as `OverdueBy(days)`. It keeps a family of rules in one class, and a growing list of parameters is a sign the rule should be split.
- **Plain predicates** — A function from candidate to boolean with `and`, `or` and `not` helpers. It is the lightest form and it gives up the named class a domain expert can read.
- **Specification for construction** — The rule states what a new object must satisfy, and a factory builds to meet it. It is rarer, and it is the same rule used for a third job.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One home per rule** — a change is made once for in-memory checks; a translated query also needs its translator updated, so test the two forms against each other.
- **Rules named in domain words** — `Overdue` and `Disputed` read like the business, so a domain expert can check them.
- **Composable by design** — new rules come from joining old ones with and, or and not, with no new class for each combination.
- **Testable alone** — a specification needs only a candidate, so each rule has a small unit test.

### Cons
<!--meta polarity=con-->

- **Many small classes** — a simple filter becomes several types; use plain predicates where the rule is used once.
- **Slow when run in memory** — testing each loaded candidate does not scale; translate the tree to a query for large sets.
- **Translation is a second system** — a query form needs support for each leaf and each combinator.
- **Easy to overuse** — a rule used in one place gains nothing from the indirection; wait for the second use before extracting it.
- **Two evaluators can disagree** — the in-memory test and the translated query can differ on nulls, case and time, so the same rule matches different rows.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The same rule is checked in several places** — validation, filtering and reports must agree, and now each has its own copy.
- **Users combine criteria** — a search screen where any mix of filters can be joined needs and, or and not over small tests.
- **Domain experts own the rules** — the rules change often and need names the business recognises.

### Avoid when
<!--meta polarity=avoid-->

- **The rule is a one-off check** — use a plain condition, since an object adds ceremony and no reuse.
- **Rules always run in the database** — write the query directly through the [Repository](./repository.md) and skip the object layer.
- **The rule belongs to one object** — put it as a method on the [Aggregate](../ddd/aggregate.md) that owns the data, where it is already named and close.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — small specifications joined with and, or and not, used to check and to filter"
abstract class Spec<T> {
  abstract isSatisfiedBy(x: T): boolean;
  and(o: Spec<T>): Spec<T> { return new Fn(x => this.isSatisfiedBy(x) && o.isSatisfiedBy(x)); }
  or(o: Spec<T>): Spec<T>  { return new Fn(x => this.isSatisfiedBy(x) || o.isSatisfiedBy(x)); }
  not(): Spec<T>           { return new Fn(x => !this.isSatisfiedBy(x)); }
}
class Fn<T> extends Spec<T> {
  constructor(private f: (x: T) => boolean) { super(); }
  isSatisfiedBy(x: T) { return this.f(x); }
}

type Invoice = { dueDate: Date; disputed: boolean };
const overdue = new Fn<Invoice>(i => i.dueDate < new Date());   // reads the clock; inject it in production
const disputed = new Fn<Invoice>(i => i.disputed);

const remindable = overdue.and(disputed.not());   // composed rule, named by its variable
const toRemind = invoices.filter(i => remindable.isSatisfiedBy(i));
```

## In the wild
<!--meta block=wild-->

- **Spring Data JPA** — Provides a Specification\<T> interface whose toPredicate builds a Java Persistence API (JPA) Criteria predicate, with and, or and not helpers to join them, and a repository that can find all entities matching one. {#wild-spring-data-jpa}
- **java.util.function.Predicate** — Java standard library predicate with and, or and negate default methods, the in-memory form of the same idea. {#wild-java-predicate}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **in-memory versus query translation** — whether a specification runs on loaded objects or becomes a query. Stay in memory while the candidate set fits comfortably in memory; translate once it does not or the rule runs on every request.
- **leaf granularity** — how small each rule is. Small leaves compose more freely and make the tree larger.

### Signals to watch
<!--meta polarity=signal-->

- **rows loaded per query** — count rows hydrated per specification call and compare to rows returned; a ratio far above 1 means move the rule into the query. Set the alert from your memory budget divided by row size.
- **query time of translated rules** — log the generated SQL per specification and run the database's explain plan on the slowest composed ones; check that filters hit an index.

### Failure modes under load
<!--meta polarity=failure-->

- **in-memory filtering at scale** — a rule that worked on a thousand rows loads millions and runs out of memory or time.
- **rule that cannot translate** — one leaf with no query form forces the whole tree back to in-memory testing.

### Readiness checklist
<!--meta polarity=check-->

- give each rule one name from the domain and one unit test
- decide for each repository whether it tests in memory or builds a query
- keep specifications free of side effects so they are safe to call any number of times

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Enterprise Application Patterns](../../themes/enterprise-application-patterns.md) — Express a rule as a composable predicate that a repository can test or turn into a query. {#fluency-enterprise-application-patterns}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Repository](./repository.md) — A repository takes a specification and returns the matching objects.
- [Aggregate](../ddd/aggregate.md) — Rules about an aggregate live beside it as named specifications.
- [Value Object](../ddd/value-object.md) — A specification is itself a small, immutable value with no identity.
- [Composite](../gof/structural/composite.md) — And, or and not nodes hold other specifications as a composite tree.
- [Query Object](./query-object.md) — A specification can be turned into a query object's criteria

**Alternative to**

- [Strategy](../gof/behavioral/strategy.md) — Both wrap one rule in an object; here the rule returns match or no match and composes.

**Prevents**

- [Shotgun Surgery](../../hazards/shotgun-surgery.md) — One home per rule, so a change to it is made once instead of at every copy

<!-- relationships:end -->
