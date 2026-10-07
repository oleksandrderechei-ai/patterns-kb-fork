---
title: Scalability
description: Growing capacity with load without rewriting the system
area: themes-scale
owner: Oleksandr Derechei
tags: [scalability, load-balancing, throughput]
status: stable
aliases: [horizontal scaling, scale-out]
---

# Scalability

Growing capacity with load without rewriting the system — by cloning what can be cloned and partitioning what can't. This theme is the set of patterns that turn "add more traffic" from an architecture emergency into a routine operation.

## The question
<!--meta block=description-->

Every system that succeeds meets a load it was not built for. A bigger machine works for a while, then hits a ceiling: the biggest machine you can buy, rising cost per unit of capacity, and a single point of failure. This theme covers adding machines instead, separately for compute (clone it and spread requests) and for data (split it, replicate it, or both), without coordination overhead eating the gain.

## Explained
<!--meta block=explain-->

Scalability means adding machines instead of buying a bigger one, and structuring the system so each added machine really adds capacity. Ask first what you are scaling, compute or data, and which load dominates: request volume, dataset size, or reads against writes. Compute is the easy half once your service keeps no user state in memory (a [stateless service](../patterns/distributed/routing/stateless-service.md)): put a [load balancer](../patterns/distributed/routing/load-balancer.md) in front and let [autoscaling](../patterns/distributed/routing/autoscaling.md) add or remove copies. If reads dominate on the data side, [replication](../patterns/distributed/coordination/replication.md) multiplies read capacity. If writes or dataset size dominate, [sharding](../patterns/distributed/routing/sharding.md) splits the data across machines. Choose the wrong axis and the new machines do nothing, since a copy of a write-heavy store must still apply every write.

- **Lagging copies.** Replicas trail the primary. Decide how stale a read may be, measure lag in seconds, and route sensitive reads to the primary.
- **Rebalancing.** Adding a shard moves data. Place keys with consistent hashing so adding the Nth node moves only about 1/N of the keys.
- **Cross-shard queries.** A query spanning shards must ask all of them. Choose a key keeping common queries on one shard; count shards per top query.
- **Hot shards.** One busy key or skewed range overloads one machine while others idle. Pick a high-cardinality key; split or copy hot keys.

**Example.** A database primary handles 3,000 operations a second. Traffic is 9,000 reads and 300 writes a second. Three read replicas give 4 machines, about 10,800 reads of capacity once each copy applies the 300 writes, and the primary still copes with 300 writes. Months later writes reach 4,000 a second. Replicas do not help, because each must apply all 4,000. Two shards split writes to 2,000 each, which fits, and each shard keeps its own read replicas for the 9,000 reads. The costs arrive too: a read served by a replica can be seconds old, and a query that spans both shards must now ask both.

## The trade-space
<!--meta block=tradespace-->

Horizontal scale is not free: it trades a single, simple system for a fleet with coordination problems. Every pattern in this theme is really answering one of two questions: **what am I scaling** (compute or data), and **along which axis** (throughput of requests, size of dataset, or ratio of reads to writes). Get the axis wrong and you add machines that don't help: replicating a write-bound store doesn't relieve write pressure, and sharding a read-heavy, small dataset just adds cross-shard complexity for no gain. Until measured load nears what one primary was load-tested to carry, a bigger machine is the cheaper answer; past that, the share of reads against writes picks the axis.

For compute, the answer is usually simple once the precondition holds: make the service stateless, put a load balancer in front of it, and let an autoscaler add or remove instances as demand moves. For data, the fork is sharper. If the problem is read volume, replication multiplies read capacity by adding copies. If the problem is write volume or dataset size, you have to partition the data itself — sharding — and then solve the placement problem that partitioning creates, which is where consistent hashing applies. A separate move, command query responsibility segregation (CQRS), splits the read model from the write model so each scales to its own load shape.

The overhead you're trading against is real: a sharded system needs a rebalancing strategy, a replicated one needs a staleness budget, and a queue-based one needs consumers that don't step on each other. Scalability done well hides that overhead behind the pattern; done poorly, it just relocates the bottleneck to the coordination layer.

```mermaid caption="Compute scales by cloning stateless replicas; data scales by replicating or partitioning, depending on which side of the read/write ratio is growing."
flowchart TB
    L{"What is under load"}
    L -->|"Compute, request volume"| S["Stateless replicas behind a load balancer, autoscaled with demand"]
    L -->|"Data, dataset size"| D{"Reads or writes growing"}
    D -->|"Reads"| R["Replicate, fan out reads across copies"]
    D -->|"Writes"| P["Partition, shard data across nodes"]
    P -->|"place shards"| H["Consistent hashing reshuffles minimally on resize"]
```

## Patterns that grow capacity
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Load Balancer](../patterns/distributed/routing/load-balancer.md) {#tour-load-balancer}

The front door for horizontal scale: it spreads incoming requests across every instance in the fleet, so the capacity autoscaling adds actually gets used. Health checks pull dead instances out of rotation after a few failed probes, which bounds the lost requests but does not remove them.

### [Stateless Service](../patterns/distributed/routing/stateless-service.md) {#tour-stateless-service}

Statelessness is what lets you add instances freely: if a request can land on any instance because no instance holds session state the others lack, you can add or kill instances without a migration plan. Push the state to a shared store and the fleet becomes disposable. That store is now data you must scale. This is the precondition for the load balancer, autoscaling and competing consumers.

### [Autoscaling](../patterns/distributed/routing/autoscaling.md) {#tour-autoscaling}

Watches a signal — central processing unit (CPU), queue depth, request latency — and resizes the fleet to match it, so you pay for the capacity you're using instead of provisioning year-round for a peak that shows up twice a year.

### [Sharding](../patterns/distributed/routing/sharding.md) {#tour-sharding}

Splits a dataset across many nodes by key, so write throughput scales with node count when the key spreads writes evenly, instead of hitting the ceiling of a single primary. The cost is that queries spanning shards get harder, and a skewed key creates hot spots that leave one node as the ceiling.

### [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) {#tour-consistent-hashing}

The placement scheme that makes sharding survive growth: adding or removing a node remaps only a thin slice of keys instead of rehashing the whole dataset, so rebalancing stays cheap as the fleet changes size.

### [Replication](../patterns/distributed/coordination/replication.md) {#tour-replication}

Multiplies read capacity by serving from copies instead of a single primary. It scales reads, not writes, and every copy is a small consistency decision — how stale a follower is allowed to get before it matters.

### [Competing Consumers](../patterns/messaging/competing-consumers.md) {#tour-competing-consumers}

Turns a queue of work into parallel throughput: add consumer instances and the backlog drains faster. The only coordination is each consumer claiming its own message. Delivery can repeat, so make handlers safe to repeat, and parallel consumers give up order unless related messages share a partition key.

### [CQRS](../patterns/architecture/cqrs.md) {#tour-cqrs}

Separates the write model from the read model so each can be scaled, indexed, and stored on infrastructure tuned to its own load shape — expensive read joins stop competing with write validation for the same schema.

### [Functional Partitioning](../patterns/distributed/routing/functional-partitioning.md) {#tour-functional-partitioning}

Before splitting one dataset by key, check whether it is really several datasets sharing a server. Giving each business area its own store lets each be sized, tuned and scaled for its own access pattern — and stops a report in one area consuming the capacity another one needs.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Lean | Reach for |
| --- | --- | --- |
| Rising request volume on stateless work | Scale horizontally | [Load Balancer](../patterns/distributed/routing/load-balancer.md) + [Autoscaling](../patterns/distributed/routing/autoscaling.md) |
| Dataset or write throughput outgrowing one primary | Partition data | [Sharding](../patterns/distributed/routing/sharding.md) + [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) |
| Read traffic far exceeds writes | Multiply copies | [Replication](../patterns/distributed/coordination/replication.md) |
| A backlog of independent work items | Parallelize consumers | [Competing Consumers](../patterns/messaging/competing-consumers.md) |
| Read and write load shapes pulling in different directions | Split the models | [CQRS](../patterns/architecture/cqrs.md) |
| None of the above works until this holds | Make instances interchangeable | [Stateless Service](../patterns/distributed/routing/stateless-service.md) |
| One store serves several unrelated business areas that compete for capacity | Split by business area | [Functional Partitioning](../patterns/distributed/routing/functional-partitioning.md) |

## Related areas
<!--meta block=siblings-->

- [CAP Theorem](./cap-theorem.md) — Every shard and replica added to scale is another node CAP reasoning has to account for.
- [Consistency & Replication](./consistency-and-replication.md) — The consistency cost of the copies and partitions scalability creates.
- [Handling Spikes](./spike-handling.md) — Autoscaling smooths sustained growth; spikes arrive faster than a fleet can resize.
- [Scaling Reads](./scaling-reads.md) — The read ladder in order, replicas then caches and the edge; this theme picks the axis, that page climbs it.
- [Scaling Writes](./scaling-writes.md) — The write ladder past a single primary, partitioning then queues and batching; this theme picks the axis, that page climbs it.
