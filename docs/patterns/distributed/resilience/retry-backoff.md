---
title: Retry with Backoff
description: Retries transient failures with a growing delay
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, latency, error-handling]
status: stable
aliases: [exponential backoff, backoff]
solves: [the same request fails once and then works fine when i just run it again, a one-second network blip turns into a failed job and an alert at 3am, all my clients hammer the server at the exact same instant after it hiccups, the api keeps returning 429 and my code just gives up immediately, transient errors reach users even though nothing is actually broken]
favourite: true
---

# Retry with Backoff

Waits progressively longer between attempts — usually with a dash of randomness — so a fleeting failure gets a chance to clear instead of being hammered by an instant retry.

## What it is
<!--meta block=description-->

A call fails for a reason that passes in a moment, such as a dropped packet or a busy server. Running it again works, but retrying at once from every failed client at the same instant knocks over a dependency that was only stumbling. Retry with backoff waits before each retry and waits longer each time, with random jitter, so the retries spread out.

## Explained
<!--meta block=explain-->

Retry with backoff runs a failed call again after a wait, and makes the wait longer after each failure. Many brief failures pass within a second, so a retry fixes them without bothering the caller. When many clients fail together, retrying at once is worse than not retrying: they all come back at the same moment. So the wait doubles each time, stops growing at a ceiling, and gets random jitter, which gives each client a slightly different delay. Retry only failures that can pass, such as a timeout or a 503, and give each attempt its own [timeout](timeout-deadline.md) so a hung attempt cannot stall the loop. Return a bad request to the caller at once, because waiting will not change the answer. Choose it over failing straight away when the failure is brief and you can afford slower answers.

- **Doubled writes.** A retried write can run twice if the success reply was lost, so send a key the server uses to ignore repeats.
- **Multiplied layers.** Retries at several layers multiply, so let one layer own retrying.
- **Load in outages.** Cap attempts, bound the loop by the caller's deadline and add a circuit breaker.

**Example.** A service restarts and 1,000 clients fail at the same instant. Each waits 200 ms, 400 ms, then 800 ms between tries. Without jitter, 1,000 calls hit the server at 0.2 s, 1,000 more at 0.6 s and 1,000 more at 1.4 s, three spikes as large as the first. With jitter, each client picks a random wait up to its limit, so the first retries spread over 200 ms, about 5 calls per millisecond instead of 1,000 at once. The cost is slower failure: a caller whose server stays down waits up to 1.4 s before it gives up, and 3 layers that each try 3 times send 27 calls for one request.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a call survive a blip without adding to the pile-up? Every transient failure goes back through the growing delay, and only an exhausted budget leaves the loop."
flowchart LR
    Caller["Your service"]
    subgraph Loop["One attempt budget"]
        Try["Attempt"]
        Wait["Wait base × 2^attempt, jittered"]
    end
    Dep["Remote dependency"]:::ext
    DLQ[("Dead-letter channel")]
    Caller -->|"1 call"| Try
    Try -->|"2 invoke, bounded by a timeout"| Dep
    Dep -->|"3 transient error"| Wait
    Wait -->|"4 try again after the delay"| Try
    Try -->|"5 result, or a permanent error"| Caller
    Try -->|"6 attempts exhausted"| DLQ
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Each failed attempt waits longer than the last before retrying. Jitter keeps many clients from retrying in lockstep; exhausted attempts propagate the error."
flowchart TB
    A["Attempt the call"] -->|"invoke"| B{"Succeeded?"}
    B -->|"yes"| E["Return result"]
    B -->|"no, transient"| C{"Attempts left?"}
    C -->|"yes"| D["Wait backoff delay, with jitter"]
    D -->|"retry"| A
    C -->|"no"| F["Give up, propagate error"]
```

## Variations
<!--meta block=variations-->

- **Fixed delay** — Retry after the same interval every time. Simplest to reason about, and the only variant that never eases off as the failure persists.
- **Exponential backoff** — Each retry's wait multiplies the last, usually doubling, capped at a maximum delay so the curve doesn't grow unbounded on a long outage.
- **Jittered backoff** — Randomize the delay around the backoff curve — full jitter, equal jitter, or decorrelated jitter — so clients that failed at the same instant don't all retry at the same instant too.
- **Retry budgets** — Cap total retry volume as a share of overall traffic, independent of any single caller's attempt count, so retry volume stays bounded to a fixed share of traffic, not a multiple of it.
- **Server-directed timing** — Honour a delay the server hands back — a Retry-After header or a protocol-level pushback signal — and let it win over the locally computed wait. The overloaded side knows when it wants traffic back; doubling your own curve against its advice retries on the wrong schedule.
- **Declarative retry** — The curve is configuration on the step, not a loop in the handler. A Step Functions retrier declares the matched errors, first interval, attempt cap, multiplier, interval ceiling and jitter. The wait also moves off your process, which suits a durable step.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Resolves transient blips automatically**, without surfacing an error to the caller, within the attempt cap and deadline.
- **Spaces out load over time**, giving a struggling dependency room to recover instead of adding to the pile-up.
- **Jitter desynchronizes clients** so a shared outage doesn't turn into a synchronized [retry storm](../../../hazards/retry-storm.md).
- **Drops into any call site** for reads and idempotent calls; a retried write also needs the callee to honour a dedup key.

### Cons
<!--meta polarity=con-->

- **Only helps with transient failures** — retrying a permanent error just delays it and wastes time.
- **Unbounded or un-jittered retries amplify load** exactly when the dependency has least to spare — cap the attempts, jitter the curve, and trip a [circuit breaker](./circuit-breaker.md) once the failure stops being transient.
- **Requires idempotent operations**, or a retried write duplicates its effect the moment a success response goes missing — carry a dedup key on anything the loop can repeat.
- **Adds latency variance** — the failure path gets slower, and less predictably so, with every attempt, so bound the whole loop with the caller's deadline and not just each attempt.
- **Retries nested at client, gateway and mesh multiply** — three tiers of three attempts is 27 calls for one request. Pick the tier that owns retry, turn it off in the others, and record which one it is.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The failure is plausibly transient** — network blips, brief overload, lock contention, rate limiting.
- **Operation is safe to repeat** — it is [idempotent](../../messaging/idempotency.md), or safe to retry via a dedup key.
- **You control the client** and can afford some extra latency on the failure path.

### Avoid when
<!--meta polarity=avoid-->

- **The failure is permanent** — a bad request, an auth failure, a missing resource — retrying just delays the error.
- **The write isn't idempotent** and there's no dedup mechanism to make a repeat safe.
- **The dependency is visibly down for a while** — pair with a [Circuit Breaker](./circuit-breaker.md) so retries stop adding to the pile-up.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the smallest retry loop that works, waiting in this process"
const MAX_ATTEMPTS = 5, BASE_MS = 200, MAX_MS = 30_000;

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function withRetry<T>(call: () => Promise<T>, deadline: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();                       // the call carries its own timeout
    } catch (err) {
      const lastTry = attempt + 1 >= MAX_ATTEMPTS;
      if (lastTry || !isTransient(err)) throw err;   // permanent: fail now, not later
      const backoff = Math.min(MAX_MS, BASE_MS * 2 ** attempt);
      const wait = Math.random() * backoff;      // full jitter: only the upper bound grows
      if (Date.now() + wait > deadline) throw err; // the caller's deadline bounds the loop
      await sleep(wait);
    }
  }
}

await withRetry(() => verifyDocument(personaId, deadline), deadline);
// isTransient: timeout, 429, 503 retry; 400, 401, 404 fail now
```

```typescript summary="TypeScript — backoff with full jitter, written to a queue column"
const MAX_ATTEMPTS = 5, BASE_MS = 200, MAX_MS = 15 * 60_000;
// The delay is a column, not a sleep. The worker hands the row back and moves
// on; whichever replica claims it after run_after is the one that retries.
function nextRunAfter(attempts: number): Date {
  const backoff = Math.min(MAX_MS, BASE_MS * 2 ** attempts);
  return new Date(Date.now() + Math.random() * backoff); // full jitter
}

async function runTask(db: Db, task: Task): Promise<void> {
  try {
    await execute(task);          // call idVendor, or deliver the client webhook
    await db.query(`UPDATE task SET status = 'done' WHERE id = $1`, [task.id]);
  } catch (err) {
    const attempts = task.attempts + 1;
    if (!isTransient(err)) {
      return void await db.query(`UPDATE task SET status = 'dead', attempts = $2 WHERE id = $1`,
        [task.id, attempts]);
    }
    // Transient: back to pending with a later run_after. Once attempts are
    // exhausted it simply stops being claimed, and the sweeper escalates it.
    await db.query(
      `UPDATE task SET status = 'pending', locked_at = NULL, attempts = $2, run_after = $3
        WHERE id = $1`, [task.id, attempts, nextRunAfter(attempts)]);
  }
}

// Claiming honours the schedule — a backed-off task is not yet visible at all.
const claim = `SELECT * FROM task WHERE status = 'pending' AND run_after <= now()
                AND attempts < ${MAX_ATTEMPTS} ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1`;
// isTransient: NetworkError, RateLimitError, or VendorUnavailable (breaker open — ask again later)
```

## In the wild
<!--meta block=wild-->

- **AWS SDK** — The retry curve is configuration, not code: retry_mode picks standard, the default, which retries transient and throttling errors with exponential backoff and jitter bounded by max_attempts (3 by default). Its retry quota is a token bucket charged per retry and refunded on success, so sustained failure drains it and the client fails fast instead of adding load to a service already struggling. Adaptive mode adds a client-side rate limiter that can delay even the initial request once the service signals throttling — useful against one hot resource, harmful on a client that fans out across many. {#wild-aws-sdk}
- **p-retry** — The Node wrapper for the same curve as options rather than a loop: retries (10 by default), factor (2), minTimeout (1 s), maxTimeout (unbounded) and randomize for jitter. A shouldRetry predicate and an AbortError stop the loop immediately on an error that will never succeed — the non-transient case backoff must never paper over. {#wild-p-retry}
- **gRPC** — Service config declares a retryPolicy with maxAttempts, initialBackoff, maxBackoff, backoffMultiplier, and the set of retryable status codes, applied by the client library — plus channel-level retry throttling (a token bucket) that disables retries when failures dominate, guarding against storms. {#wild-grpc}
- **Kubernetes** — The kubelet restarts a crashing container on an exponential back-off that doubles each failure up to a five-minute cap, surfaced as the CrashLoopBackOff state until a start succeeds. {#wild-kubernetes}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Max attempts** — How many tries a call gets before the caller is told it failed — the hard end of the curve. The sketch starts at 5 attempts, a 200 ms base and a 30 s cap; size the total so it fits the caller's deadline.
- **Base delay and multiplier** — The first wait and its growth factor (base × 2^attempt) — the shape of the curve.
- **Max delay ceiling** — A cap on the per-attempt wait, so the exponential does not run away during a long outage.
- **Jitter strategy** — Full, equal or decorrelated jitter — how much randomness is mixed into each delay.
- **Retryable classification** — Which errors count as transient (timeouts, 429, 503) and which fail straight through (400, 401, 404).
- **Retry budget** — A fleet-wide cap on retries as a share of total traffic, independent of any one caller's attempt count. Set the share from the retry rate seen on a healthy day plus headroom; a token bucket, as in the AWS SDK and gRPC entries, enforces it.

### Signals to watch
<!--meta polarity=signal-->

- **Retry rate** — Retries as a fraction of total requests, per dependency — the extra load the retry layer is adding right now.
- **Success-after-retry rate** — The share of retried calls that eventually succeed. A low share means the failures were never transient.
- **Attempt distribution** — How deep into the budget calls are going. A shift from attempt 1 to attempt 3 is the dependency degrading before it fails.
- **Failure-path latency** — The p99 of calls that exhaust the curve — what a user waits for an error.
- **Server pushback rate** — How often the callee returns 429 or Retry-After, and whether your schedule respects the delay it asks for.

### Failure modes under load
<!--meta polarity=failure-->

- **Retry storm** — Un-jittered retries return in lockstep and pile onto a dependency at the worst moment, so the blip is sustained by the retries themselves.
- **Cross-layer amplification** — Retries nested at client, gateway and mesh multiply, so a few attempts each becomes tens of calls for one request.
- **Non-idempotent duplication** — A success response lost in transit looks like a failure, so the retry repeats an effect that already happened — a second charge, a second email.
- **Budget burnt on permanent errors** — Every attempt spent on a 4xx that will never succeed is an attempt the transient failures do not get.
- **Retrying past the caller's deadline** — The client gave up mid-curve, so the remaining attempts do work nobody is waiting for — pure load with no possible payoff.

### Readiness checklist
<!--meta polarity=check-->

- Every operation the loop can repeat carries a dedup key or is provably idempotent, verified by replaying a call whose success response was dropped
- The retryable error set was checked against the errors this dependency actually returns, not the HTTP defaults
- Exactly one tier retries this call and the others are configured off, written down where the next team will find it
- A load test with the dependency made slow, not switched off, shows retry volume staying inside the budget
- Retry rate and success-after-retry are exported per dependency, with an alert on retries climbing while successes do not
- Exhausted retries land somewhere a person sees — a dead-letter channel or an escalation — rather than a log line
- The caller's remaining deadline is checked before each attempt, so no attempt starts that cannot finish in time

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Resilience](../../../themes/resilience.md) — Ride out transient failures, so a blip that clears on its own never reaches the caller as an error. {#fluency-resilience}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Circuit Breaker](./circuit-breaker.md) — Retry transient errors; trip the breaker on sustained ones
- [Dead Letter Channel](../../messaging/dead-letter-channel.md) — Exhausted retries go to the dead-letter channel
- [Scheduling](../../concurrency/scheduling.md) — Backoff needs a scheduler to fire the retry at the right time
- [Compensating Transaction](./compensating-transaction.md) — Retries drive compensations to completion; they must be idempotent
- [Service Mesh](../routing/service-mesh.md) — A mesh applies retries uniformly without touching service code
- [Load Shedding](./load-shedding.md) — Honour the Retry-After on a shed request, or the rejection becomes a retry storm
- [Design for Self-Healing](../../../principles/self-healing.md) — Retry is the cheapest healing there is, right up until it is unbounded
- [Fault Injection](./fault-injection.md) — Backoff and jitter settings are only confirmed by a fault that triggers them

**Alternative to**

- [Hedged Request](./hedged-request.md) — A retry waits for a failure, which never comes when a replica is only slow.

**Requires**

- [Idempotency](../../messaging/idempotency.md) — Safe retries require idempotent operations
- [Timeout / Deadline](./timeout-deadline.md) — Retrying a call that may hang needs a bound on each attempt, then the back off

**Prevents**

- [Retry Storm](../../../hazards/retry-storm.md) — Backoff without jitter still returns the whole crowd together
- [Poison Message](../../../hazards/poison-message.md) — A retry limit is what keeps a permanent failure from becoming a poison message.
- [Metastable Failure](../../../hazards/metastable-failure.md) — Bounded, jittered retries stop a failure from multiplying into a sustained overload.

**Exposed to**

- [Cascading Failure](../../../hazards/cascading-failure.md) — Can fall into cascading failure when retries add load to an already saturated dependency
- [Thundering Herd](../../../hazards/thundering-herd.md) — Can fall into thundering herd when clients that fail together retry together unless the delay is jittered

**Demonstrated by**

- [Web Crawler](../../../designs/web-crawler.md) — transient fetch failures are retried with growing delays instead of hammering a struggling origin
- [Payment System](../../../designs/payment-system.md) — unreliable server-to-server delivery is a textbook case for capped exponential retry
- [Job Scheduler](../../../designs/job-scheduler.md) — transient job failures are absorbed by spacing retries out exponentially instead of hammering
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — backing off vendor calls and webhook delivery attempts in a persona-verification saga before giving up to a dead-letter queue (DLQ)
- [Gopuff](../../../designs/gopuff.md) — bounding the replay is what stops contention on a promoted item becoming a retry storm
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — backoff with jitter argued from the recovery it belongs to, where the alternative is a synchronised stampede at the end of a six-hour outage

**Implemented by**

- [Networking](../../../capabilities/networking.md) — A mesh sets retries per route in configuration, so no service carries its own retry loop.

<!-- relationships:end -->
