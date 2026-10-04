---
title: Dual-Write Inconsistency
description: "Two systems updated by two calls, and one of them does not land"
area: hazards
owner: Oleksandr Derechei
tags: [consistency, durability, error-handling]
status: stable
aliases: [dual write, dual-write problem]
solves: [a record exists in the database but never showed up in the search index, "we save to the database and publish an event, and sometimes only one of them lands", the cache and the store disagree and nobody can say when they diverged, a downstream count no longer matches the source though both calls returned success]
---

# Dual-Write Inconsistency

One logical change applied to two systems by two separate calls, with no transaction spanning them — so a crash, an error or a race in the gap between the calls leaves the two holding different versions of the same fact, and neither of them reports an error.

## What it is
<!--meta block=description-->

A **dual write** applies one change to two systems through two independent calls, such as the database and a message broker, a cache or a search index. Nothing joins the calls, so a failure, crash or race between them leaves the two holding different versions. You see drift, not failure: a record missing from the search index, a cached price that stays wrong. Both calls usually succeed and nothing alerts.

## Explained
<!--meta block=explain-->

A dual write is one change sent to two systems by two separate calls, such as saving a row and then publishing a message to a broker. Nothing joins the calls, so a crash or error between them leaves one side changed and the other not. If the publish succeeds and the row rolls back, others act on something that never happened. Both calls usually succeed, so nothing alerts, and the damage shows up as drift: a missing search entry, a wrong cached price. A retry around the second call closes one branch and opens another, because a repeat now arrives twice. Make it one write. Put the message in an [outbox](../patterns/distributed/coordination/outbox.md) table in the same transaction as the row and let a relay publish it afterwards, or read the store's [change log](../patterns/distributed/coordination/change-data-capture.md). For a system you do not own, store your intent first and run a reconciliation job that compares both sides.

- **Duplicate deliveries.** A relay can publish twice, so give each message an ID and have receivers skip repeats.
- **More moving parts.** You run one extra table and a relay; alarm on rows that wait too long.

**Example.** An orders service saves an order, then publishes an event for shipping. It handles 100,000 orders a day, and one in 10,000 fails between the two steps. That is 10 orders a day paid for and never shipped, 300 in a month, with no error in any dashboard. With an outbox, the order row and the event row commit in one transaction, so a crash loses neither. A relay publishes the event, possibly twice, and shipping skips an order ID it has seen.

## How it happens
<!--meta block=causes-->

It happens because the two updates do not share a save button. Saving the order and telling the warehouse are two separate calls to two separate systems, and there is no undo that reaches across both — so if the second one fails after the first has already been stored, the first one stays. The code looks completely reasonable, works every time you run it by hand, and only misbehaves when something interrupts it halfway.

No transaction spans a database and a broker, so the second call is committed independently of the first and each ordinary failure lands inside the gap between them. Timeouts, broker unavailability and process death all produce the same result: a durable change nobody was told about. Concurrency adds a second route to the same damage, since two writers can serialize one way in the database and the other way at the destination.

Read it as the cheapest correct-looking design, which is why experienced teams still ship it. Two sequential calls are the shortest path from a working feature to a working feature: they pass review, pass integration tests, and fail only under partial failures that tests do not generate. The reflex fix — wrap the second call in a retry — closes the smallest branch and opens a larger one, because a retried publish over a committed row now risks duplicates on a consumer that was never made idempotent.

```mermaid caption="Where the change gets lost: the second write has its own failure modes, and nothing rolls back the first when it hits one."
flowchart TB
    A["One request changes one thing"] --> B["Write 1: commit the row"]
    B --> C["Write 2: publish the event"]
    C -->|"both succeed"| OK["The two systems agree"]
    C -->|"broker error, timeout or crash"| L["Row committed, event never sent"]
    L --> D["Downstream never learns — drift, and no error anywhere"]
```

- Two calls, no shared transaction: the broker, cache or index commits separately from the database, so a failure on the second leaves the first with nothing to roll back to.
- A crash in the gap: the process dies after the commit and before the publish, and no record survives to say the message was ever owed.
- A timeout that is not a failure: the publish times out and gets retried, but the original had already been accepted — so one side sees the change once and the other twice.
- Concurrent writers: two updates to the same entity commit in one order and arrive at the second system in the other, so the destination settles on the value the source has already replaced.
- Order lost in transit: updates for one entity are spread across partitions or delivered by parallel workers, so per-entity ordering is not preserved even when every message arrives.

## What it costs
<!--meta block=cost-->

- **The divergence is permanent until something else overwrites it.** A missed index update or a stale cache entry does not heal on its own, so one lost message in a million becomes a growing population of wrong records.
- **Downstream acts on a fiction, or fails to act at all.** A published-but-rolled-back event ships an order that does not exist; a committed-but-unpublished one charges a customer nothing ever ships to.
- **Nothing alerts.** Both calls returned success on almost every request, so error rates, latency and saturation all read normal — the discovery path is a customer complaint or a quarterly reconciliation.
- **Every incident becomes a forensic exercise.** Establishing what happened means comparing the two systems record by record and reconstructing which half landed, which is work per affected row rather than per bug.
- **The obvious remedy makes it worse.** Retrying the second call without idempotency on the consumer converts lost updates into duplicate ones, so the failure mode changes shape instead of going away.
- **It compounds with every pair you add.** A database with a broker, a cache and an index is three dual writes, each with its own drift and its own reconciliation job to build and to run forever.

The bill lands as trust rather than as downtime, and that makes it hard to fund. Nobody can put a number on how much of the data is wrong, so the reconciliation job becomes a permanent operational line item and the answer to "can we rely on this feed?" becomes "mostly". Analytics built on the downstream copy inherit the drift silently, and the eventual repair costs more than the outbox would have, because by then the corrective work includes backfilling everything that went missing since the first day.

## Getting out
<!--meta block=mitigation-->

Make it one write. Whatever changes the state and whatever announces the change must commit together: write the message into an [outbox](../patterns/distributed/coordination/outbox.md) table in the same transaction as the row it describes, and let a relay deliver it afterwards. Delivery becomes a retryable background job instead of a step that can be lost. If you cannot add a table, [tail the store's change log](../patterns/distributed/coordination/change-data-capture.md) instead, so the event is a projection of a committed fact rather than a second write.

Then design for at-least-once, because every relay can deliver twice. Give each message a stable identifier and have consumers record what they processed, or shape the update so that applying it twice is the same as applying it once — that is [idempotency](../patterns/messaging/idempotency.md), and it is not optional here. For caches and search indexes, invalidate rather than [write through](../patterns/caching/write-through.md): a lost invalidation costs a cache miss, a lost write-through costs permanent [staleness](./stale-cache.md). Key messages by entity so that updates to one record stay in order — global ordering is almost never the guarantee you actually need.

Where the second system is outside your reach — a payment provider, a partner API — you cannot collapse the two writes, so make the pair recoverable instead. Persist the intent before you call, retry with an idempotency key the provider honours, and run a reconciliation sweep that compares both sides and repairs the drift; that sweep is a permanent component, not a migration script. Two-phase commit is the other exit and rarely the right one: it buys atomicity by making your availability the product of both participants', and a coordinator failure holds locks until someone intervenes. Instrument the drift either way — relay lag, undelivered rows, a periodic checksum comparison between source and destination — because this failure never announces itself as an error.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Mitigated by**

- [Outbox](../patterns/distributed/coordination/outbox.md) — State and event commit together; a relay delivers afterwards
- [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) — Build the event from the commit log, never write twice
- [Event Sourcing](../patterns/architecture/event-sourcing.md) — One append is both state and event, so nothing diverges
- [Idempotency](../patterns/messaging/idempotency.md) — At-least-once relays duplicate; idempotent consumers make repeats harmless
- [Saga](../patterns/distributed/coordination/saga.md) — Compensating steps repair a sequence no transaction could cover
- [Inbox](../patterns/distributed/coordination/inbox.md) — Consumers that record what they processed make redelivery harmless
- [Sweeper](../patterns/distributed/coordination/sweeper.md) — A reconciliation sweep is the permanent repair loop when the second system cannot join the transaction
- [Compensating Transaction](../patterns/distributed/resilience/compensating-transaction.md) — Where two systems cannot commit together, a recorded undo repairs the half that landed
- [Two-Phase Commit](../patterns/distributed/coordination/two-phase-commit.md) — Two-phase commit is one cure for two stores drifting apart, at the cost of blocking.

**Threatens**

- [Cache-Aside](../patterns/caching/cache-aside.md) — The app updates the store and then the cache with separate calls, so a failed second call leaves a stale entry
- [Write-Through](../patterns/caching/write-through.md) — The cache and store are written by two calls with no shared transaction
- [Event-Driven Architecture](../patterns/architecture/eda.md) — An event-driven flow publishes the event and writes the state separately, so one can land without the other

<!-- relationships:end -->
