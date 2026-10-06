---
title: Geode
description: "Identical worldwide nodes, any of which can serve any request"
area: distributed-scale
owner: Oleksandr Derechei
tags: [replication, availability, latency]
status: stable
aliases: [geodes, geographical node]
solves: [users on the other side of the world wait half a second for every request, a whole region went down and took our service with it, traffic spikes in one region overwhelm the only place that can serve it, we pay full price for a standby region that sits idle doing nothing]
---

# Geode

Deploys the whole backend as a set of geographically spread nodes, each self-contained and each holding a full replica of the data, so any node can serve any client from any region — active-active by construction rather than by failover.

## What it is
<!--meta block=description-->

A geode deploys the whole backend into many geographically distributed nodes, each a complete replica, with a global edge tier that steers each request to the nearest healthy node. Any node can answer any request, so there is no home region and no failover step. It resolves distance latency, regional overload and the cost of a single-region failure. Unlike a deployment stamp, which owns a slice of users, every geode is equal.

## Explained
<!--meta block=explain-->

A geode deploys your whole backend as many identical nodes around the world, each with a full copy of the data, so any node can answer any request. A global edge tier sends each user to the nearest healthy node, and a replication service keeps the copies in step. There is no home region and no failover step. Without it, a user far from your one region pays hundreds of milliseconds on every request, a regional spike overwhelms the one place that can serve it, and losing that place is an outage. Choose it over a deployment stamp when every node can hold every record. A stamp owns a slice of users, so its router must know where each one lives, while a geode router only needs to know what is near and healthy.

- **Write conflicts.** Writes in two regions can conflict, so pick a conflict rule first and accept that reading your own write is no longer free.
- **Cross-region paths.** One request's path crosses regions and queues, so use distributed tracing from day one.
- **Equal nodes only.** Data-residency rules or session state pinned to one place break it, so use stamps with routing that knows where data lives.

**Example.** Your one region is in Virginia. A user in Sydney is about 200 ms away, so every request pays 200 ms. With nodes in Sydney, London and Virginia, each user reaches a node about 20 ms away. If Virginia is lost, its users move to London with no failover step, and London needs headroom for them. Two users edit the same record in Sydney and London 100 ms apart, while replication takes 250 ms, so both edits are accepted. A last-write-wins rule keeps one and drops the other. That is the cost of the conflict rule.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a request from anywhere get served from nearby? Every arrow at step 3 stays inside one node — the only thing crossing regions is replication, which is why a node keeps serving when every other node is gone."
flowchart LR
    C1["Client, region 1"]:::ext
    C2["Client, region 2"]:::ext
    GLB["Global edge router"]
    subgraph GA["Geode A"]
        AA["API and compute"]
        DA[("Full replica")]
    end
    subgraph GB["Geode B"]
        AB["API and compute"]
        DB[("Full replica")]
    end
    C1 -->|"1 request"| GLB
    C2 -->|"1 request"| GLB
    GLB -->|"2 nearest healthy node"| AA
    GLB -->|"2 nearest healthy node"| AB
    AA -->|"3 read and write locally"| DA
    AB -->|"3 read and write locally"| DB
    DA <-->|"4 replication backplane"| DB
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Availability is bought with consistency. The local write returns before it has reached the other nodes, so a user who moves between nodes inside the replication window can read their own write back stale — bound that window and design the reads that cannot tolerate it."
sequenceDiagram
    autonumber
    participant U as User
    participant E as Edge router
    participant A as Geode A
    participant B as Geode B
    U->>E: request
    E->>A: route to nearest healthy
    A->>A: write to local replica
    A-->>U: 200, before B has the write
    A->>B: replicate asynchronously
    alt geode A is lost
        E->>B: reroute, no failover step
        B-->>U: served — may lag by the replication window
    end
```

## Variations
<!--meta block=variations-->

- **Local aggregation versus central aggregation** — Either every node computes its own aggregates from its replica, or one node computes them and the result replicates outward. Local is faster and duplicates the work; central does the work once and makes one node's failure visible in every other node's numbers. A change feed with per-partition leases lets you pick per data set rather than for the whole system.
- **Mesh between nodes** — Nodes cooperate over the replication feed plus a real-time push channel, so a user connected to one node can be reached through another without either side knowing where the other user is. This is what makes messaging and presence workable on a topology with no home region.
- **Serverless nodes** — Consumption-billed compute makes an idle node cost little, which helps wide deployments. Storage, replication traffic and egress still grow with node count, so serverless cuts only the compute share.
- **Zonal, multi-zone or regional footprint** — Each node can occupy a single availability zone, several zones, or a whole region. Stacking local redundancy under the global pattern raises complexity and is worth it when a storage engine underneath can only replicate to a paired region, or when a regulator has an opinion about where a node sits.
- **Per-node [API Gateway](./api-gateway.md)** — An API-management layer in front of each node's compute is optional. It holds per-node rate limiting and authentication once the fleet is too large to manage by hand, and it must be configured identically on every node or the nodes stop being equal.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Resilience grows with every node added**. The system survives the loss of several regions at once, as long as the remaining nodes have headroom for the displaced traffic and replication still converges, because losing a node removes capacity rather than the ability to serve.
- **There is no failover to get wrong**. Every node is already live, so a regional outage is a routing decision rather than an incident with a runbook, provided the edge's health probes detect the failure. A node that answers probes but serves errors stays in rotation.
- **Latency drops for everyone**, not just for users near the home region — requests are served from a node close to them and never cross an ocean to reach state.
- **Regional demand spikes** spill over to other nodes, which works only if each has spare capacity. Spilled users pay extra distance, so size headroom per node.

### Cons
<!--meta polarity=con-->

- **Multi-region writes** mean the consistency model is now everyone's problem. Conflicting writes to two nodes need a resolution policy, and read-your-writes stops being free.
- **Cost scales** with node count and tier rather than with transactions, so the cheapest configuration is workload-specific — load test more nodes against bigger nodes instead of assuming.
- **Everything is implicitly decoupled**, which makes one request's path genuinely hard to follow across asynchronous work on instances in different regions. Distributed tracing is a prerequisite, not an improvement.
- **Every node is another ingress** point and another set of secrets. Each layer needs locking down so the only way in is the edge tier, and the surface grows linearly with the fleet.
- **It is cloud-native or nothing**. Retrofitting an existing platform onto equal, self-contained nodes is hard enough that the honest answer is usually no.
- **Unequal nodes invalidate the premise** — any constraint that makes nodes unequal does so, and data-residency rules are the most common one.
- **The edge tier and its health checks are the one global component**. A bad routing change there reaches every node at once, so stage routing changes and keep a last-known-good config.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The user base is genuinely global** and latency from a single region is a product problem rather than a metric.
- **The availability target is extreme** enough that surviving the loss of several regions at once is a requirement.
- **Every node can hold every record** — no residency rule, no per-session state, no region that must own a slice of the data.
- **The stack is cloud-native** and can be stamped out from one definition, so thirty nodes cost thirty deployments and not thirty maintenance burdens.

### Avoid when
<!--meta polarity=avoid-->

- **Data residency**, session affinity or a heavy single-region skew makes the nodes unequal. Use a [Deployment Stamp](./deployment-stamp.md) with a routing plane that knows where each user's data lives.
- **No geographic distribution is actually needed** — availability zones and a paired region are far cheaper for the same uptime.
- **The platform is legacy** and would have to be retrofitted, which this pattern does not survive.
- **Strong consistency on writes is non-negotiable**, since multi-region write acceptance is the thing being traded away.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the routing rule, and the read that cannot tolerate replication lag"
type Geode = { id: string; region: string; healthy: boolean; rttMs: number }

// Every node is equal, so routing needs no knowledge of where the data lives —
// only which node is healthy and near. That is the whole difference from a stamp.
function routeTo(nodes: Geode[]): Geode | null {
  const healthy = nodes.filter((n) => n.healthy)
  if (healthy.length === 0) return null
  return healthy.reduce((best, n) => (n.rttMs < best.rttMs ? n : best))
}

type Consistency = 'local' | 'session'

// The cost of active-active: a write acknowledged locally has not yet reached
// the other nodes. Reads that must see it carry a token and wait for it.
async function read(
  node: Geode,
  key: string,
  level: Consistency,
  lastWriteToken?: string,
): Promise<unknown> {
  if (level === 'session' && lastWriteToken) {
    // Block until this replica has caught up past the client's own write,
    // rather than serving a value older than what the client just sent.
    await waitForReplication(node, lastWriteToken)
  }
  return readLocalReplica(node, key)
}

```

## In the wild
<!--meta block=wild-->

- **Azure Cosmos DB multi-region writes** — The replication-backplane role: every configured region accepts writes and the service replicates between them, so each node reads and writes its local replica instead of reaching across the world for a primary. {#wild-cosmos-multiregion-write}
- **Amazon DynamoDB global tables** — A multi-region, multi-active table where an application in any region reads and writes its local replica and the service propagates changes to the others — the same equal-nodes premise, with last-writer-wins as the conflict rule. {#wild-dynamodb-global-tables}
- **Windows Active Directory** — An early variant of the shape: multi-primary replication means updates and queries can in principle be served from any serviceable node, though Flexible Single Master Operation roles mean the nodes are not fully equal. {#wild-active-directory}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Node count and placement** — More nodes buy resilience and proximity at a flat rate; the cheapest point between more nodes and bigger nodes is workload-specific and has to be load-tested.
- **Replication consistency level** — How much of the write must land elsewhere before it is acknowledged — the direct latency-versus-durability dial. The sketch's two levels are local acknowledgement and session (the read waits for the client's write token). Use session only for reads that cannot tolerate staleness, since each wait adds latency; measure the replication window to price it.
- **Edge routing and health-probe thresholds** — How fast a struggling node is taken out of rotation, and how much flapping you tolerate to get there. Start from measured p99 probe latency and node recovery time: set failures-to-eject just above normal jitter and require several clean probes to rejoin, so flapping stays bounded.
- **Conflict resolution policy** — Multi-region write acceptance means concurrent writes to one record need a decided rule rather than a discovered one.

### Signals to watch
<!--meta polarity=signal-->

- **Replication lag between nodes** — The width of the window in which a user moving between nodes can read their own write back stale.
- **Per-node request share and saturation** — Shows whether the edge is actually spreading load or quietly concentrating it on one node.
- **Cross-node conflict rate** — Rising conflicts mean the workload has more shared-record contention than the equal-nodes premise assumed.
- **Per-node cost against per-node traffic** — A node serving little and costing full price is the signal to consolidate the fleet.

### Failure modes under load
<!--meta polarity=failure-->

- **Read-your-writes breaks on reroute** — A user routed to a different node inside the replication window sees their own change missing.
- **A failing node is still in rotation** — A node that answers health probes but serves errors keeps taking traffic, and the pattern has no failover step to fall back on. Mitigation: probe a real read and write path and eject on error rate, not liveness alone.
- **One request is untraceable** — Work spread asynchronously across instances in several regions cannot be reconstructed without tracing already in place.
- **Conflicting writes silently resolved** — A last-writer-wins policy discards an update without an error, so the loss shows up as a support ticket rather than an alert.

### Readiness checklist
<!--meta polarity=check-->

- No data-residency rule, session affinity or regional skew makes the nodes unequal.
- The replication window is measured, and the reads that cannot tolerate it are identified and routed accordingly.
- Distributed tracing spans nodes before the second node ships.
- A node is defined by one deployment artifact, so adding one is a deployment and not a project.
- Every layer is closed except the edge, and each node has its own scoped secrets.
- Conflict resolution is a written decision, not the store default nobody chose.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Scale Units & Stamps](../../../themes/scale-units-and-stamps.md) — Deploy the whole backend to many regions so any node can answer any request. {#fluency-scale-units-and-stamps}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Load Balancer](./load-balancer.md) — A global edge tier steers each request to the nearest healthy node
- [Autoscaling](./autoscaling.md) — Each node scales out on its own inside the shared backplane's constraints

**Requires**

- [Replication](../coordination/replication.md) — Every node holds the whole dataset, so a multi-write replication backplane is the pattern's floor
- [Stateless Service](./stateless-service.md) — Any node must be able to take any request, which rules out state pinned to one of them
- [Distributed Tracing](../resilience/distributed-tracing.md) — One request runs asynchronously across instances in several regions, so tracing is a prerequisite rather than an improvement

**Often confused with**

- [Deployment Stamp](./deployment-stamp.md) — A stamp can stand alone and owns a slice of users; a geode never stands alone and every node is equal

**Implemented by**

- [Regions & Availability](../../../capabilities/regions.md) — A global anycast entry point steers each request to the nearest healthy deployment.

<!-- relationships:end -->
