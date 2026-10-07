---
title: Fan-In
description: Many parallel sources converge into one stream or one result
area: messaging
owner: Oleksandr Derechei
tags: [messaging, asynchrony]
status: stable
aliases: [fanin]
solves: [ten services each emit events and I need them merged into one ordered stream, I fired off a dozen parallel calls and have to wait for all of them to come back, results from many workers need to be collected into a single response, logs from hundreds of instances have to funnel into one pipeline, one of my parallel calls never returns and the code waiting on all of them hangs forever]
---

# Fan-In

Fan-in is the inverse of fan-out: multiple producers, branches, or parallel tasks feed a single consumer, channel, or aggregation point — which either merges the streams or waits for and combines the results.

## What it is
<!--meta block=description-->

**Fan-in** routes many parallel outputs into one convergence point: several producers, the branches of a split job, or a pool of workers. That point either merges them into one stream, as log records from many hosts join one pipeline, or waits for them and combines them. It is the gather half of [scatter-gather](./scatter-gather.md) without the scatter, and an [aggregator](./aggregator.md) is one mechanism for the combining half.

## Explained
<!--meta block=explain-->

Fan-in is the point where many parallel outputs converge into one: results from the shards of a split job, events from many services, or log lines from hundreds of hosts. That point either waits for the results and combines them, or merges them into one stream as they arrive. You get this shape whenever you run work in parallel, so decide what the point does when a source is slow or missing. Choose waiting for k of n results (a quorum) over waiting for all when a late source costs you more than a missing one.

- **Slowest source.** Waiting for all lets the slowest set the delay, so set a deadline and decide what a missing answer means.
- **Bottleneck.** All traffic crosses the point, so keep its work light or split it by key.
- **Unbounded buffer.** Fast sources grow the buffer, so bound it and slow senders (backpressure) or drop the excess on purpose.

**Example.** A search query goes to 10 shards. Each answers in 40 ms, except that 1 call in 100 takes 2 s. Waiting for all, the chance that at least one of 10 is slow is 1 - 0.99^10, about 9.6%, so roughly 1 query in 10 takes 2 s. With a 100 ms deadline and the answers collected so far, every query finishes within 100 ms. Most of the roughly 10% that lose a shard return results from 9 of 10 shards, marked partial, and the cost is that those results can miss a matching document.

## How it works
<!--meta block=structure-->

```mermaid caption="Who decides the parallel work is finished? Only the policy at step 2. Worker 3 may never send anything, so an await-all policy loops at 3a indefinitely while the buffer fills — which is why the buffer is bounded and the policy carries a deadline."
flowchart LR
    S1["Shard worker 1"]:::ext
    S2["Shard worker 2"]:::ext
    S3["Shard worker 3"]:::ext
    subgraph Conv["The convergence point: bounded buffer, one waiting policy"]
        Buf[("Bounded buffer")]
        Pol{"All in, quorum, or deadline?"}
    end
    Sink["Merge or join"]
    Down["Downstream"]:::ext
    S1 -->|"1 partial result"| Buf
    S2 -->|"1 partial result"| Buf
    S3 -->|"1 may never arrive"| Buf
    Buf -->|"2 test the policy"| Pol
    Pol -->|"3a not yet, keep buffering"| Buf
    Pol -->|"3b release"| Sink
    Sink -->|"4 one stream, or one answer"| Down
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Merge vs. join** — A **merge** interleaves the sources into one unordered stream that flows on as records arrive and never says "done". A **join** waits for every source and releases one combined value. Streaming pipelines merge; a parallel-then-collect computation joins.
- **Await-all vs. first-wins vs. quorum** — **Await-all** blocks until every source returns, so the slowest sets the pace. **First-wins** races them and takes the earliest reply, discarding the rest; it is a hedged request more than a gather, sharing the collector but not the join. **Quorum** settles for the first k of n and treats the stragglers as absent, trading completeness for a bounded tail, but only while k sources answer; without a deadline a quorum can hang like await-all.
- **Static vs. dynamic sources** — The set of sources is a fixed, known N — a partitioned job whose shard count you chose — or it is **dynamic**, with producers joining and leaving at runtime, as instances scale in and out behind a log pipeline. Dynamic fan-in cannot count on a known total, so "wait for all" stops being well defined.
- **Buffered fan-in** — The collector puts a queue in front of itself to absorb uneven producer rates, so a burst from one fast source does not overrun the sink and a lull elsewhere does not starve it. The buffer smooths the convergence, at the cost of memory and some latency — and it must be bounded, or an out-of-sync producer grows it without limit.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Gives parallel work one place to collect** or merge, instead of every downstream reinventing the collection.
- **Enables the parallel-then-join shape**: fan work out, run it concurrently, converge on the results.
- **A natural home for aggregation, deduplication, and ordering** — the reconciliation lives in one component. A merge of independent sources arrives unordered, so ordering is added deliberately, and deduplication needs a stable id from each source.

### Cons
<!--meta polarity=con-->

- **The collector is a bottleneck** and a hot spot — all the parallel output funnels through one point.
- **Slowest source sets latency** — when it waits for all, the slowest single source sets the latency of the whole convergence.
- **Producers that outrun the sink** need [backpressure](../concurrency/backpressure.md), or the collector's buffer grows without bound.
- **Partial failure must be handled explicitly** — a source that never returns hangs an await-all forever.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You fanned work out across shards** or workers and now must collect the results back into one place.
- **Many services or instances each emit output** that has to funnel into one pipeline or stream.
- **You must wait for, or merge, the outputs** of N parallel operations before proceeding.

### Avoid when
<!--meta polarity=avoid-->

- **A single producer already suffices** — there is nothing parallel to converge.
- **The sources are genuinely independent** and never need merging or a joint result.
- **One collector would be an unacceptable point** of contention — partition the convergence instead.
- **You need correlation or completion rules** for related messages, so use an [aggregator](./aggregator.md), or a keyed reduce over a whole dataset, so use [MapReduce](../distributed/coordination/mapreduce.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — join N parallel tasks at one convergence point"
type Task<T> = () => Promise<T>;

// Join flavour: fan work out, then converge on all of it.
// Promise.all IS the fan-in — N parallel tasks, one collected result.
async function fanInJoin<T>(tasks: Task<T>[]): Promise<T[]> {
  // dispatch every source in parallel...
  const running = tasks.map((run) => run());
  // ...then wait for all of them at the single convergence point.
  // Fail-fast: the first rejection rejects the join while the rest keep running;
  // Promise.allSettled would wait for every source instead.
  // The slowest task sets the latency; one that never resolves hangs the join.
  return Promise.all(running);
}

// Quorum flavour: settle for the first k of n, treating stragglers as absent.
// The deadline and the failure count are what stop a missing source hanging it.
async function fanInQuorum<T>(
  tasks: Task<T>[], k: number, deadlineMs: number,
): Promise<{ values: T[]; partial: boolean }> {
  const collected: T[] = [];
  let failed = 0;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return; // a late result is ignored
      settled = true;
      clearTimeout(timer);
      resolve({ values: collected, partial: collected.length < tasks.length });
    };
    const timer = setTimeout(finish, deadlineMs); // give up on the stragglers
    for (const run of tasks) {
      run().then((value) => {
        if (settled) return;
        collected.push(value);
        if (collected.length >= k) finish(); // enough have converged
      }).catch(() => {
        if (++failed > tasks.length - k) finish(); // k can no longer be reached
      });
    }
  });
}

// The other flavour is a streaming *merge*: rather than await a set,
// interleave many async iterables into one continuous output stream —
// no "done", just an unordered union that flows on as records arrive.
```

## In the wild
<!--meta block=wild-->

- **JavaScript Promise.all** — Fires N async operations in parallel and resolves once all complete, collecting results in order — the fan-in join inside one process. {#wild-promise-all}
- **Kafka topic as a convergence point** — Many producers write to one topic, funnelling disparate event sources into a single log (ordered per partition) for downstream consumers. {#wild-kafka-fanin}
- **Fluent Bit / Fluentd aggregation** — Log agents on many hosts forward records into one aggregator or store — a fan-in of many producers to a single pipeline. {#wild-fluentbit}
- **Parallel agent / tool-call gathering** — An orchestrator dispatches sub-tasks to several agents or tool calls in parallel and gathers their outputs into one answer — the gather half of scatter/gather over large language model (LLM) calls. {#wild-agent-fanin}
- **Model-response ensembling** — Sampling several generations or querying several models in parallel and combining them (voting, best-of-n, self-consistency) is a fan-in over independent generations. {#wild-ensemble}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **wait strategy** — wait for all, a quorum of k-of-n, or first-wins
- **per-source timeout** — how long to wait on any one source before giving up on it; start from the slowest-source latency signal plus a margin
- **collector buffer size** — how much the convergence point queues when producers outrun it; size it as the producer surplus rate times the longest burst you must absorb

### Signals to watch
<!--meta polarity=signal-->

- **slowest-source latency** — the tail that dictates await-all completion time
- **collector queue depth** — backlog building at the convergence point; alert when it stays above a set share of the buffer cap, chosen so backpressure can still act
- **timed-out / dropped source count** — sources that never returned in budget; alert when the rate exceeds the n-k failures a quorum tolerates

### Failure modes under load
<!--meta polarity=failure-->

- **a stuck source blocks await-all** — only a per-source timeout frees it; results arriving after it must be dropped by id and the caller told the result is partial
- **collector saturation** — many fast producers overwhelm the single sink without backpressure
- **unbounded buffering** — out-of-sync producer rates grow the collector's memory without a cap

### Readiness checklist
<!--meta polarity=check-->

- bound the collector buffer
- set per-source timeouts and a quorum or partial-result policy
- apply backpressure to producers
- make the merge order-independent, or order it explicitly

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Gen AI at Scale](../../themes/genai-scale.md) — Gather the parallel results {#fluency-genai-scale}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [MapReduce](../distributed/coordination/mapreduce.md) — Reduce is a fan-in that gathers the map outputs by key
- [Fan-Out](./fan-out.md) — Fan-out splits one into many; fan-in converges many back into one
- [Future / Promise](../concurrency/future-promise.md) — Awaiting several futures together is fan-in inside one process
- [Big Compute](../architecture/big-compute.md) — The gather half of a big compute run is exactly this.
- [Scatter-Gather](./scatter-gather.md) — Scatter-gather is fan-out plus fan-in, with a deadline and a correlation id added.

**Often confused with**

- [Aggregator](./aggregator.md) — Fan-in is the convergence topology; an aggregator is the mechanism that combines at it

**Exposed to**

- [Unbounded Queue](../../hazards/unbounded-queue.md) — Fast sources outrun the collector, so its buffer grows without a cap.

**Demonstrated by**

- [YouTube](../../designs/youtube.md) — The orchestrator owns the join counter and retries so no hand-rolled counter row is needed

<!-- relationships:end -->
