---
title: Canary Release
description: Send a small slice of traffic to the new version and watch before widening
area: distributed-routing
owner: Oleksandr Derechei
tags: [operations, availability]
status: stable
aliases: [canary deployment, progressive delivery, phased rollout]
solves: [a release passed every test and still broke in production, we only find out a deploy was bad when every user is already on it, there is no way to try a change against real traffic without exposing everyone, our error rate went up after a deploy and we cannot tell if it is the deploy or the day, rolling back means all users had the bad version first]
---

# Canary Release

Routes a small, measured share of live traffic to the new version and compares its error rate and latency against the version still serving everyone else, widening the share only while the comparison holds — so a defect that no test caught is paid for by a few percent of users instead of all of them.

## What it is
<!--meta block=description-->

Some defects exist only in production, under real load and messy data, so a release that passed every test can still be wrong, and switching everyone at once shows it to every user together. A **canary release** sends a small share of traffic to the new version, compares it with the old one running at the same moment, and widens the share only if the two match.

## Explained
<!--meta block=explain-->

A canary release sends a small share of real traffic, often 1 to 5 percent, to the new version while the rest stays on the old one, then compares the two and widens the share only if the new one matches. Some defects exist only in production, under real load and messy data, and switching everyone at once shows them to every user together. The old version is the control: a fixed error threshold cannot say whether 5% errors is the release or a bad Tuesday, but a side-by-side comparison can. Choose it over an all-at-once switch when production is the risk you cannot test away, and choose the switch when the change must be atomic or urgent.

- **Shared data.** Both versions use one data store, so the new one must read the old one's data. Add schema changes first, remove later.
- **Small sample.** A 1% slice is noisy, so state a minimum request count beside each threshold, or a rare failure slips through.
- **Skewed slice.** Sending only employees muddles the comparison, so sample users uniformly.
- **Slow release.** The ramp turns minutes into hours, so keep a documented fast path for urgent fixes.

**Example.** Traffic is 500 requests a second, so a 2% slice is 10 a second. The rule is no decision before 1,800 requests, which takes 3 minutes at that rate. The ramp is 2, 10, 50 and 100 percent, holding 30 minutes at each, so a release takes about 2 hours. At 10%, 50 requests a second, the new version shows 0.6% errors against 0.1% on the old. You send the slice back to zero, and only 10% of users saw errors, for at most 30 minutes. The cost is those 2 hours against one switch, so urgent fixes take the documented fast path.

## How it works
<!--meta block=structure-->

```mermaid caption="What makes this different from just deploying carefully? Steps 4 and 5 — both versions emit metrics from the same live traffic, so step 6 compares a candidate against a control rather than against a fixed threshold nobody can justify."
flowchart LR
    User["Clients"]
    R["Weighted router"]
    Stable["Stable — current version"]
    Canary["Canary — new version"]
    M[("Metrics store")]
    Gate["Analysis gate"]
    User -->|"1 requests"| R
    R -->|"2 95%"| Stable
    R -->|"3 5%"| Canary
    Stable -->|"4 baseline"| M
    Canary -->|"5 candidate"| M
    Gate -->|"6 compare the two"| M
    Gate -->|"7 widen, or set to zero"| R
```

```mermaid caption="What does the ramp actually buy? Bounded exposure. The worst release you can ship is one step wide, and the abort is the same weighted call that widened it."
sequenceDiagram
    autonumber
    participant P as Pipeline
    participant R as Router
    participant G as Analysis gate
    P->>R: weight canary to 1%
    Note over G: hold — accumulate enough requests to mean something
    G-->>P: canary matches baseline
    P->>R: weight canary to 10%
    G-->>P: canary latency p99 above baseline
    P->>R: weight canary to 0%
    Note over R: blast radius was 10% of users, for one step
```

The router needs a way to split traffic and a way to keep a user on one side of the split. Random per-request splitting is simplest and is correct for stateless reads, but it means a single user can see the new version and the old one on consecutive clicks — fine for a backend change, visible and confusing for a UI one. Splitting on a stable hash of the user id keeps each person on one version for the length of the release, at the cost of a less uniform sample.

Comparing the two populations only works if they are comparable. Route the canary to internal users and you have measured a population that behaves differently from your customers; route it to one region and you have confounded the release with that region's traffic mix and its dependency latency. Deliberate skew is sometimes the right call — exposing employees first is a real risk decision — but then the analysis is a smoke test rather than a controlled comparison, and it should not be read as one.

## Variations
<!--meta block=variations-->

- **Percentage ramp** — Weight climbs through a fixed sequence — one percent, ten, fifty, all — with a hold at each step. The default shape, and the one that makes the worst case a single step wide.
- **Cohort canary** — The slice is chosen rather than sampled: employees first, then beta users, then everyone. It puts the risk on people who signed up for it, and it gives up the controlled comparison, because the cohort does not behave like the general population.
- **Canary by [stamp](./deployment-stamp.md)** — One whole unit of infrastructure runs the new version and the router weights traffic toward it. The blast radius is a unit rather than a percentage, which suits a system that already deploys in units and makes the abort a deregistration.
- **Automated analysis** — A gate queries the metric store at each step and promotes or aborts without a human. It removes the pause where somebody has to be awake and looking, and it moves the difficulty into stating thresholds that are neither trigger-happy nor asleep.
- **Shadow traffic** — Requests are mirrored to the new version and its responses discarded, so no user is exposed at all. It catches crashes and latency regressions with zero blast radius, and it cannot catch anything about correctness that only shows in a response a user acts on — and every mirrored write has to be suppressed or it happens twice.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Bounds the blast radius** of a bad release to the current step, instead of every user at once.
- **Tests against production conditions no staging environment reproduces** — real load, real data, real clients.
- **Compares the candidate against** a control running at the same moment, so a regression is visible as a delta rather than guessed from a threshold.
- **Abort is the same weighted** call that widened it, so recovery needs no rebuild and no separate procedure.
- **Makes progressive delivery routine**, which lets a team ship smaller changes more often rather than batching them for a big release.

### Cons
<!--meta polarity=con-->

- **Some users get the bad version**. It is a smaller number, not zero, and for some workloads that is not an acceptable trade.
- **Two versions** run against one store for the whole ramp, so every change has to be compatible with the version beside it.
- **Needs a router** that can split traffic by weight and a metrics pipeline that can attribute each request to a version — neither is free to build.
- **Turns a minutes-long release** into an hours- or days-long one, which is a poor fit for an urgent fix.
- **A small slice is a small sample**, so a rare failure can pass every gate simply by not appearing yet. Without a stated minimum observation volume, the ramp measures confidence it has not earned.
- **A skewed slice invalidates the comparison**. Internal users or a single region differ from the general population in exactly the ways that matter, and the analysis will not say so.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The failure you are worried** about only appears under real production load, data or client mix.
- **Exposing a small share** of users to a defect is acceptable, and exposing all of them is not.
- **You already have a router** that can weight traffic and metrics that carry the version.
- **Traffic volume** is high enough that one percent is still a meaningful sample within the hold window.

### Avoid when
<!--meta polarity=avoid-->

- **No user may receive** the new behaviour until it is proven — a regulated calculation, a billing change, an irreversible action.
- **The change is not compatible** with the version running beside it, so the two cannot share a store during the ramp.
- **Traffic is too low** for the slice to say anything before the ramp would have finished anyway.
- **The fix is urgent**, and hours of ramp cost more than the risk of switching at once.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the ramp, and the gate that stops it"
const STEPS = [1, 10, 25, 50, 100];   // percent of traffic on the candidate

async function ramp(candidate: Target, baseline: Target) {
  for (const weight of STEPS) {
    await router.setWeight(candidate, weight);
    await hold({ minutes: 15, minRequests: 5_000 });  // enough to mean something

    const verdict = await compare(candidate, baseline);
    if (!verdict.healthy) {
      await router.setWeight(candidate, 0);   // abort is the same call
      throw new Error(`canary failed at ${weight}%: ${verdict.reason}`);
    }
  }
}

// The comparison is against the version running right now, not a fixed number —
// that is what separates "the release is bad" from "it is a busy afternoon".
async function compare(candidate: Target, baseline: Target) {
  const [c, b] = await Promise.all([metrics(candidate), metrics(baseline)]);
  if (c.errorRate > b.errorRate * 1.2) return { healthy: false, reason: "errors" };
  if (c.p99 > b.p99 * 1.3) return { healthy: false, reason: "latency" };
  return { healthy: true };
}

```

```typescript summary="TypeScript — keeping one user on one version for the whole ramp"
// Random per-request splitting is fine for a backend change and visibly wrong
// for a UI one, because the same person flips between versions on every click.
// Hash the user instead: the assignment is stable, and it is stable across
// every service that computes it the same way.
function onCanary(userId: string, weightPercent: number): boolean {
  return hash32(`canary:${userId}`) % 100 < weightPercent;
}

// The cost: the slice is no longer a uniform random sample of requests, it is a
// uniform random sample of users. A few heavy users can dominate it, so read
// the comparison per user rather than per request when the two disagree.

```

## In the wild
<!--meta block=wild-->

- **Argo Rollouts** — Its canary strategy is a list of steps — setWeight and pause — and an AnalysisTemplate that queries a metrics provider between steps, promoting or aborting the rollout on the query result rather than on a human watching a dashboard. {#wild-argo-rollouts-canary}
- **Flagger** — A Kubernetes operator that drives progressive delivery on top of a service mesh or ingress controller: it steps the traffic weight up on a schedule, runs metric checks and webhooks at each step, and rolls back automatically when a check fails. {#wild-flagger}
- **Istio** — A VirtualRoute splits traffic across subsets by weight, which is the routing primitive a canary needs; the mesh also emits per-subset request metrics, so the candidate and the baseline are measurable without changing the application. {#wild-istio-weighted}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Step sequence** — The weights the ramp passes through. Small early steps bound the worst case; too many steps stretch a release across a day and tempt people to skip the gate.
- **Hold duration and minimum sample per step** — How long each weight is observed, and how many requests must be seen before the verdict counts. On a low-traffic service the duration binds; on a busy one the sample does.
- **Comparison thresholds** — How much worse than baseline is too worse — expressed as a ratio rather than an absolute, so a busy afternoon does not read as a regression.
- **Split key** — Whether traffic is split per request or by a stable hash of the user. Per request samples uniformly; per user keeps one person on one version, which any user-visible change needs.
- **Abort policy** — Whether a failed check sets the weight to zero automatically or pages a human. Automatic bounds the exposure to one hold window and will occasionally abort on noise.

### Signals to watch
<!--meta polarity=signal-->

- **Candidate error rate against baseline** — The primary verdict, and it must be a comparison — the same number read against a fixed threshold cannot separate a bad release from a busy hour.
- **Tail latency, candidate against baseline** — A regression usually shows in p99 well before it shows in the mean, and often before it shows in errors at all.
- **Requests observed at the current step** — The gate is only as trustworthy as its sample. Promote before the minimum is reached and the pass means nothing.
- **One business metric that the change should not move** — Checkout completions, search results returned, messages delivered. It catches the release that is technically healthy and functionally broken, which no error rate will show.

### Failure modes under load
<!--meta polarity=failure-->

- **The gate passes on an empty sample** — Low traffic, short hold, and the comparison runs on a handful of requests. The ramp completes, the verdict was noise, and the defect ships to everyone anyway.
- **A skewed slice invalidates the comparison** — The candidate is served to internal users or one region, so the populations differ in exactly the ways that matter. The gate reports a clean comparison it did not actually make.
- **Version attribution is wrong** — Metrics from both versions land in the same series because the version label is missing or the mesh reports at the wrong granularity. Everything looks fine at every step because everything is averaged together.
- **Users flip between versions** — Per-request splitting with a user-visible change produces inconsistent behaviour on consecutive clicks. It reads to users as a broken product rather than as a release in progress.
- **The ramp stalls halfway** — An approval is missed or an abort leaves weight at an intermediate value, and two versions run against one store far longer than the compatibility window was designed for.

### Readiness checklist
<!--meta polarity=check-->

- Metrics carry a version label, and the candidate and baseline series have been confirmed to separate
- Every threshold is a ratio against baseline, and every step has a stated minimum sample
- The change is compatible with the version running beside it for the whole ramp
- The abort path has been exercised, not just configured
- The split key matches the change: stable per user for anything a user can see
- A fast path exists for urgent fixes, so nobody has to bypass the gate informally

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Continuous Delivery](../../../themes/continuous-delivery.md) — Expose a slice first and watch {#fluency-continuous-delivery}
- [Continuous Validation](../../../themes/continuous-validation.md) — Compare the candidate against a live control {#fluency-continuous-validation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Feature Flag](./feature-flag.md) — Ramp the release with the router, one feature with a flag
- [Health Endpoint Monitoring](../resilience/health-endpoint.md) — A candidate that reports unhealthy leaves rotation before the gate runs
- [Deployment Stamp](./deployment-stamp.md) — The slice can be a whole stamp rather than a percentage
- [Quarantine](../../security/quarantine.md) — Pairs with a supply-chain gate: check what you ship, then who sees it first
- [Rolling Deployment](./rolling-deployment.md) — A canary can be widened as a roll of new instances
- [API Routing](./api-routing.md) — Routing is the mechanism that splits the slice

**Alternative to**

- [Blue-Green Deployment](./blue-green-deployment.md) — Ramp gradually, or flip everyone across in one routing change

**Has variant**

- [Shadow Traffic](./shadow-traffic.md) — Sends real users to the new version, so it can judge responses users act on

**Requires**

- [Load Balancer](./load-balancer.md) — The ramp needs a router that can split traffic by weight

**Often confused with**

- [Strangler Fig](../coordination/strangler-fig.md) — Moves a slice of traffic to a new version to check the release is safe, then widens

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Serverless and container platforms expose this as a percentage on a revision.

<!-- relationships:end -->
