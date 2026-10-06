---
title: Rolling Deployment
description: Replace instances a few at a time so the service never goes down
area: distributed-routing
owner: Oleksandr Derechei
tags: [operations, availability]
status: stable
aliases: [rolling update, rolling upgrade]
solves: [deploying a new version means taking the whole service down for a few minutes, I cannot afford a second full copy of the fleet just to upgrade, a bad release replaced every server before anyone noticed it was broken, new servers get traffic before they have finished starting and users see errors]
---

# Rolling Deployment

A rolling deployment upgrades a service in place by replacing its instances in small batches, so most of the fleet keeps serving while the new version takes over one batch at a time.

## What it is
<!--meta block=description-->

Stopping every instance means downtime, and starting a second full copy means paying for double capacity. A rolling deployment replaces instances in small batches: it starts a few new ones, waits until they report ready, then retires the same number of old ones, and repeats until none are left. With the unavailable limit at 0, the fleet stays at target size. A bad version that fails its readiness check reaches only the batch in flight before the roll halts.

## Explained
<!--meta block=explain-->

A rolling deployment upgrades a fleet in place. It starts a few instances of the new version, waits until each one reports that it is ready, then drains and stops the same number of old ones, and repeats until none remain. Two limits set the pace: how many extra instances may exist (surge) and how many may be missing (unavailable). Choose it over a [blue-green deployment](./blue-green-deployment.md) when you cannot pay for a full second fleet and can live with two versions serving at once. Choose a blue-green deployment instead when you need a switch back that takes seconds. Without the readiness gate, a broken build replaces the whole fleet one batch at a time.

- **Two versions at once.** Requests and data cross versions mid-roll; keep changes backward compatible and expand the schema before you contract it.
- **Slow rollback.** Undoing a bad version takes as long as the part already rolled; keep the old image and halt on the first failed check.
- **Weak readiness checks.** A check that passes early sends users to cold instances; make it call a real dependency.

**Example.** A service runs 10 instances. You set surge to 2 and unavailable to 0, so the fleet never drops below 10 serving instances and peaks at 12. Each batch takes about 40 s to become ready, plus a 30 s soak, so five batches take about 6 minutes. On batch 3 the new version fails its readiness check. The controller halts with 4 new and 6 old instances serving, and users saw no errors from the failed batch, which never passed readiness. The cost is that going back means rolling those 4 again, about 2.5 minutes.

## How it works
<!--meta block=structure-->

```mermaid caption="How does the fleet change version without a gap? Steps 2 to 4 repeat per batch: a new instance must pass its readiness check before the router sends it traffic, and only then is an old one drained and removed."
flowchart LR
    Cl["Clients"]:::ext
    LB["Load balancer"]
    subgraph Fleet["Fleet, size never below the floor"]
        Old[("Old instances v1")]
        New[("New instances v2")]
    end
    Ctl["Deployment controller"]
    Cl -->|"1 requests"| LB
    Ctl -->|"2 start a batch of v2"| New
    New -->|"3 pass the readiness check"| LB
    Ctl -->|"4 drain and stop a batch of v1"| Old
    LB -->|"5 spread across both versions"| Old
    LB --> New
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What stops a bad version from spreading? The readiness check. If the new instance never becomes ready, the controller stops starting batches, and the old instances are still serving."
sequenceDiagram
    autonumber
    participant C as Controller
    participant F as Fleet
    participant R as Router
    C->>F: start 1 v2 instance (surge)
    F-->>C: v2 ready
    C->>R: add v2 to rotation
    C->>F: drain 1 v1 instance
    F-->>C: v1 gone
    Note over C,F: repeat until all instances are v2
    C->>F: start next v2 instance
    F--xC: never becomes ready
    Note over C: halt, old instances keep serving
```

Two numbers set the pace. The **surge** is how many extra instances may exist above the target size, and the **unavailable** limit is how many may be missing from it. With a surge of 1 and none unavailable, capacity never dips, and the roll costs one spare instance. With none surging and 1 unavailable, the roll costs no spare but capacity dips by one.

The readiness check is what makes the roll safe. An instance that has started is not yet ready, and sending it traffic early turns every deploy into an error spike. Both versions serve at once for the whole roll, so they must tolerate each other's requests and the shared data.

## Variations
<!--meta block=variations-->

- **Surge first** — Start new instances before stopping old ones, so capacity never drops. It needs headroom for the extra instances, and it is the safer default when load is steady.
- **Unavailable first** — Stop old instances before starting new ones, so no spare capacity is needed. It suits fixed-size or licence-limited fleets, and you accept a temporary dip in capacity.
- **Batch size by percentage** — Replace a fixed share of the fleet per step, such as 10 percent. A bigger batch finishes sooner, and a bad version reaches more instances before the roll halts.
- **Paused roll with a soak** — Hold after each batch for a set time and watch the error rate before continuing. It catches faults that need minutes to show, at the price of a longer deploy.
- **[Canary release](./canary-release.md) as a roll** — Pause after the first batch and judge it by comparing metrics with the old version, then continue. This adds a deliberate decision to the roll instead of leaving it automatic.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No downtime and no second fleet** — capacity stays near the target, so you pay for one spare batch, not a full copy.
- **Bad versions stop early** — a failing readiness check halts the roll at the first batch that fails, so most instances stay on the old version.
- **Needs only the platform** — an orchestrator or load balancer with health checks does it, with no routing layer of your own.
- **Resource-light for large fleets** — the cost of the spare is a small share of a large fleet, where a full second copy is not.

### Cons
<!--meta polarity=con-->

- **Two versions serve at once** — requests, messages and rows cross versions mid-roll. Keep changes backward compatible and split schema changes into expand then contract.
- **Rollback is another roll** — undoing a bad version takes as long as the part of the roll already done. Keep the previous image and, where speed matters, prefer a [blue-green deployment](./blue-green-deployment.md).
- **Readiness checks are easy to get wrong** — a check that passes before the instance can serve sends users to a cold instance. Make it exercise a real dependency.
- **Readiness proves a start, not correctness** — a logic bug passes the gate and spreads batch by batch. Pair the roll with a soak and an error-rate halt.
- **Slow roll on large fleets** — batches times soak time can reach hours: at 70 s per batch, 200 instances at 2 per batch take about 2 hours. Raise the batch size once the first batch proves healthy.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Interchangeable instances** — any instance can serve any request, so you can swap them one at a time.
- **Compatible neighbouring versions** — the new version can run next to the old one on the same data for the length of the roll.
- **No budget for a second fleet** — you can afford a few spare instances but not double the capacity.

### Avoid when
<!--meta polarity=avoid-->

- **A breaking change in the data or protocol** — old and new cannot coexist, so switch all at once or version the interface first.
- **You need an instant way back** — a bad version must be off in seconds, which a roll cannot do.
- **Instances hold state or long connections** — draining waits on them for a long time, and cutting them early would drop users.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — one roll loop: surge a batch, wait for ready, drain the old, halt on failure"
interface Fleet {
  start(version: string, n: number): Promise<string[]>;   // returns new instance ids
  isReady(id: string): Promise<boolean>;
  drainAndStop(ids: string[]): Promise<void>;
  oldIds(): string[];
}

async function roll(f: Fleet, next: string, surge = 1, readyTimeoutMs = 60_000) {
  while (f.oldIds().length > 0) {
    const batch = await f.start(next, surge);              // surge above target size
    const deadline = Date.now() + readyTimeoutMs;
    for (const id of batch) {
      while (!(await f.isReady(id))) {
        if (Date.now() > deadline) {                       // never ready: stop here
          await f.drainAndStop(batch);
          throw new Error(`roll halted: ${id} not ready`); // old instances still serve
        }
        await new Promise(r => setTimeout(r, 1_000));
      }
    }
    await f.drainAndStop(f.oldIds().slice(0, surge));      // retire as many as we added
  }
}
```

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Surge** — How many instances may run above the target size; Kubernetes calls it `maxSurge`. More speed, more spare capacity paid.
- **Unavailable limit** — How many instances may be missing during the roll; Kubernetes calls it `maxUnavailable`. Set it to 0 to keep full capacity.
- **Readiness check** — The probe an instance must pass before it takes traffic; Kubernetes uses `readinessProbe`. Make it exercise real dependencies.
- **Minimum ready time** — How long a new instance must stay ready before the roll counts it; Kubernetes calls it `minReadySeconds`.
- **Progress deadline** — How long the roll may stall before it is marked failed; Kubernetes calls it `progressDeadlineSeconds`. It only flags the failure; rollback is still yours.
- **Drain grace period** — How long a stopping instance may finish in-flight requests; Kubernetes calls it `terminationGracePeriodSeconds`. Set it above your longest normal request.

### Signals to watch
<!--meta polarity=signal-->

- **Error rate and latency by version** — Split by version, to compare new against old mid-roll.
- **Ready instances against target** — The count of ready instances next to the target size shows whether capacity dipped.
- **Time to ready** — How long each new instance takes to pass its readiness check; a rise points at a slow start or a heavier build.
- **Early restarts** — Restarts of new instances right after start show a crash loop before the roll stalls.

### Failure modes under load
<!--meta polarity=failure-->

- **Stalled roll** — New instances fail readiness and the fleet runs mixed versions until someone acts.
- **Early readiness** — A check that passes too early sends traffic to cold instances and shows as an error spike on every batch.
- **Cut connections** — Draining cuts long-lived connections and requests, which clients see as resets unless they retry. Remove the instance from the router, wait the drain time, then stop it.
- **Capacity dip at peak** — With unavailable above 0, traffic that peaks during the roll meets fewer instances than it needs.

### Readiness checklist
<!--meta polarity=check-->

- New and old versions tolerate each other's requests and data
- Schema changes are expanded first and contracted in a later release
- The previous version is still available to roll back to
- Drain time covers your longest normal request
- An alert fires when the roll stalls past its deadline

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Continuous Validation](../../../themes/continuous-validation.md) — Replace running instances in small batches so some always serve traffic. {#fluency-continuous-validation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Canary Release](./canary-release.md) — A roll can pause after the first batch and be judged like a canary
- [Load Balancer](./load-balancer.md) — Relies on the load balancer's health checks to send traffic only to ready instances
- [Feature Flag](./feature-flag.md) — Ship the new code during the roll with the feature switched off, then enable it separately

**Alternative to**

- [Blue-Green Deployment](./blue-green-deployment.md) — Swaps the whole fleet at once to a second copy, so rollback is one routing change but capacity doubles

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Every cloud fleet service sells this as a setting: you choose the batch size and the health gate, the platform does the roll.

<!-- relationships:end -->
