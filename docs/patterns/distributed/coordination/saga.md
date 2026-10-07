---
title: Saga
description: Coordinates a multi-step transaction across services
area: distributed-coordination
owner: Oleksandr Derechei
tags: [transactions, error-handling]
status: stable
aliases: [choreography, orchestration saga]
solves: [my payment went through but the order never got created and nothing rolled it back, I need a transaction across three services and there is no shared database to roll back, half of my multi-step workflow ran and now the data is inconsistent, locking every service's data until the slowest one answers makes my cross-service transaction time out, a later step failed and I have no way to undo the work the earlier steps already committed]
favourite: true
---

# Saga

Breaks a business transaction that spans several services into a chain of local transactions, each paired with a compensating action that undoes it if a later step fails.

## What it is
<!--meta block=description-->

A business process that spans several services has no single transaction to roll back: the card is charged and the stock reservation then fails. A saga splits it into small local transactions, each committed on its own and each with an undo. If a step fails, the undos of the finished steps run in reverse. You give up isolation while it runs.

## Explained
<!--meta block=explain-->

A saga splits a business process that crosses several services into a chain of small local transactions, each committed on its own, and gives every step an undo. Services coordinate either by reacting to each other's events or through a coordinator that commands each step. If a later step fails for a real reason, you run the undos of the steps already done, in reverse order, so nobody stays charged for an order that will never ship. Choose it over a single cross-service transaction, which would hold locks until the slowest service answers, when you cannot couple their availability. You pay with isolation: while the saga runs, other readers see half-done state.

- **Undo is a business decision.** A refund is not an un-charge. Agree each reversal with its owner; place the irreversible step as late as possible.
- **Replays.** Key steps and undos by saga id and make them safe to repeat.
- **Two writes per step.** Saving and announcing can fail apart. Announce through an \[outbox\](outbox.md).
- **Readers see the middle.** Mark the order provisional until the saga finishes.

**Example.** Checkout runs three steps for order o-31. It charges 60 at 0 s and reserves stock at 0.4 s, which fails because the last item sold. The saga runs the undo for the charge, a refund of 60 keyed by saga id o-31, so a replayed refund pays only once. While the charge stands, the order shows as pending so no other screen reads it as paid. The customer's statement shows a charge and a refund rather than nothing, which is the cost. If the refund call itself fails, you retry it, and past a retry limit it goes to a queue that an operator watches.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one checkout cross three services when no database can lock them all? Each step commits in its own service's data before the next is issued, so nobody waits on anyone else's yes."
flowchart LR
    Coord["Saga coordinator"]
    subgraph S1["One local transaction"]
        Pay["Payment Service"]
        PayDB[("Payments table")]
    end
    subgraph S2["One local transaction"]
        Stk["Stock Service"]
        StkDB[("Stock table")]
    end
    Ship["Shipping Service"]
    Coord -->|"1 charge card"| Pay
    Pay -->|"2 commit"| PayDB
    Coord -->|"3 reserve stock"| Stk
    Stk -->|"4 commit"| StkDB
    Coord -->|"5 book shipment"| Ship
```

```mermaid caption="How does the same checkout run with no coordinator? Each service commits its step, publishes an event, and the next service reacts to it; a failure event makes the earlier services undo their own steps."
flowchart LR
    Pay["Payment Service"]
    Stk["Stock Service"]
    Ship["Shipping Service"]
    Bus[("Event bus")]
    Pay -->|"1 publish ChargeCommitted"| Bus
    Bus -->|"2 deliver ChargeCommitted"| Stk
    Stk -->|"3 publish StockReserved"| Bus
    Bus -->|"4 deliver StockReserved"| Ship
    Stk -.->|"publish StockFailed"| Bus
    Bus -.->|"deliver StockFailed, Payment refunds"| Pay
```

```mermaid caption="The happy path commits one local transaction per step. A failure anywhere triggers compensations that undo every already-committed step, in reverse order."
flowchart LR
    A["Order created"] -->|"charge"| B["Payment charged"]
    B -->|"reserve"| C["Stock reserved"]
    C -->|"ship"| D["Shipped, saga complete"]
    C -.->|"any step fails"| E["Compensate, refund payment"]
    E -.->|"reverse order"| F["Compensate, cancel order"]
```

## Variations
<!--meta block=variations-->

- **[Orchestration](./workflow-orchestration.md)** — A saga execution coordinator issues each step as a command and persists the saga's progress as a state machine. The transaction logic lives in one visible place instead of scattered across services. It suits many participants and keeps them loosely coupled, at the price of a coordinator that must itself be durable and highly available, or the whole flow stalls.
- **Choreography** — Each service publishes a [Domain Event](../../ddd/domain-event.md) when its step completes, and downstream services subscribe and react on their own. No central coordinator and no single point of failure, which suits a handful of participants; add more and the dependencies between them get hard to trace, because the flow is implicit across every participant's code.
- **Forward vs. backward recovery** — A failed step does not automatically mean undo. A platform-level failure — a timeout, a dropped connection, an instance that died — takes forward recovery: retry the local transaction and continue the sequence. An application-level failure — the payment was declined, the item is out of stock — takes backward recovery: compensate the steps that already committed. Classify the failure before choosing a direction, or a transient blip unwinds a saga that needed nothing but a retry.
- **[Compensating Transaction](../resilience/compensating-transaction.md)** — The undo for one committed step. It runs only for a step that fully committed and must be reversed in business terms; idempotent retries absorb transient errors and need no compensation.
- **Semantic lock** — Mark an entity provisional or pending while its saga is in flight, so concurrent readers and writers can detect the in-progress state instead of treating it as final.
- **Pivot step** — Place the one step that cannot be undone deliberately: everything before it stays compensable, and everything after it is driven forward on repeat — idempotent retries toward completion — rather than reversed. Once the pivot commits, the saga's only direction is through.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Avoids distributed locks and two-phase commit** — each service stays autonomous and available.
- **Scales horizontally**, since no participant blocks waiting on the others' votes.
- **The sequence of steps** and compensations documents the business process explicitly.
- **Works across heterogeneous datastores**; each service keeps its own transaction technology.

### Cons
<!--meta polarity=con-->

- **No isolation**: partial saga state is visible to other transactions mid-flight, unless masked by a semantic lock.
- **Every step needs a compensation designed for it**, including ones that feel irreversible.
- **A failure now spans several services** — tracing and debugging needs distributed context.
- **Compensations must themselves be idempotent and retry-safe**, and nothing compensates a compensation — route the ones that exhaust their retries to a dead-letter queue with an operator behind it.
- **Choreography hides the whole flow** — the flow exists only as the sum of every participant's subscriptions, so nobody can say where an order is. Thread a [Correlation Identifier](../../messaging/correlation-identifier.md) through every step, or move the sequence into an orchestrator that persists it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A business transaction spans multiple** services or databases with no shared transaction manager.
- **Two-phase commit is off the table**, or coupling every participant's availability is unacceptable.
- **Steps are naturally reversible, or an approximate rollback** — refund, cancel, release — is good enough.

### Avoid when
<!--meta polarity=avoid-->

- **The whole operation stays inside one service**, where a local transaction already gives you ACID.
- **A step is truly irreversible** and no compensation makes business sense.
- **You need strict isolation** or a single consistent view mid-transaction — sagas only give you eventual consistency.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — three steps, each carrying the undo that takes it back"
interface Step {
  run: (orderId: string) => Promise<void>;
  undo: (orderId: string) => Promise<void>;   // how this step is taken back
}

const steps: Step[] = [
  { run: (o) => payments.charge(o),  undo: (o) => payments.refund(o) },
  { run: (o) => stock.reserve(o),    undo: (o) => stock.release(o) },
  { run: (o) => shipping.book(o),    undo: (o) => shipping.cancel(o) },
];

async function runSaga(orderId: string): Promise<void> {
  const committed: Step[] = [];
  for (const step of steps) {
    try {
      await step.run(orderId);       // one service, one local transaction
      committed.push(step);
    } catch (err) {
      // Toy: in-memory list, no retry, no saga-id key, no dead-letter. Production needs
      // a durable step log and per-undo retry (see tradeoffs, con 4).
      for (const done of [...committed].reverse()) await done.undo(orderId);
      throw err;
    }
  }
}
```

```typescript summary="TypeScript — a forward-only KYC saga with terminal failure states"
type FlowState =
  | "pending" | "verifying" | "screening"
  | "cleared" | "rejected" | "dead";

interface Step {
  running: FlowState;                        // state held while the step runs
  run: (flowId: string, personaId: string) => Promise<void>;
}

const steps: Step[] = [
  { running: "verifying", run: (f, p) => idVendor.submit(f, p) },
  { running: "screening", run: (f, p) => sanctionsVendor.screen(f, p) },
  { running: "cleared",   run: (f) => outbox.enqueue(f, "flow.cleared") },
];

async function runFlow(flowId: string, personaId: string): Promise<void> {
  for (const step of steps) {
    await flows.setState(flowId, step.running);
    try {
      await step.run(flowId, personaId);
    } catch (err) {
      // No compensation: a submitted ID check cannot be un-submitted.
      // Failure is absorbed by a terminal state, not undone.
      await flows.setState(flowId, err instanceof Refused ? "rejected" : "dead");
      return;
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **Temporal** — A durable workflow engine: a workflow orchestrates activities, and your workflow code registers and runs the compensations on failure, so the orchestrated saga is explicit in code. Per-activity RetryPolicy (maximum attempts, backoff coefficient) and start-to-close timeouts are the retry and timeout knobs, and workflow state survives worker crashes. {#wild-temporal}
- **AWS Step Functions** — State machines whose Retry and Catch fields, with a rollback branch, are the way AWS documents implementing sagas: each state invokes a step, a Catch routes failures to compensating states, and TimeoutSeconds bounds how long a step may hang. {#wild-step-functions}
- **Axon Framework** — Ships a first-class SagaManager on the Java virtual machine (JVM): a @Saga class uses @SagaEventHandler methods correlated by an association property to drive event-choreographed sagas, tracking each saga instance's state and firing compensations as later events arrive. {#wild-axon}
- **NServiceBus** — Models a saga as a message-driven state machine: the handler is woken by each correlated message, its state is persisted between them, and timeouts are themselves messages the saga schedules for itself. {#wild-nservicebus}
- **Wolverine** — Combines saga state handling with a transactional outbox in one library, so the state change and the messages it emits commit together rather than being two writes that can disagree. {#wild-wolverine}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Step retry policy** — Max attempts and backoff before a transient step failure is treated as fatal and turns the saga around. Size it from the participant's observed recovery time, since every attempt past that point is a compensation you paid to avoid. Take p99 recovery from past incidents or per-step latency, set the backoff budget just above it, and cap attempts so the retries fit inside the step timeout.
- **Step and saga timeouts** — How long one step, and the whole flow, may stay open before it is abandoned. The saga timeout doubles as the bound on how long provisional state stays visible to everyone else.
- **Failure classification** — Which error codes count as a business rejection and which as a platform failure. The mapping decides whether a failed step is driven forward or unwound, so keep it somewhere a domain expert can read and change.
- **Compensation retry and escalation** — How many times a failed compensation is retried, and where it lands when the retries run out. Nothing compensates a compensation, so the landing spot has to be explicit.
- **In-flight saga concurrency** — A cap on how many sagas run at once, bounding both load on the participants and how much half-applied state the rest of the system can see at any moment.

### Signals to watch
<!--meta polarity=signal-->

- **Open saga count and age** — How many sagas are in flight and how old the oldest is. A growing tail of long-lived sagas often means steps are stalling or compensations are not firing; check per-step failure rate to tell which. Alert when the oldest saga's age passes the saga timeout.
- **Compensation / rollback rate** — Fraction of sagas that end in compensation rather than completion. A spike points at a specific failing step dragging whole transactions into rollback.
- **Per-step failure rate** — Failures attributed to each participant. Isolates which service is forcing sagas to unwind, since a failure now spans several services.
- **Saga duration p99** — End-to-end time from first step to final commit or compensation — the window during which partial, un-isolated state is visible to everyone else.

### Failure modes under load
<!--meta polarity=failure-->

- **Compensation fails** — A step committed but its compensation cannot complete; the saga is stuck half-applied and no automatic path exists to fix it. It must be alerted and routed to manual repair.
- **Non-idempotent replay** — A retried or redelivered step applies twice — a double charge, a double reservation — because the step or compensation was not keyed by saga id.
- **Stuck saga holds a semantic lock** — A step neither completes nor times out; the entity stays flagged provisional forever, blocking or confusing concurrent readers that respect the lock.
- **Dirty reads of partial state** — Because a saga gives no isolation, other transactions observe intermediate state — an order that exists but is not yet paid — and act on it before the saga finishes or rolls back.
- **A blip read as a rejection** — Under load the participants time out, the classifier files those timeouts as business failures, and sagas that needed one retry unwind instead — so the compensations become their own load on services that were already struggling.

### Readiness checklist
<!--meta polarity=check-->

- Every step has a compensation designed for it, including steps that feel irreversible
- Steps and compensations are idempotent and keyed by saga id so replays are safe
- The one step that cannot be undone is named as the pivot, and everything after it is driven forward on retry rather than reversed
- Somebody is on the other end of the dead-letter path, and they have been shown what a stuck compensation looks like before it happens
- A correlation id threads through every step for distributed tracing of a failure
- The classifier was exercised against a participant that hangs, not only one that declines — that is the case it gets wrong

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [CAP Theorem](../../../themes/cap-theorem.md) — Choose availability, then reconcile with eventual consistency {#fluency-cap-theorem}
- [Consistency & Replication](../../../themes/consistency-and-replication.md) — Eventual consistency across services {#fluency-consistency-and-replication}
- [Multi-Step Processes](../../../themes/multi-step-processes.md) — Sequence local transactions, compensating on failure {#fluency-multi-step-processes}
- [Event Modeling](../../../themes/event-modeling.md) — A policy on the wall becomes a coordinated process {#fluency-event-modeling}

<!-- fluency:end -->

## Check yourself
<!--meta block=selfcheck-->

> **Why can another transaction see a half-finished saga?**
>
> A saga has no isolation, so partial state is visible mid-flight unless a semantic lock masks it, see [con 1](saga.md#tradeoffs-con-1).

> **What do you do with a compensation that keeps failing?**
>
> Nothing compensates a compensation, so route it to a dead-letter queue with an operator behind it, see [con 4](saga.md#tradeoffs-con-4).

> **When is a saga the wrong tool?**
>
> When one service owns the whole operation, a local transaction already gives you ACID, see [avoid 1](saga.md#usage-avoid-1).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Outbox](./outbox.md) — Publish each saga step reliably via the outbox
- [Inbox](./inbox.md) — Receive saga steps reliably via the inbox
- [Domain Event](../../ddd/domain-event.md) — Choreographed sagas react to domain events
- [CQRS](../../architecture/cqrs.md) — Sagas often drive read-model updates
- [Correlation Identifier](../../messaging/correlation-identifier.md) — Correlate the steps of one saga
- [Workflow Orchestration](./workflow-orchestration.md) — A saga's steps can be driven by a durable orchestration engine rather than choreographed by events
- [Sweeper](./sweeper.md) — A step that neither completes nor times out emits no event — a sweep is what expires it and starts the compensation
- [Minimize Coordination](../../../principles/minimize-coordination.md) — A saga is what multi-step work looks like once the global lock is gone
- [Functional Partitioning](../routing/functional-partitioning.md) — It is what a cross-area write becomes once data is split by function, because no store spans the boundary
- [Microservices](../../architecture/microservices.md) — The saga exists because services own their data separately.
- [Aggregate](../../ddd/aggregate.md) — Each saga step is one transaction on one aggregate.

**Alternative to**

- [Two-Phase Commit](./two-phase-commit.md) — A saga gives up the all-or-nothing isolation of two-phase commit so no participant waits on the slowest.

**Requires**

- [Idempotency](../../messaging/idempotency.md) — Steps and compensations must be replay-safe

**Composed of**

- [Compensating Transaction](../resilience/compensating-transaction.md) — A saga undoes work with compensating transactions

**Prevents**

- [Dual-Write Inconsistency](../../../hazards/dual-write-inconsistency.md) — Replaces the distributed transaction the dual write silently assumed
- [Distributed Monolith](../../../hazards/distributed-monolith.md) — Insisting on atomic cross-service transactions is one of the ways services end up welded together.

**Exposed to**

- [Retry Storm](../../../hazards/retry-storm.md) — Can fall into retry storm when each step's retries and its compensations multiply load on a service that is already failing

**Demonstrated by**

- [Robinhood](../../../designs/robinhood.md) — consistency across services with no shared transaction is held by ordered steps plus a reconciler, not an atomic commit
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — sequencing a persona's identity check and sanction screening as local transactions with explicit failure terminals, no transaction manager spanning the vendors
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — a long-running flow whose compensation is a recorded terminal rather than a rollback across third parties

**Implemented by**

- [Workflow orchestrators](../../../comparisons/workflow-orchestrators.md) — Which engine runs your sagas — Temporal, Airflow, Argo, Prefect or the cloud state machines.
- [Compute](../../../capabilities/compute.md) — A managed workflow engine runs the orchestrated saga and survives a crash mid-way.

<!-- relationships:end -->
