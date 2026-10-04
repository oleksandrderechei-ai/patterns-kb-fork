---
title: Health Endpoint Monitoring
description: Exposes a route that reports whether a service is healthy
area: distributed-resilience
owner: Oleksandr Derechei
tags: [observability, load-balancing, availability]
status: stable
aliases: [health check, healthcheck, health check api]
solves: [the load balancer keeps sending traffic to an instance that cannot serve it, the process is up and listening but every request it takes fails, my pod gets restarted while it is still warming up its cache, we only find out a node is broken when customers start complaining, a deploy rolled traffic onto instances that were not ready yet and dropped requests]
---

# Health Endpoint Monitoring

Exposes a lightweight route — `/health` or `/ready` — that a service answers honestly about its own state, so load balancers, orchestrators, and on-call engineers can tell a live, working instance from one that's merely still listening.

## What it is
<!--meta block=description-->

A load balancer or orchestrator outside a process cannot tell whether it can still serve requests, because an open port proves only that something is listening. A health endpoint is a route that answers that question for machines, cheaply and fast. Two checks matter: liveness says restart it, and readiness says stop sending it traffic.

## Explained
<!--meta block=explain-->

A health endpoint is a web address your service answers only for machines, so a [load balancer](../routing/load-balancer.md) or an orchestrator (the tool that starts, stops and restarts copies of your service) can ask whether it is working. It replies fast and cheaply, with a bare 200 or a short summary. Without it, the platform guesses from uptime and CPU and sends users to copies that will fail them. Ask two questions. Liveness asks whether the process works at all, and a no means restart it. Readiness asks whether it should get traffic now, and a no means route around it and leave it running, since a copy warming its cache is alive but not ready. Merging them turns a short dependency hiccup into a restart storm. Choose it over watching ports or CPU whenever something must decide where traffic goes.

- **Deep checks cascade.** Calling every dependency can overload them, so give each call a short timeout and cache the answer.
- **False alarms.** One blip in a minor dependency pulls a healthy copy out, so check only what the request path needs.
- **Leaks internals.** A detailed answer exposes your topology, so keep it off the public network.

**Example.** Three copies of a service sit behind a load balancer. Each checks the database with a 1 s timeout every 10 s, and the platform restarts a copy after 3 failed liveness checks. The database goes down for 40 s and a restart takes 60 s. If one check serves both questions, all three copies fail 3 checks by 30 s and restart together, so the site stays down until 90 s. With readiness separate, the database check only removes the copies from rotation, liveness still passes, nothing restarts, and traffic returns within 10 s of the database coming back, at 50 s. The cost is one more route to keep honest.

## How it works
<!--meta block=structure-->

```mermaid caption="How do two machines outside the process decide what to do with it? The orchestrator polls liveness and learns whether to restart; the load balancer polls readiness and learns whether to send the next request here."
flowchart LR
    Orch["Orchestrator"]:::ext
    LB["Load balancer"]:::ext
    Client["Client traffic"]:::ext
    subgraph Inst["One service instance"]
        Live["/healthz — liveness"]
        Ready["/readyz — readiness"]
        App["Request handler"]
    end
    DB[("Database")]:::ext
    Orch -->|"1 poll liveness"| Live
    Live -->|"2 answer 200, process alive"| Orch
    LB -->|"3 poll readiness"| Ready
    Ready -->|"4 ping under a timeout"| DB
    Ready -->|"5 answer 200, take traffic"| LB
    Client -->|"6 request"| LB
    LB -->|"7 route to a ready instance"| App
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="How does one health poll decide whether the orchestrator keeps routing to an instance or pulls it out? The service checks its own dependencies and answers with a status the poller acts on directly."
sequenceDiagram
    autonumber
    participant LB as Orchestrator
    participant S as Service Instance
    participant Dep as Dependency
    LB->>S: GET /healthz
    S->>Dep: check connectivity
    alt dependency reachable
        Dep-->>S: ok
        S-->>LB: 200 healthy
        LB->>LB: keep instance in rotation
    else dependency times out
        Dep--xS: timeout
        S-->>LB: 503 unhealthy
        LB->>LB: pull instance from rotation
    end
```

## Variations
<!--meta block=variations-->

- **Liveness vs. readiness probes** — Two separate routes with different consequences — a failed liveness check restarts the process, a failed readiness check just pulls it out of rotation.
- **Shallow vs. deep checks** — A shallow check confirms the process can respond at all; a deep check also pings its own dependencies. Deep checks catch more, but can themselves cascade if every instance hammers the same downstream at once.
- **Evaluate on a timer, serve the stored verdict** — Decouple evaluating health from answering about it: a background task re-checks the dependencies on its own interval and caches the verdict, and the route hands back whatever the last evaluation decided. Downstream load is then set by that interval alone, however many instances are probed and however often — which is the remedy for the cascade a deep check invites. You pay for it in staleness: an instance can keep reporting healthy for up to one interval after it stops being healthy, so the refresh period becomes a floor under how fast anything can be detected.
- **Startup probe / grace period** — A separate, more lenient check during boot so a slow-starting instance isn't killed by liveness before it has finished warming up.
- **Aggregated dependency health** — The response body lists each dependency's status individually, so on-call engineers get a diagnosis, not just a single pass/fail bit.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Gives orchestrators and load balancers a real signal** instead of guessing from an open socket.
- **Cheap and fast enough to poll** every few seconds without meaningful load.
- **Separating liveness from readiness** lets each control loop react the right way — restart vs. reroute.
- **Doubles as an operational tool** — curl it during an incident and see what the orchestrator sees.

### Cons
<!--meta polarity=con-->

- **A deep check that pings every dependency** can itself become a [cascading failure](../../../hazards/cascading-failure.md) under load.
- **False positives**: the process responds fine while a critical path it doesn't check is silently broken.
- **False negatives**: one blip on a nonessential dependency trips readiness and yanks a healthy instance out.
- **Another endpoint to secure** — unauthenticated deep checks can leak internal topology to anyone who asks.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Something external** — a load balancer, orchestrator, or deploy pipeline — needs to know if an instance can take traffic.
- **You run behind a container platform** that expects liveness and readiness probes to manage restarts and rollout.
- **On-call engineers need one fast, standard place** to check an instance's status during an incident.

### Avoid when
<!--meta polarity=avoid-->

- **There's no independent lifecycle to probe** — a short-lived batch job has nothing to route around.
- **The check itself calls flaky dependencies** with no timeout — that turns the health check into another failure point, and it needs a [Circuit Breaker](./circuit-breaker.md) or timeout of its own.
- **Only one instance exists behind nothing** — there's no load balancer or orchestrator to act on the signal yet.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — separate liveness and readiness routes"
let ready = false;
export function markReady() { ready = true; } // called once boot finishes

// Liveness: is the process itself still functioning?
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Readiness: should it currently receive traffic?
app.get("/readyz", async (_req, res) => {
  if (!ready) {
    return res.status(503).json({ status: "starting" });
  }
  try {
    await withTimeout(db.ping(), 500); // bounded — never hang the check
    res.status(200).json({ status: "ok", db: "up" });
  } catch {
    res.status(503).json({ status: "degraded", db: "down" });
  }
});
```

## In the wild
<!--meta block=wild-->

- **Kubernetes** — Liveness, readiness, and startup probes (httpGet, tcpSocket, exec, or grpc) drive different actions — a failed liveness restarts the container, a failed readiness pulls it from the Service endpoints — each tuned by periodSeconds, timeoutSeconds, and failure/success thresholds. {#wild-kubernetes}
- **Spring Boot Actuator** — Exposes /actuator/health, aggregating per-dependency HealthIndicator beans into one status, with separate liveness and readiness groups that map onto Kubernetes probes and a show-details toggle for the breakdown. {#wild-spring-boot-actuator}
- **AWS Elastic Load Balancing** — Target groups poll a configured health-check path on an interval and, after a set number of consecutive failures, mark the target unhealthy and stop routing to it — restoring it once it passes the healthy threshold again. {#wild-aws-elb}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Probe period** — How often the endpoint is polled (periodSeconds) — frequent enough to react, sparse enough not to load the service.
- **Failure and success thresholds** — Consecutive failures before an instance is acted on and successes before it is restored (failureThreshold, successThreshold) — the anti-flap dials.
- **Probe timeout** — A hard bound on the check itself (timeoutSeconds) so a slow dependency can never make the health check hang.
- **Startup grace** — An initial delay or dedicated startup probe (initialDelaySeconds, startupProbe) so a slow-booting instance is not killed before it has warmed up.
- **Check depth** — Shallow (the process can respond at all) versus deep (it also pings its own dependencies) — depth catches more but risks cascading.

### Signals to watch
<!--meta polarity=signal-->

- **Probe failure rate** — Fraction of health checks failing per instance — the raw signal the orchestrator and load balancer act on.
- **Health check latency** — How long the endpoint takes to answer; a deep check that is slowing is a leading indicator of dependency trouble.
- **Restart / eviction churn** — Restarts driven by liveness failures and instances pulled from rotation by readiness — spikes reveal misconfigured thresholds.

### Failure modes under load
<!--meta polarity=failure-->

- **Deep-check cascade** — A check that pings a shared downstream, run by every instance at once, amplifies load and can fail the whole fleet together.
- **Liveness restart storm** — Liveness set to fail on a transient dependency blip restarts healthy processes instead of just rerouting — the job readiness should have done.
- **Unbounded check hangs** — A dependency call in the endpoint with no timeout makes the probe itself hang, turning the health check into another failure point.
- **Correlated readiness flip** — Readiness tied to a non-critical shared dependency flips the entire fleet out of rotation on one blip, removing all capacity at once.

### Readiness checklist
<!--meta polarity=check-->

- Separate liveness from readiness so a dependency hiccup reroutes rather than restarts.
- Bound every dependency call inside the endpoint with its own timeout.
- Set thresholds and period so a single blip does not yank an instance out.
- Give slow-starting instances a startup probe or initial delay.
- Keep readiness off non-critical dependencies that could evict the whole fleet at once.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Twelve-Factor](../../../themes/twelve-factor.md) — Readiness as a signal, not an inference {#fluency-twelve-factor}
- [Observability](../../../themes/observability.md) — Report liveness and readiness {#fluency-observability}
- [Resilience](../../../themes/resilience.md) — Route around unhealthy instances {#fluency-resilience}
- [Microservices Design](../../../themes/microservices-design.md) — Tell the platform which instances can take traffic {#fluency-microservices-design}
- [Continuous Delivery](../../../themes/continuous-delivery.md) — Gate each rollout step on real readiness {#fluency-continuous-delivery}
- [Workload Composition](../../../themes/workload-composition.md) — Every piece answers for itself {#fluency-workload-composition}
- [Global Traffic & Ingress](../../../themes/global-traffic-and-ingress.md) — Tell the router which regions can still serve {#fluency-global-traffic-and-ingress}
- [Health Modeling](../../../themes/health-modeling.md) — Publish the rolled-up verdict where a router reads it {#fluency-health-modeling}
- [Operating a Live System](../../../themes/operating-a-live-system.md) — Drain a region deliberately, without touching the router {#fluency-operating-a-live-system}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Circuit Breaker](./circuit-breaker.md) — Health signals inform breaker state
- [Autoscaling](../routing/autoscaling.md) — Scale on health and load signals
- [Design for Self-Healing](../../../principles/self-healing.md) — A health signal is what lets a platform restart or reroute without a human
- [Analyse Failure Modes](../../../principles/failure-mode-analysis.md) — The analysis decides what a health signal has to cover
- [Design for Operations](../../../principles/design-for-operations.md) — The endpoint answers the operator's first question without a code read
- [Deployment Stamp](../routing/deployment-stamp.md) — One aggregate endpoint can report the health of an entire stamp
- [Canary Release](../routing/canary-release.md) — Health reporting keeps a bad candidate from serving while it is measured
- [Fault Injection](./fault-injection.md) — A deliberate fault is what proves the probe reports dependency health rather than liveness
- [Distributed Tracing](./distributed-tracing.md) — It answers liveness; tracing answers where the time went, and an incident usually needs both
- [Container Orchestration](../coordination/container-orchestration.md) — Something has to act on the verdict; the reconciliation loop is what restarts or removes the instance.
- [Failover](../coordination/failover.md) — A failing health check can be the signal that triggers promotion of a standby.

**Enables**

- [Load Balancer](../routing/load-balancer.md) — Load balancers route only to healthy instances
- [Compute](../../../capabilities/compute.md) — Managed compute needs a probe to act on; without one it cannot tell hung from healthy.
- [Service Discovery](../routing/service-discovery.md) — What a registry consumes to decide which instances stay in rotation
- [Observability Platform](../../../capabilities/observability-platform.md) — What a synthetic check or an orchestrator polls, and the platform assumes you expose one

**Often confused with**

- [Heartbeat](../coordination/heartbeat.md) — A health endpoint is polled and tests readiness, where a heartbeat is pushed and shows only liveness.

**Exposed to**

- [Cascading Failure](../../../hazards/cascading-failure.md) — Can fall into cascading failure when evicting a node for failing a health check shifts its load onto the rest

**Demonstrated by**

- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — readiness as an input to a scaler that moves on queue age rather than load

**Implemented by**

- [Observability Platform](../../../capabilities/observability-platform.md) — Synthetic checks are the monitor half: they call the endpoint on a schedule and alert on failure.

<!-- relationships:end -->
