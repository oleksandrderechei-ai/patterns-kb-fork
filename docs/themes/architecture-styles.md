---
title: Architecture Styles
description: "Choosing the shape of a whole system, and honouring the constraints that make its benefits appear"
area: themes-shaping
owner: Oleksandr Derechei
tags: [modularity, decoupling, maintainability]
status: stable
aliases: [architectural styles]
---

# Architecture Styles

An architecture style is a family of architectures sharing one set of constraints on which elements may appear and how they may relate. Honour the constraints and specific properties emerge; conform in name only and none of them do. This theme walks ten styles, four of them shapes inside one deployable, the axes on which each one charges you, and how to choose for one subdomain at a time.

## The question
<!--meta block=description-->

Two teams build the same application and get systems that share no shape: one a stack of layers in a single deployable, the other forty services trading messages over a broker. Each chose constraints, which kinds of element may exist and how they may relate, and the diagram followed. Constraints buy properties and each relaxed constraint loses one, so the work is deciding which constraints your domain can honour and naming what you give up.

## Explained
<!--meta block=explain-->

An architecture style is a set of rules about which kinds of parts may exist and how they may call each other, and the shape of your system follows from the rules. Each rule buys a property. If every service owns one capability and its own data, you can release one without the others and a failure stays inside it unless other services wait on it. Break a rule, such as two services sharing a database, and the property goes while the network calls stay. Choose by how complicated your domain is, not by fashion. [Layers](../patterns/architecture/layered.md) stacked in one program (screens, logic, data) suit a plain business domain. A web front end, a queue and background workers ([web-queue-worker](../patterns/architecture/web-queue-worker.md)) suit a simple domain with a few heavy jobs. [Microservices](../patterns/architecture/microservices.md), many small services released on their own, suit a complicated domain that changes often. Too simple a style lets code tangle into a [Big Ball of Mud](../hazards/big-ball-of-mud.md), a system nobody can safely change. Rank your goals first, such as launch date or budget, and revisit the choice when they change.

- **Network hops.** Every split turns a function call into a network call, so count the hops on your slowest path before you split.
- **Tooling bill.** Distributed styles need correlated logs, tracing and automated releases, or your first outage cannot be read.
- **Extra coordination.** A style more elaborate than your domain costs coordination nobody asked for, so keep the simplest style that meets your top goal.

**Example.** A 4-person team runs a shop with 2,000 orders a day. As one layered program it deploys in one step and checkout calls everything in-process. Split into 6 services, checkout calls 4 of them in a chain at 5 ms a hop, which adds 20 ms and 6 release pipelines for a team that never needed independent releases. The real pain is the invoice PDF, which takes 30 s and blocks the web request. They move only that job behind a queue with one worker. The page answers at once, and the cost is that the queue can deliver a message twice, so the worker must check the order number before it sends a second invoice.

## The trade-space
<!--meta block=tradespace-->

Constraints create challenges as well as benefits. Weigh a style for one subdomain and one [bounded context](../patterns/ddd/bounded-context.md) rather than for the organization at large, and weigh it on the axes below — where every style past the simplest charges you, whether or not you planned for the charge.

- **Complexity.** Match the architecture's complexity to the domain's. Too simple and dependencies go unmanaged until the structure decays into a [Big Ball of Mud](../hazards/big-ball-of-mud.md); too elaborate for the domain and you pay coordination costs nobody in the business asked for.
- **Asynchronous messaging and eventual consistency.** A broker between two components decouples their lifecycles and makes a failed message retryable, so neither has to be running when the other is. In exchange every consumer must tolerate duplicate delivery, and every reader must tolerate a view that is behind.
- **Interservice communication.** Each split turns function calls into network calls. Chains of them surface as latency a user feels and as congestion the platform bills for, and two components that talk constantly are telling you the boundary between them is wrong.
- **Manageability.** Deploying, monitoring and keeping N services healthy is not N times the work of keeping one healthy — it is a different job, needing correlated logs, distributed tracing and automated rollout. Adopt a distributed style without them and your first incident is unreadable.

Prioritise before you pick. Name the business drivers, translate them into architecture characteristics — a hard launch date pushes maintainability, testability and reliability up the list, while a tight budget pushes feasibility and simplicity up instead — and rank them with the stakeholders who own the workload rather than with the architects alone.

Then treat the choice as revisable. Measure the characteristics you ranked, check that the constraints are still being honoured, and revise — and because changing architectural direction later is expensive, spend more on the first decision than feels comfortable. Five of the ten styles below live inside one deployable and answer a different question from the rest: how the code is cut, not how many things you deploy. Layered cuts by tier, [Hexagonal](../patterns/architecture/hexagonal.md) and [Microkernel](../patterns/architecture/microkernel.md) decide which way dependencies point, and [Vertical Slice](../patterns/architecture/vertical-slice.md) and [REPR](../patterns/architecture/repr.md) cut by operation instead of by tier. Styles combine rather than compete: event-driven is commonly the primary style, with services, [pipes and filters](../patterns/architecture/pipe-filter.md) or [event sourcing](../patterns/architecture/event-sourcing.md) layered into it.

```mermaid caption="The first axis is a match, not a maximum: only one of the two mismatches looks like progress while you are making it."
flowchart LR
    D["Domain complexity"] --> M{"Match?"}
    A["Architecture complexity"] --> M
    M --> |"Architecture too simple"| S["Dependencies go unmanaged, structure decays"]
    M --> |"Matched"| K["Constraints hold, properties appear"]
    M --> |"Architecture too elaborate"| E["Coordination cost with no domain to justify it"]
```

## The ten styles
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Layered](../patterns/architecture/layered.md) {#tour-layered}

Divide the application into horizontal layers — presentation, business logic, data access — each with one responsibility, each calling only into the layer below. Every mainstream framework ships this shape already, so a new hire is productive on day one. The bill is agility: a horizontal split means one feature cuts across every layer, so change ripples the full height of the stack.

### [Hexagonal](../patterns/architecture/hexagonal.md) {#tour-hexagonal}

The core owns ports and adapters implement them, so a driver upgrade edits an adapter and never business rules. It is the alternative to layered when infrastructure churn keeps contaminating the domain.

### [Vertical Slice](../patterns/architecture/vertical-slice.md) {#tour-vertical-slice}

One request is owned end to end, so a one-line feature change stays in one folder instead of spreading across five. You accept some duplication between slices to keep them independent.

### [REPR](../patterns/architecture/repr.md) {#tour-repr}

Request, endpoint and response sit in one place per operation, with the route declared inside the endpoint. It is what a slice's transport edge looks like when the endpoint is its own class, and it avoids a controller that collects every action's dependencies.

### [Microkernel / Plugin](../patterns/architecture/microkernel.md) {#tour-microkernel}

The core stays small enough to audit and changes almost never, while every feature arrives as a plug-in behind a contract. A bad feature can then be unloaded or isolated without editing the core, and a crash stays out of the host only if you pay for sandboxing or process isolation.

### [Web-Queue-Worker](../patterns/architecture/web-queue-worker.md) {#tour-web-queue-worker}

A web front end takes requests, a queue holds the work, and a back-end worker does whatever is resource-intensive, long-running or batch. The two halves scale independently and the front end does not wait on the worker, which is the benefit. The queue can deliver a message twice, so the worker must tolerate a repeat, and a full queue still backs up the front end. Left unwatched, both halves keep gaining features until each is a monolith of its own.

### [Microservices](../patterns/architecture/microservices.md) {#tour-microservices}

Decompose functionally instead of horizontally: small autonomous services, one business capability each inside one bounded context, each owning its data, talking through application programming interfaces (APIs), deployed on their own schedules. Teams then ship without coordinating releases. In return you take on service discovery, cross-service data consistency and distributed management as real, staffed work.

### [Event-Driven](../patterns/architecture/eda.md) {#tour-eda}

Producers emit streams of events and consumers react in near real time, joined by a channel rather than by an address. Adding a consumer touches no producer, and a consumer that is down delays no producer, though the views it feeds fall behind until it returns. What you inherit is delivery and ordering as explicit design problems, plus eventual consistency in every view built from the stream.

### [Big Data](../patterns/architecture/big-data.md) {#tour-big-data}

Divide a dataset too large for one traditional database into chunks and process them where they sit: batch paths over history, stream paths for immediate insight, and analytical stores shaped for the questions reporting asks. The style exists because the data outgrew the query engine, not because the domain is complicated.

### [Big Compute](../patterns/architecture/big-compute.md) {#tour-big-compute}

Split one computationally intensive problem into discrete tasks, allocate thousands of cores to them, then release the cores when the run finishes. Simulation and rendering fit it, and the design questions are task granularity and how results are gathered — not how services talk.

<!-- tour:end -->

## How to decide
<!--meta block=decide-->

Start from the nature of the problem, and read the table by its middle column: a style is mostly a claim about how dependencies are managed, and the domain that suits it is the one whose dependencies already look like that.

| Style | How it manages dependencies | Domain it suits |
| --- | --- | --- |
| [Layered](../patterns/architecture/layered.md) | Horizontal layers, each calling only the layer below, usually in one deployable | A traditional business domain where updates are infrequent |
| [Hexagonal](../patterns/architecture/hexagonal.md) | Every dependency points inward at the core, through ports the outside implements | A domain whose rules you want to test and reuse apart from the framework and the database |
| [Vertical Slice](../patterns/architecture/vertical-slice.md) | One request owned end to end, with no shared tiers between features | A domain built feature by feature, where shared layers add files and no value |
| [REPR](../patterns/architecture/repr.md) | Request, endpoint and response for one operation in one place | A web API of many small operations that several people edit at once |
| [Microkernel](../patterns/architecture/microkernel.md) | A minimal core plus plug-ins that carry every feature | A product that other teams or customers extend, and where one feature must not crash the rest, provided plug-ins can be isolated from the host |
| [Web-Queue-Worker](../patterns/architecture/web-queue-worker.md) | Front end and back-end jobs decoupled by asynchronous messaging | A relatively simple domain with some resource-intensive tasks |
| [Microservices](../patterns/architecture/microservices.md) | Vertically decomposed services calling each other through APIs | A complicated domain with frequent updates |
| [Event-Driven](../patterns/architecture/eda.md) | Producers and consumers joined by a channel; each subsystem keeps its own view of the data | Sensor fleets and real-time systems, or any domain where new consumers must join without editing the producers |
| [Big Data](../patterns/architecture/big-data.md) | Divide a huge dataset into chunks, process each locally in parallel | Batch and real-time analysis, and predictive work over history |
| [Big Compute](../patterns/architecture/big-compute.md) | Allocate one problem's data across thousands of cores | Compute-intensive domains such as simulation |

## Related areas
<!--meta block=siblings-->

- [Service Boundaries](./service-boundaries.md) — Where the vertical decomposition lines actually go, once you have chosen to draw them.
- [Microservices Design](./microservices-design.md) — Everything the microservices style leaves you to design: communication, the client edge, and data.
- [Scalability](./scalability.md) — The characteristic that most often forces a style to be re-decided.
