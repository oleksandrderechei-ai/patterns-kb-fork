---
title: Write-Ahead Log
description: Records the intent durably before applying the change
area: distributed-data
owner: Oleksandr Derechei
tags: [persistence, durability]
status: stable
aliases: [WAL, redo log, journal]
solves: [the process was killed halfway through a write and now the data file is corrupt, we lost the last few minutes of writes when the machine lost power, flushing every changed page to disk on each commit makes writes crawl, after a crash I have no reliable way to tell which changes actually made it to disk, I need followers to catch up continuously but copying full snapshots is far too heavy]
---

# Write-Ahead Log

Appends every change to a durable, sequential log before it ever touches the real data structure — so a crash can always replay its way back to exactly the state it promised.

## What it is
<!--meta block=description-->

Updating a data structure in place means scattered disk writes, and a crash mid-write can leave a corrupt page. A write-ahead log appends each change to a durable file before applying it, as one cheap sequential write. After a crash, the system replays the log to rebuild any change it had not yet applied. Most relational databases get their durability this way.

## Explained
<!--meta block=explain-->

A write-ahead log is a file you only append to, where each change is written and flushed to disk before you apply it to the real data structure. Once the record is safely on disk, you can apply the change lazily, or lose it from memory, because the log can rebuild it. A crash during an in-place page write can leave a half-written page that corrupts the structure for good. Appending a record is one sequential write that lands whole or not at all. Choose it when a crash must not lose or corrupt committed data and the main structure is too costly to update in place.

- **Flush on every commit.** Batch many commits per flush, or accept that acknowledging early loses recent writes in a power cut.
- **Torn log writes.** The log itself must survive a partial write, so use checksums and length prefixes.
- **Unbounded growth.** An untrimmed log slows recovery and eats disk, so checkpoint and truncate on a schedule.

**Example.** A database commits 10,000 transactions a second, each logging 100 bytes, so the log grows 1 MB a second. A flush takes 1 ms, so flushing each commit alone caps you near 1,000 commits a second. Flushing 50 commits together lifts that to 50,000. With a checkpoint every 5 minutes, a crash replays at most 300 MB, which at 100 MB/s takes 3 s. With no checkpoint for a day the log is 86.4 GB and replay takes about 14 minutes. The cost of waiting for the flush is the added millisecond on every commit.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a crash never lose a write the client was told succeeded? Step 2 makes the record durable before step 3 promises anything and before step 4 touches a page, so the log always knows at least as much as the data does."
flowchart LR
    Client["Client"]:::ext
    Engine["Database engine"]
    subgraph Durable["Durable before it is applied"]
        WAL[("Write-ahead log")]
    end
    Store[("Data pages / memtable")]
    Ckpt["Checkpointer"]
    Client -->|"1 write balance = 100"| Engine
    Engine -->|"2 append record, fsync"| WAL
    Engine -->|"3 ack the write"| Client
    Engine -->|"4 apply the change"| Store
    Ckpt -->|"5 flush applied state"| Store
    Ckpt -->|"6 truncate the replayed prefix"| WAL
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The ack is owed to the fsync, not to the page write. After a crash the pages sit behind the log, so recovery replays from the last checkpoint until they catch up — which is why the checkpoint interval sets the restart time."
sequenceDiagram
    autonumber
    participant C as Client
    participant E as Engine
    participant W as Write-ahead log
    participant S as Data pages
    C->>E: write
    E->>W: append record, fsync
    W-->>E: durable
    E-->>C: ack
    alt normal running
        E->>S: apply lazily, batched
    else crash before the apply
        Note over E,S: pages are behind the log
        E->>W: read forward from the last checkpoint
        W-->>E: committed records
        E->>S: reapply until the pages catch up
    end
```

## Variations
<!--meta block=variations-->

- **Physical vs. logical logging** — Physical records capture the exact bytes changed on a page, redone by copying; logical records capture the operation performed. Physical is simple and deterministic to replay; logical is more compact but replay must be idempotent.
- **Redo-only vs. redo/undo** — A redo-only log lets recovery replay forward to the last durable state. A redo/undo log also records the before-image, so an in-flight transaction can be rolled back as cleanly as a committed one is replayed.
- **Checkpointing** — Periodically flush the state the log implies into the data structure itself, then truncate everything before that point — bounding how far recovery ever has to replay.
- **[Group commit](../../concurrency/batching.md)** — Batch several concurrent appends into one fsync instead of one per writer, trading a little added latency per write for far higher durable throughput.
- **[Log shipping](./replication.md)** — Ship the WAL itself to follower nodes and have them replay it, rather than transferring snapshots — continuous replication built directly on the durability log.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Turns random**, in-place writes into a single sequential append — close to a disk or SSD's best case.
- **Durability is bounded to one fsync per commit**, not one per touched page.
- **Recovery is deterministic**: replay the log and the data structure converges to a known state.
- **The log doubles as a natural feed** for replication, auditing, and point-in-time recovery.

### Cons
<!--meta polarity=con-->

- **The log itself must be crash-safe** — a torn write there defeats the whole scheme, so entries need checksums and length prefixes.
- **Unbounded logs slow recovery and burn disk**; checkpointing and truncation are mandatory, not optional.
- **A durable commit waits on an fsync**, and batching only amortises it. The one way under that floor is to acknowledge before the log is flushed, which buys latency with a window of recent commits that a power cut erases.
- **Doubles the conceptual write path**, log now, apply later, adding a second place logic can drift out of sync.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need durability across a crash**, but writing directly to the primary structure would be slow or unsafe.
- **Recovery as deterministic replay** — you want it rather than bespoke per-structure recovery code.
- **The log itself is useful downstream** — for replication, replay, or audit — not just for recovery.

### Avoid when
<!--meta polarity=avoid-->

- **The data is disposable** or fully rebuildable from another durable source, so write-time durability isn't worth the overhead.
- **Writes are already inherently atomic and durable** — a single fsync'd file write needs no second log on top.
- **Sub-microsecond latency matters more than survivability** and losing recent writes is acceptable.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — append, fsync, replay"
interface LogEntry { seq: number; key: string; value: string; }

class WriteAheadLog {
  private seq = 0;
  private readonly fd: number;
  constructor(private readonly path: string) { this.fd = fs.openSync(path, "a"); }

  // Durable before the caller is told the write succeeded.
  append(key: string, value: string): number {
    const entry: LogEntry = { seq: ++this.seq, key, value };
    fs.writeSync(this.fd, JSON.stringify(entry) + "\n");
    fs.fsyncSync(this.fd);
    return entry.seq;
  }

  *replay(): Generator<LogEntry> {
    const text = fs.readFileSync(this.path, "utf8");
    for (const line of text.split("\n")) {
      if (line) yield JSON.parse(line) as LogEntry;
    }
  }
}

const wal = new WriteAheadLog("./wal.log");
wal.append("balance:42", "100");
store.set("balance:42", "100"); // safe: the log is already durable

// On restart, the store is rebuilt purely from the log.
for (const entry of wal.replay()) store.set(entry.key, entry.value);
```

## In the wild
<!--meta block=wild-->

- **PostgreSQL WAL** — Every change is written to the WAL and fsynced before the heap page is touched; the same log (default 16 MB segments) drives streaming replication and point-in-time recovery. synchronous_commit tunes the durability/latency tradeoff, and checkpoint_timeout with max_wal_size governs how far recovery ever replays. {#wild-postgresql-wal}
- **SQLite WAL mode** — journal_mode=WAL sends changes to a separate -wal file with a shared-memory index (-shm), so readers keep reading a consistent snapshot of the main database while a writer appends. A checkpoint (auto-triggered around 1000 pages by default, or PRAGMA wal_checkpoint) folds the log back into the db file. {#wild-sqlite-wal}
- **MySQL InnoDB redo log** — Commits land in the redo log first; dirty buffer-pool pages are flushed lazily and replayed from the log after a crash. innodb_flush_log_at_trx_commit picks whether every commit fsyncs (1, fully durable) or batches flushes for throughput (0 or 2). {#wild-innodb-redo-log}
- **RocksDB** — Writes hit the WAL before the in-memory memtable, so an unflushed memtable is rebuildable after a restart. Once a memtable is flushed to an SST file its WAL segment can be discarded, and WriteOptions.sync chooses per-write whether the append is fsynced. {#wild-rocksdb}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Commit durability / fsync policy** — Whether each commit fsyncs the log before acking (durable) or defers the flush for throughput (e.g. PostgreSQL synchronous_commit, InnoDB innodb_flush_log_at_trx_commit). Relaxing it trades a window of possibly-lost recent commits for lower commit latency.
- **Group commit delay** — How long a committer waits to batch its fsync with others (e.g. PostgreSQL commit_delay). A small delay lets many writers share one fsync, lifting durable throughput at the cost of a bit of latency per commit.
- **Checkpoint interval** — How often the state the log implies is flushed into the data structure so the log before it can be truncated (checkpoint_timeout, max_wal_size). Longer intervals cut steady write amplification but lengthen crash recovery.
- **WAL retention / segment sizing** — How much log is kept before recycling, for replication and point-in-time recovery (wal_keep_size, log segment size). Too little breaks a lagging replica; too much risks filling the disk.

### Signals to watch
<!--meta polarity=signal-->

- **Un-checkpointed WAL size** — Bytes of log accumulated since the last checkpoint — the amount recovery would have to replay, and a direct read on how long a restart takes.
- **Commit latency p99** — Tail latency of the fsync on the commit path — the durability floor that no batching fully removes, and the first thing to rise when the log device is stressed.
- **Checkpoint duration and frequency** — How long a checkpoint takes and how often it runs. Frequent or slow checkpoints signal the WAL is filling faster than the data structure absorbs it.
- **Replication lag (log shipping)** — How many bytes or seconds a follower trails the primary's log position. Growing lag means followers replay slower than the primary appends.

### Failure modes under load
<!--meta polarity=failure-->

- **WAL fills the disk** — Log is generated faster than checkpointing recycles it or archiving drains it; the volume fills and the database halts writes rather than lose durability. Free space on the log device is the thing to watch.
- **Checkpoint I/O storm** — A checkpoint flushes a large backlog of dirty pages at once, spiking disk I/O and stalling foreground commits — the classic sawtooth when checkpoints are too infrequent.
- **fsync latency spike** — The log device slows and, because every commit waits on its fsync, commit latency across the whole system rises together — the durability floor moving up under load.
- **Slow recovery after crash** — A large un-checkpointed log means a long replay before the system accepts traffic again; recovery time is bounded by the checkpoint interval, not by how the crash happened.

### Readiness checklist
<!--meta polarity=check-->

- Log entries are checksummed and length-prefixed so a torn write is detected, not replayed as truth
- Checkpointing and truncation are configured — an unbounded log is mandatory to prevent, not optional
- The log lives on storage whose fsync is honored, not a write-back cache that lies about durability
- Recovery time is bounded by the checkpoint interval and has been tested with a real crash-and-replay
- WAL disk free space and replication lag are monitored with alerts before the volume fills

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [CAP Theorem](../../../themes/cap-theorem.md) — Durable ordering behind replicated state {#fluency-cap-theorem}
- [Consistency & Replication](../../../themes/consistency-and-replication.md) — Order and ship changes durably {#fluency-consistency-and-replication}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Quorum & Consensus](./quorum-consensus.md) — Replicate the log, commit on a quorum
- [Unique ID Generation](./unique-id-generation.md) — Where the cost of out-of-order key insertion actually lands

**Enables**

- [Replication](./replication.md) — Ship the log to bring replicas up to date
- [Change Data Capture](./change-data-capture.md) — The log the engine already writes for durability doubles as the feed for downstream consumers

**Part of**

- [LSM Tree](./lsm-tree.md) — The commit log an log-structured merge (LSM) engine writes before its memtable is a write-ahead log

**Often confused with**

- [Event Sourcing](../../architecture/event-sourcing.md) — Durability journal vs. domain source of truth

**Demonstrated by**

- [Online Chess](../../../designs/online-chess.md) — persist-before-broadcast is the write-ahead invariant — the log is the truth and the in-memory board is only its fast projection
- [Payment System](../../../designs/payment-system.md) — The log the database already writes becomes the durable feed for audit, reconciliation and webhooks

**Implemented by**

- [Relational databases](../../../comparisons/relational-databases.md) — PostgreSQL's write-ahead log (WAL), InnoDB's redo log and SQLite's WAL mode are three shapes of one mechanism, and each exposes its own durability-versus-latency knob.

<!-- relationships:end -->
