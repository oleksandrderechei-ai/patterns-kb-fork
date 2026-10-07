---
title: CAP Theorem
description: "When the network splits, you choose consistency or availability — never both"
area: themes-data
owner: Oleksandr Derechei
tags: [consistency, availability]
status: stable
aliases: [CAP, Brewer's theorem]
favourite: true
---

# CAP Theorem

When the network splits, a distributed data store can keep answering or keep every copy in agreement — but not both. Consistency, availability, partition tolerance (CAP) is the lens for that choice, and for the patterns that implement each side of it.

## The question
<!--meta block=description-->

When the network drops messages between nodes, a partition, a node holding your data has two choices: answer with what it knows and risk being out of date, or refuse until it can confirm with its peers. CAP says a system cannot guarantee all three of Consistency (every read sees the latest write), Availability (every request gets a non-error response) and Partition tolerance (the system works despite dropped messages). Partitions happen, so decide in advance which way to fall.

## Explained
<!--meta block=explain-->

The CAP theorem says that when a network split cuts your database copies ([replication](../patterns/distributed/coordination/replication.md)) off from each other, each copy must either answer with what it knows, which may be out of date, or refuse to answer until it can confirm with the others ([quorum](../patterns/distributed/coordination/quorum-consensus.md)). You cannot have both, so you decide in advance which way to fall. Splits happen on every real network, so the real choice is between the two. Choose the refusing side (CP, consistency kept through the split) when a wrong answer costs more than an error, as with a ledger or a unique username. Choose the answering side (AP, availability kept through the split) when a stale answer is acceptable, as with a shopping cart or a feed.

- **Refusals.** A refusing system returns errors during the split, so let the majority side keep serving; two copies leave neither side a majority.
- **Conflicts.** An answering system accepts conflicting writes; define a merge rule (a \[CRDT\](../patterns/distributed/coordination/crdt.md) merges by design; last-write-wins drops a write) or a compensating action.
- **Normal-time latency.** Even with a healthy network, keeping copies in step costs round trips (PACELC: latency against consistency), so pick consistency per operation.

**Example.** A bank keeps a balance of 100 in data centres A, B and C, and a 10-minute link failure cuts B off from A and C. As CP, A and C hold a majority and keep serving, while B refuses withdrawals, so B customers get errors and the balance stays correct. As AP, A and B each accept an 80 withdrawal. When the link returns, the balance is 100 - 80 - 80 = -60, so you must add a rule, such as an overdraft fee or reversing the second withdrawal. A shopping cart in the same split would just merge both item lists, which is why carts suit AP and ledgers suit CP.

## The trade-space
<!--meta block=tradespace-->

The framing "pick two of three" is a little misleading. On any real network, partitions will happen — so **P is not optional**. The real decision is what to do during a partition: sacrifice consistency to stay available (**AP**), or sacrifice availability to stay consistent (**CP**).

A **CP** store refuses reads and writes it can't confirm across a quorum — safe, but it returns errors when partitioned. An **AP** store keeps accepting reads and writes on both sides of the split and reconciles later — always answers, but two clients can see different truths until the split heals and the sides reconcile. Neither is "better"; a bank ledger wants CP, a shopping cart or social feed usually wants AP. When the network is healthy, CAP forces no choice, though strong consistency still costs latency (PACELC, below).

Read the labels narrowly. CAP's availability is the literal 100% kind — every request to a reachable node answers — so a store that refuses even a handful of writes during a rare partition is formally **CP**. Google Spanner is the canonical case: technically CP, yet available enough in practice that the label says little about its uptime. CP and AP tell you what happens during a partition, not what uptime you will measure over a year. CAP's consistency means linearizability, one agreed order of operations that every client sees, not the C in ACID.

Its practical cousin, **PACELC**, extends the idea: if Partitioned, choose A or C; Else, choose Latency or Consistency — because even with no partition, keeping copies in sync costs round-trips.

```mermaid caption="CAP only forces a choice during a partition. The design decision is which branch you take."
flowchart TD
    P{"Network partition?"}
    P -->|"No"| E["Serve fast from any replica, sync in the background"]
    P -->|"Yes"| C{"Choose during the split"}
    C -->|"Stay consistent (CP)"| CP["Reject writes without a quorum, return errors"]
    C -->|"Stay available (AP)"| AP["Accept on both sides, reconcile later"]
```

## Patterns that implement the choice
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Write-Ahead Log](../patterns/distributed/coordination/write-ahead-log.md) {#tour-write-ahead-log}

The durable, ordered record replicas ship and replay to converge. It is the mechanism underneath consistent replication.

### [Replication](../patterns/distributed/coordination/replication.md) {#tour-replication}

The copies whose agreement CAP is about. Synchronous replication leans consistency-first (CP). Asynchronous replication leans availability-first (AP) with low latency, but followers can serve stale reads and a leader failover can lose the most recent writes.

### [Quorum & Consensus](../patterns/distributed/coordination/quorum-consensus.md) {#tour-quorum-consensus}

The dial itself. Requiring a majority to agree before a write counts is how a consistency-first (CP) store trades availability for a single, agreed truth. Tuning read/write quorum sizes moves you along the C/A spectrum: with N copies, W + R > N makes every read overlap the latest write, while a sloppy quorum gives that up to stay available.

### [Leader Election](../patterns/distributed/coordination/leader-election.md) {#tour-leader-election}

Funnelling writes through one elected leader gives a clean, consistent order — a consistency-first (CP) move that becomes unavailable if the leader is partitioned away until a new one is chosen.

### [Saga](../patterns/distributed/coordination/saga.md) {#tour-saga}

An availability-first (AP)-style fit for multi-service transactions: each step commits on its own and compensating steps reconcile later, so nothing waits on a [distributed lock](../patterns/distributed/coordination/distributed-lock.md). The price is eventual consistency and no isolation while the saga runs.

### [Gossip Protocol](../patterns/distributed/coordination/gossip-protocol.md) {#tour-gossip-protocol}

Peer-to-peer state spreading that always accepts updates and converges over time — an availability-first (AP) building block for membership and eventually-consistent state.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Lean | Reach for |
| --- | --- | --- |
| A correct ledger, balances, unique constraints | CP | [Quorum](../patterns/distributed/coordination/quorum-consensus.md), [Leader Election](../patterns/distributed/coordination/leader-election.md) |
| Always-on reads/writes, tolerate brief staleness | AP | [Gossip](../patterns/distributed/coordination/gossip-protocol.md), async [Replication](../patterns/distributed/coordination/replication.md) |
| Cross-service "transaction" without a global lock | AP | [Saga](../patterns/distributed/coordination/saga.md) |
| Low latency when healthy, safety when split | CP when split, low latency when healthy | Tunable [quorums](../patterns/distributed/coordination/quorum-consensus.md) per operation |

## Related areas
<!--meta block=siblings-->

- [Consistency & Replication](./consistency-and-replication.md) — The mechanics — replicas, quorums, and logs — behind the CAP choice.
- [Scalability](./scalability.md) — Sharding and replication multiply the nodes CAP reasons about.
- [Resilience](./resilience.md) — Staying available under partition is a resilience goal too.
