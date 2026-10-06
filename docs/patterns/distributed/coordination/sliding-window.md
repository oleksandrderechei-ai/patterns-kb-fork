---
title: Sliding Window
description: "Aggregates the recent past in bounded state, aging events out instead of resetting"
area: distributed-data
owner: Oleksandr Derechei
tags: [performance, state-management, throughput, resource-management]
status: stable
aliases: [rolling window, sliding window counter, windowing]
solves: [my per-minute counter resets on the boundary and lets through double the rate for a moment, "I need the count for the last hour, not for the current hour", keeping every event so I can count the recent ones is eating all the memory, the average over the whole day hides the spike that happened ten minutes ago, each fetcher enforces its own limit so the real rate is the limit times the fleet size]
---

# Sliding Window

A sliding window holds the events of a moving interval that ends at now, so an aggregate answers for the last T rather than for the current clock period.

## What it is
<!--meta block=description-->

A fixed clock-minute counter resets at the boundary, so a caller can send a full allowance just before it and another just after. A sliding window keeps a running total over the last T seconds, ending now, and drops events as they age out. It serves rate limits and trending counts, and its bill is memory per key.

## Explained
<!--meta block=explain-->

A sliding window keeps a running total over the last T seconds, ending now, and drops events as they age out, so a limit or a count holds over any recent minute and not just each clock minute. A fixed clock-minute counter resets at the boundary, so a caller can send a full allowance just before it and another just after, double the rate in two seconds. In a [rate limiter](../resilience/rate-limiter.md) the window bounds a counter per caller; in stream analytics it bounds the aggregate itself, so trending means the last hour. Choose the exact version, one stored timestamp per event, only when the window is short or the traffic per key is thin. At fleet scale use the cheaper version, a weighted blend of the previous and current counters, whose error is bounded by one window total.

- **Memory per key.** Cost is keys alive times what one key holds. Compute it before choosing a version.
- **Quiet keys linger.** Their state never leaves. Expire a key after one window of silence.
- **Shared window.** Many servers need a shared store. Decide fail-open or fail-closed before it is down.

**Example.** You limit each user to 100 requests a minute. A fixed counter lets a user send 100 at 0:59 and 100 at 1:01, 200 in 2 s. An exact sliding log fixes that but stores 100 timestamps of 8 bytes per user, 800 bytes, so 1 million active users cost 800 MB. A weighted counter stores 2 counters of 8 bytes, 16 bytes per user, 16 MB in all. At 1:15 with 100 in the previous minute and 20 so far, it counts 100 times 0.75 plus 20, which is 95. The cost is that this is an estimate, not an exact count.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a count stay pinned to the last T seconds rather than to the current clock minute? Arrivals at 1 and 2 only ever touch the newest bucket, the clock at 3 retires the oldest, and the answer at 5 and 6 is whatever is still inside the window — so the state kept is set by the window length, not by how long the stream has been running."
flowchart LR
    Src["Event source"]:::ext
    Keeper["Window keeper"]
    subgraph W["The window — the last T seconds"]
        Buckets[("Sub-interval counters")]
    end
    Clock["Clock tick"]
    Caller["Caller asking 'how many in the last T?'"]:::ext
    Src -->|"1 event arrives"| Keeper
    Keeper -->|"2 add it to the newest bucket"| Buckets
    Clock -->|"3 retire every bucket older than T"| Buckets
    Caller -->|"4 ask"| Keeper
    Keeper -->|"5 sum the surviving buckets"| Buckets
    Keeper -->|"6 answer for now minus T to now"| Caller
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The burst that straddles a boundary. A fixed window forgives the first hundred the instant the clock ticks, so twice the intended rate lands in two seconds; the sliding window still counts them, because it measures back from now and nothing has aged out yet."
sequenceDiagram
    autonumber
    participant C as Caller
    participant F as Fixed window counter
    participant S as Sliding window counter
    Note over C,S: the limit is 100 per minute
    C->>F: 100 requests at 10:00:59
    F-->>C: allowed — the 10:00 minute now holds 100
    C->>S: the same 100 requests
    S-->>C: allowed — the last 60s now holds 100
    Note over F: 10:01:00 — the counter resets to zero
    C->>F: 100 more requests at 10:01:00
    F-->>C: allowed — 200 served inside two seconds
    C->>S: the same 100 more requests
    S-->>C: refused — the first 100 are still inside the window
```

## Variations
<!--meta block=variations-->

- **Fixed (tumbling) window** — Count inside whole clock intervals and reset at each boundary. It is one counter and one timestamp per key, the cheapest thing that works, and it is the baseline the others exist to fix: a burst placed either side of the boundary is counted as two legal windows, so up to twice the intended volume passes inside a moment. Keep it when the boundary is the question — a calendar month of billing is a tumbling window by definition.
- **Hopping window** — A fixed-length window that advances by a slide shorter than itself, so consecutive windows overlap — "the last five minutes, recomputed every minute". The edge error shrinks to the slide rather than the window length, and the cost is that each event belongs to length-over-slide windows at once, which is exactly the factor your state multiplies by.
- **Sliding log** — Keep one timestamp per event, drop everything older than the window on each touch, and count what remains. It is exact at every instant and answers questions a counter cannot, such as when the allowance next frees up. Memory grows with the events inside the window, so at fleet rates the log is the whole bill.
- **Sliding counter (weighted approximation)** — Hold two totals per key — the previous window and the current one — and prorate the previous by the fraction of it still inside the window. State is two numbers per key whatever the traffic, which is why this is the form most limiters actually deploy. The estimate assumes arrivals inside the previous window were evenly spread, so a burst clustered at its far edge is counted a little high or a little low; the error is bounded by that one window's total.
- **Session window** — Let the data define the length: the window stays open while events keep arriving and closes after a gap of inactivity. It is how a user's activity is grouped into sessions when no fixed interval means anything. Per-key state lives until the gap timer fires, so an abandoned key holds memory for the length of the gap, and a key that never goes quiet never closes.
- **Decayed / exponential window** — Evict nothing; instead scale every count down on a schedule or on each touch, so old events fade rather than fall off a cliff. There is no edge to get wrong and no per-event state, so it costs less than any windowed count. The number is a weight, not a count: it ranks well but you cannot audit it.
- **Sliding bucket window** — Split the window into N sub-interval counters per key and retire the oldest as the clock advances. State is N numbers per key whatever the traffic, the edge error is one bucket's traffic, and per-shard counters on the same alignment add position by position.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **A burst cannot be split** across a boundary and admitted twice, because the window always measures back from now. That is exact for the log; the weighted counter and bucketed windows leak at most one window total or one bucket.
- **State is bounded** by the window length rather than by the age of the stream — everything older is evicted, so a counter that has run for a year costs what one that started this morning costs.
- **The window length is a single dial** with an honest meaning: shorten it and the aggregate reacts faster, lengthen it and it smooths, and nothing else in the design has to change.
- **Recency is explicit**, so yesterday's spike cannot dominate today's ranking — which is what makes "trending" mean anything.
- **Bucketed windows on a shared** alignment add position by position, so per-shard counters merge into a fleet-wide answer without replaying any events.

### Cons
<!--meta polarity=con-->

- **Exact window costs memory per event** — it keeps one entry per event still inside it, so memory tracks traffic rather than key count; sub-interval counters cost a fixed amount per key instead, and blur the edge by one bucket.
- **Granularity is the dial on that blur**: halve the bucket width and you halve the edge error while doubling the counters carried per key, and the structure that is affordable at 10 requests a minute per key is not affordable at 10,000.
- **Eviction is work the arrival** path did not have before. Amortize it on read and write, because a timer that sweeps every key at once turns steady cost into a periodic latency spike.
- **A window that holds across** a fleet needs shared state, so the store's round trip joins every request and its unavailability needs a fail-open or fail-closed answer decided in advance.
- **Windows keyed to wall-clock time inherit clock skew**: two hosts disagree about when an event leaves, and the effective window wobbles by however far their clocks drift.
- **Subtracting an event** as it exits means retaining it for a full window length, so a sliding total over 30 days keeps fine-grained data for 30 days; the running number is cheap, the tail that feeds it is not. This holds for sums and counts; a max or min cannot be subtracted, so it needs per-bucket partials or a monotonic queue of candidates.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The question is "in the last T"**, counted back from now — the current rate, what is trending, how many errors in the last five minutes.
- **A boundary reset would be exploitable or misleading**: a caller can double its rate across the edge, or a spike vanishes from the dashboard the moment the hour turns.
- **The stream is unbounded** and only the recent past has to survive, so you need the state to stop growing without throwing the answer away.
- **The aggregate has to react** while the change is happening rather than at the next boundary — a limiter that frees allowance smoothly gives callers a steady rate instead of a stampede on the tick.

### Avoid when
<!--meta polarity=avoid-->

- **The boundary genuinely does not matter**: a tumbling window is one counter and one reset, and paying for a sliding one buys nothing.
- **The period is defined by the calendar** — "requests this month" on an invoice is a fixed window by definition, and a sliding one answers a different question that nobody asked.
- **Every event is being kept anyway**. Query the store, or precompute the rollup as a [Materialized View](./materialized-view.md), rather than maintaining a second copy of the recent past.
- **The window is long** and the keys are many, so per-key state will not fit whatever shape you pick — decay the counts or sample the stream instead of pretending the memory exists.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a weighted sliding counter: two numbers per key, whatever the traffic"
class SlidingWindowCounter {
  private previous = 0;                    // the completed window's total
  private current = 0, windowStart = 0;     // in-progress total; when it opened
  constructor(private readonly windowMs: number) {}
  // Age the counters forward to `now`. One step back is still weighted; two is gone.
  private roll(now: number): void {
    const elapsed = now - this.windowStart;
    if (elapsed < this.windowMs) return;
    this.previous = elapsed < 2 * this.windowMs ? this.current : 0;
    this.current = 0;
    this.windowStart = now - (elapsed % this.windowMs);
  }

  // Estimated arrivals in [now - windowMs, now].
  count(now = Date.now()): number {
    this.roll(now);
    // How much of the previous window is still inside the sliding one.
    const overlap = 1 - (now - this.windowStart) / this.windowMs;
    return this.previous * overlap + this.current;
  }

  tryAdd(limit: number, now = Date.now()): boolean {
    if (this.count(now) >= limit) return false;
    this.current += 1; return true;
  }
}
// new SlidingWindowCounter(60_000).tryAdd(100): 100 arrivals at 10:00:59 still
// count as 100 at 10:01:00 (previous window fully inside) and about 98 at
// 10:01:01, so a burst there is refused after only 2 more are admitted, not
// forgiven.
```

## In the wild
<!--meta block=wild-->

- **Apache Flink** — Windowing is a first-class operator over event time or processing time — tumbling, sliding (`SlidingEventTimeWindows`) and session windows. A watermark decides when a window is complete, and an allowed-lateness setting governs what happens to an event that turns up after its window fired. {#wild-apache-flink}
- **Kafka Streams** — Windowed aggregations key a table by window as well as by record key: `TimeWindows` for tumbling and hopping windows, `SessionWindows` for activity gaps. Each carries a grace period after which a late record is dropped, and the windowed state store keeps segments only for its configured retention. {#wild-kafka-streams}
- **Redis sorted sets** — The exact sliding log is built from one sorted set per key: `ZADD` the arrival timestamp as the score, `ZREMRANGEBYSCORE` to drop everything older than the window, then `ZCARD` for what remains. The three are usually wrapped in a Lua script so a concurrent request cannot read a half-evicted window. {#wild-redis-sorted-set}
- **Prometheus** — A range vector selector such as `http_requests_total[5m]` takes the samples inside the five minutes ending at the evaluation instant, so a `rate()` over it is measured back from now rather than over the last whole five-minute block. {#wild-prometheus}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Window length** — The interval the answer covers. It is the meaning of the number rather than a performance setting — shorten it and the aggregate reacts faster and swings harder, lengthen it and it smooths and lags.
- **Granularity** — Bucket width for a bucketed window, or the slide for a hopping one. It sets the edge error and the state together: halve it and you halve the error while doubling the buckets carried per key.
- **Idle-key expiry** — How long a key keeps its window after its last arrival. Without one, per-key state grows with every key ever seen instead of with the keys currently active.
- **State placement** — Local to the replica, or in a store every replica shares. Local is free and enforces per replica, so the fleet-wide figure is yours multiplied by the replica count; shared holds fleet-wide and joins the request path.
- **Lateness policy** — How long a closed window still accepts events that arrived out of order, and what becomes of the ones that miss it — dropped, or routed somewhere they can be reconciled.

### Signals to watch
<!--meta polarity=signal-->

- **Window state size and key cardinality** — The memory bill in the two terms that actually move it: how many keys hold a window, and how much each one holds.
- **Share of events arriving after their window closed** — The measure of whether the lateness allowance matches reality. A rising share means the answer is quietly incomplete.
- **Eviction cost and its shape** — How much of the arrival path goes on retiring old state, and whether that cost is spread across requests or arrives as a periodic spike.
- **Round-trip latency of the shared window operation** — With a shared store the window inherits its p99 on every request that touches it, so that latency is part of yours.
- **Clock offset between the hosts keeping or querying the window** — It is the width of the disagreement about when an event leaves, and therefore how far the effective window can wobble.

### Failure modes under load
<!--meta polarity=failure-->

- **Key cardinality explodes and memory follows** — A per-key window is bounded per key and unbounded in keys. A surge of new keys — rotation, a fan-out, a scan — fills the heap while every individual window still looks small.
- **Coarse buckets admit more than intended** — The edge error is one bucket's worth of traffic, so a granularity chosen to save memory becomes an allowance you did not mean to grant — and it is spent during a burst, which is when it hurts.
- **The sweep stalls the path it was meant to keep cheap** — A timer that evicts every key at once concentrates the whole eviction cost into one moment, and the pause lands on whatever request is in flight.
- **A hot key serializes on the shared store** — One popular key puts every replica on the same entry, so the read-modify-write on that window becomes the narrowest point in the system.
- **Out-of-order events land after their window closed** — The window has already answered, so the correction has nowhere to go and the total drifts from the source of record without anything failing.

### Readiness checklist
<!--meta polarity=check-->

- The window length is written down as a product statement — what the number means to whoever reads it — before it is tuned as a memory setting
- Per-key state is bounded by an idle expiry, and the key cardinality that fits in memory is a figure someone computed (bytes per key times active keys: two numbers for the counter, one timestamp per event for the log) rather than assumed
- The edge error of the chosen granularity was calculated against the limit or threshold it feeds, so the approximation is a decision and not a surprise
- A load test drove a burst straight across the window boundary and the admitted volume matched the intended one
- The behaviour when a shared window store is unreachable was chosen deliberately and exercised with the store switched off
- Late and out-of-order events have a stated allowance and a defined fate beyond it, and the rate of them is exported

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Streaming](../../../themes/streaming.md) — Aggregate the last T of an unbounded stream, ageing old events out. {#fluency-streaming}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Rate Limiter](../resilience/rate-limiter.md) — The window is how the limiter counts — an allowance over any recent minute, not each clock minute
- [Count-Min Sketch](./count-min-sketch.md) — Decaying or rotating the sketch's counters is this window applied to an approximate count
- [Aggregator](../../messaging/aggregator.md) — The aggregator's completion condition is usually a window over arrival time

**Alternative to**

- [Token Bucket](../resilience/token-bucket.md) — Two shapes of the same allowance: remember arrivals, or refill credit
- [Materialized View](./materialized-view.md) — Precompute the windowed rollup instead of keeping a second copy of the recent past.

**Exposed to**

- [Clock Skew](../../../hazards/clock-skew.md) — Hosts disagree about when an event leaves, so the effective window wobbles by the drift.

**Demonstrated by**

- [Top-K](../../../designs/top-k.md) — The Top-K case study argues true-sliding against tumbling as its Staff-level distinction
- [Web Crawler](../../../designs/web-crawler.md) — A shared window is what makes a per-domain rate hold across many independent workers
- [Rate Limiter](../../../designs/design-rate-limiter.md) — Shows the log variant beside token bucket and fixed window, each with different per-key state

<!-- relationships:end -->
