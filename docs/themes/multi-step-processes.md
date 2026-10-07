---
title: Multi-Step Processes
description: Coordinating a process that spans several services without a distributed transaction
area: themes-data
owner: Oleksandr Derechei
tags: [transactions, error-handling, durability]
status: stable
aliases: [distributed transactions, sagas]
---

# Multi-Step Processes

Coordinating one logical operation — charge, reserve, ship, notify — that spans several independently-failing services, where a single distributed transaction is impractical. This theme is the set of patterns that sequence local commits, undo them when a later step fails, and keep every step safe to retry and resume.

## The question
<!--meta block=description-->

Fulfilling an order charges a card, reserves stock, prints a label and waits for a warehouse worker, each in a different service that can fail alone. No single database transaction covers them, and the server driving the flow can crash between steps or receive a webhook on another machine. This theme names the mechanisms that stand in for atomicity: sequence local commits, undo what already committed, and make every step safe to retry and resume.

## Explained
<!--meta block=explain-->

A multi-step process, such as fulfilling an order, touches several services that each have their own database, so no single transaction can make all steps succeed or fail together. The usual answer is a [saga](../patterns/distributed/coordination/saga.md): each step commits at once, and if a later step fails you run an undo step, called a [compensating transaction](../patterns/distributed/resilience/compensating-transaction.md), for each step already committed, such as a refund. Choose it over [two-phase commit](../patterns/distributed/coordination/two-phase-commit.md), where every service locks and votes, because no service can hold a lock while a warehouse worker picks an item. Then decide who runs the flow. Services reacting to one another's events is cheap for short flows and hard to follow when long. One [coordinator](../patterns/distributed/coordination/workflow-orchestration.md) that records its state after each step resumes from its last saved step after a crash.

- **Visible in-between states.** Customers see charged but not yet shipped. Show a pending status instead of hiding it.
- **Undo steps can fail.** Give each a unique key so a retry is safe, and after a per-step retry cap, route failures to a person.
- **Coordinator adds a system.** One more service to run. Skip it for two-step flows, where one direct call and one undo are enough.

**Example.** An order has 3 steps of 1 s each: charge the card, reserve stock, create the shipping label. The card is charged at 1 s, and the label step fails at the 3 s mark. The coordinator undoes in reverse, a stock release then a refund, 2 s in all, so the customer sees charged but pending for about 4 s. The refund carries the order number as its key, so a retry cannot refund twice. If the refund fails 5 times, the case goes to a support queue. The coordinator saves its state after each step, so a crash resumes from the last saved step and re-runs a step cut short, which is safe because each step is idempotent.

## The tradespace
<!--meta block=tradespace-->

The baseline to beat is a distributed transaction: [Two-Phase Commit](../patterns/distributed/coordination/two-phase-commit.md) asks every participant to prepare, then commits all or none. It is the right tool when no one may ever see a half-done state and every participant supports prepare, as with two ledger databases in one data centre. For this theme's flows it fails for three reasons: no participant can hold a lock across a step that waits on a warehouse worker, a stalled coordinator stalls everyone, and external systems like a payment gateway don't speak your commit protocol. Sagas make the opposite bet. They give up atomicity and isolation, and each local step commits and becomes durable the instant it runs. Whatever happened is then undone by a defined compensation, not rolled back. The price is a real window of visible inconsistency (a customer charged but not yet shipped, held in a pending state) and compensations that need the same rigor as the forward path: retries, idempotency, and a human escape hatch for when the undo itself fails. The [Payment System](../designs/payment-system.md) case study shows the same flow with a durable record of every state change.

Given that bet, the axis of choice is **who holds the flow**. Choreography spreads it across the services. Each reacts to the previous step's event and emits the next, so the overall sequence is emergent with no single place that knows the whole thing. That is cheap and loosely coupled for short flows, and opaque once the chain grows long. Orchestration puts one coordinator in charge, driving each step as an explicit state machine. It costs more infrastructure, but gives central control and visibility when the process is complex. Underneath either style the hard part is identical: whatever runs the saga has to survive its own crash and resume from its last saved step. That is why durable execution engines exist. They make that recovery a primitive instead of something you hand-roll from a state table, a poller, and a lock.

```mermaid caption="Every step either advances or triggers compensation for what already committed; the flow is driven either by services reacting to events (choreography) or by a single coordinator (orchestration)."
flowchart TB
    S["A step in the sequence"] -->|"run and commit locally"| Q{"Did it succeed"}
    Q -->|"Yes"| N["Advance to the next step"]
    Q -->|"No"| C["Walk backward, run each committed step's compensation"]
    N -->|"next step needs a driver"| D{"Who drives the sequence"}
    D -->|"Services react to events"| CH["Choreography, emergent flow"]
    D -->|"One coordinator commands steps"| OR["Orchestration, explicit state machine"]
```

## Patterns that coordinate the steps
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Two-Phase Commit](../patterns/distributed/coordination/two-phase-commit.md) {#tour-two-phase-commit}

Every participant votes on whether it can commit, and only then does the coordinator tell all of them to commit. Nobody ends half done once the decision is delivered. Locks stay held while the votes come in, and a coordinator that dies blocks the prepared participants, which is the cost the saga avoids.

### [Idempotency](../patterns/messaging/idempotency.md) {#tour-idempotency}

The property that makes the whole theme safe to retry. A coordinator recovering from a crash may re-run a step it isn't sure completed, and at-least-once delivery redelivers events; without idempotency those retries charge the card twice or send the confirmation again. An idempotency key per logical operation means a step may run more than once but its effect applies once.

### [Saga](../patterns/distributed/coordination/saga.md) {#tour-saga}

Model the process as a chain of small local transactions, each committing in its own service's database, and pair every forward step with a compensating one. When a later step fails, walk backward and fire the compensations for everything already committed. It trades the atomicity of a distributed transaction for a defined undo of every step that ran, retried and escalated to a person if the undo fails.

### [Compensating Transaction](../patterns/distributed/resilience/compensating-transaction.md) {#tour-compensating-transaction}

The undo half of a saga, made explicit. Every step — reserve inventory, charge the card, book the shipment — needs a defined inverse: release, refund, cancel. It is a semantic undo, not a literal rollback; refunding a charge doesn't erase that it happened, it just leaves the customer whole, and deciding what "undo" even means for each step is the real design work.

### [Workflow Orchestration](../patterns/distributed/coordination/workflow-orchestration.md) {#tour-workflow-orchestration}

When the flow gets complex enough that no one should track it by hand, run it as durable code on an engine that records each completed step and, after a crash, replays from that recorded history instead of starting over. The engine runs retries and timers and drives the compensation code you write, so your code holds only the business steps: charge, reserve, ship, notify.

### [Outbox](../patterns/distributed/coordination/outbox.md) {#tour-outbox}

The atomicity gap inside a single step: a service has to change its own state and tell the rest of the world it did, but its database and the message broker share no transaction. Write the event into an outbox table in the same local commit as the state change, then let a relay publish it — so a step can never quietly succeed in the database while its event is lost.

### [Inbox](../patterns/distributed/coordination/inbox.md) {#tour-inbox}

The mirror of that gap where the next step is consumed. Record the incoming message's id alongside the effect it triggers, in one local commit, and acknowledge only after — so a redelivered step event collides with its own record instead of running the step a second time.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Strategy | Reach for |
| --- | --- | --- |
| One change across several databases that must land in all or none | Prepare, then commit together | [Two-Phase Commit](../patterns/distributed/coordination/two-phase-commit.md) |
| To complete a multi-service operation without a distributed transaction | Sequence local commits | [Saga](../patterns/distributed/coordination/saga.md) |
| To undo the steps already committed when a later one fails | Explicit inverse per step | [Compensating Transaction](../patterns/distributed/resilience/compensating-transaction.md) |
| A long or complex flow to survive crashes and resume where it stopped | Durable, replayable execution | [Workflow Orchestration](../patterns/distributed/coordination/workflow-orchestration.md) |
| A step's state change and its event to be all-or-nothing | Write the event in the same commit | [Outbox](../patterns/distributed/coordination/outbox.md) |
| Retried or redelivered steps to stay correct | Same effect however many times it runs | [Idempotency](../patterns/messaging/idempotency.md) |
| To decide who drives the flow: services reacting to events, or one coordinator | Choreography for short flows, orchestration for complex ones | [Saga](../patterns/distributed/coordination/saga.md), [Workflow Orchestration](../patterns/distributed/coordination/workflow-orchestration.md) |

## Related areas
<!--meta block=siblings-->

- [Consistency & Replication](./consistency-and-replication.md) — A saga trades a transaction's isolation for a window of visible, partly-applied state — this is the theme on how much of that inconsistency to tolerate and when it converges.
- [Resilience](./resilience.md) — Compensation, retries, and idempotency are resilience patterns first; a saga is really failure handling for a transaction that outgrew a single database.
- [CAP Theorem](./cap-theorem.md) — Choosing local commits over a blocking two-phase commit is the availability-over-consistency call CAP describes, made at the level of a whole process.
