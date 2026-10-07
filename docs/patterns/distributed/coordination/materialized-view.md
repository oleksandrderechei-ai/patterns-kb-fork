---
title: Materialized View
description: Precomputes a query's result so reads don't recompute it
area: distributed-data
owner: Oleksandr Derechei
tags: [data-modeling, read-optimization]
status: stable
aliases: [matview, projection]
solves: [my dashboard takes thirty seconds to load because it re-runs the same huge aggregation every time, the same expensive join runs on every request even though the underlying rows barely change, reporting queries are hammering the production database and slowing down writes, counting rows on every page view is melting my database, "the data is stored the way we write it, not the way anyone actually queries it"]
---

# Materialized View

Precomputes an expensive query's result once and stores it as its own durable structure, so every read is a cheap lookup instead of a live recomputation from source data.

## What it is
<!--meta block=description-->

Some queries, such as sales by region, are costly to compute and read far more often than their data changes. A materialized view stores the query's result as its own table or index and refreshes it on a schedule, on demand or on change. Reads become cheap lookups of a ready answer. The price is staleness, and something must own the refresh.

## Explained
<!--meta block=explain-->

A materialized view stores the result of an expensive query as its own table or index, so reads fetch a ready answer instead of redoing a join or sum every time. You refresh it on a schedule, on demand, or when the source changes. Choose it over running the query live when computing the answer is the cost, the source changes far less often than readers ask, and a slightly old answer is fine. Do not use it when every read must show the latest write.

- **Staleness.** The view is only as fresh as its last refresh. Tell consumers its age and pick an interval the business accepts.
- **Silent drift.** Incremental refresh can diverge from the source. Compare with a full recompute now and then, and keep a rebuild path.
- **Refresh falls behind.** A refresh longer than its interval never catches up. Alert on duration against the interval.

**Example.** A dashboard shows sales by region, and the live query over 200 million orders takes 40 s. With 50 views a minute, that is 2,000 s of query work each minute, about 33 cores busy on the primary, one per query. You store the result in a 6-row table refreshed every 5 minutes. The refresh costs 40 s per 5 minutes, about 8 s of work a minute, and each view reads 6 rows in milliseconds. The cost is that sales can be up to 5 min 40 s old, interval plus refresh. If the data grows until the refresh takes 6 minutes, it never catches up, which is why you alert when duration nears the interval.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does the expensive join or aggregate get computed? On the refresh path at steps 2 and 3, never on the read at step 4 — so a read is a lookup and the source runs the query once per refresh, not once per read."
flowchart LR
    App["Write path"]
    subgraph SoT["Source of truth"]
        Src[("Source tables")]
    end
    Refresh["Refresh process"]
    MV[("Materialized view — computed")]
    Reader["Read path"]
    App -->|"1 insert / update rows"| Src
    Src -->|"2 change events or scheduled scan"| Refresh
    Refresh -->|"3 recompute or apply the delta"| MV
    Reader -->|"4 look up the shaped result"| MV
```

## Variations
<!--meta block=variations-->

- **Database-native materialized view** — Postgres, Oracle, and others support it as a first-class object. The engine gives the object and a refresh command, not a freshness guarantee: in Postgres you run `REFRESH MATERIALIZED VIEW` on your own schedule and track the lag yourself, while Oracle's `ON COMMIT` views and SQL Server's indexed views maintain themselves as the sources change.
- **Full vs. incremental refresh** — Recompute the whole view from scratch each time — simple and correct, but expensive at scale — or apply only the delta of changed source rows, which is faster but harder to get right.
- **[Event Sourcing](../../architecture/event-sourcing.md) projection** — The view is built or incrementally updated by folding an event stream, so it's just another subscriber to history rather than a snapshot of current state.
- **[Command query responsibility segregation (CQRS)](../../architecture/cqrs.md) read model** — The view is the query side of a write/read split — denormalized and shaped specifically for the queries callers actually make.
- **Push vs. pull refresh** — Writes push updates into the view synchronously as they happen, or a background job pulls source changes and recomputes on an interval.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Reads become cheap** — a direct lookup instead of a live join or aggregation.
- **Decouples the read shape from the write/storage shape**; the view is built for the query.
- **Shields the source-of-truth store from repeated**, expensive analytical queries.
- **Refresh cost is paid once per interval, not once per read**, so it wins only when reads outnumber refreshes.

### Cons
<!--meta polarity=con-->

- **The view can be stale**, lagging the source by the refresh interval or replication delay.
- **Another artifact to build**, store, and keep in sync — extra storage and refresh infrastructure.
- **Incremental refresh logic** is a real source of bugs: partial updates, ordering, replay.
- **Doesn't replace the source of truth** — you still need somewhere to rebuild the view from.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A query is read far** more often than the rows behind it actually change.
- **The read path needs a shape** — aggregated, joined, denormalized — that's expensive to compute live.
- **Results that are seconds-to-minutes stale are acceptable**, not strict real-time.

### Avoid when
<!--meta polarity=avoid-->

- **Reads must reflect every write** immediately and staleness isn't tolerable.
- **The underlying query is already cheap** — precomputing it only adds refresh overhead for no gain.
- **The read shape changes constantly**; a new view per query shape becomes its own maintenance burden.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an incrementally refreshed view"
// Materialized view: running totals per customer.
// Reads never touch the orders table or recompute a SUM.
class OrderTotalsView {
  private totals = new Map<string, number>();

  // Called for every committed order event — the "refresh" step.
  apply(event: OrderPlaced): void {
    const prior = this.totals.get(event.customerId) ?? 0;
    this.totals.set(event.customerId, prior + event.amountCents);
  }

  totalFor(customerId: string): number {
    return this.totals.get(customerId) ?? 0;
  }
}

interface OrderPlaced {
  customerId: string;
  amountCents: number;
}

// Full rebuild, e.g. after a schema change or a corrupted view.
// Builds a fresh view, so the corrupted one is discarded, not added to.
// apply() assumes exactly-once delivery: replaying an event double-counts.
async function rebuild(
  events: AsyncIterable<OrderPlaced>,
): Promise<OrderTotalsView> {
  const fresh = new OrderTotalsView();
  for await (const event of events) fresh.apply(event);
  return fresh;
}
```

## In the wild
<!--meta block=wild-->

- **PostgreSQL** — Supports materialized views as first-class objects, recomputed on demand with REFRESH MATERIALIZED VIEW; adding CONCURRENTLY keeps the view readable during the rebuild but requires a unique index on it to reconcile the two versions {#wild-postgresql}
- **ClickHouse** — Its materialized views are incremental — each insert into the source table feeds the aggregate as it arrives, so the view sees only rows written after it was created and is typically backed by an aggregating merge-tree engine that folds the partials on read {#wild-clickhouse}
- **Oracle Database** — Shipped the idea as snapshots decades ago, with query rewrite that silently redirects a query to a matching view; fast (incremental) refresh is driven by materialized view logs on the base tables, refreshed either on commit or on demand {#wild-oracle}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **refresh strategy** — full recompute versus incremental delta: full is simple and always correct but pays for the whole view each time, incremental applies only changed rows and is far cheaper at scale but much harder to keep correct
- **refresh cadence** — how often the view is recomputed: on a schedule, on demand, or on upstream change events. Staleness can reach interval plus refresh duration, so set the interval no longer than the staleness bound allows, and longer than the refresh takes.
- **refresh concurrency** — whether a refresh blocks readers or runs alongside them; a plain rebuild can take an exclusive lock, while a non-blocking mode (for example PostgreSQL's REFRESH MATERIALIZED VIEW CONCURRENTLY, which requires a unique index) keeps the old view readable until the new one is ready
- **staleness bound** — the maximum lag the read side is allowed to show behind the source — the freshness service-level agreement (SLA) that decides how aggressive the cadence has to be

### Signals to watch
<!--meta polarity=signal-->

- **view staleness** — time since the last successful refresh, or the replication lag feeding an incremental view — the single number that says how far behind the source a read may currently be
- **refresh duration** — how long a refresh takes to complete; it grows with the data volume, and once it approaches the cadence interval the view can no longer keep up
- **refresh failure rate** — how often a scheduled refresh errors or is skipped; a silently failing refresh leaves the view frozen while reads keep treating it as current
- **view storage size** — bytes the materialized result occupies — the standing cost of trading recompute for storage, and a number that grows with every new view shape

### Failure modes under load
<!--meta polarity=failure-->

- **refresh falls behind** — a refresh longer than its interval never catches up; runs queue or overlap, depending on engine and scheduler, and staleness grows without bound. Skip a tick while a run is in progress, and alert on skipped runs.
- **refresh locks out readers** — a blocking rebuild takes an exclusive lock on the view, so every read stalls for the whole recompute — a read outage that arrives on a schedule unless a concurrent refresh mode is used
- **incremental drift** — a bug in the delta logic — a missed change, a wrong ordering, a bad replay — leaves the view quietly disagreeing with the source, and nothing surfaces it until someone reconciles against a full rebuild
- **stale reads taken as fresh** — callers act on aggregates that lag reality because the view exposes no freshness signal; the data looks authoritative right up until a decision is made on numbers that were already out of date

### Readiness checklist
<!--meta polarity=check-->

- Decide and document the staleness SLA, and expose a last-refreshed timestamp so reads can tell how current the view is
- Use a non-blocking refresh where the engine offers one, so a rebuild does not lock readers out; it needs a unique index in PostgreSQL and typically refreshes more slowly.
- Keep the source of truth and be able to fully rebuild the view from it after corruption or a schema change
- Monitor refresh duration against the cadence and alert when it approaches or exceeds the interval
- Reconcile an incremental view against a full rebuild periodically to catch silent drift

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Performance](../../../themes/performance.md) — Precompute expensive reads {#fluency-performance}
- [Scaling Reads](../../../themes/scaling-reads.md) — Precompute an expensive read as a maintained table {#fluency-scaling-reads}
- [Proximity Search](../../../themes/proximity-search.md) — Resolve fixed geometry once at write time so reads never redo the test {#fluency-proximity-search}
- [Microservices Design](../../../themes/microservices-design.md) — Keep a local read copy of another service's data {#fluency-microservices-design}
- [Event Modeling](../../../themes/event-modeling.md) — The read model built from the event stream {#fluency-event-modeling}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [CQRS](../../architecture/cqrs.md) — The read side is a materialized projection
- [Event Sourcing](../../architecture/event-sourcing.md) — Project events into read views
- [Big Data](../../architecture/big-data.md) — Analytical serving is one of the largest uses of a precomputed view.
- [Retrieval-Augmented Generation](../../ml/rag.md) — A vector index over documents is one of these, rebuilt by an embedding job rather than a query
- [Change Data Capture](./change-data-capture.md) — A change-data-capture stream is one way to keep the view fed as the source changes
- [Event-Carried State Transfer](../../messaging/event-carried-state-transfer.md) — Events carrying full state let a consumer build and refresh the view with no call back.

**Alternative to**

- [Sliding Window](./sliding-window.md) — A standing rollup replaces a hand-kept window when every event is stored anyway.

**Part of**

- [CQRS](../../architecture/cqrs.md) — The read model is a materialized view

**Often confused with**

- [Cache-Aside](../../caching/cache-aside.md) — Precomputed projection vs. lazily-filled cache
- [Index Table](./index-table.md) — Precomputes the result; an index table only precomputes how to find the records

**Prevents**

- [N+1 Query](../../../hazards/n-plus-1-query.md) — Precompute the joined result so the N follow-up queries disappear entirely
- [Extraneous Fetching](../../../hazards/extraneous-fetching.md) — Turns a per-request scan into a lookup, paid for with a bounded staleness
- [Distributed Monolith](../../../hazards/distributed-monolith.md) — Refusing to duplicate any data forces every service to call the owner, which is shared state by another name.
- [Busy Database](../../../hazards/busy-database.md) — Computes the costly shape once on a schedule, so the read is a lookup instead of per-request compute; staleness must be bounded

**Demonstrated by**

- [Top-K](../../../designs/top-k.md) — expensive windowed aggregation is precomputed into standing rollup tables read directly at query time
- [Ad Click Aggregator](../../../designs/ad-click-aggregator.md) — counts computed ahead of the query turn a slow GROUP BY over millions of rows into an instant lookup
- [Metrics & Monitoring](../../../designs/metrics-monitoring.md) — precomputed, maintained rollups are what make heavy time-range aggregations cheap at read time
- [Facebook News Feed](../../../designs/fb-news-feed.md) — a per-user feed is a textbook materialized view — computed from posts, redundant with them, and rebuilt to make reads O(1)
- [Instagram](../../../designs/instagram.md) — the per-user feed is a materialized view kept current by write-time updates instead of recomputed on read
- [Facebook Post Search](../../../designs/fb-post-search.md) — the design keeps a live materialized view of the whole post corpus so search never touches the base data
- [Google News](../../../designs/google-news.md) — the regional feed is a maintained view of the article store, kept current as rows change instead of recomputed per request
- [Yelp](../../../designs/yelp.md) — a computed value maintained at write time so the hot read path never recomputes it
- [Tinder](../../../designs/tinder.md) — the precomputed per-user feed is a read model built from source data and refreshed off the hot path
- [Strava](../../../designs/strava.md) — periodic aggregation into a read-optimized view is a materialized view over the stream of completed activities
- [Google Docs](../../../designs/google-docs.md) — an expensive-to-recompute read (replaying millions of ops) is served from a maintained, refreshed snapshot
- [Online Chess](../../../designs/online-chess.md) — an order-statistics rank index kept beside the durable record — computed from it, disposable, reconcilable — is a materialized view
- [LeetCode](../../../designs/leetcode.md) — an expensive scan-group-sort query is replaced by a precomputed read model maintained on write
- [Payment System](../../../designs/payment-system.md) — one stream feeding many independently-optimized read models is the pattern working at scale
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — a projection that commits with its source, rebuilt rather than migrated when the read model changes
- [CamelCamelCamel](../../../designs/camelcamelcamel.md) — A scheduled rebuild turns an expensive aggregation into a cheap keyed read, at the price of staleness
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — Current state kept as a computed row beside an append-only history, not a second write path

**Implemented by**

- [Databases](../../../capabilities/databases.md) — Several managed engines refresh these for you.

<!-- relationships:end -->
