---
title: LSM Tree
description: Turn random writes into sequential ones via an in-memory table flushed to sorted files
area: distributed-data
owner: Oleksandr Derechei
tags: [persistence, throughput, durability]
status: stable
aliases: [LSM tree, log-structured merge-tree]
solves: [my write throughput is capped by random-write disk seeks, I need to ingest tens of thousands of writes a second and can accept slightly slower reads, a B-tree index is too slow for my write-heavy workload, my event ingest falls behind at peak and the disk is the bottleneck, "I store far more sensor readings than anyone reads back, and writing them is the expensive part"]
---

# LSM Tree

A write-optimized storage engine: buffer writes in a sorted in-memory table, log each one for durability, then flush the table to immutable sorted files that a background process merges — trading a little read work for very high write throughput.

## What it is
<!--meta block=description-->

Updating a B-tree in place means seeking to scattered pages, which makes a write-heavy workload slow. A log-structured merge-tree (LSM tree) never updates in place. It logs each write, holds it in a sorted memory table, and flushes that to disk as one sorted file. Reads may check several files and background merging pays the bill, but writes run near disk speed.

## Explained
<!--meta block=explain-->

An LSM tree is a storage engine that turns many small random writes into a few big sequential ones. Each write is logged for safety, then put in a sorted in-memory table. When that table fills, it is written to disk in one pass as a sorted, never-changed file, and deletes are stored as markers that hide the old value. Choose it over a B-tree, which updates pages in place and finds any key in a few page reads, when writes far outnumber reads and slower, more variable reads are acceptable. Cassandra, RocksDB and LevelDB use it.

- **Reads check many files.** A key may sit in several files. Keep a \[Bloom filter\](bloom-filter.md) and an index per file to skip most.
- **Compaction rewrites data.** Background merging rewrites bytes several times and needs free disk. Leave headroom, and watch file count so reads do not slow.
- **Resurrected deletes.** Markers dropped before reaching every copy bring deleted data back. Keep them longer than your repair interval.

**Example.** A store takes 50,000 writes a second of 200 bytes, which is 10 MB a second. A 64 MB memtable fills every 6.4 s and is flushed as one sequential file. Merging 4 files into 256 MB, then 4 of those into 1 GB, writes each byte 3 times, which is 30 MB a second. The log adds 10 MB a second, so the disk takes about 40 MB a second, not 10. The final merge writes 1 GB of output while its 1 GB of inputs stay until it finishes, so keep at least 1 GB free beyond the live data. If compaction slows, a read may check ten files instead of three.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a store absorb a flood of scattered writes without scattered disk seeks? Steps 1 to 3 only ever append — log, memtable, then one sequential flush — and reads pay for that at 6 to 8, checking memory first and letting the Bloom filter rule out nearly every file."
flowchart LR
    App["Client write"]
    Rd["Client read"]
    MT["Memtable — sorted, in memory"]
    BF["Bloom filter + block index"]
    Comp["Compaction"]
    subgraph Disk["On disk — written sequentially, never in place"]
        WAL[("Write-ahead log")]
        SS[("SSTables — immutable, sorted")]
    end
    App -->|"1 append record"| WAL
    App -->|"2 insert into sorted map"| MT
    MT -->|"3 flush when full, one sequential pass"| SS
    SS -->|"4 background merge-sort"| Comp
    Comp -->|"5 write fewer, larger files"| SS
    Rd -->|"6 check newest data first"| MT
    Rd -->|"7 which files might hold this key?"| BF
    BF -->|"8 read the one or two candidates"| SS
```

## Variations
<!--meta block=variations-->

- **Size-tiered vs. leveled compaction** — Size-tiered compaction merges SSTables of similar size into one larger table — cheap writes, but a key can sit in many overlapping tables, so reads and space suffer. Leveled compaction keeps non-overlapping tables within each level, so a key is in at most one table per level — steadier read latency and lower space amplification, at the cost of more write amplification. The right choice follows the read/write mix.
- **[Bloom filter](./bloom-filter.md) and sparse block index** — Each SSTable carries a Bloom filter over its keys and a sparse index of block offsets. A point read consults the filter first and skips any file that definitely lacks the key, with no disk I/O. False positives still cost a read, and range scans get no help from the filter.
- **Tombstones for deletes** — A delete does not remove data; it writes a tombstone that shadows older values. The bytes are reclaimed only when compaction reconciles the tombstone with the values it covers, and the marker must survive long enough to reach every replica before it can be dropped — otherwise a deleted key can resurface.
- **Key/value separation** — For large values, some engines store the value in a separate log and keep only a pointer in the LSM tree, so compaction rewrites small keys instead of big payloads — cutting write amplification at the cost of an extra lookup on read. RocksDB's BlobDB and the WiscKey design work this way.
- **Time-window or FIFO compaction** — For time-series and TTL data, group files by time window or by age and drop whole expired files, so expiry needs no rewrite and no tombstone scan.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Turns random writes into large sequential ones** — sustained write throughput far above an in-place B-tree.
- **Writes do not wait on reads**: they land in the memtable while compaction reorganizes older data in the background, though writes stall if compaction falls behind (see the compaction-stall con below).
- **Immutable SSTables are simple to cache**, replicate, and back up — there is no in-place mutation to coordinate.
- **Sorted, batched**, write-once files compress well, so on-disk footprint per record is often smaller than a B-tree's.

### Cons
<!--meta polarity=con-->

- **Read amplification** — a key may sit in the memtable and several SSTables, so a read can touch many files; Bloom filters and indexes mitigate but do not eliminate it.
- **Write and space amplification** — compaction rewrites the same data multiple times and needs free disk headroom to run.
- **Compaction is a background tax** on I/O and CPU; if it falls behind, reads degrade and writes stall.
- **Tombstones and overwritten values linger** until compaction reclaims them, temporarily inflating space and slowing reads.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Writes vastly outnumber reads** — ingest-heavy workloads such as metrics, logs, events, or time series.
- **You need sustained high write** throughput that an in-place B-tree cannot match.
- **Reads are mostly point lookups**, or range scans that you accept will merge every overlapping file, and higher, more variable read latency is acceptable.

### Avoid when
<!--meta polarity=avoid-->

- **The workload is read-heavy or read-latency-critical**, where a B-tree's single-lookup reads win.
- **Writes are modest** and a B-tree already keeps up — the compaction machinery is then pure overhead.
- **You cannot spare the disk** headroom or background I/O and CPU that compaction demands.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — memtable, flush to an immutable SSTable, read newest-first"
// null value = tombstone: the key is deleted, but the marker lingers
// until compaction reclaims it.
type Table = Map<string, string | null>;

class LsmTree {
  private memtable: Table = new Map();
  private sstables: Table[] = []; // immutable, newest first
  private readonly flushAt = 1000;
  set(key: string, value: string) { this.write(key, value); }
  delete(key: string) { this.write(key, null); } // writes a tombstone

  private write(key: string, value: string | null) {
    // A real engine appends to a write-ahead log here first, for durability.
    this.memtable.set(key, value);
    if (this.memtable.size >= this.flushAt) this.flush();
  }
  // Memtable full: freeze it as a sorted, immutable file and start fresh.
  private flush() {
    const sorted = [...this.memtable].sort(([a], [b]) => (a < b ? -1 : 1));
    this.sstables.unshift(new Map(sorted)); // never mutated again
    this.memtable = new Map();
  }
  // Newest wins: memtable, then SSTables newest-to-oldest. A real read
  // consults a per-SSTable Bloom filter to skip most files.
  get(key: string): string | null {
    const hit = [this.memtable, ...this.sstables].find((t) => t.has(key));
    return hit?.get(key) ?? null; // a tombstone (null) reads as absent
  }
}
```

## In the wild
<!--meta block=wild-->

- **Apache Cassandra** — Writes append to a commit log (its write-ahead log) and a sorted in-memory memtable; when the memtable fills it flushes to an immutable SSTable, and background compaction merges SSTables and purges tombstoned rows. Reads check the memtable, then use a per-SSTable Bloom filter to narrow which files to scan. Compaction strategy is pluggable — SizeTieredCompactionStrategy or LeveledCompactionStrategy. {#wild-cassandra}
- **RocksDB / LevelDB** — Embedded key-value LSM engines — LevelDB from Google, RocksDB forked and extended from it at Facebook. Writes go to a WAL and a memtable, flush to sorted SST files, and compact in levels; RocksDB exposes leveled and universal (size-tiered) compaction and per-SSTable Bloom filters, and serves as the storage engine underneath many other databases. {#wild-rocksdb-leveldb}
- **Apache HBase** — Keeps recent writes in an in-memory MemStore backed by a write-ahead log, flushes them to immutable HFiles, and runs minor and major compactions to merge files and drop deleted cells — an LSM design layered on top of Hadoop Distributed File System (HDFS). {#wild-hbase}
- **ScyllaDB** — A Cassandra-compatible database in C++ that writes to a commit log and memtables, flushes to immutable SSTables and compacts them in the background, with per-SSTable Bloom filters for reads. {#wild-scylladb}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Memtable size / flush threshold** — How large the memtable grows before it flushes to an SSTable. Bigger memtables mean fewer, larger sequential flushes and, when keys are overwritten before the flush, less write amplification, but more memory and more write-ahead log to replay after a crash. Start near 64 MB, as in the explain example, then raise it while crash recovery stays inside your recovery-time target.
- **Compaction strategy** — Size-tiered vs. leveled (Cassandra), or leveled vs. universal (RocksDB). The lever that trades write amplification against read and space amplification — pick it for the workload's read/write mix.
- **Bloom filter bits per key** — More bits per key lower the false-positive rate (around 10 bits/key gives roughly a 1% rate) and cut wasted SSTable reads, at the cost of memory held per table.
- **SSTable data block size** — The unit read from disk and covered by the sparse index. Larger blocks compress better and shrink the index, but read more bytes per point lookup.

### Signals to watch
<!--meta polarity=signal-->

- **Read amplification** — SSTables consulted per read; a rising count means compaction is behind or Bloom filters are undersized
- **Compaction backlog** — Pending compaction work: RocksDB pending-compaction bytes, Cassandra pending compactions; sustained growth precedes read degradation and write stalls. Alert when the backlog stays above a multiple of its healthy baseline, before the engine's own stall trigger fires.
- **Write stalls / throttling** — Time writes are slowed or paused because flush or compaction cannot keep up
- **Space amplification** — On-disk bytes versus live data bytes; spikes during compaction and with tombstone or overwrite buildup
- **p99 read latency** — Tail read latency, which climbs as SSTable count and compaction backlog grow

### Failure modes under load
<!--meta polarity=failure-->

- **Compaction cannot keep up** — Write bursts outpace compaction, SSTable count climbs, reads touch more files, and the engine eventually throttles or stalls writes to let it catch up
- **Space blowup during compaction** — A merge holds its input files until its output is written, so it needs free space equal to the output; on a full volume, writes halt.
- **Tombstone buildup** — Many deletes or time to live (TTL) expiries leave tombstones that reads must scan past until compaction reclaims them, and range scans over a tombstone-heavy region slow sharply
- **Large un-flushed memtable** — A big memtable means more write-ahead log to replay, lengthening crash recovery

### Readiness checklist
<!--meta polarity=check-->

- Choose the compaction strategy for the actual read/write mix — write-heavy favours size-tiered/universal, read-heavy favours leveled
- Size Bloom filters (bits per key) for the point-read rate you need
- Monitor compaction backlog and write stalls, and alert before they saturate
- Plan disk headroom for compaction — keep enough free space for the largest merge to write its output
- Test crash recovery time given the memtable and write-ahead-log sizing

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Scaling Writes](../../../themes/scaling-writes.md) — Trade read cost for sequential write throughput {#fluency-scaling-writes}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Bloom Filter](./bloom-filter.md) — A per-SSTable Bloom filter skips files that can't hold the key, taming read amplification
- [Unique ID Generation](./unique-id-generation.md) — Insertion key order drives how much work compaction has to do
- [Inverted Index](./inverted-index.md) — The same segment-and-merge idea underlies the term-to-document lists of a search index

**Composed of**

- [Write-Ahead Log](./write-ahead-log.md) — Every write is appended to a write-ahead log (WAL) before the memtable, so a crash loses nothing

**Demonstrated by**

- [Metrics & Monitoring](../../../designs/metrics-monitoring.md) — a relentless append-only metric workload is exactly what an log-structured merge (LSM) engine is built to absorb
- [Tinder](../../../designs/tinder.md) — the durable swipe store leans on the commit-log/memtable/SSTable write amplification log-structured merge (LSM) trees are built for

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Keyspaces, managed Cassandra and Bigtable are log-structured merge (LSM) stores: you size the cluster and the engine owns memtables and compaction.

<!-- relationships:end -->
