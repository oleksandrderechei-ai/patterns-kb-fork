---
title: Consistency & Replication
description: Keeping copies of data in agreement across nodes
area: themes-data
owner: Oleksandr Derechei
tags: [replication, durability]
status: stable
aliases: [data consistency, eventual consistency]
---

# Consistency & Replication

Keeping copies of data in agreement across nodes is what makes a distributed store trustworthy instead of merely available. This theme is the machinery underneath that agreement — how writes are ordered, how replicas catch up, and how far behind "eventually" is allowed to be.

## The question
<!--meta block=description-->

Once a system keeps more than one copy of its data, a write on one copy raises a question: when does every other copy find out? Get it wrong and a user reads data older than their own write, or two copies each believe they are right. Replication is the transport that carries a change between nodes. Consistency is the guarantee a reader gets once it has landed. The replication strategy you pick decides which guarantee you can keep.

## Explained
<!--meta block=explain-->

Replication keeps several copies of your data so you survive a lost machine and spread reads, and consistency is the promise about what a reader sees after a write lands on one copy. Without a deliberate choice, a user writes a post and then reads from a copy that has not heard of it yet, or two copies each believe they hold the latest value. The main dial is how many copies must confirm a write before you call it done. Wait for a majority and a read that asks the leader or a majority sees it, but each write pays a round trip. Confirm at once and copy in the background, and writes are fast and always accepted, but a lagging copy can return old data. [Quorums](../patterns/distributed/coordination/quorum-consensus.md) sit between: with N copies, if W confirm a write and R answer a read, and W plus R is more than N, every read meets at least one copy holding the latest write and returns the newest version. Choose strong settings for money and uniqueness, loose ones for feeds.

- **Write latency.** A majority wait adds a round trip per write and stalls if the majority is unreachable, so reserve it for money.
- **Stale reads.** Confirming at once lets a lagging copy return old data: send a writer's own reads to the leader until the copy catches up.
- **Election pause.** One [elected writer](../patterns/distributed/coordination/leader-election.md) gives a clear order but stops writes until a new one is chosen, so keep the election fast.
- **Conflicts.** Several writers need conflict rules, so decide the merge before launch.

**Example.** A store has N = 3 copies in 3 zones, 2 ms apart. With W = 2 and R = 2, W + R = 4 is more than 3, so a read of two copies meets one with the last write and returns the newest version. A write returns after the second confirmation, about 2 ms, and one dead copy changes nothing. If two copies die, writes are refused, which is the availability you gave up. With W = 1 and R = 1, the total is 2, so a read can land on the one copy the write has not reached and return the old value. A user then misses their own post until that copy catches up.

## The trade-space
<!--meta block=tradespace-->

The core dial is **synchronous versus asynchronous replication**. Wait for a majority of replicas to confirm a write before acknowledging it, and every subsequent read that goes to the leader or a read quorum sees it — at the cost of an extra network round-trip on every write, and reduced availability if that majority can't be reached. Acknowledge the write immediately and ship it to replicas in the background, and writes stay fast and available — but a read against a lagging replica can return something older than what the client just wrote.

Quorums let you tune this rather than pick an extreme: require `W` replicas to confirm a write and `R` replicas to agree on a read, and if `W + R > N` (the total replica count) every read overlaps the most recent write, provided the reader takes the newest version and the quorum is strict (a sloppy quorum breaks the overlap). Push `W` and `R` down and you get speed and availability with a wider staleness window; push them up and you get strong reads at the cost of latency and fault tolerance. Copies that drift anyway are found by comparing hash trees ([Merkle Tree](../patterns/distributed/coordination/merkle-tree.md)) rather than scanning every key, and downstream stores follow the primary through its change log ([Change Data Capture](../patterns/distributed/coordination/change-data-capture.md)) instead of a second write from the application.

The other half of the trade-space is **ordering**: with one writer (an elected leader) ordering is trivial but the leader is a bottleneck and a single point of failure until re-election completes. With multiple writers, ordering has to be reconstructed after the fact — through logical clocks, conflict resolution, or simply accepting that different replicas may briefly disagree and will converge later. A [Vector Clock](../patterns/distributed/coordination/vector-clock.md) tells you when two writes were concurrent, and a [conflict-free replicated data type (CRDT)](../patterns/distributed/coordination/crdt.md) is a data type whose merge needs no decision. When the single leader dies, [Failover](../patterns/distributed/coordination/failover.md) fences it before promoting a standby, so a stale leader's writes are rejected and two nodes lead only if detection or fencing fails.

```mermaid caption="Consistency is bought with latency and availability. Replication strategy decides the exchange rate."
flowchart TB
    W["Write arrives at a node"] -->|"replicate how?"| Q{"Wait for replicas before ack?"}
    Q -->|"yes, quorum confirms"| S["Strong consistency, extra latency"]
    Q -->|"no, ship async after ack"| A["Low latency, replicas lag briefly"]
    S -->|"subsequent read"| R1["sees the latest write"]
    A -->|"subsequent read"| R2["may return stale data"]
```

## Patterns that implement the mechanics
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Write-Ahead Log](../patterns/distributed/coordination/write-ahead-log.md) {#tour-write-ahead-log}

Every change is appended to a durable, ordered log before it touches anything else, and replicas catch up by replaying that log from where they left off. It's what makes replication deterministic and recoverable after a crash.

### [Replication](../patterns/distributed/coordination/replication.md) {#tour-replication}

The copies themselves, kept on separate nodes so a single failure loses nothing already confirmed on another copy; with asynchronous copying, the lag window can still be lost. Whether those copies update synchronously or asynchronously is the dial this whole theme turns on.

### [Quorum & Consensus](../patterns/distributed/coordination/quorum-consensus.md) {#tour-quorum-consensus}

A write counts once W replicas confirm it and a read once R replicas answer. When W plus R is more than N, every read meets the latest write, so a lagging or partitioned node cannot silently answer a quorum read with stale data. Tuning W and R trades latency against how strong the guarantee is.

### [Vector Clock](../patterns/distributed/coordination/vector-clock.md) {#tour-vector-clock}

When replicas take writes on their own, a plain timestamp cannot say whether one write came before another or beside it. Each replica keeps a counter per replica, and comparing two sets of counters shows an older version or a true conflict. You pay a counter per replica on every value, and a conflict still needs a rule to resolve it.

### [CRDT](../patterns/distributed/coordination/crdt.md) {#tour-crdt}

Instead of detecting conflicts and resolving them, build the merge into the data type so replicas that took writes alone converge in any order, with repeats. You give up rules that span replicas, and some types grow memory over time.

### [Leader Election](../patterns/distributed/coordination/leader-election.md) {#tour-leader-election}

Routing every write through one elected node gives replicas a single, unambiguous order to apply — the simplest way to avoid conflicting updates. The cost is a gap in availability whenever that leader disappears and a new one has to be chosen.

### [Failover](../patterns/distributed/coordination/failover.md) {#tour-failover}

Replication keeps a copy, and failover is what uses it when a node fails: detect the failure, fence the old primary, promote a standby and redirect clients. The lag window is the data you can lose, and a wrong detection is how two primaries appear.

### [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) {#tour-change-data-capture}

Log-based capture tails the database's own durable log, so a committed change cannot be missed and the primary takes no polling load. Downstream copies — a search index, a cache, a warehouse — follow the source in commit order without the application writing to each one.

### [Outbox](../patterns/distributed/coordination/outbox.md) {#tour-outbox}

Writing the state change and the event that announces it in the same local transaction, so a crash between the two cannot leave replicas or downstream consumers with only the change or only the event. Delivery is still at least once, so the receiver must deduplicate.

### [Inbox](../patterns/distributed/coordination/inbox.md) {#tour-inbox}

The same gap on the receiving side: record the message's id and apply its effects in one local transaction, and only then acknowledge. A crash before commit acknowledges nothing, so the redelivery meets a record of what was already applied instead of applying it twice.

### [Saga](../patterns/distributed/coordination/saga.md) {#tour-saga}

When a transaction would have to span services with no shared replication underneath, a saga substitutes a sequence of local commits and compensations — trading a global lock for eventual, choreographed consistency.

### [Gossip Protocol](../patterns/distributed/coordination/gossip-protocol.md) {#tour-gossip-protocol}

Nodes trade state with random peers on a steady cadence, and the whole cluster converges without ever electing a leader or forming a quorum — a low-coordination way to keep membership and state close enough to correct.

### [Merkle Tree](../patterns/distributed/coordination/merkle-tree.md) {#tour-merkle-tree}

Copies drift even when every write is sent to all of them. Two replicas compare hashes from the root of a tree down, and only the ranges whose hashes differ are exchanged. Repair costs a scan of the changed ranges instead of the whole data set, and the tree must be kept up to date as writes land.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Approach | Reach for |
| --- | --- | --- |
| Every reader to see the latest write | Synchronous, quorum-backed | [Quorum & Consensus](../patterns/distributed/coordination/quorum-consensus.md), [Replication](../patterns/distributed/coordination/replication.md) |
| To tell which of two writes came first without trusting machine clocks | Track causality | [Vector Clock](../patterns/distributed/coordination/vector-clock.md) |
| Replicas that take writes while cut off to merge without conflicts | Mergeable data types | [CRDT](../patterns/distributed/coordination/crdt.md) |
| A single, unambiguous order for writes | Elect one writer | [Leader Election](../patterns/distributed/coordination/leader-election.md) |
| A dead primary replaced without waking anyone | Automated handover | [Failover](../patterns/distributed/coordination/failover.md) |
| A search index or cache that keeps drifting from the database | Read the change log | [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) |
| Copies that survive a lost machine or a crash without losing data | Durable, ordered log, plus copies on other nodes | [Replication](../patterns/distributed/coordination/replication.md), [Write-Ahead Log](../patterns/distributed/coordination/write-ahead-log.md) |
| The write and its event to never split apart, and a redelivered message applied once | Atomic local write, then record the id on receipt | [Outbox](../patterns/distributed/coordination/outbox.md), [Inbox](../patterns/distributed/coordination/inbox.md) |
| A multi-service transaction without a global lock | Compensating steps | [Saga](../patterns/distributed/coordination/saga.md) |
| Cluster state to converge without coordination | Peer-to-peer gossip | [Gossip Protocol](../patterns/distributed/coordination/gossip-protocol.md) |
| Two big copies compared without sending all the data | Hash tree | [Merkle Tree](../patterns/distributed/coordination/merkle-tree.md) |

## Related areas
<!--meta block=siblings-->

- [CAP Theorem](./cap-theorem.md) — Names the trade-off replication makes explicit the moment the network partitions.
- [Scalability](./scalability.md) — Sharding multiplies the replicas and quorums this theme has to keep in sync.
- [Resilience](./resilience.md) — Durable, replicated state is what lets a system recover instead of losing data.
- [Multi-Step Processes](./multi-step-processes.md) — Where one flow spans services with no shared copy: saga, outbox and inbox sequence local commits there, and here they keep copies and consumers in step.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Data Platform](./data-platform.md) — The store and write-region choice that sets which agreement mechanics apply.

<!-- relationships:end -->
