---
title: Conditional Write
description: Make a write happen only if the store still matches a predicate
area: distributed-coordination
owner: Oleksandr Derechei
tags: [concurrency, data-access]
status: stable
aliases: [compare-and-set, CAS, conditional update]
solves: [two requests read the same row and one silently overwrites the other's change, "I need to decrement stock only if it's still above zero, in one atomic step", "another request slips in between my check and my write, so the check no longer holds", two workers grabbed the same queued job because both saw it as unclaimed, my code booked the ticket even though the seat update quietly changed nothing]
---

# Conditional Write

A write that carries its own precondition: the store checks a predicate against the row and applies the change in one atomic step, so a request that was working from stale state changes zero rows instead of silently clobbering someone else's update.

## What it is
<!--meta block=description-->

Reading a value, deciding in your code, then writing leaves a gap where another request can change what you read, so two buyers both get the last seat. A conditional write sends the store the change and the condition together, and the store checks and writes in one step. A late request matches no row and changes nothing, with no lock and no coordinator.

## Explained
<!--meta block=explain-->

A conditional write sends the store the change and the rule for allowing it in one statement, so the store checks and writes as a single step. For example, UPDATE seats SET taken = true WHERE id = 7 AND taken = false changes the seat only if it is still free. Without it, you read a value, decide in your code, then write, and between the read and the write another request can change what you read: two buyers both see one seat left and both get it. Choose it over a lock when the whole safety rule fits in one condition on the row you write, because it holds no lock across your read-decide-write cycle, makes no second round trip and needs no coordination service.

- **Silent loss** A losing write changes zero rows without an error; always check the affected-row count before anything that follows.
- **Guard the real row** Guard the row actually contended, not a stand-in such as a bare counter, or two winners can land on one item.
- **Logic limit** When the decision needs your own code between read and write, no condition can carry it; use a lock or a version-checked retry.

**Example.** One seat is left. Buyers A and B both press pay at the same moment. With read-then-write, both read taken = false, both write true and both are charged 80, so you take 160 for one seat. With the conditional write, the database runs A first and updates 1 row. It then runs B's statement against the new state, finds taken = true and updates 0 rows. Your code charges only when the count is 1, so B sees sold out. The cost shows if the code skips that check: B's update changes nothing, yet the payment call still runs and B is charged 80 for nothing.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a writer stop another request slipping in between the check and the change? Steps 2 and 3 run inside one statement, so there is no gap to slip into, and step 4 is the whole result the caller gets."
flowchart LR
    App["Booking Service"]
    subgraph Stmt["One atomic statement"]
        Guard["Evaluate predicate<br/>taken = false"]
        Seats[("Seats table")]
    end
    Tickets[("Tickets table")]
    App -->|"1 UPDATE seats WHERE taken = false"| Guard
    Guard -->|"2 read current row"| Seats
    Guard -->|"3 apply taken = true"| Seats
    Guard -->|"4 return rows changed = 1"| App
    App -->|"5 insert ticket, only if step 4 applied"| Tickets
```

```mermaid caption="Both writers carry the same predicate; the store applies them one at a time, so the second sees the condition already false and changes nothing."
sequenceDiagram
    autonumber
    participant A as Writer A
    participant B as Writer B
    participant DB as Store (row 42: taken=false)
    A->>DB: UPDATE SET taken=true WHERE id=42 AND taken=false
    B->>DB: UPDATE SET taken=true WHERE id=42 AND taken=false
    Note over DB: same row — applied one at a time
    alt A serialized first
        DB-->>A: 1 row changed — A wins
        DB--xB: 0 rows changed — predicate now false, B rejected
    else B serialized first
        DB-->>B: 1 row changed — B wins
        DB--xA: 0 rows changed — predicate now false, A rejected
    end
```

## Variations
<!--meta block=variations-->

- **Status / claim guard** — The predicate names a specific row's state — `WHERE seat_number='A15' AND status='available'`. Guarding the actual contended thing, not a proxy for it, is the safe form: it flips exactly the row it checked.
- **Counter floor** — The predicate is a threshold on an aggregate: `WHERE available_seats > 0`. The decrement alone never oversells, but it proves a unit exists, not which; when a separate read picks the specific item first and several units are free, two writers can both pass and land on the same item. Guard the real row when identity matters.
- **Set-if-absent** — The condition is "the key does not exist yet" — Redis `SET key val NX`, SQL `INSERT ... ON CONFLICT DO NOTHING`, Cassandra `IF NOT EXISTS`. This is conditional create, and it is exactly how a lease or lock is acquired: whoever writes the row first owns it.
- **[Version compare](./optimistic-concurrency-control.md)** — The condition is that a version or revision still equals what you last read — `WHERE version = 42`. Generalising the guard to a monotonic token rather than a business value is what turns a single conditional write into optimistic concurrency control across a whole read-modify-write cycle.
- **Guarded multi-write** — When one atomic statement is not enough — decrement the counter and insert a ticket row — a bare `INSERT` after an `UPDATE` that matched zero rows still creates a "ticket with no seat", because a zero-row update is not an error. Make the second write depend on the first's affected-row count (a `WITH ... RETURNING` common table expression (CTE) feeding `INSERT ... SELECT`, or an explicit affected-rows check inside a transaction).

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One atomic statement** — no application lock is held across a read-decide-write cycle, no second round-trip, no coordination service to run. The store still takes a brief row lock for the statement.
- **Closes the read-then-write race on the guarded row**: the check and the write are one operation, so they cannot interleave. Other rows, ABA and write skew need other guards.
- **Rides the single-row serialization the store already gives**, so it scales with the store across many rows; one hot row is capped (see the retry-storm failure mode below).
- **The same idea travels across engines** — SQL `WHERE`, DynamoDB `ConditionExpression`, Redis `NX`, Cassandra `IF`, HTTP `If-Match`.

### Cons
<!--meta polarity=con-->

- **Only works when the whole** decision fits in a predicate; the moment app logic must sit between the read and the write, you need locking or a version check instead.
- **A losing write matches zero rows**, which is not an error — forget to check the affected-row count and the failure is silent.
- **Guarding a proxy such** as a bare counter can still let two writers collide on the same specific item; the predicate must protect the real contended thing.
- **An equality predicate is blind** to the ABA problem — a value that leaves and returns looks unchanged. Guard a version that only ever increments.
- **Loss behaviour depends on isolation level**: silent zero-rows at common defaults, but at stricter levels some engines raise a serialization error the app must catch and retry. Behaviour differs by engine, so check yours.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Safety rule is a row predicate** — the rule is a predicate on the row you are writing: a status flag, a claim, a counter floor.
- **You want to decrement**, claim, or flip a single row atomically without holding a lock across the operation.
- **You are acquiring a lease with set-if-absent**, or writing a version-checked update — both are conditional writes underneath.
- **Try it first when the rule is a predicate on the one row you write**; escalate to locking or a version loop only once a plain conditional write proves insufficient.

### Avoid when
<!--meta polarity=avoid-->

- **Deciding what to write needs application logic** between the read and the write — reach for [pessimistic locking](./pessimistic-locking.md) or optimistic concurrency control.
- **The invariant spans several rows** with no single row to guard (write skew) — that needs a stricter isolation level, not a per-row predicate.
- **The guarded value can round-trip** A→B→A and an equality check would wave the stale write through.
- **There is no contention at all** — a single-writer resource needs no guard, and the extra predicate only obscures intent.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — claim a seat, and guard a multi-write on the affected count"
// The store decides, atomically: flip the seat only if it is still free.
async function claimSeat(db: Db, seatId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE seats SET taken = true
     WHERE id = $1 AND taken = false`,
    [seatId],
  );
  // 0 rows changed means someone else got there first — a no-op, not an error.
  return rowCount === 1;
}

// A counter guard is not enough on its own: a following INSERT must depend on
// whether the UPDATE actually applied, or you create a ticket with no seat.
async function sellTicket(db: Db, concertId: string, userId: string) {
  return db.transaction(async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE concerts SET available = available - 1
       WHERE id = $1 AND available > 0`,
      [concertId],
    );
    if (rowCount === 0) return { sold: false }; // sold out — write nothing else
    await tx.query(
      `INSERT INTO tickets (concert_id, user_id) VALUES ($1, $2)`,
      [concertId, userId],
    );
    return { sold: true };
  });
}

```

## In the wild
<!--meta block=wild-->

- **DynamoDB ConditionExpression** — A write (PutItem, UpdateItem, DeleteItem) can carry a ConditionExpression such as attribute_not_exists(id) or price = :expected; the item is written only if the condition holds against the current item, otherwise the call fails with ConditionalCheckFailedException and nothing changes. {#wild-dynamodb-condition}
- **Redis SET ... NX** — SET key value NX writes the key only if it does not already exist, returning nil when it is present. This set-if-absent is the acquire step of a Redis-based lock, usually paired with an EX/PX expiry so the lease self-releases. {#wild-redis-set-nx}
- **Cassandra lightweight transactions** — An INSERT ... IF NOT EXISTS or UPDATE ... IF col = value is a Paxos-backed compare-and-set; Cassandra runs a consensus round so the conditional write is linearizable, and the result set reports \[applied\] plus the values it checked against. {#wild-cassandra-lwt}
- **HTTP conditional requests** — A PUT or DELETE carrying If-Match: "etag" (or If-None-Match: \*) tells the origin to apply the write only if the resource still matches that validator; on a mismatch the server returns 412 Precondition Failed and leaves the resource untouched. {#wild-http-if-match}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **what the predicate is checked against** — The guard can compare a business value (status = 'available'), a monotonic version or revision token, or mere absence (set-if-absent). This is the pattern's primary dial: equality on a mutable business value is blind to a value that leaves and comes back, while a version that only ever increments is not.
- **isolation level of the surrounding transaction** — At read committed and similar levels a losing write is a silent zero-row result; at serializable some of the same conflicts instead raise a serialization failure (SQLSTATE 40001 in PostgreSQL) the caller must catch and retry. Choose the level deliberately — it decides which of the two loss shapes your code has to handle.
- **retry policy on a rejected write** — Whether a losing write is retried at all, how many attempts it gets, and the backoff and jitter between them. A claim another request already won is usually final; a version conflict inside a read-modify-write cycle usually deserves a bounded retry. Immediate unbounded retry is how contention turns into a storm.
- **row-lock and statement timeouts** — A conditional write still holds the store's row lock for the duration of the statement, so concurrent writers to the same row queue behind it. lock_timeout and statement_timeout (PostgreSQL) or innodb_lock_wait_timeout (MySQL) bound how long a caller waits before failing fast instead of pinning a connection.
- **serial consistency for replicated conditional writes** — Where the conditional path runs a consensus round rather than a single-leader write, its consistency setting decides how far that round travels: Cassandra's SERIAL CONSISTENCY selects SERIAL (across datacentres) or LOCAL_SERIAL (the local one), trading cross-DC linearizability for latency.

### Signals to watch
<!--meta polarity=signal-->

- **guard rejection rate** — The share of conditional writes that changed zero rows or returned the store's precondition failure (ConditionalCheckFailedException, HTTP 412, an \[applied\] of false). This is the contention level measured directly; a step change means a row got hot or the predicate got wrong.
- **attempts per successful write** — For version-guarded read-modify-write loops, how many tries a success needed. A mean drifting above one, with a long tail, says contention is now being paid in latency rather than avoided.
- **retry exhaustions and oldest in-flight attempt** — Requests that gave up after their retry budget, and the age of the longest-running retry loop. Both are starvation indicators: the slowest writers keep losing to faster ones and never converge.
- **p99 latency of the guarded statement** — Measured including time queued on the row lock. It climbing while CPU sits idle is the fingerprint of serialization on one row, not of a saturated store.
- **conflict concentration by key** — The share of rejections landing on the top few rows. The same overall rejection rate spread across many rows scales fine; concentrated on one row it does not.

### Failure modes under load
<!--meta polarity=failure-->

- **hot-row serialization** — Every writer to one row queues behind it inside the store, so that row's ceiling is one critical section at a time however many app instances you add. It looks like a single endpoint's p99 climbing across an otherwise idle fleet.
- **retry storm at high contention** — Losers re-read and re-attempt at once, which adds load, which makes more of them lose. Without capped backoff and jitter, goodput can fall as offered concurrency rises.
- **silent zero-row loss** — A losing write is a no-op, not an error. An unchecked affected-row count lets the caller report success and any follow-on write land anyway — the ticket with no seat. It surfaces as data drift, never as an error rate, and load only widens the window.
- **counter-floor collision** — A predicate on an aggregate (available > 0) proves a unit exists, not which one. With several free, two writers both pass the guard and can be handed the same specific item; the duplicates only appear once concurrency is high enough for both to be in flight.
- **serialization failures at strict isolation** — Under serializable, conflicts that were silent at looser levels come back as errors instead, and that error rate scales with contention. Unhandled, they reach users as failed requests rather than as a retried write.

### Readiness checklist
<!--meta polarity=check-->

- Inspect the affected-row count (or the store's applied / precondition-failed result) on every guarded write and map zero rows to an explicit outcome — never let it fall through as success.
- Guard the actual contended row rather than a proxy aggregate whenever which item the caller gets matters.
- Guard a monotonic version or revision instead of a mutable business value wherever that value can round-trip A → B → A.
- Make any follow-on write depend on the guarded write having applied — a CTE feeding the insert, or an explicit affected-rows check inside the transaction.
- Decide per call site whether losing is retryable; where it is, cap the attempts, back off with jitter, and return a definite outcome when the budget runs out.
- Know the isolation level you run at and handle both loss shapes it can produce: a silent zero-row result and a serialization failure.
- Load-test the single hottest row at target concurrency — that row, not the fleet, sets the throughput ceiling.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Dealing with Contention](../../../themes/dealing-with-contention.md) — Fold the check into the write so the store guards it atomically {#fluency-dealing-with-contention}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Idempotency](../../messaging/idempotency.md) — A keyed conditional insert is how an idempotent handler wins the race against its own duplicate
- [Fencing Token](./fencing-token.md) — A conditional write is how a resource compares a fencing token without a race.

**Alternative to**

- [Sweeper](./sweeper.md) — a guarded write that checks expiry at read time removes the need for a background sweep — until an expiry has to notify someone
- [Pessimistic Locking](./pessimistic-locking.md) — Fold check and write into one statement with no application lock held; lock up front once the decision needs app code or the row is hot.

**Generalizes**

- [Optimistic Concurrency Control](./optimistic-concurrency-control.md) — Optimistic concurrency control (OCC) is a conditional write on a version column, wrapped in read-then-retry

**Enables**

- [Distributed Lock](./distributed-lock.md) — SET key NX is a conditional write; a lease lock is one plus a time to live (TTL)

**Often confused with**

- [Lock-Free](../../concurrency/lock-free.md) — The store-level form, where the compare is a predicate the database serialises

**Prevents**

- [Race Condition](../../../hazards/race-condition.md) — Check and write are one atomic store operation — no gap for another writer

**Exposed to**

- [Clock Skew](../../../hazards/clock-skew.md) — Can fall into clock skew when picking the winner by timestamp (last-write-wins) silently drops the newer update

**Demonstrated by**

- [Bitly](../../../designs/bitly.md) — Bitly relies on a conditional insert as the last line of defence for code uniqueness
- [Yelp](../../../designs/yelp.md) — the store, not the application, arbitrates the duplicate — the insert fails deterministically instead of racing
- [Online Chess](../../../designs/online-chess.md) — fencing a replaced owner with a guarded UPDATE is a conditional write used as a correctness fence against split-brain double-writes
- [Online Auction](../../../designs/online-auction.md) — the single-row compare-and-set that guards the contended high bid is a conditional write in its purest form
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — a redemption whose rowcount distinguishes expired from forged from already-spent, which a read-then-write cannot

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Each cloud database exposes a check-and-write primitive you can use directly.

<!-- relationships:end -->
