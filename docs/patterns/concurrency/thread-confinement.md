---
title: Thread Confinement
description: Remove races by giving each thread sole ownership of its data
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, isolation, state-management]
status: stable
aliases: [shared-nothing, thread ownership]
solves: [locks everywhere are killing throughput and I still get races, I cannot tell which thread is allowed to touch this mutable object, two threads keep corrupting the same shared structure, a request's data leaks into another request because worker threads share one mutable object, the crash disappears as soon as I add logging or attach a debugger]
---

# Thread Confinement

Eliminate synchronization by partitioning state so each thread exclusively owns its slice — with nothing shared, there is no lock to take and no race to reason about.

## What it is
<!--meta block=description-->

Every race needs mutable state touched by more than one thread. Locks tame the shared access; thread confinement removes the sharing. Each piece of mutable state gets one owning thread, and requests are routed to the owner, so no lock is needed and no data race on that state is possible. You pay by having to split the state cleanly by owner, and work that spans owners becomes hard.

## Explained
<!--meta block=explain-->

Thread confinement gives each piece of data one owning thread. Only that thread reads or changes it, so no lock is needed, and any other thread that wants something done sends the owner a request. Because nothing is shared, races on that data cannot happen. Choose it over locks when the state splits cleanly by key, such as by account id or by user, and each key is touched by one thread at a time.

- **Cross-owner work** An operation spanning two owners cannot take two locks; send messages or use a coordinator, and plan how it stays consistent.
- **Hot keys** A hot key pins one thread at full while others idle; split the key more finely or rebalance owners.
- **Enforcement** One thread reaching into another data brings every race back; route all access through the owner queue and check thread identity in debug builds.
- **Moved complexity** The hard part moves from locks to partitioning and routing.

**Example.** Four worker threads own accounts by id mod 4. The service gets 1,000 requests a second at 2 ms each, and one account takes 400 of them. The hot account's thread gets 400 plus its share of the other 600, 150, so 550 requests, which is 1,100 ms of work every second. It is overloaded, while the other three threads each do 150 requests, 300 ms of work, and sit 70 percent idle. No other thread may help, because the data belongs to one thread. A transfer from account 4 to account 5 crosses two owners, so it becomes two messages and needs a plan if the second fails.

## How it works
<!--meta block=structure-->

```mermaid caption="Where did the lock go? Step 2 sends every request for a key to the one thread that owns it, so step 3 touches state no other thread can reach — there is nothing left for a second thread to race against."
flowchart LR
    C["Clients"]:::ext
    R["Router"]
    subgraph Own["Each key has exactly one owning thread"]
        T1["Thread 1"]
        S1[("State A–M")]
        T2["Thread 2"]
        S2[("State N–Z")]
    end
    C -->|"1 request for a key"| R
    R -->|"2 hash the key, pick its owner"| T1
    T1 -->|"3 read and write, no lock"| S1
    T1 -->|"4 reply"| C
    R -->|"5 a key in N–Z goes to the other owner"| T2
    T2 -->|"6 its own state, never thread 1's"| S2
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Stack confinement** — The simplest form, and free: state that lives only in a method's local variables and never escapes is reachable by exactly one thread — the caller. No mechanism at all, just discipline about not publishing a reference. It stops being confined the moment the object leaks out.
- **Thread-local storage** — Each thread gets its own private instance of a variable — a non-thread-safe formatter, a scratch buffer, a per-thread database connection. The runtime keys the storage by thread, so there is no shared instance to guard. Finest grain; watch for leaks on pooled threads that outlive the value's usefulness.
- **Single-threaded [event loop](./reactor.md)** — All state changes run on one thread, so everything it touches is confined. Concurrency comes from non-blocking I/O multiplexed around the loop, not from more threads on the data; Redis's command execution and Node's event loop work this way. Across an await or callback the loop can run other handlers, so keep each invariant inside one synchronous step.
- **Sharded / thread-per-core ownership** — Split the dataset into N partitions, each pinned to one thread or core, and route each request to its shard's owner. This scales confinement across many cores while keeping every shard's hot path lock-free — the shape of thread-per-core storage engines.
- **[Actor model](./actor-model.md) (message passing)** — The shared-nothing idea realized as isolated actors that own their state and communicate only by messages. Cross-partition work becomes an explicit message rather than a shared memory access, which is exactly how confinement handles operations that span owners.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Data races on confined state are impossible**, not merely guarded: with nothing shared there is no interleaving to get wrong, provided every access goes through the owner. One escaped reference restores the race (see the enforcement con).
- **No locks on the hot path** — no contention, no lock-ordering deadlocks, no CPU parked spinning or context-switching on a mutex.
- **Each owner is a plain single-threaded program** you can reason about sequentially — far simpler than auditing every possible interleaving.
- **Scales across cores by adding partitions** — a thread-per-shard design turns more cores into more throughput without more lock contention, while keys spread evenly. A hot key caps throughput at one thread (see the load-skew con).

### Cons
<!--meta polarity=con-->

- **Needs a clean partition of state by owner** — if the data does not divide naturally, confinement does not apply.
- **Cross-partition work is expensive** — an operation spanning two owners cannot just take two locks; it needs message passing or a coordinator, and its own consistency story.
- **Load can skew** — a [hot partition](../../hazards/hot-partition.md) pins one thread at full while its peers idle, and the busy owner becomes the bottleneck because no other thread may help with its data.
- **Only as good as its enforcement** — one thread reaching into another's slice silently brings back every race you removed, and nothing stops it by default.
- **Trades synchronization complexity for architectural complexity** — the hard part moves from locks to partitioning and routing rather than disappearing.
- **Message-level races remain** — the owner runs one message at a time, not a read-then-write sequence spanning two, so keep each invariant inside one message.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **State partitions cleanly by owner** — a keyspace, a shard key, a per-connection or per-session scope — and most operations stay inside one partition.
- **Lock contention is the measured bottleneck** — threads queue on shared locks instead of doing work — and you would rather remove the sharing than keep tuning the locking.
- **You want correctness you can reason about sequentially**, one owner per thread, instead of auditing every interleaving — often in a thread-per-core or sharded engine whose hot path must stay lock-free.

### Avoid when
<!--meta polarity=avoid-->

- **Operations routinely span partitions** — the cross-owner message passing or coordination costs more than the locking it replaces.
- **The state will not divide cleanly by owner** — a forced partition just relocates the races into the seams between shards.
- **A plain lock or monitor already suffices** — for human-triggered, low-contention work, confinement is architectural overkill.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a sharded store where each key routes to one owning shard through its inbox"
// Each shard is owned by exactly one worker thread. Callers never touch its Map; they post a task to the shard's inbox and the owner runs it.
class Shard {
  private readonly data = new Map<string, string>();  // private to the owner thread
  private readonly inbox: Array<(data: Map<string, string>) => void> = [];
  post(task: (data: Map<string, string>) => void): void { this.inbox.push(task); }  // any thread may post
  // Called only by the owning thread: the single consumer of the inbox.
  runNext(): void { const task = this.inbox.shift(); if (task) task(this.data); }
}

class ShardedStore {
  private readonly shards: Shard[];

  constructor(private readonly n: number) {
    this.shards = Array.from({ length: n }, () => new Shard());
  }

  // A key always routes to the same shard — and thus the same owning thread.
  private ownerOf(key: string): Shard {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return this.shards[Math.abs(h) % this.n];
  }

  get(key: string): Promise<string | undefined> { return new Promise(resolve => this.ownerOf(key).post(d => resolve(d.get(key)))); }
  set(key: string, value: string): void { this.ownerOf(key).post(d => { d.set(key, value); }); }
}

```

## In the wild
<!--meta block=wild-->

- **Dragonfly** — A Redis-compatible in-memory store that partitions the keyspace across threads so each key is owned by exactly one thread. Most operations dispatch to their owning shard and run without locks on the hot path — a shared-nothing, thread-per-core design rather than one global lock. {#wild-dragonfly}
- **Single-threaded command execution** — A store that runs every command on one thread confines all of its state to that thread: because only one thread ever mutates the data, there are no locks and no data races by construction. Concurrency comes from non-blocking I/O around the loop, not from multiple threads on the data — the classic single-threaded event-loop store design. {#wild-single-threaded-store}
- **Java ThreadLocal** — Gives each thread its own private instance of a value keyed by thread — the standard fix for sharing a non-thread-safe object like SimpleDateFormat, or holding a per-thread connection or scratch buffer, without any synchronization. Values on pooled threads must be cleared to avoid leaking across reused threads. {#wild-java-threadlocal}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Confinement scheme** — Stack-local data, `ThreadLocal`, one owner thread or event loop, or an executor per key. Each fixes ownership differently and caps throughput differently.
- **Number of owner threads or shards** — The more shards, the more parallelism and the more state split across owners. Keys must map to a shard consistently.
- **Hand-off queue bound** — Bounded or unbounded queue into the owner thread. Unbounded hides overload as memory growth; bounded forces a rejection policy.
- **Cleanup of per-thread values** — Whether every `ThreadLocal` is cleared with `remove()` when the work ends. Pooled threads outlive the request.

### Signals to watch
<!--meta polarity=signal-->

- **Owner thread queue depth and wait time** — Time a task waits before the owner runs it. Growth means the single thread is the ceiling.
- **Owner thread busy ratio** — Share of time the thread is running rather than idle. Near 100 percent means no headroom.
- **Thread-affinity assertion failures** — Counts of code touching confined data from a thread that does not own it, if you assert ownership in code.

### Failure modes under load
<!--meta polarity=failure-->

- **One hot owner saturates** — All work for a key set runs on one thread, so the queue grows and latency climbs while other cores sit idle.
- **Reference escapes the owner** — A confined object is handed to another thread by a callback or shared field. You see a rare, unreproducible race.
- **Stale `ThreadLocal` in a pool** — A value from one request is still there when the thread serves the next. You see one user's data in another's request, or memory that never frees.
- **Blocking call on the owner** — A slow call blocks every task the thread owns, so unrelated requests stall together.

### Readiness checklist
<!--meta polarity=check-->

- Confined data is never passed out as a live mutable reference; hand off a copy or transfer ownership
- Every `ThreadLocal` is cleared in a `finally` block
- Blocking calls are banned from owner threads or moved to another pool
- A load test measures the throughput ceiling of one owner
- Ownership is asserted at entry points so a violation fails loudly in tests

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Give each piece of mutable state a single owning thread. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Reactor](./reactor.md) — A single-threaded command loop is confinement with non-blocking I/O around it

**Alternative to**

- [Monitor Object](./monitor-object.md) — Don't guard shared state with a lock — remove the sharing so no lock is needed
- [Immutability](../functional/immutability.md) — Keeps mutable state safe by letting only one thread touch it
- [Mutex](./mutex.md) — Gives each value to one thread, so no lock is needed
- [Active Object](./active-object.md) — Both confine state to one thread; Active Object adds a method-call proxy, a queue and futures, while confinement only requires one owner
- [Lock-Free](./lock-free.md) — Share one word without a lock instead of giving it one owner

**Generalizes**

- [Actor Model](./actor-model.md) — The actor model is one realization: message-passing confinement

**Prevents**

- [Race Condition](../../hazards/race-condition.md) — No sharing means no interleaving — the race cannot exist
- [Deadlock](../../hazards/deadlock.md) — No shared locks, so no lock-order cycle; owners that wait on each other's queues can still deadlock

<!-- relationships:end -->
