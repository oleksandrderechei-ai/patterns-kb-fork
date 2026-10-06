---
title: Deployment Stamp
description: "A whole self-contained copy of the stack, deployed and thrown away as one unit"
area: distributed-scale
owner: Oleksandr Derechei
tags: [scalability, isolation, availability]
status: stable
aliases: [stamp, scale unit, cell]
solves: [one bad region takes the whole product down for everyone, we hit a quota ceiling and there is no bigger size left to buy, fixing production means logging into the live environment while customers are on it, our environments have drifted apart and nobody knows what is actually deployed where, one big customer's traffic makes the app slow for everybody else]
---

# Deployment Stamp

Packages compute, ingress, buffering and configuration into one self-contained copy of the stack that a pipeline can provision, test and destroy as a single unit — so growing capacity means deploying another stamp, and recovering from a broken one means deleting it.

## What it is
<!--meta block=description-->

One environment makes every ceiling, such as a quota or a cluster size, a ceiling for the whole business, and a fault is fixed in place with users on it. A **deployment stamp** is a complete copy of the stack, built from one template, that serves its own share of users. You add a stamp for capacity and delete a bad one.

## Explained
<!--meta block=explain-->

A deployment stamp is a complete copy of your whole stack, built from one template, that serves its own share of users. When you need more capacity you build another stamp, and when one goes bad you take it out of rotation and delete it. A router in front spreads users across the stamps, and nothing inside a stamp talks to anything inside another. Without it, one environment caps the whole business at every limit and a fault is fixed in place with users on it. Capacity becomes arithmetic: measure what one stamp serves, then build demand divided by that. A failure stays with one stamp's users, so the stamp is also a [bulkhead](../resilience/bulkhead.md) around a whole environment. Choose it over growing one environment when you hit a hard ceiling or one outage must not reach everyone.

- **Cost.** Every stamp adds to the bill, so use it only where one environment is not enough.
- **State.** A stamp must hold no state anyone would miss, so keep durable data in a global store that outlives every stamp.
- **Shared parts.** The router and that store become single points of failure, so make them more available than any stamp.
- **Spare.** Survivors must absorb a failed stamp, so plan one spare and run at least two stamps.

**Example.** A load test shows one stamp serves 5,000 requests a second, and peak demand is 18,000. That needs 4 stamps, since 18,000 divided by 5,000 is 3.6. If one fails, the other 3 carry only 15,000, so 4 is not enough. With a spare you run 5, and after a loss the other 4 carry 20,000. A bad release reaches only 20% of users if you ship one stamp at a time. The cost is 5 stamps on the bill where 3.6 would do.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a request reach one stamp and stay inside it? Steps 2 and 3 are the whole contract — the router asks each stamp whether it is healthy and sends the user to one that says yes. Everything from 4 to 6 stays within stamp A, and step 7 is the recovery path: shift the traffic, do not repair the stamp."
flowchart LR
    User["Client"]
    GLB["Global router"]
    subgraph A["Stamp A — one deployable unit"]
        Ing["Ingress"]
        App["App instances"]
        Buf[("Regional buffer")]
    end
    subgraph B["Stamp B — identical, independent"]
        App2["App instances"]
    end
    DB[("Global store")]
    User -->|"1 request"| GLB
    GLB -->|"2 probe each stamp"| Ing
    GLB -->|"3 route to a healthy one"| Ing
    Ing -->|"4 spread"| App
    App -->|"5 buffer the write"| Buf
    App -->|"6 persist"| DB
    GLB -->|"7 shift away on failure"| App2
```

```mermaid caption="What happens when a stamp goes bad? Nobody logs in to fix it. The probe fails, the router stops sending traffic, the surviving stamps absorb the load, and the pipeline destroys and replaces the stamp — which only works if the surviving stamps had headroom for it."
sequenceDiagram
    autonumber
    participant R as Global router
    participant A as Stamp A
    participant B as Stamp B
    participant P as Pipeline
    R->>A: health probe
    A-->>R: healthy
    R->>A: user traffic
    R->>A: health probe
    A-->>R: unhealthy (broker unreachable)
    Note over R: stamp A out of rotation
    R->>B: all user traffic
    P->>B: scale out to absorb the shifted load
    P->>A: destroy
    P->>R: deregister stamp A
```

Three tiers fall out of the drawing, and every resource in the system belongs to exactly one of them. **Global** resources are shared by every stamp and live as long as the system: the router, the durable store, the image registry. **Regional** resources outlive individual stamps but not the region: the log and metric stores that must still be readable after the stamp that emitted them is gone. **Stamp** resources are ephemeral and hold nothing you cannot rebuild. The router also keeps a map from each user or tenant to its stamp. That map is global state, and each user stays on one stamp, so the stamps themselves stay stateless.

Assigning a resource to the wrong tier is the characteristic failure. Push something stateful down into the stamp and you can no longer delete the stamp. Pull something high-churn up into the global tier and every stamp now shares a blast radius with every other one — which is how a single expired credential in a shared store takes down all stamps at the same moment, the exact outcome the pattern was adopted to prevent.

## Variations
<!--meta block=variations-->

- **Regional stamp** — One stamp per region, with the router sending each user to the nearest healthy one. This is the common shape: it buys latency and regional fault tolerance in the same move, and it makes a regional outage a routing event rather than an incident.
- **Several stamps per region** — When one stamp hits a hard ceiling — a subscription quota, a cluster node limit, an address range — you add a second stamp in the same region instead of enlarging the first. Capacity keeps growing past the limit that would otherwise cap the whole system, at the cost of more units to deploy and observe.
- **Tenant stamp** — Stamps partitioned by customer rather than by geography, so a large tenant gets its own copy of the stack. Isolation becomes the point and geography becomes incidental — it is how you promise one tenant that another cannot make them slow, and it is the answer to [Noisy Neighbour](../../../hazards/noisy-neighbour.md) when a shared pool has stopped being defensible.
- **Ephemeral versus long-lived stamps** — A long-lived stamp is updated in place and lives for months; an ephemeral one is replaced on every release and lives for days. Ephemeral stamps reduce configuration drift when built only from the template, and make [Blue-Green Deployment](./blue-green-deployment.md) a routing change, since each release already builds a new stamp. They cost double infrastructure during every changeover, the shared store must serve two versions, and all state must leave the stamp first.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Contains a failure** inside a stamp to the users on that stamp. A corrupted cluster or an exhausted quota stops at the stamp boundary, though the global router, store and shared credentials still fail every stamp at once.
- **Turns capacity planning into arithmetic** — load-test one stamp, then deploy demand divided by that number.
- **Recovery is redeployment**. There is no repair procedure to write, rehearse or get wrong at 3am.
- **Scales past per-account and per-cluster ceilings**, because the ceiling applies to a stamp rather than to the system.
- **Makes zero-downtime release a routing change**: deploy a new stamp, shift traffic, delete the old one.

### Cons
<!--meta polarity=con-->

- **Multiplies the infrastructure bill** and the number of things to observe by the number of stamps.
- **Demands that every stamp** be built from a template. Any hand-made change is lost on the next deployment, which is the intent and also the discipline nobody enjoys.
- **Forces state out** of the stamp before you can adopt it, which is usually the hard part of the migration.
- **Moves the single point** of failure to the global router and the global store, and both now need more availability than any individual stamp does.
- **Requires headroom** on every surviving stamp to absorb a failed one. If each stamp is sized only for its own peak, failover moves the outage, so the capacity model must carry N+1, with enough quota and warm capacity in the survivors.
- **Leaves you running several versions** at once during a changeover, so the shared store must tolerate readers and writers from two releases — later versions must ignore fields they do not understand rather than reject them.
- **Punishes you for starting with one stamp**. A single deployment lets single-stamp assumptions harden into code and configuration unnoticed, and they all surface at once when you add the second — so run at least two from the beginning, even if the second is small.
- **Makes moving a tenant between stamps hard**. Tenant data lives in the global store, so a move re-points the tenant's stamp mapping and migrates its partition. Stamps are independent by design, so that needs custom logic.
- **Defeats its own isolation** if a release goes to every stamp at once. Ship one stamp first, wait for its health checks to pass, then widen.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **An outage in one region**, cluster or account must not be an outage for every user.
- **You are growing past a hard ceiling** — a quota, a cluster size, an address range — that no amount of scaling up will move.
- **You want releases to replace** infrastructure rather than mutate it, so configuration drift stops accumulating.
- **Users are spread across geographies** and you want to serve each from nearby compute without forking the codebase.
- **Tenant isolation** — one tenant's load must be prevented from degrading another's, and a shared pool has stopped being defensible.

### Avoid when
<!--meta polarity=avoid-->

- **One environment comfortably serves** the load and its failure is survivable — the second stamp doubles the bill to solve a problem you do not have.
- **The workload keeps durable state** on local disk and you are not prepared to move it out first.
- **Deployment is still manual**. Stamps multiply every manual step by the number of stamps, so automation is a prerequisite rather than a follow-up.
- **Components need to talk across stamps** to complete a request, which reintroduces the coupling the boundary was drawn to remove.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a release is a new stamp, not a change to an old one"
// Every stamp comes from one template. The only inputs are where it goes
// and which version it runs — anything else would be drift.
type StampSpec = { region: string; version: string };

async function releaseTo(regions: string[], version: string) {
  const fresh = await Promise.all(
    regions.map((region) => provision({ region, version })),
  );

  for (const stamp of fresh) {
    await smokeTest(stamp);              // prove it before a user meets it
    await router.register(stamp, { weight: 0 });
  }

  await router.shift(fresh, { to: 100, over: "6h" });  // gradual, reversible

  for (const stamp of await router.previousUnits()) {
    await router.deregister(stamp);
    await destroy(stamp);                // no repair path, only replacement
  }
}

```

```typescript summary="TypeScript — which tier does a resource belong to?"
// The one question to ask of every resource in the system. Getting it wrong
// is what makes a stamp undeletable, or makes every stamp fail together.
type Tier = "global" | "regional" | "stamp";

function tierOf(r: Resource): Tier {
  // Outlives the system and is shared by everyone: the blast radius is total,
  // so this tier gets the highest availability budget you have.
  if (r.holdsDurableState || r.isTheEntryPoint) return "global";

  // Outlives the stamp but not the region. Logs and metrics live here so the
  // evidence survives the stamp that produced it.
  if (r.mustOutliveTheStampThatWroteIt) return "regional";

  // Everything else. If deleting this loses something, it is not a stamp
  // resource yet — move the state out before you claim the stamp is disposable.
  return "stamp";
}

```

## In the wild
<!--meta block=wild-->

- **Azure Deployment Stamps** — The Azure Architecture Center documents this by name as the Deployment Stamps pattern, and its mission-critical reference architecture builds on it: a stamp per region holding the cluster, broker and key store, fronted by a global router that probes each stamp and routes only to healthy ones. {#wild-azure-deployment-stamps}
- **AWS cell-based architecture** — AWS publishes the same idea as cells: partition the workload into independent, identically-provisioned cells so a fault is contained to one cell rather than the whole service, and size the cell by load-testing it. {#wild-aws-cells}
- **Slack cellular architecture** — Slack Engineering has written about moving its services to a cellular architecture so that a failure confined to one availability zone can be drained by shifting traffic to other cells instead of being repaired in place. {#wild-slack-cells}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Stamp size** — The tested capacity of one unit — the request rate it serves with every component inside it at an acceptable saturation. Larger stamps cost less per request and concentrate more users behind one failure; smaller stamps do the opposite. Find it by load-testing one stamp until latency or errors degrade, recording the request rate there, and setting the ceiling below it.
- **Traffic weights** — The share of traffic the router sends to each registered stamp. Weights are how a release ramps and how a rollback happens, so they need to be a deployable value rather than a console change.
- **Headroom factor** — Spare capacity across the fleet, expressed as how many stamps may fail before the survivors saturate. Provision every stamp for its own peak and a failover moves the outage instead of absorbing it. With N stamps and k tolerated failures, run each at most (N-k)/N of its tested ceiling at fleet peak. For k=1, three stamps means about 67%.
- **Health probe interval and timeout** — How often the router asks each stamp whether it is healthy and how long it waits. Shorter detects a bad stamp sooner and multiplies probe load across every router edge, so the result can be cached inside the stamp. Detection time is about the interval times the number of consecutive failures required before ejecting or restoring a stamp. Set that count above 1 to stop flapping.
- **Scale-in floor** — The minimum instance count a stamp holds when its region is idle. Too low and the morning ramp is served by a cold stamp; too high and off-peak regions carry peak cost all night.

### Signals to watch
<!--meta polarity=signal-->

- **Per-stamp saturation against its tested ceiling** — The number the capacity model is built on. A stamp running above the rate it was load-tested at is serving traffic nobody has proven it can serve.
- **Probe pass rate per stamp** — Distinguishes a stamp that is degraded from a system that is degraded. Flapping here shifts traffic back and forth and is worse than a stamp that stays out.
- **Quota and limit consumption** — Instance counts, address space and per-account service limits, watched against the ceiling rather than against last week. This is what stops a scale-out, and it fails silently until the moment you need to grow.
- **Traffic weight distribution** — What the router is actually doing, not what the release intended. A drift between the two is the first sign a changeover stalled halfway.

### Failure modes under load
<!--meta polarity=failure-->

- **Scale-out blocked by a quota** — Existing instances keep serving while new ones fail to start, so the symptom is a stamp that will not grow rather than a stamp that is down. Under a spike it turns into user-visible latency with no error in the application logs.
- **Failover with no headroom** — A stamp drops out, its traffic lands on survivors that were sized for their own peak, and they saturate in turn. The isolation boundary held and the capacity model did not.
- **The global tier becomes the bottleneck** — Every stamp reads and writes the same durable store, so throttling there degrades all stamps at once regardless of how well isolated they are.
- **A shared credential expires** — One key held in the global tier and referenced by every stamp fails everywhere in the same minute. It is the failure mode that most reliably defeats the pattern, which is why identity-based access beats a long-lived key here.
- **Address space exhausted inside a stamp** — New instances cannot be placed even though capacity exists. No outage follows immediately, but the stamp has quietly lost its ability to absorb a burst or a failover.

### Readiness checklist
<!--meta polarity=check-->

- Every piece of durable state lives outside the stamp, and deleting a stamp has been rehearsed rather than assumed
- Stamps are provisioned only from the template, with no manual change that would survive a redeployment
- The capacity model carries N+1 and has been load-tested by taking a stamp out under load
- The health probe reports dependency health, not just that the process is running
- Quotas have been checked for the peak stamp count, including the overlap during a changeover
- Teardown deregisters the stamp from the router before it destroys it

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Cloud Native](../../../themes/cloud-native.md) — The whole arrangement, replicated as a unit {#fluency-cloud-native}
- [Scale Units & Stamps](../../../themes/scale-units-and-stamps.md) — The unit itself — deployed, sized and destroyed as one {#fluency-scale-units-and-stamps}
- [Continuous Validation](../../../themes/continuous-validation.md) — A release subject that is clean by construction {#fluency-continuous-validation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Bulkhead](../resilience/bulkhead.md) — A stamp is a bulkhead drawn around a whole environment
- [Load Balancer](./load-balancer.md) — A global router spreads users across the stamps that exist
- [Health Endpoint Monitoring](../resilience/health-endpoint.md) — The probe is how the router learns a stamp should leave rotation
- [Canary Release](./canary-release.md) — Weight traffic toward one stamp to ramp a release by unit
- [Blue-Green Deployment](./blue-green-deployment.md) — A release builds a new stamp, so the switch is a traffic weight
- [Multi-Tenancy](./multi-tenancy.md) — Stamps can be assigned per tenant or per group of tenants.

**Requires**

- [Stateless Service](./stateless-service.md) — A stamp is only disposable if nothing inside it holds state

**Often confused with**

- [Geode](./geode.md) — Partitions users across units; a geode replicates everything to every unit

**Prevents**

- [Noisy Neighbour](../../../hazards/noisy-neighbour.md) — A tenant stamp stops one customer's load reaching another's

**Demonstrated by**

- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — residency is one full stack per region — gateway, application programming interface (API), workers, Postgres and standby, vault, object store — stamped from the same infrastructure-as-code so only jurisdiction config varies
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — isolation made checkable: a query cannot cross a boundary with no connection across it, at the stated cost of N copies of everything

**Implemented by**

- [Regions & Availability](../../../capabilities/regions.md) — The unit you replicate across a cloud's geography.
- [Infrastructure as Code](../../../comparisons/infrastructure-as-code.md) — Reproducing a stamp is a provisioning-tool job; doing it by hand is how stamps drift

<!-- relationships:end -->
