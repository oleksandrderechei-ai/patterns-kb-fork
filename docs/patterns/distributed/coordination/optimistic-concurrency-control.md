---
title: Optimistic Concurrency Control
description: "Detect write conflicts with a version check and retry, instead of locking"
area: distributed-coordination
owner: Oleksandr Derechei
tags: [concurrency, throughput]
status: stable
aliases: [OCC, optimistic locking]
solves: [locking every read kills throughput but real conflicts are rare, two users edit the same record and the last save silently wipes the first's change, I don't want to hold a database lock across a user's think-time, the record changes while my code is halfway through working out the new value, my API accepts a save from a client that was working off an old copy]
---

# Optimistic Concurrency Control

A concurrency strategy that bets conflicts are rare: read a record together with a version marker, do the work without holding any lock, then commit the write only if the version is still what you read — and if another writer got there first, reload the fresh state and try again.

## What it is
<!--meta block=description-->

Two people editing the same row can silently overwrite each other, and locking the row while one of them thinks freezes it for everyone. Optimistic concurrency control holds no lock. You read the row with its version, do your work, and write only if the version is unchanged. If you lost the race, you reload and retry. It suits rare collisions.

## Explained
<!--meta block=explain-->

Optimistic concurrency control lets you read a row with its version number, do your work holding no lock, and write back only if the version is still the one you read. If someone else wrote first, zero rows change, you know you lost, and you reload and try again. The check is a [conditional write](conditional-write.md) on the version. Choose it over [locking the row](pessimistic-locking.md) when two writers rarely hit the same row and the time between read and write is long or human, such as an open edit form, because nothing is held while you think and no reader queues behind a writer.

- **You own the retry loop.** The work must replay on changed data. Redo it from fresh state rather than patching the old result.
- **Retry storms.** On one hot row with many writers, losers redo work and can cost more than a lock. Cap retries and back off.
- **Fooled by ABA.** An equality check misses a value that changes and changes back. Use a version that only ever increases.

**Example.** Alice and Bob both open document 7 at version 12 and each spends 2 minutes editing. A lock would have frozen the document for 2 minutes. Alice saves first with WHERE version = 12, the update changes 1 row, and the version becomes 13. Bob saves with version 12, changes 0 rows, and sees a conflict, so his editor reloads version 13 and asks him to merge. Now 10 writers hit one counter row at once and every loser retries immediately with no backoff. One wins per round, so the attempts are 10 + 9 + ... + 1 = 55, where a lock would make 10. That is 5.5 times the work, a worst case.

## How it works
<!--meta block=structure-->

```mermaid caption="How do two writers share one row without either holding a lock? Both read the same version and neither waits; the conditional update lets the first one through and tells the second its copy is stale."
flowchart LR
    A["Writer A"]
    B["Writer B"]
    subgraph CAS["One atomic check-and-set"]
        Row[("Row: data + version")]
    end
    A -->|"1 read data, version 42"| Row
    B -->|"2 read data, version 42"| Row
    A -->|"3 update where version = 42, set 43"| Row
    Row -->|"4 one row changed, A committed"| A
    B -->|"5 update where version = 42"| Row
    Row -->|"6 zero rows changed, B reloads and replays"| B
```

```mermaid caption="No lock is held across think-time; the losing writer detects the conflict from the unchanged version, reloads, and retries against the fresh state."
sequenceDiagram
    autonumber
    participant A as Client A
    participant B as Client B
    participant DB as Store (row: version=42)
    A->>DB: SELECT (reads version 42)
    B->>DB: SELECT (reads version 42)
    Note over A,B: both hold version 42, no lock
    A->>DB: UPDATE SET version=43 WHERE version=42
    DB-->>A: 1 row changed, A commits
    B->>DB: UPDATE SET version=43 WHERE version=42
    alt version still unchanged
        DB-->>B: 1 row changed
    else A committed first (version now 43)
        DB--xB: 0 rows changed, conflict
        B->>DB: reload, UPDATE WHERE version=43
        DB-->>B: 1 row changed, retry wins
    end
```

## Variations
<!--meta block=variations-->

- **Dedicated version column** — A `version` integer bumped by one on every write, regardless of whether any business field changed. The safest form: because it only ever increases, the equality check cannot be fooled by a value round-tripping back to what you read.
- **Business value as version** — Reuse a column that already changes — a seat count, the current high bid — as the concurrency token, avoiding an extra column. Sound only if that value moves in one direction; otherwise it is exposed to the ABA problem, where a review count of 100 dips to 99 and returns to 100 and the check sees "unchanged" while something happened in between.
- **Full-row / whole-record compare** — With no version column, put every field you read into the `WHERE` clause so the write applies only if the entire row still matches. Heavier, but it catches any change including a round-trip — the fallback when you cannot add a version.
- **Store-native row version** — Let the engine supply the token instead of hand-rolling one: PostgreSQL's `xmin` system column, an Elasticsearch document's `_seq_no`/`_primary_term`, an etcd key's mod-revision, or an HTTP `ETag`. The commit conditions on the value the store handed you at read time.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No lock is held across think-time**, so readers never block on a writer and connections are not pinned waiting.
- **Cheap on the common path** — when conflicts are rare the whole cost is one extra column in a `WHERE` clause.
- **No lock manager to run and no deadlocks**: there is no lock to acquire in the wrong order.
- **Works where a shared lock cannot reach** — across stateless app servers, or over HTTP with an `ETag`, where there is no connection to hold a lock on.

### Cons
<!--meta polarity=con-->

- **Thrashes under high contention**: many writers on one hot row means most of them lose, retry, and lose again — a [retry storm](../../../hazards/retry-storm.md) that does more work than a lock would.
- **The loser's work is discarded and redone**; without bounded retries and backoff, contention can starve slow writers and waste capacity.
- **An equality version check** is blind to the ABA problem unless the token strictly increments on every write.
- **The caller owns the reload-and-retry loop**; skip it and a conflict becomes a silent lost update instead of a caught one.
- **Retries assume the work can simply replay** — awkward when the read-modify-write had visible side effects between the read and the failed commit.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Conflicts are the exception and reads dominate writes** — such as admin edits or work spread across distinct records.
- **A read-modify-write cycle needs application** logic between the read and the write, so a single conditional write is not enough.
- **You must not hold** a database lock across a user's think-time or an external call.
- **The coordination must span stateless** servers or a stateless protocol where no shared lock exists — a version attribute or an `ETag` travels with the data.

### Avoid when
<!--meta polarity=avoid-->

- **Contention on a single row is high** — retries pile up and [pessimistic locking](./pessimistic-locking.md), which serializes cleanly, is cheaper overall.
- **The redone work is expensive** or has side effects that cannot simply be replayed on retry.
- **The invariant spans multiple rows** with no single row to version (write skew) — that needs a stricter isolation level, not a per-row check.
- **There is no monotonic token** available and the value you would compare on can round-trip — the equality check would miss the change.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — read a version, work, commit-if-unchanged, retry on conflict"
// Read the row + its version, mutate off-line, then write conditioned on the
// version. Zero rows changed means someone committed first: reload and retry.
async function updateWithOcc(
  db: Db,
  id: string,
  mutate: (row: Row) => Row,
  maxAttempts = 5,
): Promise<Row> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const row = await db.one(`SELECT * FROM docs WHERE id = $1`, [id]);
    const next = mutate(row); // think-time — no lock is held here

    const { rowCount } = await db.query(
      `UPDATE docs SET body = $1, version = version + 1
       WHERE id = $2 AND version = $3`,
      [next.body, id, row.version],
    );
    if (rowCount === 1) return next; // our version was still current — we won

    // Lost the race. Wait a random time up to the exponential delay (jitter), so losers do not return in lockstep, then reload and retry.
    if (attempt < maxAttempts - 1) await sleep(Math.random() * 2 ** attempt * 10);
  }
  throw new Error(`OCC gave up after ${maxAttempts} conflicting attempts`);
}

```

## In the wild
<!--meta block=wild-->

- **Elasticsearch optimistic concurrency** — Every document carries a \_seq_no and \_primary_term; an index or update request can supply if_seq_no and if_primary_term, and Elasticsearch applies the write only if the document still matches those values, returning 409 Conflict otherwise. It is Elasticsearch's built-in optimistic concurrency control. {#wild-elasticsearch-occ}
- **DynamoDB conditional update on a version attribute** — The common OCC recipe on DynamoDB: keep a numeric version attribute on the item and issue UpdateItem with a ConditionExpression like version = :expected while setting version = version + 1; a concurrent writer working from a stale version fails with ConditionalCheckFailedException and retries. {#wild-dynamodb-version}
- **PostgreSQL** — Application-level OCC adds an explicit version column checked and incremented in the UPDATE ... WHERE id = ? AND version = ?; an affected-row count of zero signals a conflict. Postgres also exposes the xmin system column, the row-version left by multi-version concurrency control (MVCC), which can serve as the token without a hand-rolled column. {#wild-postgres-version}
- **HTTP ETag + If-Match** — A resource is served with an ETag validator; a later PUT or PATCH sends If-Match with that ETag, and the origin applies the change only if the resource still carries it, replying 412 Precondition Failed on a stale write (409 Conflict is an API's own convention, not the status HTTP defines for a failed If-Match) — optimistic concurrency across a stateless protocol with no lock to hold. {#wild-http-etag-ifmatch}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Retry budget** — The cap on attempts, or a wall-clock deadline, after which a conflict is surfaced as an error instead of retried. Too low turns ordinary contention into user-visible failures; too high lets one hot key soak up capacity redoing work it will lose again.
- **Backoff and jitter between attempts** — The delay curve a loser waits before reloading and re-writing — fixed interval, capped exponential, or randomized. Randomization is the part that matters: without it every loser wakes at the same instant and collides again in lockstep.
- **The precondition — what the write is checked against** — A dedicated version column, an existing business value, the whole prior row in the WHERE clause, or a token the store hands you at read time (a PostgreSQL xmin, an Elasticsearch \_seq_no/\_primary_term pair, an HTTP ETag). Only a token that strictly increases on every write is safe against a value that leaves and returns. xmin is a transaction id, not a counter, and an ETag is often a content hash, so treat both as equality tokens and mind xmin wraparound.
- **Versioning granularity** — Whether one token covers a whole record or a narrower part of it. A coarse token rejects edits that never actually overlapped, inflating the conflict rate; a fine one cuts conflicts but stops protecting any invariant that spans the fields it no longer covers.
- **Where the retry loop lives** — Retry server-side and hide the conflict from the caller, or return a conflict status (409, or 412 on a failed If-Match) and let the client reload and resubmit. Client-side is the only honest choice when the merge needs a human decision rather than a blind replay.

### Signals to watch
<!--meta polarity=signal-->

- **Conflict rate** — Share of conditional writes that fail the precondition — zero rows affected, an HTTP 412 or 409, a ConditionalCheckFailedException. The headline number: the optimistic bet is only paying while this stays low.
- **Attempts per successful write** — The distribution, not the mean. A mean near one with a fat tail is the normal shape and says a few keys are contended while the rest are quiet; a rising body means contention has spread.
- **Give-up rate** — Writes that exhausted the retry budget and returned an error. Each one is work done twice or more and then thrown away, with a caller told to try again.
- **Read-to-commit window** — Elapsed time between reading the version and issuing the conditional write. Conflict probability scales with this window, so a slowdown anywhere inside it — an external call, a slow render, a user's think-time — raises the conflict rate with no increase in traffic.
- **Conflicts per key** — Whether failed preconditions are spread across the keyspace or concentrated on a handful of rows. Concentration is the signature of a hot row that needs a different strategy, and the aggregate rate hides it.

### Failure modes under load
<!--meta polarity=failure-->

- **Retry storm on a hot key** — Concurrency on one row outruns the rate at which winners commit, so most writers lose and re-read, and those retries are themselves load. Conflict rate on that key climbs toward (n-1)/n for n concurrent writers, latency and CPU rise, and useful throughput on the key falls while the rest of the keyspace looks healthy.
- **Lockstep retries** — Losers that back off by the same fixed amount return at the same instant and collide again. Throughput oscillates in waves instead of degrading smoothly, and adding capacity does not help because the collisions are synchronized, not saturated.
- **Starvation of the slow writer** — The longer a caller holds a version before committing, the likelier it is to lose. Under load the writers with long think-time or heavy work never win while quick writers sail through — a fairness failure that an aggregate success rate hides completely.
- **Side effects replayed on retry** — Work done between the read and the failed commit that was not confined to the store — a message sent, an external call made, an event published — happens again on every attempt. A rising conflict rate turns what was a rare duplicate into a routine one.
- **ABA slip on a non-monotonic token** — When the token is a business value that can return to a previous value, a higher write rate makes the round trip likelier. The equality check reads unchanged while a write did land, so the update is lost silently — no error, no retry, nothing in the conflict rate.

### Readiness checklist
<!--meta polarity=check-->

- Bound the retry loop with a maximum attempt count or a deadline, and define exactly what the caller sees when it is exhausted.
- Randomize the backoff between attempts so losers do not all return at the same moment and collide again.
- Check the outcome of every conditional write — the affected-row count, or the precondition-failed status — and never let a zero-row update pass as success.
- Use a token that strictly increases on every write, or compare the whole prior record, so the equality check cannot be fooled by a value that returns to itself.
- Keep side effects out of the retried section, or make them idempotent, so a replayed attempt cannot duplicate them.
- Load-test the hottest key at the concurrency you actually expect, and decide in advance what that key falls back to — a lock, or serializing it through a queue — if the conflict rate does not hold.
- Alert on give-up rate and on conflicts concentrating in a few keys; both say the optimistic bet has stopped paying there.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Dealing with Contention](../../../themes/dealing-with-contention.md) — Bet no one else wrote, verify the bet at write time, retry the rare loser {#fluency-dealing-with-contention}
- [Data Platform](../../../themes/data-platform.md) — Detect the conflict the store would have discarded {#fluency-data-platform}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Unit of Work](../../enterprise/unit-of-work.md) — The flush is the natural place to check versions before writing
- [Minimize Coordination](../../../principles/minimize-coordination.md) — Checking at commit replaces a lock held for the whole transaction
- [Identity Map](../../enterprise/identity-map.md) — The map makes stale reads likely inside a long unit, so version checks guard the save.
- [Fencing Token](./fencing-token.md) — A version check guards writers by what they read, and a fencing token guards them by the lock they held.
- [Retry with Backoff](../resilience/retry-backoff.md) — A loser's wait between reload and rewrite is capped, jittered backoff, so a hot row does not collapse into lockstep retries.

**Alternative to**

- [Pessimistic Locking](./pessimistic-locking.md) — Detect-and-retry when collisions are rare; lock up front when they're frequent
- [Distributed Lock](./distributed-lock.md) — Checks a version at write time instead of holding anything, so a stalled client cannot block the others
- [Vector Clock](./vector-clock.md) — A single version number needs one place to check it, where a vector clock works across replicas with no leader.

**Specializes**

- [Conditional Write](./conditional-write.md) — Optimistic concurrency is the read-version / conditional-write / retry loop built on this primitive

**Often confused with**

- [Lock-Free](../../concurrency/lock-free.md) — The transactional form of the same optimism, across a whole read-modify-write cycle

**Prevents**

- [Race Condition](../../../hazards/race-condition.md) — A stale version fails the write, so a lost update is caught and retried

**Demonstrated by**

- [Yelp](../../../designs/yelp.md) — concurrent reviews for one business would clobber each other's rating without a check-and-retry on the version
- [Gopuff](../../../designs/gopuff.md) — commit-time serialization-failure detection by the database is optimistic concurrency control with no explicit locking
- [Google Docs](../../../designs/google-docs.md) — edits proceed optimistically without waiting for a lock or confirmation and are merged after the fact instead of blocking
- [Online Chess](../../../designs/online-chess.md) — the lock-free compare-and-claim on a hot, heavily contended pool is optimistic concurrency at its purpose-built best
- [Ticketmaster](../../../designs/ticketmaster.md) — the last-line double-booking guard is a version check that lets a single concurrent write commit and rejects the rest
- [Online Auction](../../../designs/online-auction.md) — auction bidding is the ideal optimistic concurrency control (OCC) case since true collisions are rare, so a lock-free conditional retry beats holding a lock
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — a long know your customer (KYC) flow guards each state change with a version check, so the loser of a race writes nothing and needs no rollback
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — the guard doubles as the ordering key, so a lost update and a stale delivery are stopped by one constraint

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Version tags and condition checks in managed stores implement the compare step for you.

<!-- relationships:end -->
