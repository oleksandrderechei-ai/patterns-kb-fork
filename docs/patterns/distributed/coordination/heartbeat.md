---
title: Heartbeat
description: "Each node sends a small alive signal on a timer, and a failure detector suspects any node whose signal stops for longer than a timeout."
area: distributed-coordination
owner: Oleksandr Derechei
tags: [coordination, availability]
status: stable
aliases: [keepalive, failure detector]
solves: [a worker crashed and nothing noticed for minutes because no request was waiting on it, "I cannot tell whether a quiet node is dead, slow or cut off by the network", "healthy nodes get marked dead whenever one has a long pause, so the cluster keeps reshuffling", a connection stayed open for ages after the other machine lost power, a node holding a job vanished and the job sits unclaimed with no alarm]
---

# Heartbeat

Have each node send a small "still alive" message at a fixed interval, and have a failure detector on the other side suspect any node whose messages stop for longer than a timeout.

## What it is
<!--meta block=description-->

A node that crashes sends nothing, and silence looks the same as a quiet system. A heartbeat is a short message each node sends on a timer, so a monitor can suspect any node that stays quiet past a timeout. It gives a suspicion, never a fact: a crash, a long pause and a lost link all look the same.

## Explained
<!--meta block=explain-->

A heartbeat is a small message each node sends on a fixed timer, so others learn it is alive without asking it anything. A failure detector, the code on the receiving side, records when each message arrived and suspects any node whose silence runs past a timeout. Systems then act on that suspicion by starting a leader election or a failover. Choose it over waiting for a request to fail when nothing is waiting on the node, as with an idle worker, a lease holder or a cluster member.

- **Silence is ambiguous.** A pause longer than any you measured still looks like a crash, so ask other nodes to confirm before a drastic action.
- **Beats can lie.** A timer thread keeps beating while the work is stuck. Send the beat from the work path.
- **Quadratic traffic.** Every node watching every other grows with the square of the cluster, so a thousand nodes send a million beats per interval.

**Example.** Ten workers each send a beat every 1 s, and the detector's timeout is 5 s. Worker 7 dies just after its beat at 12 s, so the detector suspects it at 17 s. Its 40 jobs return to the pool within that 5 s window, plus one check interval. Now worker 3 stalls in an 8 s garbage-collection pause. It is suspected after 5 s of silence and its jobs are handed out again, then it wakes up and finishes them too. A 10 s timeout avoids that false alarm and slows real detection to 10 s.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a monitor learn that a node died when nothing is waiting on it? Each node sends a beat at 1 and 2, the detector stores the arrival time at 3, and at 4 it compares the silence with the timeout and passes the suspects on at 5."
flowchart LR
    A["Node A"]
    B["Node B"]
    D["Failure detector"]
    T[("Last-seen times")]
    U["Election or failover"]
    A -->|"1 beat every 1 s"| D
    B -->|"2 beat every 1 s"| D
    D -->|"3 record arrival time"| T
    T -->|"4 silence longer than 5 s?"| D
    D -->|"5 suspect node B"| U
```

```mermaid caption="What does a false alarm look like? Node B stalls for 8 s in a pause, the detector suspects it at 5 s of silence, and the next beat clears the suspicion. The timeout sat below the pause, so the suspicion was wrong."
sequenceDiagram
    autonumber
    participant B as Node B
    participant D as Detector
    B->>D: beat at 0 s
    B->>D: beat at 1 s
    Note over B: pause, no beats for 8 s
    D->>D: silence reaches 5 s, suspect B
    B->>D: beat at 9 s
    D->>D: clear the suspicion
    Note over D: raise the timeout above the pause, or confirm first
```

Each node sends a beat on a timer, and the detector stores the arrival time on its own clock. Using its own monotonic clock matters, since the detector compares durations and never trusts the sender's time. At each check the detector subtracts the last arrival from the current time and flags any node over the timeout.

The timeout is a multiple of the interval, commonly several beats, so one lost message does not cause an alarm. The detector's output is a suspicion that another pattern acts on, so what happens next should be safe to repeat or to reverse.

## Variations
<!--meta block=variations-->

- **Push heartbeat** — The node sends the beat on a timer. It is cheap and the node controls the rate, but a beat from a background thread proves only that the process runs, so send it from the work path or include a progress counter.
- **Pull probe** — The monitor asks the node whether it is alive, as with a [Health Endpoint](../resilience/health-endpoint.md). The check can test real work, but the monitor carries the polling load and every node needs an address it can reach.
- **Phi accrual detector** — Instead of a fixed timeout, the detector tracks the spread of recent gaps between beats and outputs a suspicion level that grows with the silence. You pick a threshold, and the detector adapts to a link whose delay changes. Hayashibara and colleagues described it in 2004, and Cassandra and Akka use it.
- **Indirect probing** — Before it declares a node dead, a node asks several others to ping the suspect, so one bad link is not read as a death. SWIM, a membership protocol by Das, Gupta and Motivala, does this and spreads results with [Gossip Protocol](./gossip-protocol.md).
- **Heartbeat on the lease** — A renewal of a [Lease](./lease.md) is itself a heartbeat, and its expiry is the timeout, so one message keeps the grant and shows liveness.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Failure is noticed without a request in flight** — an idle worker, a lease holder or a cluster member is detected within one timeout plus one check interval.
- **Detection time is bounded and known for a real crash** — it is at most the timeout plus one check interval of the detector, which you can put in a recovery target. A pause longer than the timeout is a false alarm, not a detection.
- **Tiny cost per node** — one small message a second per watched link, or a piggyback on traffic that already flows, so with a few neighbours or piggybacked beats a thousand nodes add little load; all-to-all does not, as the quadratic con shows.
- **A simple building block** — leader election, failover, job reclaiming and membership all rest on the same signal.

### Cons
<!--meta polarity=con-->

- **Slow is indistinguishable from dead** — a pause or a congested link looks like a crash, so set the timeout above your worst measured pause and confirm with other nodes before you act.
- **A beat can lie about health** — a timer thread keeps sending while the work threads are deadlocked, so send it from the path that does the work or attach a progress counter.
- **All-to-all beating grows with the square of the cluster** — a thousand nodes watching each other send a million messages per interval, so watch a few neighbours or use [Gossip Protocol](./gossip-protocol.md).
- **A cut-off monitor sees everyone as dead** — the monitor on the wrong side of a partition suspects every node, so require a majority of observers before a drastic action.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A silent failure costs you** — a worker holds a job, a node holds a lease or a leader holds a role, and the others must take over when it vanishes.
- **No request would reveal the failure** — the node is idle or only sends one-way, so an ordinary call timeout never fires.
- **You need detection faster than a connection timeout** — the system should react in seconds, not in the time an unprobed dead TCP connection can take to fail, which depends on keepalive settings.

### Avoid when
<!--meta polarity=avoid-->

- **A request already reveals the failure** — a call that has a [Timeout & Deadline](../resilience/timeout-deadline.md) fails by itself, and a heartbeat adds only traffic.
- **You need to know the node is ready for traffic** — liveness is not readiness, so ask a [Health Endpoint](../resilience/health-endpoint.md) that checks dependencies.
- **The cluster is very large and watched all-to-all** — the message count grows too fast, so spread the work with [Gossip Protocol](./gossip-protocol.md) and indirect probes.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a failure detector that records arrivals on a monotonic clock and lists nodes silent past a timeout"
class FailureDetector {
  private lastSeen = new Map<string, number>();

  // timeoutMs is a few beats, set above the longest pause you have measured.
  constructor(private timeoutMs: number) {}

  beat(node: string) {
    this.lastSeen.set(node, performance.now()); // our own clock, not the sender's
  }

  suspects(): string[] {
    const now = performance.now();
    return [...this.lastSeen]
      .filter(([, seen]) => now - seen > this.timeoutMs)
      .map(([node]) => node);
  }
}

// Sender: setInterval(() => send(detector, myId), 1000);
// Detector: setInterval(() => act(detector.suspects()), 1000);
// A suspicion is a hint, so act in a way that is safe to repeat or undo.
```

## In the wild
<!--meta block=wild-->

- **Apache Cassandra** — Nodes exchange gossip messages and decide whether a peer is down with a phi accrual failure detector, whose sensitivity is set by the phi_convict_threshold setting. {#wild-cassandra}
- **Akka Cluster** — Cluster members send heartbeats to a few neighbours and judge them with a phi accrual failure detector, with a threshold you can configure. {#wild-akka}
- **Kubernetes node leases** — Each kubelet renews a Lease object for its node as a heartbeat, and the node controller marks the node unreachable when the renewals stop for longer than the node-monitor-grace-period. {#wild-kubernetes}
- **Kafka consumer groups** — A consumer sends heartbeats to the group coordinator every heartbeat.interval.ms, and the coordinator removes it from the group and reassigns its partitions if none arrive within session.timeout.ms. {#wild-kafka}
- **HashiCorp memberlist** — The Go library behind Consul and Serf detects failed members with a SWIM-style protocol, which probes a node directly and then through other members before it marks the node suspect. {#wild-memberlist}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **heartbeat interval** — how often each node sends a beat; shorter detects sooner and costs more messages, and the interval bounds how finely the timeout can be set
- **failure timeout** — how many missed beats, or how much silence, before a node is suspected; keep it above your worst measured pause and several intervals long
- **phi threshold** — for a phi accrual detector, the suspicion level at which a node is convicted; a higher value tolerates more jitter and detects later
- **confirmers or quorum** — how many other nodes must also fail to reach a node before it is declared dead, which guards against one broken link
- **beat source** — whether the beat comes from a timer thread or from the work path, which sets whether a stuck application is noticed

### Signals to watch
<!--meta polarity=signal-->

- **beat inter-arrival jitter** — the spread and p99 of gaps between beats, which shows how close a healthy node runs to the timeout
- **false suspicions** — nodes suspected and then cleared by a later beat; a rising rate means the timeout is too short
- **detection time** — seconds from the real failure to the suspicion, measured in drills
- **heartbeat message rate** — total beats per second, which shows the cost of watching and its growth with cluster size

### Failure modes under load
<!--meta polarity=failure-->

- **pause false alarm** — a garbage-collection pause or a starved CPU outlasts the timeout and a healthy node is declared dead and its work duplicated
- **partitioned monitor** — the monitor on the minority side suspects every node and acts on a view that is wrong
- **stuck but beating** — a timer thread keeps sending while the work threads are deadlocked, so the node looks healthy and does nothing
- **synchronised beats** — every node beats in the same instant after a restart and the detector sees a periodic spike

### Readiness checklist
<!--meta polarity=check-->

- Set the timeout above the longest pause you have measured, and several intervals long
- Measure arrival times on the detector's monotonic clock, never the sender's clock
- Make the action on suspicion safe to repeat or to undo, and fence the old owner when it is not
- Send the beat from a path that proves work is progressing, or include a progress counter
- Test with a paused process and a partitioned network and check no healthy node is removed for good

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Resilience](../../../themes/resilience.md) — The liveness signal behind election, failover and lease renewal, which gives a suspicion and never a fact. {#fluency-resilience}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Failover](./failover.md) — A failure detector's suspicion is what starts a failover.
- [Lease](./lease.md) — A lease renewal is itself a heartbeat, and its expiry is the timeout.
- [Gossip Protocol](./gossip-protocol.md) — Gossip spreads heartbeat counters and suspicions so no node watches all the others.

**Alternative to**

- [Timeout / Deadline](../resilience/timeout-deadline.md) — A call deadline reveals a failure only while a request waits; a heartbeat covers the idle node.

**Enables**

- [Leader Election](./leader-election.md) — Leader election relies on heartbeats from the leader to know when to hold a new vote.

**Often confused with**

- [Health Endpoint Monitoring](../resilience/health-endpoint.md) — A heartbeat says a node is alive and is pushed on a timer, where a health endpoint answers whether it is ready, when asked.

**Prevents**

- [Split-Brain](../../../hazards/split-brain.md) — Only a tuned detector, with a long timeout and confirmers, avoids declaring a live node dead and promoting a second leader; fencing is still needed.

<!-- relationships:end -->
