---
title: Replication
description: Keeps copies of data on multiple nodes for durability and reads
area: distributed-data
owner: Oleksandr Derechei
tags: [replication, availability, durability]
status: stable
aliases: [primary-replica, leader-follower]
solves: [one disk died and the only copy of the data went with it, my single database server cannot keep up with the read traffic anymore, users on the other side of the world wait hundreds of milliseconds because there is only one copy, when the database host goes down the whole product is offline until someone restores a backup, restoring from last night backup would lose an entire day of work]
---

# Replication

Keeps copies of the same data on multiple machines, so losing one node never means losing the data, and reads can be served from whichever copy is closest or least busy.

## What it is
<!--meta block=description-->

A single copy of data on one machine is lost, or unreachable, when that machine fails, and one machine caps how many reads it can serve. Replication keeps copies on several machines and keeps them current, usually by one leader shipping an ordered log to followers. It buys durability and read capacity, but copies cannot update atomically, so you choose how stale a read may be.

## Explained
<!--meta block=explain-->

Replication keeps copies of the same data on several machines, in different racks or regions, so losing one machine costs a node instead of the dataset and reads can spread over the copies. In the common form one leader accepts every write, logs it in order, and ships the log to followers that apply it in the same order and can take over if the leader dies. Choose it when one host dying would lose data, or when reads have outgrown one machine. If the data itself no longer fits on one machine, you need sharding instead, because copies add no capacity.

- **Replication lag.** Lag is follower staleness and writes lost at failover. Read your own writes from the leader; use synchronous copies where loss is unacceptable.
- **Failover risk.** Two leaders diverge. Fence the old leader and rehearse the switch.
- **No write scale.** Writes still funnel through the leader, so replication does not lift write throughput.

**Example.** A leader takes 500 writes a second and ships them to two followers with 200 ms of lag. A user saves a profile and the next page reads from a follower that is 200 ms behind, so the old name shows and the user reports a bug. Reading from the leader for 1 s after a write fixes that. If the leader dies, up to 500 times 0.2, about 100 writes were never copied and are lost. Waiting for one follower to acknowledge each write before replying closes that gap but adds the follower's round trip to every write.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a second machine end up holding the same data? The primary orders every write into one log and ships it, and each replica replays that log in the same order — whether step 5 waits for step 3 is the durability dial."
flowchart LR
    C["Client"]
    subgraph Ord["One ordered log, replayed on every copy"]
        P["Primary"]
        WAL[("Write-ahead log")]
        RA["Replica A"]
        RB["Replica B"]
    end
    Rdr["Reader"]:::ext
    C -->|"1 write"| P
    P -->|"2 append entry"| WAL
    WAL -->|"3 ship entries in commit order"| RA
    WAL -->|"4 ship entries in commit order"| RB
    P -->|"5 acknowledge the write"| C
    RA -->|"6 serve a read from the copy"| Rdr
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Single-leader (primary-replica)** — One node accepts every write and ships an ordered log to followers. Simple to reason about; followers can lag behind, and a leader failure needs a handover.
- **Multi-leader** — Several nodes accept writes independently and replicate to each other — useful across datacenters, but concurrent writes to the same key can conflict and need reconciling.
- **[Leaderless (quorum-based)](./quorum-consensus.md)** — Any replica accepts reads and writes; overlapping read and write quorums make a read meet a replica holding the latest acknowledged write, with no single leader ordering them, and read repair or background anti-entropy converges the rest.
- **Cascading (chained) topology** — A follower re-serves the log onward to further followers instead of every copy streaming from the leader. The leader pays for one connection rather than N, and a distant site pulls one wide area network (WAN) stream and fans it out locally, which adds replicas or a whole second region without more load at the source. Every relay adds a lag hop and the relayed leg is normally asynchronous, so a copy two hops out trails more than the leader's own numbers suggest. The chain below a failed intermediate receives nothing until it is repointed.
- **Synchronous vs. asynchronous** — Synchronous replication waits for a replica's acknowledgment before confirming a write — safer, slower, less available under a partition. Asynchronous confirms immediately and risks losing the most recent writes on failover.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Survives node, disk, or availability-zone failure**; with synchronous acknowledgment no acknowledged write is lost, with async the newest writes can be.
- **Scales read traffic horizontally** by fanning reads out across replicas.
- **Lets you place a copy near each population of readers**, cutting read latency; writes still travel to the leader.
- **A live standby can be promoted in seconds**, once the old leader is fenced, instead of restoring from backup.

### Cons
<!--meta polarity=con-->

- **Replicas can lag**, so a read may return data that's already stale.
- **More copies mean more storage** and steady network cost to keep them in sync.
- **Failover has to elect** a new leader and reconcile any writes that never fully replicated.
- **Doesn't help write throughput** — writes still funnel through however many leaders you allow.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Survive losing one node** — losing one node must not lose acknowledged data; that needs synchronous acknowledgment.
- **Reads outgrow one node** — read traffic outstrips what one node's disk and CPU can serve.
- **Readers are geographically spread** and latency to a single copy matters.

### Avoid when
<!--meta polarity=avoid-->

- **Dataset too big for one node** — it exceeds what any single node can hold; that's a job for [Sharding](../routing/sharding.md), not more copies.
- **Every reader must see** the absolute latest write and can't tolerate any lag — commit to synchronous replication or a stronger consistency pattern deliberately, not by default.
- **A single instance with regular** backups already meets your durability bar — replication adds operational cost you don't need yet.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a single writer shipping its flow log to a synchronous standby"
// A flow's state transition is one log entry. While the standby is up, the
// writer acknowledges only after the standby has it, so promoting that standby
// never loses a transition the caller was told had committed.
// Sketch limits: no ack timeout, so a down standby blocks writes; a failed
// standby ack leaves the entry in the primary log; attach must not run while
// a write is pending, or the replayed entry makes apply throw "gap in log";
// `void` drops a throwing async reader's rejection.
interface LogEntry { seq: number; flowId: string; state: string }

class Primary {
  private log: LogEntry[] = [];
  private standby?: Replica;        // synchronous, in-region
  private readers: Replica[] = [];  // asynchronous, may lag
  async write(flowId: string, state: string): Promise<void> {
    const entry: LogEntry = { seq: this.log.length, flowId, state };
    this.log.push(entry);
    await this.standby?.apply(entry);                  // the ack waits here
    for (const r of this.readers) void r.apply(entry); // ship in commit order
  }
  attach(reader: Replica): void {
    this.log.forEach((e) => void reader.apply(e));     // catch up first
    this.readers.push(reader);
  }
}
class Replica {
  private flows = new Map<string, string>();
  private lastSeq = -1;
  async apply(e: LogEntry): Promise<void> {
    if (e.seq !== this.lastSeq + 1) throw new Error("gap in log");
    this.flows.set(e.flowId, e.state);
    this.lastSeq = e.seq;
  }
  read = (flowId: string) => this.flows.get(flowId); // an async reader may lag
}
```

## In the wild
<!--meta block=wild-->

- **PostgreSQL streaming replication** — Streams the write-ahead log (WAL) to hot standbys that serve reads and can be promoted when the primary fails; synchronous_standby_names picks which standbys must acknowledge a commit, and replication slots hold WAL for a disconnected standby — famously filling the primary's disk when a slot is orphaned. {#wild-postgresql-streaming-replication}
- **MongoDB replica sets** — A set elects a primary, replicates its oplog to secondaries, and fails over automatically without an operator; teams dial durability per write with a majority write concern and route reads with read preferences, accepting staleness on secondaries. {#wild-mongodb-replica-sets}
- **Apache Kafka** — Each partition has a leader and follower replicas, and the in-sync replica set defines what counts as durably committed; acks=all with min.insync.replicas sets the durability floor, and unclean.leader.election.enable decides whether availability may be bought with lost writes. {#wild-apache-kafka}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **acknowledgment level** — how many replicas must confirm before a write returns — Kafka acks, Postgres synchronous_commit, Mongo write concern all dial the same trade: commit latency and availability against durability of the newest writes
- **replication factor** — how many copies exist, and across which failure domains; three is the common floor because two means the first failure leaves you running unreplicated
- **read routing** — whether reads may hit followers; replica reads buy throughput and pay in staleness — decide per query, not once per system
- **failover policy** — automatic election recovers in seconds but must be paired with fencing of the old leader, or two nodes both believe they are primary
- **log retention for catch-up** — how much log the leader keeps for lagging followers; too little and a slow replica must be rebuilt from scratch, too much — or pinned by a dead replica's slot — and the leader's own disk fills

### Signals to watch
<!--meta polarity=signal-->

- **replication lag per replica** — in bytes or seconds — the one number that is both the staleness of follower reads and, under async replication, the size of your data-loss window on failover
- **in-sync replica count** — how many copies are currently keeping up; when it drops to the acknowledgment threshold, the next failure either blocks writes or loses them
- **retained log size on the leader** — grows when a follower falls behind or dies with a retention slot open; watch it before the disk does
- **leader elections per day** — elections should be rare events you can explain; unexplained ones mean a flapping network or an overloaded leader

### Failure modes under load
<!--meta polarity=failure-->

- **split brain** — a partitioned old leader keeps accepting writes while a new one is elected; without fencing or quorum both sides diverge, and reconciliation throws someone's writes away
- **failover data loss under async** — the leader dies with acknowledged writes not yet shipped; the promoted follower never saw them — clients were told committed about data that no longer exists
- **read-your-writes violation** — a user writes to the leader and reads the change back from a lagging follower — it is not there; the bug reports say the save button is broken
- **disk-full from a pinned log** — a decommissioned replica whose slot or position still pins retention; the leader hoards log for a follower that will never return until its own disk fills

### Readiness checklist
<!--meta polarity=check-->

- measure and alert on replication lag — under async replication it is the size of your data-loss window
- practice failover deliberately in business hours; the first promotion should not happen during the outage
- fence the old leader before promoting a new one — never let two primaries live at once
- decide explicitly which reads may go to replicas; a default of any-replica quietly breaks read-your-writes
- clean up replication slots and offsets for decommissioned replicas, and monitor retained log on the leader

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [System Design Interview](../../../themes/system-design-interview.md) — Redundancy behind fault tolerance and read scaling {#fluency-system-design-interview}
- [CAP Theorem](../../../themes/cap-theorem.md) — The copies whose agreement CAP is about {#fluency-cap-theorem}
- [Scalability](../../../themes/scalability.md) — Scale reads with copies {#fluency-scalability}
- [Consistency & Replication](../../../themes/consistency-and-replication.md) — The copies to keep in agreement {#fluency-consistency-and-replication}
- [Scaling Reads](../../../themes/scaling-reads.md) — Multiply read capacity with follower copies {#fluency-scaling-reads}
- [Scale Units & Stamps](../../../themes/scale-units-and-stamps.md) — Keep the shared tier alive across every unit {#fluency-scale-units-and-stamps}
- [Data Platform](../../../themes/data-platform.md) — Where the copies live, and who is allowed to write {#fluency-data-platform}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Consistent Hashing](../routing/consistent-hashing.md) — Place primary and replicas around the ring
- [Sharding](../routing/sharding.md) — Partition for scale, replicate each shard for safety
- [Read-Through](../../caching/read-through.md) — Read replicas serve cached-style reads
- [Gossip Protocol](./gossip-protocol.md) — Leaderless stores gossip membership and repair replicas in the background
- [Make Everything Redundant](../../../principles/redundancy.md) — Replication is this principle applied to data

**Enables**

- [Quorum & Consensus](./quorum-consensus.md) — Quorums make replicated writes agree
- [Geode](../routing/geode.md) — What makes each geographical node able to answer any request, not just local ones
- [Vector Clock](./vector-clock.md) — Replicas that take writes independently need a way to tell stale versions from concurrent ones.
- [CRDT](./crdt.md) — Replicas that accept writes need a merge rule, and a conflict-free replicated data type (CRDT) supplies it.
- [Merkle Tree](./merkle-tree.md) — Copies drift, and a Merkle tree finds where.
- [Failover](./failover.md) — Failover is what makes the copies useful when the primary dies.

**Requires**

- [Write-Ahead Log](./write-ahead-log.md) — Ship the log to bring replicas up to date

**Often confused with**

- [Sharding](../routing/sharding.md) — Split data vs. copy data

**Prevents**

- [Hot Key](../../../hazards/hot-key.md) — Replicate the hot entry across nodes and spread reads over the copies

**Exposed to**

- [Split-Brain](../../../hazards/split-brain.md) — Replicas that each accept writes after a cut link can diverge into two histories.

**Demonstrated by**

- [Bitly](../../../designs/bitly.md) — Bitly keeps a replica of its 500 GB store for availability
- [Distributed Cache](../../../designs/design-distributed-cache.md) — shows the sync/async/peer-to-peer trade resolved toward async for a latency-and-availability-first cache
- [Distributed Rate Limiter](../../../designs/distributed-rate-limiter.md) — master-replica replication supplies the fast failover a fail-closed limiter needs to avoid becoming an outage
- [Facebook News Feed](../../../designs/fb-news-feed.md) — replicating instead of partitioning is the design's answer to a hot key — N replicas give N× headroom with no coordination
- [Google News](../../../designs/google-news.md) — scaling read throughput and surviving a node loss by copying the feed cache across replicas is replication doing its job
- [Gopuff](../../../designs/gopuff.md) — the leader-plus-replica read/write split is replication used to scale a read-heavy workload
- [YouTube](../../../designs/youtube.md) — spreading a hot partition's reads across additional replicas is replication resolving a hot-key bottleneck
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — The persona flow's single-writer Postgres fails over to a synchronous standby, so promotion loses no acknowledged fact
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — synchronous chosen over asynchronous because the fact an async replica could drop is the append already promised to a client

**Implemented by**

- [Storage](../../../capabilities/storage.md) — Cloud storage exposes this as a redundancy tier rather than something you operate.
- [Databases](../../../capabilities/databases.md) — Managed database services run this for you; you choose the topology, not the mechanism.
- [Relational databases](../../../comparisons/relational-databases.md) — How each relational engine replicates for read scale.

<!-- relationships:end -->
