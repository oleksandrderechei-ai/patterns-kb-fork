---
title: Leader Election
description: "Exactly one node coordinates, and the group agrees who"
area: distributed-coordination
owner: Oleksandr Derechei
tags: [coordination, availability]
status: stable
solves: [I scaled to three replicas and now my nightly job runs three times, when the box that runs the scheduler dies nothing happens until someone restarts it by hand, two nodes both think they are in charge and are writing conflicting data, I need exactly one worker to own this queue but I do not want to hardcode which machine it is, failover currently means paging a human at 3am to promote a replica]
---

# Leader Election

Exactly one node in the cluster acts as coordinator at any moment — every peer runs the same protocol to agree on who that is, so writes, scheduling, and partition ownership never have to contend for the job.

## What it is
<!--meta block=description-->

Leader election lets a group of equal nodes agree on one of themselves to do a job that is only correct when one node does it, with no operator and no fixed owner to lose. Survivors notice a dead leader and pick a new one. A paused leader can wrongly believe it still leads, so leadership carries a rising term number that downstream rejects when stale.

## Explained
<!--meta block=explain-->

Leader election has a group of equal nodes agree on one of themselves to do a job that is only correct when exactly one process does it, such as taking writes for a partition or running a scheduled task once. When the leader dies, the survivors notice and pick a replacement, so nobody is paged to promote one by hand. Choose it over naming a fixed owner when that owner must survive the loss of its machine. A paused leader can lose the role without knowing, and then two nodes both write, which is split brain, so give each leader a rising term number, and make the resource keep the highest term it has seen and reject older ones atomically with each write.

- **One bottleneck.** Everything the leader owns funnels through one process. Shard the job across several leaders if it saturates.
- **Wrong timeouts.** Too short and a long pause unseats a healthy leader. Size above typical pauses; the term check covers the rest.
- **Hard to prove.** A hand-written protocol is yours to verify. Lean on a coordination service and own that dependency.

**Example.** Five nodes compete for a lease (a lock that expires) that lasts 15 s and is renewed every 5 s. Node 1 leads with term 7 and then freezes for 20 s in a garbage-collection pause. At 15 s the lease expires, node 3 wins with term 8, and the job continues with no human involved. At 20 s node 1 wakes, still believes it leads, and writes with term 7. Storage has seen term 8 and rejects it. The cost is the gap: after a real crash there is up to 15 s with no leader. A 3 s lease renewed every 1 s would shorten that gap, but a 4 s pause would unseat a healthy leader.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a group of equal nodes end up with exactly one doing the job? One of them wins the term (1, 2) and the rest stand down while its heartbeats keep arriving; every write it makes carries that term (5), which is what lets the store downstream reject a leader that has already been replaced."
flowchart LR
    subgraph Peers["The peer group — equal until one holds the term"]
        A["Node A"]
        B["Node B"]
        C["Node C"]
    end
    Lease[("Lease and term store")]
    Down[("Downstream store")]:::ext
    A -->|"1 claim leadership for term 7"| Lease
    Lease -->|"2 granted, nobody else holds it"| A
    A -->|"3 heartbeat: I lead term 7"| B
    A -->|"4 heartbeat: I lead term 7"| C
    A -->|"5 write, stamped with term 7"| Down
    A -->|"6 renew before the TTL runs out"| Lease
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="A term-based election, as in Raft or ZAB. A follower that stops hearing from the leader becomes a candidate, requests votes, and wins the term with a majority; any node that sees a higher term steps back down."
stateDiagram-v2
    [*] --> Follower: node starts
    Follower --> Candidate: election timeout, no heartbeat
    Candidate --> Leader: majority votes for this term
    Candidate --> Follower: higher term discovered
    Leader --> Follower: higher term discovered
    Follower --> [*]: node stops or crashes
    Leader --> [*]: node stops or crashes
    note right of Follower: waits for a heartbeat from the leader
    note right of Candidate: requests votes for its term
    note right of Leader: sends heartbeats, serializes writes
```

## Variations
<!--meta block=variations-->

- **Bully algorithm** — The node with the highest ID declares itself leader once it notices the current one is unreachable; lower-ID nodes yield. Simple, but chatty: a recovering high-ID node can trigger repeated re-elections. It assumes a reliable failure detector, so a partition can give it two leaders.
- **Ring algorithm (Chang-Roberts)** — An election message circulates a logical ring of nodes, each forwarding the higher of its own ID and whatever it received; the message returns to its originator carrying the winner.
- **[Quorum & Consensus](./quorum-consensus.md)** — Term-based voting. Raft elects by randomized timeouts and a majority vote; Multi-Paxos uses ballot numbers to pick a distinguished proposer. A candidate needs a majority quorum before it may act as leader.
- **[Gossip Protocol](./gossip-protocol.md)** — Liveness and leadership state spread peer-to-peer instead of through heartbeats to every node. This suits large, high-latency clusters but converges more slowly. Gossip only spreads membership; a separate rule or consensus step must still pick one leader and issue terms.
- **Lease-based external election** — Delegate the decision to a coordination service (ZooKeeper, etcd, Consul): a node holds leadership only while it can renew a time-bound lease, so a crashed leader's slot expires on its own.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Serializes coordination through one node**, so contending replicas never need to fight over the same write.
- **Automatic failover** — the group detects a dead leader and elects a fresh one without an operator.
- **Once elected, the leader decides** without a per-request vote, but writes still carry a term and may wait on quorum replication.
- **Well-studied algorithms** (Raft, Paxos, ZAB) come with published correctness proofs.

### Cons
<!--meta polarity=con-->

- **The elected leader is a bottleneck** and a single target for load on everything it owns.
- **Split brain is a real risk under partitions** — needs terms, epochs, or fencing tokens to rule out.
- **Flaky networks or long pauses cause election churn**, repeatedly disrupting an otherwise-healthy leader.
- **Getting the protocol right** — timeouts, quorum sizes, fencing — is genuinely hard to do from scratch.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several replicas exist**, but exactly one must issue writes, run a scheduled job, or own a partition.
- **You need automatic failover** with no human deciding who takes over next.
- **Serializing through a leader** is cheaper than having every node coordinate with every other on each write.

### Avoid when
<!--meta polarity=avoid-->

- **A single always-on process is acceptable** — a static, manually assigned owner needs no election.
- **Work can be sharded so nodes never compete** for the same duty in the first place.
- **Idempotent, at-least-once processing is good enough** — sidestep exclusive ownership entirely.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a lease-based elector"
interface LeaseStore {
  acquire(nodeId: string, ttlMs: number): Promise<number | null>;
  renew(nodeId: string, ttlMs: number): Promise<number | null>;
}

class LeaderElector {
  private term: number | null = null;

  constructor(
    private readonly store: LeaseStore,
    private readonly nodeId: string,
    private readonly ttlMs = 5_000,
  ) {}

  async tryBecomeLeader(): Promise<boolean> {
    this.term = await this.store.acquire(this.nodeId, this.ttlMs);
    return this.term !== null;
  }

  // Call on an interval of about ttlMs / 3, so one missed renewal does not lose the lease.
  async renew(): Promise<void> {
    if (this.term === null) return;
    this.term = await this.store.renew(this.nodeId, this.ttlMs); // null: lease lost, step down
  }

  // Stamp every write with currentTerm; the resource must reject older terms.
  get currentTerm(): number | null { return this.term; }

  // leading can be stale after a pause until renew() runs, so never trust it alone.
  get leading(): boolean { return this.term !== null; }
}
```

## In the wild
<!--meta block=wild-->

- **Apache ZooKeeper** — Ephemeral sequential znodes are the classic leader-election recipe, used by HBase and, before Kafka 4.0 removed ZooKeeper in favour of KRaft, by Kafka; the lowest sequence number wins and each contender watches only the node just below it, so a leader's crash triggers one election rather than a herd {#wild-zookeeper}
- **etcd** — Exposes Raft-backed leader election through lease-bound keys and an election API; a candidate campaigns on a key attached to a lease it must keep alive, and leadership lapses on its own when the lease time to live (TTL) expires {#wild-etcd}
- **Kubernetes** — Controller managers and schedulers run active-passive by contending for a Lease object in the coordination.k8s.io API, so only one replica reconciles; the leaderelection package drives it with leaseDuration, renewDeadline and retryPeriod {#wild-kubernetes}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **lease TTL / session timeout** — how long a leadership lease or coordination-service session lives before it expires (etcd lease TTL, ZooKeeper session timeout, Kubernetes leaseDurationSeconds); short means faster failover but more false failovers, long means the opposite
- **renewal interval** — how often the leader renews its lease or heartbeats; it must sit well under the TTL so a single missed renewal does not lose leadership on ordinary jitter (the renewDeadline and retryPeriod in the Kubernetes leaderelection package)
- **election timeout** — how long a follower waits without hearing from a leader before starting an election; in Raft it is randomized across a range so peers do not all campaign at once and split the vote
- **quorum size** — the majority a candidate must win to lead; run an odd number of voters (three or five) so a majority is unambiguous and one failure still leaves a quorum
- **fencing token / term** — the monotonically increasing epoch stamped on every action the leader takes; downstream stores reject anything carrying an older term, which is what makes a stale leader safe rather than merely unlikely

### Signals to watch
<!--meta polarity=signal-->

- **election rate** — how many elections happen per hour or day; leadership changes should be rare, explicable events, and an unexplained climb points to a flapping network or an overloaded leader losing its lease
- **leaderless gap** — the time the group spends with no recognized leader during a failover — the window in which the work that needs exactly one owner simply stalls
- **lease-renewal margin** — how close each renewal runs to the TTL; renewals that keep landing near the deadline mean the leader is one pause away from losing its slot even though it is still healthy
- **quorum member health** — how many voters are currently reachable; drop below a majority and no leader can be elected at all, so this is the number that predicts a total stall

### Failure modes under load
<!--meta polarity=failure-->

- **split brain** — a partition or a long GC pause lets a stale leader keep acting while the group elects a new one; without a fencing token both write, and their diverging state has to be reconciled by throwing someone's work away
- **election churn** — timeouts set too short relative to real network jitter cause followers to repeatedly time out and re-elect, disrupting a leader that was perfectly healthy and stalling work each round
- **paused-leader zombie** — the leader stalls long enough for its lease to expire and a successor to take over, then resumes still believing it leads; only downstream term-checking stops its now-stale writes from landing
- **quorum loss stalls writes** — enough voters become unreachable that no majority can form; the system cannot elect anyone and every operation gated on a leader blocks until quorum returns

### Readiness checklist
<!--meta polarity=check-->

- Tie every leader action to a fencing token or term that downstream validates — never trust an I-am-leader flag on its own
- Set the lease TTL and renewal interval with margin above the worst-case pause and network round-trip, so a hiccup does not trigger failover
- Run an odd number of voters and monitor quorum health, since losing a majority stalls elections entirely
- Rehearse failover and a partition deliberately, and confirm the old leader is fenced before the new one writes
- Alert on election frequency — elections should be rare and each one explicable

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [CAP Theorem](../../../themes/cap-theorem.md) — A single writer trades availability for consistency {#fluency-cap-theorem}
- [Consistency & Replication](../../../themes/consistency-and-replication.md) — Serialize writes through one node {#fluency-consistency-and-replication}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Gossip Protocol](./gossip-protocol.md) — Membership spreads by gossip; a leader is chosen
- [Scheduling](../../concurrency/scheduling.md) — A singleton scheduler runs only on the elected leader
- [Sweeper](./sweeper.md) — a scheduled sweep is the classic run-exactly-once job that needs a single elected runner
- [Make Everything Redundant](../../../principles/redundancy.md) — Election is redundancy applied to the coordinator itself
- [Failover](./failover.md) — Failover is the act of moving the leader role to a standby once the old leader is gone.
- [Lease](./lease.md) — Election commonly hands out the leader role as a lease that must be renewed.
- [Fencing Token](./fencing-token.md) — Election grants the role; a rising fencing token makes a deposed leader's late writes fail.

**Alternative to**

- [Minimize Coordination](../../../principles/minimize-coordination.md) — A leader is coordination you accept when partitioning will not work
- [Vector Clock](./vector-clock.md) — Where there is no single leader, a vector clock tells concurrent writes apart.

**Requires**

- [Quorum & Consensus](./quorum-consensus.md) — The group needs a way to agree on one member, and a majority vote is that agreement
- [Heartbeat](./heartbeat.md) — Election needs a timely signal that the leader is gone before it can start a new one.

**Often confused with**

- [Distributed Lock](./distributed-lock.md) — Both grant a single owner — election picks a role holder, a lock guards a resource

**Prevents**

- [Split-Brain](../../../hazards/split-brain.md) — Promotion on timeout alone is exactly what produces two leaders

**Demonstrated by**

- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — the singleton schedulers of a know your customer (KYC) pipeline take a lease rather than relying on being deployed once — takeover on expiry turns a crashed scheduler into a lease interval of delay
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — leases applied to the recovery machinery itself, so the failover story for the failover mechanism is the same mechanism

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Managed engines do this internally on failover.

<!-- relationships:end -->
