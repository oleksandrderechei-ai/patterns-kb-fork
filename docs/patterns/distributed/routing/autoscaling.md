---
title: Autoscaling
description: Adds or removes instances automatically as load changes
area: distributed-scale
owner: Oleksandr Derechei
tags: [scalability, availability, resource-management]
status: stable
aliases: [auto-scaling]
solves: [we pay for peak capacity around the clock and actually need it two hours a day, a marketing email went out and the site fell over before anyone could add servers, someone gets paged at 3am just to add more machines by hand, the fleet sits idle all night and drowns at lunchtime, we picked a fixed server count from a forecast and real traffic never matches it]
---

# Autoscaling

Watches load in real time, adding instances as demand climbs and removing them as it eases, so the fleet's size always tracks actual traffic instead of a guess made for peak.

## What it is
<!--meta block=description-->

**Autoscaling** watches a signal such as CPU use, requests a second or queue depth, and adds or removes instances to keep it near a target, so capacity follows demand instead of a size fixed in advance.

## Explained
<!--meta block=explain-->

Autoscaling watches a signal such as CPU use, requests a second or queue length, and adds or removes instances automatically to keep it near a target. Without it, you pick a fixed fleet size. Size for the average and a spike overwhelms you, and size for the peak and you pay for idle machines all day. It is a loop: measure, compare to the target, resize, wait, measure again. Choose it over a fixed fleet when load really varies, and over a person watching a dashboard when spikes come faster than a page can be answered. The loop works only if instances are [stateless](./stateless-service.md), boot quickly and can be drained safely, which means finishing their requests in progress before they stop.

- **Lag.** New instances take time to boot, so scaling trails the spike. Set the target below your limit and let a queue absorb the gap.
- **Dropped requests.** Removing an instance can cut requests in progress, so drain it first.
- **Flapping.** Bad thresholds or a short cooldown add and remove instances every few minutes, so set the cooldown longer than a boot.
- **State.** Stateful parts cannot be added freely, so keep state outside the instances.

**Example.** A fleet of 10 instances runs at 60% CPU, which is its target. Traffic rises 50%, so CPU reaches 90%, and the loop asks for 15 instances. New ones take 3 minutes to boot, so for 3 minutes the fleet runs at 90%, slow but alive. Had the target been 90%, the same rise would ask 135% of what 10 instances can serve, so requests would queue and fail for those 3 minutes. The cost of the 60% target is money: after the rise the load fits on 10 instances at 90% but needs 15 at 60%, so the headroom costs 5 more.

## How it works
<!--meta block=structure-->

```mermaid caption="How does the fleet resize itself with nobody touching it? The policy reads the fleet's own metric against a target and launches an instance, which takes traffic only once it has booted and passed its health check."
flowchart LR
    U["Clients"]:::ext
    LB["Load balancer"]
    subgraph Grp["One scaling group — min ≤ count ≤ max"]
        I1["Instance 1"]
        I2["Instance 2, launched"]
    end
    Met[("Metric store")]
    Pol["Scaling policy"]
    U -->|"1 requests"| LB
    LB -->|"2 spread load over the fleet"| I1
    I1 -->|"3 emit CPU, RPS, queue depth"| Met
    Pol -->|"4 read metric, compare to target"| Met
    Pol -->|"5 launch an instance, then cool down"| I2
    I2 -->|"6 pass health check, take traffic"| LB
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="A control loop: measure load, compare it to a target, resize the fleet, then pause before deciding again."
flowchart TB
    M["Measure: CPU, RPS, queue depth"] -->|"current load"| P["Compare to target"]
    P -->|"above target"| O["Scale out: add instances"]
    P -->|"below target"| I["Scale in: remove instances"]
    O -->|"fleet resized"| C["Cooldown"]
    I -->|"fleet resized"| C
    C -->|"window elapsed"| M
```

## Variations
<!--meta block=variations-->

- **Threshold (step) scaling** — Add or remove a fixed number of instances when a metric crosses a hard boundary, e.g. CPU above 70% for five minutes. Simple to reason about, but coarse and prone to oscillating right around the line.
- **Target tracking** — Continuously compute how many instances would hold a metric at a chosen target, like a thermostat, instead of firing discrete steps. Smoother than steps, and it corrects itself as load moves.
- **Scheduled scaling** — Raise and lower the group's bounds at clock times you choose, against a daily or seasonal curve you already know. The capacity is up before the traffic is, which covers the lag between demand rising and new instances coming online. An off-schedule spike still meets the full lag.
- **Predictive scaling** — Forecast the coming interval from past traffic and size the fleet to the forecast rather than to the current metric. It earns its keep where a spike arrives faster than an instance can boot, and it is only as good as the resemblance between the next day and the last ones.
- **Custom-metric scaling** — Scale on an application signal — queue depth, requests-per-instance, tail latency — instead of CPU, for workloads where CPU doesn't reflect the real bottleneck.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Capacity tracks real demand**, so you're not paying for a peak-sized fleet around the clock.
- **Absorbs spikes** that headroom or a queue can carry through the boot lag, without an engineer paging in to resize by hand.
- **Replaces lost** or unhealthy instances as a side effect of maintaining the target count.
- **Turns fleet size into a metric-driven**, tunable, observable knob instead of a one-off decision.

### Cons
<!--meta polarity=con-->

- **New instances take real time to boot**, warm caches, and pass health checks — scaling reacts on a lag, not instantly.
- **Scale-in is riskier than scale-out**: draining connections and in-flight work badly can drop requests.
- **Bad thresholds or a too-short cooldown cause flapping** — scaling out and back in every few minutes.
- **Stateful components don't autoscale cleanly**; only instances that can be added or dropped freely qualify.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Load genuinely varies** — daily cycles, bursty campaigns, unpredictable growth — not a flat, known number.
- **The component is stateless**, or externalizes its state, so instances are interchangeable and disposable.
- **Provisioning for peak wastes real** budget most of the time, or provisioning for average risks falling over.

### Avoid when
<!--meta polarity=avoid-->

- **Traffic is flat** and predictable enough that a fixed, sized fleet is simpler to run and reason about.
- **The component holds state** that can't be trivially rebalanced as the instance count changes.
- **Boot time** is so long the metric-to-capacity lag is too wide to help — pair it with [Backpressure](../../concurrency/backpressure.md) or [Queue-Based Load Leveling](../resilience/load-leveling.md) to absorb the gap instead.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal target-tracking loop"
interface Metrics { averageCpuPercent: number; instanceCount: number; }
interface InstancePool { scaleOut(n: number): Promise<void>; scaleIn(n: number): Promise<void>; }

function desiredInstances(m: Metrics, targetCpu = 60, min = 2, max = 20): number {
  // How many instances would hold CPU at the target, given current load.
  const desired = Math.ceil((m.averageCpuPercent * m.instanceCount) / targetCpu);
  return Math.min(max, Math.max(min, desired));
}

class Autoscaler {
  private lastScaledAt = 0;
  constructor(private readonly cooldownMs = 5 * 60_000) {}
  // Simplified: one cooldown for both directions, no drain before scaleIn, no step cap (see production-knob-3, -4).

  async tick(pool: InstancePool, metrics: Metrics): Promise<void> {
    if (Date.now() - this.lastScaledAt < this.cooldownMs) return; // still cooling down
    const target = desiredInstances(metrics);
    if (target === metrics.instanceCount) return;
    if (target > metrics.instanceCount) {
      await pool.scaleOut(target - metrics.instanceCount);
    } else {
      await pool.scaleIn(metrics.instanceCount - target);
    }
    this.lastScaledAt = Date.now();
  }
}
```

## In the wild
<!--meta block=wild-->

- **AWS Auto Scaling groups** — Holds a fleet between a min, max, and desired count across availability zones; target-tracking, step, and scheduled policies resize it, and instances are launched from a launch template with health-check-driven replacement. {#wild-aws-asg}
- **Kubernetes Horizontal Pod Autoscaler** — A control loop that adjusts a deployment's replica count to hold an average metric — CPU, memory, or custom and external metrics via the metrics API — at a target, with a configurable stabilization window to damp scale-down flapping. {#wild-k8s-hpa}
- **KEDA** — Extends Kubernetes autoscaling with scalers for event sources — queue length, stream lag, database queries — that drive the HPA, and can scale a workload down to zero replicas when there is no work. {#wild-keda}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Min and max instance count** — The floor that protects baseline availability and the ceiling that caps cost and protects downstream dependencies.
- **Target metric value** — The setpoint the loop holds — target CPU utilization, requests per instance, or queue depth per instance.
- **Cooldown and stabilization window** — How long to wait after a scaling action before acting again, often separate for scale-out and scale-in, to damp flapping. Set the scale-out cooldown at least the measured scale-out lag (production-signal-3), and keep scale-in longer, since scale-in is the riskier direction.
- **Scale-in and scale-out rate** — How many instances a single decision may add or remove, bounding how fast the fleet swings.
- **Metric evaluation period** — The window over which the signal is averaged before it is compared to the target.

### Signals to watch
<!--meta polarity=signal-->

- **Scaled metric versus target** — CPU %, requests per instance, or queue depth measured against the setpoint the loop is holding.
- **Instance count over time** — Repeated up-and-down swings in the count reveal flapping.
- **Scale-out lag** — Time from a metric breach to new instances passing health checks and taking traffic.
- **Unfulfilled capacity** — Launch failures or pending, unschedulable instances when the pool cannot grow.

### Failure modes under load
<!--meta polarity=failure-->

- **Flapping** — Cooldown too short or thresholds too tight, so the fleet scales out and back in every few minutes, thrashing caches and connections.
- **Scale-out lag** — Instances boot too slowly to catch a spike, so the metric stays breached and requests queue or drop while capacity is still coming online.
- **Botched scale-in** — Terminating instances without draining connections or in-flight work drops requests.
- **Ceiling or capacity limit hit** — The max is reached, or the provider has no spare capacity, so excess load queues or fails unless shedding or backpressure is in place. Alert when the count sits at max.

### Readiness checklist
<!--meta polarity=check-->

- Min and max bounds set deliberately — min for baseline, max to protect budget and downstream capacity.
- The scaling metric actually correlates with the real bottleneck, not CPU when the bottleneck is I/O or queue depth.
- Graceful scale-in: connection draining and graceful shutdown honored before termination.
- Cooldown and stabilization tuned to instance boot time so the loop does not chase itself.
- Downstream dependencies — database connections, quotas — can absorb the fleet at its max size.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Cloud Native](../../../themes/cloud-native.md) — Capacity that follows demand instead of a plan {#fluency-cloud-native}
- [Handling Spikes](../../../themes/spike-handling.md) — Add capacity as the surge builds {#fluency-spike-handling}
- [Scalability](../../../themes/scalability.md) — Resize the fleet with demand {#fluency-scalability}
- [Gen AI at Scale](../../../themes/genai-scale.md) — Resize the graphics processing unit (GPU) fleet with demand {#fluency-genai-scale}
- [Workload Composition](../../../themes/workload-composition.md) — Each separated component follows its own signal {#fluency-workload-composition}
- [Scale Units & Stamps](../../../themes/scale-units-and-stamps.md) — Right-size each unit against its own regional demand {#fluency-scale-units-and-stamps}
- [Operating a Live System](../../../themes/operating-a-live-system.md) — The routine change nobody should be making by hand {#fluency-operating-a-live-system}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Queue-Based Load Leveling](../resilience/load-leveling.md) — Level with a queue while capacity catches up
- [Load Balancer](./load-balancer.md) — Balance across the pool autoscaling resizes
- [Health Endpoint Monitoring](../resilience/health-endpoint.md) — Scale on health and load signals
- [Backpressure](../../concurrency/backpressure.md) — Push back while new capacity spins up
- [Load Shedding](../resilience/load-shedding.md) — Scaling out takes minutes; shedding is what keeps the service usable in the meantime
- [Design to Scale Out](../../../principles/scale-out.md) — Autoscaling is this decision made continuously instead of once
- [Container Orchestration](../coordination/container-orchestration.md) — The orchestrator is what actually adds and removes the instances a scaling policy asks for.
- [Compute Resource Consolidation](./compute-resource-consolidation.md) — Colocated tasks inherit one scaling decision, so group them by how they need to grow
- [Geode](./geode.md) — Applies per node, so a regional spike grows one footprint rather than the fleet

**Requires**

- [Stateless Service](./stateless-service.md) — Scaling out is safe only when the added replicas carry no session state

**Exposed to**

- [Cascading Failure](../../../hazards/cascading-failure.md) — Can fall into cascading failure when new cold instances join under full load and die before warming up

**Demonstrated by**

- [LeetCode](../../../designs/leetcode.md) — the execution fleet is sized elastically to demand rather than provisioned for peak
- [Job Scheduler](../../../designs/job-scheduler.md) — elastic capacity tracking the pending-job backlog is what holds the 2-second budget under load
- [YouTube](../../../designs/youtube.md) — Queue-depth scaling for a fleet whose central processing unit (CPU) signal is useless is the textbook case
- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — a queue-driven fleet whose work is remote calls: the scaling signal is queue age, and scale-in is safe because an abandoned claim is the expired-lock case the sweeper already handles
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — scaling on queue age, with scale-in safe because an abandoned claim is the expired-lease case the failure path already rehearses
- [Google News](../../../designs/google-news.md) — Autoscaling works here because the Feed Service holds no state

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Every cloud sells this: you supply the metric and the bounds, the platform adds and removes instances.
- [Application Platforms](../../../comparisons/application-platforms.md) — Managed platforms ship this as a setting rather than a control loop you write

<!-- relationships:end -->
