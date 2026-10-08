---
title: Leaky Bucket
description: "A bounded queue drained at one fixed rate: bursts become waiting, the output never spikes, and a full queue refuses"
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, backpressure, throughput]
status: stable
aliases: [traffic shaper, leaky bucket as a queue]
solves: [a batch job sends 500 calls in one second and the partner API rejects almost all of them, the legacy system we call breaks on spikes and can only take a fixed number per second, "I need outgoing traffic to leave at an exact steady rate, not in bursts", a burst of requests should wait in line for a short time instead of being refused]
---

# Leaky Bucket

Put arrivals in a bounded queue and drain it at one fixed rate, so a downstream system sees a steady stream whatever the burst, and a full queue turns the excess into a refusal.

## What it is
<!--meta block=description-->

A partner API takes 10 calls a second and refuses the rest, so a batch job that fires 500 calls at once is rejected although its average rate was legal. A leaky bucket is a bounded queue that drains at one fixed rate. Bursts become waiting, and an arrival that finds the queue full is refused. The cost is latency for requests at the back.

## Explained
<!--meta block=explain-->

A leaky bucket holds arrivals in a bounded queue and releases them at one fixed rate, so whatever sits downstream sees a steady stream and never a spike. Arrivals join the queue at any speed. A drain takes one item out every 1/r seconds. If the queue is full when an arrival comes, that arrival is refused. The drain rate sets the exact output rate, and the queue size sets how big a burst you absorb. Choose it over a [token bucket](token-bucket.md) (which lets a burst through at once and holds only the average) when the target cannot take a burst at all, such as a partner API with a hard ceiling.

- **Burst delay.** The last queued request waits capacity divided by rate, so size the queue from the longest wait callers accept.
- **Stale work.** If callers give up sooner than the wait, the drain serves requests nobody wants, so keep the wait under their timeout.
- **Per-copy buckets.** A bucket in each copy of a service multiplies the rate, so share one bucket.

**Example.** A partner API allows 10 calls a second. Your bucket drains 10 a second and holds 20. A batch job sends 50 calls at once. 20 enter the queue and 30 are refused straight away, so the job can back off. The queue empties over 2 seconds, and the 20th call waits 2 seconds. On an ideal drain the partner sees 10 calls a second and refuses none; set r a little under its ceiling to absorb timer jitter. A token bucket with the same numbers would have let 20 through in the first instant, and the partner would have refused the extra 10. The cost here is the 2 second wait.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a burst become a steady stream? Arrivals reach the bucket at 1; if there is room each joins the queue at 2, and if the queue is full it is refused at 3; a drain releases exactly one item every 1/r seconds at 4, so the downstream sees a constant rate."
flowchart LR
    Caller["Callers"]
    Rej["Refused: 429 or drop"]
    subgraph LB["Leaky bucket — one rate"]
        Q[("Bounded queue, capacity C")]
        Drain["Drain: one item per 1/r s"]
    end
    Down["Downstream system"]
    Caller -->|"1 arrive, any rate"| Q
    Q -->|"2 room: wait in line"| Drain
    Caller -.->|"3 full: refused"| Rej
    Drain -->|"4 release at fixed rate"| Down
```

```mermaid caption="What does a burst do to latency? 50 requests arrive at once at 10 a second with room for 20, so 20 are queued, 30 are refused, the 20th queued request waits 2 s, and the downstream never sees more than 10 in any second."
sequenceDiagram
    autonumber
    participant C as Callers
    participant B as Bucket (r = 10/s, C = 20)
    participant D as Downstream
    C->>B: 50 requests in one instant
    Note over B: 20 enter the queue
    B-->>C: 30 refused at once
    loop every 100 ms
        B->>D: release one request
    end
    Note over B,D: queue empty after 2 s, request 20 waited 2 s
```

Read the first diagram as two decisions. The first is at the door: a full queue refuses, and that refusal is cheap and immediate, so the caller learns early and can back off. The second is at the drain: it ignores how many are waiting and releases at the configured rate, so the output is flat.

The bucket also bounds the delay. A request that enters waits at most capacity C divided by drain rate r, so with C = 20 and r = 10 the worst wait is 2 seconds. Choose the capacity from the longest wait your callers will accept, not from how much memory you have.

## Variations
<!--meta block=variations-->

- **Queue form (a shaper)** — Arrivals wait in a real queue and leave at the fixed rate. Output is perfectly smooth and bursts become latency. This is the form used to pace traffic out of a router or a client, and it is the one this page describes. It differs from queue-based load leveling in one way you will feel in an incident: a leveling queue holds work until a consumer is free and has no rate limit of its own, while a leaky bucket sets the rate and refuses when it is full.
- **Meter form** — Keep a counter that rises with each arrival and drains at the fixed rate, and refuse an arrival that would push it over the limit. Nothing is queued, so nothing is delayed. With the same rate and a bucket size equal to the meter's limit it admits what a [token bucket](./token-bucket.md) would admit. Pick it when you want a verdict, not a queue.
- **Delay or refuse** — Choose what the full bucket does: refuse the newest arrival (the usual), drop the oldest so fresh work wins, or make the caller wait. Dropping the oldest suits data where only the latest value matters.
- **Per-key buckets** — One bucket per client or per tenant, so one noisy caller fills its own queue and not everyone else's. This costs a bucket per key, which a cache with an expiry keeps bounded.
- **Outbound pacing** — Put the bucket on the client side in front of a partner API, with the partner's published rate as r. You stay under their limit without waiting to be refused. The same shape protects a legacy database that cannot take a spike, or a text message (SMS) gateway that suspends senders who exceed their rate.
- **Shared bucket** — Keep the queue and drain in one place so a whole fleet shares one rate. A bucket in each copy of a service multiplies the rate by the number of copies.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Output is exactly steady** — the downstream sees r per second however the arrivals bunch, so a target with a hard ceiling is never spiked.
- **Waiting time has a ceiling** — C divided by r bounds how long anything sits in the queue, so you can promise a worst-case delay, provided the drain keeps running; a stalled timer breaks the bound, so alarm on output rate.
- **Memory is bounded** — the queue holds at most C items, so a flood cannot grow it without limit.
- **Small and cheap to build** — one queue and one timer, with no per-request accounting beyond the queue itself.

### Cons
<!--meta polarity=con-->

- **Delays a burst even when the downstream is idle** — a harmless spike still waits in line, so use a [token bucket](./token-bucket.md) when the target can take bursts.
- **Latency is the price of smoothness** — the last request in a full queue waits C divided by r, so size C from the longest wait callers accept and refuse beyond it.
- **Stale work wastes the drain** — if callers time out sooner than the queue waits, the drain serves requests nobody is waiting for, so keep the worst wait under the caller timeout or drop the oldest.
- **One rate hides who is spending it** — a single noisy client fills the queue for everyone, so use a bucket per key and a global one behind it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A downstream has a hard rate ceiling** — a partner API, an SMS gateway or a legacy system that rejects or breaks on a spike.
- **You need a flat outgoing stream** — a batch job that must write to a store at 100 rows a second, not 10,000 in one second.
- **Callers can wait a bounded time** — a delay of a second or two is better for them than a refusal.

### Avoid when
<!--meta polarity=avoid-->

- **Bursts are fine downstream** — a [token bucket](./token-bucket.md) lets them through at once and keeps only the average, so callers are not made to wait.
- **Callers need an answer now** — waiting in a queue is itself a failure, so refuse early with [load shedding](./load-shedding.md).
- **The work must survive a crash** — an in-process bucket loses its queue when the process dies, so use a durable queue with [load leveling](./load-leveling.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the queue form: a bounded queue, one timer that drains it at a fixed rate, and a refusal when it is full"
class LeakyBucket {
  private queue: Array<{ release: () => void; reject: (e: Error) => void; at: number }> = [];
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private capacity: number,        // C: most items allowed to wait
    ratePerSec: number,              // r: the exact output rate
    private maxWaitMs: number,       // the caller timeout: older entries are skipped
  ) {
    // One timer, one release per tick: the output never bursts.
    // Valid for r up to a few hundred per second; above that, release several
    // items per tick. Ticks drift under load. An idle arrival waits up to one tick, 1/r.
    this.timer = setInterval(() => {
      let next = this.queue.shift();
      while (next && Date.now() - next.at > this.maxWaitMs) {
        next.reject(new Error("waited too long: skipped"));   // stale work wastes no slot
        next = this.queue.shift();
      }
      next?.release();
    }, 1000 / ratePerSec);
  }

  stop() { clearInterval(this.timer); }

  // Resolves when it is this call's turn; rejects at once if the bucket is full.
  submit(): Promise<void> {
    if (this.queue.length >= this.capacity) {
      // overflow knob: refuse newest here; drop-oldest would shift the queue head instead
      return Promise.reject(new Error("bucket full: refuse and tell the caller"));
    }
    return new Promise((release, reject) =>
      this.queue.push({ release, reject, at: Date.now() }));
  }
}

// Usage: a partner API that allows 10 calls a second, with a worst wait of 2 s.
const bucket = new LeakyBucket(20, 10, 2000);
async function callPartner() {
  await bucket.submit();             // waits its turn
  return fetch("https://partner.example/api");
}
```

## In the wild
<!--meta block=wild-->

- **NGINX limit_req** — The `ngx_http_limit_req_module` documents that it uses the leaky bucket method: `rate` sets the drain and `burst` sets the queue. Without `nodelay`, excess requests are delayed to the rate (the queue form). With `nodelay`, burst requests pass at once while slots free at the rate (the meter form). Past the burst, requests are refused, with 503 by default (`limit_req_status`). {#wild-nginx-limit-req}
- **ATM traffic control (generic cell rate algorithm)** — ATM networks policed traffic with the generic cell rate algorithm, which is specified as a continuous-state leaky bucket in its meter form. {#wild-atm-gcra}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **drain rate** — the exact output rate; set it at or below the downstream ceiling, with room for other callers of the same target
- **queue capacity** — how many items may wait; the worst wait is capacity divided by rate, so size it from the longest delay callers accept
- **overflow policy** — what a full bucket does: refuse the newest, drop the oldest, or block the caller; blocking moves the queue to the callers, so bound it with a timeout or the memory cap no longer holds
- **key scope** — one bucket per client or tenant, or one for everyone; per-key stops a noisy caller filling a shared queue
- **max age** — the drain discards items that waited past the caller timeout and releases the next one

### Signals to watch
<!--meta polarity=signal-->

- **queue depth** — how full the bucket is; a depth that stays near capacity means arrivals exceed the drain
- **time in queue** — how long items wait before release, against the caller's timeout
- **refusal rate** — the share of arrivals turned away because the bucket was full
- **output rate** — the measured release rate against the configured one, which shows a stalled or drifting drain

### Failure modes under load
<!--meta polarity=failure-->

- **stale queue** — callers time out before their turn, so the drain spends its capacity on requests nobody is waiting for and live requests wait behind them
- **stalled drain** — a blocked timer or a paused process stops all output while arrivals keep filling the queue
- **multiplied rate** — each copy of the service runs its own bucket, so the downstream receives the configured rate times the number of copies
- **lost queue** — an in-memory queue disappears when the process restarts, and every waiting item goes with it
- **shared store down** — a bucket shared across copies needs a fail-open or fail-closed choice: open lets the downstream take a spike, closed refuses every caller

### Readiness checklist
<!--meta polarity=check-->

- Set the drain rate from the downstream ceiling, not from what you wish to send
- Size the queue so the worst wait stays under the caller's timeout
- Return a clear refusal, such as 429 with a retry-after header set to queue depth divided by drain rate, rounded up, with jitter so refused callers do not retry in step, when the bucket is full
- Share one bucket across all copies that call the same target: run the drain in one worker all copies enqueue to, or give each of n copies a rate of r divided by n as a fallback
- Test a burst of several times the capacity and check the downstream rate stays flat
- Decide fail open or fail closed for a shared bucket before an outage forces it

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Handling Spikes](../../../themes/spike-handling.md) — The strict twin of the token bucket: bursts become waiting, so a fragile target never sees a spike {#fluency-spike-handling}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Rate Limiter](./rate-limiter.md) — It is one algorithm a limiter can run, with delay in place of refusal.
- [Backpressure](../../concurrency/backpressure.md) — A full bucket refuses, which tells the sender to slow down.

**Alternative to**

- [Token Bucket](./token-bucket.md) — It never lets a burst through, where the token bucket permits one up to its size.

**Variant of**

- [Queue-Based Load Leveling](./load-leveling.md) — It is a leveling queue with a fixed drain rate and a refusal when full.

**Often confused with**

- [Load Shedding](./load-shedding.md) — It delays a burst up to the queue size, then refuses the rest.

**Prevents**

- [Unbounded Queue](../../../hazards/unbounded-queue.md) — A queue capped at C items refuses when full, so the backlog cannot grow without limit.

**Implemented by**

- [Networking](../../../capabilities/networking.md) — NGINX limit_req smooths bursts into a steady rate, which is this pattern as configuration.

<!-- relationships:end -->
