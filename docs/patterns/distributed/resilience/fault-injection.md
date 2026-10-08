---
title: Fault Injection
description: "Break it on purpose, on a schedule, to prove it survives"
area: distributed-resilience
owner: Oleksandr Derechei
tags: [testing, availability, isolation]
status: stable
aliases: [chaos engineering, failure injection, chaos testing]
solves: [we think the system survives a dependency going down but nobody has ever checked, the failure path has never run outside a design document, our timeouts and retry settings were copied from another service and nobody knows if they fit, our failover kicked in during an outage and nobody was alerted that it had, we promise an availability number and have no evidence for it]
---

# Fault Injection

States what the system should do when a specific thing fails, then causes that failure deliberately under real load and checks the prediction — turning resilience from a property the design claims into one the system has been observed to have.

## What it is
<!--meta block=description-->

Your design says the system degrades gracefully when a dependency slows down, but nobody has seen it happen. Fault injection causes that failure on purpose while real load runs. You write down what should happen first, then compare it with what did. A failed prediction is a defect found on a calm afternoon, not during an incident.

## Explained
<!--meta block=explain-->

Fault injection breaks something on purpose while real traffic runs and checks whether the system did what you predicted. You write the prediction first, naming a normal measure and its bounds: orders keep completing, latency rises by under a second and the circuit breaker opens within 30 s. Then you cause the failure, limit how many users it can touch, and compare. A prediction that holds is evidence, and one that fails is a defect found with everyone awake. Without it, your timeout, retry and breaker have never been seen working, so the first test is the real outage. Choose it over a design review or unit tests when you need proof of behaviour under load, since a design review does not run the failure path and unit tests rarely do with real load. In practice the breaker often works and the alert or runbook is where gaps appear.

- **Real degradation.** You hurt a live system, so cap the share of users affected and abort when the normal measure leaves its bounds.
- **Needs load.** An idle system shows no queueing or retry storm, so run it on real or synthetic traffic.
- **Needs metrics.** Without per-dependency latency and error metrics, you cannot see the result, so build them first.
- **Residue.** A fault can leave a firewall rule behind, so list every change and undo it.

**Example.** The prediction: with the payment provider slowed to 3 s, orders still complete, checkout latency stays under 4 s and the breaker opens within 30 s. The test affects 5% of traffic and aborts if errors pass 2% against a normal 0.1%. It is planned for 10 minutes at 200 orders a minute, so 10 orders a minute are slowed, about 100 in all. The breaker opens at 20 s as predicted. Then the fallback crashes because nobody had ever run it, errors pass 2% and the abort ends the test. No alert fired during the slowdown, because the alert watches errors and slow calls are not errors. Both are found with everyone awake.

## How it works
<!--meta block=structure-->

```mermaid caption="What makes this an experiment rather than an outage? Steps 1 and 5. Without the prediction there is nothing to compare against. Step 2 matters because a fault on an idle system produces none of the queueing you wanted to observe."
flowchart LR
    Hyp["Hypothesis"]
    Runner["Experiment runner"]
    Load["Load"]
    Sys["System under test"]
    Dep[("Dependency")]
    Obs[("Telemetry")]
    Hyp -->|"1 predict the outcome"| Runner
    Load -->|"2 drive steady state"| Sys
    Runner -->|"3 inject the fault"| Dep
    Sys -->|"4 absorb or degrade"| Obs
    Runner -->|"5 compare against the prediction"| Obs
    Runner -->|"6 stop and restore"| Dep
```

```mermaid caption="Where does the real defect usually turn up? Not in the mechanism, which behaved. In the response to it: the system degraded exactly as designed and nobody was told."
sequenceDiagram
    autonumber
    participant R as Runner
    participant S as Service
    participant D as Dependency
    participant M as Monitors
    R->>M: record steady state
    R->>D: add 2s latency, one instance only
    S->>D: call
    D-->>S: slow
    Note over S: timeout fires, breaker counts the failure
    S->>M: error rate within predicted bounds
    M-->>R: still inside the abort threshold
    R->>D: remove the fault
    S->>M: steady state restored
    Note over R,M: the alert never fired — that is the finding
```

The faults worth injecting map to the failures that actually happen. Added latency finds missing or over-generous timeouts. Returned errors find the retry that has no ceiling. Name-resolution failure simulates the whole class of connectivity loss without touching the dependency. Terminating instances tests whether the fleet notices and replaces them. Filling a disk, pinning a processor or exhausting a connection pool finds the resource limit nobody set. Each answers a different question, so an experiment names one fault rather than combining several.

Blast radius has to be a property of the experiment, not of the operator's care. The controls that make production experiments defensible are a fault scoped to one instance or one small percentage of traffic, an automatic abort wired to the steady-state measure rather than to a human watching, and a rollback that is a single call and has been tested on its own. Residue is the hazard here. A name-resolution override or firewall rule can outlive the experiment, and the runner will not report it.

## Variations
<!--meta block=variations-->

- **Game day** — A scheduled session where a team runs experiments by hand and watches together. Slow and expensive per experiment, and the best way to test the human parts — who gets paged, which dashboard they open, whether the runbook is still true.
- **Automated experiment in the pipeline** — The same experiments run unattended as a stage of the release pipeline, usually alongside a load test so the system is under pressure when the fault lands. It catches a resilience regression on the release that introduced it rather than months later.
- **Pre-production versus production** — Running in a copy of the environment risks nothing and proves less, because the copy has different data, different scale and different traffic. Running in production is the only place the answer is definitive, and it is only defensible once the blast radius and the abort are mechanical.
- **Randomised termination** — Instances are killed continuously and at random rather than as a designed experiment. It is the oldest form of the practice and it enforces one specific property — nothing may depend on a particular instance surviving — which is why it works without a hypothesis where the general form does not.
- **Where the fault is applied** — In the platform (terminate an instance, sever a zone), in the network path (a proxy or [service mesh](../routing/service-mesh.md) adds latency or returns errors), or in the application itself behind a switch. Platform faults are realistic and coarse; mesh faults are precise and only reach traffic that goes through the mesh; in-application faults reach anything but require the failure path to be built into the code you are testing. A dependency you do not run, such as the payment provider, can only be faulted from your side (client, proxy or mesh), which tests your handling of it, not the provider. Partial faults such as packet loss or one slow endpoint find different defects than a dead dependency.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Converts a claim about resilience into an observation**, so the first test of the failure path is not the incident.
- **Exercises detection and response, not just the mechanism** — most findings are a missing alert or a stale runbook rather than broken code.
- **Finds the settings that were copied** rather than chosen: thresholds, timeouts and pool sizes that only reveal themselves under a real fault.
- **Run in the pipeline**, it catches a resilience regression on the release that caused it, when the change is still small and attributable.
- **Builds a documented history** of what the system does under specific failures, which is worth more during an incident than any design document.

### Cons
<!--meta polarity=con-->

- **You are deliberately degrading a system** real people are using, and sometimes the degradation is larger than predicted.
- **Meaningless without load and without a stated prediction** — an unloaded system tolerates faults it would fail under traffic.
- **Needs observability good enough to see the answer**. Without per-dependency latency and error metrics, the experiment produces an anecdote.
- **Costs engineering time to design**, run and interpret, and the finding is often that nothing happened, which is hard to keep funded.
- **A fault can leave residue** — a name-resolution override, a firewall rule, a paused process — that outlives the experiment and becomes a real outage the runner never reports.
- **Experiments only cover failures somebody thought of**, so the practice reinforces the existing model of how the system fails and is weakest exactly where that model is wrong.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The system has resilience mechanisms** nobody has ever seen operate under load.
- **An availability target is being promised** and there is no evidence behind the promise.
- **A failure analysis lists modes** the design claims to handle, and you want the list checked rather than believed.
- **Incidents keep revealing** that the mechanism worked and the alert did not.

### Avoid when
<!--meta polarity=avoid-->

- **There are no resilience mechanisms yet**. Injecting a fault will confirm the system breaks, which you already knew — build the timeout and the fallback first.
- **You cannot cap the blast radius** or stop the experiment automatically, in which case this is an unplanned outage with a plan attached.
- **Observability is too thin to see what happened**, so the result cannot be read either way.
- **The system is already unstable** and the queue of known problems is longer than anything an experiment would surface.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the experiment, with its abort wired in"
const experiment = {
  hypothesis: "Orders keep completing when payments adds 2s of latency",
  // scope to the cohort the fault touches; a 1m window means abort lags up to 1m
  steadyState: () => metrics.successRate("checkout", { window: "1m" }),
  tolerance: 0.99,            // below this, the prediction has failed
  blastRadius: { instances: 1 },
  fault: latency("payments", { ms: 2000 }),
  duration: "5m",
};

// One shape on every path; window runs from injection start to fault removal.
async function run(e: Experiment) {
  const before = await e.steadyState();
  const empty = { window: null, recoveryAt: null, faultRemovedAt: null };
  if (before < e.tolerance) return { held: false, skipped: true, before, ...empty };

  const startedAt = Date.now();
  await e.fault.inject(e.blastRadius);
  let held = true;
  let inconclusive = false;
  try {
    // The abort is mechanical. A human watching a dashboard is not an abort.
    await watchUntil(e.duration, async () => {
      if (await e.steadyState() < e.tolerance) throw new HypothesisFailed();
    });
    // Nothing reached the path under test, so a pass proves nothing.
    inconclusive = (await e.fault.requestsAffected()) === 0;
    held = !inconclusive;
  } catch (err) {
    if (!(err instanceof HypothesisFailed)) throw err;
    held = false;
  } finally {
    await e.fault.remove();   // always, on every path: residue is the real hazard
    await verifyRemoved(e.fault);
  }
  const faultRemovedAt = Date.now();
  const recoveryAt = await metrics.recoveredAt("checkout", e.tolerance);
  return {
    held, inconclusive, before, recoveryAt, faultRemovedAt,
    window: { from: startedAt, to: faultRemovedAt },
  };
}
```

```typescript summary="TypeScript — the finding is usually about the response, not the mechanism"
// A pass on the hypothesis is only half the result. Check that the system said
// something while it degraded, because the common defect is silent correctness.
async function report(e: Experiment, result: Result) {
  return {
    hypothesisHeld: result.held,

    // Did the mechanism engage at all? A "pass" where nothing tripped means the
    // fault never reached the path you were testing.
    breakerOpened: await metrics.sawStateChange("payments.breaker", "open"),

    // Did anyone find out? This is where most experiments actually fail.
    alertFired: await alerts.firedDuring(result.window, "payments-degraded"),
    timeToDetect: await alerts.firstFiredAt(result.window),

    // And did it come back on its own, or did the fault removal fix it?
    recoveredBeforeFaultRemoved: result.recoveryAt < result.faultRemovedAt,
  };
}

```

## In the wild
<!--meta block=wild-->

- **Netflix Chaos Monkey** — The tool that named the practice: it terminates instances at random during working hours, which enforces one property continuously — nothing may depend on a particular instance staying alive. {#wild-chaos-monkey}
- **AWS Fault Injection Service** — Runs experiment templates that inject faults such as instance termination, API errors and throttling, network latency and resource exhaustion, with stop conditions bound to CloudWatch alarms so the experiment aborts itself when a metric leaves its bounds. {#wild-aws-fis}
- **Azure Chaos Studio** — Runs fault experiments against Azure resources as a pipeline step, which is how the mission-critical reference architecture validates resiliency: chaos experiments execute alongside a load test so the injected fault lands on a system that is actually under pressure. {#wild-azure-chaos-studio}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Blast radius** — How much of the system the fault may reach — one instance, one percentage of traffic, one zone. It is the difference between an experiment and an outage, and it belongs in the experiment definition rather than in the operator judgement.
- **Steady-state measure and tolerance** — The metric that says the system is normal and the bound it may not cross. Choose a user-facing measure such as checkout success rate; an infrastructure metric will stay green through a failure users can feel. Set the tolerance from the measure's normal band over recent weeks, and include slow calls (a latency percentile), since an errors-only measure misses a slow dependency.
- **Fault magnitude** — How much latency, what error rate, how many instances. Too small and nothing engages, too large and every mechanism trips at once and you cannot tell which one mattered. Start at the smallest fault that engages the mechanism (for example latency just above the caller's timeout), then step up and record each step.
- **Duration** — How long the fault stays applied. It has to outlast the mechanism being tested — a breaker that opens after thirty seconds is untested by a twenty-second experiment.
- **Schedule** — Whether experiments run on a cadence, as a release-pipeline stage, or only during a game day. Pipeline runs attribute a regression to the change that caused it; game days test the people.
- **Abort latency** — Metric delay plus evaluation window plus the time to collect the breaches required. The experiment can run that long past tolerance, so size the blast radius and the window for it, and keep the window shorter than the duration.
- **Ramp and freeze** — Widen the radius (one instance, then a percentage, then a zone) only after the smaller run held; block runs during incidents, deploys and on-call handovers.

### Signals to watch
<!--meta polarity=signal-->

- **The steady-state measure during the experiment** — The verdict on the hypothesis, and the input to the automatic abort. Everything else is diagnosis.
- **Whether the mechanism engaged** — Breaker state changes, timeouts fired, retries attempted. A pass with nothing engaged means the fault never reached the path under test, which is a false result rather than a good one.
- **Time to detect** — How long until an alert fired, measured from fault injection. A system that degraded correctly and told nobody has failed the experiment even though the hypothesis held. Compare it against the alert's own paging target; exceeding it fails the experiment.
- **Time to recover after the fault is removed** — Separates a system that absorbed the fault from one that was pushed into a state it cannot leave on its own, such as a full queue or a saturated pool.

### Failure modes under load
<!--meta polarity=failure-->

- **The abort does not fire** — The steady-state measure degrades past tolerance and the experiment keeps running because the stop condition was misconfigured or the metric was delayed. This is the failure that turns the practice into an incident. Dry-run each new experiment with a deliberately tripped tolerance in staging and confirm the abort and fault removal fire.
- **The fault leaves residue** — A name-resolution override, a firewall rule or a paused process outlives the experiment. The runner reports a clean finish while the system is still broken, so nobody connects the outage to the experiment.
- **No load, so no result** — The fault is applied to an idle or lightly loaded system, nothing queues, nothing saturates, and the experiment passes without testing anything.
- **The measure is too coarse to see the damage** — An aggregate success rate hides a failure confined to one endpoint or one customer segment. The hypothesis holds and the users who were affected are invisible in the number.
- **Cascading beyond the blast radius** — The fault is scoped to one instance, but retries from its callers push load onto the healthy ones. The blast radius was drawn around the injection point and the failure travelled through the traffic.

### Readiness checklist
<!--meta polarity=check-->

- Every experiment states its hypothesis and its tolerance before it runs, and is skipped if the system is not healthy to begin with
- The abort is automatic and bound to the steady-state measure, not to someone watching
- Fault removal runs on every exit path and is verified afterwards rather than assumed
- Load is running, whether production traffic or a load test alongside the experiment
- The blast radius is enforced by the tool, and the experiment records what it actually reached
- The experiment backlog comes from a written failure analysis and from real incidents, not from what is easy to inject

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Continuous Validation](../../../themes/continuous-validation.md) — Check the safeguards actually work {#fluency-continuous-validation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Circuit Breaker](./circuit-breaker.md) — Injecting a failing dependency is how you find out the breaker actually trips
- [Bulkhead](./bulkhead.md) — Saturating one compartment proves the others were really isolated
- [Retry with Backoff](./retry-backoff.md) — Returning errors on purpose exposes a retry with no ceiling or no jitter
- [Timeout / Deadline](./timeout-deadline.md) — Added latency is the fastest way to find a missing or over-generous timeout
- [Health Endpoint Monitoring](./health-endpoint.md) — The experiment checks whether the probe noticed, not just whether the code coped
- [Analyse Failure Modes](../../../principles/failure-mode-analysis.md) — The analysis supplies the list of faults worth injecting
- [Service Mesh](../routing/service-mesh.md) — A mesh proxy adds latency or errors for the experiment, so no application code needs a fault switch.
- [Fallback](./fallback.md) — Injecting the dependency failure is the only way the fallback runs under load before an incident.

**Prevents**

- [Cascading Failure](../../../hazards/cascading-failure.md) — Rehearse the first failure and find the spread before it happens for real
- [Retry Storm](../../../hazards/retry-storm.md) — A deliberate outage under load makes the amplification visible in a controlled window
- [Metastable Failure](../../../hazards/metastable-failure.md) — Applying a trigger, removing it and checking that goodput returns exposes a loop before an incident does.

**Implemented by**

- [Observability Platform](../../../capabilities/observability-platform.md) — Two clouds sell this as a service, and open-source tools run the same experiments on Kubernetes.

<!-- relationships:end -->
