---
title: HyperLogLog
description: Estimate the number of distinct items in a stream in ~kilobytes
area: distributed-data
owner: Oleksandr Derechei
tags: [performance, resource-management]
status: stable
aliases: [HLL]
solves: [I need unique-visitor counts over billions of events without storing every id, counting distinct values exactly uses far too much memory, an approximate count of unique items is fine if it fits in a few kilobytes, recomputing the distinct count means rescanning every event from the beginning, adding up my daily unique counts double-counts anyone who came back]
---

# HyperLogLog

A fixed bank of small registers that estimates how many distinct items a stream has contained — reading the rarest hash pattern each register has seen as evidence of scale, and averaging across registers so a few kilobytes can count into the billions within a fraction of a percent.

## What it is
<!--meta block=description-->

HyperLogLog estimates how many distinct items a stream has held, using a small fixed bank of registers instead of a set that grows with every id. About 12 KB counts billions of items with under 1% error. It answers only how many, not which ones, and sketches from separate shards or days merge without loss.

## Explained
<!--meta block=explain-->

HyperLogLog estimates how many different items have passed through a stream, using a fixed bank of about 12 KB however many arrive. It hashes each item to a random-looking number and notes how many leading zeros the hash has. A long run of zeros is rare, so the longest run seen hints at how many different items it took to produce it. Many small registers, each keeping its own longest run, average out the noise. Choose it over an exact set of ids when the stream is too big to keep every id and a small error is fine.

- **Never exact.** Keep it away from billing. Below a few thousand items an exact set is smaller.
- **Counts only.** It cannot say which items it counted or whether one was present.
- **Poor overlaps.** Merging by register maximum is lossless for totals, but overlap of two sets compounds two errors. Count totals only.

**Example.** You count unique daily visitors, about 1 billion ids. An exact set of 8-byte ids needs about 8 GB. A sketch with 16,384 registers and a 64-bit hash takes 12 KB. Its standard error is 0.81%, 8.1 million on 1 billion: about two runs in three land within 8 million of the truth, nearly all within 16 million. You keep one sketch per day and merge 30 by taking the larger value in each register, giving monthly uniques from 360 KB. You cannot count visitors who came on both Monday and Tuesday without compounding two errors of that size.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a fixed 12 KB answer \"how many different items have passed through\"? Steps 2 and 3 keep only the rarest hash pattern per register, so memory never grows with the stream, and steps 5 and 6 turn those maxima back into a count whose error you chose in advance."
flowchart LR
    Stream["Event stream"]:::ext
    Svc["Counting service"]
    subgraph Sketch["One sketch — fixed ~12 KB"]
        Regs[("m registers, one byte each")]
    end
    Est["Estimator"]
    Client["Dashboard"]:::ext
    Stream -->|"1 item arrives"| Svc
    Svc -->|"2 hash it, top bits pick a register"| Regs
    Svc -->|"3 keep the longer zero run"| Regs
    Client -->|"4 how many distinct?"| Est
    Est -->|"5 read all m registers"| Regs
    Est -->|"6 harmonic mean, bias-corrected"| Client
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Each item is hashed once; its leading bits choose a register and the run of leading zeros in the rest records the rarest pattern that register has seen. A harmonic mean across all registers turns \"rare patterns imply scale\" into a cardinality estimate."
flowchart LR
    K["Item"] -->|"hash once"| H["64-bit hash"]
    H -->|"first p bits"| B["Pick a register"]
    H -->|"remaining bits"| Z["Count leading zeros"]
    Z -->|"rank = zeros + 1"| R["Register = max(old, rank)"]
    B -->|"index"| R
    R -->|"across all registers"| M["Harmonic mean"]
    M -->|"bias-corrected"| E["Estimated distinct count"]
```

## Variations
<!--meta block=variations-->

- **HyperLogLog++** — Google's refinement: 64-bit hashes to avoid collisions at extreme scale, an empirically fitted bias correction that sharpens estimates at small cardinalities, and a sparse mode for small sets. More accurate across the range and smaller when the set is small.
- **Sparse vs dense representation** — While the set is small, store only the registers actually touched as (index, value) pairs instead of the full flat array, switching to the dense array once enough registers fill. Keeps a near-empty sketch tiny rather than paying the full footprint from the first item.
- **LogLog and SuperLogLog** — The predecessors that averaged register values with the arithmetic (or a truncated) mean. HyperLogLog's switch to the harmonic mean is what cut the variance and gave the family its accuracy at the same memory.
- **Streaming rollup vs one-pass scan** — Because registers merge by element-wise maximum, sketches union losslessly. Maintain one incrementally per shard or per time window and combine them into a grand-total unique count — or compute one in a single scan over stored data — without ever re-reading raw events.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Tiny, fixed memory** — roughly 12KB of registers estimates cardinalities into the billions, versus gigabytes for an exact set of the same keys.
- **Predictable error** — the standard error is about 1.04/√m, so more registers tighten the typical error by a formula you can compute in advance; single runs can exceed it.
- **Sketches merge losslessly by element-wise maximum** — union per-shard or per-day sketches into a grand total without double-counting or re-reading events.
- **Insert is O(1): one hash**, then a single max against one register.

### Cons
<!--meta polarity=con-->

- **Estimates only cardinality** — it cannot tell you whether a specific item is present, how often it appeared, or list what it counted.
- **Always approximate**: a small percentage error is inherent, so it is wrong for exact billing, dedup, or anything that must reconcile to the unit.
- **Overkill for small sets** — its fixed footprint and correction terms are not justified below a few thousand distinct items, where a plain hash set is smaller and exact. Sparse encoding and linear counting narrow the gap, but a plain hash set is still exact and simpler at that size.
- **Intersections are hard** — union is exact via max, but estimating the overlap of two sets by inclusion-exclusion compounds the error badly.
- **No removal or windowing** — a sketch cannot forget an item, so a sliding-window distinct count needs one sketch per window, and the estimate assumes a well-mixed hash.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need the count of distinct items** — unique visitors, distinct IPs, distinct search terms — over a volume too large to keep every id.
- **A fraction of a percent** of error is acceptable and the win is fitting the whole running count in kilobytes.
- **You want to union counts** across shards or time windows cheaply — daily sketches that roll up into a monthly unique total.

### Avoid when
<!--meta polarity=avoid-->

- **You need an exact distinct count**, or the number feeds billing or dedup that must reconcile exactly.
- **The expected cardinality is small** — a plain hash set is smaller, exact, and simpler below a few thousand items.
- **You need per-item frequency** ("how many times") or membership ("is this one present") — that is a [Count-Min Sketch](./count-min-sketch.md) or a [Bloom filter](./bloom-filter.md), not a cardinality estimator.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal estimator"
class HyperLogLog {
  // Uint8Array spends 16 KB at p = 14; packing 6-bit registers gives the 12 KB figure
  private readonly registers: Uint8Array;

  // p bucket bits → m = 2^p registers; p = 14 gives ~0.81% standard error
  constructor(private readonly p = 14) {
    this.registers = new Uint8Array(1 << p);
  }

  add(key: string): void {
    // hash32: any well-mixed 32-bit hash; every writer must use the same function and seed
    const h = hash32(key);
    const bucket = h >>> (32 - this.p);               // top p bits pick the register
    const rest = (h << this.p) | (1 << (this.p - 1)); // remaining bits, with a tail guard
    const rank = Math.clz32(rest) + 1;                // position of the leftmost 1-bit
    if (rank > this.registers[bucket]) this.registers[bucket] = rank;
  }

  count(): number {
    const m = this.registers.length;
    let sum = 0;
    let zeros = 0;
    for (const r of this.registers) {
      sum += 2 ** -r;                                 // harmonic-mean denominator
      if (r === 0) zeros++;
    }
    const alpha = 0.7213 / (1 + 1.079 / m);           // bias constant
    const raw = (alpha * m * m) / sum;
    if (raw <= 2.5 * m && zeros > 0) return m * Math.log(m / zeros); // small range: linear counting
    return raw;                                       // 32-bit hash, no large-range correction: not for billions
  }

  // union: element-wise maximum; both sketches need the same p and hash
  merge(other: HyperLogLog): void {
    if (other.p !== this.p) throw new Error("precision mismatch");
    for (let i = 0; i < this.registers.length; i++) {
      if (other.registers[i] > this.registers[i]) this.registers[i] = other.registers[i];
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **Redis HyperLogLog** — PFADD adds items, PFCOUNT estimates the distinct count, and PFMERGE unions sketches; the dense encoding is about 12KB and holds a standard error near 0.81% up into the billions. {#wild-redis}
- **PostgreSQL postgresql-hll** — Adds an hll column type with hll_add and hll_union_agg aggregates, so distinct counts can be pre-aggregated per group and unioned across rows entirely in SQL. {#wild-postgresql-hll}
- **Google BigQuery** — APPROX_COUNT_DISTINCT, and the HLL_COUNT.INIT / MERGE / EXTRACT functions, estimate distinct values with HyperLogLog++ and let intermediate sketches be merged across queries. {#wild-bigquery}
- **Presto / Trino** — approx_distinct() computes cardinality with HyperLogLog, taking an optional target standard error, and exposes an HLL type so partial sketches can be merged. {#wild-presto-trino}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Precision p / register count** — m = 2^p registers set the accuracy — the standard error is about 1.04/√m, so p = 14 (16384 registers) lands near 0.81% in roughly 12KB. The one dial that trades bytes for error, and it is fixed for the life of a sketch.
- **Hash width** — 32-bit versus 64-bit hashes. A 32-bit hash starts colliding as distinct counts climb into the billions, which is why HyperLogLog++ moved to 64 bits; choose the width from the largest cardinality the system will ever count.
- **Sparse-to-dense threshold** — How large the sparse (index, value) encoding may grow before the sketch switches to the full flat register array — Redis exposes this as hll-sparse-max-bytes. Higher keeps near-empty sketches tiny; lower pays the full fixed footprint sooner but keeps updates cheap.
- **Rollup granularity — the sketch key** — Which dimensions and time buckets each get their own sketch (per shard, per hour, per campaign). Fine granularity buys flexible unions later, but multiplies the fixed per-sketch footprint by the whole key cross-product.

### Signals to watch
<!--meta polarity=signal-->

- **Measured relative error** — the estimate against an exact distinct count on a bounded window or a sample. Readings should fall within about two standard errors (2 × 1.04/√m); persistent bias is the alarm.
- **Total sketch storage** — Live sketch count × bytes per sketch. Each sketch is capped, so this number grows through the count, not the size — it is the real memory story
- **Per-sketch size distribution** — Bytes per stored sketch shows how many are still in the sparse encoding versus paying the full dense register array, which is what predicts the next step up in storage
- **Rollup latency versus sketches unioned** — Time to answer a rolled-up count, plotted against how many sketches the union touches; it rises with that count, so a widening query is the cause before the data is
- **Estimated cardinality against the hash ceiling** — The estimate itself, watched against the usable range of the hash width in use — approaching it means collisions are starting to bias the count downward

### Failure modes under load
<!--meta polarity=failure-->

- **Sketch-count explosion** — The footprint of one sketch is fixed; the number of sketches is not. A high-cardinality rollup key — per user, per URL, per fine time bucket — multiplies ~12KB by millions and turns a kilobyte-sized structure into hundreds of gigabytes
- **Slow rollup over many sketches** — A month-from-days or global-from-shards answer unions every constituent sketch at read time, so latency grows with the number merged. The sketches stay small, but there are thousands of them and the union runs on every query
- **Bulk sparse-to-dense transition** — A traffic spike pushes a whole population of near-empty sketches past the sparse threshold at once, and memory steps up to the full register array for all of them together rather than gradually
- **Collisions near the hash ceiling** — With a 32-bit hash, once true cardinality reaches into the billions distinct items begin sharing hashes and the estimate flattens below the truth. It surfaces as a plausible number that has quietly stopped growing, not as an error
- **Compounded error on intersections and subtraction** — Union is lossless by element-wise maximum (the merged sketch equals the sketch of the union, error unchanged), but overlap computed by inclusion-exclusion subtracts two approximations. When the two sets are similar in size the errors dominate the difference, and the answer can come out nonsensical — including negative

### Readiness checklist
<!--meta polarity=check-->

- Pick the precision from a written error budget (1.04/√m) and fix it before any sketch is persisted — sketches built with a different precision or a different hash function cannot be merged.
- Budget storage as sketch count × bytes across the full cross-product of the rollup key, not as the size of one sketch.
- Choose the hash width from the largest cardinality the system will ever count, not from today's traffic.
- Keep an exact path for anything that must reconcile to the unit — billing, dedup, invoices — and never let an approximate count feed it.
- Validate the deployed estimate against an exact count on a bounded window before anyone is allowed to trust the dashboard.
- Decide the merge story up front: same precision, same hash, and a serialization every reader as well as the writer understands.
- Answer overlap questions with a sketch per segment or a structure built for similarity — never by subtracting two estimates.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Approximate Answers](../../../themes/approximate-answers.md) — Estimate how many distinct items a stream held in kilobytes. {#fluency-approximate-answers}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [MapReduce](./mapreduce.md) — Per-split sketches merge in the reduce stage by element-wise maximum
- [CRDT](./crdt.md) — Per-register maximum is an order-free, repeat-safe merge, so replicas can union sketches without coordination.

**Often confused with**

- [Count-Min Sketch](./count-min-sketch.md) — Same sketch family, different question: distinct-count here, per-item frequency there
- [Bloom Filter](./bloom-filter.md) — Same sketch family: how many distinct here, is it present there

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Managed warehouses and Redis-compatible stores ship this as a built-in function or command.

<!-- relationships:end -->
