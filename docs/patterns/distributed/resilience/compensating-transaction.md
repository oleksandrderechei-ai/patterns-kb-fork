---
title: Compensating Transaction
description: Undoes completed steps when a later step fails
area: distributed-resilience
owner: Oleksandr Derechei
tags: [transactions, error-handling]
status: stable
aliases: [compensating action]
solves: [the payment went through but the order never got created and support fixes it by hand, my checkout died halfway and left inventory reserved forever, i cannot wrap three separate services in one database transaction, when step four fails i have no idea how to unwind steps one through three, we keep finding records stuck in a half-finished state after a crash]
---

# Compensating Transaction

When a later step in a multi-step operation fails after earlier steps already committed, runs an explicit, semantic undo — a refund, a release, a cancellation — for each of them, because no distributed rollback is coming to save you.

## What it is
<!--meta block=description-->

Once an operation spans independent services, no shared commit can roll it all back when a late step fails. A compensating transaction pairs each step with an undo, such as refund for charge. When a step fails, the coordinator runs the undos for the finished steps in reverse. An undo reverses the business effect, so it corrects the state afterward instead of preventing it.

## Explained
<!--meta block=explain-->

A compensating transaction is an undo step you write for each step of an operation that spans several services, and you run the undos in reverse when a later step fails. Each service saves its own work for good, so no lock is held across services and none waits on the slowest. If you reserve stock and charge a card, and then the shipment fails, you refund the charge and release the stock. Without the undos, the failure leaves a charged customer with nothing shipped, and someone finds and fixes it by hand. Choose it over a single database transaction only when the steps live in different services. Choose it over [two-phase commit](../coordination/two-phase-commit.md), where every service locks its data until all agree, when you cannot hold locks that long. An undo means the opposite business effect, not erased history: a refund leaves the charge on record.

- **Hand-written undos.** You write every undo yourself, so write it together with its step.
- **Visible half-done state.** Customers can see it, so show it as pending.
- **Steps with no undo.** A sent email cannot be taken back, so run such steps last.
- **Undos can fail.** Make each one safe to repeat, retry it with backoff, and park it for a person if retries run out.

**Example.** An order has three steps: reserve the last unit of stock, charge 40 dollars, book a courier. The courier service is down. The coordinator runs the undos in reverse: refund 40 dollars, then release the unit. The first refund call times out, so it is retried after 5 s with the same refund key, and the refund key lets the payment service ignore a duplicate request. For those 5 s the customer sees a charge and another buyer sees zero stock. That window is the cost. A confirmation email sent before the courier step could not be taken back, so it belongs after it.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one operation across three services undo itself when the last step fails? The log written at 2 and 4 records exactly which steps committed, so at 6 to 8 the orchestrator walks them backwards and runs each one's paired inverse — the money is refunded, not un-charged."
flowchart LR
    Orch["Orchestrator"]
    Log[("Saga log — which steps committed")]
    subgraph Local["Each service commits locally — no shared transaction"]
        Inv["Inventory"]
        Pay["Payment"]
        Ship["Shipping"]
    end
    Orch -->|"1 reserve stock"| Inv
    Orch -->|"2 record: reserve committed"| Log
    Orch -->|"3 charge card"| Pay
    Orch -->|"4 record: charge committed"| Log
    Orch -->|"5 create shipment — no capacity"| Ship
    Log -->|"6 read committed steps, newest first"| Orch
    Orch -->|"7 refund the charge"| Pay
    Orch -->|"8 release the stock"| Inv
```

```mermaid caption="Shipping fails after inventory and payment already succeeded. The orchestrator runs each completed step's compensation in reverse order."
sequenceDiagram
    autonumber
    participant O as Orchestrator
    participant Inv as Inventory
    participant Pay as Payment
    participant Ship as Shipping
    O->>Inv: reserve stock
    Inv-->>O: reserved
    O->>Pay: charge card
    Pay-->>O: charged
    O->>Ship: create shipment
    alt shipment created
        Ship-->>O: shipped
    else shipping fails
        Ship--xO: no carrier capacity
        O->>Pay: refund charge (compensate)
        Pay-->>O: refunded
        O->>Inv: release stock (compensate)
        Inv-->>O: released
    end
```

## Variations
<!--meta block=variations-->

- **Semantic vs. exact rollback** — A compensation undoes the business effect, not the storage. A refund is a new, visible transaction that offsets a charge — it doesn't erase the charge from history the way a database rollback would.
- **Pivot transaction** — The step after which the saga, the chain of steps and undos, goes forward no matter what. Retry it until it succeeds instead of compensating it. Order steps as compensable first, then the pivot, then retriable steps, so a failure after the pivot never needs an undo.
- **[Idempotency](../../messaging/idempotency.md)** — A compensation itself can fail and need retrying, so it must be safe to run twice — refunding the same charge only once even if the retry fires again.
- **Best-effort vs. guaranteed compensation** — Best-effort compensations run once from memory and are lost if the process crashes mid-undo. Durable ones persist each compensation as a queued task and retry it until confirmed.
- **Unknown outcome** — A step that fails by timeout may have committed, so run its undo too and make the undo a safe no-op if the step never ran.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Avoids holding locks or open transactions** across services for the life of a whole operation.
- **Lets each service commit locally** and keep its own consistency boundary intact.
- **Turns partial failure into an automatic recovery**, provided compensations are idempotent and durably retried.
- **Composable** — a saga is just a list of steps, each carrying its own undo.

### Cons
<!--meta polarity=con-->

- **Compensations are bespoke business logic for every step** — the platform can't generate them for you.
- **The system passes through** a visibly inconsistent intermediate state; a customer may see a charge before the refund lands.
- **Not everything is compensable** — a sent email or a shipped package has no clean undo.
- **If a compensation itself fails**, the saga is stuck half-undone unless retries and idempotency are designed in from the start.
- **The half-done state is not isolated**; others can read or overwrite it, so an undo may find a different value than it wrote.
- **An undo cannot retract work** others already started from the half-done state they saw.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A single business operation spans multiple services** or databases with no shared transaction manager.
- **Every step in that operation** has a reasonable semantic undo — release, refund, cancel.
- **Availability over locked resources** — availability matters more than holding the whole operation's resources locked until it commits.

### Avoid when
<!--meta polarity=avoid-->

- **All the state lives in one database** — use a real ACID (atomicity, consistency, isolation, durability) transaction instead of building this by hand.
- **A step is genuinely irreversible** with no meaningful compensation — design a pivot point around it instead.
- **The operation is a single idempotent call** with no ordering dependency — plain retry already covers it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a saga that undoes what it already did"
type Step = {
  action: () => Promise<void>;
  compensate: () => Promise<void>;
};

async function runSaga(steps: Step[]): Promise<void> {
  const completed: Step[] = [];
  try {
    for (const step of steps) {
      completed.push(step); // before the action: a timed-out step may have committed
      await step.action(); // compensate must be idempotent and a safe no-op if the step never ran
    }
  } catch (err) {
    for (const step of completed.reverse()) {
      await step.compensate().catch(() => {
        // log and hand off to a durable retry queue
      });
    }
    throw err;
  }
}

await runSaga([
  { action: () => inventory.reserve(orderId), compensate: () => inventory.release(orderId) },
  { action: () => payment.charge(orderId),    compensate: () => payment.refund(orderId) },
  { action: () => shipping.create(orderId),   compensate: () => shipping.cancel(orderId) },
]);
```

## In the wild
<!--meta block=wild-->

- **Temporal** — Its SDKs provide a Saga helper (addCompensation in the Java SDK) that registers an undo per step and invokes them in reverse when the workflow fails; durable event history means the compensations survive worker crashes. {#wild-temporal}
- **BPMN 2.0** — The standard defines compensation handlers, compensation boundary events, and a compensate throw event, so an executable process — as in engines like Camunda — can walk back already-completed activities. {#wild-bpmn}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Compensation retry policy** — How many times and with what backoff a failed compensation is retried before it is escalated — compensations fail too and must keep trying.
- **Pivot point placement** — Which step marks the boundary past which the saga rolls forward (retry to success) instead of compensating backward.
- **Compensation durability** — Whether each pending compensation is persisted to a queue or journal so a crash mid-undo can resume, versus best-effort in-memory.
- **Idempotency key scope** — The key used to dedupe both actions and compensations so a retry cannot double-apply a refund or release.

### Signals to watch
<!--meta polarity=signal-->

- **Stuck / half-undone sagas** — Count of sagas that failed a compensation and are left partially rolled back awaiting intervention.
- **Time-to-consistency** — How long the system stays in the visibly inconsistent intermediate state before compensations complete.
- **Compensation dead-letter depth** — Compensations that exhausted their retries and were parked for manual handling.

### Failure modes under load
<!--meta polarity=failure-->

- **Compensation fails** — An undo step errors and, without retries and idempotency, the saga is stuck half-undone with no automatic path forward.
- **Non-idempotent double-apply** — A compensation that is not idempotent runs twice on retry after a partial success — refunding the same charge twice.
- **Irreversible step, no pivot** — A genuinely un-undoable step (email sent, package shipped) is reached without a pivot, so the saga can neither complete nor cleanly roll back.
- **Lost compensation on crash** — Best-effort in-memory compensations are dropped if the process dies mid-undo, leaving the earlier steps un-compensated.

### Readiness checklist
<!--meta polarity=check-->

- Make every action and compensation idempotent, keyed so retries cannot double-apply.
- Persist pending compensations durably so a crash mid-undo can resume.
- Define a pivot point for any step that has no meaningful undo.
- Route compensations that exhaust retries to a dead-letter with an operator runbook.
- Alert on sagas stuck half-completed beyond a time bound.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Resilience](../../../themes/resilience.md) — Undo partial work on failure {#fluency-resilience}
- [Multi-Step Processes](../../../themes/multi-step-processes.md) — Undo a completed step when a later one fails {#fluency-multi-step-processes}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Workflow Orchestration](../coordination/workflow-orchestration.md) — A durable engine drives the undo steps and survives crashes mid-rollback
- [Retry with Backoff](./retry-backoff.md) — A failed compensation must be retried until the undo is confirmed

**Requires**

- [Idempotency](../../messaging/idempotency.md) — An undo can fail and be retried, so each compensation must be safe to run again

**Part of**

- [Saga](../coordination/saga.md) — A saga undoes work with compensating transactions

**Often confused with**

- [Two-Phase Commit](../coordination/two-phase-commit.md) — Compensation undoes committed steps after a failure, where two-phase commit never lets them commit alone.

**Prevents**

- [Dual-Write Inconsistency](../../../hazards/dual-write-inconsistency.md) — When the second write fails, an explicit undo of the first restores a consistent state

**Exposed to**

- [Retry Storm](../../../hazards/retry-storm.md) — Retrying a failed undo against a service that is already down adds load; cap compensation retries and back them off.

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Workflow engines run the compensations for you: each step declares its undo, and the engine replays them after a failure.
- [Workflow orchestrators](../../../comparisons/workflow-orchestrators.md) — How much of the compensation each orchestrator writes for you.

<!-- relationships:end -->
