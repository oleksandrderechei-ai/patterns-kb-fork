---
title: Event Sourcing
description: "State is a replayable log of events, not a snapshot"
area: architecture
owner: Oleksandr Derechei
tags: [data-modeling, immutability]
status: stable
aliases: [ES]
solves: [the balance is wrong and I have no idea which update did it, compliance wants to know what this record looked like last March and I overwrote it, my audit table drifted out of sync with the real data months ago, two users saved at once and one of the changes just vanished, I need to answer why this happened but all I stored was the final value]
favourite: true
---

# Event Sourcing

Every change to an entity is captured as an immutable event appended to a log, and current state is never stored on its own — it's rebuilt by replaying that log and folding each event into whatever came before.

## What it is
<!--meta block=description-->

The balance is wrong and nobody can say why, because each update overwrote the value before it. Instead, never overwrite: append every change, such as deposited or withdrawn, to an ordered log that becomes the record, and add the log up whenever you need the answer. The audit trail cannot drift from the data, because it is the data. You can also rebuild the state as it stood at any past moment.

## Explained
<!--meta block=explain-->

With event sourcing you never overwrite a value. You append each change to an ordered log that never changes, and you work out the current state by adding the log up, so the audit trail cannot drift from the data. Choose it over a normal table with an audit table beside it when the history is itself valuable: a legal record, questions about the past, or several differently shaped read models built from one log by a projection (code that reads the log and builds a copy for one screen). On a plain create-read-update-delete app it adds cost for no gain. When two writers change the same aggregate (the object whose rules decide each change) at once, each appends with the version it last saw, so the second append fails loudly instead of interleaving.

- **Long logs are slow to add up.** Save a snapshot every so many events and replay only the events after it.
- **Event shapes are forever.** Put a version number on every event from the first and decide how old shapes get upgraded.
- **Reads can lag the log.** Read the record itself for the one screen that must show a user their own change.
- **Replay repeats side effects.** Switch off outside calls while replaying.

**Example.** An account has these events: deposited 100, withdrawn 30, deposited 50. Adding them up gives 120, and replaying only to the second event gives 70, the balance at that moment. Assuming 0.05 ms to apply one event (measure your own), 10,000 events take 500 ms for a full replay on every read. A snapshot every 500 events cuts it to at most 500 events, 25 ms. The cost is that the snapshot is a second thing to write and keep in step with every future event version.

## How it works
<!--meta block=structure-->

```mermaid caption="How is a balance answered when no row holds it? Step 3 appends the only truth the system keeps; everything inside the box is folded from that log and can be thrown away and rebuilt."
flowchart LR
    Client["Client"]
    App["Command handler"]
    Log[("Event log, append-only")]
    Proj["Projector"]
    subgraph Derived["Folded from the log — rebuildable"]
        Snap[("Snapshots")]
        View[("Read model")]
    end
    Client -->|"1 deposit 100"| App
    App -->|"2 fold from the last snapshot"| Snap
    App -->|"3 append MoneyDeposited"| Log
    Proj -->|"4 read new events"| Log
    Proj -->|"5 update the view"| View
    Client -->|"6 read the balance"| View
```

```mermaid caption="A command produces one event appended to the log. State is never stored directly — it is the fold of every event replayed in order; a read model is a separate projection built from the same log."
flowchart LR
    C["Command"] -->|"handled by"| A["Aggregate, applies business rules"]
    A -->|"append"| L["Event Log, append-only"]
    L -->|"replay, fold"| S["Current State, folded on read"]
    L -->|"project"| V["Read Model, a separate projection"]
```

## Variations
<!--meta block=variations-->

- **Snapshotting** — Periodically persist the folded state so replay resumes from the latest snapshot instead of scanning the full log from event zero.
- **Per-aggregate stream vs. single log** — One ordered stream per aggregate instance (per order, per account) scales writes and reads; a single global stream simplifies cross-aggregate ordering but becomes a bottleneck.
- **Event versioning / upcasting** — Old event shapes are transformed to the current schema when read — upcast, not rewritten — since events must stay immutable forever.
- **[Materialized View](../distributed/coordination/materialized-view.md) projections** — Fold the event stream into one or more read-optimized views instead of querying the log directly for every read.
- **Replay-safe side effects** — Handlers touch nothing outside the system on replay. Outbound calls sit behind a flag the replay turns off. A time-sensitive inbound response is stored in the event, so replay folds the value that was true then, not now.
- **Archival tier** — Move cold events off the hot store onto cheap [object storage](../distributed/routing/object-storage.md) on a schedule, keeping the recent tail where reads are fast. It bounds the cost of a log that only ever grows, at the price of a replay that reaches back far enough having to read from the slow tier.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Complete audit trail**: every change is recorded, not inferred after the fact. It is tamper-evident only with extra controls, such as chained entry hashes or write-once storage.
- **State at any past point in time** can be reconstructed by replaying up to that moment.
- **Multiple read models** can be built from the same log without touching the write side.
- **Append-only writes never overwrite a value**, so a lost update surfaces as a failed expected-version append rather than silent loss.

### Cons
<!--meta polarity=con-->

- **Replaying a long stream from scratch** is slow without snapshotting.
- **Schema evolution is harder** — events are immutable, so shapes must be versioned or upcast forever. Put a version field on every event from the first one, because retrofitting it onto an unversioned log means guessing.
- **Querying "current state" isn't a single row read**; it needs a projection or a fold.
- **Read models built from the log** lag the write side. For the one screen that must show a user their own change at once, read the aggregate itself.
- **Replay re-runs whatever the handlers did**, so every call to an outside system has to be gated behind a flag the replay turns off, and every time-sensitive value read from outside has to be stored in the event that used it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need a reliable audit** trail or a compliance record of every change, not just its result.
- **Business rules genuinely depend** on the sequence of what happened, not just where things ended up.
- **You want to build several** independently evolvable read models from one write path.
- **You want to ask what-if** — replay the log with an event changed, added or removed and see where the state lands.

### Avoid when
<!--meta polarity=avoid-->

- **The domain is simple create, read, update, delete (CRUD)** with no real need for history, audit, or temporal queries.
- **The team can't yet operate the extra machinery** — snapshotting, versioning, replay tooling.
- **Strong, immediate read-after-write consistency** across the whole system is a hard requirement.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — rebuilding state, deciding and appending with an expected version"
type AccountEvent =
  | { type: "AccountOpened"; id: string; openingBalance: number }
  | { type: "MoneyDeposited"; id: string; amount: number }
  | { type: "MoneyWithdrawn"; id: string; amount: number };

interface AccountState { id: string; balance: number }

function apply(state: AccountState, event: AccountEvent): AccountState {
  switch (event.type) {
    case "AccountOpened":
      return { id: event.id, balance: event.openingBalance };
    case "MoneyDeposited":
      return { ...state, balance: state.balance + event.amount };
    case "MoneyWithdrawn":
      return { ...state, balance: state.balance - event.amount };
  }
}

// Current state is never stored — it's a fold over the log.
const log: AccountEvent[] = [
  { type: "AccountOpened", id: "acc-1", openingBalance: 0 },
  { type: "MoneyDeposited", id: "acc-1", amount: 100 },
  { type: "MoneyWithdrawn", id: "acc-1", amount: 30 },
];

const state = log.reduce(apply, {} as AccountState); // balance 70

// Decide, then append with the version you last read.
function withdraw(s: AccountState, amount: number): AccountEvent[] {
  if (s.balance < amount) throw new Error("insufficient funds");
  return [{ type: "MoneyWithdrawn", id: s.id, amount }];
}
// store.append("acc-1", withdraw(state, 30), log.length) rejects if another writer appended first.
// Resume from a snapshot: events.slice(snap.version).reduce(apply, snap.state)
```

## In the wild
<!--meta block=wild-->

- **EventStoreDB** — A database purpose-built for append-only event streams: appends take an expected revision so concurrent writers conflict instead of interleaving, and catch-up subscriptions feed projections that fold streams into current state. {#wild-eventstoredb}
- **Amazon Kinesis Data Streams** — AWS documents this as the event store itself: application changes are published to the stream as they happen, partitioned across shards for throughput, and archived to Simple Storage Service (S3) so the durable history outlives the stream's own retention. Downstream consumers project the same events into whatever read store each one needs — a relational materialized view for queries, a payment processor for completed transactions. {#wild-kinesis}
- **Datomic** — Stores immutable facts with transaction time; as-of hands you the entire database as a value at any past instant, and the history API exposes the full record of assertions and retractions for an entity. {#wild-datomic}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **snapshot interval** — how many events between snapshots; too sparse and a cold load replays thousands of events, too dense and the snapshot store becomes a second write path to keep correct
- **stream granularity** — one stream per aggregate instance keeps replay short and writes parallel; coarser streams give you cross-entity ordering but concentrate contention and grow without bound
- **event store partitioning** — the shard or partition key the store spreads writes and reads across. The log is the single hottest write path in the system, so a key that concentrates traffic on one partition caps throughput no amount of hardware raises
- **expected-version check on append** — append with the version you last read; a mismatch means a concurrent writer got there first — reject and retry rather than silently interleave events
- **archive threshold** — the age or offset past which cold events move to cheap object storage. It bounds the cost of a log that only ever grows; set it inside the range a real replay needs and those replays start reading from the slow tier
- **versioning strategy** — upcasters that rewrite old shapes on read, or tolerant readers that ignore unknown fields; either way the choice is forever, because written events never change

### Signals to watch
<!--meta polarity=signal-->

- **projection lag** — events appended minus events projected — the read model's staleness as a measured number, not an assumption
- **longest-stream replay time** — the aggregate with the most events sets worst-case load latency; it grows silently until someone opens a five-year-old account
- **append conflict rate** — expected-version failures per minute; a rising rate marks a hot aggregate that concurrent writers are fighting over
- **event store size and per-partition skew** — total retained bytes plus the spread across partitions; a single partition running ahead of the others is the throughput ceiling arriving early

### Failure modes under load
<!--meta polarity=failure-->

- **unbounded stream growth** — an aggregate that lives forever — a ledger, a device — accumulates events until load time breaks; for those, snapshotting is survival, not optimization
- **replay reaches the outside world** — a replay re-runs the handlers, and an ungated one re-sends the email, re-charges the card, or re-notifies the partner. The system under replay looks fine; the damage lands entirely outside it
- **replay reads today instead of then** — a handler that called an external service for a rate, a price or a score gets the current answer during replay, so the reconstructed state silently differs from the state that actually existed
- **projection rebuild measured in days** — fixing a projection bug means replaying the whole log; at 0.05 ms an event, a billion events is about 14 hours single-threaded, so rebuild speed has to be designed for
- **schema regret** — a badly shaped event is permanent — every future reader carries its upcast chain, and one missed upcaster folds wrong state without an error
- **personal data in an immutable log** — a deletion request meets a log that never deletes; crypto-shredding or storing personally identifiable information (PII) outside the events must be designed in before the first event is written

### Readiness checklist
<!--meta polarity=check-->

- design snapshotting before the first long-lived aggregate, not after the first slow load
- put an explicit version field on events from day one — retrofitting versions onto an unversioned log is miserable
- every outbound side effect in a handler is behind a flag the replay can turn off
- every time-sensitive external read is stored in the event, so a replay reads the value that was true then
- keep personal data out of events, or encrypt it with a per-subject key you can destroy
- rehearse a full projection rebuild in staging and time it — that number is your recovery time when a projection bug ships
- append with an expected version so concurrent writers fail loudly instead of interleaving

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Streaming](../../themes/streaming.md) — A durable, replayable stream of events — the log is the state, so re-reading it rebuilds anything computed from it. {#fluency-streaming}
- [Event Storming](../../themes/event-storming.md) — Keep the discovered events as the record {#fluency-event-storming}
- [Event Modeling](../../themes/event-modeling.md) — The optional decision to store the middle lane {#fluency-event-modeling}

<!-- fluency:end -->

## Check yourself
<!--meta block=selfcheck-->

> **Why do long-lived aggregates need snapshots?**
>
> Replaying a long stream from the first event is slow, see [con 1](event-sourcing.md#tradeoffs-con-1).

> **Why is evolving an event schema harder than altering a table?**
>
> Events are immutable, so their shapes must be versioned or upcast for as long as the log lives, see [con 2](event-sourcing.md#tradeoffs-con-2).

> **When should you not event-source a domain?**
>
> When it is plain CRUD with no need for history, audit or temporal queries, see [avoid 1](event-sourcing.md#usage-avoid-1).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Event-Driven Architecture](./eda.md) — Sourced events can also drive reactions
- [CQRS](./cqrs.md) — Often paired: write events, project read models
- [Outbox](../distributed/coordination/outbox.md) — Append the event, publish reliably
- [Immutability](../functional/immutability.md) — Events are append-only and never mutated
- [Materialized View](../distributed/coordination/materialized-view.md) — Project events into read views
- [Domain Event](../ddd/domain-event.md) — Persist the events the domain emits
- [Flux](../frontend/flux.md) — Flux/Redux is event-sourcing applied to client-side user interface (UI) state
- [Memento](../gof/behavioral/memento.md) — Snapshot the aggregate so replay need not start from event one
- [Minimize Coordination](../../principles/minimize-coordination.md) — An append-only log removes the contention a mutable record creates
- [Aggregate](../ddd/aggregate.md) — One aggregate is one event stream; a version check on append guards its rules

**Alternative to**

- [Event-Carried State Transfer](../messaging/event-carried-state-transfer.md) — In event sourcing the events are the owner's own record, not a copy for others.

**Composed of**

- [Domain Event](../ddd/domain-event.md) — The log is a sequence of domain events

**Often confused with**

- [CQRS](./cqrs.md) — Separate read/write models vs. store events — distinct ideas
- [Write-Ahead Log](../distributed/coordination/write-ahead-log.md) — Domain events as truth vs. a durability log
- [Change Data Capture](../distributed/coordination/change-data-capture.md) — Stores the events themselves as the state, so no log needs to be read back out of a table

**Prevents**

- [Dual-Write Inconsistency](../../hazards/dual-write-inconsistency.md) — Dissolves the dual write by making the log the state

**Exposed to**

- [Golden Hammer](../../hazards/golden-hammer.md) — Can fall into golden hammer when the history log gets used where a plain table would do
- [Clock Skew](../../hazards/clock-skew.md) — Can fall into clock skew when ordering events from many hosts by wall-clock time scrambles the stream

**Demonstrated by**

- [Ad Click Aggregator](../../designs/ad-click-aggregator.md) — immutable events retained and replayed to rebuild the aggregates computed from them
- [Strava](../../designs/strava.md) — storing lifecycle events and computing state from them, so moving-time vs total-time falls out for free, is event-sourcing in miniature
- [Google Docs](../../designs/google-docs.md) — document state is reconstructed by applying an immutable, ordered stream of edit operations rather than storing mutable snapshots
- [Online Chess](../../designs/online-chess.md) — state-as-a-fold-over-events turns crash recovery into pure replay of a few hundred bytes and makes the leaderboard trivially rebuildable
- [Payment System](../../designs/payment-system.md) — payments show why an append-only event log beats mutable current-state — you can reconstruct any past state and defend a chargeback
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — a case study where the pattern's payoff is a delivery guarantee: the record needs no companion queue because it already is one

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — A purpose-built event store gives you the append, per-stream read and subscription that this pattern needs.

<!-- relationships:end -->
