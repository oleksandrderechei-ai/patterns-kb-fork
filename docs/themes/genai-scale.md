---
title: Gen AI at Scale
description: "Classic scale-out patterns — batching, sharding, map-reduce, scheduling, fan-out/fan-in — pointed at large models"
area: themes-scale
owner: Oleksandr Derechei
tags: [scalability, batching, throughput]
status: stable
---

# Gen AI at Scale

Generative-AI systems push on the same scaling axes as any large backend, only harder: one request can saturate a GPU, one model won't fit on one device, one machine can't chew through the training corpus. This theme walks the classic distributed patterns — batching, sharding, map-reduce, scheduling, and fan-out/fan-in — through how they show up in training, serving, and agent orchestration today.

## The question
<!--meta block=description-->

A generative-AI stack stresses ordinary backend load in new places: one inference request can saturate a GPU, one model no longer fits one device, one machine cannot process a terabyte corpus, and one agent turn fans out into dozens of calls. The levers are old ones: batching, sharding, map-reduce, scheduling, fan-out and autoscaling. What is new is where they apply: the GPU, the context window and the weights.

## Explained
<!--meta block=explain-->

Running large models at scale uses the same few moves as any big backend, aimed at the GPU, the memory it holds and the model's weights. One rule decides most choices: GPUs are expensive and idle time is waste, so you trade latency for GPU utilization. [Batching](../patterns/concurrency/batching.md) groups requests so one pass through the model serves many at once, which multiplies tokens per second. [Sharding](../patterns/distributed/routing/sharding.md) splits a model too big for one GPU across several. Map-reduce splits a huge dataset into chunks processed in parallel and then merged, which suits a nightly job, not an interactive one. [Scheduling](../patterns/concurrency/scheduling.md) moves work that is not urgent to cheaper off-peak hours. [Fan-out](../patterns/messaging/fan-out.md) sends one agent step to several model or tool calls at once. Choose batching first for serving, since it needs no extra machines, unless the batch wait alone breaks your latency target.

- **Batch wait.** A request waits for the group to fill, so cap the wait from your latency target; continuous batching shortens it.
- **Shard traffic.** Every pass pays for traffic between GPUs, so shard a model only when it does not fit one device.
- **Slowest call.** A fan-out waits for its slowest call, so set a per-call deadline and choose at expiry: drop, partial answer or retry.

**Example.** Suppose one decoding step of a model takes 40 ms for a single request and 50 ms for a batch of 16. Alone, a GPU produces 1 token per 40 ms, 25 tokens a second. Batched, it produces 16 tokens per 50 ms, 320 tokens a second, about 13 times more for the same machine. Each user now sees 20 tokens a second instead of 25, plus the wait for the batch. With fixed batches that wait is a fill; with continuous batching a new request joins at the next decoding step. A 20 ms cap bounds the delay, so a quiet hour sends smaller batches.

## The tradespace
<!--meta block=tradespace-->

Accelerators are expensive and idle time is waste, so the dominant trade is utilization against latency. [Batching](../patterns/concurrency/batching.md) keeps the GPU busy and multiplies tokens per second, but every request waits for the batch to fill. Batch size is also capped by the KV cache, the per-request attention memory, which grows with each request's context length, so long contexts shrink the batch. The [ChatGPT](../designs/chatgpt.md) case study walks through token streaming and GPU scheduling. When the model is rented, [Harness Engineering](./harness-engineering.md) covers the part you own.

[Sharding](../patterns/distributed/routing/sharding.md) a model across GPUs breaks the single-device memory ceiling, but each forward pass pays for the communication between the slices. [Map-reduce](../patterns/distributed/coordination/mapreduce.md) processes a corpus one machine could never hold, at the cost of a batch-shaped, high-latency job. [Scheduling](../patterns/concurrency/scheduling.md) pushes non-urgent inference into cheaper off-peak windows and asynchronous batch APIs, trading immediacy for cost. [Fan-out](../patterns/messaging/fan-out.md)/[fan-in](../patterns/messaging/fan-in.md) turns a slow serial chain of model calls into parallel ones, but the gather waits for the slowest branch, every branch spends its own tokens (best-of-n costs n times the tokens), parallel calls can hit provider rate limits, and coordinating the branches is its own cost. [Autoscaling](../patterns/distributed/routing/autoscaling.md) stops you paying for an idle peak-sized fleet, but a new replica must load its weights before it serves, so scale-up lags: keep headroom or warm replicas, or accept spike latency to save idle spend. For a sudden burst, see [Handling Spikes](./spike-handling.md).

## Patterns that scale Gen AI
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Batching](../patterns/concurrency/batching.md) {#tour-batching}

Batch size sets inference throughput, until memory or latency limits bite. A batch shares the fixed cost of one forward pass across all its requests, and continuous batching keeps the batch full by swapping requests in and out at every decoding step instead of waiting for the slowest one to finish. Asynchronous batch application programming interfaces (APIs) push the same idea further, trading up to a day of latency, set by the provider, for a lower price per token. Batch only when requests are queued while the GPU is under-used, so check queue depth and GPU utilization first.

### [Sharding](../patterns/distributed/routing/sharding.md) {#tour-sharding}

When a model's weights (plus gradients and optimizer state, when training) outgrow a single graphics processing unit (GPU), they are partitioned across many — the same partition-by-key idea as a sharded database, applied to tensors. The data side shards too: billion-vector embedding indexes are split across nodes and answered by a fan-out query. When serving, one lost GPU takes its whole replica down, so plan restart and failover per group.

### [MapReduce](../patterns/distributed/coordination/mapreduce.md) {#tour-mapreduce}

Preparing training data, generating embeddings, and summarizing a document longer than the context window all take the same shape: map a function over independent chunks in parallel, then reduce the pieces into one result. It is a batch job — high latency, enormous throughput.

### [Scheduling](../patterns/concurrency/scheduling.md) {#tour-scheduling}

Not every generation needs to happen now. Bulk evaluations, nightly re-indexing, and large offline inference runs are scheduled into cheaper windows; flaky model-provider calls are retried on a backoff; and durable schedulers keep long, multi-step agent workflows alive across restarts.

### [Fan-Out](../patterns/messaging/fan-out.md) {#tour-fan-out}

An agent turn rarely needs just one model call. Fanning a request out to several tools, sub-agents, or model samples at once means none waits on the others — the parallelism that makes a multi-step agent feel fast instead of serial.

### [Fan-In](../patterns/messaging/fan-in.md) {#tour-fan-in}

The other half of the round trip: the outputs of those parallel calls converge at one point that waits for them — or a quorum of them — and combines them, whether that means merging tool results or ensembling several generations by voting or best-of-n.

### [Autoscaling](../patterns/distributed/routing/autoscaling.md) {#tour-autoscaling}

Inference load is spiky and GPUs are the most expensive line in the budget, so the serving fleet is resized against a signal (queue depth, latency, tokens in flight) instead of paying year-round for a peak that shows up occasionally. A new replica must load its model weights before it serves, so scale on a leading signal and keep some headroom; a sudden burst can still outrun it.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you're hitting… | Lean | Reach for |
| --- | --- | --- |
| Low inference throughput while GPUs sit idle | Group requests | [Batching](../patterns/concurrency/batching.md) |
| A model or index that won't fit on one device | Partition across devices | [Sharding](../patterns/distributed/routing/sharding.md) |
| A dataset or corpus too big for one machine | Map, then reduce | [MapReduce](../patterns/distributed/coordination/mapreduce.md) |
| Bulk, non-urgent, or must-retry work | Defer and orchestrate | [Scheduling](../patterns/concurrency/scheduling.md) |
| One agent turn needing many model or tool calls | Parallelize, then gather | [Fan-Out](../patterns/messaging/fan-out.md) + [Fan-In](../patterns/messaging/fan-in.md) |
| Serving load that swings with demand on costly accelerators | Resize with demand | [Autoscaling](../patterns/distributed/routing/autoscaling.md) |

## Related areas
<!--meta block=siblings-->

- [Scalability](./scalability.md) — The general form of everything here — these are the same scale-out patterns, pointed at GPUs and context windows.
- [Performance](./performance.md) — Throughput, latency, and utilization — the quantities every trade on this page is measured in.
- [Streaming](./streaming.md) — Token-by-token generation is the low-latency counterweight to batch-shaped throughput.
- [Handling Spikes](./spike-handling.md) — Autoscaling is one of its three answers and it lags, so a burst of inference traffic also needs a queue or load shedding.
- [Scaling Writes](./scaling-writes.md) — Batching and sharding for a database's write path; here the same moves point at GPU inference and model weights.
