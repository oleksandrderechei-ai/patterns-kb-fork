---
title: Noisy Neighbour
description: One tenant's load degrades everyone sharing the same pool
area: hazards
owner: Oleksandr Derechei
tags: [performance, isolation, resource-management, latency]
status: stable
aliases: [noisy neighbor]
solves: [our latency doubled with no deploy and a flat request rate, another team's batch job slows our service down, one tenant's traffic degrades everyone sharing the same host, the metric that would explain our slowdown belongs to a workload we cannot see]
---

# Noisy Neighbour

One workload takes a disproportionate share of infrastructure it holds in common with others — CPU, disk, connections, cache memory — and the co-tenants absorb the latency, because the shared resource was never told how much any of them was entitled to.

## What it is
<!--meta block=description-->

A noisy neighbour is a workload that takes far more than its share of a pooled resource (CPU, disk operations, connections, cache space) and slows everything else on it. The resource serves whoever asks hardest. You recognise it when the victim's request rate is flat, its error rate is zero and its latency has doubled anyway. It is a fairness failure inside one pool, not overload of the system: capacity exists but is split badly.

## Explained
<!--meta block=explain-->

A noisy neighbour is a workload that takes far more than its share of something pooled, such as a connection pool, disk operations, memory bandwidth or cache space, and slows every other workload on it. Nothing is broken and nobody is malicious: a bulk import, a monthly report or a client stuck in a retry loop just uses what it can reach. The victims' metrics look innocent, because their request rate is flat and their error rate is zero, while their latency has doubled in a queue at the shared resource. Choose this diagnosis over system-wide overload when capacity exists but is split badly. Partition first, giving each class of work its own pool with a [bulkhead](../patterns/distributed/resilience/bulkhead.md), so a heavy job drains only its own. Then meter at the entrance: attribute every request to its tenant and cap the top consumer with a per-tenant [rate limiter](../patterns/distributed/resilience/rate-limiter.md).

- **Idle capacity.** Separate pools sit unused while their class is quiet; give hard isolation only to workloads whose latency you sell.
- **Attribution first.** You cannot cap what the resource never recorded, so tag each request with its tenant before you set limits.

**Example.** A database has a shared pool of 100 connections. Interactive traffic keeps 40 busy. A nightly export opens 80, so 120 are wanted of 100 and interactive calls queue behind the export and their latency climbs while their error rate stays zero. You split the pool: 70 for interactive, 30 for batch. Interactive keeps room for a spike, and the export takes about 80 / 30 = 2.7 times longer. The cost is 30 connections that sit mostly idle by day.

## How it happens
<!--meta block=causes-->

Sharing without rules. Several jobs run on the same machine, or several services draw from the same pool of database connections, and nobody wrote down how much of it each one may take. Most of the time everyone fits and nobody notices. Then one of them does something big, and takes what it needs, which happens to be what everyone else needed too.

The mechanism is contention at an unpartitioned resource. Demand above the resource's service rate produces a queue, and that queue is shared by everyone using it, so one workload's excess reaches the others as waiting time rather than as an error. Utilisation on the victim's side stays normal because the victim is not doing more work; it is doing the same work behind a longer line.

The decision that produces it is made at procurement, not at three in the morning: unless someone prices the tail explicitly, isolation is the line item that gets cut. Multi-tenancy without per-tenant attribution then makes the result undiagnosable: if the resource never learned who was asking, you cannot bill, throttle or even name the workload that is taking it.

```mermaid caption="Why a workload that changed nothing gets slower: the queue is at the shared resource, so one tenant's demand is every tenant's latency."
flowchart LR
    A["Tenant A starts a bulk import"] -->|"unmetered demand"| R["Shared pool: CPU, IOPS, connections"]
    R -->|"queue forms at the resource"| Q["Every request waits behind A's"]
    Q --> B["Tenant B: p99 doubles, no deploy, no extra traffic"]
    B -->|"clients time out and retry"| R
```

- An unbounded batch job — a backfill, an export, an analytics scan — running against the same database, disk or cluster that serves interactive traffic.
- A shared connection or [thread pool](../patterns/concurrency/thread-pool.md) with no per-caller cap, so one slow or greedy caller holds most of the leases and everyone else queues for what is left.
- Co-residency without resource limits: containers or virtual machines packed onto a host with no CPU shares, memory ceiling or I/O throttling, leaving the scheduler to hand capacity to whoever asks most often.
- A shared cache with no per-tenant memory budget: one workload's working set evicts everyone else's, so its hit rate improves while theirs collapses and their load lands on the origin.
- A client in a retry loop: one caller multiplies its own failed load and spends the pool's capacity on requests nobody is waiting for any more.

## What it costs
<!--meta block=cost-->

- **The victim cannot diagnose it.** No deploy, no traffic change, no errors in its own logs — so the first hour of every such incident is spent investigating a service that is behaving perfectly.
- **It lands in the tail, where the timeouts live.** Means can barely move while p99 doubles, and the requests that cross a caller's timeout become failures in a service that never failed.
- **Per-tenant promises stop being keepable.** You sell a latency target per customer while the resource underneath has no idea customers exist, so one tenant's batch job spends another tenant's error budget.
- **Capacity planning becomes guesswork.** The headroom that matters is whatever the worst-behaved neighbour leaves you, so you end up provisioning for somebody else's peak and still being surprised.
- **It escalates through retries.** Victims time out, retry onto the same contended resource and add load to it, turning a fairness problem into a saturation problem once retries exceed spare capacity.
- **Trust in the shared platform erodes faster than the incidents.** After two unexplained slowdowns teams start asking for their own cluster, which is exactly the cost pooling was meant to avoid.

Price it as the bill for the pooling you chose, because that is what it is. Consolidation buys utilisation — one shared fleet running at seventy per cent instead of ten private ones at ten — and the tail latency you gave up is the payment. That trade is often correct, but it stays correct only while somebody measures both halves: the money saved by sharing, against the escaped latency, the wasted investigation hours and the dedicated capacity teams demand once they stop trusting the pool. Unmeasured, the saving stays visible in the infrastructure bill and the cost disappears into on-call.

## Getting out
<!--meta block=mitigation-->

Partition the resource before you go looking for the culprit. Give each class of work its own pool — separate connection pools for batch and interactive traffic, separate worker fleets, separate volumes — so a heavy job exhausts its own allocation and stops there instead of everyone's. Where workloads share a host, set explicit CPU, memory and I/O limits per container, so the scheduler has a stated entitlement to enforce rather than a race to arbitrate. Isolation is the cure that needs no culprit named, at the price of idle reserved capacity.

Then meter at the entrance. Attribute every request to the tenant or workload that caused it, and apply a per-tenant rate or concurrency limit so capacity is divided by policy instead of by whoever is fastest to ask. Cap the top consumer rather than everyone: throttling the one workload above its allowance protects the median. And move the heavy work off the interactive path where you can — run reports against a replica, schedule backfills into a window, and put [backpressure](../patterns/concurrency/backpressure.md) on the producer so a queue slows the job rather than the pool.

Attribution is the first diagnostic step, partitioning the first containment step: carry workload identity down to the pool, keep per-tenant consumption alongside the aggregate, and alarm on queueing at the resource and on the ratio of the top consumer to the median, not on any tenant's own throughput. Split the fleet by what you sell — dedicated capacity for the handful of workloads whose latency is a contractual promise, pooled capacity for the long tail — since, when few workloads carry a latency promise, that is cheaper than isolating everything and far cheaper than isolating nothing. Then accept the mirror image: your batch job is somebody else's noisy neighbour, so the limits belong on your own workloads too, and the first place to look during an unexplained slowdown is what else shares the resource, not your own last deploy.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Monolithic Persistence](./monolithic-persistence.md) — Monolithic Persistence is the same effect inside one data store.
- [Starvation](./starvation.md) — A noisy neighbour is one cause of starvation: a heavy tenant holding the shared pool.
- [Connection-Pool Exhaustion](./connection-pool-exhaustion.md) — One tenant's burst holding every pooled connection is a noisy neighbour at the connection pool.

**Mitigated by**

- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — Separate pools per class, so a workload exhausts only its own
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — Per-tenant caps divide capacity by policy, not by who asks hardest
- [Backpressure](../patterns/concurrency/backpressure.md) — Slows the producer instead of letting a queue starve co-tenants
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — A queue absorbs the burst so shared capacity stays level
- [Partition Around Limits](../principles/partition-around-limits.md) — Partitioning gives a single tenant's spike somewhere to be contained
- [Deployment Stamp](../patterns/distributed/routing/deployment-stamp.md) — Give the heavy tenant its own stamp when a shared pool stops being defensible
- [Resource Organisation](../capabilities/resources.md) — Separate accounts or projects, with their own quotas, is the structural fix.
- [Container Orchestration](../patterns/distributed/coordination/container-orchestration.md) — Declared limits and placement stop one heavy workload eating a host's shared capacity
- [Multi-Tenancy](../patterns/distributed/routing/multi-tenancy.md) — Isolation models and per-tenant quotas contain a noisy tenant.
- [Token Bucket](../patterns/distributed/resilience/token-bucket.md) — A per-key token bucket gives each tenant a bounded burst.

**Threatens**

- [Thread Pool](../patterns/concurrency/thread-pool.md) — One shared pool lets a slow or heavy task class take every worker
- [Compute Resource Consolidation](../patterns/distributed/routing/compute-resource-consolidation.md) — Consolidation is the deliberate choice that creates the exposure.

<!-- relationships:end -->
