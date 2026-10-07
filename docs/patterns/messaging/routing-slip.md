---
title: Routing Slip
description: Carries the list of processing steps inside the message itself
area: messaging
owner: Oleksandr Derechei
tags: [messaging, decoupling, extensibility]
status: stable
solves: [Every new kind of message means editing the central router that all other kinds share, Different messages need different steps in different orders and a fixed pipeline needs a branch for each mix, "I want each processing step to know only its own work, not what comes before or after", Teams add steps to the flow but must ask the owner of one big routing table first]
---

# Routing Slip

Attaches the ordered list of processing steps to the message itself, so each step does its work and passes the message to the next address on the list.

## What it is
<!--meta block=description-->

Different messages often need different sequences of steps, such as validate, enrich, score and notify, chosen by the message type. Hard-coding those sequences in a central router means every new route changes the router that every other route shares. A **routing slip** attaches the ordered list of steps to the message. Each processor performs its step, then forwards the message to the next address on the slip. The route travels with the data, so steps stay independent.

## Explained
<!--meta block=explain-->

A routing slip is a list of steps attached to the message itself. Each processor does its step, removes its entry and forwards the message to the next address on the list, so the route is set when the message is created and no central component holds it. Choose it over a [content-based router](./content-based-router.md) when each message needs its own sequence and there are many steps, so a fixed pipeline would need a branch for every combination. Choose a central orchestrator instead when you need one place to see progress or to undo earlier steps.

- **No central view.** Nothing holds progress; carry a correlation id and trace each hop.
- **The route is fixed once sent.** A step cannot react to a distant result unless it edits the slip; allow that only under named rules.
- **Failure and undo are yours.** A failed step strands the message; use a dead-letter channel and keep undo steps explicit.

**Example.** A lender handles 10,000 applications a day, 7,000 standard and 3,000 premium. A standard slip is validate, credit-score, fraud-check, notify. A premium slip swaps fraud-check for manual-review. Each step takes about 120 ms, so a standard application finishes in about 500 ms with queue hops. Adding a new route, such as a fast-track with two steps, means changing only the creator. The cost shows when credit-score is down for 5 minutes: at about 7 applications a minute, about 35 messages wait in its queue, and an operator finds them by correlation id, since no component holds the route and each hop logs the id.

## How it works
<!--meta block=structure-->

```mermaid caption="Where is the route stored? In the message. At steps 2 and 4 each processor reads the head of the slip and forwards to it, so no component but the creator knows the whole sequence, and an empty slip at step 6 means the message is done."
flowchart LR
    Cre["Creator"]:::ext
    QA[("Queue A")]
    PA["Step A"]
    QB[("Queue B")]
    PB["Step B"]
    QC[("Queue C")]
    PC["Step C"]
    Done["Finished"]:::ext
    Cre -->|"1 message with slip A, B, C"| QA
    QA -->|"2 receive"| PA
    PA -->|"3 do work, forward with slip B, C"| QB
    QB -->|"4 receive"| PB
    PB -->|"5 do work, forward with slip C"| QC
    QC -->|"6 receive"| PC
    PC -->|"7 slip empty, hand on"| Done
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What happens when a step fails? The message stops where it is. The message stays at the failed step with the rest of the slip intact, so a retry resumes there, and a message that keeps failing goes to the dead-letter channel. Only a slip with undo keeps a list of finished entries."
sequenceDiagram
    autonumber
    participant A as Step A
    participant B as Step B
    participant D as Dead-letter channel
    participant C as Step C
    A->>B: message, slip B, C
    B->>B: attempt 1 fails
    B->>B: attempt 2 fails
    B->>D: message, slip B, C, reason
    Note over D: an operator fixes the cause and resends to B
    D->>B: resend, slip B, C
    B->>C: message, slip C
```

The slip is data: a list of destination addresses, often with a position marker that says which entry is next. A processor reads the next entry, does its work and sends the message there. It adds no routing logic of its own, which is what lets steps be written, deployed and scaled separately.

The creator decides the route, so it needs to know the available steps and which sequence fits the message. That can be a fixed table or rules over the content, and it is the one place a new route is added. A processor may edit the slip, for example to insert a manual review after a risky score. Allow that only under agreed rules, because an edit makes the route harder to predict.

## Variations
<!--meta block=variations-->

- **Static slip** — The creator sets the full route once and no step changes it. The route is easy to read off a message, and it cannot react to what a step finds.
- **Dynamic slip** — A step may insert, skip or reorder later entries based on its result, such as adding a manual review after a high fraud score. It lets the route adapt, and it makes the path harder to predict and test.
- **Conditional entries** — Each entry carries a condition and is skipped when the condition fails. One slip then serves several message types, with the logic in the data.
- **Slip with undo** — Each entry pairs a step with the step that reverses it, so a failure can walk back through the completed entries. It moves toward a [saga](../distributed/coordination/saga.md) and carries its cost: every step needs a working undo.
- **Central orchestrator instead** — One component holds the route and calls each step in turn, as in [workflow orchestration](../distributed/coordination/workflow-orchestration.md). It gives one place to see progress and to undo, and it becomes a component every route depends on.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No central router to change** — a new route is a new slip, and existing steps and routes stay untouched.
- **Steps stay independent** — each one knows its work and the message format, never the order around it.
- **Per-message routes** — the sequence can differ for every message, which a fixed pipeline would need many branches to express.
- **Steps are reusable** — the same step appears in many routes, so it is built and scaled once.

### Cons
<!--meta polarity=con-->

- **No single view of progress.** The route lives in flight, so add a correlation id to each hop and trace it with [distributed tracing](../distributed/resilience/distributed-tracing.md).
- **The slip couples steps to addresses.** Renaming a queue breaks messages already in flight, so use stable logical names and map them to queues at the edge.
- **Failure and undo are yours.** A failing step strands the message, so send it to a [dead-letter channel](./dead-letter-channel.md) and keep any undo steps explicit.
- **A dynamic slip is hard to test.** A step that edits the route makes the path depend on data, so restrict edits to a few named rules.
- **The message grows** with the length of the slip, which matters for routes of dozens of steps.
- **Redelivery repeats a step.** Consume, pop the entry and forward is not one atomic action, so under at-least-once delivery a step can run twice; make every step [idempotent](./idempotency.md) and acknowledge the input only after the forward succeeds.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The sequence of steps differs per message**, and a fixed pipeline would need a branch for every combination.
- **Steps are owned by different teams** and should be deployable without a change to a shared router.
- **New routes appear often**, and each one should be a data change at the creator and not a code change in the middle.

### Avoid when
<!--meta polarity=avoid-->

- **Every message follows the same fixed sequence**, so a plain pipeline is simpler and easier to see.
- **You need one place to show progress or to undo steps**, which a central orchestrator provides directly.
- **A step must react to what a distant step found**, so the route is really a decision tree that belongs in one component.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a processor does its step, then forwards to the next address on the slip"
interface Envelope<T> {
  correlationId: string;
  slip: string[];        // addresses still to visit, head first
  body: T;
}

// The same wrapper serves every step: do the work, then follow the slip.
function step<T>(work: (body: T) => Promise<T>) {
  return async (msg: Envelope<T>) => {
    const body = await work(msg.body);
    const [next, ...rest] = msg.slip;
    if (next === undefined) return done(msg.correlationId, body); // slip empty: finished
    await send(next, { ...msg, slip: rest, body });               // forward with the head removed
  };
}

// The creator is the only place that knows a route.
await send("validate", {
  correlationId: "app-4411",
  slip: ["credit-score", "fraud-check", "notify"],
  body: application,
});
```

## In the wild
<!--meta block=wild-->

- **Apache Camel routingSlip** — The routingSlip() EIP step reads a list of endpoint addresses from an expression, usually a message header, and sends the message to each in turn. Camel runs the slip inside that one step, so the hops are calls made from one route and the receiving endpoints do not each forward the message. {#wild-camel-routing-slip}
- **Spring Integration routing slip** — A routingSlip header on a message holds the route, and a router that supports it reads the next entry and forwards, with strategies to compute the next hop. {#wild-spring-integration-routing-slip}
- **MassTransit Courier** — MassTransit builds a routing slip of activities for a message, runs each activity in turn, and can run the compensation of completed activities when one fails. {#wild-masstransit-courier}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Retry count per step** — How many times a step retries, with backoff, before the message goes to the dead-letter channel; start from how long the dependency's typical outage lasts. Too many hides a persistent fault; too few dead-letters on a blip.
- **Maximum slip length** — A cap on entries, set at the longest legitimate route plus a margin and enforced at creation. It also stops a dynamic slip from growing without end.
- **Slip edit rules** — Which steps may insert or skip entries and where. Fewer rules make the route predictable.
- **Address naming** — Logical step names mapped to queues at the edge, so renaming a queue does not break messages in flight.
- **Maximum hops per message** — A hop counter in the envelope. A message that passes the slip's original length plus the inserts you allow goes to the dead-letter channel, which ends a route loop.

### Signals to watch
<!--meta polarity=signal-->

- **Queue depth per step** — Where messages wait. A growing queue at one step marks the slow or failing step.
- **End-to-end latency per route** — Time from creation to an empty slip, split by route. A rise on one route points at one of its steps.
- **Dead-letter rate per step** — Messages that exhausted retries at each step, which locates a persistent fault.
- **Age of the oldest message in flight** — Time since creation of the oldest message with a non-empty slip. It shows stuck messages before any step reports an error. Alert when it passes a multiple of that route's slowest normal end-to-end latency (signal 2).

### Failure modes under load
<!--meta polarity=failure-->

- **Stranded message** — A step fails for good and nothing else knows the message exists, so the work silently never finishes.
- **Route loop** — A dynamic slip that re-inserts an earlier step sends the message round forever.
- **Stale address** — A queue is renamed or removed while messages carrying its old name are in flight.
- **Slow step backs up the route** — One step takes longer than its arrival rate and the queue before it grows without bound.
- **Duplicate step run** — A retry or redelivery repeats a step's side effect, such as sending a notification twice.

### Readiness checklist
<!--meta polarity=check-->

- Every message carries a correlation id that each hop logs
- Addresses in the slip are stable logical names
- A message that exhausts its retries lands in a dead-letter channel someone watches
- Slip length is capped and edit rules are written down
- Every step can run twice on the same message without harm

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Attach the list of steps to a message so each processor forwards it to the next. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Pipe-and-Filter](../architecture/pipe-filter.md) — The slip chooses which filters a message passes through, and in what order
- [Dead Letter Channel](./dead-letter-channel.md) — A step that exhausts its retries sends the stranded message here

**Alternative to**

- [Content-Based Router](./content-based-router.md) — The route travels with the message as an ordered list, so no central router has to know every sequence
- [Workflow Orchestration](../distributed/coordination/workflow-orchestration.md) — Each processor reads the next address off the slip, so there is no coordinator to run

**Often confused with**

- [Recipient List](./recipient-list.md) — One copy walks the steps in order, each forwarding to the next; a recipient list sends a copy to every recipient at once.

**Exposed to**

- [Unbounded Queue](../../hazards/unbounded-queue.md) — A slow step's queue grows without bound while the slip keeps feeding it

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that sends a message along a route it carries as a ready-made building block.

<!-- relationships:end -->
