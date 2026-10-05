---
title: Quorum & Consensus
description: A majority of nodes must agree before a write counts
area: distributed-coordination
owner: Oleksandr Derechei
tags: [replication, availability, durability]
status: stable
solves: [a read hit a stale replica and gave me an old value, waiting for every copy to acknowledge means one slow machine stalls all my writes, two nodes disagree about the current value and I have no way to decide which is right, a node came back after a network split still serving data from before the split, I need writes to survive a machine dying without taking the whole cluster down]
---

# Quorum & Consensus

A majority of nodes must acknowledge a write before it counts as durable — so no single replica, however fast or however wrong, gets to decide the outcome alone.

## What it is
<!--meta block=description-->

No single replica can be trusted alone, and waiting for all of them stalls the system when one is slow. A quorum is the minimum number of replicas that must agree: a write waits for W acknowledgements, a read asks R, and when W + R exceeds the replica count N, every read overlaps the latest write. Consensus protocols such as Raft add a leader and a log for ordering.

## Explained
<!--meta block=explain-->

A quorum makes a read or write count only after enough copies of the data agree. With N copies, a write waits for W acknowledgements and a read asks R copies. When W + R is greater than N, every read overlaps every write on at least one copy, so a read cannot miss the latest committed write. Choose it over trusting one copy or waiting for all copies when data must survive machine loss and one slow machine must not stop you. W and R become dials between fresh reads and fast writes.

- **Slowest copy sets latency.** Each operation waits on the slowest copy in its set. Pick W and R to fit your latency budget.
- **Lost majority stops writes.** A partition leaving no side a majority halts writes. Spread copies across independent racks or zones.
- **Silent stale reads.** W + R of N or less can return stale data without error. Alert on the setting.
- **No ordering.** Overlap does not order concurrent writes. Add version numbers or a consensus protocol.

**Example.** A key has N = 3 copies on A, B and C, with W = 2 and R = 2, so 2 + 2 is greater than 3. A write is acknowledged by A at 5 ms and B at 40 ms, so it commits at 40 ms. C is down and misses it. A later read asks B and C, gets version 5 from B and version 4 from C, and returns version 5. With W = 1 the same write commits at 5 ms, but R = 1 could read C and return version 4, since 1 + 1 is not greater than 3. W = 2 costs 35 ms more than W = 1, varying per write.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a write survive replica C being down without a later read missing it? Step 4 commits on two acks from A and B and never waits for C, and step 6 is safe because any two replicas share at least one that took the write: B holds v5 and C, back up and stale, holds v4."
flowchart LR
    Writer["Client write"]:::ext
    Coord["Coordinator"]
    subgraph Ring["N = 3 replicas, W = 2, R = 2, W + R > N"]
        A[("Replica A")]
        B[("Replica B")]
        C[("Replica C — down during the write")]
    end
    Reader["Client read"]:::ext
    Writer -->|"1 write v5"| Coord
    Coord -->|"2 replicate v5"| A
    Coord -->|"2 replicate v5"| B
    Coord -->|"2 replicate v5, no ack"| C
    A -->|"3 ack"| Coord
    B -->|"3 ack"| Coord
    Coord -->|"4 committed on W = 2"| Writer
    Reader -->|"5 read, asks R = 2"| Coord
    Coord -->|"5 B returns v5, C returns v4"| B
    Coord -->|"6 return v5, the highest version"| Reader
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="A write commits once two of three replicas acknowledge it, and a later read of B and C returns the newest version."
sequenceDiagram
    autonumber
    participant Cl as Client
    participant A as Node A
    participant B as Node B
    participant C as Node C
    Cl->>A: write v5
    Cl->>B: write v5
    Cl->>C: write v5
    C--xCl: down, no ack
    alt quorum reached (W=2)
        A-->>Cl: ack
        B-->>Cl: ack
        Note over Cl: 2 of 3 acked, commit without waiting on C
    else quorum not reached
        Note over Cl: fewer than W acks, write fails or retries
    end
    Note over C: C comes back up still holding v4
    Cl->>B: read (R = 2)
    Cl->>C: read (R = 2)
    B-->>Cl: v5
    C-->>Cl: v4
    Note over Cl: return v5, the highest version
```

## Variations
<!--meta block=variations-->

- **Read/write quorum tuning (W + R > N)** — Pick W and R so they sum past N — e.g. N=3, W=2, R=2 — guaranteeing every read touches at least one replica that saw the latest write. Holds for strict quorums only; sloppy quorums and concurrent writes break it.
- **Strict vs. sloppy quorum** — A strict quorum only counts the N designated replicas. A sloppy quorum accepts acks from any reachable node and hands the write off later (hinted handoff), trading strict consistency for availability during a partition.
- **Majority vs. weighted quorum** — Classic majority gives every replica one vote. A weighted quorum assigns more votes to reliable or well-connected nodes, so the outcome doesn't hinge on a single flaky one.
- **Flexible / asymmetric quorums** — Decouple the quorum used to elect a leader from the quorum used to replicate entries, as long as the two still intersect — shrink one and the other can grow, cutting latency on the hot path.
- **Leader-based consensus (Paxos, Raft)** — Layer a stable leader and an ordered log on top of the same majority arithmetic, so replicas agree not just that a write happened but in what order — quorum becomes full consensus.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Tolerates minority failures without stopping** — with majority quorums, up to floor((N-1)/2) nodes can be down or partitioned; larger W or R tolerates fewer.
- **No single node** is a single point of truth; a stale or bad replica gets outvoted.
- **Consistency and availability are tunable** via W and R, not baked in as an all-or-nothing choice.
- **Correctness rests on simple**, well-understood intersection math, not on trusting any one participant.

### Cons
<!--meta polarity=con-->

- **Majority requires reaching most of the cluster** — a bad enough partition can leave every side short of quorum.
- **Adds write latency**: the request isn't done until W replicas answer, not one.
- **Overlap alone gives no ordering** — concurrent conflicting writes still need versioning or a real consensus protocol.
- **Changing cluster membership mid-flight is delicate**; quorum math assumes a known, stable N.
- **W + R > N alone is not linearizable**: a write that failed on fewer than W replicas can still surface later, and reads racing a write can disagree. Pair quorum with a consensus log for linearizable reads.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Data is replicated across multiple** nodes and no single copy can be trusted alone.
- **You need to survive node** failure or a network partition without halting every write.
- **You can afford the latency** of waiting on more than one acknowledgment per operation.

### Avoid when
<!--meta polarity=avoid-->

- **A single authoritative source of truth already exists** — there's nothing for a quorum to arbitrate.
- **You need strict**, linearizable ordering and haven't paired quorum with a real consensus protocol.
- **The added round trips** of touching multiple nodes per write blow your latency budget.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal quorum write and read"
// Write: resolve once W replicas acknowledge, without waiting for the rest
// A rejected write may still sit on some replicas: callers must treat failure as unknown and retry idempotently.
async function quorumWrite(replicas: ReplicaClient[], value: Versioned, w: number): Promise<void> {
  const n = replicas.length;
  return new Promise((resolve, reject) => {
    let acked = 0, failed = 0;
    for (const r of replicas) {
      r.write(value).then(
        () => { if (++acked >= w) resolve(); },
        () => { if (++failed > n - w) reject(new Error("quorum unreachable")); },
      );
    }
  });
}

// Read: ask R replicas, keep the highest version. W + R > N guarantees
// at least one of them took the latest committed write.
async function quorumRead(replicas: ReplicaClient[], key: string, r: number): Promise<Versioned> {
  const answers = await firstN(replicas.map((rep) => rep.read(key)), r); // firstN: helper resolving with the first R answers
  return answers.reduce((a, b) => (b.version > a.version ? b : a));
}

// N=3, W=2, R=2: 2 + 2 > 3
await quorumWrite(replicas, { key: "x", val: 42, version: 5 }, 2);
const latest = await quorumRead(replicas, "x", 2);
```

## In the wild
<!--meta block=wild-->

- **Apache Cassandra** — Per-query consistency levels (ONE, QUORUM, LOCAL_QUORUM, ALL) let callers dial W and R against a keyspace's replication_factor, making W + R > N a runtime choice; LOCAL_QUORUM keeps the quorum inside one datacenter, and hinted handoff replays missed writes later during a partition. {#wild-cassandra}
- **Raft** — A leader-based consensus algorithm: a single elected leader appends to a replicated log, and an entry commits only once a majority of members has persisted it. Terms and randomized election timeouts make split votes rare. It backs etcd, Consul, and TiKV. {#wild-raft}
- **etcd** — Kubernetes stores all cluster state here. Built on Raft, every write is committed only after a majority of members has it, so clusters are run with an odd membership (typically 3 or 5) to keep a clear majority and survive one or two node losses. {#wild-etcd}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Replication factor N** — How many replicas hold each key. Larger N tolerates more failures but makes every quorum wider and slower, and quorum math assumes N is known and stable.
- **Write / read quorum sizes (W, R)** — Per-operation consistency levels. W + R > N buys read-your-writes; shrinking one shifts latency and staleness onto the other. Set them for the guarantee you actually need, not the strongest available.
- **Election timeout vs. heartbeat interval** — In leader-based consensus (Raft), the follower election timeout must sit comfortably above the leader heartbeat interval and network round-trip time (RTT), or followers time out and trigger needless elections. Keep broadcast time well below election timeout, and election timeout well below mean time between failures.
- **Strict vs. sloppy quorum (hinted handoff)** — Whether writes may be accepted by any reachable node and handed off later. Sloppy quorum keeps writing during a partition at the cost of temporary inconsistency and a hint backlog to drain afterward.

### Signals to watch
<!--meta polarity=signal-->

- **Write / read latency p99** — An operation is not done until W (or R) replicas answer, so tail latency tracks the slowest replica in the quorum, not the average node.
- **Unreachable / lagging replica count** — How many members are down, partitioned, or behind. Once this reaches floor((N-1)/2) the cluster is one failure away from losing quorum.
- **Leader elections per interval** — In consensus systems, frequent leader changes mean the cluster is spending time electing instead of committing — often a symptom of a too-tight election timeout or a flaky node.
- **Replication / hint backlog** — How far replicas trail the committed point, or how many hinted writes are queued for handoff. A growing backlog is unflushed inconsistency waiting to surface.

### Failure modes under load
<!--meta polarity=failure-->

- **Split with no majority** — A partition slices the cluster so no side holds a majority; every side is short of quorum and writes stall everywhere until the partition heals.
- **Election storm** — An election timeout barely above RTT lets transient slowness unseat the leader repeatedly; the cluster flaps between leaders and commit throughput collapses.
- **Stale reads from W + R <= N** — Quorums no longer guaranteed to overlap, so a read can land entirely on replicas that missed the latest write and return old data with no error.
- **Hint backlog overrun** — A long partition under sloppy quorum piles up hinted writes faster than they can be handed back; the backlog pressures the coordinator and delays convergence when the partition ends.

### Readiness checklist
<!--meta polarity=check-->

- W + R > N holds for every consistency level a client is allowed to request
- N is odd, so a clean two-way split always leaves one side with a majority and no tie; a split into three or more parts can still leave none
- Election timeout is set well above heartbeat interval and worst-case network RTT
- Membership changes are applied one node at a time, never by editing N mid-flight
- Leader-change rate and unreachable-replica count are monitored with alerts

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [CAP Theorem](../../../themes/cap-theorem.md) — Tune the consistency/availability dial with read/write quorums {#fluency-cap-theorem}
- [Consistency & Replication](../../../themes/consistency-and-replication.md) — Agree on writes across a majority {#fluency-consistency-and-replication}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Write-Ahead Log](./write-ahead-log.md) — Replicate the log, commit on a quorum
- [Distributed Lock](./distributed-lock.md) — Holding a lease correctly under failure is one thing a consensus store is used for
- [Make Everything Redundant](../../../principles/redundancy.md) — A quorum is the tie-break that redundancy cannot do without
- [Vector Clock](./vector-clock.md) — Quorum reads can return divergent versions, and vector clocks tell the reader which to keep.
- [Merkle Tree](./merkle-tree.md) — Quorum writes can miss a replica and a Merkle repair closes the gap later.
- [Two-Phase Commit](./two-phase-commit.md) — Consensus can store a two-phase-commit coordinator's decision so its failure no longer blocks prepared participants.

**Alternative to**

- [Gossip Protocol](./gossip-protocol.md) — Use consensus when a single agreed value or linearizable read matters
- [CRDT](./crdt.md) — Use agreement when a rule spans replicas; use a conflict-free replicated data type (CRDT) when replicas must keep writing alone.
- [Failover](./failover.md) — When one standby must be promoted and the old primary can be fenced, failover does it without a vote.

**Enables**

- [Leader Election](./leader-election.md) — A majority vote is the building block that lets a group settle on one leader

**Requires**

- [Replication](./replication.md) — Quorums make replicated writes agree

**Prevents**

- [Split-Brain](../../../hazards/split-brain.md) — A partition yields at most one majority, so leaders cannot double

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Spanner, CockroachDB and YugabyteDB sell the majority commit outright — you place the replicas, you cannot tune it away.
- [Relational databases](../../../comparisons/relational-databases.md) — CockroachDB commits through a Raft majority, which is why any node accepts writes and why each commit pays for the network.

<!-- relationships:end -->
