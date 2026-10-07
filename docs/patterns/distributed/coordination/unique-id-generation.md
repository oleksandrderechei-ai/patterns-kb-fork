---
title: Unique ID Generation
description: "Generate keys on any node without asking a central allocator, and still index well"
area: distributed-data
owner: Oleksandr Derechei
tags: [data-modeling, throughput]
status: stable
aliases: [snowflake id, UUIDv7, ULID, distributed id generation]
solves: [two servers generated the same primary key and one insert failed, our inserts got slower as the table grew and the primary key is a random uuid, asking the database for the next number has become a bottleneck on the write path, I need ids that can be generated while partitioned and merged later without collisions, I want to know roughly when a row was created from its id alone]
---

# Unique ID Generation

Builds an identifier out of a clock reading, a per-generator identity and a counter, so any node can generate a key that nothing else will ever produce — and, because the clock sits in the high bits, keys still arrive at the index in roughly the order they were created.

## What it is
<!--meta block=description-->

Giving every machine its own ids with no central counter is easy with random bits, but random keys scatter inserts across an index and slow writes. A time-ordered id joins a clock reading, a machine number and a counter. Ids from any machine then sort roughly by creation time, so they land at the end of the index and stay unique with no coordination.

## Explained
<!--meta block=explain-->

Unique id generation lets every machine issue its own ids without asking a central counter, by joining three parts: a clock reading in the highest bits, the machine's own number, and a counter for ids made in the same millisecond. Ids then sort roughly by creation time, so inserts land at the end of an index instead of scattering across it. A fully random key sends every insert to a different page, which forces page splits (a full index page cut in two) and wastes cache. Choose it when one database sequence (a counter the database hands out) cannot serve every writer, because of throughput, several independent writers or offline writes. Otherwise a sequence is smaller, denser and simpler.

- **Clock steps back.** A clock that moves backwards can repeat an id, so refuse to issue ids until it catches up.
- **Hot index tail.** At extreme rates the newest end of the index is hot, so put a shard or tenant prefix before the timestamp.
- **The id leaks.** It shows creation time and fleet size, so expose an opaque random id at your API boundary.

**Example.** A 64-bit layout holds 41 bits of milliseconds, 10 bits of machine number and 12 bits of counter, so 1,024 machines can each make 4,096 ids per millisecond, about 4.1 million a second per machine. The 41-bit clock lasts about 69 years from its chosen start date. Machine 7 last issued an id at millisecond 1,000, and its clock now reads 970 after a correction. It refuses to issue for 30 ms and raises an alert, rather than risk repeating an id. The 4,097th request inside one millisecond waits for the next.

## How it works
<!--meta block=structure-->

```mermaid caption="The timestamp sits highest, so ids sort by time and inserts land at the index tail. Put the node id above the timestamp instead and each node gets its own region of the index, which spreads a hot tail page but gives up time order."
flowchart LR
    subgraph G1["Generator, node id 5"]
        A1["assemble: time | 5 | seq"]
    end
    subgraph G2["Generator, node id 9"]
        A2["assemble: time | 9 | seq"]
    end
    W["Writer"]
    IDX[("Primary key index")]
    TAIL["Tail leaf page"]
    A1 -->|"1 generate locally, no round trip"| W
    A2 -->|"1 generate locally, no round trip"| W
    W -->|"2 insert"| IDX
    IDX -->|"3 time in the high bits, so both land here"| TAIL
```

```mermaid caption="The compact 64-bit layout, most significant field first. Each field is a ceiling you are choosing: 69 years of timestamps, 1,024 generators, and 4,096 ids per generator per millisecond before the generator has to wait for the next tick."
flowchart LR
    S["sign: 1 bit, always 0"] --> T["timestamp: 41 bits, ms since a chosen epoch"]
    T --> N["node id: 10 bits, 1024 generators"]
    N --> Q["sequence: 12 bits, 4096 per node per ms"]
```

## Variations
<!--meta block=variations-->

- **Fully random 128-bit identifier** — No clock, no node id, no coordination — and no ordering. The right answer when the identifier is public and should reveal nothing, and the wrong one when it is also the primary key of a large indexed table.
- **Time-ordered 128-bit identifier** — A millisecond timestamp prefix, then randomness. Standardized as version 7 in RFC 9562 (RFC = Request for Comments, an internet standard): 48 bits of Unix milliseconds, a version marker, 12 bits that may hold sub-millisecond precision, a counter or random bits, a variant marker, then 62 random bits. Many libraries provide it and nothing needs administering. The default choice for a new system.
- **Compact 64-bit time, node and sequence** — Half the width of the standard form, which shows up in every index and foreign key on a large table. The price is assigning each generator a distinct node id and keeping that assignment correct as the fleet changes.
- **Sortable text encoding** — The same time-ordered bits rendered in a case-insensitive base32 alphabet, so the string sorts the same way the bytes do. Useful when the id travels through systems that only handle text, such as object keys or log lines.
- **Range allocation from a coordinator** — A coordinator hands each node a block of numbers, and the node issues ids from it locally until the block is exhausted. Keeps ids small and dense at the cost of a dependency and one round trip per block — the middle ground between a shared sequence and pure local generation.
- **Shard-prefixed identifier** — Put a [shard](../routing/sharding.md) or tenant discriminator above the timestamp. Global ordering is given up on purpose, in exchange for spreading inserts across as many hot pages as there are shards.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Any node generates a key** with no round trip, so the write path has no central allocator to queue behind or lose.
- **A time-ordered key keeps inserts** at the index tail, so pages fill densely and the hot pages stay cached.
- **Writers can be partitioned**, offline or in different regions and still produce keys that do not collide, provided each writer holds a distinct node id.
- **The key doubles as a rough creation timestamp**, which makes range scans and retention windows cheap.

### Cons
<!--meta polarity=con-->

- **The identifier leaks what it encodes**: creation time to anyone holding one, and fleet size to anyone collecting a few.
- **Correctness depends on the clock**, so a backwards step can produce a duplicate or an out-of-order key.
- **128-bit keys double index** and foreign-key width against a 64-bit integer, on every table that references them.
- **Node-id assignment is the original coordination problem**, moved from once per id to once per process — not removed.
- **Each field is a ceiling**: the epoch choice sets an exhaustion date, and sequence exhaustion inside one tick blocks the generator until the next.
- **Ordering is only as good** as clock agreement between nodes, so two ids a few milliseconds apart say nothing reliable about which event happened first.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **More than one process inserts** rows for the same logical table, so no single sequence owns the numbering.
- **The identifier is the primary** key of a large, heavily-written indexed table, where insert locality shows up in the bill.
- **Writers must keep working while partitioned** from each other, or offline, and reconcile later.

### Avoid when
<!--meta polarity=avoid-->

- **One database writer already owns** the sequence and has the throughput — a native sequence is smaller, denser and has no clock dependency.
- **The identifier is public and must reveal nothing**: use randomness, and keep any sortable key internal.
- **You need a total order** you can reason about across nodes — this gives approximate order, not consensus.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the 64-bit layout, including the clock-went-backwards branch"
const EPOCH = 1_700_000_000_000n; // chosen once; changing it invalidates every existing id
const NODE_BITS = 10n, SEQ_BITS = 12n;
const MAX_SEQ = (1n << SEQ_BITS) - 1n;
const nowMs = () => BigInt(Date.now()) - EPOCH;

class IdGenerator {
  private lastMs = -1n;
  private seq = 0n;
  constructor(private nodeId: bigint) {
    if (nodeId >> NODE_BITS) throw new Error("node id does not fit in 10 bits");
  }

  next(): bigint {
    let ms = nowMs();
    if (ms === this.lastMs) {
      this.seq = (this.seq + 1n) & MAX_SEQ;
      // 4096 ids used inside one millisecond: the only correct move is to wait.
      if (this.seq === 0n) while ((ms = nowMs()) <= this.lastMs);
    } else if (ms < this.lastMs) {
      // The clock moved backwards. Issuing now risks repeating an id we already
      // handed out, so refuse rather than produce a duplicate silently.
      throw new Error(`clock went backwards by ${this.lastMs - ms}ms`);
    } else {
      this.seq = 0n;
    }
    this.lastMs = ms;
    // Field order IS the sort order: time highest, so ids compare by time first.
    return (ms << (NODE_BITS + SEQ_BITS)) | (this.nodeId << SEQ_BITS) | this.seq;
  }
}
```

## In the wild
<!--meta block=wild-->

- **RFC 9562** — The current universally unique identifier (UUID) specification, published May 2024 to supersede RFC 4122. It standardizes the time-ordered layout as version 7: a 48-bit Unix millisecond timestamp, then a version marker, sub-millisecond sequence bits, a variant marker and random bits. {#wild-rfc-9562}
- **Snowflake** — The 64-bit generator Twitter announced in 2010, and the name the timestamp-node-sequence layout is now known by generally: 41 bits of milliseconds, 10 bits of machine id, 12 bits of per-millisecond sequence. {#wild-snowflake}
- **ULID** — The same time-ordered idea specified as a 26-character Crockford base32 string, so the text form sorts the same way the underlying bits do. {#wild-ulid}
- **PostgreSQL B-tree indexes** — Where the cost of random keys is most often measured: scattered inserts force page splits, which shows up as inflated write-ahead log volume and buffer-cache churn rather than as slow queries. {#wild-postgres-uuid}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Field widths and epoch** — How many bits go to timestamp, node id and sequence, and which epoch the timestamp counts from. Each choice is a ceiling: generator count, ids per tick, and the date the timestamp field overflows.
- **Node-id assignment source** — Where a generator learns its own id — static config, a coordination service lease, or computed from the instance address. Determines what happens when the fleet is replaced.
- **Clock-regression policy** — Whether a backwards clock step blocks id generation, throws, or is absorbed by a monotonic counter that ignores the wall clock until it catches up.
- **Key width at rest** — 64-bit integer versus 128-bit value, which propagates into every index and foreign key that references the row.
- **Backwards-skew tolerance** — The largest backwards clock step the generator waits out before it throws and alerts. Set it from the clock offset you observe against a reference (see the clock offset signal), so a small correction waits and a large one stops.

### Signals to watch
<!--meta polarity=signal-->

- **Index page splits and write amplification** — Splits per second and bytes written to the log per row inserted. The direct measure of whether keys are arriving in order.
- **Sequence exhaustion events** — How often a generator uses its whole per-tick sequence and has to wait. Tells you the current headroom against burst write rate.
- **Clock offset against a reference** — How far each generator drifts from a trusted time source. Correctness rests on this, and nothing else reports it.
- **Duplicate-key rejection rate** — Unique-constraint violations on the primary key. Should be zero; a nonzero count points first to two generators sharing a node id, then to clock regression or retried inserts.

### Failure modes under load
<!--meta polarity=failure-->

- **Two generators share a node id** — A misconfigured or reused node id makes two machines produce identical ids in the same millisecond, and the collision surfaces as a unique-constraint violation on insert — or as silent overwrites where there is no constraint.
- **Insert throughput decays as the table grows** — The signature of random keys: fine on an empty table, progressively worse as the index outgrows the buffer cache and every insert touches a cold page.
- **Clock step stalls the write path** — A time correction moves the clock backwards and the generator refuses to issue ids until it catches up, so writes block for the length of the correction.
- **Tail page becomes the write hot spot** — Perfect time ordering concentrates every insert on one leaf page, so the locality win turns into lock contention at the top of the index.

### Readiness checklist
<!--meta polarity=check-->

- Node ids are unique by construction — leased or computed, not hand-assigned in config where a copy-paste reuses one.
- A backwards clock step stops id generation (the sketch throws, and a caller may retry or wait) and raises an alert, rather than being allowed to reissue an id.
- The key width and the epoch are recorded as decisions, since neither can be changed later without rewriting every stored id.
- Sequence exhaustion is measured, so the per-tick ceiling is known against real burst rates rather than assumed.
- Any identifier exposed publicly is opaque, so the internal sortable key does not leak creation time or fleet size.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Scaling Writes](../../../themes/scaling-writes.md) — Issue time-ordered ids on any node so inserts stay cheap to index. {#fluency-scaling-writes}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Sharding](../routing/sharding.md) — A shard prefix above the timestamp spreads inserts, at the cost of global ordering
- [Write-Ahead Log](./write-ahead-log.md) — Random keys pay for their disorder here, as page splits inflate log volume
- [Idempotency](../../messaging/idempotency.md) — A client-generated id doubles as the deduplication key for a retried write
- [LSM Tree](./lsm-tree.md) — Compaction cost depends on key order, so the same ordering that helps a B-tree helps here

**Often confused with**

- [Correlation Identifier](../../messaging/correlation-identifier.md) — This generates primary keys; a correlation id tags related messages and is not meant to be a record's key.

**Exposed to**

- [Clock Skew](../../../hazards/clock-skew.md) — A backwards or disagreeing clock can repeat or misorder an id, so the generator must refuse or wait.

<!-- relationships:end -->
