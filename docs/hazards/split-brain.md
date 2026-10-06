---
title: Split-Brain
description: "A partition leaves two leaders, both accepting writes that will not merge"
area: hazards
owner: Oleksandr Derechei
tags: [coordination, availability]
status: stable
aliases: [dual primary, two masters]
solves: [the network partitioned and both halves kept accepting writes, two nodes each believe they are the leader, we ended up with two versions of the truth that will not merge, after the link came back the two sides had conflicting writes]
favourite: true
---

# Split-Brain

A network partition cuts a cluster in two and both halves conclude the other is dead, so both elect a leader and both accept writes — leaving two divergent versions of the truth that no later merge can fully reconcile.

## What it is
<!--meta block=description-->

Split brain is a cluster divided into two groups that each believe they are the survivor. The link fails, both elect a leader and both accept writes, so the single copy of the truth becomes two. You recognise it after the network heals, when records hold two values, because each half reported itself healthy meanwhile. Its root is that a lost message looks identical to a dead peer, so no node can know.

## Explained
<!--meta block=explain-->

Split brain is a cluster that breaks into two groups that each think they are the survivor, so both elect a leader and both accept writes. A silent machine looks the same whether it crashed, is paused by a long garbage-collection cycle, or sits behind a broken link, so a rule that promotes a new leader when the old one goes quiet gives you two leaders when the link is cut. Both halves report healthy, so nobody notices until they rejoin and the same records hold two values. Decide per workload which side of the trade it sits on. Ledgers and stock should stop writing on the smaller side. Carts and telemetry can stay available and merge later. To stop writes, require a majority with [quorum consensus](../patterns/distributed/coordination/quorum-consensus.md): an odd number of voters, and only the side holding more than half elects a leader. To stop a resumed old leader, give each term an increasing number and have storage reject lower ones, as a [fencing token](../patterns/distributed/coordination/fencing-token.md) does.

- **Minority outage.** The smaller side refuses writes until the link heals; that bounded outage is the price of nothing to reconcile.
- **Detector tuning.** Aggressive failure-detector timeouts cause needless failovers; slow ones prolong real outages.

**Example.** A 5-node database has a 3-node group in one data centre and 2 nodes in another, and the link drops for 10 minutes. With promote-on-timeout, both groups elect a leader and accept 20 orders a second, so about 12,000 orders on each side conflict at the merge. With a majority rule, the 3-node side keeps the leader and the 2-node side refuses writes. The old leader, paused 30 s, wakes with term 7 and storage has seen term 8, so its writes are refused.

## How it happens
<!--meta block=causes-->

It starts with silence. One machine stops answering the others, and nobody can tell whether it died or the wire to it did. If the rule is "when the boss goes quiet, pick a new boss", then a broken wire between two rooms full of machines produces a boss in each room — and both of them start giving orders. The moves below are the ordinary ways a cluster ends up with that rule and no way to stop the second boss.

Promotion on timeout alone is what lets both sides promote: each sees only its own side and a failure detector reporting that the rest is gone, and neither holds proof that the old leader has actually stopped. A partition is not observable from inside a partition, so no amount of waiting turns that guess into knowledge.

Underneath sits the impossibility result the design has to respect: with asynchronous messaging you cannot both guarantee progress and guarantee agreement in the presence of failures, so a cluster must give one of them up on purpose. Split brain is what happens when nobody made that choice explicitly — availability was assumed and consistency was assumed, so the failure detector was tuned for the former and the write path was written for the latter.

```mermaid caption="One failure, two leaders: each side applies the same promotion rule to the same evidence, and the divergence is only discovered when the halves rejoin."
flowchart TB
    N["Link between racks fails"] --> A["Side A: 'the others are gone'"]
    N --> B["Side B: 'the others are gone'"]
    A -->|"promote on timeout"| LA["Leader A accepts writes"]
    B -->|"promote on timeout"| LB["Leader B accepts writes"]
    LA --> D["Two histories, same keys"]
    LB --> D
    D -->|"network heals"| M["Merge must discard someone's writes"]
```

- Promotion on timeout with no quorum requirement: any side that stops hearing the leader elects its own, so a two-way partition produces two leaders and a three-way one can produce three.
- An even-sized cluster, or two data centres with equal votes, where no side can ever hold a strict majority — so either both sides promote, or neither does and the cluster stops.
- A leader that was never actually stopped: a long garbage-collection pause or a hung disk makes it miss heartbeats, the cluster replaces it, and then it resumes still believing it holds the role.
- A demoted leader whose in-flight writes are still accepted downstream, because the storage layer takes writes from whoever asks and has no way to tell that this caller's term has expired.
- An asymmetric or partial partition, where A can reach B but B cannot reach A, so the two sides disagree about who is reachable and a failure detector on either side produces a different answer.

## What it costs
<!--meta block=cost-->

- **Two versions of the truth, and no way to compute the right one.** Both halves accepted valid writes, so the merge is not a technical question but a business one: someone has to decide which customer's order survives.
- **Silent damage while it runs.** Each side answers requests successfully and reports itself healthy, so the incident starts at the moment of the partition and is discovered at the moment of the merge — often hours later.
- **Mutual exclusion stops holding.** A [distributed lock](../patterns/distributed/coordination/distributed-lock.md) or a leader-only job granted on one side is granted again on the other, so two processes run a supposedly single-writer task and corrupt what it touches.
- **Recovery costs more than the outage would have.** Reconciling divergent histories means comparing records, replaying logs and calling customers; refusing writes on the minority side for the same period would have been a bounded, understood loss of availability.
- **Downstream systems keep the damage.** Both halves emitted events, sent notifications and charged cards; you can roll back a database row, but not an email or a payment already captured.

Split brain converts the minority side’s bounded, self-healing availability loss into an unbounded correctness loss, and correctness losses do not expire when the network recovers: they surface as disputed invoices, duplicate shipments and a ledger that no longer reconciles months later. That asymmetry is why mature systems choose to stop rather than to guess, and why the argument for staying available during a partition has to be made per workload, not per cluster.

## Getting out
<!--meta block=mitigation-->

Require a majority before anyone acts. Give the cluster an odd number of voting members and let only the side holding more than half of them elect a leader or accept a write; a partition can produce at most one majority, so the minority side stops instead of diverging. This is the whole point of the consensus protocols — a quorum turns "I cannot hear them" into "I do not have the right to proceed", which is the distinction a timeout alone can never make.

Then make an old leader harmless, because a quorum decides who may write and does not by itself stop who was writing. Fence the resource: attach a monotonically increasing token to the leadership term, have the storage or lock service record the highest token it has seen, and reject anything arriving with a lower one — so a leader that wakes up from a long pause finds its writes refused rather than applied. Where the resource cannot check a token, the blunt equivalent is to cut the old node off entirely — power it down or revoke its network access before promoting a replacement — so that exclusion is enforced by something outside the node's own judgment.

Choose the failure detector's timeouts with the cost of both mistakes in view: too short and a garbage-collection pause triggers a needless failover, too long and every real crash costs that much downtime. Where a majority is structurally impossible — two data centres with equal votes — add a small third voter in a third location whose only job is to break ties, rather than letting an even split decide by luck. And decide in advance what a workload does on the minority side: rejecting writes is the safe default, while accepting them is a deliberate choice that obliges you to design the merge, which means conflict-free data types or a recorded resolution policy, not a hope that timestamps will settle it.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Clock Skew](./clock-skew.md) — A partition gives two leaders, where skew gives two holders through mistimed expiry.

**Mitigated by**

- [Quorum & Consensus](../patterns/distributed/coordination/quorum-consensus.md) — Only a majority may commit, so one side must stop
- [Leader Election](../patterns/distributed/coordination/leader-election.md) — Election with terms and fencing stops a stale leader writing
- [CRDT](../patterns/distributed/coordination/crdt.md) — Conflict-free merging makes divergent writes harmless where availability must be kept.
- [Failover](../patterns/distributed/coordination/failover.md) — Failover with fencing is the guard against a returning old primary writing alongside the new one.
- [Fencing Token](../patterns/distributed/coordination/fencing-token.md) — A rising token checked at storage stops a stale node from writing after a split.
- [Heartbeat](../patterns/distributed/coordination/heartbeat.md) — Careful failure detection keeps a pause from being read as a death that splits the cluster.
- [Lease](../patterns/distributed/coordination/lease.md) — A lease stops a holder that can see its own clock, but a paused holder still acts, so add a fencing token checked at the resource.
- [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) — A fencing token gets a resumed leader's writes rejected

<!-- relationships:end -->
