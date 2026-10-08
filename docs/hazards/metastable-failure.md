---
title: Metastable Failure
description: "An outage that outlasts its trigger because the system's own retries, cold caches and late answers keep the overload going"
area: hazards
owner: Oleksandr Derechei
tags: [resilience, availability]
status: stable
aliases: [self-sustaining overload, stuck in overload]
solves: [the traffic spike ended an hour ago but the service is still failing with CPU pinned, every time we restart the overloaded service it falls over again within seconds, we fixed the cause of the outage but the system would not recover until we cut traffic by hand, "the database stays overloaded long after the cache was flushed, though request volume is back to normal", "the postmortem found only a small trigger that was already gone, and no bug"]
---

# Metastable Failure

A short trigger pushes a system into overload, and the system's own recovery work — retries, cold caches, late answers nobody reads — keeps it there after the trigger is gone, so the outage outlives its cause.

## What it is
<!--meta block=description-->

A metastable failure is an outage that keeps itself going after its trigger, such as a spike, a cache flush or a deploy, has passed. You see traffic back to normal while errors are not: CPU is pinned, queues are full and useful throughput is near zero. Restarting does not help. The defining trait is persistence at a load the system handles on a normal day, held up by retries, a cold cache or a stale backlog.

## Explained
<!--meta block=explain-->

A metastable failure is an outage that keeps itself going after its cause has ended. A trigger, such as a spike or a cache flush, pushes the system into overload. Inside the system, something then raises the load for each useful answer: clients retry, a cold cache sends every read to the database, and a queue serves requests whose callers gave up. Those effects hold the overload up, so the system stays down at a traffic level it handles easily on a normal day. Restarts do not help, because a restarted instance has an empty cache and meets the full backlog. Recovery needs the load cut below normal on purpose, then raised in steps. So decide in advance who gets refused. Shed load early by measured saturation, cap retries as a share of traffic, pass deadlines so late requests are dropped unserved, and serve the newest first. Test recovery by applying a trigger, removing it and watching whether useful output returns without a manual cut.

**Example.** A database serves 1,000 reads a second. The cache has a 95 percent hit rate, so the app sends 10,000 reads a second and the database sees 500. A deploy flushes the cache. Now it sees 10,000, ten times its limit. Queries take over 2 s, clients time out at 1 s and retry twice, and almost no read succeeds, so the cache never refills. An hour after the deploy the database still sees 30,000 reads a second. The fix is to shed everything but 800 a second until the cache fills, then reopen in steps. The cost is minutes of refused requests.

## How it happens
<!--meta block=causes-->

The failure is a loop with a vulnerable state in front of it. In the vulnerable state the system runs fine, close to its limit, and any trigger large enough tips it into overload. Once there, the sustaining loop below takes over, and the trigger no longer matters.

```mermaid caption="Why does the outage outlive its trigger? The trigger pushes load past capacity, overload makes answers late, late answers cause retries and wasted work, and both raise the load per useful answer, so the loop feeds itself after the trigger has ended."
flowchart TB
    T["Trigger: spike, cache flush, slow dependency"] --> O["Overload: queues grow, latency passes the client timeout"]
    O --> W["Answers arrive late: work done, nobody reads it"]
    O --> R["Callers retry"]
    W --> L["More load per useful answer"]
    R --> L
    L --> O
    T -.->|"trigger ends"| G["Loop keeps running without it"]
```

- Running efficiently and close to the limit: idle capacity looks like waste, so the fleet is sized to the steady state, and a modest spike then has no room to pass through.
- Capacity that depends on state: a cache with a 95 percent hit rate lets you size the database for 5 percent of reads, and an empty cache sends it 20 times that, with the cache refilling only from the reads that succeed.
- Work that is repeated: each timed-out call is retried by the client, the library and the gateway, so one failure becomes several attempts. [Retry storms](./retry-storm.md) are a common sustaining effect.
- Work that is wasted: a queue serves requests in arrival order, and by the time one reaches the front its caller has timed out, so the server does the work and sends the answer to nobody.
- Recovery that costs capacity: cold restarts, reconnect waves, connection setup and replicas catching up all take the capacity you need to recover.
- No control that watches goodput (useful answers per second): dashboards show request rate and CPU, which look busy and healthy, so nothing admits fewer requests when useful output has collapsed.

## What it costs
<!--meta block=cost-->

- **The outage does not end when you fix the cause.** The trigger is gone and the system is still down, so the on-call engineer is fixing a cause that no longer exists.
- **Restarts do not help.** A restarted instance has a cold cache and meets the full backlog, so it fails again and the incident gets longer with each try.
- **Recovery needs you to turn traffic away.** The only way out is to cut load below normal, so you spend part of the incident refusing customers on purpose.
- **The root cause is hard to find.** The trigger was small and brief, the loop is spread over many components, and the postmortem has no single bug to point at.
- **It comes back.** Any trigger that tips the system past the edge starts it again, so a fleet that survived last quarter's spike can fail on this quarter's small one.
- **Capacity numbers are wrong.** The capacity you planned for holds only while caches are warm and queues are short, so the figure on the capacity sheet is not the capacity you have.

## Getting out
<!--meta block=mitigation-->

Break the loop, not the trigger. Cut the load to what the system can serve, then bring it back in steps. [Load shedding](../patterns/distributed/resilience/load-shedding.md) does this when it measures saturation, and it should refuse early and cheaply so a refusal costs almost nothing to serve. Shed until queues drain and goodput recovers, then let traffic back in stages, because a full reopening is itself a new trigger. If you have no automatic shedding, an operator needs a dial that does the same: a limit at the edge, a feature flag, or a way to pause a batch job.

Then take away what keeps the loop going. Cap retries with a budget and spread them with [backoff and jitter](../patterns/distributed/resilience/retry-backoff.md) so a failure does not multiply. Pass a deadline with every request through [timeouts and deadlines](../patterns/distributed/resilience/timeout-deadline.md), and drop a request whose deadline has passed before doing the work, so the server stops answering callers who left. Serve the newest requests first when a queue is long, since the oldest are the likeliest to be dead. A [circuit breaker](../patterns/distributed/resilience/circuit-breaker.md) in front of a struggling dependency gives it quiet time to recover. Let the breaker close in steps too, because a breaker that closes at once lets the full load back in and becomes the next trigger.

Reduce the dependence on warm state. If the database is sized for a cache that may be empty, either size it for the miss rate or protect it with [request coalescing](../patterns/distributed/resilience/request-coalescing.md) and a gradual warm-up, so a cold cache does not become a [cache stampede](./cache-stampede.md). Keep spare capacity where recovery is expensive.

Finally, test the recovery, not just the failure. Run a load test that applies a trigger, removes it and measures whether goodput returns on its own, using [fault injection](../patterns/distributed/resilience/fault-injection.md). A system that needs a manual cut to recover will tell you in the test, and not at the next incident.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Retry Storm](./retry-storm.md) — A retry storm is the most common sustaining loop inside a metastable failure.

**Often confused with**

- [Cascading Failure](./cascading-failure.md) — It persists after its trigger and can sit inside one component.
- [Cache Stampede](./cache-stampede.md) — A cold cache is one trigger and one sustaining effect among several.

**Mitigated by**

- [Load Shedding](../patterns/distributed/resilience/load-shedding.md) — Cutting load below capacity breaks the loop and lets goodput return.
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — Retries are the most common sustaining effect, and a budget with backoff and jitter limits them.
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — A deadline lets the server drop late requests unserved instead of wasting work.
- [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) — A breaker gives a struggling dependency quiet time to recover.
- [Request Coalescing](../patterns/distributed/resilience/request-coalescing.md) — Sharing one fetch per key keeps a cold cache from sending every read to the database.
- [Fault Injection](../patterns/distributed/resilience/fault-injection.md) — Applying a trigger, removing it and checking that goodput returns shows whether a loop sustains the outage.
- [Hedged Request](../patterns/distributed/resilience/hedged-request.md) — A hedge adds little load under a budget, but unbudgeted hedges sustain an overload, so cap them.

**Threatens**

- [Cache-Aside](../patterns/caching/cache-aside.md) — A cold cache after a flush sends every read to the database, which can then never refill it
- [Message Queue](../patterns/messaging/message-queue.md) — A backlog of requests whose callers gave up keeps the consumers busy with worthless work
- [Failover](../patterns/distributed/coordination/failover.md) — The standby meets the full load cold, and the next failover re-triggers the failure
- [Metrics & Monitoring](../designs/metrics-monitoring.md) — A metrics pipeline whose backlog never drains stays behind long after the outage that caused it.

<!-- relationships:end -->
