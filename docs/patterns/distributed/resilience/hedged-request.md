---
title: Hedged Request
description: "Send a second copy of a slow read to another replica and take the first answer, cutting tail latency for a few percent more load"
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, latency]
status: stable
aliases: [backup request, speculative retry, speculative execution]
solves: [my median latency is fine but one request in a hundred takes hundreds of milliseconds, a page that calls many servers is slow whenever any one of them stalls, "one replica pauses for a moment and users see the slowest responses, with no errors anywhere", "timeouts and retries do not help because the slow call does not fail, it is just late"]
---

# Hedged Request

Send a second copy of a read to another replica when the first has not answered within your usual latency, use whichever answer comes first and cancel the other, so one slow server no longer sets your slowest responses.

## What it is
<!--meta block=description-->

A few requests to a replicated service are very slow, though nothing has failed, and a page that fans out to many servers waits on the slowest. A hedged request sends a second copy to another replica when the first is later than usual, uses whichever answer comes first and cancels the other. A timeout turns slowness into an error and a retry waits for failure, so neither helps.

## Explained
<!--meta block=explain-->

A hedged request cuts your slowest responses by sending a second copy of a read to another replica when the first is slower than usual. You send to one replica and start a timer set to a high percentile of your normal latency, often the 95th (the time that 95 of 100 requests beat). If the answer comes first, nothing more happens. If the timer fires first, you send the same request to a second replica, use the first answer that arrives and cancel the other. Slow answers here come from pauses and noisy neighbours, not errors, so a timeout cannot help, and a retry waits for a failure that never comes. Choose it over a retry when the problem is lateness.

- **Extra load.** Every hedge is another request, so set the delay high and cap hedges with a budget.
- **Doubled writes.** A duplicated write can run twice, so hedge only reads and idempotent calls (safe to repeat).
- **Shared slowness.** If all replicas are slow for the same reason, a copy waits as long as the original.
- **Cancel needed.** A copy with no cancel signal keeps running, so pass one through.

**Example.** A read hits one of 3 replicas with a median of 5 ms and a p95 of 12 ms. About 1 request in 100 stalls for 400 ms. You hedge after 12 ms. About 5 percent of requests send a copy, so load rises 5 percent. A request is now slow only if both replicas stall, about 1 in 10,000 if the stalls are independent, so the slow case answers near 17 ms (12 ms wait plus 5 ms on the second replica) and the p99 falls from 400 ms to about 20 ms. If the database behind all 3 replicas stalls, both copies stall and nothing improves.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one slow replica stop setting your slowest answers? The client sends to replica A at 1 and starts a timer at 2 set to the 95th-percentile latency; if A has not answered when it fires, a copy goes to replica B at 3, the first answer wins at 4, and the loser is cancelled at 5."
flowchart LR
    Client["Client"]
    subgraph Policy["Hedge policy"]
        Timer["Timer: hedge delay = p95"]
    end
    A["Replica A"]
    B["Replica B"]
    Client -->|"1 send request"| A
    Client -->|"2 start timer"| Timer
    Timer -->|"3 no answer yet: send a copy"| B
    A -->|"4 first answer wins"| Client
    B -->|"4 or this one does"| Client
    Client -->|"5 cancel the loser"| B
```

```mermaid caption="What changes with a slow replica? Without a slow replica the answer comes before the timer and no second copy is sent; with one, the copy goes out at the hedge delay and the second replica's answer is used."
sequenceDiagram
    autonumber
    participant C as Client
    participant A as Replica A
    participant B as Replica B
    C->>A: read key (hedge delay 12 ms)
    alt A answers within 12 ms
        A-->>C: value
        Note over C: about 95 of 100 requests, no hedge
    else A is slow
        Note over C: 12 ms pass, no answer
        C->>B: same read
        B-->>C: value at 17 ms
        C-)A: cancel
        Note over C: A would have answered at 400 ms
    end
```

Walk the first diagram. The client sends to one replica and starts a timer. The delay is not a guess: you read it from your own latency histogram, so it fires for only the slowest few percent of requests. When it fires, the second copy goes to a different replica, and the first answer to arrive is returned. Cancelling the other stops the server doing work nobody will read, which only helps if the server can actually drop queued or running work.

The sequence shows the cost. Every hedge is one extra request, so the hedge delay is also a load dial: at p95 you add about 5 percent, at p50 you would add 50.

Fan-out makes the tail worse. A page that gathers answers from 100 servers is as slow as the slowest of them, so if each server is slow 1 time in 100, about 63 of 100 pages wait on at least one slow server (the arithmetic is from Dean and Barroso's "The Tail at Scale", 2013).

## Variations
<!--meta block=variations-->

- **Delayed hedge** — Wait for a high percentile of normal latency, then send the second copy. It adds a few percent of load and gets most of the gain. The version in the paper's Bigtable measurement sent the second request after 10 ms and cut the 99.9th percentile of a 1,000-key read from 1,800 ms to 74 ms for about 2 percent more requests.
- **Tied requests** — Send to two replicas at once, each told about the other, and have the replica that starts work first cancel the other copy. It removes the wait for the timer and cuts most duplicate work: the peer's copy is dropped if still queued, but both can run if they start within one network delay of each other. It needs servers that can cancel a peer's queued copy.
- **Immediate duplicate** — Send both copies at the same moment and take the first answer. Latency is lowest and load doubles, so it fits only small, critical reads.
- **Budgeted hedging** — Allow hedges only while a [token bucket](./token-bucket.md) has tokens, so the extra load has a hard ceiling whatever the latency does.
- **Backup tasks for stragglers** — A batch job starts a second copy of the last few unfinished tasks on other machines. [MapReduce](../coordination/mapreduce.md) did this to stop one slow machine holding a whole job open. It is the same idea at task level, with a longer time scale.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Cuts the slowest answers sharply** — the second copy has to be slow as well, so with independent slowness the tail drops from about 1 in 100 to about 1 in 10,000.
- **Pays only for the slow few** — a delay at the 95th percentile adds about 5 percent of requests, not a full second copy of all traffic.
- **Works when nothing is broken** — a replica that is slow for a moment throws no error, so a [circuit breaker](./circuit-breaker.md) never trips, and hedging still helps.
- **Needs no knowledge of the cause** — pauses, compactions and noisy neighbours all look the same to a timer.

### Cons
<!--meta polarity=con-->

- **Adds load exactly when load hurts** — if the backend is already near full, extra copies make it slower, so cap hedges with a budget and stop hedging when the backend reports it is saturated.
- **Duplicates side effects** — a hedged write can run twice, so hedge only reads and operations that are [idempotent](../../messaging/idempotency.md).
- **Does nothing for correlated slowness** — a slow shared database or a slow query is slow on every replica, so the second copy waits as long as the first.
- **Needs working cancellation** — without it the losing copy runs to the end, and the duplicate work stays, so pass a cancel signal through and test that servers honour it.
- **Multiplies copies across tiers** — a fan-out tier whose backends also hedge sends many more requests than either would alone, so hedge at one tier or share one budget down the call chain.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A read can go to any of several replicas** — a key-value store, a search shard or a cache fleet where every copy holds the same data.
- **Your p99 is many times your median** — the slow slice comes from pauses and noise, not from the work itself.
- **One response gathers many answers** — fan-out makes the slowest server the one that matters, so the tail dominates the page.

### Avoid when
<!--meta polarity=avoid-->

- **The request changes state** — a duplicate write is a bug unless the call is made safe to repeat, so use [idempotency](../../messaging/idempotency.md) first, or do not hedge.
- **The backend is already overloaded** — extra copies deepen the overload, so refuse early with [load shedding](./load-shedding.md) instead.
- **Identical requests arrive together** — many callers asking for the same key need to share one call, which is [request coalescing](./request-coalescing.md), the opposite move.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — send to the first replica, hedge to another after a delay, return the first answer and cancel the rest"
async function hedged<T>(
  replicas: string[],
  call: (replica: string, signal: AbortSignal) => Promise<T>,
  hedgeDelayMs: number,                      // set to a measured p95, not a guess
): Promise<T> {
  const aborts: AbortController[] = [];
  const attempt = (replica: string) => {
    const ac = new AbortController();
    aborts.push(ac);
    return call(replica, ac.signal);
  };

  const primary = attempt(replicas[0]);
  const secondary = new Promise<T>((resolve, reject) => {
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      // a replica other than replicas[0]; skip hedging if there is only one
      const other = replicas.find((r) => r !== replicas[0]);
      if (other === undefined) { primary.then(resolve, reject); return; }
      // gate: spend a budget token before sending; no token, no copy
      attempt(other).then(resolve, reject);
    };
    const timer = setTimeout(fire, hedgeDelayMs);          // slow: hedge at the delay
    primary.then(
      () => clearTimeout(timer),                           // fast: no copy is sent
      () => { clearTimeout(timer); fire(); },              // failed early: hedge now
    );
  });

  try {
    return await Promise.any([primary, secondary]);        // first answer wins
  } finally {
    aborts.forEach((a) => a.abort());                      // cancel whoever is left
  }
}
```

## In the wild
<!--meta block=wild-->

- **The Tail at Scale (Dean and Barroso, 2013)** — The Communications of the ACM paper that named hedged and tied requests. Its Bigtable measurement is under Delayed hedge above. {#wild-tail-at-scale}
- **gRPC hedging policy** — The service config can set a hedging policy with `maxAttempts` (capped at 5), `hedgingDelay` and `nonFatalStatusCodes`: later attempts go out after the delay without waiting for a failure. A non-fatal status lets the other attempts continue; any other status or the first OK response ends the call and cancels the rest. Retry throttling applies to hedges too. {#wild-grpc-hedging}
- **Apache Cassandra speculative retry** — A per-table `speculative_retry` option makes the coordinator send a read to another replica when the first is slower than a set percentile or time, which is a delayed hedge. {#wild-cassandra}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **hedge delay** — the wait before the second copy goes out, a high percentile of measured latency (the sketch uses p95; the Bigtable run used 10 ms); lower cuts more tail and adds more load. Measure it on first-attempt latency only, not on the hedged result, or the delay drifts down as hedging improves the tail
- **maximum attempts** — how many copies may be in flight for one request; each extra copy adds load for a smaller gain
- **hedge budget** — a cap on the share of requests allowed to hedge, often a token bucket refilled per request, so the extra load has a ceiling; size it just above the share of requests slower than the delay percentile (about 5 percent at p95; the Bigtable run added about 2 percent)
- **eligible operations** — which calls may hedge; reads and idempotent calls only
- **replica choice** — the copy goes to a different replica, not one on the first one's host or zone; skip hedging when no other replica is healthy

### Signals to watch
<!--meta polarity=signal-->

- **hedge rate** — the share of requests that sent a second copy; it should sit near the share above the delay percentile
- **hedge win rate** — how often the second copy answered first; a low rate means the extra load is buying nothing
- **tail latency** — p99 and p99.9 with and without hedging, so the gain is measured
- **backend request rate** — total requests reaching the replicas, which rises with every hedge

### Failure modes under load
<!--meta polarity=failure-->

- **overload amplification** — the backend slows under load, more requests pass the hedge delay, more copies are sent and the backend slows further
- **correlated slowness** — every replica is slow for one shared reason, so most requests pass the hedge delay and load approaches double with no gain in latency
- **cancel not honoured** — the losing copy runs to the end, so the duplicate work stays and capacity is wasted
- **stale delay** — the hedge delay was set once, the latency profile moved, and the policy now hedges nearly everything or nothing

### Readiness checklist
<!--meta polarity=check-->

- Hedge only reads and idempotent calls
- Set the hedge delay from a measured percentile and review it as latency shifts
- Cap hedges with a budget and turn them off when the backend is saturated
- Check that servers drop cancelled work
- Compare tail latency and backend load before and after

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Resilience](../../../themes/resilience.md) — Answers lateness where retries only answer failure, at the price of a few percent extra load {#fluency-resilience}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Timeout / Deadline](./timeout-deadline.md) — A deadline caps the total wait, and the hedge delay sits well inside it.
- [Token Bucket](./token-bucket.md) — A token bucket can cap the share of requests allowed to hedge.

**Alternative to**

- [Retry with Backoff](./retry-backoff.md) — Hedging handles a call that is late; it does not wait for a failure first.

**Requires**

- [Idempotency](../../messaging/idempotency.md) — A copy sent twice is safe only if the call can be repeated with the same effect.

**Often confused with**

- [Request Coalescing](./request-coalescing.md) — Hedging duplicates one request on purpose to dodge a slow replica.

**Prevents**

- [Head-of-Line Blocking](../../../hazards/head-of-line-blocking.md) — A copy on another replica means a caller no longer waits behind one slow lane.
- [Metastable Failure](../../../hazards/metastable-failure.md) — Used with a budget it adds little load, and without one it can sustain an overload.

<!-- relationships:end -->
