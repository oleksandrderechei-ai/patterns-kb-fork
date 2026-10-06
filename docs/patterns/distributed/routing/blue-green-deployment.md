---
title: Blue-Green Deployment
description: "Stand the new version up beside the old, then move traffic across"
area: distributed-routing
owner: Oleksandr Derechei
tags: [operations, availability, lifecycle]
status: stable
aliases: [blue/green, red-black deployment]
solves: [every deploy needs a maintenance window and users notice it, a bad release takes another hour to undo because rolling back means building again, half the fleet is on the new version and half on the old and nothing behaves consistently, we cannot test the new version on real infrastructure until it is already live, the migration went out with the code and now there is no way back]
---

# Blue-Green Deployment

Runs the new version on its own complete set of infrastructure alongside the version currently serving users, then makes the release a routing change — which means rollback is the same routing change in reverse, and no user ever meets a half-upgraded system.

## What it is
<!--meta block=description-->

**Blue-green deployment** releases a new version by building a second full copy of the system, testing it while it carries no users, and then pointing the router at it. An in-place upgrade can fail halfway and leave a mix nobody tested, and undoing a finished bad one means another upgrade. Here the old copy keeps running, so going back is one more routing change.

## Explained
<!--meta block=explain-->

Blue-green deployment runs two full copies of your system, blue serving users and green idle with the new version, and releases by pointing the router at green, so rolling back means pointing it back. The colours name roles, not environments: blue is whichever copy holds the traffic, so the roles swap on every release. Without it, an in-place upgrade that fails halfway leaves some machines on each version, and one that finishes but is wrong can be undone only by another upgrade, the slowest answer at the worst moment. Choose it over a rolling update, which replaces machines one at a time, when the time to recover from a bad release is the constraint.

- **Double infrastructure.** You pay for two copies during the overlap, so destroy the old one once the watch window closes.
- **Shared data store.** Rollback works only while the old version reads what the new one wrote, so add columns first, remove later.
- **Long sessions.** Open connections do not switch, so keep blue running as long as your longest session.

**Example.** A service runs on 20 servers. You build 20 more with the new release, run smoke tests while they carry no users, and at 14:00 point the router at them. The column the release needs was added a week earlier, so blue still reads the data. At 14:06 errors climb from 0.2% to 4%, and at 14:07 you point the router back, a one-minute rollback instead of a rebuild. The cost was 40 servers for seven minutes, and you now delete the 20 green servers and fix the release.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does the release actually happen? At step 5, and nowhere else — everything before it builds and proves green while blue carries every user. Step 7 is the constraint the picture hides: one store serves both colours, so the schema must satisfy the old version and the new one for the whole overlap."
flowchart LR
    User["Client"]
    R["Router"]
    Pipe["Pipeline"]
    Blue["Blue — version now serving"]
    Green["Green — new version"]
    DB[("Shared store")]
    User -->|"1 request"| R
    R -->|"2 all traffic"| Blue
    Pipe -->|"3 build green"| Green
    Pipe -->|"4 test with no users on it"| Green
    R -->|"5 switch"| Green
    Blue -->|"6 idle, kept for rollback"| DB
    Green -->|"7 same data, both versions"| DB
```

```mermaid caption="What does a failed release cost? One routing change. That path exists only because blue was left running and untouched, which is exactly what the doubled infrastructure is buying."
sequenceDiagram
    autonumber
    participant P as Pipeline
    participant R as Router
    participant B as Blue
    participant G as Green
    P->>G: provision and deploy the new version
    P->>G: smoke test directly, bypassing the router
    G-->>P: pass
    P->>R: switch to green
    R->>B: drain in-flight requests
    R->>G: all traffic
    Note over G: bake — watch errors and latency
    G-->>P: error rate above threshold
    P->>R: switch back to blue
    Note over B: rollback complete, nothing rebuilt
```

Two details decide whether the switch is genuinely invisible. In-flight requests on blue must be allowed to finish rather than cut, so the router drains the old target before retiring it and the application handles its shutdown signal instead of exiting on the spot. And green must be warm — instances started, caches populated, connection pools open — before it takes the first request, or the switch trades a deployment outage for a cold-start one.

Long-lived connections do not switch. A websocket or a streaming connection established against blue stays on blue until something closes it, so a release that assumes an instant cutover leaves a population of users on the old version for as long as their sessions last. Either the client reconnects on a signal, or blue is retained until those connections drain naturally — and then the retention window is a property of session length rather than of the release plan.

## Variations
<!--meta block=variations-->

- **Swapped environments** — Two long-lived environments exchange roles on every release: today's green is next release's blue. The infrastructure is provisioned once and reused, which is cheap, but configuration drifts between the two because neither is ever rebuilt from scratch.
- **Ephemeral green** — Green is provisioned fresh for each release and blue is destroyed once the switch settles. Drift becomes impossible because nothing survives long enough to drift, and the pattern folds into [Deployment Stamp](./deployment-stamp.md) — the release builds a new stamp and the switch is a traffic weight. The cost is a full provisioning cycle inside every release.
- **Gradual switch** — The router moves weight from blue to green over hours or days instead of flipping it. That is [Canary Release](./canary-release.md) layered on the same two environments, and it turns a binary decision into an observation you can stop at any point.
- **Rolling update** — The common alternative: replace instances a few at a time inside one environment. It needs no second fleet and no doubled cost, and it gives up the property blue-green exists for — during the roll both versions are live, and rollback means rolling again.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Rollback costs one routing change** rather than a rebuild, as long as blue is still running and the data stays readable by it.
- **No machine is ever half-upgraded**, but both versions share the store and long-lived sessions during the overlap, so that overlap must be designed for.
- **The new version is exercised** on production infrastructure and data before any user reaches it, though without real load; keep smoke tests read-only or tagged.
- **Deployment stops being a scheduled outage**, which removes the maintenance window and the argument about when to hold it.
- **Pairs with disposable infrastructure**: build green fresh every time and configuration drift stops accumulating.

### Cons
<!--meta polarity=con-->

- **Doubles the infrastructure** for the length of the release, and the second copy must be large enough to take all the traffic.
- **The shared store cannot be duplicated**, so every schema change has to work for both versions at once.
- **A long release process makes small changes expensive**, which pushes teams toward batching them — the opposite of what the pattern is for.
- **The router configuration becomes load-bearing**: the ability to release at all now depends on it being correct.
- **Rollback is only real** while data written by green is still readable by blue. A migration that drops or repurposes a column silently removes the escape route, with no error at the time it happens.
- **Long-lived connections do not follow the switch**, so a fraction of users stays on the old version for the length of their session and the retention window is set by session duration rather than by the plan.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A bad release must be undoable in minutes** rather than in another build cycle.
- **There is no acceptable maintenance window**, because users are on the system at every hour.
- **Running two versions** of the code at once is fine, but running a half-upgraded fleet is not.
- **You already rebuild infrastructure from a template**, so provisioning a second copy is a pipeline step rather than a project.

### Avoid when
<!--meta polarity=avoid-->

- **Doubling the fleet** for the length of a release is not affordable, or a quota will not allow it.
- **The change carries a schema** migration that cannot be made backward compatible, because then rollback does not work and the main benefit is gone.
- **Releases are small** and frequent and a rolling update already meets the availability target with none of the doubled cost.
- **Almost all traffic sits on long-lived connections**, so the switch would take as long as the sessions do and the two environments would coexist indefinitely.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the release, and the rollback that costs the same"
// "blue" and "green" are roles, not environments. Whoever holds the traffic
// is blue; a release swaps the roles and never upgrades anything in place.
async function release(version: string) {
  const blue = await router.activeTarget();
  const green = await provision(version);

  await smokeTest(green);          // reach green directly, not through the router
  await warmUp(green);             // pools open, caches filled, before any user

  await router.pointTo(green);
  await router.drain(blue, { grace: "60s" });   // let in-flight requests finish

  if (await bake(green, { for: "30m" })) {
    await destroy(blue);           // only now is the rollback option given up
  } else {
    await router.pointTo(blue);    // the whole point: one call, no rebuild
    await destroy(green);
  }
}

```

```typescript summary="TypeScript — the migration shape that keeps rollback possible"
// Blue and green share one store, so a schema change has to be readable by
// both. Expand, then contract — never in the same release.

// Release N — expand. Add the new field; nothing reads it yet.
await db.addColumn("orders", "customer_ref", { nullable: true });

// Release N+1 — write both, read either. Blue still writes only the old field,
// so green must cope with rows that lack the new one, and blue with rows that
// have it.
function readCustomer(row: OrderRow): string {
  return row.customer_ref ?? row.customer_id;
}
function writeCustomer(row: OrderRow, ref: string) {
  row.customer_ref = ref;
  row.customer_id = ref;   // keep blue able to read it, or rollback is gone
}

// Release N+2 — contract. Only once no version in rotation reads the old
// field, and only once rolling back that far is off the table.
await db.dropColumn("orders", "customer_id");

```

## In the wild
<!--meta block=wild-->

- **Argo Rollouts** — Its BlueGreen strategy keeps an activeService and a previewService pointing at two ReplicaSets, promotes by re-pointing the active service, and holds the old ReplicaSet for a configurable scaleDownDelaySeconds so a rollback needs no rebuild. {#wild-argo-rollouts}
- **AWS CodeDeploy blue/green** — CodeDeploy provisions a replacement set of instances or tasks, registers them behind a second load balancer target group, shifts traffic to it, and can roll back by shifting the listener back to the original group. {#wild-aws-codedeploy}
- **Azure App Service deployment slots** — A staging slot hosts the new version beside production in the same App Service plan, is warmed up before the swap, and the swap exchanges the two slots' routing, so swapping back is the rollback. {#wild-app-service-slots}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Bake window** — How long the new fleet serves all traffic before the old one is destroyed. A longer window catches slow-burning faults that only appear after a cache fills or a nightly job runs; a shorter one cuts the period you pay for two fleets.
- **Drain grace period** — How long the router lets in-flight requests finish on the old fleet before cutting it. Set it below your longest normal request and the switch shows up to users as truncated responses.
- **Warm-up before the switch** — Synthetic traffic against the new fleet so pools, caches and just-in-time compilation are ready. Skip it and the release trades a deployment outage for a cold-start latency spike at the exact moment everyone is watching.
- **Auto-promotion** — Whether the switch happens automatically once the smoke tests pass, or waits for an approval. Automatic is faster and removes a human from the critical path; manual is what you want while the process is still new.
- **Old-fleet retention** — How long the previous fleet is kept after the switch. It is the length of the rollback window and the size of the doubled bill, and those are the same dial.

### Signals to watch
<!--meta polarity=signal-->

- **Error rate and latency on the new fleet against the old fleet's baseline** — Compare the two rather than watching an absolute threshold, since a change visible only as a delta is the one a threshold misses.
- **In-flight requests on the draining fleet** — Should fall to zero within the grace period. If it does not, either the grace is too short or something is holding connections open longer than the request model assumes.
- **Capacity and quota consumption during the overlap** — Peak usage during a release is roughly double steady state. Watch it against the limit, because this is the moment a quota bites.
- **Long-lived connections still on the old fleet** — Tells you when the switch is actually finished. Without it, the release looks complete while a population of users is still on the previous version.

### Failure modes under load
<!--meta polarity=failure-->

- **The migration made rollback impossible** — The switch succeeds, the new version writes data the old one cannot read, and the routing change back now corrupts or fails. There is no error at the moment the escape route disappears, which is what makes this the worst one.
- **Cold start after the switch** — The new fleet takes full traffic with empty caches and closed pools, so latency spikes for minutes and looks like a bad release. Warm-up prevents it; retrying the switch does not.
- **Quota blocks the second fleet** — The release stops before it starts because there is no room for the doubled capacity. It fails in the pipeline rather than in production, which is the good version of this failure.
- **Stranded long-lived connections** — Websocket and streaming clients stay on the old fleet. Destroying it on schedule disconnects them all at once, turning a clean release into a reconnect storm.
- **Router misconfiguration** — A wrong target, an expired certificate on the new fleet, or a rule that matches nothing. Because every release depends on the router, its configuration errors present as a full outage rather than a degraded one.

### Readiness checklist
<!--meta polarity=check-->

- Every schema change in this release is backward compatible, and the contract step is scheduled for a later release
- The application ignores fields it does not understand instead of rejecting them, so both versions can share the store
- Smoke tests reach the new fleet directly, bypassing the router, and gate the switch
- The rollback has been exercised in a lower environment with the same pipeline, not just documented
- Quota headroom covers double the steady-state fleet for the length of the overlap
- The application handles its shutdown signal and finishes in-flight work within the drain grace

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Twelve-Factor](../../../themes/twelve-factor.md) — A release you can replace rather than mutate {#fluency-twelve-factor}
- [Continuous Delivery](../../../themes/continuous-delivery.md) — Switch traffic in one move, with a way back {#fluency-continuous-delivery}
- [Continuous Validation](../../../themes/continuous-validation.md) — Prove the new version before anyone arrives {#fluency-continuous-validation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Load Balancer](./load-balancer.md) — The switch is a change of target on the router in front
- [Strangler Fig](../coordination/strangler-fig.md) — Route a slice to the replacement and keep the way back
- [External Configuration Store](../coordination/external-configuration-store.md) — Configuration deserves the same staged rollout and rollback path as code
- [Containerization](../coordination/containerization.md) — The two sides differ only by which image digest they run
- [Deployment Stamp](./deployment-stamp.md) — Ephemeral green is a freshly provisioned stamp
- [Web-Queue-Worker](../../architecture/web-queue-worker.md) — Both halves swap together, so size for two versions running during the switch
- [Container Orchestration](../coordination/container-orchestration.md) — Managed or in-cluster, the orchestrator is where the switch is declared.

**Alternative to**

- [Canary Release](./canary-release.md) — Switch all at once, or ramp a weighted slice and watch
- [Rolling Deployment](./rolling-deployment.md) — Replaces instances a few at a time in one fleet, so no second copy is needed, but both versions serve users mid-roll and rollback means rolling again

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Managed compute platforms ship this as a deployment strategy rather than something you script.

<!-- relationships:end -->
