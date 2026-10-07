---
title: Improper Instantiation
description: "Rebuilding a shareable, expensive client on every request"
area: hazards
owner: Oleksandr Derechei
tags: [performance, lifecycle, resource-management, throughput]
status: stable
aliases: [new client per request, per-request singleton misuse]
solves: [we run out of sockets under load on a server that is not busy, a new HTTP client is created for every request, the profiler says most of the time goes into constructors, errors about too many open files appear only in production, throughput plateaus and latency multiplies once concurrency rises]
---

# Improper Instantiation

An object designed to be created once and shared for the life of the process — a client that manages connections to something remote, or anything else expensive to build — is instead created and discarded on every request. The setup cost is paid over and over, and the resources it quietly holds are consumed faster than the system can release them.

## What it is
<!--meta block=description-->

Improper instantiation is creating a new copy of an object built to be created once and shared, usually a client for HTTP, a database, a queue or a cache. You recognise it when calls fail with socket or port exhaustion under load while CPU looks idle, and when each request pays a connection handshake. The defining trait is the lifetime: the object is expensive to build, so building it per request is the defect.

## Explained
<!--meta block=explain-->

Improper instantiation is building a new copy of something designed to be built once and shared. Client objects for HTTP, databases, queues and caches usually look small but hold open connections, negotiated sessions and a pool of both. Create one per request and every request pays to rebuild that state, then leaves sockets behind, because the operating system does not reclaim them the moment the object is dropped. Under load the process piles up sockets faster than the system frees them, and calls start failing with exhaustion errors while nothing looks busy. Exhaustion shows only under concurrency or sustained rate, since a test with one caller never runs out; the handshake cost shows at any load. Read the library's documentation to learn its intended lifetime, and for a shared client create it once at startup and keep it for the life of the process. Where the far side limits connections, share a capped pool rather than one instance.

- **Shared settings.** Every caller shares one object, so set its configuration once at startup.
- **Concurrency safety.** A shared object must be safe for concurrent use; check the library says so.

**Example.** A service calls a payment API at 500 requests a second and builds a new HTTP client for each call. Each client adds an 80 ms handshake, and its socket stays allocated for about 60 s after use. A machine has roughly 28,000 free ports, so 500 a second uses them up in 56 s, and then every call fails. One client created at startup, with a pool of 50 connections, keeps the count near 50 however many requests arrive. Both figures are typical defaults and vary by operating system and destination address.

## How it happens
<!--meta block=causes-->

- **Release early is applied to a client built to be kept.** Holding a resource no longer than needed is a good habit from file handles and database connections, but it is wrong for a shared client, whose whole design assumes it will be kept.
- **Cleanup syntax invites disposal.** A construct that closes the object at the end of the block reads as careful, so the object gets scoped to a request without anyone deciding that its lifetime should be a request.
- **The cost of construction is invisible in the source.** Creating the object is one line whether it allocates a struct or opens a connection and negotiates a session, and nothing in the call site distinguishes the two.
- **Sharing is avoided on thread-safety grounds.** A per-request instance is obviously safe, so people skip checking whether the type supports concurrent use. Shareable types document that they do.
- **Container lifetimes are configured by default.** Where a framework wires dependencies, the registration decides the lifetime, and a per-request default silently applies to a client that needed to be a singleton.
- **It never shows up before production.** One instance at a time behaves perfectly; the failure needs concurrency and sustained load, so it survives every functional test and appears first as an error rate at a traffic level nobody reproduced.
- **Client built inside the handler.** A client created in a function body rather than at startup scope is rebuilt on every invocation, which is common in serverless and per-request handlers.

## What it costs
<!--meta block=cost-->

- **Setup is paid per request instead of once.** Connection establishment, session negotiation and configuration parsing run on every call, so the per-request cost is dominated by preparation rather than by the work being asked for.
- **Scarce operating-system resources are exhausted.** Sockets and handles linger after their object is discarded, so a process creating them per request eventually cannot create any more and calls fail outright, on a machine that is not otherwise busy.
- **Throughput plateaus while latency climbs.** Where nothing runs out, each call still adds its construction time, 80 ms in the example, so requests per second flatten and response time climbs.
- **Garbage collection works harder.** Short-lived objects holding buffers and native handles churn through the heap, mainly in managed runtimes. Exhaustion appears before CPU does.
- **The far side pays for the churn too.** Each new connection costs the remote system a handshake, an authentication and a slot in its own limits, so a caller that reconnects per request can exhaust a shared dependency's capacity while sending very little traffic.

## Getting out
<!--meta block=mitigation-->

Match the lifetime to the object's design, which means reading its documentation rather than guessing from its shape. A client meant to be shared is created once at startup and used for the life of the process. That is the **[Singleton](../patterns/gof/creational/singleton.md)** lifetime, whether or not it is expressed with that pattern. A long-lived client also needs a connection lifetime or periodic recycle, or it pins old DNS results and dead endpoints after a failover. Where the object cannot be shared but is expensive to build, keep a bounded set alive and lend them out: an **[Object Pool](../patterns/gof/extra/object-pool.md)** spreads the construction cost across many uses, and its fixed size doubles as a cap on the scarce resource underneath.

Make lifetime a declared decision rather than a property of where the code happens to sit. **[Dependency Injection](../patterns/gof/extra/dependency-injection.md)** puts it in one registration a reviewer can read (singleton, pooled or per-request) instead of leaving it implicit in a constructor call buried in a handler. Get the registration wrong in the other direction and the failure is worse than a slow system: a per-request object promoted to a singleton keeps state across requests it was never meant to cross.

Sharing is only safe if the type says it is. Confirm the object is built for concurrent use, and treat its mutable configuration as immutable once it is shared — settings applied per call on an instance several requests are using is a [Race Condition](./race-condition.md) waiting for load. The fix is to configure at startup and hold separate instances where the settings genuinely differ. Not everything shareable should be held either: a resource that is scarce on the far side is better returned promptly than hoarded, so a scarce far-side resource gets a capped pool, and the pool size is that cap. Size the pool from peak concurrent calls and the far side's connection limit, then measure.

Verify with the resource, not with the code. Count live sockets or handles for the process under sustained concurrency: a healthy client's count is flat. Count open sockets per process on your platform and baseline them first; flat means no growth as request volume rises. A healthy count is roughly the size of its pool, and one that climbs with request volume tells you the lifetime is still wrong regardless of what the registration claims. Only concurrency reveals this defect, so it needs a load test rather than a functional one. A shared client makes the next hazard the one to watch, since every request now queues for the same bounded pool. See [Connection Pool Exhaustion](./connection-pool-exhaustion.md).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Mitigated by**

- [Singleton](../patterns/gof/creational/singleton.md) — A client designed to be shared is built once at startup and used for the life of the process
- [Object Pool](../patterns/gof/extra/object-pool.md) — Where the object cannot be shared, keep a bounded set alive and lend them out
- [Dependency Injection](../patterns/gof/extra/dependency-injection.md) — Make lifetime a declared registration a reviewer can read, not an accident of where the constructor sits

<!-- relationships:end -->
