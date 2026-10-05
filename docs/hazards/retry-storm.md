---
title: Retry Storm
description: "Clients retry in unison, multiplying load on a service already failing"
area: hazards
owner: Oleksandr Derechei
tags: [resilience, availability, error-handling, latency]
status: stable
aliases: [retry amplification]
solves: [traffic entering the system is flat but calls to the failing dependency keep climbing, the outage outlived its cause and the errors never stopped, "the service recovers for a few seconds then falls over again, over and over", every client tried again at the same moment and multiplied the load]
---

# Retry Storm

A failure makes every caller try again at the same moment, so a service that was merely struggling is handed several times the load it already could not serve — and the retries, not the original fault, are what keep it down.

## What it is
<!--meta block=description-->

A retry storm is what happens when a dependency starts failing and every caller tries again at the same instant, so the struggling service receives several times the traffic it already could not serve. You recognise it by the traffic shape: calls at the dependency climb while user traffic is flat, and the outage outlives its cause. It is close kin to a [thundering herd](./thundering-herd.md), but the failure itself synchronises the callers and each round feeds the next.

## Explained
<!--meta block=explain-->

A retry storm is what happens when a dependency starts failing and every caller tries again at the same moment, so the struggling service receives several times the traffic it could not serve in the first place. Each retry is sensible alone. But attempts multiply down a chain, since three tries at each of two layers makes nine calls for one user request, and clients that failed together wait the same time and return together. The outage outlives its cause: the fault clears, yet the amplified load keeps the failures going. Watch calls per user request, not calls per second. Make each attempt later than the last with exponential delay, add random jitter, and cap attempts, as [retry with backoff](../patterns/distributed/resilience/retry-backoff.md) does. Pick one layer to retry at. Stop retries outright while the dependency is down with a [circuit breaker](../patterns/distributed/resilience/circuit-breaker.md).

- **Lost recoveries.** A retry budget caps retries as a share of successful traffic, and drops a rare transient failure a second try would have saved.
- **Errors surface higher.** Retrying at one layer means lower layers pass transient errors up instead of healing locally.

**Example.** A dependency handles 1,000 calls a second and normally gets 200 a second, one per user request. A gateway and a service behind it each try 3 times, so one user request becomes 9 calls. A 5 s blip fails everything and the load jumps to 200 x 9 = 1,800 a second. That exceeds 1,000, so failures continue after the blip ends. Retrying only at the gateway, 3 attempts with jittered backoff, gives 200 x 3 = 600 a second at worst, under the limit, so the dependency recovers.

## How it happens
<!--meta block=causes-->

Nobody writes a retry storm on purpose. Every caller is doing the sensible thing — the call failed, so try it again — and the only trouble is that they all do it at the same moment, because they all failed at the same moment. The ordinary defaults below decide how big the wave gets.

The loop amplifies and it is synchronized, and both properties are fixed by choices made long before the incident. Amplification comes from attempts per call multiplied by the number of layers that retry; synchronization comes from a delay that every client computes identically. The defaults below keep both turned up.

Read it as an incentive problem. A retry raises this client's success rate today, and its cost lands on a shared dependency during someone else's incident, so nothing in a code review rejects it and no load test with a single client reveals it. Amplification is a property of the fleet, which is why it is discovered in production and nowhere else.

```mermaid caption="The loop that keeps the outage alive: the retries a failure triggers are what produce the next failures."
flowchart LR
    F["Dependency starts failing"] -->|"every caller tries again"| R["Offered load multiplies"]
    R -->|"queues fill, deadlines fire"| M["More calls fail"]
    M -->|"more failures to retry"| F
```

- Immediate or fixed-interval retries: every failed call comes back inside the same short window, so the load arrives as a spike instead of a spread.
- Backoff without jitter: clients that failed in the same instant compute the same delay and return in the same instant, so growing the interval only moves the wave rather than flattening it.
- Retries at several layers — the SDK, the service client, the gateway — multiply instead of adding: three attempts at each of three hops is up to twenty-seven calls for one user request.
- Retrying failures that cannot clear: an overload response or a rejected request gets the same treatment as a dropped packet, so callers keep knocking on a door that is explicitly telling them to stop.
- Timeouts set far above normal latency: the caller waits out the full deadline before retrying, so the retry arrives while the first attempt is still occupying the dependency.

## What it costs
<!--meta block=cost-->

- **The outage outlives its cause.** The dependency spends its returning capacity on retries, so it never gets the quiet interval it needs to drain the backlog that the retries are made of. That self-sustaining state is a [metastable failure](./metastable-failure.md).
- **Recovery is punished.** Bring an instance back and the waiting attempts consume it within seconds, which is why a restarted service dies again immediately and the graph shows a sawtooth rather than a rise.
- **Most of the load is unwanted work.** Attempts whose caller has already given up still cost the dependency a full query, so a large share of what is knocking it over is work no one will ever read.
- **The blast radius is wider than the dependency.** Retries occupy threads, connections and load-balancer capacity that unrelated calls share, so requests that never touch the failing service start failing too.
- **Retried writes can duplicate.** A response lost after the operation succeeded is indistinguishable from a failure, so every retry of a non-idempotent write risks a second effect on top of the outage.

The bill lands in capacity planning, which is why you cannot buy your way out. Absorbing a storm means provisioning for the amplified rate — several times peak, held permanently, for load that exists only while you are failing — and that multiple grows with the depth of your call graph rather than with your traffic. Amplification also breaks the assumption your dashboards run on: request rate at a dependency stops being a measure of demand, so any capacity model fitted to incident traffic sizes for a number the business never asked for.

## Getting out
<!--meta block=mitigation-->

Make each attempt later than the last, and make the crowd spread out. Grow the delay exponentially, add a random component to it, and cap the number of attempts. The randomness is the part that does the work: clients that failed together compute the same delay and return together, so a longer interval alone moves the wave without flattening it.

Then bound the total, not just the interval. Pick one layer to retry at and switch retries off at every other one, so a failure is not multiplied by the number of hops it passes through. Cap retries as a share of successful traffic, so the volume a struggling dependency can see is a number you chose in advance. And retry only what can clear — a transient error, on a call that is safe to repeat.

The dependency has a move of its own. Refuse excess work quickly and cheaply instead of queueing it, so a rejected call costs almost nothing to serve and whatever capacity remains goes to requests that can still succeed. Keep amplification as a standing measurement, calls per user request and retry share per dependency, because it is a fleet property that no single client's tests will ever show you.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Poison Message](./poison-message.md) — A message that cannot succeed keeps feeding the storm.
- [Metastable Failure](./metastable-failure.md) — A retry storm that outlives its trigger becomes a metastable failure.

**Mitigated by**

- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — Jittered, capped backoff desynchronizes the wave
- [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) — Stops the retries entirely while the dependency is down
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — The dependency refuses excess cheaply instead of queueing it
- [Fault Injection](../patterns/distributed/resilience/fault-injection.md) — The multiplication only shows up when something is actually failing
- [Fallacies of Distributed Computing](../principles/fallacies-of-distributed-computing.md) — The first fallacy is how a retry storm starts.

**Threatens**

- [Saga](../patterns/distributed/coordination/saga.md) — Each step's retries and its compensations multiply load on a service that is already failing
- [Outbox](../patterns/distributed/coordination/outbox.md) — A relay that republishes after a failure floods a recovering broker
- [Compensating Transaction](../patterns/distributed/resilience/compensating-transaction.md) — Compensation retries against a service that is already down add to the retry load; this pattern's undos need a cap and backoff.

<!-- relationships:end -->
