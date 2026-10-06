---
title: Vector Clock
description: "Per-replica counters on each version, so a store can tell an older write from a concurrent one"
area: distributed-coordination
owner: Oleksandr Derechei
tags: [consistency, state-management]
status: stable
aliases: [version vector, logical clock, Lamport timestamp]
solves: ["two replicas took a write for the same key while cut off, and now I cannot tell which is newer", last write wins by timestamp keeps dropping one of two simultaneous edits without any error, my shopping cart lost an item when the phone and the laptop both added one, I need to know whether one update came before another without trusting machine clocks]
---

# Vector Clock

Give every version of a value a small map of counters, one per replica that has written it, so any two versions can be compared and told apart as one older than the other or as written without knowledge of each other.

## What it is
<!--meta block=description-->

When replicas accept writes without coordinating, a store that orders versions by wall-clock time silently loses one of two concurrent writes. A vector clock attaches a map of counters, one per replica, to each version. Comparing two maps shows whether one version came from the other or the two are concurrent, so the store keeps both. It does not merge them for you.

## Explained
<!--meta block=explain-->

A vector clock is a small map of counters, one per replica, attached to each version of a value. A replica that writes adds one to its own counter. A reader that merges siblings takes the larger counter for each entry, then adds one on its own. To compare two versions, check every entry: if one map is at most the other everywhere, that version is an ancestor and you can drop it. If each map is ahead somewhere, the writes were concurrent, meaning neither writer saw the other, and you keep both. Choose it over last-write-wins by timestamp when replicas accept writes without a leader and losing an update is costly, because machine clocks drift and timestamps pick a winner by accident.

- **No merge.** It finds conflicts but does not resolve them, so write a merge rule or store the value as a conflict-free data type.
- **Growing clock.** One entry per writer. Server names bound it but can falsely order concurrent client writes; capping costs false conflicts.

**Example.** Three replicas hold a cart. A stores \[milk\] with clock {A:1}. Phone and laptop both read it. The phone writes through B: \[milk, eggs\], clock {A:1, B:1}. The laptop writes through C: \[milk, bread\], clock {A:1, C:1}. When a replica compares them, B is ahead on one entry and C on the other, so it keeps both. The next read returns both carts, the app takes the union \[milk, eggs, bread\], and writes it back with clock {A:1, B:1, C:1} plus one on the writer, so it beats both. With timestamps, one of the two items would have been dropped without a trace. A union cannot tell a removed item from an unseen one, so deletes can return.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a store tell a stale version from a concurrent one? Each write adds one to its own replica's counter at 1, 2 and 3, and the comparison at 4 finds that v2 and v3 each lead on one entry, so 5 keeps both while v1, behind both, is dropped at 6."
flowchart LR
    V1["v1 {A:1}"]
    V2["v2 {A:1, B:1}"]
    V3["v3 {A:1, C:1}"]
    Cmp{"Compare v2 and v3"}
    Keep["Keep both as siblings"]
    Drop["Drop v1"]
    V1 -->|"1 B reads v1, writes"| V2
    V1 -->|"2 C reads v1, writes"| V3
    V2 -->|"3 reader fetches"| Cmp
    V3 -->|"3 reader fetches"| Cmp
    Cmp -->|"4 B:1 vs 0, C:0 vs 1"| Keep
    V1 -->|"6 behind both"| Drop
    Keep -->|"5 caller merges, writes v4"| V4["v4 {A:1, B:1, C:1}"]
```

```mermaid caption="Two replicas write without seeing each other, and the clocks show it: replica B compares the two versions, finds each ahead on one entry, and returns both."
sequenceDiagram
    autonumber
    participant A as Replica A
    participant B as Replica B
    participant R as Reader
    A->>A: write x, clock {A:1}
    B->>B: write x, clock {B:1}
    Note over A,B: neither saw the other's write
    A->>B: replicate x {A:1}
    B->>B: compare {A:1} with {B:1}
    Note over B: each is ahead on one entry, so concurrent
    B->>B: keep both versions
    R->>B: read x
    B-->>R: both versions with their clocks
    R->>B: write merged x, clock {A:1, B:2}
```

Each replica keeps one counter per replica it has heard of, and the clock travels with the data, not with the machine. The walk has four rules:

1. **On a local write**, the replica adds one to its own entry in the clock of the version it started from.
2. **On receiving a version**, it compares the incoming clock with each clock it holds.
3. **If one clock is at most the other in every entry**, the lower version is an ancestor and the replica drops it.
4. **If neither is**, the versions are concurrent and the replica keeps both. The next reader receives both clocks, merges the values by whatever rule the application has, and writes the result with an entry-wise maximum of the clocks plus one on its own entry. That new clock is ahead of both siblings, which retires them.

Cost shows up in step 4. Siblings pile up if nobody merges, and the clock gains an entry for every replica that ever wrote.

## Variations
<!--meta block=variations-->

- **Lamport timestamp** — Leslie Lamport's logical clock (1978): one counter per process instead of a vector, carried by every message and pushed past the sender's value by every receiver. Colin Fidge and Friedemann Mattern independently proposed the vector form in 1988. It is tiny and gives a total order (every event gets one fixed place in line, ties broken by process ID) that respects cause and effect, which suits ordering a log or breaking ties. It cannot say two events were concurrent, so it cannot detect a conflict.
- **Version vector** — the same structure, but it counts versions of one item per replica instead of events per process, and it advances only on writes to that item, not on every message. Replicas of a database use it to decide which copy of a key is newer or in conflict, which is the form you meet in storage systems.
- **Dotted version vector** — a version vector that also carries the single event, a dot, that created this version. It stops one replica serving many clients from falsely marking their concurrent writes as ordered, and so keeps the number of siblings from growing without need. Riak adopted it for that reason.
- **Pruned clock** — a vector cut to a fixed size by removing the oldest entries. Amazon's Dynamo paper describes this, with a size threshold. The clock stays small, but a removed entry makes a descendant look concurrent, so you get a few extra siblings.
- **Hybrid logical clock** — a wall-clock reading and a small counter in one value, which stays close to real time and still orders causally. It orders versions but, like a Lamport timestamp, cannot detect concurrency. It is the usual choice when you want ordered timestamps that humans can read; see [Clock Skew](../../../hazards/clock-skew.md).

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Detects concurrent writes** — a store that keeps both versions loses no update, provided each entry identifies the writer and readers merge and write back, where wall-clock order drops one without a sign.
- **Needs no synchronised clocks** — it counts events, not seconds, so a replica with a clock hour off still orders correctly.
- **Needs no coordination on write** — a replica ticks its own counter locally, so writes stay available during a partition.
- **Proves ancestry both ways** — a lower clock means an ancestor and a concurrent pair means a conflict, which a Lamport timestamp cannot tell you.

### Cons
<!--meta polarity=con-->

- **Detects conflicts but does not resolve them** — siblings go back to the reader, so you must write a merge rule or keep the data in a [conflict-free replicated data type (CRDT)](./crdt.md).
- **The clock grows with the writers** — one entry per replica or client that ever wrote, so a large fleet gives a clock as large as the value; pruning cuts it at the price of false conflicts.
- **Siblings pile up** — if readers do not merge and write back, each concurrent write adds a version to store, ship and return.
- **Entries are tied to identity** — a client that gets a new ID on each restart adds a new entry every time, a replica that is replaced must hand its counter over, and one that restarts with an empty counter reuses values and corrupts ordering. A write that omits the context it read counts as concurrent with everything.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several replicas accept writes** for the same key with no leader, and you must not lose either of two concurrent updates.
- **You cannot trust the clocks** on your machines to order writes, and a lost update would cost money or a customer's data.
- **You want to show the user a conflict** or merge it by rule, such as a union of two carts, rather than pick a winner at random.

### Avoid when
<!--meta polarity=avoid-->

- **A single leader orders every write** — a position in its [replicated log](./replication.md) is already a total order, and a vector adds bytes for nothing.
- **Losing the older of two writes is acceptable** — last-write-wins by timestamp is simpler, with the risk set out under [Clock Skew](../../../hazards/clock-skew.md).
- **You want merges to need no code** — put the value in a [CRDT](./crdt.md), which merges by construction.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — tick, merge and compare a vector clock"
type VC = Record<string, number>;

// A replica writing adds one to its own entry.
const tick = (vc: VC, me: string): VC => ({ ...vc, [me]: (vc[me] ?? 0) + 1 });

// On receipt, take the larger counter per entry (before ticking).
function merge(a: VC, b: VC): VC {
  const out: VC = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}

// "before" means a is an ancestor of b; "concurrent" means keep both.
function compare(a: VC, b: VC): "before" | "after" | "equal" | "concurrent" {
  let behind = false, ahead = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0, y = b[k] ?? 0;
    if (x < y) behind = true;
    if (x > y) ahead = true;
  }
  if (behind && ahead) return "concurrent";
  return behind ? "before" : ahead ? "after" : "equal";
}
```

## In the wild
<!--meta block=wild-->

- **Amazon Dynamo** — The 2007 Dynamo paper uses a vector clock per object version, returns concurrent versions to the client to reconcile, and describes truncating the clock past a size threshold. {#wild-dynamo}
- **Riak** — Riak tracks causality per object with vector clocks and, from version 2.0, with dotted version vectors, and can return sibling values on a conflicting write. {#wild-riak}
- **Lamport, Time, Clocks, and the Ordering of Events in a Distributed System** — The 1978 paper that introduced logical clocks and the happened-before relation on which vector clocks build. {#wild-lamport-paper}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **clock entry identity** — Use a replica or server ID as the entry, not a client ID, so the clock is bounded by the number of servers and a restarting client adds no entry. With server IDs alone, concurrent writes from different clients through one server look ordered and the older is dropped; pair them with a dot (see Dotted version vector) or read before writing.
- **pruning threshold** — The maximum number of entries kept before the oldest is dropped; a lower cap keeps values small and a higher cap avoids false siblings. Set it above the number of servers that can coordinate writes to one key, then raise it while the false-sibling rate falls.
- **merge rule** — What reconciles siblings on read: a union, a per-field choice or a call back to the application.

### Signals to watch
<!--meta polarity=signal-->

- **sibling count per key** — A rising count means no reader is merging and writing back.
- **clock size** — Entries or bytes per version; it grows with the number of distinct writers.
- **share of reads returning several versions** — The direct measure of how often concurrent writes reach a reader.

### Failure modes under load
<!--meta polarity=failure-->

- **sibling explosion** — Many writers update a hot key without reading first, so each read returns and each write ships a long list of versions.
- **false conflicts after pruning** — A dropped entry makes an ordered pair look concurrent, so you merge versions that were not in conflict. Count merges that yield one version equal to an ancestor; if the count climbs, raise the cap.
- **entry sprawl** — Clients that take a new ID on each start add an entry every time, and the clock grows without bound.

### Readiness checklist
<!--meta polarity=check-->

- Decide who merges siblings and write that merge rule before the first release
- Use stable server IDs as clock entries and cap the clock size
- Read before you write, passing the clock back, so each write is a descendant
- Alert on keys whose sibling count keeps rising

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Consistency & Replication](../../../themes/consistency-and-replication.md) — Per-replica counters tell an older version from a concurrent one, so no update is silently dropped when replicas take writes alone. {#fluency-consistency-and-replication}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Quorum & Consensus](./quorum-consensus.md) — A Dynamo-style quorum returns several versions and the clocks say which are concurrent.
- [Merkle Tree](./merkle-tree.md) — A Merkle repair finds the differing keys, and the clocks pick the newer version.

**Alternative to**

- [Optimistic Concurrency Control](./optimistic-concurrency-control.md) — Detects concurrent writes across replicas with no single version counter to check.
- [CRDT](./crdt.md) — Detects the conflict and leaves the merge to you.
- [Leader Election](./leader-election.md) — A leader gives one write order, so no clock is needed; a vector clock serves replicas with no leader.

**Requires**

- [Replication](./replication.md) — Version comparison only matters once more than one copy of the data accepts writes.

**Prevents**

- [Clock Skew](../../../hazards/clock-skew.md) — Removes the dependence on wall-clock order that skew breaks.

<!-- relationships:end -->
