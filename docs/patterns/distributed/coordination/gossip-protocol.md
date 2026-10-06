---
title: Gossip Protocol
description: Nodes spread state by talking to a few random peers
area: distributed-coordination
owner: Oleksandr Derechei
tags: [coordination, availability]
status: stable
aliases: [epidemic protocol, epidemic algorithm]
solves: [every node telling every other node about changes makes the connection count explode, when the machine that broadcasts membership dies nobody learns who is still alive, nodes join and leave constantly and my static config file cannot keep up, I need to detect dead machines without one central health checker becoming a bottleneck, my cluster grew to hundreds of nodes and keeping everyone informed now costs more than the actual work]
---

# Gossip Protocol

Each node periodically shares what it knows with a few randomly chosen peers, and after a handful of rounds that update has spread, epidemic-style, to the entire cluster — with no coordinator and no broadcast storm.

## What it is
<!--meta block=description-->

A gossip protocol spreads membership and state changes through a large cluster with no coordinator. Each round, every node swaps what it knows with a few random peers, and whoever learns something passes it on. An update reaches everyone in about log N rounds, not instantly, and nothing is guaranteed or ordered. Cassandra, Consul and Serf use it for membership and failure detection.

## Explained
<!--meta block=explain-->

In a gossip protocol, every node regularly picks a few random peers and swaps what it knows with them, so news spreads through the cluster like a rumour with no central broadcaster. Each node merges what it hears and passes it on in its next round, so the work spreads evenly, nodes can join or die mid-round, and an update reaches everyone in rounds that grow with the logarithm of the cluster size. Choose it over one node telling all N peers, or an N-squared mesh of links, when membership changes fast and a view a few rounds stale is acceptable.

- **No guarantees.** A slow node can lag by rounds and conflicts need a merge rule you supply.
- **Constant chatter.** Anti-entropy rounds send even when nothing changed. Keep fanout and interval just high enough.
- **Flapping.** A failure timeout below the longest pause makes healthy nodes look dead. Set it above that pause.

**Example.** A cluster has 1,000 nodes, each pushing to 1 random peer per second. One node learns that node 42 left. The informed set roughly doubles each round, so about 10 seconds later most nodes know, and a few stragglers take several more rounds. Telling 3 peers a round cuts the spread to about 5 rounds. Push-pull converges faster. Every node sends 1 message a second even when nothing changed, so the cluster carries 1,000 messages a second as steady chatter. A node paused for 8 s by garbage collection, against a 5 s failure timeout, is declared dead and then returns, so set the timeout above 8 s.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one node's update reach the whole cluster without telling everyone itself? Each node that has heard picks a small random fanout and passes on what it merged, so reach roughly doubles per round and the update saturates N nodes in about log N rounds."
flowchart LR
    N1["Node A — has the update"]
    subgraph R1["One round, fanout of 2"]
        N2["Node B"]
        N3["Node C"]
    end
    N4["Node D"]
    N5["Node E"]
    N6["Node F — converged"]
    N1 -->|"1 exchange state with a random peer"| N2
    N1 -->|"2 exchange state with a second random peer"| N3
    N2 -->|"3 merge what is newer, pass it on"| N4
    N3 -->|"4 merge what is newer, pass it on"| N5
    N4 -->|"5 merge what is newer, pass it on"| N6
```

## Variations
<!--meta block=variations-->

- **Anti-entropy vs. rumor-mongering** — Anti-entropy periodically reconciles full state with a random peer, self-healing but bandwidth-heavy; rumor-mongering only gossips an item while it's still "hot" and drops it once it seems stale, which is cheaper but can leave stragglers behind.
- **Push, pull, push-pull** — Push sends your state at a peer, pull asks a peer for theirs, push-pull does both in one round-trip. Push-pull converges fastest and is the common default.
- **SWIM-style failure detection** — Layers indirect probing onto gossip: if a direct ping to a peer times out, ask a few other members to probe it on your behalf before declaring it dead, cutting false positives from one slow link.
- **Epidemic broadcast trees (Plumtree)** — Builds a spanning tree from gossip's own membership view for cheap, efficient common-case broadcast, then falls back to plain gossip to repair the tree when a branch breaks.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Scales to large**, dynamic clusters without a coordinator or an all-to-all broadcast.
- **Degrades gracefully**, since no single node's failure stalls dissemination.
- **Spreads load roughly evenly**, since peers are chosen at random; no fixed coordinator carries the whole cluster.
- **Membership tracking and failure detection** run on the same exchanges, though a usable detector still needs tuning.

### Cons
<!--meta polarity=con-->

- **Only eventually consistent** — a node can act on stale state for several rounds after an update.
- **Convergence is probabilistic**; a worst-case node can lag noticeably behind the rest.
- **Heartbeat and anti-entropy rounds** cost steady background bandwidth even when nothing changed; rumor-mongering alone goes quiet.
- **Concurrent conflicting updates need a merge strategy** of their own — gossip doesn't order anything.
- **Deletions need tombstones** kept longer than the worst-case spread time, or a lagging peer re-introduces the removed entry.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The cluster is large** or its membership changes often — nodes joining, leaving, or failing.
- **You need failure detection** or state dissemination that survives no coordinator staying up.
- **Eventual consistency is fine** for the state being spread — membership, routing tables, cache invalidation.

### Avoid when
<!--meta polarity=avoid-->

- **You need a single agreed** value or linearizable reads — reach for [Quorum & Consensus](./quorum-consensus.md) instead.
- **The cluster is small** and static enough that a plain broadcast is simpler and cheap.
- **Updates must be observed** in a specific order by every node — gossip's arrival order isn't guaranteed.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal gossip round"
type NodeId = string;
interface PeerState { version: number; data: Record<string, unknown>; }
type Digest = Map<NodeId, PeerState>;

class GossipNode {
  private state: Digest = new Map();

  constructor(private readonly peers: NodeId[], private readonly fanout = 3) {}

  // One round: pick a few random peers, exchange state, merge
  async round(exchange: (peer: NodeId, mine: Digest) => Promise<Digest>) {
    for (const peer of pickRandom(this.peers, this.fanout)) {
      this.merge(await exchange(peer, this.state)); // push-pull
    }
  }

  // Only the owner of an entry bumps its version; peers only copy newer ones.
  private merge(incoming: Digest) {
    for (const [id, remote] of incoming) {
      const local = this.state.get(id);
      if (!local || remote.version > local.version) {
        this.state.set(id, remote); // newer version wins
      }
    }
  }
}

function pickRandom<T>(xs: T[], n: number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
```

## In the wild
<!--meta block=wild-->

- **Apache Cassandra** — Every node gossips membership and heartbeat state each second, so the ring needs no coordinator to know who is up; it uses a phi-accrual failure detector whose sensitivity is tuned by phi_convict_threshold rather than a hard timeout {#wild-cassandra}
- **HashiCorp Serf** — A standalone SWIM-based gossip library for membership and failure detection, and the layer Consul builds its cluster on; the underlying memberlist library exposes GossipInterval, the fanout, and separate probe and suspicion timeouts as explicit dials {#wild-serf}
- **Redis Cluster** — Runs a separate gossip bus on a dedicated port between nodes to propagate slot assignments and failure suspicions; cluster-node-timeout sets how long a node may be unreachable before peers agree to mark it failed {#wild-redis-cluster}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **fanout** — the number of random peers each node exchanges with per round; higher fanout converges in fewer rounds but multiplies per-round bandwidth
- **gossip interval** — how often a round fires; shorter intervals cut convergence time and raise steady background chatter
- **failure-detection timeout** — how long a peer may be silent or unreachable before it is suspected and then declared dead (a probe timeout in SWIM-style protocols, the phi threshold in phi-accrual detectors); set it above the worst-case GC pause and network jitter or healthy nodes flap
- **indirect-probe count / suspicion timeout** — in SWIM, how many other members are asked to probe a silent peer before it is convicted, and how long it stays merely suspect first; more indirect probes cut false positives from a single bad link at some extra traffic

### Signals to watch
<!--meta polarity=signal-->

- **convergence time** — how long a fresh update takes to reach the whole cluster; it should track O(log N) rounds, and a steady climb means fanout or interval no longer suits the current cluster size
- **per-node gossip bandwidth** — bytes per second of gossip traffic on each node; the steady cost of anti-entropy, which grows with membership size and message payload
- **membership flap rate** — how often nodes transition up and down in the membership view; repeated flapping on a node that is actually alive means the failure detector is firing false positives
- **membership view divergence** — disagreement between nodes about who is currently alive; a persistent gap means some nodes are not converging and are acting on stale membership

### Failure modes under load
<!--meta polarity=failure-->

- **false-positive death under load** — a busy or GC-paused node misses its probes and is declared dead by peers, then reappears and flaps; downstream routing and rebalancing thrash on membership that never actually changed
- **straggler lag at scale** — convergence is probabilistic, so a worst-case node can trail the rest by several rounds and keep acting on stale state long after everyone else has the update
- **gossip storm** — fanout set too high or the interval too short, or membership payloads grown too large, saturates the network with reconciliation traffic even when nothing has changed
- **partition splits membership** — a network partition lets each side converge to its own consistent view; when it heals the two views must be merged, and any conflicting state needs a reconciliation rule of its own

### Readiness checklist
<!--meta polarity=check-->

- Tune fanout and interval to the cluster size — convergence is O(log N) rounds, so resist over-gossiping
- Set failure-detection timeouts above the worst-case GC pause and network jitter, or healthy nodes will flap dead and back
- Bound gossip message size and prefer incremental deltas over full-state exchange as membership grows
- Monitor convergence time and flap rate, and alert on a node that repeatedly transitions up and down
- Define a reconciliation rule for conflicting state, since gossip merges views but orders nothing

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [CAP Theorem](../../../themes/cap-theorem.md) — availability-first (AP)-style membership that converges eventually {#fluency-cap-theorem}
- [Consistency & Replication](../../../themes/consistency-and-replication.md) — Converge membership and state over time {#fluency-consistency-and-replication}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Leader Election](./leader-election.md) — Membership spreads by gossip; a leader is chosen
- [Consistent Hashing](../routing/consistent-hashing.md) — Gossip membership feeds the hash ring
- [Replication](./replication.md) — Anti-entropy rounds reconcile divergent copies between peers over time
- [CRDT](./crdt.md) — Gossip can carry conflict-free replicated data type (CRDT) state because the merge absorbs repeats and any order.
- [Merkle Tree](./merkle-tree.md) — Dissemination is probabilistic, so a tree-based repair catches what it missed.
- [Heartbeat](./heartbeat.md) — Gossip carries heartbeat counters and suspicions, so no node watches all the others.

**Alternative to**

- [Quorum & Consensus](./quorum-consensus.md) — Gossip converges eventually; quorum agrees on one value now

<!-- relationships:end -->
