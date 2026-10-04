---
title: Pipe-and-Filter
description: Data flows through independent processing stages
area: architecture
owner: Oleksandr Derechei
tags: [modularity, composition, decoupling, transformation]
status: stable
aliases: [pipes-and-filters, pipeline]
solves: ["one function parses, validates, transforms and formats and it is nine hundred lines", I need the same cleanup step in three different jobs and it is copy-pasted, adding a new processing step means rewriting the whole transformation, I load the entire file into memory before I can process any of it, reordering two steps in this job requires untangling them from each other first]
---

# Pipe-and-Filter

Data streams through a chain of independent filters, each one consuming, transforming, and re-emitting it before handing the result down the pipe to the next stage.

## What it is
<!--meta block=description-->

One function that parses, validates, transforms and formats cannot be changed without re-reading and re-testing all of it, and its cleanup step cannot be reused. Pipe and filter splits the job into small filters, each doing one transformation. Pipes carry each filter's output into the next one's input, and a filter knows only the shape of the data it reads and writes.

## Explained
<!--meta block=explain-->

Pipe and filter splits a job into a line of small steps, called filters. Each filter does one transformation, and pipes carry one filter's output into the next filter's input. The pipe is the only channel between steps, so you can reorder, replace or reuse them, and run them in one process, in separate threads or on separate machines without changing the filter logic, once records can be serialized between stages. The Unix shell and stream-processing frameworks are built this way. Choose it over one long function when steps change independently or other jobs need the same cleanup step. For a small fixed job that must succeed or fail as one unit, a single function is clearer.

- **The slowest filter caps the line.** Buffer before it and run several copies; copies finish out of order, so number records to keep order.
- **Restarts repeat records.** Make filters safe to repeat and have the pipe drop repeats by record ID. An outside effect needs its own idempotency key.
- **Hand-offs add delay.** Keep tiny steps together in one stage.

**Example.** A log line passes through four filters: parse at 1 ms a record, drop health checks, mask emails at 4 ms a record, then format. One masking copy handles 250 records a second, as 1,000 ms divided by 4 ms. After health checks go, 1,000 records a second still reach masking, so its buffer grows without end. Four copies share the buffer and handle exactly 1,000 a second, so a burst still queues. A crashed copy restarts and replays 500 records, so the pipe drops any record ID already seen. The cost is the buffer, the 4 copies, and an ID store that must expire old IDs.

## How it works
<!--meta block=structure-->

```mermaid caption="What lets you splice a stage in, or swap one out, without editing its neighbours? No filter in the box names another one — each is written against the record it receives and the record it emits, so every numbered arrow is a place a new filter can be cut in."
flowchart LR
    Src[("Log file")]
    subgraph Pipe["Each filter knows only the shape it takes in and the shape it emits"]
        Parse["Parse"]
        Drop["Drop bad lines"]
        Enrich["Look up customer"]
        Format["Format row"]
    end
    Sink[("Report store")]
    Src -->|"1 raw line"| Parse
    Parse -->|"2 record"| Drop
    Drop -->|"3 valid record"| Enrich
    Enrich -->|"4 named record"| Format
    Format -->|"5 report row"| Sink
```

```mermaid caption="Give each stage its own thread and the fast one races ahead. A bounded queue on the seam turns that into backpressure: once Q1 is full, Parse blocks on the hand-off and the pipeline settles at the speed of the lookup instead of buying memory to hide it."
flowchart LR
    Parse["Parse — fast"]
    Q1[("bounded queue")]
    Enrich["Look up customer — slow"]
    Q2[("bounded queue")]
    Format["Format row"]
    Parse -->|"1 emit"| Q1
    Q1 -->|"2 take"| Enrich
    Enrich -->|"3 emit"| Q2
    Q2 -->|"4 take"| Format
    Q1 -.->|"5 full: Parse blocks"| Parse
```

## Variations
<!--meta block=variations-->

- **Pull (lazy) pipelines** — Each filter is an iterator that only computes its next value when downstream asks for one — memory-cheap, and results start flowing before the whole input is read.
- **Batch pipelines** — Each filter runs to completion over its whole input before handing off the full output. Simpler to reason about, but no result until every stage finishes.
- **[Producer-Consumer staging](../concurrency/producer-consumer.md)** — Adjacent filters are split across threads or processes, connected by a bounded queue instead of a direct call, so each stage runs at its own pace.
- **[Backpressure-aware filters](../concurrency/backpressure.md)** — A slow filter signals upstream to slow down production instead of letting an [unbounded queue](../../hazards/unbounded-queue.md) build up between stages.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Filters are small**, single-purpose, and independently testable.
- **Pipelines are recomposable** — reorder, insert, or drop a stage without rewriting the rest.
- **Independent stages can run concurrently**, on separate threads or machines.
- **New behavior often means adding a filter**, not editing existing ones.

### Cons
<!--meta polarity=con-->

- **Moving data between stages** adds latency and overhead, and across process or machine seams it also costs serialization.
- **An error deep in the pipeline** is harder to trace back to its source stage.
- **State that spans the whole** request doesn't fit a model of stateless, local filters.
- **Overall throughput is capped** by the slowest filter unless stages are buffered or parallelized.
- **A stage that dies** usually takes the whole run with it. A restart can redo finished work or hand the next stage a record it has already seen, so filters must be safe to repeat and the pipe must drop repeats. A record that always fails needs a dead-letter side channel, or the restart loop replays it forever.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Processing naturally decomposes** into a sequence of independent transformations.
- **You want stages that can be reordered**, reused, or replaced without touching the others.
- **Stages can usefully run concurrently**, or scale independently under load.

### Avoid when
<!--meta polarity=avoid-->

- **The steps share complex state** or must run as one atomic unit.
- **A single straightforward function** is clearer than a pipeline of tiny stages.
- **The overhead of pipes** and buffering outweighs the benefit for a small, fixed job.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a pipeline of async generator filters"
type Filter<In, Out> = (input: AsyncIterable<In>) => AsyncIterable<Out>;

async function* source(): AsyncIterable<number> {
  for (let i = 1; i <= 5; i++) yield i;
}

const double: Filter<number, number> = async function* (input) {
  for await (const n of input) yield n * 2;
};

const format: Filter<number, string> = async function* (input) {
  for await (const n of input) yield `value=${n}`;
};

// Filters compose: each only knows its own input/output shape.
// Pull-based: a slow consumer delays the next pull, so no unbounded buffer builds.
async function run() {
  const pipeline = format(double(source()));
  for await (const line of pipeline) console.log(line);
}

run();
```

## In the wild
<!--meta block=wild-->

- **Unix shell pipes** — The shell connects programs with anonymous pipes, a fixed kernel buffer of 64 KB by default on Linux. Stages run concurrently, and when the buffer fills the writer blocks, giving the pipeline natural backpressure for free. {#wild-unix-pipes}
- **java.util.stream** — Intermediate map and filter operations are lazy and do nothing until a terminal operation runs; calling parallelStream splits the source and runs the pipeline across the shared ForkJoinPool.commonPool. {#wild-java-streams}
- **GStreamer** — GStreamer links elements through typed pads into a pipeline; inserting a queue element hands the downstream segment its own thread, and a bus carries state-change and error messages back to the application. {#wild-gstreamer}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Inter-stage queue bound** — Capacity of the bounded buffer between adjacent filters. Too small and a fast downstream stage sits idle; too large and it hides backpressure while memory grows. Start at the downstream rate times the delay you will tolerate (Little's law), then tune until the queue before the slowest stage runs near full and the others stay near empty.
- **Batch / chunk size** — How many records a filter reads or emits per hand-off. Larger batches amortize per-item and serialization overhead; smaller batches cut end-to-end latency. Raise it until throughput stops improving, and stop before latency breaks your budget.
- **Per-stage parallelism** — Number of worker threads or instances running one filter, so a slow stage can be scaled independently. Workers needed are about its per-record time times the target records a second; stop when another stage becomes the slowest. Copies can emit out of order, so decide whether to resequence.

### Signals to watch
<!--meta polarity=signal-->

- **Per-stage queue depth** — Fill level of each inter-stage buffer. A queue that stays near full marks the stage just downstream as the bottleneck. Alert when depth stays above a set fraction of the bound across several sampling intervals, not on one spike.
- **Per-stage throughput** — Records per second each filter completes. The slowest stage sets the ceiling for the whole pipeline.
- **End-to-end latency** — Time for one record to traverse every stage; it rises by the wait in each backed-up queue.

### Failure modes under load
<!--meta polarity=failure-->

- **Slowest stage caps throughput** — The pipeline runs no faster than its slowest filter; buffers ahead of it fill and stages upstream stall waiting to hand off.
- **Unbounded queue exhausts memory** — With no bound and no backpressure, a fast producer ahead of a slow filter grows the connecting buffer until the process runs out of memory.
- **Head-of-line blocking** — In an ordered stage, one slow or stuck record blocks every record behind it, including records that could already run. Mitigate with a per-record timeout routing to a dead-letter or skip path, or with unordered workers when order does not matter.

### Readiness checklist
<!--meta polarity=check-->

- Every inter-stage queue is bounded, with a defined full policy: block, drop, or spill to disk.
- The slowest stage is identified and can be parallelized or scaled on its own.
- Backpressure propagates from the slowest consumer back to the source.
- A stage failure has a defined outcome (retry, skip, or halt) and the failing record is traceable to its stage.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Streaming](../../themes/streaming.md) — Compose stages into a processing pipeline {#fluency-streaming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Producer-Consumer](../concurrency/producer-consumer.md) — Stages are producers and consumers in series
- [Backpressure](../concurrency/backpressure.md) — Slow filters must push back upstream
- [Big Data](./big-data.md) — Data pipelines are the pattern at scale, one stage per transformation.
- [Content Enricher](../messaging/content-enricher.md) — Each filter in a pipeline can be an enricher that adds one piece of data
- [Routing Slip](../messaging/routing-slip.md) — A fixed pipeline can be made per-message by attaching a routing slip

**Often confused with**

- [Pipeline / Composition](../functional/pipeline.md) — Stages that can span threads or machines, not just calls
- [Chain of Responsibility](../gof/behavioral/chain-of-responsibility.md) — Every filter transforms and forwards; a handler may stop the request.

**Exposed to**

- [Unbounded Queue](../../hazards/unbounded-queue.md) — A queue between two filters with no bound lets a slow stage grow memory instead of pushing back.

**Demonstrated by**

- [Web Crawler](../../designs/web-crawler.md) — each stage is a filter passing work through queues, so a failure is isolated to one URL and stages scale apart
- [YouTube](../../designs/youtube.md) — the transcoding chain is a textbook sequence of independent filters passing artifacts downstream

**Implemented by**

- [Data & Analytics](../../capabilities/data-analytics.md) — Managed extract, transform, load (ETL) services are this, with the stages configured rather than coded.

<!-- relationships:end -->
