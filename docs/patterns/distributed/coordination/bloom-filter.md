---
title: Bloom Filter
description: "Probabilistic check: definitely absent, or maybe present"
area: distributed-data
owner: Oleksandr Derechei
tags: [performance, resource-management]
status: stable
aliases: [Bloom filter, probabilistic set]
solves: [most of my lookups miss and every miss still costs a disk seek, I keep hitting the database for keys that turn out not to exist at all, an exact index of every key I have would never fit in memory, I need a quick check for whether I have already seen this item without keeping all of them around, checking whether an item is in a huge remote set means a network round trip every single time]
---

# Bloom Filter

A compact bit array that answers "is this key in the set?" with a guarantee in one direction only — it never says absent when the key is present, but it can occasionally say present when it isn't.

## What it is
<!--meta block=description-->

Checking whether a key is in a set that is huge, remote or slow costs a disk seek or a network call, and most queries ask for keys that are not there. A Bloom filter is a small in-memory bit array set through several hash functions. A no is certain and skips the expensive lookup; a yes only means maybe. It gives up retrieval, and plain filters cannot forget a key.

## Explained
<!--meta block=explain-->

A Bloom filter is a small in-memory bit array that answers whether a key might be in a big set stored somewhere slow. It never says no wrongly: if the answer is no, the key is definitely absent and you skip the disk or network call. If it says yes, the key is only probably there, so you still do the real lookup. Each key sets a few bits chosen by hash functions (scrambling formulas), and a query checks the same bits. Choose it over a plain in-memory set when the set is too big to hold exactly and most queries ask for keys that were never stored.

- **Wrong yeses** Each wasted lookup finds nothing; pick the false-positive rate from what a wasted lookup costs.
- **Fixed size** Past the planned key count the wrong-yes rate climbs; size for peak with headroom and rebuild when you outgrow it.
- **No deletes** Bits are shared, so a plain filter cannot delete a key; rebuild on a schedule or use a counting or cuckoo variant.

**Example.** A store holds 10 million keys on disk, and a read costs 5 ms. Of 1,000 reads a second, 900 ask for keys that do not exist. Without a filter those 900 cost 4.5 s of disk time every second, so you need five disks just for misses. A filter with 10 bits per key takes 100 million bits, 12.5 MB, and wrongly says yes about 0.8% of the time. Now 900 misses cause about 7 wasted reads, around 35 ms of disk time. Load 20 million keys into the same filter and only 5 bits per key remain, so the wrong-yes rate climbs to about 14%: 126 wasted reads, 0.63 s of disk time. That is the sizing cost.

## How it works
<!--meta block=structure-->

```mermaid caption="How do you skip a disk seek for a key that was never stored? Steps 1–3 cost a few hash computations and can answer \"no\" with certainty, so only step 4 pays — and a false positive is a step 4 that pays for nothing."
flowchart LR
    C["Reader"]
    subgraph Gate["The cheap in-memory gate"]
        H["k hash functions"]
        BA[("m-bit array")]
    end
    Store[("The keys, on disk or across the network")]:::ext
    C -->|"1 is key u42 in the set?"| H
    H -->|"2 the k bit positions for u42"| BA
    BA -->|"3 any bit still 0: definitely absent, answer now"| C
    C -->|"4 all k bits set: worth a real look"| Store
    Store -->|"5 the value, or the miss the filter mispredicted"| C
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Counting Bloom Filter** — Replaces each bit with a small counter, so a key can be removed by decrementing instead of only ever setting bits.
- **Scalable Bloom Filter** — Chains progressively larger filters as the set grows, holding a fixed false-positive bound without knowing the final size upfront.
- **Blocked Bloom Filter** — Confines each key's bits to one cache line, trading a slightly higher false-positive rate for far fewer memory fetches per lookup.
- **Cuckoo Filter** — Stores a per-key fingerprint in a cuckoo hash table instead of shared bits — supports deletion natively and often wins at low false-positive rates.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Uses a fraction** of the memory an exact set of the same keys would need. Burton Bloom described it in 1970 for hyphenating text against a word list too large for memory, where most words break by rule and only a minority needed the expensive lookup.
- **Lookup and insert are O(k)** — constant time no matter how many keys are stored.
- **No false negatives in the plain filter**: "absent" is always correct and safe to act on. Delete-capable variants keep that only if you remove keys that were actually inserted.
- **Filters with the same size, k and hashes merge** with a bitwise OR, so you can build shards separately and combine them.

### Cons
<!--meta polarity=con-->

- **False positives are inherent**, and the rate climbs as the filter fills past its design load.
- **Cannot enumerate, retrieve, or identify which key matched** — only yes/no per query.
- **The plain filter can't delete a key**, since its bits are shared with others.
- **Must be sized** for the expected key count upfront; resizing means rebuilding from scratch.
- **A lookup touches k scattered bit positions**, so a large filter costs several cache misses; the blocked variant cuts this.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A real lookup is expensive** — a disk seek, a network hop, a cold cache fill — and most queries are for keys that aren't there.
- **The candidate set is far** larger than an exact in-memory index could afford to hold.
- **An occasional false positive is cheap to absorb** — worst case you do the real lookup and get a miss.

### Avoid when
<!--meta polarity=avoid-->

- **You need exact membership with zero false positives** — a hash set or map answers that directly.
- **Deletion is required** and you haven't chosen the counting variant.
- **The key set is small** enough that an exact structure already fits comfortably in memory.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal filter"
// fnv1a: any 32-bit string hash, assumed. 1<<20 bits holds about 100k keys at
// about 1%: size = n x bits per key, k = (size / n) x ln 2.
class BloomFilter {
  private bits: Uint8Array;

  constructor(private readonly size = 1 << 20, private readonly k = 7) {
    this.bits = new Uint8Array(Math.ceil(size / 8));
  }

  private *hashes(key: string): Generator<number> {
    const h1 = fnv1a(key), h2 = fnv1a(key + "x") | 1; // odd stride
    for (let i = 0; i < this.k; i++) yield (h1 + i * h2) % this.size;
  }

  add(key: string): void {
    for (const bit of this.hashes(key)) this.bits[bit >> 3] |= 1 << (bit & 7);
  }

  mightContain(key: string): boolean {
    for (const bit of this.hashes(key)) {
      if (!(this.bits[bit >> 3] & (1 << (bit & 7)))) return false; // definitely absent
    }
    return true; // maybe present
  }
}
```

## In the wild
<!--meta block=wild-->

- **Apache Cassandra** — Keeps a filter per SSTable so a read can skip files that definitely do not hold the partition key; the target rate is the per-table bloom_filter_fp_chance, and the filters are held off-heap so they survive without pressuring the Java virtual machine (JVM) heap {#wild-cassandra}
- **RocksDB** — Attaches a per-SSTable filter block, turning most non-existent-key reads into a memory check instead of an I/O; the filter policy is configured in bits_per_key, and partitioned filters let only the needed slice be paged in on large tables {#wild-rocksdb}
- **PostgreSQL bloom extension** — Ships a bloom index access method for tables queried on many arbitrary column combinations; the index stores a signature per row whose length and per-column bit counts are set at CREATE INDEX time, trading precision for a single compact index over an exact one per column {#wild-postgresql-bloom}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **target false-positive rate** — the primary design knob (Cassandra sets it as bloom_filter_fp_chance; RocksDB sets bits_per_key, which implies a rate). A lower rate costs more bits per key. Pick it from the cost ratio of a wasted real lookup against the memory saved, not by reflex
- **expected element count (n)** — the filter is sized for a key count you commit to upfront; load it past that n and the realized false-positive rate climbs above target, since m and k were fixed for the smaller set
- **bits per key (m/n)** — memory footprint per key, which together with the target rate fixes the array size m. About 10 bits per key gives roughly 1% and about 14 gives roughly 0.1%, from m/n = -ln(p)/(ln 2)^2. The optimal hash count k is roughly (m/n)ln2 and is usually computed, not tuned by hand
- **deletion strategy** — a plain filter cannot forget a key, so decide up front: periodically rebuild from the current source, or adopt a counting or cuckoo variant that supports removal at extra cost

### Signals to watch
<!--meta polarity=signal-->

- **realized false-positive rate** — wasted real lookups divided by all queries for absent keys, the figure the 0.8% in the explain example uses. It shows whether the deployed filter meets its target
- **fill ratio** — the fraction of bits set to 1. It rises toward saturation as inserts accumulate; at the optimal k it is about 50% at design load, so a filter well past half full has drifted above its designed false-positive rate. Alert there and rebuild at a larger n
- **filter memory footprint** — bytes resident for the array — the cost side of the trade, and what grows if you rebuild larger to hold more keys

### Failure modes under load
<!--meta polarity=failure-->

- **saturation past design load** — more keys inserted than the filter was sized for; the false-positive rate climbs until the cheap gate rejects almost nothing and every read pays the expensive path anyway
- **stale bits from removed keys** — the source deletes a key but the plain filter cannot clear its bits, so it keeps answering maybe-present for something gone — a permanent false positive until the filter is rebuilt
- **undersized build** — n guessed too low when the filter was created; it is over its target rate from day one, and the only fix is a full rebuild with a larger array

### Readiness checklist
<!--meta polarity=check-->

- Size for the real peak key count with headroom; a filter loaded past its design n silently exceeds its target rate
- Choose the target false-positive rate from the cost of a wasted lookup against the memory saved, not a default
- Decide the deletion story up front — periodic rebuild, or a counting or cuckoo variant — since a plain filter can never forget a key
- Measure the realized false-positive rate in production, not just the designed one, and alert when it drifts up

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Performance](../../../themes/performance.md) — Skip lookups that would miss {#fluency-performance}
- [Approximate Answers](../../../themes/approximate-answers.md) — Gate a slow lookup with a cheap check that never wrongly says no. {#fluency-approximate-answers}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Cache-Aside](../../caching/cache-aside.md) — Skip a lookup the filter says will miss
- [LSM Tree](./lsm-tree.md) — Log-structured merge (LSM) read paths put a Bloom filter on each SSTable to avoid scanning files that lack the key

**Often confused with**

- [Count-Min Sketch](./count-min-sketch.md) — Both are hash-based sketches, but this tests membership where a Count-Min Sketch counts frequency
- [HyperLogLog](./hyperloglog.md) — Membership of one item, not a count of distinct items
- [Merkle Tree](./merkle-tree.md) — A filter answers is-it-present approximately, where a hash tree locates differences exactly.

**Demonstrated by**

- [Web Crawler](../../../designs/web-crawler.md) — approximate set membership rules out most duplicates with tiny memory, tolerating rare false positives
- [Metrics & Monitoring](../../../designs/metrics-monitoring.md) — a probabilistic membership pre-check is what absorbs a cardinality lookup on every point at 5M/second
- [Tinder](../../../designs/tinder.md) — the never-re-show requirement tolerates false positives but not false negatives — the exact asymmetry a Bloom filter gives

<!-- relationships:end -->
