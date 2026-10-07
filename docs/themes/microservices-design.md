---
title: Microservices Design
description: "Once the boundaries are drawn: how services talk, how clients reach them, and who owns which data"
area: themes-shaping
owner: Oleksandr Derechei
tags: [integration, decoupling]
status: stable
---

# Microservices Design

Drawing the boundaries is the first half of the job. The second half is three questions with real bills attached: how services communicate, how clients reach them without learning your topology, and how data stays usable when every service owns a private store and none of them holds the whole picture.

## The question
<!--meta block=description-->

Once service boundaries are right, every function call becomes a network call that can time out or arrive twice, clients must find services and prove who the user is, and a join now spans two databases. Three questions carry the theme: how services talk and whether the caller waits, how clients reach them, and how data stays usable. One rule drives the answers: services never share a schema.

## Explained
<!--meta block=explain-->

Once you split a system into services, three problems arrive. Function calls become network calls that can time out or be answered twice, clients must find the right service and prove who the user is, and a join across two services spans two databases you cannot query together. The rule behind most answers is that two services never share tables, because then every column change needs both teams and you lose independent releases. For each call ask whether the caller needs the answer. If it does, call the other service and wait, with a timeout and a [circuit breaker](../patterns/distributed/resilience/circuit-breaker.md), a gate that stops calls to a service known to be failing. If others merely observe that something happened, publish an [event](../patterns/ddd/domain-event.md) to a broker, a middleman that holds messages. That lets you add a subscriber without touching the sender. For a query that needs data from two services, keep a copy fed by their events.

- **Duplicates.** Events can arrive twice, so make consumers safe to repeat.
- **Delay and upkeep.** Queues add delay when they back up, and a broker is one more system to run, so watch queue depth.
- **Lagging copies.** A copy built from events lags the source, so show its age or accept a few seconds of delay.

**Example.** Placing an order calls payment, which must answer, so it is a synchronous call with a 2 s timeout and takes about 100 ms. It then publishes OrderPlaced for email, warehouse and analytics. If those three were called in a chain at 100, 150 and 200 ms, the customer would wait 550 ms. With events they wait only for payment, about 100 ms, and the warehouse can be down for an hour and catch up if the broker keeps messages that long. The cost is that the warehouse may receive OrderPlaced twice, so it checks the order number first. A sales dashboard needs customer and order data, so it reads an event-fed copy a few seconds behind.

## The trade-space
<!--meta block=tradespace-->

There are two ways for one service to reach another: call its API and wait for the response, or send a message and carry on while somebody processes it later. Keep the distinction clean, because one word covers two ideas. Asynchronous I/O means the calling thread is not blocked, which is a performance detail. An asynchronous protocol means the sender never waits for a reply. A plain HTTP request-response call is synchronous however the client implements it.

What asynchronous messaging buys you:

- **Reduced coupling.** The sender names a channel, not a consumer, so it need not know who reacts or where they run.
- **Multiple subscribers.** Several consumers take the same event, and adding the fourth touches nothing that publishes it.
- **Failure isolation.** The sender can still publish while the consumer is down, provided the broker is up and holds the message, and the consumer catches up on recovery. Every service has its own lifecycle and is mid-upgrade at some point; a synchronous API fails the whole operation whenever the callee is not up, unless the caller has a fallback.
- **Responsiveness.** An upstream service answers without waiting on the services downstream of it. In a chain A to B to C, synchronous waiting stacks all three latencies onto the user.
- **Load levelling.** A queue absorbs the arrival rate, so receivers work at their own pace instead of the sender's.
- **Checkpointed workflows.** A queue records where a multi-step process got to, one step at a time.

What it charges:

- **Infrastructure coupling.** The system is built on one broker's semantics, and swapping it later is a migration rather than a configuration change.
- **Latency.** End-to-end time rises as soon as queues carry depth, and depth is usually how you find out.
- **Cost.** At high throughput the messaging tier is a line item, not a rounding error.
- **Complexity.** Duplicates have to be handled by deduplication or idempotency, and request-reply needs a second queue plus a way to match each reply to its request.
- **Throughput.** Queue semantics mean at least one enqueue, one dequeue and some locking inside the broker per message, so the queue itself can become the bottleneck. Batching helps and complicates the code; where you do not need queue semantics, an event stream may serve better.

A worked mix, from one system: a public representational state transfer (REST) API at the ingestion edge, because clients expect request-response; asynchronous messaging from ingestion into the scheduler, chosen purely for load levelling; synchronous internal calls where the caller needs each answer and any failure should fail the whole operation; and asynchronous events for status updates that other services merely observe, so adding a subscriber never touches the main workflow path.

Failures split in two, and only one of them is a retry. A transient failure — a timeout, a refused connection — resolves itself, so retry it with capped exponential backoff and jitter, at one layer of the call chain only and only for idempotent calls, because retries multiplied across layers amplify an outage (see [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md)). A non-transient one fails the business transaction and leaves it partially complete, which is a coordination problem rather than a communication one: [Multi-Step Processes](./multi-step-processes.md) covers sequencing local commits and compensating for whatever already ran, and [Saga](../patterns/distributed/coordination/saga.md) is the pattern underneath it.

Private stores turn "which database" into a per-service question, and the access pattern answers it. A service holding in-flight state that clients poll constantly wants read and write throughput far more than long-term durability, and runs no complex queries — a key-value store, with short-lived rows. A history service ingesting those same events for analysis wants the opposite: schema-on-read storage (structure applied when you query) it can scan in bulk, partitioned by date. That choice makes a single-id lookup slow, so it keeps a smaller copy in something tuned for lookup and ages rows out of it on a schedule. A service holding many records queried only by id, written heavily and never joined, fits a document store. Three services, three engines, and the cost is three things to operate rather than one. A service that reads another's data on every request fails whenever that owner is down, so [Event-Carried State Transfer](../patterns/messaging/event-carried-state-transfer.md) puts the fields in the change event and lets each consumer keep a local copy, which is behind by the event lag.

```mermaid caption="Ask it per call, not per system: the same pair of services will use more than one of these."
flowchart TD
    Q{"Does the caller need the answer to continue?"}
    Q --> |"Yes, and a failure should fail the operation"| S["Synchronous call, with a timeout and a breaker"]
    Q --> |"No, the work must still happen"| M["Queue the message: load levelling, retry on recovery"]
    Q --> |"No, others merely observe"| E["Publish an event: many subscribers, none coupled to you"]
```

## The patterns that answer the three questions
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [API Gateway](../patterns/distributed/routing/api-gateway.md) {#tour-api-gateway}

Exposing services straight to clients hands every client your topology and repeats your authentication check in every service. A gateway intercepts the traffic instead: it routes each request to the right service, aggregates a fan-out into one response, and offloads the cross-cutting work — transport layer security (TLS) termination, authentication, rate limiting, caching, logging. The rule that matters most is negative. Keep business rules out of it, or the gateway becomes a shared dependency and couples the services through the thing that was meant to decouple them.

### [Backend-for-Frontend](../patterns/distributed/routing/bff.md) {#tour-bff}

One gateway serving a mobile app, a web app and a partner integration compromises on all three. Give each client class a thin backend of its own, owned by that client's team, calling downstream services and returning exactly the payload those screens need. You pay one more deployable per client class, and you get to change the mobile contract without asking the partner team.

### [Ambassador](../patterns/distributed/routing/ambassador.md) {#tour-ambassador}

Every service needs retries, timeouts, circuit breaking, transport layer security (TLS) and metrics on its outbound calls. Written as a library, that logic is duplicated once per language your teams chose and upgraded on each team's schedule. An ambassador is a proxy sharing the service's host and lifecycle: the service dials a local address and the proxy does the real talking, so the policy becomes configuration rather than a dependency in every build. Deployed as a [Sidecar](../patterns/distributed/routing/sidecar.md), it is one proxy process per service instance.

### [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) {#tour-health-endpoint}

A call has to reach an instance that is actually working, and there may be hundreds of them. A cheap route the platform polls — a bare 200, or a small body reporting the caches, queues and downstream connections the service depends on — is how the load balancer and the scheduler tell a dead instance from a slow one and stop routing to it.

### [Service Discovery](../patterns/distributed/routing/service-discovery.md) {#tour-service-discovery}

Instances get whatever address the platform hands out and a rolling deploy replaces them within a minute, so a configured host and port is already stale. A registry holds the instances that are healthy now, and a caller names the service and gets somewhere to send the request.

### [Service Mesh](../patterns/distributed/routing/service-mesh.md) {#tour-service-mesh}

Run those proxies everywhere and configure them centrally and you have a mesh: load balancing on observed latency or outstanding request count rather than at random, layer-7 routing on path, host header or application programming interface (API) version, bounded retries with a timeout, circuit breaking on configured thresholds, metrics on request volume and latency and error rate, [tracing](../patterns/distributed/resilience/distributed-tracing.md) information added at each hop, and mutual transport layer security (TLS) between services. None of it is free — every request now traverses a proxy, every node runs extra processes, and the cluster configuration becomes something you operate. Load test before adopting.

### [API Versioning](../patterns/distributed/routing/api-versioning.md) {#tour-api-versioning}

Services deploy on their own schedules, so at any moment a caller may be running against a contract older than the one you just shipped. That makes an interface change a compatibility question rather than a code change: add fields, never repurpose them, and have consumers ignore what they do not recognise. When a change genuinely cannot be made compatible, run both versions side by side and route callers to the one they ask for, keeping the old one until traffic on it reaches zero. Skip this and independent deployment quietly becomes a coordinated release again.

### [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) {#tour-circuit-breaker}

An instance fails because its node failed, because the process crashed, or because it is overwhelmed, and each of those makes your call fail. [Retrying](../patterns/distributed/resilience/retry-backoff.md) a transient fault is right; retrying a dependency that is genuinely down is how pending requests pile up holding memory, threads and connections until your service fails as well. A breaker counts recent failures and stops calling, so the failure stays where it started.

### [Bulkhead](../patterns/distributed/resilience/bulkhead.md) {#tour-bulkhead}

Give each dependency its own pool of threads or connections rather than letting every caller draw on one shared pool. A saturated downstream then exhausts its own pool and nothing else, and the request paths that never touch it keep serving. Without it, one slow dependency becomes a [cascading failure](../hazards/cascading-failure.md) across services that had nothing to do with it.

### [Correlation Identifier](../patterns/messaging/correlation-identifier.md) {#tour-correlation-identifier}

One user operation spans many services, so per-service logs and metrics answer nothing on their own. Assign an id the moment the request enters the system — at the gateway, or in the first service — pass it in a header to every hop, and write it into every log line and span. Searching for it reconstructs the end-to-end trail, including a failure and the retry that succeeded after it.

### [Idempotency](../patterns/messaging/idempotency.md) {#tour-idempotency}

A retry is safe only when applying the operation twice has the effect of applying it once, which is why blindly retrying a POST or a PATCH is not safe: the original call may have succeeded with the caller never seeing the response. Have each service build a key from the correlation identifier plus a service-specific qualifier, store the key before processing, and on a retry find it and skip. Because each service builds its own key from the one shared id, retries are safe across the whole transaction with no separate key-generation mechanism, provided the id stays the same when a client retries. Store the key and apply the effect in one local transaction, because a crash between the two would make the retry skip work that never ran. The correlation identifier is assigned when a request enters the system, so a client that retries a timed-out call needs a client-supplied idempotency key, or the edge must reuse the original id on replay; otherwise the duplicate gets a new id and runs again.

### [Event-Carried State Transfer](../patterns/messaging/event-carried-state-transfer.md) {#tour-event-carried-state-transfer}

Once data ownership is split, consumers still need other services' data. Put the changed state inside the event so each consumer keeps its own copy and reads it locally, which removes the callback and the runtime coupling at the price of seconds of staleness and a shared event contract.

### [Transactional Outbox](../patterns/distributed/coordination/outbox.md) {#tour-outbox}

A service that changes its own state and announces the change does two writes with no shared transaction between them. If the row commits and the publish fails, downstream services never learn; if the publish succeeds and the row rolls back, they act on something that did not happen. Write the event into an outbox table inside the same local commit, and let a relay publish it afterwards, so the one local commit is the only write that must succeed. The relay can crash after publishing and before marking the row sent, so it delivers at least once and consumers still need idempotency.

### [Materialized View](../patterns/distributed/coordination/materialized-view.md) {#tour-materialized-view}

When a service needs data another service owns, calling across on every read is chatty and ties your availability to theirs. Subscribe to the owner's published events instead and maintain a local view shaped for the query you actually run: a copy that is behind the owner, which remains the single source of truth. Keep a version or sequence number per key and drop any event older than the one applied, so a late event cannot overwrite newer state. To seed or rebuild the view, replay the owner's events or load a snapshot from the owner. Publish a schema for those events so serialization is generated rather than hand-written, store only the fields your context needs, and aggregate or batch at high volume, where the event flow itself becomes the bottleneck. Inside one service, the same read-model split is [CQRS](../patterns/architecture/cqrs.md).

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

Read the table by its left column. Each row is a situation you can recognise in a design review, not a property you would like the system to have.

| Your situation | Reach for | Because |
| --- | --- | --- |
| The caller needs each answer, and any failure should fail the whole operation | A synchronous call, with a [timeout](../patterns/distributed/resilience/timeout-deadline.md), a [breaker](../patterns/distributed/resilience/circuit-breaker.md) and a [bulkhead](../patterns/distributed/resilience/bulkhead.md) | Waiting is the point, so bound the wait, stop calling what is already down, and give each dependency its own pool so one slow callee cannot starve the rest |
| A service hard-codes addresses that go stale after each deploy | [Service Discovery](../patterns/distributed/routing/service-discovery.md), with [Health Endpoint](../patterns/distributed/resilience/health-endpoint.md) monitoring | Callers look up the instances running now instead of editing a list, and the health check keeps dead instances out of it |
| Other services merely observe that something happened | A published event | The fourth subscriber is added without touching the publisher |
| The work must happen, but the caller should not wait for it | A queue with [competing consumers](../patterns/messaging/competing-consumers.md) | The queue levels the arrival rate onto workers running at their own pace; a message can arrive twice, so make the consumer [idempotent](../patterns/messaging/idempotency.md), and if the caller needs the result use the synchronous row |
| Clients would otherwise learn your topology and repeat your auth check | [API Gateway](../patterns/distributed/routing/api-gateway.md) | One address to publish, one place to enforce cross-cutting concerns |
| Mobile, web and partners each want a different payload | [Backend-for-Frontend](../patterns/distributed/routing/bff.md) | One shared contract usually fits each of them badly |
| Retries, mutual TLS and tracing are being rewritten once per language | [Ambassador](../patterns/distributed/routing/ambassador.md), then a [Service Mesh](../patterns/distributed/routing/service-mesh.md) | The policy becomes configuration instead of a dependency in every build |
| A query or a call needs another service's data and must survive that service's outage | A [materialized view](../patterns/distributed/coordination/materialized-view.md) fed by their events, or [Event-Carried State Transfer](../patterns/messaging/event-carried-state-transfer.md) | The owner stays the source of truth and the events carry the data, so the consumer reads a local copy that is behind by the event lag and never calls back |
| A state change and its event must not diverge | [Outbox](../patterns/distributed/coordination/outbox.md) | Two writes with no shared transaction is a [dual write](../hazards/dual-write-inconsistency.md), and dual writes drift |
| Nobody can trace one user operation across the service logs | [Correlation Identifier](../patterns/messaging/correlation-identifier.md) | Per-service telemetry answers nothing without something joining it |
| Two services call each other constantly and their APIs are chatty | Merge them, or move the boundary | Chattiness often signals that the split was drawn in the wrong place |

## Related areas
<!--meta block=siblings-->

- [Service Boundaries](./service-boundaries.md) — The half of the job that comes first: deciding where one service ends.
- [Architecture Styles](./architecture-styles.md) — Whether microservices is the right style for this subdomain at all.
- [API Design](./api-design.md) — Shaping and evolving the contracts these services publish to each other.
- [Resilience](./resilience.md) — Go there when the question is what to do once a dependency fails (retry, hedge, fallback, heartbeat); here the question is how services call each other.
