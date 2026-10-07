---
title: Batching
description: Accumulate many items and process them together to amortize fixed per-item cost
area: concurrency
owner: Oleksandr Derechei
tags: [performance, batching, throughput, latency]
status: stable
aliases: [request batching]
solves: [every insert opens its own round-trip to the database and the writes crawl, we call the same API a thousand times in a loop and keep getting rate-limited, the GPU sits idle between single requests and inference throughput is terrible, per-message overhead dominates and the system cannot keep up with the incoming rate, committing each record one at a time is hammering the disk with fsyncs]
---

# Batching

Instead of handling each item the moment it arrives, batching collects items and processes them as a group — so the fixed cost of an operation (a network round-trip, a disk sync, a GPU kernel launch) is paid once for many items instead of once each.

## What it is
<!--meta block=description-->

Many operations cost about the same whether they carry one item or a hundred, such as a network round trip, a disk flush or an API call. Batching collects items in a buffer and sends them as one group when it holds enough items or enough time has passed. You pay each fixed cost once per group, and each item waits a little longer.

## Explained
<!--meta block=explain-->

Batching collects many small operations and sends them together as one, so the fixed cost of a call, such as a network round trip or a commit, is paid once for the whole group. The group goes out when it reaches a size limit or when a short timer, the linger time, runs out, whichever comes first. Choose it over one call per item when that fixed cost is larger than the cost of the data itself, which is usual for database writes, network calls and disk flushes. The gain is capped near the ratio of fixed cost to per-item cost; the example below gives about 29 times. At low traffic the trade flips, because items wait for a group that fills slowly, so flush at once when idle, or shrink the linger time as arrivals slow, if your load spans both ranges.

- **Items wait** Keep the linger time within a delay you can defend; under load the size limit fires first.
- **Buffer memory** Cap the buffer in bytes and make producers wait when it is full.
- **Half-failed groups** Record a result per item and make operations safe to repeat, so a retry redoes only the failures.

**Example.** You insert 10,000 rows, and each call costs a 2 ms round trip plus 0.05 ms of work per row. One call per row takes 10,000 x 2.05 ms = 20.5 s. In groups of 100, each call takes 2 + 100 x 0.05 = 7 ms, and 100 calls take 0.7 s, about 29 times faster. With a 10 ms linger time, the first row of each group waits up to 10 ms. At 10 rows a second the timer fires with one row in the group, so you gain nothing and add 10 ms. A failed group means 100 rows to retry, so track results per row.

## How it works
<!--meta block=structure-->

```mermaid caption="Why does one trip beat ten? The flush pays the round-trip, the fsync or the starting of a GPU job once for the whole group, and the linger timer is what stops an item waiting forever for that group to fill."
flowchart LR
    P["Producers"]:::ext
    subgraph Batcher["One flush pays the fixed cost once"]
        B[("Accumulator buffer")]
        T["Trigger: N items or T ms"]
    end
    D["Downstream: database, broker, GPU"]:::ext
    P -->|"1 submit an item"| B
    B -->|"2 hold it, count items, start the timer"| T
    T -->|"3 whichever fires first, flush"| B
    B -->|"4 one call carries the whole group"| D
    D -->|"5 per-item results back to each caller"| P
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Size-triggered vs. time-triggered (linger)** — Flush when the buffer reaches N items, or after a maximum wait has elapsed — usually whichever comes first. Size alone stalls forever when items trickle in; a linger timer bounds how long any item can wait.
- **Micro-batching** — Form very small groups on a tight timer so latency stays bounded while the fixed cost is still amortized across a handful of items. It is the middle ground between one-at-a-time and large batches, common in stream processing.
- **Client-side vs. server-side** — The caller groups its own requests and sends them to a bulk endpoint, or the server coalesces incoming requests from many callers before doing the work. Client-side needs no server change; server-side batches across independent clients that cannot cooperate.
- **Dynamic / adaptive batching** — Grow the batch size as load rises and shrink it when the system is idle, so you amortize hard under pressure but do not add latency when there is nothing to amortize.
- **Opportunistic (group commit)** — Send whatever arrived while the previous call was running, with no timer, so batches grow only under load and an idle system adds no wait.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Higher throughput** — the fixed per-operation cost is amortized across the whole group.
- **Fewer round-trips**, syscalls, and commits for the same amount of work.
- **Uses bulk-efficient resources well** — DB bulk inserts, GPU kernels, vectorized paths.
- **Absorbs bursts** into fewer, larger calls while the buffer is bounded; each call is heavier, and past the bound memory grows or producers wait.

### Cons
<!--meta polarity=con-->

- **Added latency**: each item waits up to the linger time, and at low arrival rates the timer fires on near-empty groups, so you pay that wait for no throughput gain.
- **Bigger blast radius** — a single failed group can affect many items at once.
- **Costs memory** to hold in-flight items until the flush.
- **Partial-failure handling is harder** — which items in the group succeeded, and which must be retried?
- **Buffered items are lost** if the process dies before the flush; acknowledge callers only after the flush when loss is unacceptable.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The per-item fixed cost dominates** — most of the work is overhead, not payload.
- **Throughput matters more than the latency** of any single item.
- **The downstream is far more efficient in bulk** (bulk insert, GPU, vectorized ops).
- **You are rate-limited by request count** and want fewer, larger requests.

### Avoid when
<!--meta polarity=avoid-->

- **Each item needs an immediate response** on an interactive path.
- **Items are large or memory-bound** and buffering them is costly.
- **Strict per-item ordering or isolation is required**.
- **Volume is low** — you add latency for a saving that never materializes.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — buffer calls, flush on size or a linger timeout"
class Batcher<In, Out> {
  private buffer: { item: In; resolve: (o: Out) => void; reject: (e: unknown) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly run: (items: In[]) => Promise<Out[]>,
    private readonly maxSize = 100,
    private readonly lingerMs = 10,
    private readonly maxBuffered = 1000,
  ) {}
  submit(item: In): Promise<Out> {
    if (this.buffer.length >= this.maxBuffered)
      return Promise.reject(new Error("buffer full")); // bound: reject here, or await capacity
    return new Promise<Out>((resolve, reject) => {
      this.buffer.push({ item, resolve, reject });
      if (this.buffer.length >= this.maxSize) this.flush();      // size trigger
      else this.timer ??= setTimeout(() => this.flush(), this.lingerMs); // time trigger
    });
  }
  private async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const group = this.buffer;
    this.buffer = [];
    if (group.length === 0) return;
    // concurrent flushes are not capped here; add a max-in-flight limit if the downstream needs one
    try {
      const results = await this.run(group.map((g) => g.item));
      if (results.length !== group.length) throw new Error("result count mismatch");
      group.forEach((g, i) => g.resolve(results[i])); // hand each caller its result
    } catch (e) {
      group.forEach((g) => g.reject(e)); // per-item isolation or retry would go here
    }
  }
}

```

## In the wild
<!--meta block=wild-->

- **Java Database Connectivity (JDBC) addBatch/executeBatch** — Groups many SQL statements into one round-trip to the database; some drivers add rewriteBatchedStatements to collapse repeated inserts into one statement. {#wild-jdbc-batch}
- **Apache Kafka producer** — Accumulates records per partition and sends them together; batch.size caps bytes per batch and linger.ms adds a small wait so more records join each send. {#wild-kafka-producer}
- **TCP Nagle's algorithm** — Coalesces small outgoing TCP segments until an ack returns or enough data accumulates, trading latency for fewer packets; TCP_NODELAY turns it off. {#wild-nagle}
- **OpenAI Batch API** — Submit a file of requests to run asynchronously (within 24h) at lower cost than synchronous calls — trading latency for throughput and price. {#wild-openai-batch}
- **Anthropic Message Batches API** — Send many Messages requests as one asynchronously-processed batch (within 24h) at reduced cost per request. {#wild-anthropic-batches}
- **vLLM continuous batching** — A large language model (LLM) serving engine that adds and evicts requests from the running GPU batch at each decoding step, keeping the batch full instead of waiting for the slowest request to finish. {#wild-vllm}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **max batch size** — the item or byte ceiling that forces a flush; raise it until throughput per item stops improving or the downstream per-call limit is reached
- **linger / flush interval** — the maximum time an item waits before the group ships, even under-filled; keep it within the latency headroom left after the downstream call time, and note that a linger shorter than the gap between arrivals ships single items
- **buffer bound** — cap on in-flight items or bytes held in memory

### Signals to watch
<!--meta polarity=signal-->

- **batch fill ratio** — average items per flush — low means linger is dominating and you are paying latency for little gain
- **items waiting / queue depth** — how much work is buffered ahead of the next flush
- **added p99 latency** — the tail latency the wait introduces
- **flush reason ratio** — share of flushes fired by size versus the linger timer, plus downstream time per batch; shows whether to raise size or linger

### Failure modes under load
<!--meta polarity=failure-->

- **under-fill at low load** — batches ship half-empty on the linger timer, so you pay latency without the throughput win
- **memory pressure under bursts** — an unbounded buffer grows without limit when producers outrun the flush
- **poison item** — one bad record can fail the whole group unless failures are isolated, for example by splitting a failed group in half and retrying each half, or retrying members singly

### Readiness checklist
<!--meta polarity=check-->

- bound the buffer by size or memory, never unbounded
- set linger to a latency budget you can defend
- handle partial failure: retry survivors, isolate the bad item
- load-test at both low and high arrival rates

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Scaling Writes](../../themes/scaling-writes.md) — Coalesce many small writes into fewer larger ones {#fluency-scaling-writes}
- [Gen AI at Scale](../../themes/genai-scale.md) — Keep the graphics processing unit (GPU) busy {#fluency-genai-scale}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md) — Level the arrival rate with a queue, then drain it in amortized groups
- [Backpressure](./backpressure.md) — An unbounded batch buffer needs backpressure so producers can't overrun it
- [Write-Behind](../caching/write-behind.md) — Write-behind coalesces deferred store writes into one flush
- [Request Coalescing](../distributed/resilience/request-coalescing.md) — Batching groups different keys; coalescing collapses identical ones — they stack

**Prevents**

- [N+1 Query](../../hazards/n-plus-1-query.md) — Coalesce the per-item fetches into one batched, keyed query (the DataLoader move)
- [Chatty I/O](../../hazards/chatty-io.md) — Collapses an operation that crosses the boundary once per item into a single round-trip

**Demonstrated by**

- [Distributed Cache](../../designs/design-distributed-cache.md) — demonstrates batching cutting both write pressure on a hot shard and per-request network chatter
- [Top-K](../../designs/top-k.md) — coalescing skewed hot-key writes collapses a 700k/sec firehose 2-100x into large periodic writes a database handles efficiently
- [Metrics & Monitoring](../../designs/metrics-monitoring.md) — amortising per-point overhead at the edge is what makes 5M points/second affordable to accept
- [Facebook Post Search](../../designs/fb-post-search.md) — batching is the first line of defence against the 100k-likes/sec write firehose
- [Strava](../../designs/strava.md) — coalescing hundreds of per-point writes into a single bulk sync is batching cutting backend request volume ~100x
- [ChatGPT](../../designs/chatgpt.md) — amortizing a fixed per-pass cost — streaming the whole weight set out of high-bandwidth memory (HBM) — across many sequences is the payoff batching exists to capture
- [Bitly](../../designs/bitly.md) — Write instances claim counter values in blocks of 1000, cutting Redis round-trips 1000x
- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — a compliance re-screen batches to fit a contracted vendor rate, and keeps the batch a transport optimisation rather than a unit of failure by committing each member separately
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — batching priced exactly: it buys rate and not invoice, and its partial-failure cost is paid one member at a time
- [Uber](../../designs/uber.md) — a design that tried batching location pings and rejected it for stale positions

**Implemented by**

- [Data & Analytics](../../capabilities/data-analytics.md) — The managed pipeline decides the batch boundary for you.

<!-- relationships:end -->
