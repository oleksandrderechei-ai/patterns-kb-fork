---
title: Pessimistic Locking
description: Lock the row up front so no one else can touch it until you're done
area: distributed-coordination
owner: Oleksandr Derechei
tags: [concurrency, isolation]
status: stable
aliases: [SELECT FOR UPDATE, row locking]
solves: [the same row is updated so often that retrying failed saves keeps failing again, I need other transactions to wait while one finishes changing this record, two transfers hit the same account and the balance ends up wrong, two people pick the same block of seats at once and both bookings go through, two workers claim the same job from the queue and run it twice]
---

# Pessimistic Locking

Take an explicit lock on the rows you're about to change before you read them, so competing transactions block until you commit — a collision is prevented outright, not detected after the fact.

## What it is
<!--meta block=description-->

Between reading a row and writing it back, a second transaction can slip in, and one update silently overwrites the other. Pessimistic locking prevents that: it locks the rows you are about to change, in SQL with SELECT FOR UPDATE, and other transactions wait until you commit. It never retries and never loses an update, but every transaction pays for the lock.

## Explained
<!--meta block=explain-->

Pessimistic locking takes a lock on the rows you are about to change before you read them, so other transactions that want the same rows wait until you commit. In SQL that is SELECT ... FOR UPDATE. Choose it over a [conditional write](conditional-write.md) or a [version check](optimistic-concurrency-control.md) when many writers fight over the same rows and the decision in the middle is real code that no single WHERE condition can express, such as finding four seats together. You buy a clear winner, no retry loop, and no overwritten update.

- **Queues behind the holder.** Every transaction pays for the lock. Keep it short and never call a payment service while holding it.
- **Deadlocks.** Opposite lock order aborts one transaction. Lock rows in one fixed order and retry the aborted side.
- **One transaction only.** A lock cannot span services or a human pause.

**Example.** A seat-map transaction locks row 12 for 20 ms, so that row can serve 1,000 divided by 20, about 50 bookings a second. A developer adds an 800 ms payment call inside the transaction. The lock now lasts 820 ms and the same row serves about 1.2 bookings a second, so the queue behind it grows. Move the payment call after the commit and the rate returns to 50. Separately, if one transaction locks seat A then B while another locks B then A, the database aborts one after its wait timeout, so you lock seats in ascending order.

## How it works
<!--meta block=structure-->

```mermaid caption="What stops two transactions deciding on the same row at once? Txn A holds the row from its locking read to COMMIT, so Txn B waits and then reads the value A wrote rather than the one A saw."
flowchart LR
    A["Txn A"]
    B["Txn B"]
    subgraph Held["Exclusive lock — held until COMMIT"]
        LM["Lock manager"]
        Seat[("Seats row A15")]
    end
    A -->|"1 SELECT … FOR UPDATE"| LM
    LM -->|"2 grant lock, return row"| A
    B -->|"3 SELECT … FOR UPDATE, same row"| LM
    LM -->|"4 queue B behind A"| B
    A -->|"5 decide, UPDATE, COMMIT"| Seat
    Seat -->|"6 release lock"| LM
    LM -->|"7 grant to B, post-commit row"| B
```

~~~mermaid caption="Txn B blocks at `FOR UPDATE` until Txn A commits, then reads A's committed value — the read-modify-write gap is closed by serializing the two writers."
sequenceDiagram
    autonumber
    participant A as Txn A
    participant Row as Row (seat A15)
    participant B as Txn B
    A->>Row: BEGIN, then SELECT FOR UPDATE
    Row-->>A: row locked
    B->>Row: SELECT FOR UPDATE (same row)
    Note over B,Row: blocks, waits for the lock
    alt A commits in time
        A->>Row: UPDATE, then COMMIT
        Row-->>B: lock released, returns post-commit value
        B->>Row: re-decide, then UPDATE and COMMIT
    else lock wait timeout
        Row--xB: lock timeout, Txn B aborts
    end
~~~

## Variations
<!--meta block=variations-->

- **Exclusive vs. shared locks** — `FOR UPDATE` takes an exclusive lock — no other transaction may read-for-update or write the row. `FOR SHARE` (MySQL's `LOCK IN SHARE MODE`) takes a shared lock: others may also read-for-share, but writers still block. Use shared when you only need a row to stay stable while you read related data, exclusive when you intend to write it.
- **Claim-and-skip for work queues** — `SELECT … FOR UPDATE SKIP LOCKED` steps over rows another transaction has already locked instead of waiting, so N workers each grab a different unclaimed row. This is the standard way to pull jobs off a database-backed queue without two workers claiming the same job.
- **Wait, fail fast, or time out** — By default the lock request waits, and how long depends on the engine: PostgreSQL blocks indefinitely unless you set a lock timeout, while MySQL/InnoDB caps the wait for you. Treat the bound as something you configure, not something you inherit. `NOWAIT` fails immediately if the row is already locked, letting the caller back off rather than queue. Picking one is a policy choice: queue behind contention, or shed it.
- **Advisory locks on an arbitrary key** — The lock does not have to be attached to data. PostgreSQL and MySQL both let a caller name a lock — an integer or a string the application chooses — and serialise everyone who asks for that same name; the PostgreSQL manual's own example of what they are for is emulating pessimistic locking. Taken at session scope, an advisory lock is held until it is released or the connection ends, so a critical section spanning several statements or several transactions can stay inside the database you already run instead of reaching for a distributed lock. What the engine enforces is the lock, not the convention: a caller that writes the row without asking for the key succeeds, and never learns that anyone was holding it.
- **Lock granularity and scope** — Row-level is the default and the finest. A broad `SELECT` — or a missing index that forces a scan — can lock far more rows than you intended, and some engines escalate to page or table locks under pressure. Lock the narrowest set that makes the decision safe, and no more.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Prevents lost updates outright** — no retry loop, no clobbered writes; the winner is whoever acquires the lock, decided deterministically.
- **Handles arbitrary read-decide-write logic** that no single conditional `WHERE` clause could express.
- **Predictable under high contention** — where optimistic retries would thrash, a lock queue simply serializes the work.
- **Uses the database's own battle-tested** locking and [deadlock](../../../hazards/deadlock.md) detection — no new infrastructure to run.

### Cons
<!--meta polarity=con-->

- **The lock is held for the whole transaction**, so a long or slow one — an external API call mid-transaction — stalls everyone queued behind it.
- **Reduced concurrency**: contending writers are serialized, and every transaction pays the lock cost even when it would never have collided.
- **Deadlock risk when transactions acquire** locks in inconsistent order; the database aborts one side and the app must catch and retry it.
- **Lock-wait timeouts surface as errors** the caller must handle, and a forgotten `COMMIT` on a held connection can block others indefinitely.
- **Does not span connections, services, or time** — it lives and dies with one transaction, so it is not a distributed lock.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Collisions on the same rows are frequent**, so optimistic retries would just thrash.
- **The decision between reading** and writing is real application logic, not a predicate the database can check inside the `UPDATE`.
- **Exactly one writer per record** — you must guarantee exactly one transaction mutates a record at a time — balances, inventory, seat selection.
- **The whole operation fits inside a single**, short database transaction.

### Avoid when
<!--meta polarity=avoid-->

- **Contention is low** — optimistic concurrency or a plain conditional write is cheaper and never blocks.
- **Safety rule is one predicate** — the safety rule is a single `WHERE` predicate, so one conditional `UPDATE` already closes the gap.
- **The critical section must span** more than one transaction, wait on a human, or cross services — reach for a distributed lock or a saga instead.
- **The transaction would hold** the lock across slow I/O such as a payment gateway or third-party call.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — SELECT … FOR UPDATE inside a transaction"
// Claim one specific seat safely: lock the row, verify, then sell it.
async function reserveSeat(db: Client, seatId: string, userId: string) {
  await db.query("BEGIN");
  try {
    // FOR UPDATE locks this row until COMMIT. A concurrent reserveSeat
    // for the same seat blocks on this line until we finish.
    const { rows } = await db.query(
      `SELECT status FROM seats WHERE id = $1 FOR UPDATE`,
      [seatId],
    );
    if (rows[0]?.status !== "available") {
      await db.query("ROLLBACK");        // someone got here first
      return { ok: false, reason: "taken" };
    }
    await db.query(
      `UPDATE seats SET status = 'sold', sold_to = $2 WHERE id = $1`,
      [seatId, userId],
    );
    await db.query("COMMIT");            // lock released, decision durable
    return { ok: true };
  } catch (err) {
    await db.query("ROLLBACK");          // release the lock on any failure
    throw err;
  }
}

```

## In the wild
<!--meta block=wild-->

- **PostgreSQL** — Row-level locking reads: SELECT … FOR UPDATE (and FOR SHARE) lock the returned rows until the transaction ends. FOR UPDATE SKIP LOCKED, added in 9.5, lets many workers each claim a distinct unlocked row; NOWAIT fails fast instead of waiting on a held lock. {#wild-postgresql}
- **MySQL / InnoDB** — Locking reads via FOR UPDATE and LOCK IN SHARE MODE (spelled FOR SHARE since 8.0, which also added SKIP LOCKED and NOWAIT). InnoDB holds the row locks to the end of the transaction and detects deadlocks, rolling one transaction back with an error the app must retry. {#wild-mysql-innodb}
- **Database-backed job queues** — Postgres-backed queue libraries such as graphile-worker build a work queue on an ordinary table and claim the next job with SELECT … FOR UPDATE SKIP LOCKED, so concurrent pollers each atomically grab a different row and no two workers run the same task. {#wild-skip-locked-queues}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Lock wait timeout** — How long a blocked statement queues before it gives up and errors — PostgreSQL \`lock_timeout\`, MySQL/InnoDB \`innodb_lock_wait_timeout\`. Set too long, waiters pile up holding connections; too short, ordinary queuing surfaces as spurious failures the caller must retry.
- **Wait policy per statement** — Whether a locking read queues (the default), fails immediately with \`NOWAIT\`, or steps over locked rows with \`SKIP LOCKED\`. This is a per-call-site decision, not a server setting: queue behind contention, shed it, or route around it.
- **Lock mode and scope** — \`FOR UPDATE\` (exclusive) versus \`FOR SHARE\`, and how many rows the WHERE clause plus its index actually lock. The plan decides the scope, not the intent — in InnoDB a locking statement with no usable index locks every row it examines, not just the ones it returns.
- **Transaction boundary timeouts** — Caps on how long a transaction can hold what it has taken — PostgreSQL \`statement_timeout\` for a single statement and \`idle_in_transaction_session_timeout\` for a session sitting idle inside an open transaction while still holding its locks.
- **Deadlock detection and retry policy** — PostgreSQL \`deadlock_timeout\` sets how long a waiter blocks before deadlock detection runs; InnoDB's \`innodb_deadlock_detect\` can turn detection off so waits end at the lock timeout instead. Alongside it sits the application's own dial: attempt count, backoff and jitter after an abort.

### Signals to watch
<!--meta polarity=signal-->

- **Lock wait time** — How long transactions spend blocked before acquiring. PostgreSQL shows it as sessions with \`wait_event_type = 'Lock'\` in \`pg_stat_activity\` and ungranted rows in \`pg_locks\`. A rising figure is the first sign the contended rows have become the bottleneck.
- **Deadlock rate** — Deadlocks detected per interval — PostgreSQL keeps a per-database counter in \`pg_stat_database.deadlocks\`. Steady state should sit near zero; any sustained trend means two code paths take the same rows in different orders.
- **Abort rate by error code** — The share of transactions ending in a lock-wait timeout or deadlock rather than a commit (MySQL 1205 and 1213; PostgreSQL SQLSTATE 40P01, and 55P03 from \`NOWAIT\`). Track it as a proportion of attempts — the absolute count moves with traffic and hides the trend.
- **Lock hold time (p95/p99)** — How long a locking transaction runs from acquisition to commit. On a single contended row this is the throughput ceiling — roughly one transaction per hold time — so watch the tail, where a few slow transactions set the queue length for everyone.
- **Connection pool wait time** — A blocked transaction keeps its connection while it waits, so lock contention on a handful of rows shows up as pool saturation and queuing for unrelated traffic that never touches those rows.

### Failure modes under load
<!--meta polarity=failure-->

- **Convoy on a hot row** — Every transaction touching the same row serializes, so throughput on it caps at one per hold time no matter how many workers you add. Extra concurrency past that point only lengthens the queue and the latency tail.
- **Lock held across slow I/O** — A payment call or third-party request inside the transaction stretches hold time from milliseconds to seconds. The queue behind it then grows faster than it drains, and waiters start failing on lock-wait timeouts far from the transaction that caused it.
- **Deadlock storm from inconsistent ordering** — Two paths that take the same pair of rows in opposite order deadlock rarely at low volume and constantly at high. The engine aborts one side, the application retries, and the retries add load exactly when the system is already saturated.
- **Lock scope wider than intended** — A locking read that cannot use an index locks everything it scans. Under InnoDB's REPEATABLE READ, gap locks additionally block inserts into the scanned range, so unrelated writes stall on a lock nobody meant to take.
- **Idle in transaction** — A worker that opens a transaction and then stalls — a crash between statements, a forgotten COMMIT — holds its locks until something kills the session. In PostgreSQL a long-lived transaction also holds back cleanup of dead rows, so the damage outlives the blocked callers.

### Readiness checklist
<!--meta polarity=check-->

- Keep the transaction short and free of external network calls — nothing that can hang belongs between the lock and the COMMIT.
- Always set an explicit lock wait timeout so no caller blocks indefinitely, and pair it with a statement timeout and an idle-in-transaction timeout.
- Acquire multiple locks in one deterministic order everywhere in the codebase — sorting by primary key before locking is the practical cure for deadlocks.
- Treat deadlock and lock-timeout errors as expected outcomes: catch them, retry with capped jittered backoff, and fail with a clear error rather than looping forever.
- Read the query plan of every locking SELECT and confirm an index narrows it to the rows you meant to lock.
- Choose the wait policy per call site — queue by default, NOWAIT to shed load, SKIP LOCKED for claim-one-row queue work.
- Load-test at the contention you actually expect, and size the connection pool knowing that blocked transactions occupy connections while they wait.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Dealing with Contention](../../../themes/dealing-with-contention.md) — Lock the contended rows up front when collisions are frequent {#fluency-dealing-with-contention}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Alternative to**

- [Optimistic Concurrency Control](./optimistic-concurrency-control.md) — Lock up front when collisions are frequent; go optimistic when they're rare
- [Distributed Lock](./distributed-lock.md) — A database row lock is simpler, but it holds only for the length of one transaction on one store
- [Two-Phase Commit](./two-phase-commit.md) — When the data spans databases, two-phase commit extends the same lock-until-commit idea across the network.
- [Lease](./lease.md) — Row locks live inside one transaction, where a lease reaches across servers and survives a crashed holder.
- [Conditional Write](./conditional-write.md) — Locking holds the row while your code decides; a conditional write skips the lock when the rule fits one predicate.

**Prevents**

- [Race Condition](../../../hazards/race-condition.md) — Only the lock holder can touch the row, so check-then-act can't interleave

**Exposed to**

- [Deadlock](../../../hazards/deadlock.md) — Can fall into deadlock when row locks taken in inconsistent order across transactions form a wait cycle

**Demonstrated by**

- [Inventory Management](../../../designs/inventory-management.md) — it assumes conflict and takes the locks before reading, using consistent lock ordering to avoid deadlock
- [BookMyShow](../../../designs/bookmyshow.md) — the seat race is resolved by locking the resource before acting on it, one winner guaranteed
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — a claim where contention is expected, contrasted on the same page with the optimistic guard used where it is rare

<!-- relationships:end -->
