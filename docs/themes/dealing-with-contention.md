---
title: Dealing with Contention
description: Keeping concurrent writers correct when they fight over the same data
area: themes-scale
owner: Oleksandr Derechei
tags: [concurrency, state-management]
status: stable
aliases: [concurrency control, write contention]
---

# Dealing with Contention

Keeping concurrent writers correct when they contend for the same record — a ladder of coordination mechanisms you climb as collisions grow more frequent and reach further across servers and time.

## The question
<!--meta block=description-->

Two requests change the same row in the same millisecond, each reading the old value and writing back its own result. One write silently erases the other, a [lost update](../hazards/race-condition.md): a seat sells twice, a deposit vanishes, and nothing throws. A ladder fixes this: one atomic statement, a version check with retry, an explicit lock, and a lease with a fencing token, a rising number the resource checks. Climb only as far as collision rate and reach force you.

## Explained
<!--meta block=explain-->

When two requests change the same row at the same moment, code that reads a value, decides, and writes it back loses one change without any error. You fix it by climbing a ladder and stopping at the first rung that fits. First, fold the safety rule into one write the database runs atomically, such as an update that only applies if seats are left. Next, attach a version to the row and let the rare loser retry, which is optimistic because it assumes nobody interferes. If writers collide often, retries pile up faster than they clear, so take a [lock](../patterns/distributed/coordination/pessimistic-locking.md) up front and make writers queue. Last, if exclusivity must span several servers or outlast one transaction, use a [lease](../patterns/distributed/coordination/lease.md), a record of who holds the claim that expires on its own. Add a [fencing token](../patterns/distributed/coordination/fencing-token.md), a number that rises with each grant, so the resource can refuse a stale holder. Choose by how often writers meet and how far the contention reaches.

- **Lock waits.** Locks slow every writer even when none would collide.
- **Unsafe retries.** A retry is only safe if doing a write twice equals doing it once, so give each operation a key the store remembers.
- **Stalled queue.** A lock held during a slow call stalls every writer queued behind it.

**Example.** A flash sale has 100 buyers hitting one stock row at once. With a version check, each round one writer wins and the rest retry: 100 + 99 + ... + 1 is 5,050 attempts for 100 sales, so 4,950 attempts are discarded work. With a row lock, the 100 writers queue and run 100 writes, about 5 ms each, so the last waits about 0.5 s. A single update that only applies when stock is above zero is the conditional-write rung: it needs no lock and no retries, so try it first. The lock costs overhead on every write, even on a quiet day, and a real queue once the sale starts.

## The tradespace
<!--meta block=tradespace-->

Two questions place you on the ladder. **How often do writers actually collide?** When collisions are rare — most retail checkout, admin edits, a review-count bump — bet on that and pay little for the common case: fold the whole safety rule into one conditional write the store executes atomically, or attach a version to the row and let the occasional loser retry. This is the optimistic stance: assume no interference, detect the exception, redo only the rare bit. When collisions are frequent — a hot auction, the one flash-sale row everyone wants — optimism turns into a [retry storm](../hazards/retry-storm.md) that clears slower than it fills, and it is cheaper to be pessimistic: take an explicit lock up front so writers block in an orderly queue instead of thrashing. A conditional write stays correct even on a hot row; only logic that cannot fit in one statement forces a version check or a lock. To know when to move to a lock, watch conflicts per key: if retries per success keep rising on one row, lock it.

**How far does the contention reach?** While the decision fits inside one row and one transaction, the database itself is your coordinator — a `WHERE` clause or a `SELECT ... FOR UPDATE` is all the machinery you need. Once exclusivity must be seen by more than one server, or must outlive the transaction — hold a seat for ten minutes of checkout, keep two workers off the same job — a lock held by one transaction ends when it ends, and you need a lease any server can read and that expires on its own. A lease still cannot stop a holder that stalled past its deadline and wakes up believing it owns the record, so have the resource itself refuse writes carrying an older token than the last it accepted.

Idempotency applies on both axes: a retry, or a duplicate delivery, is only safe if applying a write twice equals applying it once. Make each operation [idempotent](../patterns/messaging/idempotency.md) and every retry on the ladder becomes trustworthy. And there is a boundary: once an operation must stay correct across several independent stores at the same time, it has left contention behind and become a distributed-transaction problem. The [Ticketmaster](../designs/ticketmaster.md) and [BookMyShow](../designs/bookmyshow.md) case studies work the seat-hold lease through, and [Online Auction](../designs/online-auction.md) works the hot-bid rung.

```mermaid caption="Climb only as high as scope and collision rate force you: reach for a lease last, prefer a single atomic write first, and choose optimism or pessimism by how often writers actually meet."
flowchart TB
    S["Two writers contend for one record"] -->|"how to serialize?"| Q1{"Must exclusivity span servers or outlive the transaction?"}
    Q1 -->|"Yes"| DL["Distributed lock: a lease with a TTL"]
    Q1 -->|"No"| Q2{"Does the safety rule fit in the row's WHERE clause?"}
    Q2 -->|"Yes"| CW["Conditional write: one atomic statement"]
    Q2 -->|"No, needs app logic"| Q3{"Do writers collide often?"}
    Q3 -->|"Rarely"| OCC["Optimistic control: version check, loser retries"]
    Q3 -->|"Often"| PL["Pessimistic lock: acquire the rows up front"]
```

## The escalation ladder
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Conditional Write](../patterns/distributed/coordination/conditional-write.md) {#tour-conditional-write}

The cheapest rung, and the one to try first. When the safety rule is a predicate on the row you're writing — `available_seats > 0`, `status = 'available'` — you need no lock at all: fold the check into the write's `WHERE` clause and let the store serialize writes to that row for you. The loser's condition re-evaluates against the winner's result, matches zero rows, and does nothing. One atomic statement, no coordinator.

### [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) {#tour-optimistic-concurrency-control}

When the decision needs a little application logic but collisions are rare, don't lock — assume no one else touched the row and check that assumption as you write. Attach a version that changes on every write and condition the update on the version you read still being current. If a concurrent writer moved it first, your update matches zero rows and you retry. You pay only when there is a real conflict, which makes it a fit when the same row is rarely written by two writers at once, however read-heavy the traffic.

### [Pessimistic Locking](../patterns/distributed/coordination/pessimistic-locking.md) {#tour-pessimistic-locking}

When collisions are frequent, optimism degrades into a retry storm. Lock the contended rows up front instead — `SELECT ... FOR UPDATE` — so a competing writer blocks until you commit rather than doing work it will have to discard. The price is that every writer pays lock overhead even when it would never have collided, and a lock held across slow I/O — a payment call, say — stalls everyone queued behind it. Lock rows in one fixed order and set a lock timeout, or two writers can deadlock or wait without end.

### [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) {#tour-distributed-lock}

When exclusivity must outlive a single transaction or be seen by more than one server — hold a seat through a ten-minute checkout, keep two workers off the same task — a row lock cannot reach that far. Represent the lock as a lease instead: a record of who holds it and when it expires, readable by any server and self-cleaning when its time to live (TTL) lapses. The escalation of last resort — reach for it only when a single-transaction guard genuinely cannot do the job.

### [Lease](../patterns/distributed/coordination/lease.md) {#tour-lease}

A lease is a grant that ends at a deadline unless the holder renews it. A holder that crashes frees the resource when the deadline passes, with no cleanup job. A paused holder can still act after expiry, so pair it with a check at the resource. Choose the term longer than your worst pause and renew at a third to a half of it; a short term recovers fast but renews often, a long one leaves a crashed holder's resource idle.

### [Fencing Token](../patterns/distributed/coordination/fencing-token.md) {#tour-fencing-token}

Each grant of the lock carries a number that rises, and the resource refuses any write with a lower number than one it has seen. A paused holder that wakes after its lease ended is refused, whatever the clocks say. The resource must be able to do the check.

### [Idempotency](../patterns/messaging/idempotency.md) {#tour-idempotency}

A retry is only safe if doing the write twice equals doing it once, and that holds for optimistic retries and for any client or queue redelivery on every rung. Give each operation a key the store remembers, so a replayed or duplicated request returns the first result instead of applying a second charge. Keep the key at least as long as your longest redelivery, and claim it in one atomic step, such as a unique constraint. Idempotency doesn't resolve contention on its own; it is what makes retries trustworthy from client to store.

<!-- tour:end -->

## How to decide
<!--meta block=decide-->

| If you need… | Lean | Reach for |
| --- | --- | --- |
| The safety rule to fit inside one row's `WHERE` clause (a counter, status, or claim) | Atomic write | [Conditional Write](../patterns/distributed/coordination/conditional-write.md) |
| Read-decide-write correctness where collisions are rare and reads dominate | Optimistic | [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) |
| Correctness when many writers keep hitting the same hot row | Pessimistic | [Pessimistic Locking](../patterns/distributed/coordination/pessimistic-locking.md) |
| Exclusivity that spans servers or an external wait such as checkout | A lease | [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) |
| A paused or slow holder to be unable to overwrite the new owner | Storage refuses stale writes | [Fencing Token](../patterns/distributed/coordination/fencing-token.md) |
| A claim that frees itself when its holder crashes | Time-limited grant | [Lease](../patterns/distributed/coordination/lease.md) |
| A retried or duplicated write to land exactly once | Safe replay | [Idempotency](../patterns/messaging/idempotency.md) |

## Sibling themes
<!--meta block=siblings-->

- [Consistency & Replication](./consistency-and-replication.md) — Contention is the single-node face of the question replication asks across many: whose write wins, and when does everyone agree on it.
- [CAP Theorem](./cap-theorem.md) — When contention spreads across a partitioned network, keeping writers correct turns into the consistency-versus-availability choice.
- [Scalability](./scalability.md) — A hot contended row is where horizontal scaling stops helping — sharding splits keys, but not the one key every writer wants at once.
- [Concurrency](./concurrency.md) — The same fight between writers inside one process, where locks and monitors suffice; this page starts when it crosses processes or stores.
- [Scaling Writes](./scaling-writes.md) — Sharding spreads different keys across nodes; it cannot help the one hot key every writer wants, which is where this ladder starts.
- [Multi-Step Processes](./multi-step-processes.md) — Where correctness must span several independent stores at once; past contention, into saga or two-phase-commit territory.
