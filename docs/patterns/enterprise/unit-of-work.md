---
title: Unit of Work
description: "Tracks changes, commits them as one transaction"
area: enterprise
owner: Oleksandr Derechei
tags: [transactions, batching, data-access]
status: stable
aliases: [UoW]
solves: [a crash halfway through left my database half-updated, saving one order fires off forty separate little UPDATE statements, my inserts blow up because the child row gets written before the parent, I need these five changes to either all land or none of them, every setter in my business logic is followed by another save() call]
---

# Unit of Work

Keeps a running list of every object you create, change, or delete during a business transaction, then flushes them to the store in a single ordered, all-or-nothing commit.

## What it is
<!--meta block=description-->

When each object saves itself the moment it changes, you get a swarm of small round trips, no say over write order, and a half-updated store if a failure strikes midway. A unit of work records the objects changed during one business transaction, new, changed or removed, and writes them together in one database transaction at commit.

## Explained
<!--meta block=explain-->

A unit of work records the objects you change during one business transaction, which are new, changed or removed, and writes them all together when you say commit. Nothing reaches the database before that. At commit it opens one database transaction, orders the writes so inserts run parent before child and deletes run child before parent, sends them in batches when batching is enabled, and commits or rolls back the whole set. One business action becomes one transaction, with few round trips. It usually runs beside an [identity map](identity-map.md), and flush is the natural place for optimistic-locking version checks. Choose it over letting each object save itself when one action touches several objects that must succeed or fail together. For an action that changes a single row, a direct save is simpler.

- **Holds state.** Give each request its own and dispose of it.
- **Late writes.** Code expecting an immediate save is surprised, so flush before any query that must see the changes.
- **Change tracking errors.** Snapshot comparison can miss or over-report changes, so test the commit against a real database.
- **Failed commit.** Objects keep their unsaved changes after a rollback, so discard the unit of work and reload instead of retrying on it.

**Example.** A transfer changes 2 accounts, adds 1 audit row and 2 ledger lines: 5 writes. Saved one by one, that is 5 round trips, and a crash after the third write leaves money gone from one account with nothing recorded. With a unit of work all 5 go in one transaction, and a crash leaves the database as it was. At an assumed 2 ms a round trip, one by one is 10 ms and one batch is a few ms. The cost shows when code queries the ledger before commit and finds nothing, since the lines are not written yet. Flush before that query.

## How it works
<!--meta block=structure-->

```mermaid caption="When does anything actually reach the database? Not while the use case is mutating objects — steps 1 and 2 only record what changed, and step 3 sends the whole set inside one transaction that commits or rolls back together."
flowchart LR
    Svc["Place-order use case"]
    UoW["Unit of Work"]
    Sets["new · dirty · removed"]
    subgraph Tx["One database transaction"]
        Mapper["Data mapper"]
        DB[("orders + order_lines")]
    end
    Svc -->|"1 mutate domain objects"| UoW
    UoW -->|"2 record each change"| Sets
    Svc -->|"3 commit"| UoW
    UoW -->|"4 ordered inserts, updates, deletes"| Mapper
    Mapper -->|"5 one batched flush"| DB
```

## Variations
<!--meta block=variations-->

- **Caller registration** — The caller explicitly tells the unit of work when something changed — `registerDirty(order)`. Simple and explicit, but easy to forget a call and lose a write.
- **Object registration** — Each object notifies its own unit of work from inside its setters, so callers can't forget. Couples the domain object to the unit of work.
- **Snapshot / dirty checking** — The unit of work keeps a snapshot taken at load time and, on commit, compares each object to it to find what changed. Hibernate and EF Core work this way. The caller sees nothing, and the tracking is hard to implement. Use it when an ORM is in play, since a missed registration cannot lose a write.
- **Session-per-request scope** — One unit of work is opened per web request or message and disposed at its end. The alternative is one scoped to a single use case.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One transactional boundary** — the whole business transaction commits or rolls back atomically.
- **Fewer round trips** — writes are collected and sent together at commit, and can be batched.
- **Controls write order** so inserts and deletes respect foreign-key constraints.
- **Decouples domain logic from persistence timing** — business code just mutates objects.
- **A single place to apply optimistic-locking** and concurrency checks.

### Cons
<!--meta polarity=con-->

- **Adds a stateful coordinator** you must scope correctly and dispose reliably.
- **A long-lived unit of work** accumulates memory and can serve stale objects.
- **Dirty tracking via snapshots or proxies is fiddly** — it can miss or over-report changes.
- **Hides when writes actually happen**, which surprises anyone expecting an immediate save.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A single business transaction touches several** objects or tables and must commit as one.
- **You want to collapse chatty per-object saves** into one batched commit.
- **You already lean on a [Repository](./repository.md) or object-relational mapper (ORM)** and need one place that decides where a transaction starts and ends.

### Avoid when
<!--meta polarity=avoid-->

- **The operation changes a single row** — a direct save is simpler and clearer. Save it through the repository directly.
- **Writes must be visible immediately and independently**, each durable before the next step, as with append-only event logging or an audit trail. Write each event on its own; there is no change set to commit.
- **You're in a stateless, per-message style**, handling each message on its own with no state kept between messages, so there is no change set to collect. Handle each message with a plain write.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal unit of work"
type Entity = { id: string; version: number };

class UnitOfWork {
  private newObjects = new Set<Entity>();
  private dirty = new Set<Entity>();
  private removed = new Set<Entity>();

  registerNew(e: Entity) { this.newObjects.add(e); }
  registerDirty(e: Entity) { if (!this.newObjects.has(e)) this.dirty.add(e); }
  registerRemoved(e: Entity) { this.newObjects.delete(e); this.dirty.delete(e); this.removed.add(e); }

  // Orders by operation only; real units also sort by foreign-key dependency and batch statements.
  // Add flush(db) to run pending writes before a query. On failure, discard this unit and retry in a new one.
  async commit(db: Db) {
    await db.transaction(async (tx) => {
      for (const e of this.newObjects) await tx.insert(e);
      for (const e of this.dirty)      await tx.update(e);
      for (const e of this.removed)    await tx.delete(e);
    });
    this.clear(); // one atomic transaction, then reset
  }

  private clear() {
    this.newObjects.clear();
    this.dirty.clear();
    this.removed.clear();
  }
}
```

## In the wild
<!--meta block=wild-->

- **Hibernate Session** — Its first-level cache tracks loaded entities and dirty-checks them on flush, orders statements by action type, and by entity dependency when hibernate.order_inserts and hibernate.order_updates are enabled, and can batch statements via hibernate.jdbc.batch_size; flush timing is governed by the FlushMode. {#wild-hibernate-session}
- **EF Core DbContext** — Its change tracker records each entity as Added, Modified, or Deleted; SaveChanges wraps them in one transaction and batches multiple statements per round trip up to MaxBatchSize. {#wild-ef-core-dbcontext}
- **SQLAlchemy Session** — Accumulates pending object changes and, on flush or commit, emits INSERT, UPDATE, and DELETE in dependency order; the Session also serves as the identity map so one row maps to one object within it. {#wild-sqlalchemy-session}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Flush timing / mode** — Whether pending changes flush automatically (before queries, at commit) or only on an explicit call. Auto-flush saves you remembering to flush, but hides when writes happen.
- **Write batch size** — How many INSERT/UPDATE/DELETE statements are sent per round trip on commit (for example hibernate.jdbc.batch_size); larger batches cut round trips. Raise the size until round trips stop falling, and stop where commit duration or memory rises.
- **Unit-of-work scope** — The lifespan of one unit of work — per request, per message, or per use case; wider scope tracks more objects and holds them longer.
- **Commit isolation level** — The isolation the single commit transaction runs at, trading anomaly protection against contention.

### Signals to watch
<!--meta polarity=signal-->

- **Tracked entity count** — Number of objects the unit of work is tracking; dirty-checking cost and memory grow with it.
- **Statements per commit** — How many statements one flush emits. Thousands of un-batched statements are a round-trip storm. There is no universal threshold: baseline statements per commit in a normal request and alert on a multiple. Read it from ORM statistics or the SQL log.
- **Commit transaction duration** — How long the single commit transaction runs; long commits hold locks and connections.
- **Optimistic-lock conflict rate** — How often a version check fails at flush, forcing the use case to retry.

### Failure modes under load
<!--meta polarity=failure-->

- **Long-lived unit of work bloats** — A unit of work kept open too long tracks ever more entities, so memory grows.
- **Dirty-check cost scales with tracked set** — Snapshot diffing is linear in tracked objects; loading tens of thousands into one context makes each flush slow, so measure flush time as the tracked count grows.
- **Optimistic-lock conflict under concurrency** — Two units of work mutate the same row; the second fails its version check at commit and must be retried.
- **Lost write from a missed registration** — In the caller-registration variant, forgetting a registerDirty leaves a mutation out of the commit, and it silently never persists. Detect it with a reload-and-compare test after commit; snapshot checking removes the risk.

### Readiness checklist
<!--meta polarity=check-->

- Scope the unit of work to one request or use case and dispose it reliably at the end.
- Keep the tracked set bounded — do not load tens of thousands of entities into one unit of work for a bulk job.
- Enable statement batching for bulk writes.
- Handle optimistic-lock conflicts by discarding the unit, reloading in a new one and retrying a small bounded number of times, then surface the conflict.
- Pair it with an identity map so one row maps to exactly one tracked object.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Enterprise Application Patterns](../../themes/enterprise-application-patterns.md) — Record changes during a business transaction and write them out together. {#fluency-enterprise-application-patterns}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Repository](./repository.md) — The repo reads; the unit of work commits the changes
- [Optimistic Concurrency Control](../distributed/coordination/optimistic-concurrency-control.md) — Version checks ride along with the flush, in the same transaction
- [Data Mapper](./data-mapper.md) — It flushes tracked changes through the mappers that own the SQL
- [Identity Map](./identity-map.md) — The identity map is what lets the unit write each changed row once.
- [Service Layer](./service-layer.md) — A service layer decides where one unit of work starts and ends

**Alternative to**

- [Active Record](./active-record.md) — Changes collected and written together vs. each row saving itself the moment it changes

**Prevents**

- [Chatty I/O](../../hazards/chatty-io.md) — Batches the writes of one business action into one transaction instead of one round trip per object

<!-- relationships:end -->
