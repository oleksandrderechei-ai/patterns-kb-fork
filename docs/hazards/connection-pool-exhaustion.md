---
title: Connection-Pool Exhaustion
description: "Every pool slot is held by a slow call, so requests hang instead of failing"
area: hazards
owner: Oleksandr Derechei
tags: [resilience, resource-management, availability]
status: stable
aliases: [pool exhaustion]
solves: [requests hang waiting for a database connection instead of failing, the database looks idle but our app times out on every query, one slow query made every unrelated endpoint slow too, we ran out of pool slots long before the database ran out of capacity]
---

# Connection-Pool Exhaustion

A downstream dependency slows down, so every borrowed connection is held longer, until every slot in the pool is occupied and new requests queue for a connection instead of failing — and a service that is merely slow underneath becomes a service that answers nothing at all.

## What it is
<!--meta block=description-->

Connection-pool exhaustion is the state where every connection in a pool is checked out, so the next caller waits for one to come back. You recognize it when requests hang rather than fail: CPU is low, nothing logs an error, and threads are parked on the same acquire call. The defining trait separating it from a resource leak is that stopping traffic lets the pool recover, unless nested acquisition has deadlocked it.

## Explained
<!--meta block=explain-->

Connection-pool exhaustion is the state where every connection in a shared pool is checked out, so the next caller must wait for one to come back. A pool exists because opening a connection is slow, so you keep a fixed set and lend them out. The number you need is arrival rate times how long each borrower holds one, so a downstream service that merely gets slower can empty the pool while traffic stays flat. With no limit on the wait, the line in front of the pool grows silently and nothing logs an error. Do not just enlarge the pool, because that hands the same queue to the database and slows every other client. Put a timeout on acquiring a connection, so the hang becomes a fast error your alerts can see. Hold each connection for as short a time as possible, never across an outside call. Give each workload its own pool ([bulkhead](../patterns/distributed/resilience/bulkhead.md)) so a slow report cannot starve logins, and alert on waiters.

- **Visible failures.** A timeout turns silent hangs into errors, so some requests fail during a slowdown. Pair it with a circuit breaker.
- **Split capacity.** Separate pools each need their own sizing, and idle slots in one cannot help another.

**Example.** A service has a pool of 20 connections and takes 100 requests a second, each holding one for 100 ms, so 10 are busy. The database slows and each hold becomes 400 ms. The pool now serves 20 / 0.4 = 50 requests a second, and 50 a second join the line. After 10 s, 500 callers are waiting and each waits 10 s, with no error logged. With a 500 ms acquire timeout the line holds at about 25 and the other 50 a second get a fast error. The cost is that half of the requests fail visibly during the slowdown.

## How it happens
<!--meta block=causes-->

Nothing has to break: traffic stays flat and a slower downstream makes each request hold its connection longer.

Concurrency equals arrival rate times holding time, and with no acquire timeout the queue is unbounded, so overload becomes latency rather than errors.

Treat the pool as admission control, not a buffer: its size is the most concurrency you have decided to send downstream, and the causes below are how that decision goes unmade.

```mermaid caption="Slow, not broken: an unbounded wait for a slot turns one sluggish dependency into a service that answers nothing."
flowchart LR
    D["Downstream query slows"] -->|"each call holds its slot longer"| H["Checked-out connections rise to the cap"]
    H -->|"no slot free"| W["New requests queue for the pool"]
    W -->|"no acquire timeout"| Q["Threads park; requests hang instead of erroring"]
```

- Downstream latency rising: at the same traffic, a query that takes ten times longer needs ten times the slots, so a slow dependency exhausts the pool without any change in load.
- No timeout on acquiring a connection: the caller waits indefinitely for a slot, which is what converts overload into a hang instead of a fast, visible error.
- No statement or transaction timeout: a query blocked on a lock or a table scan holds its connection until the database decides to end it, and until then the slot is gone.
- Holding a slot across work that does not need it, such as an external API call, a file write or user think-time inside a transaction, which multiplies holding time.
- Nested acquisition: a request holding one connection asks for a second, so with enough concurrent requests every slot is held by someone waiting for a slot and the pool deadlocks.
- A size chosen by default rather than by measurement, with no relation to how many workers can be in flight or how much concurrency the database can actually serve.
- Per-instance pools multiplied by replica count can exceed the database's session limit, and scaling out under load deepens the squeeze.
- Retries on timeouts add arrivals just as holders slow, so a fast error can feed the queue it was meant to shorten.

## What it costs
<!--meta block=cost-->

- **Requests hang instead of failing.** No error is returned, so no error-rate breaker trips, no retry budget is spent and no alert on error rate fires. The failure stays invisible to the mechanisms built to catch errors.
- **The stall propagates upstream.** Callers waiting on your unanswered response hold their own threads and connections, so one slow query can occupy resources several services away from it.
- **The outage is total, not proportional.** Endpoints that never touch the slow query fail as well, because they draw from the same pool. A report page can take down the login path.
- **Health checks report the wrong thing.** A check that does not use the pool says the instance is fine while it serves nothing; a check that does use it fails, and the instance is evicted just as its peers are getting the redistributed load.
- **Diagnosis is slow at the worst time.** CPU, memory and error rate all look healthy, so the answer only appears in pool metrics or a thread dump — evidence a team without pool metrics first collects during the incident.

Sizing is where this gets expensive, because the intuitive fix is the wrong one. Every connection is memory and a session on the database, which is the scarcer, shared resource, so enlarging the pool to stop the waiting hands the same queue to the server where it slows every other client too — past a point, more concurrency buys less throughput, since the work spends its time contending rather than executing.

## Getting out
<!--meta block=mitigation-->

Put a bound on every wait (acquire, statement and request), so an invisible hang becomes a fast error that your alerts, your breakers and your callers can act on. Choose the acquire timeout deliberately: it is how long you are willing to let a caller queue before you would rather refuse them. Set it from the request deadline so it fires before the caller's own timeout.

Then hold each slot for as little time as possible. Take the connection inside the unit of work and give it back immediately after, never across an external call, a file write or anything waiting on a person. Split the pool by workload so a slow analytical query cannot consume the slots the login path needs, and fix the double-borrow: a request that holds one connection while asking for another will [deadlock](./deadlock.md) the pool under enough concurrency.

Size it from the downstream's real concurrency limit, not from your request rate, and confirm it with a load test that pushes latency up rather than traffic. Find that limit by load-testing the database while raising concurrency until throughput stops rising, then divide it across all instances. Alert on the two numbers that move first — waiters on the pool and time spent waiting for a slot — because both usually rise before request latency or error rate does. When a dependency is slow rather than broken, a breaker in front of it releases the slots your service is spending on calls that will not finish in time. And if pool utilization does not fall back after traffic stops, stop tuning the size: what you have is a leak, not exhaustion: wait for the pool to drain, then follow [resource leak](./resource-leak.md).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Chatty I/O](./chatty-io.md) — A chatty caller holds slots far longer than its work needs, so call count alone can exhaust the pool.
- [Cascading Failure](./cascading-failure.md) — A pool starved on one path can spread to every service sharing it, turning one stalled caller into a cascade.
- [Noisy Neighbour](./noisy-neighbour.md) — Connection pool exhaustion is what a noisy neighbour looks like when the shared resource is a connection pool.

**Often confused with**

- [Deadlock](./deadlock.md) — Nested checkouts can deadlock a pool; plain exhaustion needs no cycle, only holders slower than demand
- [Resource Leak](./resource-leak.md) — A leak stays full after traffic stops; exhaustion recovers once slow holders return their slots.

**Mitigated by**

- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — Acquire and statement timeouts turn a hang into a visible error
- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — Per-workload pools stop one slow query starving every path
- [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) — Releases slots spent on calls that cannot finish in time

**Threatens**

- [Object Pool](../patterns/gof/extra/object-pool.md) — A fixed pool whose borrowers slow down runs dry while traffic stays flat
- [Thread Pool](../patterns/concurrency/thread-pool.md) — A bounded pool with an unbounded wait hangs requests silently
- [Semaphore](../patterns/concurrency/semaphore.md) — A counted permit with no acquire timeout parks callers behind slow holders
- [Gopuff](../designs/gopuff.md) — A design where surge-scaled service instances all open pools against one regional leader.

<!-- relationships:end -->
