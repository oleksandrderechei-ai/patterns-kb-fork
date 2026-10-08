---
title: Copy-on-Write
description: Readers never lock — writers publish a new copy
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, immutability, state-management, read-optimization]
status: stable
aliases: [COW, CoW]
solves: [readers block while one thread updates a config map that changes twice a day, I have to copy the whole list before iterating so a concurrent change cannot corrupt the loop, cloning the object on every write is fine until the object gets big, a reader saw the structure half-updated and crashed, I want readers to never take a lock but writes still have to be safe]
---

# Copy-on-Write

Readers never lock — writers publish a new copy: a writer clones the shared structure, edits the clone, and swaps in one reference, so every reader gets a complete version instead of a half-updated one.

## What it is
<!--meta block=description-->

A reader walking a shared structure sees nonsense if a writer edits it halfway through, and a lock makes every reader queue behind the writer. Copy-on-write never edits in place. The writer copies the structure, changes the copy and swaps one shared reference to publish it. Each reader keeps the version it grabbed and reads it to the end, so readers take no lock.

## Explained
<!--meta block=explain-->

Copy-on-write lets readers use a shared structure without any lock, because nobody changes it in place. A writer makes a private copy, edits the copy, then swaps one shared reference so new readers see the new version, while readers already holding the old one finish on it, complete and unchanged. Choose it over a [read-write lock](rw-lock.md) when reads far outnumber writes and readers sit on a latency-critical path, as with routing tables, feature flags and listener lists. With balanced traffic the copying costs more than the lock would.

- **Whole-copy writes** A small edit copies everything; share the unchanged parts between versions and copy only the changed path.
- **Double memory** Both versions exist during a swap, so peak memory about doubles; combine several edits into one swap.
- **Slow readers** A slow reader keeps the old version alive; limit how long a reader holds a snapshot, never across a network wait.
- **Writers take turns** Two copies made at once lose one edit, so serialise writers or retry a compare-and-swap that loses.

**Example.** A routing table holds 50,000 routes at 100 bytes each, so 5 MB. It gets 200,000 reads a second and one config push a minute. Each read never waits. A push copies 5 MB, edits the copy and swaps, and memory peaks at 10 MB. If a push of 50 changes publishes each one separately, it copies 50 x 5 MB = 250 MB. Batching the 50 into one copy costs 5 MB. At one push a second it copies 5 MB a second, 300 MB a minute; measure that against what a read-write lock would cost 200,000 reads. The cost is that a reader that captured the table before the swap routes by the old version until it finishes.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a reader avoid locking while a writer changes shared data? The writer never touches version 1 — it builds version 2 privately, and the only step other threads can observe is the reference swap in step 4."
flowchart LR
    R["Reader threads"]
    subgraph Pub["Publication — one atomic swap"]
        Ref["Current-version reference"]
    end
    V1[("Version 1 — frozen")]
    V2[("Version 2 — frozen")]
    W["Writer thread"]
    R -->|"1 read the reference, no lock"| Ref
    Ref -->|"2 iterate the version it named"| V1
    W -->|"3 clone version 1, edit the private clone"| V2
    W -->|"4 publish: point the reference at version 2"| Ref
    Ref -->|"5 the next reader follows version 2"| V2
```

```mermaid caption="What does a reader that started before the swap see? Reader A finishes on version 1 while Reader B already reads version 2 — so the old version stays alive, and stale, for the whole of A's iteration."
sequenceDiagram
    autonumber
    participant A as Reader A
    participant Ref as Shared reference
    participant W as Writer
    participant B as Reader B
    A->>Ref: read reference
    Ref-->>A: version 1
    W->>W: clone version 1, edit the clone
    W->>Ref: swap to version 2
    B->>Ref: read reference
    Ref-->>B: version 2
    Note over A: A is still iterating version 1, which nobody modified
    Note over A,W: version 1 is reclaimed only after A releases it
```

## Variations
<!--meta block=variations-->

- **Whole-value copy** — Clone the entire structure on every write. It is the simplest form and the hardest to get wrong: each write allocates the structure again, and both versions stay resident until the old one is released. Fine for a config map of a few hundred entries, too slow for a million-element index.
- **Structural sharing** — Copy only the path from the root to the node that changed, and point the rest of the new version at the old version's nodes. A write into a tree of a million nodes then costs the depth of the tree rather than its size, which is what makes copy-on-write affordable on large structures. Persistent maps and vectors are built this way, and the price is a data structure far more intricate than an array.
- **Page-level copy-on-write** — The kernel does it for you. After a `fork()`, parent and child share the same physical pages, marked read-only in both page tables; the first write from either side traps, the kernel copies that one page, and both carry on. A process that forks (starts a child process) and immediately execs (replaces its program) copies almost nothing, which is why forking a large process is cheap until one side starts writing.
- **Snapshot filesystems** — A copy-on-write filesystem never overwrites a live block: a change writes new blocks and updates the tree to point at them. Retaining a reference to the old tree is therefore a snapshot, created in constant time and costing storage only as the two trees diverge. You pay in fragmentation, and in space you cannot reclaim while any snapshot still names those blocks.
- **Copy-on-write collections** — The library form: a list or set whose mutating operations copy the backing array under a lock, and whose iterators are snapshots taken at creation. Iteration needs no synchronisation and cannot fail midway because of a concurrent change. The iterator will not show writes that landed after you obtained it, and it cannot remove through the iterator, because the array it walks is a frozen copy, not the live list.
- **Deferred reclamation** — Without a garbage collector the writer must free the old version itself, and only after every reader that could hold it has finished, a wait called a grace period. Read-copy-update in the Linux kernel works this way.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Readers take no lock** and never block on a writer. A read is one volatile or acquire load of the reference, so throughput scales with core count.
- **A reader cannot observe a half-updated structure** — the version it captured is complete and frozen for as long as it holds it.
- **Iteration needs no defensive copy**: the writer takes one copy for everyone, instead of every reader taking one for itself.
- **Publication is a single reference swap**, so rollback is keeping the previous reference and swapping it back; any writes published after that version are discarded too.
- **Old versions are snapshots you already paid for** — a consistent view for a backup, an audit, or a long-running job.

### Cons
<!--meta polarity=con-->

- **Write amplification**: changing one field pays for a copy of the whole structure. Structural sharing cuts that to the changed path, at the cost of a much more intricate data structure.
- **Peak memory roughly doubles**, because both versions are live across the swap. A burst of writes on a large structure spikes well above its steady size — batch several edits into one publication instead of publishing per change.
- **A long-running reader pins the version it captured**, delaying its reclamation and widening how stale that reader's view is. Bound reader lifetimes, and never hold a snapshot across an I/O wait.
- **It only pays when reads vastly outnumber writes**. Near-balanced traffic spends more on copying than the lock it replaced, and a purpose-built concurrent structure beats it on both sides.
- **Writers still need mutual exclusion**. Two writers that clone the same version concurrently both publish, and the second silently discards the first's change. Serialise them with a mutex, or publish with a [lock-free](./lock-free.md) compare-and-swap that retries when it loses the race.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Reads vastly outnumber writes on the same structure** — a routing table, a feature-flag set, a listener registry, a config map.
- **Readers sit on the latency-critical path** and must neither block nor contend with each other.
- **A reader needs one stable view** for the whole of a long operation — iterating, serialising, computing a total.
- **The structure is small enough**, or shares structure well enough, that a copy is cheap against the read traffic it saves.

### Avoid when
<!--meta polarity=avoid-->

- **Writes are frequent**, or reads and writes arrive at similar rates — a lock or a concurrent structure costs less. Find the crossover by measuring: write rate times structure size is the bytes copied per second; compare it with what contended reads cost under a [read-write lock](./rw-lock.md).
- **The structure is large and copied whole**, so a single write allocates more than the machine has headroom for.
- **Readers must see a change the instant** it is published; a captured version is stale by construction.
- **Readers need to change what they read** — copy-on-write hands them a frozen version, not shared state.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a lock-free-to-read routing table"
type Route = { readonly host: string; readonly weight: number };

class RouteTable {
  // The only shared cell: one reference to a frozen array nobody edits in place.
  private current: ReadonlyArray<Route> = Object.freeze([]);
  // Writers queue behind each other, so no update is discarded. A failed write rejects to its own caller; the queue carries on.
  // The queue matters only because an edit may await; with real threads use a mutex or a compare-and-swap.
  private writes: Promise<void> = Promise.resolve();

  // Readers: one read of one reference. No lock, no contention, no waiting.
  snapshot(): ReadonlyArray<Route> {
    return this.current;
  }

  add(route: Route): Promise<void> {
    const write = this.writes.then(() => {
      const next = [...this.current, route];      // 1. clone
      next.sort((a, b) => b.weight - a.weight);   // 2. edit the private clone
      this.current = Object.freeze(next);         // 3. publish: one swap
    });
    this.writes = write.catch(() => {});          // a throw must not wedge later adds
    return write;
  }
}

// Capture the reference ONCE, then read it to the end: a concurrent add()
// cannot touch `routes`. Calling table.snapshot() inside the loop would let
// two turns land on two different versions and send to one host twice.
const routes = table.snapshot();
for (const r of routes) send(r.host);
```

## In the wild
<!--meta block=wild-->

- **java.util.concurrent.CopyOnWriteArrayList** — Every mutating operation — `add`, `set`, `remove` — copies the backing array under a lock, so reads synchronise on nothing. An iterator holds the array that existed when it was created: it never throws `ConcurrentModificationException`, it never shows a later write, and its own `remove`, `set` and `add` throw `UnsupportedOperationException`. `CopyOnWriteArraySet` is backed by one. {#wild-cow-array-list}
- **Linux fork()** — The child does not receive a copy of the parent memory. It receives page tables pointing at the same physical pages, with the writable ones marked read-only on both sides; the first write from either process takes a page fault and the kernel copies that one page. Forking a large process is therefore cheap in memory, but the call itself copies the page tables, so it takes longer as mapped memory grows; a page is copied only when one side starts writing. {#wild-linux-fork}
- **ZFS and Btrfs** — Neither filesystem overwrites a live block: a change writes new blocks and rewrites the tree above them to point at the new locations. Keeping the old tree root is what makes a snapshot near-instant and initially free, and the space it holds is reclaimed only when the snapshot is destroyed. {#wild-zfs-btrfs}
- **Redis BGSAVE** — Redis forks a child process to write the point-in-time snapshot while the parent keeps serving requests. The child sees a consistent dataset because the kernel copies pages only as the parent modifies them — so a write-heavy workload during the save dirties pages faster and pushes the process memory above the size of the dataset. The fork itself copies the page tables, so the parent pauses for longer as the dataset grows, and with transparent huge pages one write copies a whole huge page instead of 4 KB, which is why Redis advises disabling them. {#wild-redis-bgsave}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Copy granularity** — Whether a write copies the whole value or only the path from the root to the node that changed. Whole-value copying is simpler and correct; structural sharing turns a cost proportional to the size of the structure into one proportional to its depth, usually the affordable choice once the structure is large: a balanced binary tree of a million nodes copies about 20 nodes, not 1,000,000.
- **Publication batching** — How many logical edits go into one published version. Publishing per field keeps readers freshest and allocates the most; coalescing a run of edits into one swap trades a little staleness for far fewer copies. Choose the window from the longest staleness readers tolerate, then watch copies per second to confirm it.
- **Writer serialisation** — A mutex around clone-and-publish, or a compare-and-swap on the reference that retries when it loses. The mutex wastes no clones and blocks writers; the CAS loop blocks nobody and redoes the copy on every lost race.
- **Snapshot lifetime** — How long a reader may hold a captured version before releasing it. It sets both the staleness ceiling for that reader and how long the old version stays unreclaimable.

### Signals to watch
<!--meta polarity=signal-->

- **Write rate against structure size** — Write rate times structure size is the bytes allocated per second. It shows whether copy-on-write still pays for itself; the example's one 5 MB push a minute is about 83 KB a second.
- **Peak resident memory during publication** — Both versions are live across the swap, so the peak is what has to fit — not the steady-state size of the structure. Alert when two live versions no longer fit in the memory budget.
- **How long readers hold a version** — Time from capturing the reference to releasing it. Rising hold times mean staler reads and old versions that cannot be reclaimed. Alert when hold time nears the interval between writes.
- **Allocation rate and collector pause time** — On a managed runtime every publication becomes garbage, and the pause is the latency that copying costs your readers.

### Failure modes under load
<!--meta polarity=failure-->

- **Memory spike on a write burst** — A run of writes allocates a full version each, and any that readers still hold cannot be reclaimed. Memory climbs far above the steady-state size and hits the ceiling before throughput does.
- **Lost update between writers** — Two writers clone the same version and both publish; the second swap discards the first change and nothing raises an error. It looks like a save that silently did not happen.
- **One slow reader pinning a version** — A consumer holding a snapshot across an I/O wait pins that one old version, so it cannot be reclaimed, and acts on state that is minutes old.
- **Write amplification overtaking the saving** — As the write rate rises, the copying costs more than the read contention it removed. Throughput falls with no code change.

### Readiness checklist
<!--meta polarity=check-->

- Measure the read-to-write ratio before adopting it; copy-on-write only pays when reads clearly dominate.
- Size memory for the peak, not the average — both versions are resident across the swap, and versions readers still hold add to it.
- Serialise writers with a mutex or a compare-and-swap loop; a clone-and-publish with no exclusion loses updates silently.
- Make readers capture the reference once per operation, and never hold a snapshot across an I/O wait.
- Use structural sharing for any structure large enough that a whole-value copy shows up in the allocation rate.
- Watch writer collisions: lost compare-and-swap races per second, or time spent waiting on the mutex.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Let readers run lock-free by publishing a new copy for each write. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Lock-Free](./lock-free.md) — Publishing the new version is one atomic reference swap
- [Iterator](../gof/behavioral/iterator.md) — An iterator holds the version that existed when it was created
- [Mutex](./mutex.md) — A mutex around clone-and-publish keeps two writers from discarding each other's copy; readers never take it

**Alternative to**

- [Read-Write Lock](./rw-lock.md) — Takes the lock off the read path entirely instead of sharing it between readers

**Specializes**

- [Immutability](../functional/immutability.md) — Narrows immutability to one strategy: copy lazily on first write, and share until then

**Prevents**

- [Race Condition](../../hazards/race-condition.md) — A reader never observes a half-updated structure — it sees one complete version or the next

<!-- relationships:end -->
