---
title: Resilience
description: "Staying up, or degrading gracefully, when parts fail and failures cascade between services"
area: themes-operating
owner: Oleksandr Derechei
tags: [resilience, isolation, availability]
status: stable
aliases: [fault tolerance, reliability]
favourite: true
---

# Resilience

Parts of any system will fail — disks, networks, dependencies, deploys. Resilience is the discipline of staying up, or degrading gracefully, when they do, instead of letting one failure cascade into an outage.

## The question
<!--meta block=description-->

At scale, failure is a certainty: disks fail, networks drop packets, dependencies slow to a crawl, deploys go wrong. Resilience does not prevent that; it designs so a failure is more likely to degrade the system than take it down. Does a hung call tie up every thread? Does a caller hammer a dependency that is already down? Does a redelivered message run twice? Decide each in design, not during an incident.

## Explained
<!--meta block=explain-->

Resilience means designing each call so that one failing part slows or stops only itself. The steps form a ladder, and the trade between patience and self-preservation sets how far you climb. Bound every wait with a timeout, so nothing blocks forever. Retry a few times, with a cap on attempts, growing pauses and random jitter so many clients do not retry in step, because many failures are brief, such as a dropped packet. If failures keep coming, a circuit breaker, a gate that counts failures and then answers at once without calling, stops you queuing behind a dependency that is not coming back. A fallback then returns a cached or reduced answer. Give each dependency its own share of threads, called a bulkhead, so one cannot starve the rest. Patience is cheap for a dropped packet and ruinous for a dead service, because every waiting thread is capacity your next request lacks. Retried or redelivered work runs twice, so make operations safe to repeat, and give half-finished multi-step work an explicit undo.

**Example.** A checkout service has 50 threads and takes 100 requests a second. Its payment dependency dies. Each call waits 1 s and is tried 3 times with no pause between tries, so a request holds a thread for 3 s. Holding 100 requests a second for 3 s needs 300 threads. The 50 threads are gone within about half a second. Nothing else can run. The dependency still receives about 50 calls a second, none answered. A breaker that opens after 20 failures answers instantly instead. The cost is that payments fail fast for the whole cooldown, so you queue those orders for later.

## The trade-space
<!--meta block=tradespace-->

The core tension is between **patience and self-preservation**. Waiting longer, or trying again, recovers many transient failures: a dropped packet, a short blip, a garbage collection pause. The price is a held thread, connection or worker for each wait, which is capacity the next request lacks. Too much patience lets one slow dependency starve everything upstream.

Respond in steps. Bound the wait first. Retry briefly, only on operations that are safe to repeat and at one layer only, since attempts multiply at every layer. If failures keep coming, [fail fast](../principles/fail-fast.md), so the caller is not queued behind a dependency that is not coming back. Isolate capacity wherever you can, so one failing dependency sinks only its own compartment. Two more steps deal with what a failure leaves behind. When part of the answer is optional, a [Fallback](../patterns/distributed/resilience/fallback.md) returns a cached copy or a simpler answer instead of an error, and you alert on how often it fires. When the problem is lateness rather than failure, so timeouts and retries never trigger, a [Hedged Request](../patterns/distributed/resilience/hedged-request.md) sends a second copy of a read to another replica after a high-percentile delay, at the cost of extra load.

Detection is its own question. A [Heartbeat](../patterns/distributed/coordination/heartbeat.md) lets others learn that a node is alive when no request is waiting on it; its timeout cannot tell a crash from a long pause or a broken link, so confirm before a drastic action. [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) pulls out of rotation an instance that still answers requests but is unhealthy. Once a primary is confirmed dead, [Failover](../patterns/distributed/coordination/failover.md) promotes a standby. A [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) parks messages that never succeed.

Once retries and redelivery are in play, operations must tolerate running twice, and partial failures need a rollback or a safe, inspectable stop.

```mermaid caption="Patience recovers transient failures; past a threshold, self-preservation takes over."
flowchart TB
    R["Call a dependency"] -->|"with a bounded timeout"| T{"Succeeds within the deadline?"}
    T -->|"Yes"| Done["Return the result"]
    T -->|"No"| Retry{"Transient, few failures so far?"}
    Retry -->|"Yes"| Backoff["Retry with backoff"]
    Retry -->|"No, failing repeatedly"| Break["Open the circuit, fail fast"]
    Break -->|"isolate capacity"| Isolate["Bulkhead contains the damage to this dependency"]
```

## Patterns that implement the choice
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) {#tour-timeout-deadline}

Every call across a network needs an upper bound on how long you'll wait, or one slow dependency exhausts the threads, connections, or memory of everything upstream of it. A deadline turns an indefinite hang into a bounded, recoverable failure.

### [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) {#tour-circuit-breaker}

After enough failures, trip open and reject calls immediately instead of piling more requests onto a dependency that isn't going to answer. It gives the failing service room to recover and gives the caller a fast, predictable failure instead of a stack of stuck requests.

### [Idempotency](../patterns/messaging/idempotency.md) {#tour-idempotency}

Once retries and redelivery are a given, every operation that can be repeated needs to produce the same result whether it runs once or five times. Without it, the retries meant to improve resilience can corrupt state.

### [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) {#tour-retry-backoff}

Most failures at scale are transient: a dropped packet, a short overload. Trying again after a short, increasing delay resolves them without any human involved. Backoff, plus jitter, keeps a whole fleet of retrying clients from synchronizing into the next overload.

### [Fallback](../patterns/distributed/resilience/fallback.md) {#tour-fallback}

When the call is cut short by a timeout, a breaker or a full bulkhead, the caller still has to show something. A fallback picks the lesser answer, such as a cached value or a default, for that one request. Decide it in advance, or the user sees a plain error.

### [Hedged Request](../patterns/distributed/resilience/hedged-request.md) {#tour-hedged-request}

A retry waits for a failure, which never comes when a replica is only slow. Send a second copy to another replica after a short delay and take the first answer. It needs a call that is safe to repeat and a cap on the share of hedged requests, since extra copies add load.

### [Bulkhead](../patterns/distributed/resilience/bulkhead.md) {#tour-bulkhead}

Partition pools, threads or capacity per dependency, so an overwhelmed downstream sinks only its own compartment, like a ship's watertight compartments.

### [Compensating Transaction](../patterns/distributed/resilience/compensating-transaction.md) {#tour-compensating-transaction}

When a multi-step operation fails partway through and there's no distributed transaction to roll it back atomically, you need an explicit, opposite action for every step already committed — recovering correctness after the fact instead of preventing the failure up front.

### [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) {#tour-dead-letter-channel}

Some messages will never succeed no matter how many times you retry, and letting them retry forever blocks the queue behind them. Routing them to a separate channel after a bounded number of attempts keeps the pipeline moving and leaves a place to inspect and replay them later.

### [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) {#tour-health-endpoint}

A [load balancer](../patterns/distributed/routing/load-balancer.md) or orchestrator can only route around a failing instance if something tells it the instance is failing, so an endpoint reporting real dependency and resource health lets bad instances be pulled from rotation before they cause user-visible errors.

### [Heartbeat](../patterns/distributed/coordination/heartbeat.md) {#tour-heartbeat}

A node that crashes says nothing, so silence is the only signal. A heartbeat is a small message sent on a timer, and a missed run of them is a suspicion that the node is gone. Set the timeout against your pauses, or a slow node is declared dead.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Strategy | Reach for |
| --- | --- | --- |
| Stop calling a dependency that keeps failing | Fail fast | [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) |
| Show a simpler page when an optional dependency is down | Return a smaller answer | [Fallback](../patterns/distributed/resilience/fallback.md) |
| Cut the slowest one percent of responses when nothing is failing | Send a second copy of a read | [Hedged Request](../patterns/distributed/resilience/hedged-request.md) |
| Recover automatically from a transient blip | Try again, briefly, on repeat-safe calls | [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) |
| Stop one slow call from starving the caller | Bound every wait | [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) |
| Keep one dependency's overload from sinking every caller | Partition capacity | [Bulkhead](../patterns/distributed/resilience/bulkhead.md) |
| Make retried or redelivered operations safe | Same result every time | [Idempotency](../patterns/messaging/idempotency.md) |
| Recover correctness after a partial multi-step failure | Explicit undo | [Compensating Transaction](../patterns/distributed/resilience/compensating-transaction.md) |
| Keep a poison message from blocking the queue | Quarantine after N attempts | [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) |
| Pull a failing instance that still answers requests out of rotation | Report real health | [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) |
| Learn that an idle worker or node has died when no request is waiting on it | Periodic liveness message | [Heartbeat](../patterns/distributed/coordination/heartbeat.md) |
| Resume service when a primary dies, with no one repairing it | Promote a standby | [Failover](../patterns/distributed/coordination/failover.md) |
| Coordinate a multi-step change across services, with undo on failure | Local steps, each with an undo | [Saga](../patterns/distributed/coordination/saga.md) |

## Related areas
<!--meta block=siblings-->

- [Handling Spikes](./spike-handling.md) — A burst of load is its own kind of failure; bulkheads and backoff keep a spike from becoming an outage. Go there when the trigger is a load surge rather than a failing dependency.
- [Observability](./observability.md) — You cannot route around a failure, or confirm a circuit breaker tripped, without first seeing it happen. Go there first when detection is the open question.
- [CAP Theorem](./cap-theorem.md) — Choosing to stay available during a partition is itself a resilience trade-off, made against consistency.
