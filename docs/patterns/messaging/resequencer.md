---
title: Resequencer
description: Releases out-of-order messages to the consumer in sequence
area: messaging
owner: Oleksandr Derechei
tags: [messaging, state-management, asynchrony]
status: stable
aliases: [reorder buffer]
solves: [Messages reach my consumer out of order and the step that needs sequence breaks, A payment event is processed before the order event it depends on, Adding more workers on one queue shuffled the order of events for the same customer, Retried messages overtake the originals and my state ends up wrong, One missing message in a sequence leaves the rest waiting and I cannot tell when to give up]
---

# Resequencer

Holds messages that arrive out of order in a buffer and releases them to the consumer in sequence, so a step that depends on order never sees a later message before an earlier one.

## What it is
<!--meta block=description-->

Messages stop arriving in the order they were sent as soon as they cross several consumers, retries or network paths. A consumer that assumes order then charges a cart before the last item was added. A **resequencer** is a stateful filter that buffers each message by its sequence number and passes one on only when every lower number has already gone out. One late message then delays the stream instead of corrupting every consumer behind it.

## Explained
<!--meta block=explain-->

A resequencer sits in front of a consumer that needs messages in order. It buffers each arriving message under its sequence number and releases one only when every lower number has already gone out, so a late message delays the stream instead of corrupting it. Choose it over making the consumer cope with any order when later steps truly depend on earlier ones and the transport cannot promise order, as happens with [competing consumers](./competing-consumers.md) or retries. Choose one ordered queue per key instead when you can give up parallelism across that key. Without it, a payment event arriving before the event that added the last item charges the wrong total, and nothing reports it.

- **A gap blocks the stream.** One lost message holds the rest; set a timeout from real arrival skew and dead-letter the gap.
- **Held messages use memory.** A restart loses the buffer and the next number; cap it per key and replay from the first unreleased one.
- **Senders must number consecutively.** A skipped number reads as a loss, so a producer that filters must renumber.

**Example.** Order o-9 sends events 1 (add item), 2 (add item), 3 (pay) and 4 (ship). They arrive as 1, 3, 4, 2. The resequencer releases 1, then holds 3 and 4 because it expects 2. Message 2 arrives 800 ms after 3, and 2, 3 and 4 leave together, so payment sees both items. Without it, the charge would miss item 2. The cost is that payment waited 800 ms. If 2 never arrives, a 30 s timeout releases 3 and 4 and reports the gap, so the stream stops waiting after 30 s, not forever.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does the order come back from? Step 3 — the buffer holds every message that arrived early, and step 4 releases a message only when the next expected number is in hand, so the consumer sees 1, 2, 3, 4 however the channel shuffled them."
flowchart LR
    Prod["Producers"]:::ext
    Ch[("Channel: arrives as 1, 3, 4, 2")]
    subgraph RS["Resequencer"]
        Buf[("Buffer of early messages")]
        Next["Next expected number"]
    end
    Cons["Order-sensitive consumer"]:::ext
    DLC[("Dead-letter channel")]
    Prod -->|"1 stamped with a sequence number"| Ch
    Ch -->|"2 receive in any order"| Buf
    Buf -->|"3 hold until the gap fills"| Next
    Next -->|"4 release in sequence"| Cons
    Next -.->|"5 gap timed out"| DLC
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What does a late message cost? Only the wait. Messages 3 and 4 sit in the buffer until 2 arrives, then all three leave at once; if 2 never comes, the timeout turns an unbounded wait into a reported gap."
sequenceDiagram
    autonumber
    participant P as Producer
    participant R as Resequencer
    participant C as Consumer
    P->>R: message 1
    R->>C: release 1
    P->>R: message 3
    Note over R: expected 2, hold 3
    P->>R: message 4
    Note over R: expected 2, hold 3 and 4
    P->>R: message 2
    R->>C: release 2, 3, 4
```

The resequencer keeps two things per stream: the **next expected number** and a buffer of messages that came early. A message below the expected number is a duplicate or a replay and is dropped. A message equal to it is released, and the buffer is then drained for as long as the following numbers are present.

The stream is defined by a key, usually the same value a [correlation identifier](./correlation-identifier.md) carries. Numbering must be consecutive within that key. If the sender skips a number on purpose, for example because it filtered a message out, the resequencer reads the skip as a loss and waits for it. Sequence numbers come from the sender, never from arrival order, which is the thing that went wrong.

## Variations
<!--meta block=variations-->

- **Per-key resequencer** — Each key, such as an order id, gets its own expected number and buffer. One stuck order then blocks only itself, and memory is held per active key instead of globally.
- **Timeout release** — After a wait limit, the resequencer skips the missing number, reports the gap and continues. A message that arrives after its number was skipped falls below the expected number, so send it to a dead-letter channel or it is dropped unseen. It trades a guarantee of completeness for a guarantee that the stream keeps moving.
- **Batch resequencer** — Collects a known set, then sorts and releases it whole. It fits a [splitter](./splitter.md) that stamps a total count, and it behaves like an [aggregator](./aggregator.md) that outputs the messages in order instead of one merged message.
- **Ordered stream instead** — Route all messages of one key to one consumer so the broker never reorders them, as a [sequential convoy](./sequential-convoy.md) does. No buffer is needed, and parallelism across keys is the only parallelism you keep.
- **Bounded window** — The buffer has a maximum size. When it fills, the oldest held message is released and the gap is treated as lost, which caps memory at a known figure.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Restores order without a single-consumer bottleneck** — workers stay parallel, and only the final step sees a sequence. The resequencer itself holds state per key, so route by key to scale it.
- **Hides the transport from the consumer** — retries, redelivery and parallel paths can reorder messages, and the consumer need not know.
- **Makes a late message a delay, not a corruption** — the consumer never acts on step 3 before step 2.
- **Gives gaps a name** — a timeout reports the missing number or range, instead of a silent wrong state later.

### Cons
<!--meta polarity=con-->

- **A lost message blocks everything behind it** until the timeout fires. Pick a timeout from the real arrival skew, and send the gap to a [dead-letter channel](./dead-letter-channel.md).
- **The buffer holds state in memory**, so a restart loses held messages and the next expected number. Ack a message only after release and persist the next expected number with the buffer, or redelivery has nothing to replay.
- **Every message waits for its predecessors**, so tail latency rises with the worst skew. Resequence per key, never globally.
- **Senders must number messages consecutively per key**, which is new coupling. A deliberate skip looks like a loss, so a producer that filters must renumber.
- **A sender that restarts at 1** looks like a stream of duplicates. Carry an epoch beside the number, or reset the stream explicitly.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A consumer applies changes in sequence** and a later message before an earlier one gives a wrong end state.
- **Several consumers or retry paths** sit between producer and consumer, so arrival order no longer matches send order.
- **You can bound how late a message can be**, so a timeout is a real figure and not a guess.

### Avoid when
<!--meta polarity=avoid-->

- **The consumer can accept any order**, for example because each message carries a full state and the highest version wins.
- **One ordered queue per key already works** and the parallelism it costs is acceptable.
- **Messages carry no reliable sequence number** and the sender cannot add one, so the resequencer has nothing to sort by.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — release in order per key, hold the early, report the gap on timeout"
interface Msg { key: string; seq: number; body: unknown }
class Resequencer {
  private next = new Map<string, number>();            // next expected number per key
  private held = new Map<string, Map<number, Msg>>();  // early arrivals per key
  constructor(private release: (m: Msg) => void, private onGap: (key: string, from: number, to: number) => void) {}

  accept(m: Msg): void {
    let n = this.next.get(m.key) ?? 1;
    if (m.seq < n) return;                             // duplicate, replay, or a late arrival after a skip: drop
    const buf = this.held.get(m.key) ?? new Map<number, Msg>();
    this.held.set(m.key, buf.set(m.seq, m));
    while (buf.has(n)) {                               // drain every consecutive message
      this.release(buf.get(n)!);
      buf.delete(n++);
    }
    this.next.set(m.key, n);
  }

  // A timer calls this when a key has made no progress for the gap timeout:
  // skip to the lowest held number and report the gap instead of waiting forever.
  giveUp(key: string): void {
    const buf = this.held.get(key);
    if (!buf?.size) return;
    const lowest = Math.min(...buf.keys());
    this.onGap(key, this.next.get(key) ?? 1, lowest);   // report the skipped range [from, lowest)
    this.next.set(key, lowest);
    this.accept(buf.get(lowest)!);
  }
}
```

## In the wild
<!--meta block=wild-->

- **Apache Camel Resequencer** — The resequence() route step reorders exchanges by an expression. Batch mode collects and sorts a set, and stream mode releases consecutive numbers as they arrive, with a timeout so a gap does not block forever. {#wild-camel-resequencer}
- **Spring Integration Resequencer** — A resequencer endpoint buffers messages by correlation key and sequence number, and releases them in order once the sequence is complete or a timeout fires. {#wild-spring-integration-resequencer}
- **TCP receive buffer** — The receiver holds segments that arrive early and hands bytes to the application only in sequence-number order, the same mechanism applied to a byte stream. {#wild-tcp-reordering}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Gap timeout** — How long a stream waits for a missing number before skipping it. Set it above a high percentile of measured arrival skew per key. Too short skips a number that was only late, and that message is then dropped as a duplicate; too long stalls everything behind the gap.
- **Buffer capacity** — The most held messages per key and in total. It caps memory, and a full buffer forces a release or a rejection.
- **Gap policy** — Whether a timed-out gap is skipped, sent to a dead-letter channel, or halts the stream for a person to decide.
- **Key granularity** — The field that defines a stream. A finer key, such as one order, confines a stuck gap to that order.

### Signals to watch
<!--meta polarity=signal-->

- **Held message count** — Messages waiting in the buffer. A count that climbs without falling back means a gap is not filling.
- **Age of the oldest held message** — Time since the first early arrival. It shows a stalled key before the timeout fires.
- **Gap timeout rate** — How often a wait ends by timeout rather than by the missing message. A rise means loss or growing skew upstream.
- **Time in buffer** — Added latency per message. Its tail is the real cost of resequencing.

### Failure modes under load
<!--meta polarity=failure-->

- **Stalled stream** — One lost message holds every later message of its key until the timeout, and downstream sees silence.
- **Buffer growth** — A burst of early arrivals or many stuck keys fills memory, and the process dies with the buffer.
- **Restart wipes the buffer** — Held messages vanish and the next expected number is forgotten, so the stream either stalls or replays.
- **Sequence reset** — A sender that restarts at 1 is read as duplicates and dropped, so its new messages never arrive.

### Readiness checklist
<!--meta polarity=check-->

- Every message carries a key and a consecutive sequence number from the sender
- The gap timeout comes from measured arrival skew, not a guess
- A timed-out gap goes somewhere visible, such as a dead-letter channel
- Buffer size is capped per key and in total
- A sender restart or reset has a defined behaviour

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Message Flow](../../themes/message-flow.md) — Put out-of-order messages back in sequence before passing them on. {#fluency-message-flow}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Competing Consumers](./competing-consumers.md) — Parallel consumers finish out of order, so a resequencer downstream restores the original sequence
- [Splitter](./splitter.md) — The parts of a split message can arrive out of order, and the resequencer puts them back by sequence number
- [Dead Letter Channel](./dead-letter-channel.md) — Receives the gap a timeout skipped, and the late message that follows it, instead of dropping them silently

**Alternative to**

- [Sequential Convoy](./sequential-convoy.md) — Fixes order after the fact by buffering until the gap fills, so any consumer may process in parallel

**Often confused with**

- [Aggregator](./aggregator.md) — Reorders messages and passes each one on, but never combines them

**Exposed to**

- [Head-of-Line Blocking](../../hazards/head-of-line-blocking.md) — Can fall into head of line blocking when it holds all later messages until the missing earlier one arrives

**Implemented by**

- [Messaging & Eventing](../../capabilities/messaging.md) — Integration platforms and the Camel library ship the step that restores the order of out-of-order messages as a ready-made building block.

<!-- relationships:end -->
