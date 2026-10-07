---
title: Cascading Failure
description: One failure's load lands on its peers and takes them down in turn
area: hazards
owner: Oleksandr Derechei
tags: [resilience, availability, isolation, resource-management]
status: stable
aliases: [cascade failure, cascading outage]
solves: [one instance died and its traffic took down the ones that were still healthy, the outage spread from one service to the whole fleet in minutes, restarting the dead node just moves the overload onto the next one, each round of failures takes down more machines than the last]
favourite: true
---

# Cascading Failure

One component fails and its share of the work lands on the peers that are still up, pushing them past their own limits — so they fail too, each failure making the next one arrive sooner, until a partial fault has become a total outage.

## What it is
<!--meta block=description-->

A cascading failure spreads because of the response to it. One instance dies, its traffic goes to the survivors, and without spare capacity one of them saturates and dies too, leaving the same work for fewer machines. You recognize it by the direction of spread: failures move to services that never called the first one, drops come in accelerating sequence, and restarts die under the backlog. The trigger is trivial; the missing headroom is the cause.

## Explained
<!--meta block=explain-->

A cascading failure is a failure that spreads because of how the system responds to it. One instance dies, the load balancer hands its traffic to the survivors, and if they lack spare capacity one of them overloads and dies too, leaving the same work for even fewer machines. Losing one of N instances raises each survivor's load by N/(N - 1), so a fleet survives a loss only if utilization stays below (N - 1)/N. Retries and cold restarts, which start with empty caches, add load on top. The overloaded state then sustains itself, so waiting does not recover it and only dropping traffic does. Buy headroom for the first loss and shed load beyond it, because failover is the thing that moves the load. Keep utilization under that line and rehearse the loss. Split capacity so a failure lands on its own slice ([bulkhead](../patterns/distributed/resilience/bulkhead.md)), refuse excess work at the edge, and put a [circuit breaker](../patterns/distributed/resilience/circuit-breaker.md) in front of the sick part.

- **Idle capacity** Headroom means paying for machines that sit partly unused; in the example, 10 instances carry what 8 could, a fifth idle.
- **Slow recovery** Bring capacity back with retries off and traffic ramped, or restarts die under the full backlog.

**Example.** A fleet of 10 instances each handles 1,000 requests a second and carries 9,000, so 90%. One crashes and the other 9 take 1,000 each, at the ceiling. Queues grow, a health check evicts one, and 8 now face 1,125 each, so all are over their ceiling and the next loss follows as soon as queues fill. At 70%, 7,000 a second, the same loss gives 778 each, two give 875, and three reach 1,000. That gap lets you shed traffic or add capacity. The price is carrying 7,000 on 10 instances where 8 would have served it at 87.5%.

## How it happens
<!--meta block=causes-->

The mechanism is load redistribution without capacity headroom. Failover hands a failed unit's share to its peers instantly and in full, so the first loss raises each survivor's load by N/(N&nbsp;−&nbsp;1), each further loss by a larger factor, and once that load crosses capacity, the next failure is caused by the previous one rather than by the trigger. Retries, reconnects and cold restarts add load on top of the redistribution, which is why cascades accelerate instead of settling.

Underneath is a capacity decision nobody wrote down. Utilization targets are set for cost and steady-state latency; that constraint belongs to whoever sizes the fleet, not to whoever writes the failover logic. Because the two are usually different teams, the headroom is negotiated away in a budget review and its absence is discovered during an incident.

```mermaid caption="Each round shortens the interval to the next: every failure raises the share carried by whatever is left."
flowchart LR
    T["One instance fails"] -->|"its share is redistributed"| L["Survivors carry N/(N−1) of the load"]
    L -->|"utilization crosses capacity"| S["Another instance saturates and fails"]
    S -->|"fewer instances, larger share each"| L
```

- Running the fleet close to its ceiling: at high utilization there is no headroom for a failed peer's share, so the first loss is enough to start the chain.
- Failover that redistributes everything at once: the full load of the dead unit arrives on its peers instantly, rather than being shed or admitted gradually.
- Shared resources that couple unrelated paths — one connection pool, one database, one cache — so pressure on one call path consumes the capacity every other path depends on.
- Retries stacked on top of redistribution: callers of the failing unit multiply their requests exactly while the survivors are absorbing its traffic.
- Health checks that evict an overloaded-but-working instance, removing capacity at the moment capacity is scarcest and handing its share to the rest.
- Cold restarts under full traffic: a fresh instance has empty caches, connections and buffers, so it is slower than the one it replaced and fails before it can warm.

## What it costs
<!--meta block=cost-->

- **A partial fault becomes a total outage.** You lose the whole service rather than the fraction that broke, so redundancy you paid for delivers none of the availability it was bought for.
- **The system does not recover without shedding or a breaker.** Once the trigger is gone, offered load still exceeds the reduced capacity, so the outage waits for a human.
- **Restarts fail until the load is turned down.** Every instance you bring back is handed the full backlog and dies before it warms, which is why recovery time is dominated by manual shedding rather than by the fault itself.
- **The blast radius crosses ownership lines.** Services that never called the failing one go down through shared pools and shared infrastructure, so the teams paged are not the team that can fix it.
- **The postmortem chases the wrong thing.** The trigger is usually trivial and gets the attention, while the real finding — that the fleet had no headroom for one loss — is a capacity decision nobody was in the room for.

What makes it expensive is that the overloaded state is stable. The system has a second operating point — queues full, retries in flight, every unit saturated — that keeps feeding itself after the original fault has cleared, and leaving it needs load pushed well below the level that got you into it. That hysteresis is why "wait for it to recover" is not a strategy and why the exit is usually load dropped, by an operator or by automatic shedding and breakers. Holding u below (N&nbsp;−&nbsp;1)/N means buying idle capacity permanently, so the headroom is a real line item, competing against the cheaper option of shedding load when the moment comes. Most systems should buy some of both.

## Getting out
<!--meta block=mitigation-->

Decide in advance where a failure is allowed to stop. Partition capacity into compartments — separate pools per dependency, cells or shards that serve a slice of traffic — so a failed unit's load can only land on its own compartment instead of on everyone. Containment does not prevent the first failure; it fixes the size of the outage before you have one.

Then make refusing work cheaper than accepting it badly. Shed low-value traffic at the edge while there is still capacity for the rest, keep queues short so a request that has waited past its deadline is dropped rather than served, and [fail fast](../principles/fail-fast.md) when a dependency is slow — callers that wait are callers holding threads and connections. A breaker in front of the failing component does that automatically, and it also stops the callers from re-feeding the thing that is trying to recover. Cap retries as a share of recent requests and fail fast once spent, so retries cannot multiply load on the survivors. Do not let a health check evict an instance that is overloaded but still answering, and cap how many it may remove at once. Size the queue bound from the measured service rate times the latency you can afford, and set each deadline below the caller's timeout.

Recovery is a procedure, not a restart. Bring capacity back with traffic turned down, warm it, then ramp — and disable retries while you do, or the backlog will consume every instance as it appears. Keep utilization under the level where losing one unit exceeds what the rest can carry, and rehearse the loss so the number is measured rather than assumed. Treat (N&nbsp;−&nbsp;1)/N as an upper bound: measure where latency starts to climb and stay under that knee. The early signal is correlated: latency and queue depth rising together across peers that have no reason to be correlated means the redistribution has already started.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Synchronous I/O](./synchronous-io.md) — A blocking caller is one way a cascade crosses a hop: parked threads pass the slowness on
- [Retry Storm](./retry-storm.md) — A retry storm is one way a failing peer is re-fed until the failure spreads.
- [Connection-Pool Exhaustion](./connection-pool-exhaustion.md) — A shared pool lets pressure on one call path starve every other path, which is how the cascade crosses services.

**Often confused with**

- [Metastable Failure](./metastable-failure.md) — A cascade is defined by spread, and a metastable failure by self-sustaining persistence.

**Mitigated by**

- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — Compartments fix the blast radius before the first failure
- [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) — Breaks the chain so callers stop re-feeding a failing peer
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — Bounded waits stop the stall propagating up the call chain
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — Shedding at the edge keeps offered load under reduced capacity
- [Load Shedding](../patterns/distributed/resilience/load-shedding.md) — Refuse work past capacity, so the overload stops at the first hop instead of spreading
- [Design for Self-Healing](../principles/self-healing.md) — Designed-in recovery keeps a single failure from spreading outward
- [Analyse Failure Modes](../principles/failure-mode-analysis.md) — The cascade is found by walking dependencies before it happens
- [Fault Injection](../patterns/distributed/resilience/fault-injection.md) — Injecting one component's failure shows whether its load actually sinks the peers
- [Fallback](../patterns/distributed/resilience/fallback.md) — A fallback gives callers a working answer so they do not fail with the dependency.

**Threatens**

- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — Redistributing a dead node's share overloads the survivors
- [Autoscaling](../patterns/distributed/routing/autoscaling.md) — New cold instances join under full load and die before warming up
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — Retries add load to an already saturated dependency
- [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) — Evicting a node for failing a health check shifts its load onto the rest

<!-- relationships:end -->
