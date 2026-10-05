---
title: Failover
description: "Promote a standby to take over when the primary fails, then redirect clients, so service resumes in seconds with no one waking up to repair it."
area: distributed-coordination
owner: Oleksandr Derechei
tags: [resilience, availability]
status: stable
aliases: [automatic failover, standby promotion]
solves: [the database host died overnight and the service stayed down until someone promoted a replica by hand, "after the primary was replaced, apps kept connecting to the dead address for minutes", "two nodes accepted writes at once after we switched, and the data diverged", a switch to the backup lost the last few seconds of writes clients were told had succeeded, a short network glitch moved traffic to the standby when nothing was wrong]
---

# Failover

Keep a standby ready, and when the primary fails, promote the standby and point clients at it, so the service resumes in seconds and without waiting for a repair.

## What it is
<!--meta block=description-->

When a single database host dies, every request fails until a person finds a healthy copy, promotes it and repoints clients. Failover automates that handover: a monitor detects the failure, fences the old primary, promotes a standby and redirects clients. A wrong detection can leave two leaders, and an asynchronous standby loses the writes it had not yet received.

## Explained
<!--meta block=explain-->

Failover keeps a standby copy of a single-writer system, such as a database, current through [replication](replication.md), and promotes it to take over when the primary fails. A monitor sends [heartbeat](heartbeat.md) probes, and when several in a row fail it declares the primary dead, cuts off the old primary so it cannot keep writing, promotes the standby, and points clients at it. The repaired old primary later rejoins as the standby. Choose it over restoring from backup when you cannot wait for a person or a rebuild, and over plain extra copies when the state has one writer.

- **Wrong detection.** A slow primary looks dead and two nodes write. Fence the old primary first and let a majority of monitors decide.
- **Replication lag.** An asynchronous standby is behind and loses recent writes. Use synchronous copies for data you cannot lose.
- **False alarms.** A timeout shorter than your worst pause triggers needless switches. Set it above that pause.
- **Untested standby.** It fails when needed. Rehearse the switch and size the standby for the full load.

**Example.** A database primary stops answering at 03:00:00. The monitor probes every 1 s and declares failure after 3 misses, at 03:00:03. It fences the old primary, then promotes the standby, which takes 4 s to replay its log and accept writes. It repoints the router at 03:00:08, and clients reconnect, so about 8 s of downtime replaced a page and a manual switch of perhaps 30 min. The standby was 2 s behind, so the writes from the last 2 s before the failure are gone, and the team knows that figure because it measured the lag.

## How it works
<!--meta block=structure-->

```mermaid caption="How do clients end up talking to a new primary? The primary streams changes to the standby at 1, a monitor sees the probes fail at 2, fences the old primary at 3, promotes the standby at 4 and repoints the router at 5, and clients follow at 6 and 7."
flowchart LR
    Cl["Clients"]
    R["Router"]
    P["Primary"]
    S["Standby"]
    M["Monitor"]
    P -->|"1 stream changes"| S
    M -->|"2 probe, no reply"| P
    M -->|"3 fence the old primary"| P
    M -->|"4 promote"| S
    M -->|"5 repoint"| R
    Cl -->|"6 requests"| R
    R -->|"7 forward to the new primary"| S
```

```mermaid caption="In what order must the steps run, and what if the old primary comes back? The monitor waits for three missed probes, fences before it promotes, and moves clients last. An old primary that only lost the network is refused by the fence and rejoins as a standby."
sequenceDiagram
    autonumber
    participant M as Monitor
    participant P as Old primary
    participant S as Standby
    participant R as Router
    M->>P: probe
    P--xM: no reply, three times in a row
    M->>P: fence, cut off writes
    M->>S: promote
    S-->>M: ready, now primary
    M->>R: repoint to the standby
    Note over P: network returns, still thinks it leads
    P->>S: write
    S--xP: refused by the fence
    M->>P: resync it as a standby
```

The order is the safety. Declare failure only after several missed probes, since one lost probe is not a death. Fence the old primary before the promotion, so at no moment can two nodes accept writes. Check how far behind the standby is and decide whether to promote or wait. Promote it, wait until it accepts writes, and only then repoint clients, or they connect to a node that is not ready.

The old primary must not come back as primary. Resync it from the new primary as a standby, because its log may hold writes the new primary never saw.

## Variations
<!--meta block=variations-->

- **Active-passive** — One node serves and a standby waits. A cold standby starts only on failure and recovers in minutes, a warm one runs and lags a little, and a hot one replicates continuously and recovers in seconds. The faster the recovery, the more you pay for idle capacity.
- **Active-active** — Every node serves traffic, and failover is removing the dead node from rotation so the rest absorb its share. It recovers fastest, but the survivors need headroom for the lost load, and writes to the same data on two nodes need a conflict rule or a partitioned owner for each key.
- **Consensus-driven promotion** — The replicas themselves pick the new primary by vote through [Leader Election](./leader-election.md) on [Quorum & Consensus](./quorum-consensus.md), so no separate monitor can be wrong and a minority side cannot promote itself.
- **Manual or confirmed failover** — The monitor raises the alarm and a person approves the promotion. It is slower by minutes, and it avoids a switch that a short network glitch would otherwise trigger.
- **Cross-region failover** — The standby is in another region and clients move by DNS or a global load balancer. Replication lag is larger, so you lose more writes, and DNS caches delay clients by the record's TTL (time to live).

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Outage shrinks from hours to seconds with a hot standby** — no person has to wake, decide and repoint, so recovery time is detection, fencing, promotion and client redirect, up to the DNS TTL if clients use DNS.
- **One machine failure stops being an incident** — a dead host or a lost zone costs a switch, which an alert can report without a page.
- **Planned maintenance needs no maintenance window** — you fail over on purpose, with a brief switch outage and no lag loss if you wait for the standby to catch up, patch the old primary and fail back, which also proves the path works.
- **A single-writer store gains availability** — databases and brokers that cannot run as many equal copies can still survive a node loss.

### Cons
<!--meta polarity=con-->

- **Split-brain if detection is wrong** — a slow primary looks dead and two nodes accept writes, so fence the old primary before the promotion and use a majority to decide.
- **Acknowledged writes can be lost** — with asynchronous replication the standby lags, so a failover drops the lag window; use synchronous or semi-synchronous copies for data you cannot lose, at the price of commit latency and blocked writes while the standby is unreachable.
- **Short timeouts cause needless switches** — a network glitch or a long pause triggers a failover that costs more than the blip, so set the timeout above your worst pause and add a hold-down between failovers.
- **An untested failover fails when needed** — the standby has stale config, a cold cache or too little capacity, so rehearse the switch on a schedule and size the standby for the full load.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **One machine or zone must not take the service down** — your recovery target is minutes or seconds, not the time a person needs.
- **The state has a single writer** — a database, a broker or a cache primary cannot simply be run as many equal copies.
- **You patch or move live systems** — a switch you can perform on purpose lets you upgrade without a maintenance window.

### Avoid when
<!--meta polarity=avoid-->

- **The service is stateless** — run several copies behind a [Load Balancer](../routing/load-balancer.md), and a failed copy needs no promotion.
- **You cannot fence the old primary** — an automatic switch risks two writers, so keep the promotion manual or use [Quorum & Consensus](./quorum-consensus.md), where a majority decides.
- **An outage of minutes is acceptable and rebuilds are cheap** — restore from backup, and skip the standby, monitor and fencing you would otherwise run and test.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a monitor that waits for repeated misses, then fences, promotes and repoints in order"
// Helpers assumed: sleep(ms), alert(msg), MAX_LAG_BYTES.
// One monitor is shown for brevity; run several and require a majority to agree.
async function watch(primary: Node, standby: Node, router: Router, missesAllowed = 3) {
  let misses = 0;
  while (misses < missesAllowed) {
    const start = Date.now();
    // One lost probe is not a death: count consecutive misses.
    misses = (await primary.ping(1000)) ? 0 : misses + 1;
    await sleep(Math.max(0, 1000 - (Date.now() - start))); // keep a 1 s interval
  }

  // If fence() throws or cannot confirm, abort and page a person: never promote unfenced.
  await primary.fence(); // cut it off BEFORE promoting, or two nodes may write

  // Automatic mode refuses a lagging standby; alert-and-promote is a deliberate choice.
  if (standby.lagBytes() > MAX_LAG_BYTES) {
    alert("standby too far behind: promotion refused, a person decides");
    return;
  }
  await standby.promote();       // wait until it accepts writes
  await router.pointTo(standby); // clients move last
}
```

## In the wild
<!--meta block=wild-->

- **Patroni** — A template for PostgreSQL high availability that keeps a leader key in a distributed store such as etcd, ZooKeeper or Consul, and promotes a replica automatically when the leader's key expires. {#wild-patroni}
- **Redis Sentinel** — Sentinel processes monitor a Redis primary, agree by quorum that it is down, elect one Sentinel to lead the failover, promote a replica and tell clients the new address. {#wild-sentinel}
- **MongoDB replica sets** — The members of a replica set hold an election when the primary is unreachable, and a replica that wins a majority becomes primary, with no outside monitor. {#wild-mongodb}
- **Amazon Relational Database Service (RDS) Multi-AZ** — A standby in another availability zone is kept in step with the primary, and when the primary fails RDS promotes the standby and moves the database's DNS name to it. {#wild-rds}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **failure detection timeout** — how many missed probes, over what interval, before the monitor declares the primary dead; it sets the outage length and must sit above your worst pause; start at 3 missed probes at 1 s, then raise it above the longest stall your latency data shows
- **hold-down period** — the minimum time between failovers, so a flapping primary cannot trigger a chain of switches
- **maximum acceptable lag** — how far behind the standby may be before automatic promotion is refused or an alert is raised, which is the most data you agree to lose; refusing promotion keeps the data and extends the outage until a person decides
- **replication mode** — synchronous, semi-synchronous or asynchronous copying, which sets how many acknowledged writes a failover can lose
- **client redirect method and TTL** — how clients find the new primary, such as DNS with a short record TTL, a virtual address, a proxy or service discovery, which sets how long clients keep the old address

### Signals to watch
<!--meta polarity=signal-->

- **replication lag at failure** — how far behind the standby was, which equals the data lost
- **time to recover** — seconds from the first missed probe to traffic served by the new primary, measured on each failover and each drill
- **failover count** — switches per week; a rise points to flapping or an unhealthy primary
- **standby health** — the standby's own replication state and free capacity, checked as closely as the primary's

### Failure modes under load
<!--meta polarity=failure-->

- **split brain** — the old primary was cut off but alive, a second node was promoted, and both accepted writes until fencing stopped one
- **lagging promotion** — the standby was behind and the acknowledged writes in the gap are gone
- **flapping** — a timeout below the worst pause or a noisy network triggers repeated switches, each with its own outage
- **stale clients** — clients keep the old address in a DNS cache or a connection pool and fail until it expires
- **overloaded survivor** — the new primary has a cold cache or less capacity and fails under the full load

### Readiness checklist
<!--meta polarity=check-->

- Fence the old primary before the promotion, and test that the fence works
- Rehearse a failover on a schedule and measure the recovery time and the data lost
- Make clients reconnect with retry and short DNS or connection-pool lifetimes
- Monitor the standby as closely as the primary, including lag
- Size the standby for the full load and have a runbook to resync the old primary as a standby

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Consistency & Replication](../../../themes/consistency-and-replication.md) — What replication is for when a node fails: detect, fence, promote, redirect, with the lag window as the data you can lose. {#fluency-consistency-and-replication}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Leader Election](./leader-election.md) — Consensus-driven promotion lets the replicas pick the new primary themselves.
- [Heartbeat](./heartbeat.md) — Missed heartbeats are the usual trigger that declares the primary dead.
- [Fencing Token](./fencing-token.md) — A token checked at storage refuses writes from the old primary after promotion.
- [Health Endpoint Monitoring](../resilience/health-endpoint.md) — Health probes feed the monitor that decides the primary has failed.

**Alternative to**

- [Quorum & Consensus](./quorum-consensus.md) — When the old primary cannot be fenced, let a majority decide the leader instead of promoting one standby automatically.

**Requires**

- [Replication](./replication.md) — A standby can take over only if replication kept a copy of the primary's state.

**Often confused with**

- [Fallback](../resilience/fallback.md) — Failover moves the whole system to a standby, where a fallback degrades one call.

**Prevents**

- [Split-Brain](../../../hazards/split-brain.md) — Fencing the old primary before promotion keeps two nodes from accepting writes.

**Exposed to**

- [Metastable Failure](../../../hazards/metastable-failure.md) — Can fall into metastable failure when the standby meets the full load cold, and the next failover re-triggers the failure

**Implemented by**

- [Regions & Availability](../../../capabilities/regions.md) — Managed databases ship the monitor, the promotion and the endpoint repoint as one setting.

<!-- relationships:end -->
