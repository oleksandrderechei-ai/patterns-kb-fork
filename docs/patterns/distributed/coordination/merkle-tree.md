---
title: Merkle Tree
description: "A tree of hashes over key ranges, so two replicas find which ranges differ with a few comparisons"
area: distributed-data
owner: Oleksandr Derechei
tags: [replication, durability]
status: stable
aliases: [hash tree, anti-entropy tree]
solves: [two replicas should hold the same millions of keys and I cannot afford to compare every one, a replica missed some writes and nothing repairs keys that nobody reads, I need to find the few records that differ between two big copies without sending all of the data, how to check that two copies of a large dataset match by comparing one small value]
---

# Merkle Tree

Hash each block of data, then hash the hashes in pairs up to a single root, so two replicas compare one value to learn whether they match and walk down the tree to the exact ranges that differ.

## What it is
<!--meta block=description-->

Two replicas holding millions of items drift apart, and comparing every key moves the whole dataset to find a handful of differences. A Merkle tree is a tree of hashes over the data, where each parent hashes its children. Replicas compare roots, then descend only into the child that differs, so the work scales with the number of differences.

## Explained
<!--meta block=explain-->

A Merkle tree is a tree of hashes over a dataset. You cut the key space into ranges, hash the keys and values in each range, and then hash those hashes in pairs up to one root hash. Two replicas compare roots. If they match, the data matches as of the moment each tree was built, and the check cost one message. If not, they compare the two child hashes, descend only into the child that differs, and stop at the one range that is out of step, where they swap the keys and keep the newer version. Choose it over a full scan when replicas hold millions of items that mostly agree. This background repair is called anti-entropy.

- **Build cost.** Building the tree means reading the data. Build it off-peak or update it as you write.
- **Same ranges needed.** Both sides must cut ranges the same way. Rebuild after nodes join or leave.

**Example.** Two replicas each hold 1,048,576 keys in 1,024 ranges of about 1,024 keys, a tree 10 levels deep. Nine keys on one range are missing on B. The roots differ. At each of the 10 levels the replicas exchange two hashes, so about 20 hashes cross the network and one range is found. They then swap the 1,024 keys of that range and B gains its nine. Comparing every key would have meant checking over a million keys to find nine. The cost is the build: hashing all 1,048,576 keys means one pass over the disk on each node, repeated whenever the data changes.

## How it works
<!--meta block=structure-->

```mermaid caption="How do two replicas find the one range that differs among a million keys? They compare roots at 1, skip every matching child at 2 and 4, descend into the differing one at 3, and reach the single differing range at 5, so only that range is copied at 6."
flowchart TB
    Root{"1 Compare roots"}
    L["2 Left child: hashes match, skip"]
    R["3 Right child: hashes differ, descend"]
    RL["4 Right-left: match, skip"]
    RR["5 Right-right: differ, one range"]
    Fix["6 Copy only the keys in that range"]
    Root -->|"differ"| L
    Root -->|"differ"| R
    R --> RL
    R --> RR
    RR --> Fix
```

```mermaid caption="Replicas A and B exchange hashes one level at a time and stop descending wherever the hashes agree, so the traffic is a few hashes plus one range of keys."
sequenceDiagram
    autonumber
    participant A as Replica A
    participant B as Replica B
    A->>B: root hash
    B-->>A: differs
    A->>B: hashes of the two children
    B-->>A: left matches, right differs
    A->>B: hashes of the right child's two children
    B-->>A: left matches, right differs
    A->>B: keys and values of the leaf range
    B-->>A: its keys and values for that range
    Note over A,B: each side keeps the newer version of every key in the range
```

Building the tree takes three decisions. Both replicas must cut the key space into the same ranges, because a hash only matches if it covers the same keys. Each leaf holds the hash of the keys and values in its range. Each inner node holds the hash of its two children's hashes, up to one root.

Comparing then runs top down. Equal hashes mean equal data below, so you skip the whole subtree. Different hashes mean something below differs, so you descend and compare the children. At a leaf you exchange the actual keys, compare versions and copy what is missing. The tree does not say which side is right, only where to look. For that you need a version rule, such as a [vector clock](./vector-clock.md) or a timestamp.

## Variations
<!--meta block=variations-->

- **Anti-entropy repair between replicas** — each node keeps a tree per key range it holds and trades hashes with a peer on a schedule. Dynamo-style stores use this. It runs beside read repair, which only fixes keys someone reads.
- **Tree built on demand** — the tree is computed when a repair starts, by scanning the data, so nothing is stored between runs. It costs a scan of disk each time, and the tree reflects the data at scan time.
- **Tree kept up to date** — the tree is updated as writes arrive, so a comparison is cheap at any moment. It costs extra work on every write and extra space.
- **Branching factor and depth** — a wider tree means fewer levels and more hashes per message; a deeper binary tree sends less per round and needs more rounds. The number of leaves sets how many keys you copy for one difference.
- **Proof of inclusion** — the hashes along one path are enough to prove that an item is in the set, without holding the set. Git object ids, blockchain block headers and transparency logs use this property.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **A match costs one message** — when trees are kept up to date, two healthy replicas confirm they agree by exchanging one root hash, so repair on a clean cluster is nearly free; with on-demand builds the scan, not the message, is the cost.
- **Work scales with the differences, not the data** — one differing range costs about as many comparisons as the tree is deep, so k scattered ranges cost about k times that and scattered drift erodes the saving.
- **Finds drift nobody reads** — keys that stay cold and never trigger a read repair still get checked.
- **Needs no clocks to find drift** — the tree only says where two copies differ; picking the winner is left to a version rule you still supply.

### Cons
<!--meta polarity=con-->

- **The tree costs to build** — hashing every key means reading the data, which loads the disk of a busy node; build it off-peak or incrementally.
- **A hot range needs fresh hashes** — hashes of data that keeps changing are stale by the time you compare, so you copy ranges that already moved on.
- **Coarse leaves copy extra** — one differing key makes you exchange the whole leaf range, so tune the number of leaves to the data size.
- **Both sides must cut ranges the same way** — when nodes join or leave and ranges change, trees must be rebuilt, which is a burst of work at the worst time.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Replicas hold millions of items** and drift apart slowly, so a full scan to compare them is too slow and too costly in network.
- **You need a background repair** that finds the keys no read has touched, in a store without a central log.
- **You must prove data is intact** or an item belongs to a set, with a short proof, without trusting the holder.

### Avoid when
<!--meta polarity=avoid-->

- **The question is membership of one key** — a [Bloom Filter](./bloom-filter.md) answers it from a few bits, with a small false-positive rate.
- **Copies are small or change in a stream** — send the change log from a [replicated](./replication.md) leader, since a log gives order and a tree does not.
- **You only need to spread news of changes** — [gossip](./gossip-protocol.md) carries it; a tree is for finding missed ones afterward.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — build a hash tree over ranges, then list the ranges that differ"
import { createHash } from "node:crypto";

type Node = { hash: string; lo: number; hi: number; kids?: [Node, Node] };
const h = (s: string) => createHash("sha256").update(s).digest("hex");

// Leaves hash the keys and values of one range; parents hash their children.
function build(ranges: string[][], lo = 0, hi = ranges.length): Node {
  if (hi - lo === 1) return { hash: h(ranges[lo].join("|")), lo, hi };
  const mid = (lo + hi) >> 1;
  const l = build(ranges, lo, mid), r = build(ranges, mid, hi);
  return { hash: h(l.hash + r.hash), lo, hi, kids: [l, r] };
}

// Skip any subtree whose hashes match; descend only where they differ.
function diff(a: Node, b: Node): number[] {
  if (a.hash === b.hash) return [];
  if (!a.kids || !b.kids) return [a.lo];
  return [...diff(a.kids[0], b.kids[0]), ...diff(a.kids[1], b.kids[1])];
}
// Both trees must be built over the same ranges, in the same order.
```

## In the wild
<!--meta block=wild-->

- **Amazon Dynamo** — The 2007 Dynamo paper uses Merkle trees per key range for anti-entropy, so replicas find divergent keys while exchanging only hashes. {#wild-dynamo}
- **Apache Cassandra** — Anti-entropy repair, run with nodetool repair, builds Merkle trees of each replica's data and streams the ranges that differ. {#wild-cassandra}
- **Git** — Object ids are hashes of content and each tree object hashes its entries, so one commit id fingerprints the whole snapshot and unchanged subtrees are skipped. {#wild-git}
- **Certificate Transparency (RFC 6962)** — Logs of issued certificates are Merkle trees, and a short path of hashes proves a certificate is in the log. {#wild-ct}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **number of leaf ranges** — More leaves mean fewer keys copied for one difference and a larger tree to hold and send; fewer leaves mean the reverse. Size it as total keys divided by the keys you accept copying per difference: the explain example is 1,048,576 keys in 1,024 ranges, so 1,024 keys copied per difference. Check it against bytes streamed per repair.
- **repair schedule** — How often replicas compare trees; it bounds how long drift can last before it is found. Set the interval shorter than the time you can tolerate one lost copy, and check it against ranges found different per run.
- **build mode** — Build the tree on demand by scanning, or keep it updated on each write; the first costs disk reads per run and the second costs work per write.

### Signals to watch
<!--meta polarity=signal-->

- **tree build time and disk read load** — The cost of a repair run on a busy node, and the number to watch when it competes with live traffic.
- **ranges found different per run** — A steady rise outside outages and topology changes means writes are being missed in normal operation. Alert when a run exceeds its own recent average.
- **bytes streamed per repair** — The data actually copied, which should track the real differences.

### Failure modes under load
<!--meta polarity=failure-->

- **repair competes with traffic** — Hashing every key on a node already near its disk limit raises read latency until the build ends.
- **stale trees on hot ranges** — Data changes between hashing and comparing, so ranges that already converged get copied again.
- **mismatched ranges after topology change** — Nodes that cut ranges differently produce hashes that never match, and each comparison falls to the leaves.

### Readiness checklist
<!--meta polarity=check-->

- Fix the range boundaries so every replica cuts the key space the same way
- Run repair often enough that drift is found before data is lost on the only good copy
- Schedule builds off-peak or throttle them
- Decide the version rule that picks the winner for a differing key

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Consistency & Replication](../../../themes/consistency-and-replication.md) — Compares hashes down a tree to find the few ranges two replicas disagree on, so repair does not scan everything. {#fluency-consistency-and-replication}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Vector Clock](./vector-clock.md) — The tree says where copies differ and a version rule such as a vector clock picks the winner.
- [Gossip Protocol](./gossip-protocol.md) — Gossip tells replicas about new writes and a Merkle repair finds the ones that were missed.
- [Quorum & Consensus](./quorum-consensus.md) — Repair brings replicas back toward the state a quorum write intended.

**Requires**

- [Replication](./replication.md) — Exists to find drift between copies.

**Often confused with**

- [Bloom Filter](./bloom-filter.md) — Both summarise a large set, but a tree finds exactly which ranges differ and a filter answers membership with false positives.

<!-- relationships:end -->
