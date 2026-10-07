---
title: Resource Leak
description: "A resource acquired but never released, shrinking capacity until everything blocks"
area: hazards
owner: Oleksandr Derechei
tags: [concurrency, resource-management, lifecycle, error-handling]
status: stable
aliases: [connection leak, pool exhaustion, handle leak]
solves: [memory keeps growing until we restart the process, we restart the service every night to keep it healthy, open file handles and connections climb and never come back down, available capacity shrinks over days until everything blocks]
---

# Resource Leak

A pooled resource or permit — a database connection, a file handle, a semaphore permit, a lock — is acquired but never handed back, usually because an error slips past the release. Each leak permanently subtracts from a finite pool, so capacity quietly shrinks until every caller blocks forever, waiting on a resource that will never return.

## What it is
<!--meta block=description-->

A resource leak is a limited resource, such as a database connection, file handle, permit or lock, that is acquired and never released. The usual cause is a release skipped by an exception or early return. You recognise it when available resources fall one at a time with no crash and no stack trace, until callers hang. It differs from plain exhaustion because stopping traffic does not bring the resources back.

## Explained
<!--meta block=explain-->

A resource leak is a limited, shared resource, such as a database connection, a file handle, a lock or a permit, that is taken and never given back. The cause is almost always a missing release on the error path: an exception or early return skips the release call and the resource is orphaned. Nothing crashes and no error appears, so each leak quietly shrinks the pool until the last one is gone and every caller waits forever. From outside it looks like pool exhaustion, but exhaustion recovers when you stop traffic and a leak does not. Choose a structural fix over a convention every author must remember. Bind the release to the scope with a finally block, a with or using block, or a defer statement, so the error path frees the resource as surely as the normal path. Add a timeout on acquiring, so a caller that cannot get a resource fails fast. An [object pool](../patterns/gof/extra/object-pool.md) or [semaphore](../patterns/concurrency/semaphore.md) can then add backstops.

- **Early reclaim.** A hold limit takes back a slow but legitimate borrower too soon; set it above your worst honest use.
- **Ownership handoff.** Scope-bound release breaks when a resource moves to another thread, so pass ownership explicitly.

**Example.** A service has a pool of 10 database connections and takes 20 requests a second. One in a hundred requests hits an error path that skips the release, so 20 x 0.01 = 0.2 connections leak a second. The pool is empty after 10 / 0.2 = 50 s, and every request then hangs while the processor idles. Wrapping each use in a with block returns the connection on every path. A 2 s acquire timeout turns any future leak into a loud error after 2 s, not a silent hang.

## How it happens
<!--meta block=causes-->

```mermaid caption="Each failure orphans one connection, so capacity erodes silently until the pool hits zero — hours later and far from the line that skipped the release."
flowchart TB
    A["Request acquires a pooled connection"] -->|"the work throws, or returns early"| B["Control jumps past the release call"]
    B -->|"nothing binds the release to the scope"| C["Connection orphaned — one fewer in the pool"]
    C -->|"once more per failed request"| D["Available count only ever falls"]
    D -->|"the last connection leaks"| E["Pool empty"]
    E -->|"acquire waits for a return that never comes"| F["Every caller hangs, with no exception raised"]
```

- **No guaranteed release on the error path.** The acquire and the release sit in separate statements, so an exception or early return between them skips the hand-back and orphans the resource.
- **A slow operation holding the resource too long.** No bug is required, and this is exhaustion rather than a leak: a stalled query or a hung downstream keeps a connection checked out for seconds instead of milliseconds, so the pool drains under load and recovers when the stall ends. It looks like a leak from outside.
- **Unbounded, on-demand acquisition makes it worse.** With no cap, the code opens new connections or handles that are never freed, instead of blocking when the pool is empty, and exhausts the database's or OS's own limits.
- **Confused ownership.** A resource passed across threads or call boundaries, where it is unclear who is responsible for releasing it, gets released by nobody — or, just as damaging, released twice.

## What it costs
<!--meta block=cost-->

- **The pool exhausts and every caller blocks forever.** Once the last resource has leaked, an acquire that blocks until one is free will block indefinitely — because none ever will be. Callers pile up behind a queue that never advances, and the service stops responding entirely.
- **No errors anywhere, which is what makes it hard to spot.** With no acquire timeout, monitoring usually shows zero exceptions and the database is nearly idle, because almost nothing reaches it, yet users see only timeouts.
- **Request threads are consumed too.** Each blocked caller holds the worker thread it is running on, so the web tier's own [thread pool](../patterns/concurrency/thread-pool.md) fills with parked threads waiting on the drained resource pool — and the server stops accepting new work, spreading the stall outward from the leaked resource.
- **The leak is cumulative and delayed.** One orphaned resource per error is invisible; capacity erodes until load drives it to zero and the service fails all at once, far from the line that skipped the release.
- **Double release corrupts the pool.** A second release can hand one resource to two callers or inflate the permit count.

## Getting out
<!--meta block=mitigation-->

Bind the release to the scope so the error path frees the resource as surely as the normal path. A `finally` block, a `with`/`using` context manager, RAII or a `defer` keeps the acquire and its release together, so no exception or early return can slip between them. This closes the most common path. It does not cover a resource handed to another thread, so pass ownership explicitly.

Then bound the wait. Add an acquisition timeout so a caller that cannot get a resource fails fast with a clear error or a 503 instead of blocking forever. This turns a silent hang into loud failures you can alert on; it does not return the leaked resources. Add a hold limit that reclaims a borrow held past your worst honest use, and log the acquirer's stack trace when it fires, so the leaking code can be found. Validate pooled resources before handing them out, discarding dead ones. Bound acquisition and watch pool utilization: an in-use count that only climbs and never falls back is the signature of a leak, visible long before the pool hits zero.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Mitigated by**

- [Thread Pool](../patterns/concurrency/thread-pool.md) — Bounded, reused, lifecycle-managed workers instead of leak-prone ad-hoc threads
- [Object Pool](../patterns/gof/extra/object-pool.md) — Centralised checkout and return plus leak detection bound and surface a missed release; an object never returned is still lost
- [Semaphore](../patterns/concurrency/semaphore.md) — Acquire-with-timeout and a guaranteed release keep permits from draining away
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — A caller that cannot get a resource fails fast instead of blocking forever.

**Threatens**

- [Lease](../patterns/distributed/coordination/lease.md) — A holder that never releases keeps the grant until the lease expires
- [Big Compute](../patterns/architecture/big-compute.md) — Burst pools are the case where a leak costs most.
- [Iterator](../patterns/gof/behavioral/iterator.md) — An abandoned lazy iterator keeps its handle open until it is closed.

<!-- relationships:end -->
