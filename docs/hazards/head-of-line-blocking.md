---
title: Head-of-Line Blocking
description: "One stuck item at the front of an ordered lane holds up everything behind it, though none of those items is slow"
area: hazards
owner: Oleksandr Derechei
tags: [performance, latency]
status: stable
aliases: [HOL blocking, HOLB]
solves: [small requests that need 5 ms wait 30 seconds in the queue behind one slow job, one hung message stops the whole queue while the consumers sit idle, my fast requests are slow whenever one slow request is ahead of them on the same connection, one lost packet stalls every request sharing the same connection, the oldest message in the queue keeps getting older and nothing behind it is processed]
---

# Head-of-Line Blocking

One stuck or slow item at the front of an ordered lane holds up every item behind it, though none of them is slow or broken, so fast work waits for slow work only because of its place in line.

## What it is
<!--meta block=description-->

Head-of-line blocking happens when work must leave a lane in the order it entered and the item at the front cannot move, so everything behind it waits. You see items needing 5 ms spend 30 s in the system, idle consumers, and an oldest-item age that climbs, and depth that rises only if arrivals continue. The defining trait is that the blocked items are innocent: the lane has capacity, but the order rule forbids anything passing the head.

## Explained
<!--meta block=explain-->

Head-of-line blocking is a lane that must release items in order and cannot, because the item at the front is stuck. Everything behind it waits, though each item is quick and healthy. It appears in a queue read by one ordered consumer, in HTTP/1.1 pipelining (several requests sent without waiting, answered in order), in a switch with one input queue, and in HTTP/2, where independent streams share one TCP connection and one lost packet stalls them all. You recognise it when the time a request spends working is normal and the time it spends waiting is not. The fix is to stop forcing one global order. Order only inside a group, so a stuck item blocks only its own group, and give slow work its own lane. Bound the head with a timeout per item, then retry later or move it to a dead-letter queue (a side queue for failures). Where the lane is a transport, use one that does not order across streams, such as HTTP/3.

**Example.** A single consumer reads an ordered queue. Item 1 calls a partner that hangs for 30 s. The 99 items behind it take 20 ms each, so they need 2 s in total. Instead each waits at least 30 s, and the consumer is idle for the whole stall. With a 2 s timeout per item and a dead-letter queue, the head blocks the lane for at most 2 s, and the other 99 finish by about 4 s. The cost is that item 1 is retried later or inspected by a person, and it is no longer in order with the rest.

## How it happens
<!--meta block=causes-->

The cause is a straight line, with no loop: an ordering rule, plus one item that takes much longer than its neighbours. A retry makes it worse, since a head item retried in place holds the lane for each attempt, but the hazard does not feed itself the way a retry storm does.

- A strict order over unrelated items: the lane keeps global first-in, first-out order because that is the simplest rule, and most items never needed to be ordered against each other.
- No limit on how long one item may take: a call with no timeout, a lock that is never released or a download over a slow link holds the head for as long as it likes.
- Unlike work in one lane: a 20 ms lookup and a 10-minute export share a queue, so the cheap work is paced by the expensive work.
- Retry in place: a message that fails is retried at the head, so one bad payload blocks the lane for every attempt. That case has its own page, [poison messages](./poison-message.md).
- A transport that orders more than the application needs: HTTP/2 sends many independent streams over one TCP connection, and TCP delivers bytes in order, so one lost packet stalls every stream until it is retransmitted. HTTP/3 moved to QUIC to remove this.
- One lane because one lane is cheap: opening more connections, partitions or queues costs setup and state, and the single lane was kept to avoid it.

## What it costs
<!--meta block=cost-->

- **Fast requests inherit slow latency.** A request that needs 5 ms waits as long as the stuck item ahead of it, so the user sees the slowest case, not the typical one.
- **Capacity idles while work waits.** Other consumers, other links and other output ports are free, and the lane cannot use them, so you pay for hardware that does nothing during the stall.
- **Tail latency rises with no change in load.** p99 spikes when a slow item holds up many others, while the median looks fine.
- **It is hard to see.** Each item's own time is normal and only the wait is long, so a trace of a single request shows no slow step.
- **One bad item stops everything behind it.** A poison message can stall a partition or queue until a timeout, dead-letter rule or person moves it.
- **It spreads in a pipeline.** The stalled stage delivers nothing, so the next stage starves, and the effect shows up several hops from where it started.

## Getting out
<!--meta block=mitigation-->

Give each item its own place to wait. If most items never needed ordering against each other, order only within a group and let groups pass one another: a [sequential convoy](../patterns/messaging/sequential-convoy.md) orders by a key such as an order id, so a stuck item blocks only its own group. A [priority queue](../patterns/messaging/priority-queue.md) or a separate queue per class of work keeps cheap, urgent items out from behind slow ones. With several consumers taking the next item from one queue, a stuck item holds one worker and not the whole lane. Several consumers on one queue give up global order, so use that only where order is not needed.

Then bound the head. Put a timeout on each item, so nothing can hold the front forever, and when it expires move the item out. Retry it later, or send it to a dead-letter queue after a few attempts, so the lane keeps moving and the bad item is kept for inspection. Pass a deadline with each request through [timeouts and deadlines](../patterns/distributed/resilience/timeout-deadline.md) so the work behind the head is not done for callers who have left. Cut large jobs into small chunks, so the longest item in a lane is short. Alert on the age of the oldest item in each lane, since each item's own time looks normal.

Where the lane is a transport, change the transport. Move from HTTP/1.1 pipelining to HTTP/2 to remove blocking at the HTTP level, and to HTTP/3 to remove it at the TCP level. HTTP/2 still stalls every stream on one lost packet, which is why HTTP/3 is the second step. Use several connections where one is a bottleneck, and in a switch use a queue per output so a packet bound for a busy port cannot hold up the rest.

Finally, hide what you cannot remove. If a slow server at the front is the cause, [hedged requests](../patterns/distributed/resilience/hedged-request.md) send a copy to another replica, so the caller no longer waits on one slow lane. The half-fix to watch for is a split that is too coarse: a convoy keyed on a field with a few values, or two queues where one class still holds a slow item, puts a head in front of every group. Hedge only idempotent requests; a duplicate in an ordered lane repeats work.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Often confused with**

- [Poison Message](./poison-message.md) — A failing message at the head is one cause of head-of-line blocking.
- [Starvation](./starvation.md) — Here the lane has capacity and cannot use it, where starvation is a policy that keeps picking other work.

**Mitigated by**

- [Hedged Request](../patterns/distributed/resilience/hedged-request.md) — Hedging hides a slow server at the front by sending the request elsewhere.
- [Priority Queue](../patterns/messaging/priority-queue.md) — Separate lanes by class keep urgent items out from behind slow ones.
- [Message Queue](../patterns/messaging/message-queue.md) — Many consumers on one queue mean a stuck item holds one worker, not the whole lane.
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — A per-item timeout bounds how long any one item may hold the front.
- [Sequential Convoy](../patterns/messaging/sequential-convoy.md) — Ordering only within a keyed group means a stuck item blocks only its own group.
- [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) — Dead-letter channel is the exit for a stuck head that retries cannot clear.
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — Competing consumers is the multi-worker form of the fix for a stuck head.

**Threatens**

- [Resequencer](../patterns/messaging/resequencer.md) — It holds all later messages until the missing earlier one arrives
- [WebSocket](../patterns/messaging/websocket.md) — One multiplexed ordered connection lets one slow message delay all the others behind it
- [Active Object](../patterns/concurrency/active-object.md) — An active object's one scheduler thread makes every slow request block the queue behind it
- [Persona Identification & Sanction Check (V2)](../designs/persona-identification-v2.md) — a design that accepts the blocking on purpose: a per-flow delivery lane bounded by an attempt budget

<!-- relationships:end -->
