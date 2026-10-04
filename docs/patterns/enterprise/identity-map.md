---
title: Identity Map
description: "One in-memory object per database row within a unit of work, found by key"
area: enterprise
owner: Oleksandr Derechei
tags: [persistence, data-access, state-management]
status: stable
aliases: [first-level cache, session cache, persistence context]
solves: ["I loaded the same row twice and my two objects disagree, so one edit overwrote the other on save", the same record is queried over and over inside one request, an object graph with parent and child pointing at each other loops forever when loaded, I changed a field on one object and the same record elsewhere in the request still shows the old value]
---

# Identity Map

Keep a map from each row's key to the one object already loaded for it, and check the map before every read, so a unit of work holds at most one in-memory object per database row.

## What it is
<!--meta block=description-->

Loading the same row twice gives two objects for one record. Edit the second copy and the first still shows the old value, and when both save, the later write overwrites the earlier. An identity map is a lookup table, kept for one request or session and keyed by type and primary key, that returns the object already loaded instead of building another.

## Explained
<!--meta block=explain-->

An identity map is a lookup table, kept for one unit of work such as a request, from a row's type and key to the single object already loaded for it. Every read by key checks the table first and loads from the database only on a miss. Choose it over loading a fresh object on every read when the same row can be reached by several routes in one request, such as from a list, a customer's history and a relation, because two copies of one row disagree and the later save wipes out the earlier. Its job is identity, not speed. It is thrown away with its unit of work, so unlike a cache shared across requests it never serves another user's stale data.

- **Stale for the unit.** A row changed by someone else is not seen again, so keep the unit short and reload on purpose.
- **Grows with every load.** A batch over a million rows holds a million objects, so clear the map or split the batch.
- **Not thread-safe.** Give each thread its own unit of work and its own map.

**Example.** A request loads order 42 for the page, then the pricing code loads order 42 again from a relation. Without the map the second load builds a second object. Pricing sets the total to 120 on its copy, the page's copy still says 100, and the save writes whichever was last, so one edit is lost. With the map the second read returns the first object, there is 1 query instead of 2, and both see 120. A nightly batch over 1,000,000 rows would hold 1,000,000 objects, so it clears the map every 1,000 rows. After a clear, a row loaded again becomes a new object, so objects from before the clear must not be reused.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a read avoid loading the same row twice? The mapper asks the map at 2 before the database, and only a miss at 3 goes on to load at 4 and register the result at 5, so every later read at 1 gets the same object."
flowchart LR
    Code["Business code"]
    subgraph UoW["One unit of work"]
        Repo["Repository"]
        Map[("Identity map")]
        Mapper["Data mapper"]
    end
    DB[("Database")]
    Code -->|"1 find order 42"| Repo
    Repo -->|"2 look up Order:42"| Map
    Map -->|"3 miss"| Mapper
    Mapper -->|"4 select row 42"| DB
    Mapper -->|"5 store object under key"| Map
    Map -->|"6 same object returned"| Code
```

```mermaid caption="Two lookups for one key in a unit of work: the second never reaches the database, and both callers hold the same object."
sequenceDiagram
    autonumber
    participant A as Caller A
    participant R as Repository
    participant M as Identity map
    participant D as Database
    A->>R: find Order 42
    R->>M: get Order:42
    M-->>R: miss
    R->>D: select row 42
    D-->>R: row
    R->>M: put Order:42 = obj
    R-->>A: obj
    Note over A,D: Caller B asks for the same row later
    R->>M: get Order:42
    M-->>R: obj (same instance)
```

The map is keyed by the type and the primary key, so `Order:42` and `Customer:42` stay apart. Every path that creates an object from a row, whether a direct lookup, a query result or a lazily loaded relation, must check the map before building a new one. A query by a non-key column still goes to the database, because the map cannot tell which keys match, but each returned row is looked up by its key in the map and replaced by the existing object if there is one.

## Variations
<!--meta block=variations-->

- **Per unit of work** — One map for each business transaction or request, thrown away when it ends. It is the common form, and the safe one: the map cannot serve one user's data to another, though a row stays stale for the whole unit.
- **One map per class** — Each class keeps its own map keyed by primary key, and the lookup picks the map by type. It is simple and typed, and a type hierarchy needs care so a subclass row and its base class use the same map.
- **One map for all types** — A single map keyed by type and id. It is easier to clear and to inspect, at the cost of a composite key and less specific types.
- **Weak references** — The map holds objects through weak references, so an object nobody uses can be collected. It stops a long unit of work from growing without bound, and it means identity is only guaranteed while something still refers to the object.
- **Explicit or implicit** — An explicit map is one the code calls itself. An implicit map lives inside the data mapper or the ORM (object-relational mapper), so the guarantee holds without any caller remembering to ask.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One object per row** — two references to the same record always see the same state, so one edit cannot hide behind another copy.
- **Fewer queries as a side effect** — a repeat read by key already in the map costs a hash lookup instead of a round trip; identity, not speed, is the purpose, and a query by a non-key column still goes to the database.
- **Cycles end** — a loaded order registers in the map before its customer loads, so the customer's link back finds the order, and a ring of related objects is built once and linked instead of recursing without end.
- **Cleaner change tracking** — a unit of work can track one object per row, so a commit writes each changed row once.

### Cons
<!--meta polarity=con-->

- **Stale for the length of the unit** — a row changed by someone else is not seen again, so keep the unit short or reload the object on purpose.
- **Memory grows with the unit** — every loaded object stays in the map, so a batch that touches a million rows holds a million objects; clear or break the batch into smaller units.
- **Not thread-safe by default** — sharing one map across threads needs locking; give each thread its own unit of work and its own map.
- **Easy to misread** — a reader who takes the map for a cache expects hits it never gives, because a query by a non-key column still hits the database; document what it covers.
- **Does not stop cross-unit lost updates** — two requests each hold their own object for one row, so the later commit still overwrites the earlier unless a version check guards the write.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The same row is reachable by several routes** — in one request an order is loaded from a list, a customer's history and a relation, and all three must be one object.
- **You edit objects and save later** — a [Unit of Work](./unit-of-work.md) needs one object per row to know what changed and to write it once.
- **The object graph has cycles** — parent and child point at each other, and loading must stop at the object already built.

### Avoid when
<!--meta polarity=avoid-->

- **The code only reads and discards** — a report that streams rows has no use for identity, so skip the map and its memory.
- **You want speed across requests** — use a real cache with expiry, such as an [In-Process Cache](../caching/in-process-cache.md), since the map is thrown away each unit.
- **Rows are immutable values** — a [Value Object](../ddd/value-object.md) has no identity to preserve, and copies are equal and harmless.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an identity map consulted by the repository, scoped to one unit of work"
class IdentityMap {
  private items = new Map<string, Promise<object>>();
  private key(type: string, id: number) { return `${type}:${id}`; }

  get<T>(type: string, id: number): Promise<T> | undefined {
    return this.items.get(this.key(type, id)) as Promise<T> | undefined;
  }
  put(type: string, id: number, load: Promise<object>) {
    this.items.set(this.key(type, id), load);
  }
  evict(type: string, id: number) { this.items.delete(this.key(type, id)); }
  clear() { this.items.clear(); }
}

class OrderRepository {
  constructor(private map: IdentityMap, private db: Db) {}

  find(id: number): Promise<Order> {
    const inFlight = this.map.get<Order>("Order", id);
    if (inFlight) return inFlight;                       // same promise, same instance, even for concurrent finds
    const load = this.db.selectOrder(id).then(row => new Order(row));   // build once
    this.map.put("Order", id, load);                     // register the in-flight load before awaiting
    load.catch(() => this.map.evict("Order", id));       // a failed load must not stay cached
    return load;
  }
}
// One IdentityMap per unit of work: create it at the start, drop it at the end; in a batch job call clear() every N rows.
```

## In the wild
<!--meta block=wild-->

- **Hibernate ORM** — The Session holds a persistence context that keeps one instance per entity type and id; loading the same id twice in a session returns the same object, and Session.clear() empties it. {#wild-hibernate}
- **SQLAlchemy** — Its Session keeps an identity map, so a query that returns a row already loaded in that session hands back the same object instead of building another. {#wild-sqlalchemy}
- **Entity Framework Core** — A DbContext tracks entities by key and returns the same instance for a key it already tracks, until the context is disposed or the tracker is cleared. {#wild-efcore}
- **Doctrine ORM** — Its UnitOfWork keeps an identity map of managed entities, so one row maps to one object within an EntityManager. {#wild-doctrine}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **unit-of-work scope** — how long one map lives, such as a request or a message. A longer scope saves more queries and keeps stale data and memory for longer.
- **batch size between clears** — how many rows a bulk job loads before it empties the map. A smaller batch bounds memory and costs more reloads.
- **weak versus strong references** — whether the map holds objects strongly or lets unused ones be collected. Weak references cap memory and weaken the identity guarantee.

### Signals to watch
<!--meta polarity=signal-->

- **objects in the map at commit** — should match the rows you meant to touch; far more means the unit is too wide.
- **queries per request** — a rise after a change can mean reads are bypassing the map.
- **memory of long-running jobs** — grows steadily if nothing clears the map.

### Failure modes under load
<!--meta polarity=failure-->

- **unbounded batch** — a job holds every row it has loaded, and memory climbs until the process runs out.
- **stale row overwrites** — a long unit serves a row another writer changed minutes ago, so a later save overwrites their change; guard the save with a version column checked at write, and keep the unit short.
- **map shared across threads** — a thread gets an object another thread is half-way through changing.

### Readiness checklist
<!--meta polarity=check-->

- create one map per unit of work and drop it when the unit ends
- route every read, including query results and lazy loads, through the map
- clear or split the unit in any job that loads more rows than memory holds; size each batch as the memory budget divided by the measured bytes per loaded object, and start low
- keep the map out of shared state, or lock it

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Enterprise Application Patterns](../../themes/enterprise-application-patterns.md) — Check a map by key before every load, so two reads of one row give one object. {#fluency-enterprise-application-patterns}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Unit of Work](./unit-of-work.md) — The unit of work needs one object per row to track changes.
- [Repository](./repository.md) — The repository checks the map before each load.
- [Data Mapper](./data-mapper.md) — The mapper builds objects only on a map miss.
- [Optimistic Concurrency Control](../distributed/coordination/optimistic-concurrency-control.md) — Version checks on write catch what the map's stale view missed.

**Alternative to**

- [In-Process Cache](../caching/in-process-cache.md) — The map gives identity within a unit of work; a cache gives speed across requests.

<!-- relationships:end -->
