---
title: Object Pool
description: Reuses a fixed set of expensive objects
area: gof-extra
owner: Oleksandr Derechei
tags: [low-level-design, resource-management, latency]
status: stable
aliases: [resource pool]
solves: [opening a fresh database connection on every request is dominating my response time, the database is rejecting me because my service opened too many connections at once, the TCP handshake and auth cost more than the query I actually wanted to run, garbage collection pauses keep spiking because I allocate a huge buffer per request, I have no ceiling on how much of a scarce external resource my service grabs]
---

# Object Pool

Keeps a fixed set of expensive-to-build objects alive and hands them out on loan — so callers borrow and return rather than allocate and discard.

## What it is
<!--meta block=description-->

An object pool keeps a set of already-built objects ready for reuse. A client acquires one, uses it and releases it, instead of building and discarding one each time. It pays off when construction is costly, such as a database connection, and the fixed size also caps use of a scarce resource.

## Explained
<!--meta block=explain-->

An object pool keeps a fixed set of already-built objects, such as database connections, and lends one out per use: a caller takes one, uses it and gives it back. You pay the setup cost once and not on every request, and the pool's size caps how many of a scarce resource are open at once. Choose it over creating objects on demand only when construction is measurably slow or the resource must be capped. For an object a modern runtime creates in nanoseconds, a pool is overhead and a new way to fail.

- **Dirty returns.** An object returned dirty leaks one caller's data to the next, so reset it on return.
- **Leaks.** An object never returned shrinks the pool until everyone waits, so return it in a finally block and set a borrow timeout.
- **Deadlock.** A task holding one object while waiting for another from the same pool can deadlock, so borrow one at a time.
- **Shared sizing.** Size the pool against the total across every service that shares the resource.

**Example.** A database allows 100 connections, and opening one takes 30 ms of handshake. A pool pays that 30 ms once per connection, not on every request. A service runs 10 copies and gives each a pool of 8: 80 connections, 20 spare. A request that fails and forgets to return its connection loses one per failure. After 8 failures in one copy, that copy has none, and each request there waits the 2 s borrow timeout and then errors, while the other 9 copies stay fine. A finally block that returns the connection ends the leak. Had you set 12 per copy, 10 x 12 = 120 would exceed the 100 the database allows.

## How it works
<!--meta block=structure-->

```mermaid caption="The lifecycle of a pooled object. It shuttles between idle and in-use, is scrubbed on the way back, and is only destroyed when it expires or the pool shrinks."
stateDiagram-v2
    [*] --> Idle
    Idle --> InUse: acquire
    InUse --> Idle: release, reset
    Idle --> Destroyed: expiry, eviction
    Destroyed --> [*]
    note right of Idle: sits in the free list, ready to lend
    note right of InUse: checked out by one client
```

## Variations
<!--meta block=variations-->

- **Fixed vs. elastic** — A fixed pool holds a constant number of objects; an elastic one grows toward a maximum under load and shrinks when idle. Fixed gives predictable resource use; elastic trades that for adaptability.
- **Blocking vs. fail-fast acquire** — When the pool is empty, acquire can block until an object is returned (usually with a timeout) or fail immediately so the caller can back off. Blocking smooths bursts; fail-fast surfaces exhaustion sooner.
- **Validation on borrow / return** — Test the object before handing it out — pinging a connection, checking a socket — so a client rarely gets a dead one; it can still die between the check and first use. Costs a round trip but avoids surfacing stale state as a mystery failure.
- **[Thread Pool](../../concurrency/thread-pool.md)** — The most common specialization: a pool whose objects are worker threads, fed a queue of tasks. Reuses the expensive thread rather than the result of its work.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Spreads the cost of expensive construction** across many uses instead of paying it every time.
- **Caps how many of a scarce resource** are in use at once, at a fixed ceiling.
- **Cuts constant allocate-and-discard churn** and the garbage-collection pressure it creates.
- **Keeps acquire wait near zero** while the pool holds an idle object; once it is exhausted, callers wait up to the acquire timeout.

### Cons
<!--meta polarity=con-->

- **Reused objects keep their old state** — forget to reset one and it leaks data between clients.
- **An object borrowed and never returned** is lost, and enough such leaks starve the whole pool; return it in a finally block, set a borrow timeout and log borrows held too long.
- **Adds real machinery to build and maintain**: sizing, validation, eviction, thread safety.
- **For cheap objects**, a modern allocator or garbage collector often beats a pool outright.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Building the object is genuinely expensive** — connections, threads, sockets, large buffers.
- **Each object is used briefly** but acquired again and again at high frequency.
- **You need a hard cap** on how many of a scarce resource are alive at once.

### Avoid when
<!--meta polarity=avoid-->

- **The objects are cheap to create** — pooling adds overhead and buys nothing.
- **Their state is large or awkward** to wipe clean before the object is reused.
- **Callers hold each object** for long or unpredictable spans: reuse is rare and a slow holder starves the pool.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a bounded generic pool with a borrow-and-return helper"
interface PoolOptions<T> {
  readonly create: () => T;   // build a fresh object (the expensive step)
  readonly reset: (obj: T) => void;  // wipe per-use state before reuse
  readonly max: number;       // hard ceiling on live objects
}

class ObjectPool<T> {
  private readonly idle: T[] = [];
  private live = 0;
  constructor(private readonly opts: PoolOptions<T>) {}

  // … cut: blocking wait with timeout, validate on borrow, eviction (destroy and live--), double-release guard.
  acquire(): T {
    const reused = this.idle.pop();
    if (reused !== undefined) return reused;
    if (this.live >= this.opts.max) throw new Error("pool exhausted");
    const obj = this.opts.create(); // a throwing build must not use up capacity
    this.live++;
    return obj;
  }

  release(obj: T): void {
    this.opts.reset(obj);
    this.idle.push(obj);
  }

  // Borrow, run, return even if work throws. Synchronous work only: a Promise would be released before it settles; for async, make use async and await work(obj) inside the try.
  use<R>(work: (obj: T) => R): R {
    const obj = this.acquire();
    try { return work(obj); } finally { this.release(obj); }
  }
}
```

## In the wild
<!--meta block=wild-->

- **HikariCP** — The default Java Database Connectivity (JDBC) connection pool in Spring Boot. Key knobs are maximumPoolSize (the ceiling), minimumIdle (warm floor), connectionTimeout (acquire wait), idleTimeout and maxLifetime (eviction). It exposes ActiveConnections, IdleConnections, and PendingConnections as metrics and can log leak warnings via leakDetectionThreshold. {#wild-hikaricp}
- **PgBouncer** — A lightweight connection pooler in front of PostgreSQL that multiplexes many client sessions onto a small set of real backend connections. Its pool_mode (session, transaction, or statement) controls how aggressively backends are shared; transaction mode returns a backend to the pool at each commit, letting far more clients share few server connections. {#wild-pgbouncer}
- **Apache Commons Pool** — A general-purpose object-pooling library (the engine behind DBCP) with borrow/return semantics via a PooledObjectFactory. It offers testOnBorrow/testOnReturn/testWhileIdle validation, maxTotal and maxIdle sizing, maxWait on borrow, and a background evictor governed by minEvictableIdleTime. {#wild-commons-pool}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Maximum pool size** — The hard ceiling on live objects (HikariCP maximumPoolSize, generic max). Doubles as the cap on the scarce downstream resource; the sum across all app instances must stay under the resource limit (e.g. the database max_connections). To find the number, watch peak active objects, the utilization signal, under realistic load and set the ceiling just above it, within this instance's share of the limit.
- **Acquire timeout** — How long acquire() blocks on an empty pool before failing (HikariCP connectionTimeout, Commons Pool maxWait). Bounds exhaustion into a fast error instead of an indefinite hang.
- **Validation on borrow / return** — Test an object before lending it (Commons Pool testOnBorrow / testOnReturn, HikariCP connection validation / keepaliveTime) so a dead connection or socket is discarded rather than handed to a client.
- **Idle eviction and max lifetime** — When to retire objects (HikariCP idleTimeout and maxLifetime, Commons Pool minEvictableIdleTime). Recycling long-lived objects avoids servers dropping connections the pool still believes are good.
- **Minimum idle / warm size** — A floor of pre-created objects kept ready (HikariCP minimumIdle) so a burst after idle does not pay full construction cost on the first requests.
- **Leak detection threshold** — How long a borrow may be held before the pool logs a leak warning (HikariCP leakDetectionThreshold). Set it above your slowest legitimate hold; it logs the leak and does not reclaim the object.

### Signals to watch
<!--meta polarity=signal-->

- **Pool utilization** — Active versus idle versus total objects (HikariCP exposes ActiveConnections, IdleConnections, TotalConnections). Sustained near-100% active means the pool is the bottleneck.
- **Callers awaiting acquire** — Callers blocked waiting for a free object, i.e. the pool queue depth (HikariCP PendingConnections). A rising value precedes acquire timeouts.
- **Acquire wait time** — Time from acquire() to receiving an object. Near zero when warm; climbing wait time is the early sign of contention before exhaustion.
- **Acquire timeout / failure rate** — Count of acquires that hit the timeout without getting an object — the direct symptom of exhaustion or a leak.

### Failure modes under load
<!--meta polarity=failure-->

- **Pool exhaustion** — Every object is borrowed; new callers block until the acquire timeout and then fail. Often a downstream slowdown holding objects longer, not more traffic.
- **Object / connection leak** — A borrowed object is never returned (missing release in an error path). The available count decays toward zero and the pool eventually serves no one. To tell it from exhaustion under a slow downstream, check active objects after traffic drops: a leak stays at the ceiling, a slowdown drains once the downstream recovers.
- **Stale object handed out** — With validation off, an object the far end has already closed (idle-killed connection, half-open socket) is lent out and fails on first use as a mystery error.
- **State bleed between clients** — Per-use state is not reset on release — an uncommitted transaction, a set session variable, or leftover buffer contents — so the next borrower inherits it.

### Readiness checklist
<!--meta polarity=check-->

- Maximum pool size is sized against the downstream limit, counting every app instance that shares it
- Acquire has a bounded timeout so exhaustion fails fast instead of hanging
- Objects are validated on borrow or bounded by a max lifetime so dead ones rarely reach callers; one can still die between the check and first use
- Per-use state is reset on release and borrow/return is balanced, with leak detection enabled
- Idle and max-lifetime eviction are configured to match how long the far end keeps objects alive

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Performance](../../../themes/performance.md) — Reuse expensive objects to cut allocation cost. {#fluency-performance}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Has variant**

- [Thread Pool](../../concurrency/thread-pool.md) — A thread pool is an object pool of workers

**Often confused with**

- [Flyweight](../structural/flyweight.md) — Share immutable state vs. reuse whole objects

**Prevents**

- [Improper Instantiation](../../../hazards/improper-instantiation.md) — Spreads construction cost across many uses, and caps the scarce resource underneath
- [Resource Leak](../../../hazards/resource-leak.md) — Centralises acquire and release so a missed return is bounded and detectable; the leaked object is still lost

**Exposed to**

- [Connection-Pool Exhaustion](../../../hazards/connection-pool-exhaustion.md) — Can fall into connection pool exhaustion when a fixed pool whose borrowers slow down runs dry while traffic stays flat

**Demonstrated by**

- [Distributed Cache](../../../designs/design-distributed-cache.md) — shows connection pooling removing handshake cost from the p95/p99 latency tail
- [Distributed Rate Limiter](../../../designs/distributed-rate-limiter.md) — a pool of live connections amortises setup cost across a million checks a second inside the latency budget
- [LeetCode](../../../designs/leetcode.md) — a pool of pre-warmed runtimes amortizes expensive container startup over many gradings

<!-- relationships:end -->
