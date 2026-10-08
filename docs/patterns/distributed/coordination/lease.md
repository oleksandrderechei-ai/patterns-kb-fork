---
title: Lease
description: "A grant of a resource for a fixed time that the holder must renew; if it stops renewing, the grant lapses by itself and the resource is free to give away."
area: distributed-coordination
owner: Oleksandr Derechei
tags: [coordination, isolation, availability]
status: stable
aliases: [TTL lock]
solves: [a worker died holding ownership of a shard and nothing frees it until someone notices and clears it by hand, one node must be the only writer for a while and step down by itself if it loses contact, a client cache copy may be stale and I cannot tell when to stop trusting it, a machine that is gone still holds its address or name and nothing gives it back, an owner crashed and other nodes cannot tell whether it is dead or only slow]
---

# Lease

Grant a right to a resource for a fixed time that the holder must renew: while it renews, the right stays its own, and when it stops, the right lapses by itself and someone else can take it.

## What it is
<!--meta block=description-->

Without an expiry, a claim outlives its holder: a worker crashes and the shard sits idle until a person clears the claim. A lease is a grant with a deadline. The holder must renew it, and if renewals stop, the grantor waits out the term and gives the resource to someone else. It assumes both sides agree how long a second is, so pair it with a fencing token.

## Explained
<!--meta block=explain-->

A lease is a grant of a resource for a fixed time. The holder must renew it before the time runs out, and if it stops renewing, the grant lapses and the resource can go to someone else. The grantor, the process that hands the resource out, records who holds it and until when, and promises not to grant it again before then. Choose it over a lock with no expiry when the holder can crash without cleaning up, because a lock nobody releases stays held until a person finds it. A lease is the time-bound core of a [distributed lock](distributed-lock.md).

- **Stale holder.** A holder that pauses past the deadline still believes it owns the resource. Have the resource check a \[fencing token\](fencing-token.md).
- **The term is a bind.** Short loses leases to jitter, long leaves a dead holder's resource idle. Set it from your measured worst pause.
- **Cut-off holders stop.** A healthy holder cut off from the grantor must stop at the deadline. Check your own clock before every step.

**Example.** A shard owner takes a lease with a 10 s term and renews every 3 s. At 4 s it crashes, so renewals stop. The last renewal ran at 3 s and moved the expiry to 13 s, so the grantor refuses every other caller until 13 s. At 13 s a second worker takes the shard, so recovery cost at most 10 s of idle shard and no human. If the owner had only paused until 14 s, it would wake up believing it still owns the shard, so the shard's storage must reject its late writes.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a holder keep a resource without a human cleaning up after it? The grantor records owner and expiry at 1 and 2, the holder works only inside the term at 3, and each renewal at 4 and 5 pushes the expiry forward; if renewals stop, the record simply runs out."
flowchart LR
    H["Holder"]
    G["Grantor"]
    R["Resource"]
    subgraph Term["One term — owner and expiry"]
        L[("Lease record")]
    end
    H -->|"1 ask for the lease, term 10 s"| G
    G -->|"2 record owner, expiry = now + 10 s"| L
    G -->|"3 granted"| H
    H -->|"4 work while the lease is valid"| R
    H -->|"5 renew at 3 s, before the term ends"| G
    G -->|"6 move expiry forward"| L
```

```mermaid caption="What happens when a holder stops renewing? A renews and then crashes, the grantor waits out the term, and B is granted the lease. If A had only paused, the wake-up at 14 would still be a stale holder, which is why the resource must fence."
sequenceDiagram
    autonumber
    participant A as Holder A
    participant G as Grantor
    participant B as Holder B
    A->>G: acquire, term 10 s
    G-->>A: granted, expires at 10
    A->>G: renew at 3 s
    G-->>A: expires at 13
    Note over A: crash, or a pause, at 4 s
    B->>G: acquire at 8 s
    G-->>B: refused, A still holds until 13
    B->>G: acquire at 13 s
    G-->>B: granted, expires at 23
    Note over A: wakes at 14 s and still believes it holds the lease
```

The walk starts when the holder asks for the lease and the grantor records the owner and an expiry, the current time plus the term. The holder then works, checking before each step that its own clock says the lease is still valid, with a margin for clock drift. At one third of the term or sooner, it asks to renew, and the grantor moves the expiry forward. A refusal to a second caller is the grantor keeping its promise.

If the holder crashes, renewals stop and the grantor waits until the recorded expiry, plus a drift allowance that mirrors the holder's margin, before it grants the resource again. The grantor never revokes early, because it cannot tell a crash from a pause. That wait is the recovery time, so it is set by the term you choose. A grantor that restarts and loses its records must persist leases or refuse every grant for one full term plus the drift allowance, or it can grant a live lease twice.

## Variations
<!--meta block=variations-->

- **Fixed term with renewal** — The base form: a term of seconds, renewed at a fraction of it. Short terms recover fast but renew often, and long terms renew rarely but leave a crashed holder's resource idle for the whole term.
- **Session-bound lease** — One session lease per client covers everything that client owns, and every key it created vanishes when the session lapses. etcd leases and ZooKeeper sessions work this way, so one renewal stream keeps thousands of keys alive.
- **Read lease** — The server promises a client that a cached copy stays valid until the lease ends, and it either tells the client before it changes the data or waits out the lease. This is the original use in Gray and Cheriton's file cache.
- **Leader lease** — A leader holds a lease so it can serve reads from its own state without asking a quorum each time, which is sound only while clocks drift less than the margin. It is the same lease inside [Leader Election](./leader-election.md), where the role is what is leased.
- **Lease on an identifier** — An address or a name is granted for a term and returns to the pool when the holder stops renewing. DHCP leases an IP address in exactly this way, so a machine that vanishes gives its address back by itself.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Crashed holders clean up after themselves** — the grant lapses at the deadline, so no one clears it by hand and no separate failure detector is needed, only a term longer than the worst pause.
- **Recovery time is known in advance** — a resource is idle for at most one term after its holder dies, which you can put in a recovery target, provided clock drift stays within the safety margin and the grantor itself is up.
- **Needs agreement on duration only** — the two sides compare how long a term lasts, not what time it is, so clocks may disagree on the hour if they tick at nearly the same rate.
- **Renewal is cheap while the holder is healthy** — one small message per third of a term keeps the grant, however long the work runs.

### Cons
<!--meta polarity=con-->

- **A paused holder keeps acting after the lease is gone** — a stall longer than the term leaves two parties who both believe they own the resource, so add a [Fencing Token](./fencing-token.md) checked at the resource.
- **Term length is a bind** — a short term loses leases to ordinary jitter, and a long term leaves a dead holder's resource idle, so set it from your measured worst pause and your recovery target.
- **The holder must stop when it cannot renew** — a healthy holder cut off from the grantor loses the resource at the deadline, so the grantor is a dependency of every holder and needs its own redundancy, replicated with consensus rather than plain copies, or it can grant one resource twice.
- **Early revocation is impossible** — the grantor cannot take a lease back before expiry without the holder's help, so a stuck but renewing holder keeps the resource until you stop it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A holder may vanish without cleanup** — a worker owns a shard, a job or a cached copy, and the claim has to free itself when the worker dies.
- **You need a known worst-case recovery time** — a resource may be idle for one term after a failure and not for as long as a person takes to notice.
- **A node must act alone for a while** — a leader or a shard owner serves from its own state and steps down by itself when it loses contact.

### Avoid when
<!--meta polarity=avoid-->

- **A stale holder's write would corrupt data** and the resource cannot check a number — put a [Fencing Token](./fencing-token.md) in front of it first, or drop the lease and use a [Conditional Write](./conditional-write.md).
- **The exclusive section fits in one database transaction** — a row lock with [Pessimistic Locking](./pessimistic-locking.md) is simpler and carries no clock assumption.
- **You cannot bound pauses or clock drift** — a role that must never be doubled belongs to [Quorum & Consensus](./quorum-consensus.md), where a term number decides, not a clock.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a lease that renews at a third of its term and stops work before it can expire"
interface Grantor {
  acquire(key: string, ttlMs: number): Promise<boolean>;
  renew(key: string, ttlMs: number): Promise<boolean>;
}

class Lease {
  private validUntil = 0; // local monotonic time, never the wall clock

  constructor(private g: Grantor, private key: string,
              private ttlMs: number, private marginMs: number) {}

  async start(): Promise<boolean> {
    const asked = performance.now();
    if (!(await this.g.acquire(this.key, this.ttlMs))) return false;
    // Count from when we asked: network delay shortens the lease, never lengthens it.
    this.validUntil = asked + this.ttlMs;
    // Keep the handle; clear it and mark the lease lost once validUntil passes
    // with no successful renewal, and when the work is done.
    setInterval(() => this.renew(), this.ttlMs / 3);
    return true;
  }

  private async renew() {
    const asked = performance.now();
    const ok = await this.g.renew(this.key, this.ttlMs).catch(() => false);
    if (ok) this.validUntil = asked + this.ttlMs;
    // A refusal or error means the lease may be lost: holds() turns false at the margin,
    // so work stops. Pass the fencing token from acquire/renew with every write to the resource.
  }

  // Call before every step of work; stop at once when it is false.
  holds = () => performance.now() < this.validUntil - this.marginMs;
}
```

## In the wild
<!--meta block=wild-->

- **etcd** — A client grants a lease with a time to live (TTL) and keeps it alive with keep-alive requests, and every key attached to the lease is deleted when the lease expires. This is how etcd-based locks and elections free themselves after a crash. {#wild-etcd}
- **Kubernetes Lease objects** — The coordination.k8s.io Lease API object records a holder and a renew time. Controllers use it for leader election, and each kubelet renews a Lease as its node heartbeat. {#wild-kubernetes}
- **Google Chubby** — Described in Burrows' 2006 paper: a client keeps a session lease alive with KeepAlive calls, and its locks and cached data stay valid only while the session lease holds. {#wild-chubby}
- **DHCP address leases** — A server grants an IP address for a lease time and the client renews it before the end. An address whose client disappears returns to the pool when the lease runs out. {#wild-dhcp}
- **Apache ZooKeeper sessions** — A client session has a timeout and is kept alive by the client's pings. When the session expires, the ephemeral nodes it created are removed, which is how ZooKeeper locks and group membership release a crashed holder. {#wild-zookeeper}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **lease term** — how long a grant lasts without renewal; it is also the longest idle time after a holder dies, so set it above your worst measured pause and below your recovery target; if no term satisfies both, shorten the pauses or add a fencing token and accept the longer term
- **renewal interval** — how often the holder renews, as a fraction of the term such as one third, so a single lost renewal does not cost the lease
- **safety margin** — how long before its local deadline the holder stops work, sized to the clock drift you can bound over one term
- **renewal jitter** — a random offset on each holder's renewal timer so thousands of leases do not all renew in the same instant

### Signals to watch
<!--meta polarity=signal-->

- **time left at renewal** — how much of the term remains when each renewal lands; a shrinking value predicts a loss
- **renewal failures and latency** — missed or slow renewals per holder, each one a holder close to losing its lease
- **leases lost while working** — leases that expired before the holder released them; the number to alert on
- **grantor request rate** — grows with the number of holders divided by the renewal interval, and sizes the grantor

### Failure modes under load
<!--meta polarity=failure-->

- **pause past the term** — a holder wakes up and acts on a lease it no longer holds, so two holders write until a fencing check stops the old one
- **grantor outage** — every healthy holder stops at its deadline at once, a full outage caused by the coordination service
- **clock step** — a time-sync correction moves the wall clock and a term measured on it ends early or late, so measure terms on a monotonic clock
- **renewal spike** — every holder renews in the same instant and the grantor sees a periodic load spike

### Readiness checklist
<!--meta polarity=check-->

- Measure the term on a monotonic clock, never the wall clock
- Renew at a third of the term or sooner, and check the lease before every step of work
- Put a fencing token at the resource when a stale write would corrupt data
- Test a pause longer than the term, for example with SIGSTOP, and confirm the old holder is rejected
- Alert on leases lost while the holder was working

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Dealing with Contention](../../../themes/dealing-with-contention.md) — The time-bound core of a distributed lock: a crashed holder frees the resource at the deadline, with no cleanup job. {#fluency-dealing-with-contention}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Heartbeat](./heartbeat.md) — The renewal stream of a lease doubles as the liveness signal for its holder.
- [Leader Election](./leader-election.md) — A leader holds its role as a lease and steps down when it cannot renew.
- [Fencing Token](./fencing-token.md) — A lease alone cannot stop a paused holder, so a token checked at the resource closes the gap.
- [Distributed Lock](./distributed-lock.md) — A lock built on a lease adds a shared store and a named holder.
- [Minimize Coordination](../../../principles/minimize-coordination.md) — Expiry removes the need to contact a dead holder; pair it with a fencing token

**Alternative to**

- [Pessimistic Locking](./pessimistic-locking.md) — A lease excludes other servers across machines and time, with no database transaction held open.

**Prevents**

- [Split-Brain](../../../hazards/split-brain.md) — Narrows split-brain to the pause case: a holder that checks its own clock stops at its deadline, but a paused one still needs a Fencing Token.

**Exposed to**

- [Clock Skew](../../../hazards/clock-skew.md) — A lease needs the two sides to agree on how long a term lasts, which clock drift can break.
- [Resource Leak](../../../hazards/resource-leak.md) — Can fall into resource leak when a holder that never releases keeps the grant until the lease expires
- [Thundering Herd](../../../hazards/thundering-herd.md) — Can fall into thundering herd when leases granted together expire together, and the holders all renew in the same instant

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Time-limited ownership is available ready-made as a blob lease or a coordination-service lease.

<!-- relationships:end -->
