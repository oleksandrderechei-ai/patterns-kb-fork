---
title: Compute Resource Consolidation
description: Packs compatible tasks onto one unit so you stop paying for idle
area: distributed-scale
owner: Oleksandr Derechei
tags: [operations, resource-management, cloud]
status: stable
aliases: [bin packing, workload colocation]
solves: [we pay for thirty services that are idle most of the day, every small job got its own instance and the bill is bigger than the workload, our compute utilisation sits at eight percent and finance is asking why, we have more deployment units to patch than we have engineers]
---

# Compute Resource Consolidation

Groups tasks with compatible scaling, lifetime and resource profiles onto a single computational unit, so an expensive unit stays busy instead of a dozen cheap ones sitting idle and billing anyway.

## What it is
<!--meta block=description-->

Giving every task its own unit of compute is clean but wasteful: thirty units, mostly idle, each billing for reserved capacity. **Compute resource consolidation** groups several tasks on one unit so paid-for capacity gets used. Which tasks share is the whole pattern. You group by matching scale profile and pair by contrasting resource profile, and you give up isolation to do it.

## Explained
<!--meta block=explain-->

Compute resource consolidation puts several tasks on one unit of compute, such as one server, container or app instance, so the capacity you pay for gets used instead of idling. A unit costs the same at 8% busy as at 80%. The skill is knowing which tasks may share. Group tasks that scale up and down together, because a unit scales as a whole: a poller for rare messages beside a service that grows to 100 instances makes 100 pollers listening for nothing. Pair tasks that want different resources, because two compute-heavy or two memory-heavy tasks on one unit fight each other. Choose it over one unit per task when many sit mostly idle, and skip it for critical work, where a [bulkhead](../resilience/bulkhead.md)'s isolation is the requirement.

- **Shared fate.** Colocated tasks fail and restart together, so share only background work.
- **Shared security.** They share one security context, so a task with sensitive data keeps its own unit.
- **Contention.** Load peaks when every task is busy, so set a limit per task.
- **Stale grouping.** Decide from measured usage over time, not a diagram, and recheck it, since last quarter's heat map goes stale.

**Example.** A team runs 30 units that each cost 60 dollars a month and run about 8% busy, 1,800 dollars in all. Measured usage shows the tasks scale alike and peak at different hours, so they pack 5 to a unit. That makes 6 units at about 40% busy and 360 dollars a month, a saving of 1,440. The cost is shared fate. If one task crashes while starting, the other 4 on its unit stop too. If each task peaks at 40% and 3 peak together, the unit hits 120%, so they slow each other down.

## How it works
<!--meta block=structure-->

```mermaid caption="What changes when three tasks stop having three units? Step 1 is the part that cannot be skipped — the grouping is only correct if it comes from measured behaviour, and the poller stays separate because its scale profile disagrees, not because of what it does."
flowchart LR
    HM[("Utilisation heat map")]
    subgraph BEFORE["Before — one unit per task"]
        U1["Unit: bursty API"]
        U2["Unit: rare poller"]
        U3["Unit: report builder"]
    end
    subgraph AFTER["After — grouped by profile"]
        UX["Unit: bursty API + memory-heavy report builder"]
        UY["Unit: rare poller, scales on its own"]
    end
    BEFORE -->|"1 measure real CPU and memory over time"| HM
    HM -->|"2 group matching scale profiles"| AFTER
    HM -->|"3 pair contrasting resource profiles"| AFTER
```

```mermaid caption="The two shared-fate events worth designing for. A neighbour that cannot start takes the whole unit's startup with it, and a platform recycle stops every task at once — which is why long-running work in a consolidated unit needs checkpointing rather than an assumption of uptime."
sequenceDiagram
    autonumber
    participant P as Platform
    participant U as Consolidated unit
    participant A as Task A
    participant B as Task B
    P->>U: start unit
    U->>A: initialise
    U->>B: initialise
    alt task B fails to start
        B--xU: startup error
        U--xP: unit startup fails
        Note over U,A: task A never runs — a neighbour's bug took it down
    end
    P->>U: recycle the host environment
    U->>A: stop signal
    A->>A: checkpoint and resume after restart
```

## Variations
<!--meta block=variations-->

- **Shared hosting plan** — Several applications assigned to one block of server infrastructure, billed once. The lowest-friction form: nothing about the applications changes, and they simply stop each having their own reserved capacity.
- **Shared cluster with node pools** — Components colocate on the same nodes, with the nodes themselves grouped into pools by computational requirement — a CPU-optimised pool, a memory-optimised pool. This is the form that lets you apply the contrasting-profile rule mechanically, since the scheduler places by declared requirement.
- **Shared machine set across tenants** — One set of machines serves every tenant, so management cost is spread rather than multiplied. It buys the most and isolates the least, which makes [Noisy Neighbour](../../../hazards/noisy-neighbour.md) the standing risk and per-tenant quotas the standing mitigation.
- **Consumption-based compute** — Pay-per-execution platforms scale to zero and run many independent workloads on one shared pool, so the provider does the consolidation and you never see the packing decision. It is consolidation with none of the grouping work, and the reason it is often the right answer for idle-heavy tasks.
- **Consolidating the sidecars** — Where every service runs its own [Sidecar](./sidecar.md) for proxying, logging or configuration, the per-instance overhead multiplies across the fleet. Moving that function to one agent per node is the same trade in miniature: less duplicated overhead, one shared failure domain.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Utilisation rises directly**, and so does the return on capacity you are already reserving — the saving is the idle time you stop paying for.
- **The platform gets more homogeneous**, which cuts the tooling, dashboards and runbooks needed to operate it.
- **Colocated tasks communicate faster**, because calls between them no longer cross the network.
- **Fewer units means less to deploy**, patch and observe, which is often a bigger saving than the compute bill.

### Cons
<!--meta polarity=con-->

- **Fault isolation is what you spend**, and startup is the sharpest case: a task that fails to initialise can take the whole unit's startup with it and stop every neighbour from running.
- **The security context is shared**. Colocated tasks often share an identity and reach the same resources, so the unit is only as secure as its most vulnerable task, and the attack surface grows with each one added.
- **Release cadence couples**. Changing one task means stopping, redeploying and restarting the unit — and therefore every other task in it, which makes a frequently-changing task a poor tenant.
- **Platform recycling stops everything at once**, so long-running work needs checkpointing or protection from the recycle rather than an assumption that it will finish.
- **Contention appears exactly when you are busiest**, which is when the tasks all want the same resource at the same moment.
- **The unit's code gets harder to test**, debug and maintain, because several unrelated concerns now live in one process boundary.
- **It needs production evidence** to do correctly and ongoing monitoring to stay correct — a grouping made from last quarter's heat map quietly stops being the right one.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Tasks spend most of their time idle**, and each is paying for reserved capacity it does not use.
- **An expensive unit** — many cores, lots of memory — is provisioned for short bursts and sits unused between them.
- **You have production history and a heat map**, so the grouping can be argued from measured behaviour.
- **The tasks are background or supporting work**, where a shared failure domain is an acceptable price.

### Avoid when
<!--meta polarity=avoid-->

- **The tasks perform critical fault-tolerant work**. Isolation is the requirement, and [Bulkhead](../resilience/bulkhead.md) is the pattern that supplies it.
- **A task handles sensitive data** and needs its own security context, since colocation shares one.
- **The tasks have conflicting scale profiles**, where scaling for one wastes everything you saved on the other.
- **The system is new and unmeasured**. Consolidating from a diagram groups tasks by what they are named rather than by what they do.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the grouping rule, applied to measured profiles"
type Profile = {
  task: string
  scaleProfile: 'bursty' | 'steady' | 'rare'   // how it needs to grow
  bottleneck: 'cpu' | 'memory' | 'io'          // what it runs out of first
  meanUtilisation: number                      // measured, not estimated
}

const IDLE_THRESHOLD = 0.25

// Two tasks may share a unit only if they scale together and starve on
// different resources. Both halves are required — matching one alone is how
// consolidation turns into contention or into wasted scale-out.
function canShare(a: Profile, b: Profile): boolean {
  return a.scaleProfile === b.scaleProfile && a.bottleneck !== b.bottleneck
}

function groupIntoUnits(profiles: Profile[]): Profile[][] {
  // Only busy-enough-to-matter savings are worth the isolation you give up.
  const candidates = profiles.filter((p) => p.meanUtilisation < IDLE_THRESHOLD)

  return candidates.reduce<Profile[][]>((units, task) => {
    const home = units.find((unit) => unit.every((other) => canShare(other, task)))
    return home
      ? units.map((unit) => (unit === home ? [...unit, task] : unit))
      : [...units, [task]]
  }, [])
}

```

## In the wild
<!--meta block=wild-->

- **Kubernetes** — Requests and limits let the scheduler pack pods onto shared nodes by declared CPU and memory need, and node pools group machines by shape — which is how the contrasting-resource-profile rule gets applied by the scheduler rather than by hand. {#wild-k8s-node-pools}
- **Azure App Service plans** — Several applications assigned to one plan share the underlying compute and are billed once for it, which is the shared-hosting-plan form with no application change required. {#wild-app-service-plan}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Requests and limits per task** — What the scheduler packs against. Requests too low invites contention; too high recreates the idle capacity you were removing.
- **Tasks per unit** — The density dial, and the direct trade against blast radius.
- **Node pool shapes** — Grouping machines by CPU-heavy or memory-heavy profile is how the contrasting-profile rule gets enforced by the scheduler.
- **Checkpoint interval for long-running tasks** — A platform recycle stops everything in the unit, so this bounds how much work is lost.

### Signals to watch
<!--meta polarity=signal-->

- **Utilisation per unit, CPU and memory separately** — The heat map the grouping decision is made from — and re-made from, since the workload mix drifts.
- **Contention indicators: CPU throttling and memory pressure** — Rising throttling means two tasks that were meant to want different resources actually want the same one.
- **Unit restart count and cause** — Restarts attributable to one task are the shared-fate cost showing up as a number.
- **Cost per unit against work completed** — Confirms the consolidation actually saved money rather than moving it.

### Failure modes under load
<!--meta polarity=failure-->

- **One task fails to start and the unit does not come up** — Startup is the sharpest shared-fate case, because a neighbours initialisation bug stops tasks that were perfectly healthy.
- **Contention appears only at peak** — Tasks coexist happily at low load and fight for the same resource exactly when you are busiest.
- **Scale-out multiplies a task that did not need it** — Conflicting scale profiles in one unit mean scaling for the bursty task also replicates the idle one.
- **A neighbours deploy restarts everything** — Coupled release cadence turns one team routine change into a restart for every colocated task.

### Readiness checklist
<!--meta polarity=check-->

- The grouping came from measured production utilisation, not from an architecture diagram.
- Colocated tasks share a scale profile and differ in bottleneck resource.
- Nothing critical, fault-tolerant or handling sensitive data was colocated.
- Long-running tasks checkpoint, because the platform recycles the unit underneath them.
- Requests and limits are set per task so one cannot starve its neighbours.
- The grouping is recomputed on a schedule, since last quarter heat map stops describing this quarter workload.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Scale Units & Stamps](../../../themes/scale-units-and-stamps.md) — Pack compatible tasks onto one unit so you stop paying for idle capacity. {#fluency-scale-units-and-stamps}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Container Orchestration](../coordination/container-orchestration.md) — Node pools grouped by central processing unit (CPU) or memory requirement are how the packing rule gets applied mechanically
- [Autoscaling](./autoscaling.md) — A unit scales as a unit, which is why only matching scale profiles may share one

**Alternative to**

- [Bulkhead](../resilience/bulkhead.md) — The opposite trade: consolidation spends the isolation a bulkhead buys, for utilisation

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Managed Kubernetes bin-packs many workloads onto one pool of nodes.

<!-- relationships:end -->
