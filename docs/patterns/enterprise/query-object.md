---
title: Query Object
description: A database query built as an object from domain terms, then turned into SQL
area: enterprise
owner: Oleksandr Derechei
tags: [persistence, data-access, decoupling]
status: stable
solves: [a search screen with many optional filters builds SQL by gluing strings together, renaming a column breaks searches scattered across the code, user input reaches my SQL string and I worry about injection, every caller writes its own slightly different query for the same data, my repository has dozens of findByX methods and still cannot cover every filter combination]
---

# Query Object

A query object is an object that represents a database query as criteria over domain fields, which a mapping layer turns into SQL, so callers build searches without writing or knowing the schema.

## What it is
<!--meta block=description-->

Search screens with optional filters produce SQL assembled by gluing strings together: one clause per filled-in box, a stray AND, a column renamed in the table but not in the string. A query object holds the search as data, such as a list of criteria on domain fields. A mapper turns it into SQL, so callers never see table or column names.

## Explained
<!--meta block=explain-->

A query object turns a search into data: a list of criteria on domain fields, such as status equals open and total above 100. A mapping layer reads that list and writes the SQL, binding every value as a parameter. Callers never see a table or a column, and each filled-in filter on a search screen adds one criterion instead of one more piece of string. Choose it over named finder methods on a [repository](./repository.md) when the combinations of filters are too many to name, and over hand-built SQL when the schema changes often enough that strings in the callers keep breaking. If you have five fixed queries, name them and skip this.

- **A limited language.** Joins and window functions may not fit; keep a named raw query for them.
- **Hidden SQL.** A slow query is harder to spot, so log each generated statement with its timing.
- **A layer to own.** Building it yourself is real work; use your ORM's criteria API where it has one.

**Example.** Suppose a support screen has 8 optional filters: status, agent, date range, tag. The string-built SQL has 8 if-branches, and one renamed column breaks 3 of 14 searches because no test covered them. With a query object, each filled box adds one where call, so the search code is about 8 lines, and only the mapper's column table names order_status. Renaming the column is one edit. Values are bound as parameters, so the free-text box cannot inject through its value, and field names come only from the mapper's column table. The cost is that the screen cannot ask for a join across agents and teams, so that one report keeps its own SQL.

## How it works
<!--meta block=structure-->

The caller creates a query object for one domain class and adds criteria: a field, an operator and a value, plus sort and limit. The object has no SQL in it. When it is executed, the mapping layer looks up how each field maps to a column, writes the statement with bound parameters, runs it and builds the result objects. Fowler places it beside the [Data Mapper](./data-mapper.md) because only the mapper knows the schema.

```mermaid caption="How does a caller search without knowing the schema? It builds criteria in domain terms; the mapper alone turns them into parameterised SQL."
flowchart LR
    Caller["Caller"]
    Query["Query object: criteria on fields"]
    subgraph Mapping["Mapping layer"]
        Mapper["Mapper: field to column"]
        Meta[("Field-to-column metadata")]
    end
    DB[("Database")]
    Caller -->|"1 add criteria"| Query
    Query -->|"2 execute"| Mapper
    Mapper -->|"3 look up columns"| Meta
    Mapper -->|"4 SELECT with parameters"| DB
    DB -->|"5 rows"| Mapper
    Mapper -->|"6 domain objects"| Caller
```

## Variations
<!--meta block=variations-->

- **Criteria builder** — Criteria are added one call at a time, such as `where("status", "=", "open")`. It reads like a sentence, and a missing criterion omits its clause, so an empty search returns every row; set a default and a maximum limit.
- **[Specification](./specification.md)-backed query** — The criteria are named rule objects that also run in memory, so one rule filters a database query and a loaded list. Each rule needs a database translator, and the two paths can drift, so test both against the same cases.
- **Query by example** — The caller fills in an object, and every non-empty field becomes an equality criterion. Quick to write for simple screens, but it cannot express ranges or "or".
- **Composite criteria** — And, or and not nodes combine simple criteria in a tree. The mapper walks it and writes nested conditions. Cap tree depth and node count, and reject unknown field names before translating.
- **Behind a [Repository](./repository.md)** — The repository takes a query object and hides the mapper, so domain code sees a collection it can ask questions of.
- **Typed or fluent API** — Field names are checked by the compiler instead of as strings, so a rename becomes a build error, not a runtime one. This holds only if the field type stays `keyof T` through to the mapper.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No SQL in application code.** A column rename touches the mapping metadata, not every search; a domain field rename still needs the typed variation to fail at build time.
- **Optional filters compose safely.** Each filled-in box adds a criterion, with no string gluing and no stray AND.
- **Parameters are always bound,** which closes the common injection path.
- **The screen's search can be tested without a database,** by inspecting the criteria it built; the mapper's translation still needs its own test against a real database.

### Cons
<!--meta polarity=con-->

- **A limited language.** Joins, window functions and vendor features may not fit; expose a named raw query for the few that do not.
- **Another layer to build and maintain** unless a library gives it to you.
- **Hides the SQL that runs.** A slow query is harder to see, so log the generated statement.
- **Easy to over-fetch.** Unindexed filters are cheap to write, so review criteria on hot paths.
- **Identifiers are not parameters.** Field, operator and sort names that come from user input must map through the mapper's whitelist, or they reopen injection.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A search screen has many optional filters** and the SQL is built by concatenating strings.
- **Several callers need similar queries** and you want one way to express them.
- **You use a [Data Mapper](./data-mapper.md)** and the domain code must stay free of table names.
- **You want queries built and inspected as data,** for tests or auditing.

### Avoid when
<!--meta polarity=avoid-->

- **You have a few fixed queries.** Named methods on a repository are simpler and easier to tune.
- **Reports need heavy joins or analytic SQL.** Write the SQL, or read from a separate read model.
- **Your ORM already offers one,** and building another on top adds a layer without removing any code.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — criteria over domain fields, translated to parameterised SQL by the mapper only"
type Op = "=" | ">" | "<" | "like";
interface Criterion { field: string; op: Op; value: unknown }

class Query<T> {
  private criteria: Criterion[] = [];
  private limitN?: number;
  constructor(readonly entity: new () => T) {}
  where(field: keyof T & string, op: Op, value: unknown) {
    this.criteria.push({ field, op, value });
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  get parts() { return { criteria: this.criteria, limit: this.limitN }; }
}

// Only the mapper knows the columns.
const columns: Record<string, string> = { status: "order_status", total: "total_cents" };

// table and op are compile-time constants, never user input.
// Only criteria values are bound; limit is bound too, as the last parameter.
function toSql(table: string, q: Query<unknown>) {
  const { criteria, limit } = q.parts;
  const where = criteria.map((c, i) => {
    const col = columns[c.field];
    if (!col) throw new Error(`unmapped field: ${c.field}`);
    return `${col} ${c.op} $${i + 1}`;
  }).join(" AND ");
  const params: unknown[] = criteria.map(c => c.value);
  let sql = `SELECT * FROM ${table}${where ? " WHERE " + where : ""}`;
  if (limit !== undefined) { sql += ` LIMIT $${params.length + 1}`; params.push(limit); }
  return { sql, params };
}

const q = new Query(Order).where("status", "=", "open").where("total", ">", 10000).limit(50);
// toSql("orders", q) -> SELECT * FROM orders WHERE order_status = $1 AND total_cents > $2 LIMIT $3, params ["open", 10000, 50]
```

## In the wild
<!--meta block=wild-->

- **JPA Criteria API** — Jakarta Persistence (JPA) builds a query as a CriteriaQuery object of roots, predicates and orderings from a CriteriaBuilder, and the provider translates it to SQL with bound parameters. Fields can be referenced through a generated static metamodel, so a rename is a compile error; this holds only when the metamodel is generated and used instead of string attribute names. {#wild-jpa-criteria}
- **Django QuerySet and Q** — A Django QuerySet is built up by chained filter and exclude calls and combined with Q objects using and, or and not; it holds the criteria as data and compiles them to SQL only when evaluated. {#wild-django-q}

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Enterprise Application Patterns](../../themes/enterprise-application-patterns.md) — Describe an open-ended search as an object that a repository turns into a query. {#fluency-enterprise-application-patterns}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Repository](./repository.md) — A repository can accept a query object so callers search without SQL
- [Data Mapper](./data-mapper.md) — The mapper alone knows the column names and turns criteria into SQL
- [Specification](./specification.md) — Criteria can be named rule objects that translate to a query

<!-- relationships:end -->
