---
title: Scatter-Gather
description: "Broadcasts a request, then merges the responses"
area: messaging
owner: Oleksandr Derechei
tags: [messaging, latency]
status: stable
aliases: [fan-out/fan-in]
solves: [I call five providers one after another and the request takes ten seconds, every backend I add makes my endpoint another second slower, I want the cheapest quote but must ask every provider and some never answer, one slow participant hangs the whole comparison and there is no way to move on without it, my caller should not have to know there are eight services behind this one call]
favourite: true
---

# Scatter-Gather

Broadcasts one request to a set of recipients in parallel, then waits for their replies and merges whatever comes back into a single, unified response.

## What it is
<!--meta block=description-->

Scatter-gather sends one request to several recipients at the same moment, collects the replies as they arrive and combines them into one answer. The caller makes one call and gets one reply. It turns a sum of delays into a maximum when the answer lives in several places, such as quotes from five carriers.

## Explained
<!--meta block=explain-->

Scatter-gather sends one request to several recipients at the same moment, collects the replies as they arrive and combines them into one answer for the caller. It turns a sum of delays into a maximum: asking five carriers one after another takes five waits, asking them together takes one, for the slowest. Choose it when the answer lives in several places and asking one by one would multiply the delay by their number.

- **Load multiplier.** Every call multiplies load by the recipient count, even if you keep one reply. Size for that rate and cap the fan-out.
- **Slowest sets the pace.** Set a deadline and combine what has arrived. Give late replies a place to go instead of dropping them silently.
- **Correlation.** Replies come back out of order, so each carries a correlation id, a token naming the request it answers.
- **Missing replies.** Decide and write down what silence means: dropping an unanswered quote is fine, reading an unanswered sanctions check as clean is not.

**Example.** You want shipping quotes from 5 carriers that answer in 200, 250, 400, 600 and 1,800 ms. One after another that is 3,250 ms. Asked together and waiting for all, it is 1,800 ms. With an 800 ms deadline you answer at 800 ms using 4 quotes. The cost is load: at 20 quotes a second you make 100 carrier calls a second. The slow carrier replies after the deadline has passed, and if its quote was the cheapest, the customer misses the best price, so you log late replies and watch how often that happens.

## How it works
<!--meta block=structure-->

```mermaid caption="How do three carrier quotes cost one wait instead of three? Step 2 leaves together, so step 4 happens when the slowest reply lands or the deadline does, whichever comes first."
flowchart LR
    Req["Caller"]
    subgraph SG["One request in, one merged reply out"]
        Sc["Scatter"]
        Ga["Gather — closes on the deadline"]
    end
    A["Carrier A"]:::ext
    B["Carrier B"]:::ext
    C["Carrier C"]:::ext
    Req -->|"1 one quote request"| Sc
    Sc -->|"2 same question to all, at once"| A
    Sc -->|"2"| B
    Sc -->|"2"| C
    A -->|"3 reply, carrying the correlation id"| Ga
    B -->|"3"| Ga
    C -->|"3"| Ga
    Ga -->|"4 merge into one answer"| Req
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Auction** — Every recipient answers the same question — a price, a bid, a route — and gather keeps only the winning reply, discarding the rest.
- **Distribution** — The request is partitioned so each recipient handles distinct work; gather reassembles the pieces into one complete result rather than picking a winner.
- **Static vs. dynamic [recipient list](./recipient-list.md)** — Recipients are a fixed, known set, or resolved at runtime from a directory or service registry — trading simplicity for the ability to add participants without redeploying.
- **[Correlation Identifier](./correlation-identifier.md)** — Each reply carries the id of the request that produced it, so gather can match interleaved replies back to the right in-flight scatter.
- **Timeout / quorum gather** — Rather than block for every reply, gather closes after a deadline or once a minimum count has arrived, treating stragglers as absent instead of stalling the whole exchange.
- **Recipient-list vs. broadcast dispatch** — The EIP (Enterprise Integration Patterns) book splits the pattern by dispatch: Distribution sends to a recipient list the router controls, Auction broadcasts on a [publish-subscribe](./pubsub.md) channel. Either dispatch can feed either gather. This page's Auction and Distribution name the gather instead.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Parallelizes the fan-out**, so overall latency isn't the sum of every recipient's response time.
- **Surfaces the best or most complete answer** by consulting several sources instead of trusting one.
- **Keeps the caller's contract simple** — one request, one merged reply — no matter how many recipients answered.
- **Tolerant of partial failure** when gather doesn't require every recipient to respond.

### Cons
<!--meta polarity=con-->

- **Latency is still bounded** by the slowest recipient or by the gather timeout. The deadline turns an unbounded wait into a known one, so it is required.
- **Aggregation must handle partial, duplicate and out-of-order replies** — the [correlation identifier](./correlation-identifier.md) on each reply matches it to its request, and duplicates need a per-recipient dedupe.
- **Every call multiplies load N-fold across recipients** and network, even when only one reply is kept — size the recipients for the amplified rate, and cap the fan-out breadth rather than discovering the cap in an incident.
- **Needs correlation, timeout, and partial-failure handling** — real machinery, not a plain request/reply.
- **Missing replies are a domain decision** — A missing reply has no default meaning; the domain decides. Dropping an unanswered price quote is fine, reading an unanswered sanctions check as clean is not. Write the choice beside the timeout.
- **Stragglers arrive after the aggregate** has closed, for a request that no longer exists — give a late reply a defined destination, because the alternative is a silent drop nobody counts.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several sources could answer**, and you want the best, fastest, or most complete reply.
- **A large piece of work can be partitioned** and processed by recipients in parallel, then recombined.
- **Caller needs a simple contract** — the caller must keep a simple one-request/one-response contract regardless of how many parties respond.

### Avoid when
<!--meta polarity=avoid-->

- **One authoritative source already has the answer** — querying several adds cost without benefit.
- **Recipients must respond in a strict order**, or the merge needs transactional consistency across replies.
- **The volume or cost of broadcasting** to every recipient outweighs whatever the best reply is worth.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — ask everyone at once, then combine"
async function cheapestQuote(parcel: Parcel, carriers: Carrier[]) {
  // scatter: every carrier is asked in the same tick, not one after another
  const asked = carriers.map((carrier) => carrier.quote(parcel));

  // gather: wait once, for the slowest, instead of once per carrier
  // toy: one failed carrier rejects the whole call and nothing bounds the wait; the next sketch adds a deadline and drops failed legs
  const quotes = await Promise.all(asked);

  return quotes.reduce((best, q) => (q.price < best.price ? q : best));
}
```

```typescript summary="TypeScript — screening one persona against every sanctions list"
interface LegResult { list: string; hit: boolean; }

async function screen(
  flowId: string,
  personaId: string,
  lists: string[],          // one leg per sanctions list
  timeoutMs = 5_000,
) {
  const withTimeout = (p: Promise<LegResult>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    // a vendor error counts as a missing leg, not a failed gather
    // a reply after the deadline is dropped here; a real gather counts it
    return Promise.race([p.catch(() => null), deadline])
      .finally(() => clearTimeout(timer));
  };

  // scatter: every list is dispatched at once, all carrying the same flowId
  const scattered = lists.map((list) =>
    withTimeout(sanctionsVendor.check({ flowId, personaId, list })));

  // gather: one collector, waiting for every slot to settle (reply or timeout)
  const legs = await Promise.all(scattered);

  // A missing leg is not a clear one — an unanswered list decides nothing,
  // so the flow stays in screening for a sweeper to retry.
  if (legs.some((leg) => leg === null)) return;

  const hits = legs.filter((leg) => leg!.hit).map((leg) => leg!.list);
  await flows.transition(flowId, hits.length ? "rejected" : "cleared",
    hits.length ? `list_hit:${hits.join(",")}` : "all_lists_clear");
}
```

## In the wild
<!--meta block=wild-->

- **Elasticsearch** — A coordinating node scatters each search to every relevant shard in parallel, gathers the top hits from each, and merges them into one ranked result set; the two-phase query-then-fetch design is Scatter-Gather over shards. {#wild-elasticsearch}
- **Apollo Federation** — The gateway compiles one client query into a query plan against the owning subgraphs: independent fetches run in parallel, dependent ones in sequence, and the gateway stitches the partial responses into a single result by entity keys. {#wild-apollo-federation}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Gather timeout / deadline** — How long to wait for replies before closing the aggregate and treating late repliers (stragglers) as absent. Start just above the slowest healthy recipient's p99 and below the caller's own timeout.
- **Quorum / minimum reply count** — The number of replies that closes the gather early, instead of waiting for every recipient.
- **Fan-out breadth (recipient count)** — How many recipients each request is scattered to — it sets the load-amplification factor per call.
- **Correlation state time to live (TTL)** — How long the gather holds an in-flight aggregation before discarding it. Set it a little longer than the gather timeout, so the deadline closes the gather and the TTL only reaps orphans.
- **Missing-reply semantics** — What the aggregate does with an absent recipient: omit it, substitute a default, or fail the whole exchange. A domain decision, not a default.

### Signals to watch
<!--meta polarity=signal-->

- **Reply completeness** — Replies received divided by recipients scattered to, before the deadline; a falling ratio means recipients are timing out. Alert when it drops below the quorum fraction or falls against its own baseline.
- **End-to-end gather latency (p99)** — Bounded by the slowest reply or the timeout, whichever comes first — so it tells you which of the two is binding.
- **Timeout / straggler rate** — How often the gather closes on the deadline instead of on full completion.
- **In-flight aggregation count** — Open scatters awaiting replies; a climbing count signals orphaned or stuck aggregations.
- **Per-recipient reply latency** — The distribution across recipients, not just the aggregate — this is what names the one participant setting your tail.

### Failure modes under load
<!--meta polarity=failure-->

- **Slowest recipient dominates** — Tail latency of the whole exchange tracks the slowest responder up to the gather timeout, so when the gather waits for every reply one degraded participant sets the p99 for every call; a deadline or quorum caps it.
- **Orphaned aggregations** — Replies that never arrive leave gather state open, leaking memory unless a correlation TTL expires it.
- **Late reply after close** — A straggler answers after the aggregate was already sent, arriving for a request that no longer exists. Count late replies: the straggler rate shows how often the best quote is lost.
- **Load amplification** — Every call multiplies N-fold across recipients; a request burst arrives at all of them simultaneously, so they saturate together rather than one at a time.
- **Absence read as an answer** — A gather that closes on a deadline and treats a missing reply as an empty or negative result reports a conclusion nobody computed.

### Readiness checklist
<!--meta polarity=check-->

- The gather has a hard timeout, and the meaning of a missing reply is written down beside it rather than implied by the code
- Every reply carries a correlation id matched to its in-flight request
- In-flight aggregation state is bounded and expires, verified by running the case where a recipient never answers
- Duplicate and late replies have a defined destination and are counted, not dropped silently
- Recipients are sized for the amplified request rate, not for the caller's rate
- Fan-out breadth has a cap, so a recipient list that grows at runtime cannot multiply load without a limit

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Ask several parties at the same time and combine their answers into one. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Correlation Identifier](./correlation-identifier.md) — Correlate responses back to the request
- [Pagination](../distributed/routing/pagination.md) — A paged query across partitions is the everyday case: fan out, merge on the sort key, keep only the page
- [Recipient List](./recipient-list.md) — Its distribution form sends to a recipient list rather than broadcasting
- [Timeout / Deadline](../distributed/resilience/timeout-deadline.md) — The gather step needs a deadline, or one slow recipient holds the caller open.
- [Fan-In](./fan-in.md) — Its gather half is a fan-in; this page names the convergence topology.

**Composed of**

- [Splitter](./splitter.md) — Scatter fans out, gather aggregates
- [Aggregator](./aggregator.md) — The gather step is an aggregator
- [Fan-Out](./fan-out.md) — The broadcast half sends one request to every recipient at the same moment

**Often confused with**

- [MapReduce](../distributed/coordination/mapreduce.md) — Scatter/gather fans a request to responders; map-reduce grinds a whole dataset
- [Fork-Join](../concurrency/fork-join.md) — Sends one request to many services over a network and collects the replies

**Exposed to**

- [Synchronous I/O](../../hazards/synchronous-io.md) — Can fall into synchronous io when the gather step ties up a thread per outstanding branch while it waits for replies

**Demonstrated by**

- [Top-K](../../designs/top-k.md) — an exact global ranking is assembled from independent per-shard results, since a global winner must be a winner on its own shard
- [Gopuff](../../designs/gopuff.md) — the union-across-nearby-data centers (DCs) read is a textbook scatter to many partitions gathered into a single response
- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — a sanctions screening fanned across several lists, with one collector deciding Clear or Sanctioned only when all legs are in
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — a fan-in whose tally is round-scoped, and whose legs carry a third outcome so an unreachable participant still terminates
- [Uber](../../designs/uber.md) — Scatter-gather as the rare exception cost of sharding by region

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that sends a request to several parties and collects the replies as a ready-made building block.

<!-- relationships:end -->
