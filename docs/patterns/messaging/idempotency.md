---
title: Idempotency
description: The same request applied twice has the same effect as once
area: messaging
owner: Oleksandr Derechei
tags: [resilience, error-handling]
status: stable
aliases: [idempotent receiver, idempotency key]
solves: [a customer got charged twice because the request timed out and they clicked again, my consumer picked up the same message after a crash and sent the confirmation email twice, I do not know whether the first attempt went through so I am scared to retry anything, double-clicking submit creates two orders and support has to clean it up by hand, replaying the queue after the outage duplicated every side effect downstream]
favourite: true
---

# Idempotency

The same request, retried once or replayed a hundred times over, lands exactly once in effect — so a timeout, a redelivered message, or a double-click can never double the outcome.

## What it is
<!--meta block=description-->

An operation is **idempotent** when applying it many times has the same effect as applying it once. A caller that times out cannot tell whether the work happened, and most networks and brokers deliver at least once, so retries are certain. A read is safe for free. A write needs an idempotency key that lets the server recognise and discard duplicates, or a rewrite into a repeatable form, such as set balance to 100.

## Explained
<!--meta block=explain-->

An operation is idempotent when running it twice has the same effect as running it once. You make a write safe to repeat by sending a unique key with each logical request: the server does the work the first time it sees the key, stores the result, and returns that stored result for every repeat. This matters because a caller whose request times out cannot tell whether the work happened, and most networks and brokers deliver at least once, so repeats are certain. Choose a key over rewriting the operation to be naturally repeatable (set the balance to 100, not add 10) when the operation cannot be reshaped, such as charging a card.

- **Two writes.** The key and the effect can strand one on a crash, so commit both in one transaction.
- **Racing duplicates.** Two can both pass a read-then-write check, so claim the key atomically, such as with a unique constraint.
- **Key store growth.** Expire entries after longer than your longest redelivery and alert on its size.

**Example.** A warehouse consumer reads message m-310, reserve 2 units of SKU 7. It reserves, crashes before acknowledging, and the broker redelivers. Without a check, stock drops by 4. With a table of processed message ids, the reservation and the insert of m-310 commit in one transaction, so the second try hits the unique constraint and is skipped: stock drops by 2. The cost is the table. At 5,000 messages a day, keeping ids for 7 days, since the broker redelivers for at most 4, holds 35,000 rows, and an expiry job must trim it.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a retry after a timeout avoid charging the card twice? The key is claimed at step 2 before any money moves, and step 6 still finds it from a different instance because the store is shared rather than local."
flowchart LR
    Client["Client"]
    subgraph Fleet["Any instance, one shared store"]
        A1["API instance"]
        A2["API instance"]
    end
    Keys[("Key → result store")]
    Card["Card network"]:::ext
    Client -->|"1 pay, carrying a key"| A1
    A1 -->|"2 claim the key atomically"| Keys
    A1 -->|"3 charge, only if the claim was new"| Card
    A1 -->|"4 file the answer against the key"| Keys
    Client -->|"5 retry, same key"| A2
    A2 -->|"6 find the key, replay the answer"| Keys
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="A key identifies one logical request. The first arrival executes and records the result; every later arrival with the same key just replays it."
flowchart TB
    Req["Request arrives with an idempotency key"] -->|"look up key"| Check{"Key seen before"}
    Check -->|"Yes"| Stored["Return the stored result, skip re-execution"]
    Check -->|"No"| Exec["Execute the operation once"]
    Exec -->|"persist result"| Save["Atomically store key with its result"]
    Save -->|"reply"| Return["Return the result"]
```

## Variations
<!--meta block=variations-->

- **Idempotency key** — The client generates a token for one logical operation and sends it on every attempt; the server persists key → result and returns the stored result on repeats.
- **Natural idempotency** — Design the operation so repetition is harmless by construction — `PUT` that sets absolute state, or a `DELETE` where removing an already-absent thing is a no-op. It is the same contract HTTP already gives: `GET`, `HEAD`, `PUT`, and `DELETE` are idempotent by the spec (RFC 9110), while `POST` and `PATCH` are not — which is exactly why write APIs bolt an explicit key onto those two.
- **Bounded dedup window** — Keep the key → result mapping only for a TTL (time to live), not forever, trading unlimited storage growth for a small risk of accepting a very late duplicate as new.
- **[Idempotent consumer](../distributed/coordination/inbox.md)** — A message consumer tracks processed message IDs instead of trusting the broker's delivery guarantee, so redelivery after a crash or rebalance never reprocesses an event.
- **Request fingerprinting** — Persist a hash of the request payload alongside the key. A repeat carrying the same key but a different body is a client mistake, not a genuine retry, so reject it (a `409`/`422`) instead of silently replaying the first result — catching an accidentally reused key before it returns the wrong answer.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Makes retries genuinely safe** — clients can retry blindly on timeout instead of guessing.
- **Removes duplicate side effects** from redelivered messages, replays, and double-clicks.
- **Underpins recovery techniques like Saga compensation** and outbox replay that depend on re-running steps.
- **Shrinks the failure surface**: "did it work?" no longer needs a special out-of-band check.

### Cons
<!--meta polarity=con-->

- **A key/result store is another piece of infrastructure** — schema, storage, and cleanup to maintain.
- **Turning a naturally non-idempotent operation** (an increment, a "send once" email) into an idempotent one is real design work, not a flag to flip.
- **A dedup window trades off storage against risk**: too short and late duplicates slip through, too long and the store grows unbounded — size it from the longest redelivery you have actually measured, and alert on the store's growth rather than trusting the expiry fired.
- **Two duplicate requests racing before** the first completes can still double-execute — make claiming the key and recording the result one atomic step (a unique constraint, a conditional put), never a read followed by a write.
- **The key and the effect are two writes**, so a crash between them leaves a key with nothing behind it, or an effect no key will ever match — commit both in one transaction where the store allows it, and reconcile where it does not.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Clients or infrastructure may retry the same request** — timeouts, network blips, ambiguous failures.
- **The operation has a real-world** cost if it runs twice: a payment, an order, a provisioning call.
- **Consumers read from a queue or broker** whose delivery guarantee is at-least-once, not exactly-once.

### Avoid when
<!--meta polarity=avoid-->

- **The operation is already naturally idempotent** — a plain read, or a write that only ever sets an absolute value.
- **Duplicates are cheap and harmless** — a non-critical analytics ping, a log line.
- **You'd be adding a key/result** store purely out of caution, with no retry path that could ever trigger a duplicate.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — one key per payment, the first answer replayed to every retry"
// The caller sends the SAME key on every attempt of one logical payment.
async function pay(key: string, amount: number): Promise<Receipt> {
  // One atomic step: claim the key, or discover somebody already has.
  const claim = await store.claimIfNew(key);
  if (!claim.isNew) return claim.result;   // a repeat — hand back the first answer

  const receipt = await charge(amount);
  await store.saveResult(key, receipt);    // now every later copy finds this
  return receipt;
}
```

```typescript summary="TypeScript — deduping a redelivered vendor callback"
interface StoredResult { status: number; body: unknown; }

class IdempotencyStore {
  // A Map stands in for the real backing store. In production this must be a
  // shared, durable store (Redis, DynamoDB) with a TTL — a process-local Map
  // is not seen by other instances and is lost on restart, so duplicates slip through.
  private results = new Map<string, StoredResult>();

  async execute(key: string, handler: () => Promise<StoredResult>): Promise<StoredResult> {
    const cached = this.results.get(key);
    if (cached) return cached; // duplicate — skip re-execution

    // The check-and-record step must be atomic (unique constraint, conditional
    // put) so two concurrent duplicates can't both slip past the cache miss.
    const result = await handler();
    this.results.set(key, result);
    return result;
  }
}

// One boundary of four in a KYC flow, each keyed by whichever side can see the
// duplicate: client key on create, vendor request id on callback (below), task
// row id on a re-claimed lease, event id on a redelivered webhook.
const store = new IdempotencyStore();
const { flowId, providerRequestId, verdict } = parseCallback(req);
const key = `idVendor:${flowId}:${providerRequestId}`;
const result = await store.execute(key, () => applyVerification(flowId, verdict));
res.status(result.status).json(result.body);
```

## In the wild
<!--meta block=wild-->

- **Stripe API** — Accepts an Idempotency-Key header on POST requests, stores the result of the first call, and replays the same response for any retry carrying the same key instead of charging a card twice. Reusing a key with different request parameters returns an error rather than a stale replay, and keys are retained for 24 hours, after which the same key is treated as new. {#wild-stripe}
- **HTTP methods (RFC 9110)** — Defines GET, HEAD, PUT, DELETE, OPTIONS, and TRACE as idempotent so intermediaries and clients may safely repeat them after a failed response; POST and PATCH are deliberately excluded, which is why write APIs bolt on an explicit idempotency key. {#wild-http}
- **Kafka idempotent producer** — With enable.idempotence=true, each batch is tagged with a producer id and a per-partition monotonic sequence number, so the broker discards duplicates from producer retries and preserves order within a single producer session. {#wild-kafka-idempotent-producer}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Dedup window / key TTL** — How long the key-to-result mapping is retained before it expires — must cover the maximum retry or redelivery window, traded against unbounded store growth.
- **Key scope / granularity** — What one idempotency key spans — one logical operation. A client-supplied key is not globally unique, so compose the stored key from tenant/user + endpoint/path + the client token, so keys cannot collide across users or endpoints and retries of the same operation always match.
- **Atomicity mechanism** — The check-and-record primitive that makes the dedup safe: a unique constraint, a conditional put, or a compare-and-set, so two concurrent duplicates cannot both pass the cache-miss check.
- **Store durability** — Where the key-to-result mapping lives and how durable it is. It must be a shared, distributed store — a process-local one does not survive multiple instances or a restart. Losing it reopens the door to duplicate side effects on the next retry.

### Signals to watch
<!--meta polarity=signal-->

- **Duplicate-hit rate** — How often an incoming request matches an already-stored key — the retries and redeliveries the mechanism is actually catching.
- **Dedup store size / growth** — Row or key count over time; unbounded growth points at a TTL that never fires or cleanup that is not running.
- **Concurrent-duplicate rate** — Requests bearing the same key that arrive before the first has recorded its result — the race the atomic check must win.
- **Check-and-record latency** — Time the dedup lookup and write add to every mutating request, since it sits on the critical path of each write.

### Failure modes under load
<!--meta polarity=failure-->

- **Non-atomic check-and-record** — If the read and the write are separate steps, two concurrent duplicates both see a cache miss and both execute — a double charge under load.
- **Process-local dedup store** — An in-memory key store behind a load balancer, or lost on restart, is not shared across instances, so a retry routed elsewhere sees no key and re-applies the side effect.
- **Key reused with a different payload** — Treating a reused key as a replay when the request body differs returns the wrong stored result; without a fingerprint check the mismatch goes unnoticed.
- **The window is the wrong size** — Set short, a retry arriving after the key expired is taken for a new request and the effect applies twice. Set long, or never cleaned, the key store grows until it becomes its own incident. Both directions surface first under the load that produced the retries.
- **Result recorded out of step with the operation** — Recording the key before the operation commits, or a crash between the two, can leave a stored key with no completed effect — or a completed effect with no key.

### Readiness checklist
<!--meta polarity=check-->

- Two duplicates were fired concurrently at a running instance, and exactly one effect landed — the race proven, not reasoned about.
- A retry was routed to a different instance, and to the same instance after a restart, and both found the key.
- Somebody has agreed what happens to a duplicate that arrives after the window — accepted risk, not a surprise discovered in an incident.
- Store the result with the key so a duplicate returns the original response instead of re-executing.
- Scope each key to one logical operation, keyed per tenant and endpoint, so distinct operations never collide.
- Validate a request fingerprint so a key reused with a different body is rejected, not replayed.
- Alert on dedup-store growth to catch a TTL or cleanup that stopped working.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [System Design Interview](../../themes/system-design-interview.md) — Make retried requests safe {#fluency-system-design-interview}
- [Resilience](../../themes/resilience.md) — Make retries and redelivery safe {#fluency-resilience}
- [API Design](../../themes/api-design.md) — Make retries safe so an ambiguous timeout can't double an effect {#fluency-api-design}
- [Dealing with Contention](../../themes/dealing-with-contention.md) — Make the retry safe so a duplicate write is harmless {#fluency-dealing-with-contention}
- [Multi-Step Processes](../../themes/multi-step-processes.md) — Make each step safe to retry {#fluency-multi-step-processes}
- [Long-Running Tasks](../../themes/long-running-tasks.md) — Make at-least-once redelivery safe {#fluency-long-running-tasks}
- [Microservices Design](../../themes/microservices-design.md) — Make a repeated call apply once {#fluency-microservices-design}
- [Workload Composition](../../themes/workload-composition.md) — The price of acknowledging work before doing it {#fluency-workload-composition}
- [Data Platform](../../themes/data-platform.md) — At-least-once delivery makes it mandatory, not optional {#fluency-data-platform}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Dead Letter Channel](./dead-letter-channel.md) — Dedupe redeliveries; divert true failures
- [Competing Consumers](./competing-consumers.md) — Parallel consumers must handle redelivery
- [Principle of Least Astonishment](../../principles/least-astonishment.md) — Repeating a call surprises nobody when the effect is identical
- [Timeout / Deadline](../distributed/resilience/timeout-deadline.md) — The unknown-outcome retry is exactly the repeat this pattern makes safe
- [Conditional Write](../distributed/coordination/conditional-write.md) — The atomic check-and-record is a conditional write: claim the key, or discover somebody already has
- [Asynchronous Request-Reply](../distributed/routing/async-request-reply.md) — The submit of a long-running operation is the classic place a key is required rather than advised
- [Minimize Coordination](../../principles/minimize-coordination.md) — Idempotency is what lets you stop coordinating over duplicates
- [Unique ID Generation](../distributed/coordination/unique-id-generation.md) — The key a consumer deduplicates on has to be generated somewhere, usually by the client
- [Command-Query Separation](../../principles/command-query-separation.md) — Queries are repeatable by construction, commands need their own guard.
- [Event-Carried State Transfer](./event-carried-state-transfer.md) — Version-checked upserts are idempotent handling of repeated state events.
- [Fencing Token](../distributed/coordination/fencing-token.md) — Where a resource can compare a token, fencing refuses the stale write that replay-safety would only absorb.

**Enables**

- [Retry with Backoff](../distributed/resilience/retry-backoff.md) — Safe retries require idempotent operations
- [Saga](../distributed/coordination/saga.md) — Steps and compensations must be replay-safe
- [Queue-Based Load Leveling](../distributed/resilience/load-leveling.md) — The queue that levels load redelivers; repeats must be harmless
- [Messaging & Eventing](../../capabilities/messaging.md) — The broker will not make duplicate delivery go away — this is the part you still owe.
- [Messaging Bridge](./messaging-bridge.md) — What the receiving side needs before anything relays messages to it
- [Outbox](../distributed/coordination/outbox.md) — Idempotent consumers are what make an outbox relay's repeats harmless
- [Inbox](../distributed/coordination/inbox.md) — Safe repeats are what let an inbox accept a resend after a crash
- [Compensating Transaction](../distributed/resilience/compensating-transaction.md) — Compensating steps are re-run until they land, which only works if repeats are harmless
- [Hedged Request](../distributed/resilience/hedged-request.md) — Hedging is one more reason an operation must be safe to run twice.

**Prevents**

- [Dual-Write Inconsistency](../../hazards/dual-write-inconsistency.md) — The counter-move for the duplicates every relay produces
- [Poison Message](../../hazards/poison-message.md) — Safe replay of dead letters depends on idempotent handling.

**Demonstrated by**

- [Ad Click Aggregator](../../designs/ad-click-aggregator.md) — an idempotency key enforced before the write is the whole defence against double-counting
- [Facebook News Feed](../../designs/fb-news-feed.md) — the design shows why at-least-once messaging forces idempotent handlers — a duplicated prepend can't corrupt a feed
- [WhatsApp](../../designs/whatsapp.md) — at-least-once delivery with client acks only stays correct because redelivery is idempotent
- [Facebook Live Comments](../../designs/fb-live-comments.md) — receiving a comment twice is a no-op, the idempotent-merge property that makes at-least-once delivery safe
- [Dropbox](../../designs/dropbox.md) — resume-after-failure only works because repeating a chunk operation converges rather than corrupting or duplicating
- [Ticketmaster](../../designs/ticketmaster.md) — a retried payment webhook is made safe by an idempotency key that folds duplicate deliveries into one effect
- [Robinhood](../../designs/robinhood.md) — the dedup key makes retries safe across a boundary that may already have acted on the first attempt
- [Payment System](../../designs/payment-system.md) — the double-charge-on-timeout scenario is the canonical motivation for idempotent writes
- [Job Scheduler](../../designs/job-scheduler.md) — correctness under retries depends entirely on making a repeated execution harmless
- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — deduping vendor callbacks and webhook retries in a persona-verification saga so a redelivered message never double-applies a result
- [Gopuff](../../designs/gopuff.md) — a rapid-delivery checkout replays its whole serializable transaction on abort, and the key is what makes the replay safe
- [YouTube](../../designs/youtube.md) — A video pipeline keyed on the upload event replays safely because the trigger is idempotent
- [Strava](../../designs/strava.md) — an offline-first client retries its sync freely because the append is deduped server-side by activity and point
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — a case study that prices the pattern's limit: at-least-once transport plus an idempotent effect is exactly-once in effect only where both ends are yours

<!-- relationships:end -->
