---
title: Count-Min Sketch
description: Estimate per-item frequency in sublinear memory with hashed counters
area: distributed-data
owner: Oleksandr Derechei
tags: [performance, resource-management, read-optimization]
status: stable
aliases: [CMS, count-min sketch]
solves: [I need the most frequent items in a huge stream but cannot keep a counter for each key, exact per-item counts for billions of keys won't fit in memory, "which items are trending right now, approximately, without a full count", "each worker only sees part of the stream, so no single machine knows the real totals", a full group-by just to find the most common values scans the entire dataset]
---

# Count-Min Sketch

A compact grid of counters that answers "about how many times has this key appeared?" over a stream — using memory fixed in advance, independent of how many distinct keys flow through it, at the cost of a small over-estimate it can never turn into an undercount.

## What it is
<!--meta block=description-->

A count-min sketch is a fixed grid of counters with one hash function per row. Recording a key bumps one counter per row, and estimating it reads those counters and takes the minimum, which is an upper bound while counters only grow. It counts per-item frequency over a stream whose distinct keys are too many for an exact counter each, in memory that does not grow. It stores no keys, so pair it with a structure that holds candidates.

## Explained
<!--meta block=explain-->

A count-min sketch estimates how often each item appeared in a huge stream using a small grid of counters whose size never grows. Each item is scrambled by one hash function per row (a formula that maps it to a column), and every occurrence adds one to its cell in each row. To ask for a count, you read that item's cells and take the smallest, because other items sharing a cell can only inflate it, so the answer is never too low. Choose it over an exact table of counters when the distinct items, such as every search term or URL, are too many to hold, and an over-count is harmless.

- **Noisy tail.** Busy items inflate their neighbours, so trust the head of the distribution, treat rare items as noise, or widen the grid.
- **Fixed shape.** Grids merge only when width, depth and hash seeds all match, so fix them before the first shard counts.
- **No keys.** You cannot list frequent items from it, so pair it with a small heap of candidate keys; add decay for recent counts.

**Example.** You count 10 million search queries in a grid of 4 rows by 2,000 columns, 8,000 counters, about 32 KB. Each estimate can be too high by about 0.14% of the stream, which is up to 13,600, with 98% confidence for any one query. A trending term searched 300,000 times reads at most 313,600, a 4.5% over-count; only terms within 13,600 of each other can swap order. A term searched 50 times may read as high as 13,650, so the tail is useless. Doubling the width to 4,000 halves that error to 6,800 and doubles the memory to 64 KB.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one fixed grid of counters answer \"how often?\" for a key space too large to tally? Steps 2 to 4 bump one cell per row, and the estimate at 6 to 8 takes the smallest of those cells — the one least polluted by other keys, so a collision can push a count up but never down."
flowchart LR
    Stream["Event stream"]:::ext
    Counter["Counting service"]
    subgraph Grid["One fixed grid — d rows, w columns"]
        R1[("Row 1 counters")]
        R2[("Row 2 counters")]
        R3[("Row 3 counters")]
    end
    Min["Estimate: min of the d cells"]
    Heap["Candidate keys"]:::ext
    Stream -->|"1 key arrives"| Counter
    Counter -->|"2 hash key, bump one cell"| R1
    Counter -->|"3 hash key, bump one cell"| R2
    Counter -->|"4 hash key, bump one cell"| R3
    Heap -->|"5 ask how often this key"| Min
    R1 -->|"6 read that key's cell"| Min
    R2 -->|"7 read that key's cell"| Min
    R3 -->|"8 read that key's cell"| Min
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Conservative Update** — On insert, raise only the counters that are currently at the key's minimum rather than all d of them. This shaves the over-estimate substantially on skewed streams, at the price of no longer supporting decrements or deletions.
- **Count-Mean-Min Sketch** — Estimates the collision noise in each row from the total volume, subtracts it from each counter, and takes the median instead of the minimum. This corrects much of the upward bias — useful when the long tail matters, not only the heavy hitters.
- **Count Sketch** — Adds a second ±1 hash per row and takes the median of the signed counters, giving an unbiased estimate that can err in either direction rather than a one-sided upper bound. Better when rare items and frequent ones both need estimating.
- **Decayed / [sliding-window](./sliding-window.md) sketch** — Periodically scales every counter down, or keeps per-window sketches and ages the oldest out, so recent occurrences outweigh old ones — keeping the estimate tuned to what is frequent now rather than all-time totals.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Fixed memory**, independent of the number of distinct keys — w×d counters whether you track thousands of keys or billions.
- **Insert and query are O(d)** — a handful of hashes and increments, constant no matter how long the stream or how many keys.
- **Never undercounts while every update is non-negative** and counters never wrap, saturate or age: the estimate is then an upper bound, so a key's true frequency is at or below what the sketch reports. Decay, reset, deletion and median variants lose the bound.
- **Two sketches of the same dimensions add cell-by-cell** — combine per-shard sketches into a global one, so counting parallelizes across a cluster.

### Cons
<!--meta polarity=con-->

- **Over-estimates by design**, and the bound grows with total volume; skew decides which keys absorb the error, as heavy hitters spill onto everything that collides with them.
- **Cannot enumerate or recover keys** — it stores counts against hashed cells, not the keys, so it needs a companion structure that already knows the candidates.
- **Accurate for the heavy hitters**, noisy for the long tail — a rare key's small true count is easily swamped by a frequent key sharing one of its cells.
- **Width and depth are sized** upfront for an assumed volume and error target; a stream far larger or more skewed than planned drifts past the bound.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need approximate per-item frequencies** — or the heavy hitters and top-K — over a stream with far too many distinct keys to keep an exact counter for each.
- **A small over-count is acceptable** and you care most about the frequent items: trending topics, hot keys, most-viewed content.
- **You want fixed**, predictable memory and mergeable per-shard counters, so the counting can spread across a cluster.

### Avoid when
<!--meta polarity=avoid-->

- **You need exact counts**, or downstream logic breaks on an over-estimate — reach for exact counters or a database aggregate.
- **The number of distinct keys** is small enough that a plain hash map of counters fits comfortably in memory.
- **Distinct counts, not frequencies** — the question is "how many distinct items" rather than "how often each one" — that is a cardinality estimator like HyperLogLog; "is this item present at all" is a Bloom filter.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal sketch"
class CountMinSketch {
  private readonly rows: Uint32Array[];

  constructor(private readonly width = 1 << 16, private readonly depth = 5) {
    this.rows = Array.from({ length: depth }, () => new Uint32Array(width));
  }

  // one independent hash per row — seed each with the row index
  private column(row: number, key: string): number {
    return fnv1a(key + ":" + row) % this.width;
  }

  add(key: string, count = 1): void {
    for (let r = 0; r < this.depth; r++) this.rows[r][this.column(r, key)] += count;
  }

  estimate(key: string): number {
    let min = Infinity;
    for (let r = 0; r < this.depth; r++) {
      min = Math.min(min, this.rows[r][this.column(r, key)]);
    }
    return min; // an upper bound — collisions only inflate, never deflate
  }
}
```

## In the wild
<!--meta block=wild-->

- **Redis Stack Count-Min Sketch** — A first-class sketch type: CMS.INITBYDIM or CMS.INITBYPROB to size it, CMS.INCRBY to count occurrences, CMS.QUERY to estimate, and CMS.MERGE to fold several sketches into one. {#wild-redis-stack}
- **Apache Spark** — DataFrame.stat.countMinSketch(col, eps, confidence, seed) builds a sketch over a column, giving approximate frequencies without a full group-by shuffle over the whole dataset. {#wild-apache-spark}
- **Twitter Algebird** — Provides Count-Min Sketch as a mergeable monoid for streaming aggregation; its top-N variant keeps the heaviest keys alongside the sketch — the classic sketch-plus-heap route to approximate top-K. {#wild-algebird}
- **Caffeine** — Its Window-TinyLFU eviction keeps a count-min frequency sketch — 4-bit counters, periodically halved to age out old counts — to judge which keys are hot enough to admit, an LFU-style signal. {#wild-caffeine}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Sketch width (w) — columns per row** — The accuracy dial: error is bounded by about e/w of the total counted volume, so doubling the width halves the over-estimate and doubles the memory.
- **Sketch depth (d) — rows and independent hashes** — How many independent hashes each key gets, and so how many chances to land on a lightly loaded cell. Roughly ln(1/delta) rows give failure probability delta that the error exceeds the width's bound. Depth also sets per-operation cost, since insert and query are both O(d).
- **Counter width in bits** — Bits per cell, from 4-bit nibbles up to 64-bit integers. Narrow counters shrink the sketch by up to 8x versus 32-bit counters and let you spend the savings on more width, but they saturate on hot keys, so they only work paired with a decay scheme that pulls values back down.
- **Update rule — plain vs conservative** — Plain update increments all d counters; conservative update raises only the counters currently sitting at the key's minimum, which markedly cuts the over-estimate on skewed streams. The price is that the sketch can no longer be decremented, so deletions and any subtractive aging are off the table.
- **Aging policy — reset, decay or window rotation** — The error bound is relative to everything counted since the sketch was last cleared, so an unaged sketch degrades monotonically. Choose one: zero it on a schedule, periodically halve every counter, or keep per-window sketches and drop the oldest. The interval is what defines the window over which “frequent” is meant.

### Signals to watch
<!--meta polarity=signal-->

- **Total increments since last reset** — The volume that error bound scales against. Compare it to the volume you sized for and you have the current drift from plan.
- **Measured over-estimate on a control set** — Keep exact counters for a small fixed sample of keys and periodically diff the sketch's estimate against them. The gap is the only ground-truth accuracy number you will ever have, and it is cheap for a few dozen keys.
- **Non-zero cell share per row** — The fraction of each row's counters that have ever been touched. As it approaches saturation every lookup is reading a cell shared with other keys, and estimates for anything outside the heavy hitters stop meaning much.
- **Saturated cell share** — The fraction of counters pinned at the maximum value the counter width can represent. Only relevant with narrow counters, where it is the direct measure of whether decay is keeping up with the hottest keys.
- **Row spread on queried keys** — The gap between the largest and smallest of a key's d counters, available for free on every query since all d are read anyway. A wide spread means that key is colliding with heavy traffic in some rows, and a distribution of spreads that shifts upward is the sketch telling you it is getting crowded.

### Failure modes under load
<!--meta polarity=failure-->

- **Error grows with the stream, not with the sketch** — An unaged sketch keeps getting worse the longer it runs, at constant width and depth. Rare keys drift into plausible-but-wrong non-zero counts long before anything alerts.
- **Heavy hitters swamp the tail** — Every counter is shared, and the minimum only rescues a key if at least one of its d cells stayed clean. Once traffic skews hard enough that a key collides with a heavy hitter in all d rows, its estimate is dominated by someone else's volume, so the sketch is accurate for heavy hitters you already know about and wrong for rare keys.
- **Counter saturation on hot keys** — With narrow counters, a burst pins the hottest keys at the maximum value. They all then compare equal, so any ranking or admission decision built on the sketch loses its ordering precisely during the load spike it was meant to handle.
- **Merge fails on mismatched sketches** — Cell-by-cell addition is only valid between sketches with identical width, depth, hash functions and seeds. A rolling deploy that retunes the dimensions produces per-shard sketches that either refuse to merge or, if the code adds them anyway, silently return wrong counts.
- **Discontinuity at the reset boundary** — Clearing the sketch to fight drift throws away all history at once, so every key reads as cold immediately afterwards. Anything downstream that admits, evicts or throttles on frequency flips behaviour at that instant — which is why decay-by-halving is usually preferred over a hard zero.

### Readiness checklist
<!--meta polarity=check-->

- Size width and depth from an explicit error target and the volume you expect between resets — that volume is part of the specification, not an afterthought.
- Seed each row's hash independently and use a hash with good avalanche; rows that correlate collapse the depth guarantee back to a single row's accuracy.
- Pair the sketch with a structure that holds the candidate keys — a heap, a watchlist — because it can answer about a key you name but never enumerate one.
- Keep a small control set of keys with exact counts in production and compare the estimates against it, so accuracy drift is measured rather than assumed.
- Decide the aging policy before shipping — reset, halve or window-rotate — and pick the counter width so the hottest key cannot saturate before the next decay.
- Verify that every sketch you intend to merge shares identical dimensions, hash functions and seeds, and version them so a deploy cannot change them mid-stream.
- Confirm the downstream logic is safe with an upper bound, and never let a rare key's inflated count drive a decision that breaks on an over-count.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Approximate Answers](../../../themes/approximate-answers.md) — Estimate how often each key appears in fixed memory, never under-counting. {#fluency-approximate-answers}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Sliding Window](./sliding-window.md) — Per-window sketches aged out keep the estimate tuned to what is frequent now

**Often confused with**

- [Bloom Filter](./bloom-filter.md) — Both are hash-based sketches, but this counts frequency where a Bloom filter tests membership
- [HyperLogLog](./hyperloglog.md) — Same sketch family, different question: per-item frequency here, distinct-count there

**Demonstrated by**

- [Top-K](../../../designs/top-k.md) — counting frequencies across billions of distinct keys fits in hundreds of MB instead of the hundreds of GB an exact hash table needs
- [Facebook Post Search](../../../designs/fb-post-search.md) — the design leans on a probabilistic sketch to stop the bigram key space from exploding
- [Distributed Cache](../../../designs/design-distributed-cache.md) — naming the heavy hitters in a cache's request stream in fixed memory, wrong only by over-counting

<!-- relationships:end -->
