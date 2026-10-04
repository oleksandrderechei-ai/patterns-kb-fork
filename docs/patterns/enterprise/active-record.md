---
title: Active Record
description: An object wraps a row and its own persistence
area: enterprise
owner: Oleksandr Derechei
tags: [persistence, data-access, readability]
status: stable
aliases: [AR]
solves: [I wrote three classes and a mapping file just to insert one row, "adding one column means editing the entity, the mapper, the interface and the test double", my data access layer is more code than the features it serves, this admin tool is just forms over tables and the architecture is fighting me, "I only want to load a row, change a field and save it back without ceremony"]
---

# Active Record

An object wraps a single database row, carrying both its fields and the logic to save, load, update, and delete that very row — no separate layer stands between the data and its persistence.

## What it is
<!--meta block=description-->

Keeping table rows and the code that saves them in two places means a schema change touches both. An Active Record wraps one database row in an object that owns the row's fields and the code that saves it, with instance methods like save and delete and finders like find. A migration then changes table and class together, which suits CRUD-heavy software, until a rule needs several rows.

## Explained
<!--meta block=explain-->

An Active Record is an object that wraps one database row and owns both the row's fields and the code that saves it. The class has instance methods such as save and delete and finders such as find that return objects already filled from a query. With one representation there is nothing to drift apart: a migration changes the table and the class together, and the query sits beside the rule that uses it. Choose it over a [data mapper](data-mapper.md), a separate layer that moves data between plain objects and tables, when a row is roughly one meaningful object and CRUD speed matters more than isolating storage, as in admin tools and young products. Skip it once most of the domain stops fitting one row.

- **Shaped by the table.** Renaming a column forces class changes, and a rule spanning tables has no home, so move it into a service.
- **Tests need a database.** Persistence is baked in, so keep rules in small methods that need no loading.
- **Logic drifts out.** A record of only getters turns anemic, so keep behaviour on the record.

**Example.** An orders table has 12 columns, and a migration adding a discount column makes order.discount exist at once, with no other file touched. That is the saving. Later the total needs the order lines from one table and a tax rate from another. The record has no row to hold that, so the team writes an OrderPricing service that reads the Order and calls its methods. Each test of the total now needs a database, about 40 ms a test. The cost is that the service starts to hold all the logic and the record shrinks to getters, so the team moves pure rules back onto the record.

## How it works
<!--meta block=structure-->

```mermaid caption="Who writes the SQL? The same class that carries the discount rule. Both arrows to the table start inside the boundary, which is why the caller never names a column — and why nothing on this page runs without a database."
flowchart LR
    App["Application code"]
    subgraph Rec["Order class — fields, behavior and SQL together"]
        Find["Order.find, the static finder"]
        Obj["order instance"]
    end
    DB[("orders table")]
    App -->|"1 Order.find(42)"| Find
    Find -->|"2 SELECT row 42"| DB
    DB -->|"3 row"| Find
    Find -->|"4 return instance"| Obj
    App -->|"5 applyDiscount(10)"| Obj
    App -->|"6 order.save()"| Obj
    Obj -->|"7 UPDATE row 42"| DB
```

## Variations
<!--meta block=variations-->

- **Framework-generated records** — Columns are introspected from the schema at load time (Rails' ActiveRecord, Laravel's Eloquent, Django's ORM (object-relational mapper)), so the class carries no explicit field list — a migration adds a column and every record picks it up.
- **Hand-written records** — Fields and SQL are written out by hand per class, common in smaller frameworks and pre-ORM codebases — more boilerplate, but no schema-introspection magic to fight.
- **Lifecycle callbacks** — Hooks such as `before_save` or `after_create` weave extra behavior — timestamps, validation, cache invalidation — directly into the persistence path.
- **Read-only / view-backed record** — Wraps a query result, report, or database view instead of a writable table, and simply omits `save` and `delete`.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Minimal ceremony for CRUD-shaped domains** — define fields, call save, and persistence is done.
- **Reads the way people think about it**: load a row, change it, save it back.
- **One class holds everything about a row**: its shape and how it persists — nothing else to open.
- **Framework tooling** (migrations, validations, associations) hooks straight into the base class.

### Cons
<!--meta polarity=con-->

- **Couples domain logic to the schema** — a column rename or table split forces a class change.
- **Hard to unit test in isolation**; persistence is baked in, so tests need a real or in-memory database.
- **Business logic and persistence logic share one class**, tending toward a [God object](../../hazards/god-object.md), or, if kept thin, toward an anemic one with logic pushed elsewhere.
- **Awkward once a row's data spans** more than one table or a non-trivial join — there's no natural home for it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The domain maps closely to the tables** — one row is roughly one meaningful object with modest behavior.
- **Fast, traceable CRUD** matters more than isolating persistence — small apps, admin tools, CRUD-heavy services.
- **You're already inside a framework** (Rails, Laravel, Django) that supplies Active Record as its default ORM.

### Avoid when
<!--meta polarity=avoid-->

- **The domain is rich** and doesn't map one-to-one onto tables — aggregates, joins, and value objects don't fit one row per class.
- **You need to swap or mock persistence** for testing without touching a real database — a [Data Mapper](./data-mapper.md) isolates that cleanly.
- **Multiple representations of the same data** (read models, caches, denormalized views) would fight over one class.

Keep behavior on the record, not just accessors — an Active Record that's only getters, setters, and persistence calls has already slid into the [Anemic Domain Model](../../hazards/anemic-domain-model.md) smell, with the real logic pushed into a service that manipulates it from outside.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal record"
class Order {
  id?: number;
  customerId: number;
  total: number;

  constructor(row: { id?: number; customerId: number; total: number }) {
    Object.assign(this, row);
  }

  static async find(id: number): Promise<Order> {
    const row = await db.queryOne("SELECT * FROM orders WHERE id = ?", [id]);
    return new Order(row);
  }

  async save(): Promise<void> {
    if (this.id === undefined) {
      this.id = await db.insert("orders", { ...this });
    } else {
      await db.update("orders", this.id, { total: this.total });
    }
  }

  applyDiscount(pct: number): void {
    this.total *= 1 - pct / 100; // domain logic lives on the record too
  }
}

const order = await Order.find(42);
order.applyDiscount(10);
await order.save(); // UPDATE orders SET total = ... WHERE id = 42
```

## In the wild
<!--meta block=wild-->

- **Rails ActiveRecord** — Introspects the schema so each model class gains its columns, finders and save method automatically; teams lean on includes to eager-load associations against N+1, and know that update_all-style bulk writes bypass validations and callbacks. {#wild-rails-activerecord}
- **Laravel Eloquent** — Each model wraps a table and carries its own save, delete and static query methods; with() eager-loads relationships to dodge N+1, and observers hang lifecycle behavior off the persistence path without bloating the model. {#wild-laravel-eloquent}
- **Django ORM** — Model classes declare fields and inherit save/delete, keeping row and persistence in one class; select_related and prefetch_related are the standard N+1 defenses, and bulk_create deliberately skips per-object save() and its signals. {#wild-django-orm}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **association loading** — lazy by default in most implementations; every association navigated inside a loop is a potential extra query, so the eager-load switch is the dial you touch most
- **callback discipline** — how much behavior rides on lifecycle hooks; every hook runs on every save — including imports, backfills and test fixtures that never asked for it
- **validation placement** — rules on the record are skipped by bulk writes and raw SQL; rules in the database are not — decide which layer is the actual gate
- **connection pool size** — records talk to the database directly, so the app tier owns the pool; slow work done while a record holds a connection starves everyone else

### Signals to watch
<!--meta polarity=signal-->

- **queries per request** — association access in a template loop is the classic N+1 source — the view fires queries and nothing in the code says so
- **save latency vs. raw statement latency** — a save that takes 200ms is often 10ms of SQL and 190ms of callback chain; the gap is your hook budget
- **connection pool utilisation** — external calls inside callbacks hold a connection hostage for their whole duration; pool exhaustion often traces back to one innocent after_save

### Failure modes under load
<!--meta polarity=failure-->

- **N+1 in the view layer** — templates navigate associations freely; each navigation is a query, and the page that rendered fine with 10 rows issues 500 queries with 500
- **callback cascade** — an after-save that saves another record that fires its own hooks — one write fans out into a chain nobody designed, and bulk operations replay it row by row
- **validation bypass** — framework bulk-write paths skip model validations and callbacks by design; the database accepts rows the model would have refused
- **racy uniqueness check** — a uniqueness rule enforced only on the model is a read-then-write; two concurrent saves both pass the check and both insert

### Readiness checklist
<!--meta polarity=check-->

- back every validation you rely on with a database constraint — model-level uniqueness alone races under concurrency
- keep side effects (email, HTTP calls) out of lifecycle callbacks; enqueue a job instead, or every save becomes a distributed transaction
- eager-load associations on any query whose results feed a loop
- know which bulk operations in your framework skip callbacks and validations, and treat them as raw SQL
- test against a real database — persistence is baked into the class, so a stub tests something else

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Enterprise Application Patterns](../../themes/enterprise-application-patterns.md) — Wrap one table row in an object that owns its own persistence. {#fluency-enterprise-application-patterns}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Transaction Script](./transaction-script.md) — Records are the data access a procedural script calls into

**Alternative to**

- [Data Mapper](./data-mapper.md) — Row owns its persistence vs. a separate mapper
- [Unit of Work](./unit-of-work.md) — Self-saving rows vs. a tracker that flushes all changes in one transaction

**Often confused with**

- [Entity](../ddd/entity.md) — One row that persists itself, not a domain identity

**Exposed to**

- [Anemic Domain Model](../../hazards/anemic-domain-model.md) — Can fall into anemic domain model when an active record is a row-shaped class with a setter per column, so rules drift out into services
- [Partial Object](../../hazards/partial-object.md) — Can fall into partial object when one wide entity class shared by every query is filled differently per finder
- [Primitive Obsession](../../hazards/primitive-obsession.md) — Can fall into primitive obsession when columns mapped straight to primitive fields leave domain concepts untyped

<!-- relationships:end -->
