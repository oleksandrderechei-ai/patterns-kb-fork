---
title: Aggregator
description: Combines many related messages back into one
area: messaging
owner: Oleksandr Derechei
tags: [messaging, state-management, batching]
status: stable
solves: [I get one event per line item but I cannot do anything until the whole order has arrived, I fired off five requests and now I have to work out when all the replies are in, every consumer keeps its own half-broken bookkeeping of which pieces showed up, one missing fragment means my collector waits forever and holds state it never frees, downstream gets a pile of fragments it has to stitch back together itself]
---

# Aggregator

Collects a stream of related messages that arrive independently over time and combines them into one complete message once every piece — or a deadline — has arrived.

## What it is
<!--meta block=description-->

An **aggregator** collects related messages that arrive separately and sends one combined message once the set is complete. Without it, every consumer repeats the same bookkeeping: hold state, watch for the rest, decide when to act. It matches messages by a [correlation identifier](./correlation-identifier.md), folds their payloads with an aggregation strategy, and releases on a completeness condition such as a count or a deadline. Its hardest part is knowing when to stop waiting.

## Explained
<!--meta block=explain-->

An aggregator collects related messages that arrive one at a time, holds them until the set is complete, and sends one combined message on. Related messages share a [correlation id](./correlation-identifier.md) (a key that every message in the set carries), and a rule says when the set is complete: a count, a deadline, or both. Choose it when fragments arrive independently, such as one reply per recipient, and every consumer would otherwise write the same waiting and tallying. Skip it when each message stands alone, because the collector adds delay and stored state for nothing.

- **Endless wait.** A lost fragment stalls the set, so set a deadline and send the partial result marked incomplete, or drop it.
- **Lost state.** Partial sets sit in memory, so store them durably or a crash loses them.
- **Double counting.** A repeated fragment can count twice, so record each fragment id and ignore repeats.

**Example.** A checkout asks 4 warehouses whether they hold an item. The aggregator groups replies by order id, expects 4 and has a 500 ms deadline. Warehouse A answers at 40 ms, B at 90 ms, B again at 95 ms because it retried, and C at 300 ms. D is down. A count of messages alone reaches 4 at 300 ms and emits a result that lacks D. Counting distinct warehouses holds at 3, and at 500 ms the aggregator sends 3 of 4 replies marked incomplete. With no deadline it would hold that order in memory forever.

## How it works
<!--meta block=structure-->

```mermaid caption="When does the aggregator stop waiting? Only at step 4 — the count is reached or the deadline fires. A group whose condition can never be met loops between steps 3 and 4a and keeps its entry in the store, which is why the deadline is not optional."
flowchart LR
    Frag["Fragment channel"]:::ext
    Agg["Aggregator"]
    subgraph Hold["Held until complete: count reached or deadline passed"]
        Store[("Correlation store, one entry per group")]
        Check{"Complete?"}
    end
    Out["One aggregated message"]
    Down["Downstream consumer"]:::ext
    Frag -->|"1 message, correlation 42"| Agg
    Agg -->|"2 fold into the partial result"| Store
    Store -->|"3 test the condition"| Check
    Check -->|"4a no, keep waiting"| Store
    Check -->|"4b yes, or the timeout fires"| Out
    Out -->|"5 release and discard the state"| Down
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Count-based completeness** — Release once a known number of related messages has arrived — simplest when the set size is fixed or announced up front.
- **Timeout-based completeness** — Release whatever has accumulated once a deadline passes, so one missing or late fragment can't block the aggregate forever.
- **Best-effort aggregation** — Combine on timeout even when incomplete, marking the missing pieces rather than discarding a partial result outright.
- **First-reply completeness** — Release on the first, fastest answer to arrive and discard the rest — the trade to make when latency beats coverage, as in a bidding round or a race across redundant providers. The aggregate then reflects one respondent instead of the field, and a participant that is always last vanishes from the result without anyone noticing.
- **Externally signalled completeness** — A control message or a business milestone — the trading day closing, the order being submitted — declares the group done, rather than a count or a clock. Use it when the end of the set is known upstream and not here, and keep a timeout underneath: a signal that never arrives holds the aggregate open indefinitely.
- **[Scatter-Gather](./scatter-gather.md)** — Broadcast a request to several recipients and aggregate their replies into one — the aggregator is the gather half of that round trip.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Collapses a stream of related messages** into one coherent result the rest of the system can consume simply.
- **Correlation id decouples producers** — none of them needs to know about the others or about the aggregation itself.
- **Timeout-based completeness** — keeps a slow or missing fragment from blocking the set; a count alone does not, and reordering is left to the aggregation strategy.
- **Centralizes reconstruction logic in one place instead** of duplicating it in every downstream consumer.

### Cons
<!--meta polarity=con-->

- **Needs a durable correlation store** — a crash mid-aggregation drops partial state when the store is in memory, so use a durable store when that loss is unacceptable.
- **Choosing completeness is a real design problem**: too strict waits forever, too loose emits partial data as if it were whole.
- **Adds latency** — nothing downstream sees anything until the last piece, or the timeout, arrives.
- **Duplicate or out-of-order inputs complicate** the aggregation strategy and must be handled explicitly.
- **Group affinity** — all fragments of one key must reach one worker, so scale-out needs partitioning by correlation id, and a hot key becomes a bottleneck.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple independently-arriving messages share a correlation id** and only make sense combined — line items, partial responses, sharded events.
- **Downstream consumers want a single** coherent message per business event, not N fragments to reconcile themselves.
- **You're gathering replies from a fan-out** and need one result from the set — the classic Scatter-Gather round trip.

### Avoid when
<!--meta polarity=avoid-->

- **Messages don't share a natural, stable key** to correlate on — there is nothing to group them by.
- **Each message must be processed independently and immediately**; waiting for the rest of the set defeats that.
- **The transformation needed is stateless**, one message in and one message out — a plain translation step is enough, with no collector required.
- **You only need ordering, not combining** — use the [Resequencer](./resequencer.md) instead.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal count-based aggregator"
interface CorrelatedMessage<T> {
  correlationId: string;
  payload: T;
}

class Aggregator<T, R> {
  private groups = new Map<string, T[]>();

  constructor(
    private readonly expectedSize: number,
    private readonly combine: (parts: T[]) => R,
    private readonly onComplete: (result: R) => void,
  ) {}

  add(msg: CorrelatedMessage<T>): void {
    const parts = this.groups.get(msg.correlationId) ?? [];
    parts.push(msg.payload);
    this.groups.set(msg.correlationId, parts);

    if (parts.length >= this.expectedSize) {
      this.groups.delete(msg.correlationId); // release and forget; no dedupe, no deadline: a repeat counts twice, an incomplete group stays in memory
      this.onComplete(this.combine(parts));
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **Apache Camel aggregate()** — The aggregate() enterprise integration pattern (EIP) takes a correlation expression, an AggregationStrategy, and a completion condition — completionSize, completionTimeout, completionPredicate, or completionInterval. An optional AggregationRepository (Java Database Connectivity (JDBC), Infinispan, LevelDB) persists open groups so a restart does not lose them. {#wild-apache-camel-aggregate}
- **Spring Integration Aggregator** — Groups messages by correlation key in a MessageStore and releases the combined message when its ReleaseStrategy is satisfied; a group-timeout forces release of a partial group so one missing message cannot hold it open indefinitely. {#wild-spring-integration-aggregator}
- **Kafka Streams** — Windowed aggregations group records by key and fold them with an initializer and aggregator. By default a window emits an updated result for each record; `Suppressed.untilWindowCloses` emits one final result once the window closes after its grace period (how long to wait for late records). A record later than that is dropped and does not reopen the window. {#wild-kafka-streams}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Completion condition** — What triggers release of a group — a message count, a predicate over the accumulated set, or a periodic interval (Camel completionSize / completionPredicate / completionInterval, Spring release strategy).
- **Completion timeout** — A deadline after which an incomplete group is released anyway, so one lost or slow fragment cannot hold it open forever (Camel completionTimeout, Spring group-timeout). Start a little above the p99 gap between a group's first and last fragment, then tune it from the timeout-vs-completion ratio.
- **Correlation expression** — The key expression that decides which messages belong to the same group — the join key on which all bookkeeping hangs.
- **Aggregation store** — Where open groups are held: an in-memory map, or a durable repository (Camel AggregationRepository backed by JDBC/Infinispan, Spring MessageStore) that survives a process restart.
- **Open-group bound** — A ceiling on how many correlation groups may be in flight at once, so an unbounded stream of keys that never complete cannot exhaust memory — enforced by the store's capacity or an eviction/timeout policy rather than one dedicated switch. At the ceiling pick one action: release the oldest group as partial, dead-letter it, or slow the source. Size the ceiling as peak new keys per second times the timeout.

### Signals to watch
<!--meta polarity=signal-->

- **Open correlation groups** — Count of incomplete sets currently held in the store — a direct proxy for aggregation-state memory.
- **Age of oldest open group** — How long the longest-waiting set has been incomplete; a rising floor means fragments are being lost or delayed.
- **Timeout vs. completion releases** — Ratio of aggregates released on the deadline (incomplete) versus on the completion condition (whole) — a shift toward timeouts signals missing fragments; alert when timeout releases rise above a baseline from a healthy week or after a deploy. A timeout set too tight for current load gives the same shift.

### Failure modes under load
<!--meta polarity=failure-->

- **Group that never completes** — A correlation key missing one fragment, with no completion timeout, holds its partial state indefinitely and leaks memory.
- **Partial state lost on restart** — An in-memory store drops every open group when the process restarts; fragments already consumed from the source channel are gone for good.
- **Late fragment after release** — A message arriving after its group already released either opens a spurious new single-item group or is silently discarded.
- **Timeout too tight** — Under load, fragments that are merely slow miss the deadline and the aggregator emits incomplete sets as if they were whole.
- **Duplicate fragment counted twice** — At-least-once input redelivers a fragment; a count-based group counts it twice, completes early and releases an incomplete set as whole. Dedupe by fragment id inside the group.

### Readiness checklist
<!--meta polarity=check-->

- Set a completion timeout so a single lost fragment cannot hold a group open forever.
- Use a durable aggregation store if losing partial groups on restart is unacceptable.
- Decide and implement behaviour for fragments that arrive after their group has completed.
- Bound or alert on the number of concurrent open correlation groups to cap memory.
- Emit whether each aggregate was released by its completion condition or by timeout.
- Acknowledge each fragment to the source only after its store write commits; test by killing the process mid-group.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Collect related messages and release one combined message when the set is complete. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Splitter](./splitter.md) — Split out, process, then recombine
- [Sliding Window](../distributed/coordination/sliding-window.md) — A window is the commonest way to decide an aggregate is complete enough to release
- [Idempotency](./idempotency.md) — A redelivered fragment must not count twice, so each fragment id is recorded.

**Requires**

- [Correlation Identifier](./correlation-identifier.md) — Related fragments are matched into one set by the correlation id every message in it carries

**Part of**

- [Scatter-Gather](./scatter-gather.md) — The gather step is an aggregator

**Often confused with**

- [Fan-In](./fan-in.md) — An aggregator does the combining at a fan-in's convergence point
- [Resequencer](./resequencer.md) — Combines related messages into one, where a resequencer only reorders and keeps each message

**Demonstrated by**

- [Metrics & Monitoring](../../designs/metrics-monitoring.md) — gathering related alerts within a time window and combining them is the aggregator preventing an alert storm

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that combines related messages into one as a ready-made building block.

<!-- relationships:end -->
