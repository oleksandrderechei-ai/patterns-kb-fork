---
title: CRDT
description: "Data types whose replicas merge in any order, with repeats, and still converge, with no coordination"
area: distributed-data
owner: Oleksandr Derechei
tags: [consistency, availability]
status: stable
aliases: [conflict-free replicated data type, convergent replicated data type, commutative replicated data type]
solves: [two devices edited the same list offline and syncing them overwrites one side, a counter incremented in two data centres gives the wrong total after they sync, users edit the same document with no server to order their keystrokes, each replica accepts writes during a partition and I do not want to write merge code]
---

# CRDT

A data type built so that its replicas can be changed independently and merged in any order, with any repeats, and every replica still ends on the same value, with no coordination between them.

## What it is
<!--meta block=description-->

A conflict-free replicated data type (CRDT) is a data type that several replicas change on their own and merge in any order, with repeats, and still end on the same value. For types that keep both sides, such as counters and sets, it removes the lost update and the manual repair after a partition, with no leader or agreement step except to compact metadata. It cannot enforce a rule across replicas, such as a balance above zero.

## Explained
<!--meta block=explain-->

A conflict-free replicated data type, or CRDT, is a data structure with a built-in merge. The merge gives the same answer in any order, in any grouping and with repeats: it is commutative, associative and idempotent. Because of that, replicas can take writes alone, swap state in any order over a lossy network (state-based types), and still agree once they have seen the same updates. A counter keeps one slot per replica and merges by taking the larger value per slot. A set tags each add so a remove deletes only what it saw. Choose a CRDT over a leader or [quorum](quorum-consensus.md) when replicas must keep writing while cut off.

- **No cross-replica rules.** A CRDT cannot keep a stock level above zero. Keep such rules on a consensus path.
- **Growing metadata.** Tombstones and per-replica counters pile up. Compact them on a schedule every replica agrees to.

**Example.** Two data centres each count likes on a post with a counter that has one slot per site. During a 10-minute split, site A records 40 likes and site B records 25. Each keeps its own slot only. When the link returns they swap state and merge by taking the larger value per slot, so both show 65. Sending the same state twice, or in the other order, still gives 65. A single shared counter with last-write-wins would have kept 40 or 25 and lost the rest. The cost is that the counter can only go up, and removing a like needs a second slot.

## How it works
<!--meta block=structure-->

```mermaid caption="How can two replicas that never coordinated agree on a count? Each one writes only its own slot at 1 and 2, they swap state at 3, and merging by taking the larger number per slot at 4 and 5 gives both the same total."
flowchart LR
    A["1 Replica A counts 2 locally<br/>{A:2, B:0}"]
    B["2 Replica B counts 3 locally<br/>{A:0, B:3}"]
    MA["A after merge {A:2, B:3}"]
    MB["B after merge {A:2, B:3}"]
    A -->|"3 send state"| B
    B -->|"3 send state"| A
    A -->|"4 max per slot"| MA
    B -->|"5 max per slot"| MB
    MA -.->|"value = sum = 5"| MB
```

```mermaid caption="A remove only deletes the add tags it has seen, so when one replica removes x as another adds it, the new tag survives the merge and x stays."
sequenceDiagram
    autonumber
    participant A as Replica A
    participant B as Replica B
    Note over A,B: both hold x with tag t1
    A->>A: remove x, deletes tag t1
    B->>B: add x again, tag t2
    A->>B: send state, no tags for x
    B->>A: send state, x with t1 and t2
    Note over A,B: merge is a union of tags minus removed ones, so t2 remains
    Note over A,B: both replicas now show x
```

Every CRDT has the same shape: a local state, local update operations that only move the state forward, and a merge that joins two states. A G-Counter is the smallest example. The state is a map from replica to a count, an increment adds one to your own entry, the merge takes the larger number for each entry, and the value is the sum. A counter that also decrements keeps two of them, one for adds and one for removes.

The walk in the first diagram follows that: each replica writes alone, then the states cross in either order or twice, and the maximum per entry gives the same answer.

Sets need more care, because an add and a remove can be concurrent. The **OR-Set** (observed-remove set) tags each add with a unique id. A remove deletes only the tags it has seen, so a concurrent re-add survives, as the second diagram shows. Text works the same way with a larger id: a **sequence CRDT** gives each character a position identifier that sorts between its neighbours and never changes, and a delete leaves a hidden marker so later merges still find the place.

## Variations
<!--meta block=variations-->

- **State-based (convergent)** — each replica sends its whole state, or a delta of it, and the receiver merges. Delivery can be late, lost, reordered or repeated, because the merge absorbs all four. The cost is size: you ship state, not the change.
- **Operation-based (commutative)** — replicas send each operation, such as "add x with tag t2". The messages are small, but the network must deliver every operation to every replica without loss, in causal order, and deduplicated unless the operations are idempotent.
- **Delta-state** — send only the part of the state that changed since the last exchange, and merge it with the same function. Messages are usually far smaller than full state, nearer operation-based size when updates are sparse between exchanges. Deltas still need causal ordering, or a fallback to full state after a gap.
- **Counters, registers and sets** — a G-Counter only goes up, a PN-Counter goes up and down, a last-write-wins register keeps the value with the higher timestamp (see [Clock Skew](../../../hazards/clock-skew.md) for its risk), and an OR-Set lets items be added and removed.
- **Sequence CRDTs for text** — each character or run of characters gets an identifier that fixes its place between its neighbours. This is the CRDT answer to the editing problem the [Google Docs](../../../designs/google-docs.md) design solves with a central server.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No coordination on write** — each replica applies updates locally and stays available through a partition or offline.
- **Merges never conflict** — the type decides the result, so no user or app code resolves a clash.
- **Forgives bad delivery** — state-based types survive duplicate, late and reordered messages, and a lost one heals as long as each replica's state eventually reaches the others, so the sync layer can be as simple as gossip.
- **Peer-to-peer works** — with no central server, devices can sync directly or through any relay.

### Cons
<!--meta polarity=con-->

- **No cross-replica rules** — a limit, a unique name or a balance that must stay non-negative needs agreement, which a CRDT cannot give.
- **Metadata grows** — tombstones, tags and per-replica counters pile up, and removing them safely needs every replica to agree, which is coordination again.
- **Results can surprise** — an add that wins over a concurrent remove, or two edits interleaved in the middle of a word, is correct by the type's rule and still unexpected to a user.
- **Each type takes care to design** — a CRDT for your own structure is hard to get right, so use a vetted type or library.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Replicas must keep taking writes** while cut off, such as devices offline or data centres split, and you want them to converge on reconnection.
- **The data is a counter, a set, a map or text** that merges naturally, such as likes, tags, a cart or a shared document.
- **You have no central server to order writes**, or you want users to keep editing during an outage of it.

### Avoid when
<!--meta polarity=avoid-->

- **A rule spans replicas** — such as stock that must not go below zero — use [Quorum & Consensus](./quorum-consensus.md) for a decision all replicas agree on.
- **A central server already orders everything** — a single leader with [replication](./replication.md) is simpler and carries no growing metadata.
- **You only need to detect conflicts and merge by app rule** — a [Vector Clock](./vector-clock.md) keeps both versions and lets you decide.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a G-Counter and an OR-Set, merged without coordination"
// G-Counter: each replica writes only its own slot; merge = max per slot.
type GCounter = Record<string, number>;
const inc = (c: GCounter, me: string): GCounter => ({ ...c, [me]: (c[me] ?? 0) + 1 });
const value = (c: GCounter) => Object.values(c).reduce((a, b) => a + b, 0);
function mergeCounter(a: GCounter, b: GCounter): GCounter {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}

// OR-Set: adds carry a unique tag; a remove deletes only the tags it saw.
type ORSet = { adds: Set<string>; removed: Set<string> }; // tag = "item|id"
const add = (s: ORSet, item: string, id: string) => s.adds.add(`${item}|${id}`);
const remove = (s: ORSet, item: string) => {
  for (const t of s.adds) if (t.startsWith(item + "|")) s.removed.add(t);
};
const has = (s: ORSet, item: string) =>
  [...s.adds].some((t) => t.startsWith(item + "|") && !s.removed.has(t));
function mergeSet(a: ORSet, b: ORSet): ORSet {
  return { adds: new Set([...a.adds, ...b.adds]), removed: new Set([...a.removed, ...b.removed]) };
}
```

## In the wild
<!--meta block=wild-->

- **Yjs** — An open-source CRDT library for shared text and structured data in the browser and on servers, used to build collaborative editors. {#wild-yjs}
- **Automerge** — An open-source CRDT library that stores a JSON-like document and merges changes made on different devices, including offline. {#wild-automerge}
- **Riak data types** — Riak 2.0 added counters, sets, maps, flags and registers built as CRDTs, so concurrent writes merge by the type's rule instead of leaving siblings. {#wild-riak-data-types}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **state or operation based** — State-based types tolerate lossy delivery and ship more bytes; operation-based types ship less and need reliable, causally ordered delivery.
- **sync interval and delta size** — How often replicas exchange state and whether they send full state or only a delta; longer intervals widen the window in which replicas disagree.
- **garbage-collection schedule** — When tombstones and old per-replica entries are removed; it needs every replica to confirm it has seen them.

### Signals to watch
<!--meta polarity=signal-->

- **metadata size per object** — Tombstones, tags and per-replica entries as a share of live data; a steady rise means nothing is compacting.
- **replica divergence** — The age or version gap between a replica's last merged state and each peer's latest; it is the staleness a reader can see.
- **merge time** — How long a merge takes on a large object; it rises with metadata and delays sync.

### Failure modes under load
<!--meta polarity=failure-->

- **unbounded growth** — A long-lived document or set keeps every tombstone, so memory and load time grow with its history, not its size.
- **violated invariant** — Two replicas each accept a change that is valid alone, and the merged result breaks a rule such as a limit or a unique key.
- **replica that never returns** — A device gone for good blocks compaction that waits for every replica to confirm. Set a timeout after which the replica leaves the confirm set, and resync it from full state if it returns.

### Readiness checklist
<!--meta polarity=check-->

- Confirm the rule you care about needs no agreement across replicas, or keep it on a consensus path
- Pick a vetted type or library before you design your own
- Decide how and when tombstones are compacted and who confirms it
- Test merges with duplicated, reordered and delayed messages

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Consistency & Replication](../../../themes/consistency-and-replication.md) — A merge built into the data type lets replicas take writes alone and still converge. {#fluency-consistency-and-replication}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Gossip Protocol](./gossip-protocol.md) — State-based conflict-free replicated data types (CRDTs) spread by gossip and tolerate its duplicates and reordering.

**Alternative to**

- [Vector Clock](./vector-clock.md) — Builds the merge into the type, so there is nothing to resolve.
- [Quorum & Consensus](./quorum-consensus.md) — Converges with no agreement step, at the cost of enforcing no cross-replica rule.

**Requires**

- [Replication](./replication.md) — Only matters where several replicas accept writes.

**Prevents**

- [Split-Brain](../../../hazards/split-brain.md) — Both sides keep writing during a partition and the merge needs no choice of winner.

<!-- relationships:end -->
