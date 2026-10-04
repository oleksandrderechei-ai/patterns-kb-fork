---
title: MapReduce
description: "Split a dataset, map over the pieces in parallel, then reduce the results into an answer"
area: distributed-data
owner: Oleksandr Derechei
tags: [partitioning, throughput]
status: stable
aliases: [map-reduce]
solves: [counting something across billions of records takes hours on one machine, the dataset is far too big to fit or process on a single node, I need to run the same computation over a huge corpus and merge the answers, aggregating logs from thousands of files one after another never finishes, a batch job that runs for hours dies halfway through and I have to start over]
---

# MapReduce

MapReduce processes data too big for one machine by running a map function in parallel over input splits, shuffling the outputs together by key, and folding each key's values into a result with a reduce function — while the framework handles distribution, parallelism, and re-running failed tasks.

## What it is
<!--meta block=description-->

One machine cannot hold or crunch a dataset of billions of records in reasonable time. MapReduce spreads the work: a map function runs in parallel over pieces of the data, the framework groups the results by key, and a reduce function folds each group into an answer. You write two functions and the framework reruns tasks whose machine died. It is batch, minutes to hours.

## Explained
<!--meta block=explain-->

MapReduce splits a big dataset across many machines, runs your function on each piece in parallel, groups the results by key, and runs a second function on each group to produce the answer. You write only the two functions. The framework spreads the data, moves it, and reruns any task whose machine died. Choose it over a single machine when the computation itself, not only the data, takes hours on one core and nobody is waiting on the answer. The same shape fits summarising long documents chunk by chunk and generating embeddings at scale.

- **Costly shuffle.** Grouping by key moves data over the network and spills to disk. Run a combiner to sum partial results first.
- **Skewed keys.** One very common key sends most values to one reducer, which sets the pace. Split such keys.
- **Repeated passes.** Iterative algorithms rerun the whole dataset each pass. Use an in-memory engine for those.

**Example.** You count words in 1 TB of logs. One machine reading 100 MB/s needs 10,000 s, about 2.8 hours. On 100 machines the read takes about 100 s. The shuffle sends pairs to 20 reducers. If one key, the word the, is 40% of the pairs and the pairs total 200 GB, its reducer receives 80 GB while an even split would give each 10 GB, so the job runs about 8 times longer than it should. A combiner sums each machine's the count first, so that key sends one pair per machine instead of millions, and the skew vanishes.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a count over billions of records finish in an hour? Each split is counted in parallel, then the shuffle brings every value for a key to one reducer, which folds it into the answer."
flowchart LR
    IN[("Input dataset")]
    M1["Map task 1"]
    M2["Map task 2"]
    subgraph Bar["Shuffle barrier — every value for a key arrives before its reducer runs"]
        SH{{"Group by key"}}
    end
    R1["Reduce task A"]
    R2["Reduce task B"]
    OUT[("Output")]
    IN -->|"1 hand each split to a map task"| M1
    IN -->|"1 hand each split to a map task"| M2
    M1 -->|"2 emit key/value pairs"| SH
    M2 -->|"2 emit key/value pairs"| SH
    SH -->|"3 route each key to one reducer"| R1
    SH -->|"3 route each key to one reducer"| R2
    R1 -->|"4 fold the key's values, write"| OUT
    R2 -->|"4 fold the key's values, write"| OUT
```

## Variations
<!--meta block=variations-->

- **Classic batch vs. in-memory DAG** — The original model (Hadoop) writes each stage to disk. In-memory DAG (directed acyclic graph) engines like Spark generalize map/shuffle/reduce into a graph of transformations kept in memory — far faster for multi-pass and iterative work, at the cost of holding data in RAM.
- **Combiner** — A map-side pre-aggregation that partially reduces each map task's output before it is shuffled. When the reduce is associative (a sum, a count), a combiner shrinks the volume moved across the network dramatically.
- **Map-only jobs** — Embarrassingly-parallel transforms — filtering, format conversion, enrichment — that need no grouping. Drop the reduce stage entirely and each map task writes its output directly.
- **Multi-stage pipelines** — Real work rarely fits one map/reduce pass. Chain several jobs, or express the whole computation as a DAG, so the output of one stage feeds the next without a manual hand-off.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Scales horizontally to enormous datasets** — add machines and the work spreads onto them.
- **Parallelism and fault tolerance are automatic**; a task that fails just gets re-run elsewhere.
- **A simple mental model** — write two functions and let the framework handle the hard parts.
- **Moving computation to the data** keeps most reads local and cuts network traffic.

### Cons
<!--meta polarity=con-->

- **High latency** — it is a batch model, not interactive; jobs run in minutes to hours.
- **The shuffle is expensive**: grouping by key moves data across the network and spills to disk.
- **Awkward for iterative algorithms** — each pass re-reads and re-writes the whole dataset.
- **Skewed keys bottleneck one reducer** — a skewed key sends most values to one reducer, making it the bottleneck for the whole job.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A batch computation runs over a very large**, partitionable dataset.
- **You need aggregations**, counts, or joins at a scale one machine cannot handle.
- **The work is a one-** or few-pass transform where end-to-end latency does not matter.

### Avoid when
<!--meta polarity=avoid-->

- **You need low-latency or interactive** query response.
- **The algorithm is heavily iterative** — reach for an in-memory DAG engine instead.
- **The data fits comfortably on a single machine** — the overhead is not worth it.
- **You need strong per-record transactions**, not bulk fold-over-everything.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — single-process word count, showing the shape"
type Pair<K, V> = [K, V];

// MAP: turn each input into zero or more key/value pairs.
const map = (doc: string): Pair<string, number>[] =>
  (doc.toLowerCase().match(/[a-z]+/g) ?? []).map((w) => [w, 1]);

// REDUCE: fold all values for one key into a single result.
const reduce = (word: string, counts: number[]): Pair<string, number> =>
  [word, counts.reduce((a, b) => a + b, 0)];

function mapReduce(docs: string[]): Map<string, number> {
  // map over every input (a real system runs this in parallel across nodes)
  const mapped = docs.flatMap(map);

  // shuffle: group every value by its key
  const grouped = new Map<string, number[]>();
  for (const [word, count] of mapped) {
    (grouped.get(word) ?? grouped.set(word, []).get(word)!).push(count);
  }

  // reduce each group
  const out = new Map<string, number>();
  for (const [word, counts] of grouped) {
    const [k, v] = reduce(word, counts);
    out.set(k, v);
  }
  return out;
}

mapReduce(["the cat sat", "the dog sat"]); // { the: 2, sat: 2, cat: 1, dog: 1 }
```

## In the wild
<!--meta block=wild-->

- **Google MapReduce** — The 2004 system and paper that popularized the model, used internally to build the search index across thousands of machines. {#wild-google-mapreduce}
- **Apache Hadoop MapReduce** — The open-source implementation: map and reduce tasks over Hadoop Distributed File System (HDFS), with automatic re-execution of failed tasks. {#wild-hadoop}
- **Apache Spark** — Generalizes MapReduce into an in-memory DAG of transformations — much faster for multi-pass and iterative jobs while keeping the map/shuffle/reduce model. {#wild-spark}
- **LangChain map-reduce summarization** — Summarizes a document longer than the context window by summarizing each chunk in parallel (map) and combining those summaries (reduce). {#wild-langchain-mapreduce}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **number of partitions / splits** — how finely the input is divided across map tasks
- **number of reducers** — parallelism of the reduce stage
- **combiner** — map-side pre-aggregation, on or off, to cut shuffle volume

### Signals to watch
<!--meta polarity=signal-->

- **task skew** — slowest reducer vs the median — a hot key shows up here
- **shuffle bytes** — data moved between map and reduce; the usual bottleneck
- **failed / retried task count** — how much work is being re-run
- **job wall-clock** — end-to-end time, dragged by stragglers

### Failure modes under load
<!--meta polarity=failure-->

- **data skew** — one hot key sends most values to a single reducer that then dominates the job
- **shuffle saturation** — the all-to-all data movement overwhelms network or disk
- **stragglers** — a few slow tasks hold up the whole job
- **out-of-memory on a hot key** — a reducer can't hold all values for one key

### Readiness checklist
<!--meta polarity=check-->

- partition to balance keys and avoid skew
- use a combiner to shrink the shuffle where the reduce is associative
- size the reducer count to the data volume
- keep tasks idempotent — the framework re-runs them

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Gen AI at Scale](../../../themes/genai-scale.md) — Process a corpus no machine can hold {#fluency-genai-scale}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Sharding](../routing/sharding.md) — Map runs where the data lives — one task per shard
- [Fan-In](../../messaging/fan-in.md) — The reduce stage is a keyed fan-in: many map outputs converge per key
- [HyperLogLog](./hyperloglog.md) — Reduce can merge sketches instead of exact sets, in kilobytes
- [Big Data](../../architecture/big-data.md) — Map-reduce is the engine the batch half of a big data architecture usually runs on.
- [Barrier](../../concurrency/barrier.md) — The shuffle between the map and reduce phases is a barrier across the cluster
- [Fork-Join](../../concurrency/fork-join.md) — Applies the same split-and-merge idea across the machines of a cluster

**Often confused with**

- [Scatter-Gather](../../messaging/scatter-gather.md) — Both split then combine, but map-reduce is data-parallel batch, not request/reply
- [Big Compute](../../architecture/big-compute.md) — Both split work across many machines; this one splits a dataset and moves work to the data, big compute splits one computation over cores.

**Demonstrated by**

- [Ad Click Aggregator](../../../designs/ad-click-aggregator.md) — distributed map/reduce over the full event log recomputes exact totals as the batch source of truth

**Implemented by**

- [Data & Analytics](../../../capabilities/data-analytics.md) — Available as a managed service rather than a cluster you run.

<!-- relationships:end -->
