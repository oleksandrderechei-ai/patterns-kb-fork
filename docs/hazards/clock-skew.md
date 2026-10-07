---
title: Clock Skew
description: "Machines disagree about the time, so ordering by wall clock, lease expiry and last-write-wins give wrong answers"
area: hazards
owner: Oleksandr Derechei
tags: [consistency, state-management]
status: stable
aliases: [clock drift, time skew]
solves: [the older of two edits won because the server that took it had a clock running ahead, a record carries a timestamp earlier than the event that caused it, two servers both think they hold the lease because they disagree on when it expired, logs from different hosts merged by time show the reply before the request, "after a time sync, a timer went negative or fired far too late"]
---

# Clock Skew

Every machine keeps its own clock, no two agree, and any rule that orders events, expires a lease or picks a winner by comparing their readings gives the wrong answer whenever the gap is bigger than the gap between events.

## What it is
<!--meta block=description-->

Clock skew is the difference between the times two machines report for the same instant. You see it afterward: an update that vanished, a record dated before its cause, two holders of one lock. The trap is that a timestamp looks like a fact, so code compares stamps from two machines and treats the larger as later. The defining trait is silence: both stamps are valid times, so nothing errors when the skew exceeds the margin.

## Explained
<!--meta block=explain-->

Clock skew is the gap between what two machines say the time is. Each server counts time with its own crystal, which runs a little fast or slow, and a sync service corrects it over a network that adds delay of its own, sometimes by jumping the clock back. So readings are close but never equal, and no machine can see its own error. The trouble starts when code compares stamps from two machines and treats the larger as later. Last-write-wins keeps the higher timestamp, a lease ends when a local clock says so, and merged logs sort by time. Each is wrong whenever the skew is bigger than the gap between events, and nothing reports an error. Count order with logical clocks, not seconds. Guard a resource with an increasing token the resource checks, not with lease expiry alone. Time a duration on one machine with its monotonic clock. Where you must use real time, monitor offset and alert past the margin you assumed.

**Example.** Two writes hit the same profile 150 ms apart. The first goes to node A, whose clock runs 300 ms fast, and is stamped 10:00:00.400. The second goes to node B, whose clock is exact, and is stamped 10:00:00.250. The store keeps the higher stamp, so the older write wins and the user's later edit is gone, with no error logged. Replace the stamps with vector clocks and the store sees two concurrent versions and keeps both. Any two writes to one key closer together than the skew can resolve this wrong way, so more writes mean more losses. The cost of the fix is a merge rule for the siblings.

## How it happens
<!--meta block=causes-->

A clock is a counter driven by an oscillator, and an oscillator is never exact. Two healthy servers drift apart by some amount every hour, a sync service corrects them in steps, and a correction can jump a clock backward. The moves below are the ordinary ways a design ends up trusting a comparison between two of them.

Wall-clock time is used as an order. A store stamps each write with the local time and keeps the highest stamp, so a server whose clock runs ahead wins every conflict it takes part in. Apache Cassandra resolves conflicting cell writes this way by default, with the timestamp supplied by the client or the coordinator.

```mermaid caption="One order, two answers: the first write goes through the fast clock and the second through the slow one, so last-write-wins keeps the older write."
flowchart LR
    W1["Write 1 at true 10:00:00.100"] -->|"node A, clock +300 ms"| T1["stamped 10:00:00.400"]
    W2["Write 2 at true 10:00:00.250"] -->|"node B, clock exact"| T2["stamped 10:00:00.250"]
    T1 --> LWW{"Keep the higher stamp"}
    T2 --> LWW
    LWW -->|"write 1 wins"| Lost["Write 2 is lost, no error"]
```

- Lease expiry decided by local clocks: a holder computes "my lease ends at 10:00:30" from its own clock, the lock server computes the same deadline from another, and the two disagree about when the lease ended.
- A clock that steps backward after a sync correction, so a timer or a duration measured with wall-clock time comes out negative or too long. A time source meant for durations, the monotonic clock, does not step, but it only has meaning on one machine.
- A virtual machine that is paused, migrated or suspended, whose clock then lags for a while or jumps when the host catches it up.
- A leap second, a clock that is stuck or has no sync source, or a time server that is wrong, so a single machine is off by seconds or more while its peers are close to each other.
- Timestamps from clients, such as phones, whose clocks users can set to any value.
- A long garbage-collection or scheduler stall lets a lease lapse while the holder, with a healthy clock, still believes it holds it; a fencing token covers it.

## What it costs
<!--meta block=cost-->

- **Silent lost updates.** Last-write-wins by timestamp drops a write with no error, so two edits closer together than the skew can leave only one, and it may be the older.
- **Effects ordered before causes.** A log merged by time shows the reply before the request, and a trace that comes out of order sends the on-call engineer to the wrong service.
- **Mutual exclusion stops holding.** A lease that one side thinks has expired and the other thinks is live gives two holders, which is the double grant that [Split-Brain](./split-brain.md) shows at cluster scale.
- **Bugs that match the clock, not the code.** A defect that appears only when two nodes are 200 ms apart does not reproduce on a laptop, and the data it damaged looks valid.
- **Rules with a built-in margin.** Waiting out the uncertainty adds latency to every commit, and a token adds a round trip to the lock service on each grant.
- **Fixes cost something.** Vector clocks need a merge rule for siblings and metadata per writer; fencing needs the resource to check the token.

The cost grows with the write rate, because the chance that two conflicting writes fall within the skew grows with how many there are. A system that was right at 10 writes a second can lose updates at 10,000 a second without a single line changing.

## Getting out
<!--meta block=mitigation-->

Stop comparing clocks across machines for anything that decides correctness. To order events, use logical time: a [vector clock](../patterns/distributed/coordination/vector-clock.md) counts causal steps instead of seconds, so it finds the writes that were concurrent and keeps both for a merge, where a timestamp picks one and loses the other. A single counter per process, a Lamport timestamp, gives an order that respects cause and effect when you only need a tie-break.

To guard a resource, do not trust lease expiry alone. Have the lock service hand out a number that rises with each grant and make the protected resource reject any write stamped with a lower one, the fencing described under [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md). Then a holder whose lease ended without its knowledge, by skew or by a pause, has its writes refused. For durations and timeouts on one machine, use the monotonic clock, which does not step backward.

Where you must use real time, bound it. Keep clocks synced with a time service you monitor, alert when a machine's offset passes the margin your rules assume, and take a machine with a bad clock out of rotation. Some systems go further and make uncertainty part of the answer: Google's Spanner reads time from an API that returns an interval, TrueTime, and waits out the interval before it commits, so ordering holds, at the cost of a wait as long as the interval on each write. A hybrid logical clock keeps stamps close to real time and still ordered causally. For wall-clock last-write-wins, accept that the older write can win and keep it for data where that is tolerable.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Split-Brain](./split-brain.md) — Both can leave two holders of one lease, but skew comes from disagreeing clocks and split-brain from a cut link.

**Mitigated by**

- [Fencing Token](../patterns/distributed/coordination/fencing-token.md) — A rising token the resource checks does not depend on any clock.
- [Vector Clock](../patterns/distributed/coordination/vector-clock.md) — Counted events order writes without trusting wall clocks.

**Threatens**

- [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) — Skew makes a lease end earlier or later than the holder believes.
- [Lease](../patterns/distributed/coordination/lease.md) — Skew and drift between nodes are what make a lease expire early or late.
- [Conditional Write](../patterns/distributed/coordination/conditional-write.md) — Picking the winner by timestamp (last-write-wins) silently drops the newer update
- [Event Sourcing](../patterns/architecture/event-sourcing.md) — Ordering events from many hosts by wall-clock time scrambles the stream
- [Sliding Window](../patterns/distributed/coordination/sliding-window.md) — Wall-clock windows move their edge by the skew, so two hosts count different events.
- [Unique ID Generation](../patterns/distributed/coordination/unique-id-generation.md) — Ids ordered by wall clock mislead when node clocks disagree.
- [CRDT](../patterns/distributed/coordination/crdt.md) — Skewed clocks make a last-write-wins register keep the wrong value.

<!-- relationships:end -->
