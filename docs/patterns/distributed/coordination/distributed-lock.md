---
title: Distributed Lock
description: Hold exclusivity as a lease with a time to live (TTL) that any server can see
area: distributed-coordination
owner: Oleksandr Derechei
tags: [coordination, isolation]
status: stable
aliases: [lease lock, Redlock]
solves: [I need one server at a time to hold a shared resource while the others wait their turn, a resource is held across many requests or minutes and a DB transaction cannot span that, two workers both believe they own the same task, the mutex that guarded this code did nothing once we ran a second copy of the service, a process died holding a claim and everyone else is stuck behind it until someone clears it by hand]
---

# Distributed Lock

Represent a lock as a lease — who holds it and when it expires — stored where every server can read it, so mutual exclusion can span many machines and outlive any single database transaction.

## What it is
<!--meta block=description-->

A distributed lock lets only one process in a whole fleet run a critical section at a time. It keeps a small record of who holds the lock and until when, in a store every server can read, and the record expires if the holder crashes. It is not airtight: a stalled holder can lose the lock and a second one gets in, so back it with a fencing token.

## Explained
<!--meta block=explain-->

A distributed lock is a small record in a store every server can reach, saying who holds the lock and until when, so only one server in a fleet runs a critical job at a time. A server takes it with a create-only-if-absent write, deletes it when done, and the record expires after a set time, so a holder that crashes does not block everyone forever. Choose it over a database row lock or a [conditional write](conditional-write.md) when exclusivity must span many stateless servers and outlive a single transaction, such as a run-once job or a multi-minute seat hold.

- **Not airtight.** A stalled holder loses the lock unaware. Give each grant a rising [fencing token](fencing-token.md) and reject older ones at the resource.
- **Expiry is a guess.** Too short risks double grants, too long blocks everyone after a crash. Exceed your longest pause, and still fence.
- **Stampede on release.** Waiting servers all retry at once. Retry with random delays.
- **New failure point.** The lock store can fail. Alert on locks that expired while held.

**Example.** A nightly report job runs on 12 servers, and the lock expires after 30 s. Server A takes it with token 33 and then freezes for 40 s in a garbage-collection pause. At 30 s the lock expires and server B takes it with token 34. B writes its report, and the storage records 34 as the highest seen. At 40 s A wakes, still believes it holds the lock, and writes with token 33. Storage rejects it, so the report is not corrupted. Without the check both writes land. The cost is the 30 s expiry itself: if A had crashed instead, the other 11 servers wait up to 30 s.

## How it works
<!--meta block=structure-->

```mermaid caption="How do many servers agree that only one of them may touch a resource? One lease in a store they all read grants the work at 1 and 2 and refuses everyone else at 4, and the token stamped on each write at 5 is what the resource compares at 6 — so a holder whose lease has lapsed loses to the newer one."
flowchart LR
    A["Worker A"]
    B["Worker B"]
    subgraph Lease["One lease — owner and expiry"]
        Store[("Lock store")]
    end
    Res["Protected resource"]
    Seen[("Highest token seen")]
    A -->|"1 create key if absent, TTL 30s"| Store
    Store -->|"2 granted, fencing token 41"| A
    B -->|"3 create key if absent"| Store
    Store -->|"4 refused, lease still held"| B
    A -->|"5 write, stamped token 41"| Res
    Res -->|"6 apply only if token is newest"| Seen
    A -->|"7 delete key if still mine"| Store
```

```mermaid caption="A stalled holder's lease expires and Server 2 acquires the lock; the monotonic fencing token lets the resource reject Server 1's late, stale write instead of corrupting data."
sequenceDiagram
    autonumber
    participant S1 as Server 1
    participant Lock as Lock store (TTL)
    participant Res as Protected resource
    participant S2 as Server 2
    S1->>Lock: SET lock NX EX 30 (token 41)
    Lock-->>S1: acquired
    Note over S1: GC pause > TTL, lease expires
    S2->>Lock: SET lock NX EX 30 (token 42)
    Lock-->>S2: acquired
    S2->>Res: write, fence 42
    Res-->>S2: applied — fence 42 is newest
    S1->>Res: write, fence 41
    alt fence newer than last applied
        Res-->>S1: applied
    else stale fence
        Res--xS1: rejected — 41 < 42
    end
```

## Variations
<!--meta block=variations-->

- **Single-instance Redis lock** — `SET key owner NX EX ttl` creates a self-expiring key in one atomic command; a small Lua script does the owner-checked release. Fast and simple, but the single node is a point of failure. With a replica, asynchronous replication means a failover can drop the key and grant a second holder before any TTL expiry. It offers no correctness guarantee across the TTL boundary: good for soft reservations, not for guarding data a double grant would corrupt.
- **Redlock (multi-node Redis)** — Acquire the same lock on a majority of independent Redis nodes to survive one node failing. Genuinely contested for correctness — Martin Kleppmann argues it still cannot guarantee mutual exclusion under GC pauses or clock skew — so reserve it for reservations, not for a resource that a double grant would corrupt.
- **Ephemeral-node locks (ZooKeeper / etcd)** — ZooKeeper ties the lock to a client session with ephemeral sequential znodes; each waiter watches only the node just ahead of it, so a holder's crash ends its session, auto-deletes its node, and wakes exactly the next waiter. etcd instead ties the key to a lease the client keeps alive. Both keep the store's own state consistent on the majority side of a partition, but a stalled holder is still double-granted without a fencing token (etcd key revision, ZooKeeper sequence). Cost: a coordination cluster, and not built for very high acquisition rates.
- **Database-column lease** — Two columns — `locked_by`, `locked_until` — and a conditional `UPDATE` that succeeds only if the row is free or the lease has expired. No new infrastructure and the same durability as your data, but the lock row becomes a write hotspot and DB writes are slower than a cache.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Mutual exclusion that spans processes, machines, and time** — it works where a transaction-scoped lock cannot reach.
- **A TTL means a crashed holder self-heals**: the lease expires and the lock frees with no cleanup job.
- **Lets a critical section outlive a single request** — a reservation held for minutes while a user acts.
- **Coordinates a whole fleet down** to one actor (run-once jobs, singleton workers) with off-the-shelf stores — Redis, ZooKeeper, etcd.

### Cons
<!--meta polarity=con-->

- **Not airtight**: a holder that stalls past the TTL can be double-granted the lock — the defining hazard of the pattern.
- **Correctness needs a fencing token** checked by the resource; the lock service alone cannot guarantee it.
- **TTL tuning is a bind** — too short risks double grants, too long makes a single crash block everyone.
- **Clock skew across nodes** and network partitions undermine the TTL and quorum assumptions the lock rests on.
- **Adds infrastructure and a new failure domain**; the lock store itself can become a bottleneck or a point of failure.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Exactly one process** in a fleet must do something — run a scheduled job once, own a partition, perform a one-time migration.
- **The critical section outlives a single database transaction** — a multi-minute reservation, a wait on a human or an external step.
- **Exclusivity must span servers** — it has to be visible to many stateless servers, not just one database connection.
- **A short lease can shrink the contention window** — hold a seat for the instant of selection, not the whole checkout.

### Avoid when
<!--meta polarity=avoid-->

- **A single-row guard already covers it** — inside one transaction, a [conditional write](./conditional-write.md) or `FOR UPDATE` is simpler and safer.
- **A double grant would corrupt** data and you cannot add a fencing token at the resource — rethink the design first.
- **The work is naturally idempotent** or can be sharded so two workers never contend — you may not need a lock at all.
- **You would be standing up** Redis or ZooKeeper purely for this — the extra failure domain can cost more than the problem.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — Redis SET NX PX to acquire, Lua check-and-delete to release"
// Acquire with SET NX PX: the value is a unique owner token, so only
// the real holder can release. NX = create only if absent; PX = TTL.
async function acquire(redis: Redis, key: string, ttlMs: number) {
  const token = crypto.randomUUID();
  const ok = await redis.set(key, token, "PX", ttlMs, "NX");
  return ok === "OK" ? token : null;   // null = someone else holds it
}

// Release only if we still own it. A GET-then-DEL would race, so the
// check-and-delete runs atomically as a single Lua script.
const RELEASE = `
  if redis.call("get", KEYS[1]) == ARGV[1]
  then return redis.call("del", KEYS[1]) else return 0 end`;

async function release(redis: Redis, key: string, token: string) {
  await redis.eval(RELEASE, 1, key, token);
}

// This bounds a crash, not a stall. If the holder pauses past the TTL,
// a second caller can acquire, so the protected resource must still
// reject any write stamped with a stale fencing token. The UUID above
// proves ownership only and is not a fencing token: Redis SET cannot
// mint a rising number, so take it from an etcd revision or ZooKeeper
// sequence.

```

## In the wild
<!--meta block=wild-->

- **Redis** — Redis documents the single-instance SET NX lock and the multi-node Redlock algorithm, which Martin Kleppmann argued cannot guarantee mutual exclusion under GC pauses or clock skew. Redis has no built-in fencing tokens, so it suits soft reservations rather than data a double grant would corrupt. {#wild-redis}
- **Apache ZooKeeper** — Ephemeral sequential znodes implement a lock where the lowest sequence number holds it and each waiter watches only the node just ahead of it. Strongly consistent, but not built for very high acquisition rates. {#wild-zookeeper}
- **etcd** — A Lease with a TTL the client keeps alive, plus a transactional compare-and-swap (Txn on the key create-revision), gives an atomic acquire; the key mod-revision is a natural monotonically increasing fencing token. Its clientv3 concurrency package packages this as a Mutex recipe. {#wild-etcd}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **lease TTL** — how long a lease lasts without renewal; set it above the longest holder pause and critical section you measure, since too short risks a double grant and too long blocks everyone after a crash
- **renewal / heartbeat interval** — how often the holder extends its lease or keeps its session alive (etcd lease keep-alive, ZooKeeper session heartbeat); it must sit well under the TTL so ordinary jitter does not cost the lock
- **acquire retry & backoff** — how a waiter that fails to acquire retries — fixed interval, capped exponential backoff, or blocking on a watch; jitter avoids a thundering herd the instant the lock frees
- **fencing-token issuance** — the monotonically increasing number handed out on each grant (etcd key revision, ZooKeeper zxid or sequence) that the resource checks

### Signals to watch
<!--meta polarity=signal-->

- **lock hold time** — how long holders keep the lock; the critical section should stay comfortably under the TTL, and a creeping hold time predicts expirations mid-work
- **contention / wait time** — how long acquirers queue for the lock; sustained growth means the lock is a bottleneck and the resource is effectively single-threaded
- **renewal / keep-alive failures** — heartbeats or lease renewals that miss; each one is a holder one step from losing its lock while still working
- **expired-while-held count** — leases that expired before the holder released — the direct precursor to a double grant, and the number to alert on

### Failure modes under load
<!--meta polarity=failure-->

- **stalled holder, expired lease** — a GC pause or slow disk carries the holder past the TTL; a second process acquires and both run the critical section at once (the double grant) — only a fencing token at the resource stops the stale write
- **clock skew across nodes** — TTL and Redlock quorum reasoning assume comparable clocks; a fast or slow clock on one node makes a lease expire earlier or later than expected and undermines the safety argument
- **thundering herd on release** — when a popular lock frees, every waiter retries at once and hammers the lock store; without jittered backoff or watch-based single-waiter wakeups this spikes load
- **split-brain under partition** — a network partition can let two sides each believe they may grant the lock (especially a single-node or poorly-quorumed store), producing concurrent holders until it heals

### Readiness checklist
<!--meta polarity=check-->

- Always set a TTL so a crashed holder cannot hold the lock forever
- Put a fencing token at the protected resource — never trust an I-hold-the-lock flag alone for correctness
- Make release owner-checked and atomic (Lua compare-and-delete, or a CAS on the lease) so you cannot delete a lock you no longer hold
- Keep the critical section shorter than the TTL, and renew the lease if the work might run long
- Alert on renewal failures and expired-while-held — they are the early warning for a double grant

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Dealing with Contention](../../../themes/dealing-with-contention.md) — Hold exclusivity across servers and across time as a self-expiring lease {#fluency-dealing-with-contention}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Quorum & Consensus](./quorum-consensus.md) — A fault-tolerant lock stores its lease in a consensus-backed store (etcd/ZooKeeper)
- [Sweeper](./sweeper.md) — when nothing else will notice the expired lease, a sweep reclaims it and returns the work to the pool
- [Sequential Convoy](../../messaging/sequential-convoy.md) — The fallback mechanism when ordering must be enforced without broker support
- [Lease](./lease.md) — A distributed lock is a lease held in a shared store, so a crashed holder frees it at the deadline.
- [Request Coalescing](../resilience/request-coalescing.md) — A lock with an expiry lets one caller per key rebuild a value while the rest wait for it.

**Alternative to**

- [Minimize Coordination](../../../principles/minimize-coordination.md) — The lock is what you reach for when the work genuinely cannot be split
- [Pessimistic Locking](./pessimistic-locking.md) — A lease held in a shared store covers many servers and outlives one transaction
- [Optimistic Concurrency Control](./optimistic-concurrency-control.md) — Excludes other servers up front with an expiring lease, at the cost of fencing and expiry tuning

**Enables**

- [Fencing Token](./fencing-token.md) — A lock that must be safe for correctness needs a fencing token checked at the resource.

**Requires**

- [Conditional Write](./conditional-write.md) — A single-instance lock is acquired by a conditional write (SET NX) with an expiry

**Often confused with**

- [Leader Election](./leader-election.md) — Both grant a single owner — a lock guards a resource, election picks a role holder

**Prevents**

- [Split-Brain](../../../hazards/split-brain.md) — Leases a single owner that must stop at expiry, so a partitioned old holder is refused once a fencing token is checked at the resource

**Exposed to**

- [Clock Skew](../../../hazards/clock-skew.md) — A lease expiry depends on clocks, so skew can give two holders.
- [Race Condition](../../../hazards/race-condition.md) — Can fall into race condition when a lock whose expiry races with a slow holder admits two holders
- [Thundering Herd](../../../hazards/thundering-herd.md) — Can fall into thundering herd when a popular lock frees and every waiter retries at once, unless retries are jittered or watch-based

**Demonstrated by**

- [Web Crawler](../../../designs/web-crawler.md) — an atomic cross-node lock serialises access to a shared resource under concurrency
- [Uber](../../../designs/uber.md) — a short-lived time to live (TTL) lock is the canonical way to enforce single-owner access across many stateless instances
- [Ticketmaster](../../../designs/ticketmaster.md) — the seat reservation is exactly a distributed lock with automatic time to live (TTL) expiry shared across many booking-service instances
- [Job Scheduler](../../../designs/job-scheduler.md) — automatic crash recovery is exactly self-expiring exclusive ownership of a job

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Locks are sold as leases on a blob, a conditional row or a coordination service.

<!-- relationships:end -->
