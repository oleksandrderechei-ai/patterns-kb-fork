---
title: Fencing Token
description: "A number that rises with each lock grant and is checked by the resource, so a holder that lost its lock without noticing cannot overwrite newer work."
area: distributed-coordination
owner: Oleksandr Derechei
tags: [coordination, isolation]
status: stable
aliases: [fencing, epoch number]
solves: [a paused worker woke up after its lock expired and overwrote data the new owner had already written, two processes both believed they held the lock and the stored value ended up wrong, an old leader kept writing to storage after a new leader took over, "timeouts cannot guarantee one writer, so I need the storage itself to refuse a late one", a stalled client retried its write minutes later and clobbered a newer result]
---

# Fencing Token

Issue a number that rises with every lock grant and have the protected resource refuse any write that carries a lower number than one it has already seen, so a holder that lost its lock without noticing cannot do harm.

## What it is
<!--meta block=description-->

A lock with an expiry cannot stop a slow holder from acting: after a long pause it still believes it holds the lock and overwrites newer work. A fencing token fixes this. Each grant carries a larger number, the holder attaches it to every write, and the resource rejects any number lower than the highest it has seen.

## Explained
<!--meta block=explain-->

A fencing token is a number that rises with every grant of a lock, and the protected resource uses it to refuse writes from a holder that lost the lock. The lock service gives each holder the next number, the holder attaches it to every write, and the resource keeps the highest number it has accepted and rejects any write below it. Choose it over a longer expiry when pauses, clock drift or slow retries can outlast any timeout you pick, because the expiry only shrinks the chance of two holders and the token refuses a stale holder's writes at the resource, though not its other side effects. The same number guards leader election, where it is called a term or an epoch.

- **Resource must check.** It stores the number and compares it in the same atomic step as the write. Use a conditional update.
- **Counter must not go back.** Keep it in a durable or replicated store that survives restarts.
- **Writes only.** A stale holder's other side effects still happen. A resource you cannot change needs an idempotent design instead.

**Example.** Client A takes the lock for a nightly report job and gets token 33. It stalls for 40 s in a garbage-collection pause and the 30 s lock expires. Client B takes the lock with token 34 and writes its report, so the store records 34. At 40 s A wakes, still believes it holds the lock, and writes with 33. The store sees 33 is below 34 and refuses it, and A learns it lost the lock. Without the check, A's older report would replace B's. The cost is one integer per guarded row and one comparison per write.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does the safety come from when the lock itself can be wrong? The lock service issues a larger number with each grant at 1 and 2, the holder stamps it on its write at 3, and the resource compares it with the highest number it has kept at 4 and 5 before it applies anything."
flowchart LR
    A["Client"]
    L["Lock service"]
    R["Protected resource"]
    subgraph Check["The resource keeps this"]
        S[("Highest token accepted")]
    end
    A -->|"1 acquire"| L
    L -->|"2 granted, token 34"| A
    A -->|"3 write, stamped 34"| R
    R -->|"4 34 is at least the highest?"| S
    S -->|"5 yes: store 34"| R
    R -->|"6 apply the write"| A
```

```mermaid caption="What happens to a client that lost its lock without noticing? A holds token 33 and pauses, the lock moves to B with 34, B's write sets the highest to 34, and A's late write at 33 fails the comparison and is refused."
sequenceDiagram
    autonumber
    participant A as Client A
    participant L as Lock service
    participant B as Client B
    participant R as Resource
    A->>L: acquire
    L-->>A: token 33
    Note over A: pause, lease expires
    B->>L: acquire
    L-->>B: token 34
    B->>R: write, token 34
    R-->>B: applied, highest is 34
    A->>R: write, token 33
    R--xA: rejected, 33 is below 34
    Note over A: stop work, drop the lock
```

The lock service issues each grant a number from a counter that only goes up, and the holder sends it with every request to the resource. The resource compares the number with the highest it has stored for that lock. It accepts an equal or higher number, so a holder can write many times under one grant, and it rejects a lower one. It must store the highest number and apply the write as one atomic step, or two writes can pass the check together.

A rejection carries information: it tells the writer its lock is gone. A well-behaved client stops, drops its in-memory work and starts over, since carrying on would only produce more rejected writes.

## Variations
<!--meta block=variations-->

- **Counter from the lock service** — The service hands out a per-lock counter, such as a revision number in an etcd key or a sequence from ZooKeeper. The counter must survive a restart of the service and never go backwards, so a plain in-memory counter that resets is a bug.
- **Epoch or term number** — A consensus protocol gives each leader a term, and every follower and storage node rejects messages from a lower one. This is the fencing token built into [Leader Election](./leader-election.md) and [Quorum & Consensus](./quorum-consensus.md).
- **Guarded column** — The token is stored in a column and each write is a [Conditional Write](./conditional-write.md) such as `UPDATE … SET value = ?, fence = ? WHERE key = ? AND fence <= ?`. It needs no new service and makes the check and the apply one atomic statement.
- **Signed sequencer** — The lock service returns a signed string that names the lock, the mode and a generation number, and the resource verifies it before it acts. Chubby calls this a sequencer; the resource still needs the latest generation it has seen, or a call back to the lock service, to reject a stale one.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Safe against clock drift and pauses** — once the resource checks atomically and the counter stays monotonic: a stale holder's write is refused by comparison, so correctness does not depend on the term being long enough.
- **One cheap comparison per write** — the cost is a stored number and an integer check, which a conditional write already pays for.
- **Works with any grant scheme** — a lease, a lock, an election or a manual promotion can all issue the number.
- **A rejection tells the holder it lost** — the writer learns its lock is gone at the first refused write and can stop, not at the end of its work.

### Cons
<!--meta polarity=con-->

- **The resource must cooperate** — a third-party API, a file system or an email send cannot compare numbers, so you either add a guard in front of it or accept a rare double action.
- **The counter must never go backwards** — a lock service that restarts and resets it makes a stale holder look new, so back it with a replicated or durable store.
- **The resource keeps state per lock** — it stores the highest number and updates it atomically with the write, which adds a column or a record to every guarded item.
- **It protects writes, not reads** — a stale holder can still read old data and act on it elsewhere, so keep its other side effects idempotent or check the token there too.
- **Ordering, not exclusion** — a stale write that reaches the resource before the newer holder's first write is accepted, and a lock covering several resources is fenced only where each one checks.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A late write would corrupt data** — a stalled worker, a paused leader or a slow retry must never overwrite a newer holder's result.
- **You cannot bound pauses or clock drift** — garbage collection, a swapped-out process or a virtual machine freeze can outlast any term you pick.
- **You own the protected store** — it is a database you can add a column to, or a service you can make compare a number.

### Avoid when
<!--meta polarity=avoid-->

- **The resource cannot check a number** — the lock alone cannot make it safe, so add a gateway that fences for it, which helps only if it is the sole path to the resource, or make the work idempotent, and use [Optimistic Concurrency Control](./optimistic-concurrency-control.md) wherever the store supports a version check.
- **One database transaction covers the work** — a row lock with [Pessimistic Locking](./pessimistic-locking.md) or a [Conditional Write](./conditional-write.md) needs no token.
- **A rare double grant is harmless** — a soft reservation or a duplicate-safe job does not need the extra state on every write.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a resource that rejects any write whose token is below the highest it has accepted"
interface Row { value: string; fence: number }

class FencedStore {
  private rows = new Map<string, Row>();

  // The check and the write are one step: this method does not yield between them.
  write(key: string, value: string, token: number): boolean {
    const current = this.rows.get(key);
    if (current && token < current.fence) return false; // stale holder: refuse
    this.rows.set(key, { value, fence: token });        // equal or newer: accept
    return true;
  }
}

const store = new FencedStore();
store.write("report", "from B", 34); // true: B holds the newest grant
store.write("report", "from A", 33); // false: A woke up after its lock expired
// In a database the same check is one conditional UPDATE ... WHERE fence <= :token.
```

## In the wild
<!--meta block=wild-->

- **Google Chubby sequencers** — Burrows' 2006 Chubby paper describes a sequencer, a string naming the lock, its mode and a lock generation number, which a holder passes to a server so the server can reject a request from a holder whose lock has changed. {#wild-chubby}
- **Apache Kafka producer epoch** — A transactional producer is registered under a transactional id with an epoch that rises each time a new producer with that id starts, and the broker rejects writes from a producer with an older epoch, which fences a zombie instance. {#wild-kafka}
- **etcd key revisions** — Every etcd key carries a create revision and a mod revision drawn from a cluster-wide counter that only increases, so a client can use one as a fencing token that a resource compares. {#wild-etcd}
- **Raft terms** — Each election in Raft starts a new term, and a node that sees a message with a higher term steps down while one that sees a lower term rejects it, which fences an old leader the same way. {#wild-raft}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **token source** — where the counter lives: a consensus-backed store revision, a database sequence or a term number; it must be durable and must never reset after a restart
- **granularity** — one counter per lock or one per resource; a per-lock counter lets unrelated locks proceed, a shared counter orders every grant
- **comparison rule** — reject only a strictly lower number and accept an equal one, so a holder can write many times under one grant
- **stale-write handling** — what a client does after a rejection: stop at once, drop in-memory work and re-acquire

### Signals to watch
<!--meta polarity=signal-->

- **stale-write rejections** — writes refused for a low token; a steady trickle means holders are being paused past their term and a burst means a lock service problem
- **grants per lock** — how fast the token rises; frequent grants mean flapping ownership
- **token gaps or regressions** — a number that goes backwards, the sign the counter was reset
- **time between grant and first write** — a long gap shows holders stalling before they act

### Failure modes under load
<!--meta polarity=failure-->

- **counter reset** — the lock service restarts with an in-memory counter and issues numbers below ones the resource has accepted, so a stale holder passes the check
- **unfenced path** — one writer reaches the resource without the check, such as an admin script or a second service, and corrupts data the guard was meant to protect
- **non-atomic check** — the resource reads the highest number and writes in two steps, so two writers pass the check together
- **retry storm** — clients that treat a rejection as a transient error retry forever instead of dropping the lock

### Readiness checklist
<!--meta polarity=check-->

- Check the token in the same atomic step as the write, with a conditional update or a transaction
- Keep the counter durable and monotonic across restarts and failover of the lock service
- Send the token on every write path to the resource, including scripts and batch jobs
- Make clients stop and drop their lock on a rejection
- Test a holder paused past its lock term and confirm its write is rejected

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Dealing with Contention](../../../themes/dealing-with-contention.md) — The check that stays safe when a paused holder wakes after its lease expired: its older number is refused. {#fluency-dealing-with-contention}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Failover](./failover.md) — Failover is a place where a rising token stops the deposed node from writing.
- [Lease](./lease.md) — A fencing token backs a lease, so a holder that lost it to expiry cannot still write.
- [Optimistic Concurrency Control](./optimistic-concurrency-control.md) — Compares a number issued at grant time, where optimistic control compares a version read from the row.
- [Conditional Write](./conditional-write.md) — The guard is usually a conditional write that checks the token and applies the value in one atomic step.
- [Leader Election](./leader-election.md) — Leader election is where the rising token comes from: each new leader takes the next term.
- [Quorum & Consensus](./quorum-consensus.md) — A consensus group issues each leader a term, and storage rejects any lower term, which is the token.
- [Idempotency](../../messaging/idempotency.md) — Where the resource cannot compare a token, make the write safe to replay instead.

**Alternative to**

- [Pessimistic Locking](./pessimistic-locking.md) — A row lock holds inside one transaction on one store; a token is for a lock that spans servers where the holder can pause.

**Requires**

- [Distributed Lock](./distributed-lock.md) — Hands out a rising number with each grant of the lock for the resource to check.

**Prevents**

- [Clock Skew](../../../hazards/clock-skew.md) — Fencing holds even when clocks disagree about when a lease ended.
- [Split-Brain](../../../hazards/split-brain.md) — Refuses writes from a deposed holder so two writers cannot both succeed.

<!-- relationships:end -->
