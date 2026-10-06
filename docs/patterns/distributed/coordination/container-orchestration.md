---
title: Container Orchestration
description: Declare the cluster you want; a control loop keeps it that way
area: distributed-coordination
owner: Oleksandr Derechei
tags: [coordination, lifecycle, resource-management, availability]
status: stable
aliases: [container scheduling, cluster orchestrator]
solves: [a machine reboots overnight and the services that were on it never come back, deploying a new version means logging into each machine in turn and hoping I did not skip one, traffic doubled and somebody had to start more copies of the service by hand, "every instance gets a new address when it restarts, so callers keep talking to something that is gone", two teams put their services on the same machine and one of them ate all the memory]
---

# Container Orchestration

You declare how many instances of each service should run and how much each may consume; a control loop compares that declaration against what is actually running, and creates, restarts or removes containers until the two agree.

## What it is
<!--meta block=description-->

Placing, spreading and restarting a hundred containers across twenty machines by hand never finishes. With a container orchestrator, such as Kubernetes, you declare a target: three copies of this image, this much memory each. A control loop repeatedly compares that target with reality and acts on the gap, so a first deploy, a crash, a scale-up and a rollback are one code path.

## Explained
<!--meta block=explain-->

A container orchestrator lets you write down the cluster you want, such as three copies of the checkout service with 512 MB each, and a loop keeps reality equal to that. The loop compares the wanted state with the actual state over and over and acts on any gap, so a crashed machine, a scale-up and a rollback are the same act, and a missed event cannot leave the cluster wrong for long. Choose it over a deploy script when placing, replacing and rolling out copies across more than a handful of machines has become recurring human work. Below that size the orchestrator costs more to run than it saves.

- **Faithful to mistakes** The loop enforces a wrong declaration as fast as a right one; keep the declaration in version control and review every change.
- **Health checks steer** Keep the check that gates traffic apart from the one that triggers a restart, and tie neither to an outside service.
- **Resource requests** Wrong memory requests strand paid capacity or get processes evicted; measure them from real load.
- **Stateful services** Databases with stable identity need extra setup: grant them stable names and attached storage explicitly.

**Example.** You declare 3 copies of checkout, each with a readiness check every 5 s that fails after 2 misses and calls the payment database. A machine dies, and once this setup's 30 s failure timeout has passed, the loop starts a replacement, so you page nobody. Later the database slows to 10 s per answer. All 3 copies fail 2 checks in a row, so after 10 s the loop removes every one from traffic, though each was only waiting. Checkout is down for as long as the database stays slow. The fix is a readiness check that tests only the copy itself, and a separate, slower check that restarts it.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a written-down number become running processes? Step 2 is the only decision, and it comes out the same whether you asked for more or a machine died — which is why one loop covers deploy, scale and recovery."
flowchart LR
    Op["Operator"]
    subgraph CP["Control plane"]
        Store[("Desired + observed state")]
        Ctrl["Controller"]
        Sched["Scheduler"]
    end
    Agent["Node agent"]
    App["Service instance"]
    Op -->|"1 declare 3 replicas"| Store
    Ctrl -->|"2 compare desired to observed"| Store
    Ctrl -->|"3 one short, place it"| Sched
    Sched -->|"4 pick a node with room"| Agent
    Agent -->|"5 start container"| App
    Agent -->|"6 report what is running"| Store
```

Steps 2 and 6 are the loop. The controller never learns why the numbers differ, and the node agent never learns what the target is; each does one job on a timer, and the cluster converges because both keep running. Nothing in the picture holds an event queue, so an agent unreachable for a minute rejoins by reporting what it has, not by replaying what it missed.

Step 4 is bin-packing under constraints. The scheduler places each instance on a machine whose free capacity covers what the declaration **requested**, subject to whatever else the declaration insisted on: keep these three apart, keep this one near that one, only these machines are eligible. Placement is the moment your requests turn into money, because a request that overstates real usage reserves capacity nobody consumes.

The service abstraction hangs off step 6. Because the control plane knows which instances exist and which are ready, it can publish a stable name that resolves to the healthy set and spread requests across it, exactly as a [load balancer](../routing/load-balancer.md) does — so callers address the service and never the instance. That is what makes an instance disposable, and disposability is what lets the loop restart, move and replace instances without asking anyone.

```mermaid caption="A rolling update is the loop with a new target. Readiness gates every step, so a version that cannot serve stalls the rollout instead of completing it — and that branch is the one worth designing, because it is the branch that keeps you up."
sequenceDiagram
    autonumber
    participant Op as Operator
    participant St as State store
    participant Ct as Controller
    participant Nd as Node agent
    participant Ap as New instance
    Op->>St: set image = v2, replicas = 3
    Ct->>St: read desired vs observed
    Ct->>Nd: start one v2 instance
    Nd->>Ap: run container
    alt readiness check passes
        Ap-->>Nd: ready
        Nd-->>St: observed: one v2 ready
        Ct->>Nd: retire one v1 instance
        Note over Ct,Nd: repeat until no v1 remains
    else readiness check never passes
        Nd-->>St: observed: zero v2 ready
        Note over Ct,St: rollout stalls, v1 keeps serving
    end
    Note over Ct,Nd: node lost — observed drops, the same loop places a replacement
```

## Variations
<!--meta block=variations-->

- **Rolling update** — Raise new instances a few at a time and retire old ones only once the new are ready. It needs no spare cluster. It costs you a window in which both versions serve and any request may hit either, so the change has to be compatible in both directions.
- **[Blue-Green Deployment](../routing/blue-green-deployment.md) over two sets** — Run the full new version beside the full old one, prove it, then move the stable name across in one step. Rollback is moving the name back, which is the fastest recovery any of these strategies offers. You pay double capacity for that service while both sets exist.
- **[Canary Release](../routing/canary-release.md) by replica share** — Point a fraction of live traffic at the new version and widen only if the numbers hold. Splitting by replica count is free but coarse — with four replicas the finest slice is 25% — so a smaller share needs weighting at the proxy layer instead.
- **Pull-based reconciliation** — Keep the declaration in version control and run an agent inside the cluster that reconciles the cluster to the repository, rather than pushing changes in from a build job. Every change is then reviewed, attributable and revertible like code, and no build system needs cluster credentials. The cost is a second loop to understand: a change applied by hand is silently undone.
- **Run-to-completion workloads** — The same loop with a target of "run this once and finish" instead of "keep three alive": batch jobs, migrations, scheduled work. Reconciliation now means retrying a failure up to a bound and knowing when to stop, so the parameters that matter are the retry limit and the deadline rather than the replica count.
- **[Sidecar](../routing/sidecar.md) injection** — The control plane rewrites each declaration on the way in, adding a helper container beside every application container — a proxy, a log shipper, a credential agent. Teams get the capability without editing anything, which is also the hazard: a mutation nobody wrote is hard to debug, and the injected container's own limits are now part of your capacity arithmetic.
- **Custom resource with its own controller** — Extend the reconcile loop to a resource the platform has never heard of. Register a new declarative type — a database cluster, a certificate, a tenant — and run a controller that watches it and drives the real thing towards the declaration. The operational knowledge that used to live in a runbook becomes code the cluster runs continuously, so a failover or a version upgrade is a field edit rather than a procedure. The cost is that you now own a controller: its reconcile must be idempotent and safe to interrupt at any point, because it will be, and a buggy one converges on the wrong state just as tirelessly as a good one converges on the right one.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **An instance that dies** is replaced with nobody paged, in seconds for a crashed process and after the failure-detection timeout for a lost machine, because replacing it is the same act as creating it.
- **Callers reach a stable service** name rather than an address, so instances can move, restart and change in number without a caller changing.
- **Releases become an edit to the declaration**: roll forward, roll back, or run two versions side by side, through the mechanism you already use to deploy.
- **Instance count can follow load automatically**, which is where [Autoscaling](../routing/autoscaling.md) plugs in — it moves the declared number and the same loop does the rest.
- **Many services share machines under enforced limits**, so utilization rises and several teams deploy onto the same capacity without negotiating for it.
- **Per-service effort stays roughly flat** as instance count grows, because the work is in writing the declaration rather than carrying it out; platform operations and debugging still scale with fleet size.

### Cons
<!--meta polarity=con-->

- **The loop enforces a wrong** declaration as faithfully as a right one, and just as fast: a bad configuration reaches every machine in the time a good one would.
- **It is a large piece** of infrastructure with its own failure modes, upgrade cadence and staffing cost. Three services on two machines rarely repay it.
- **Health checks steer the loop**, so a wrong one makes the orchestrator the cause of the outage — restarting healthy instances, or leaving broken ones in rotation.
- **Resource requests wrong in either direction** cost real money or real reliability: too high strands capacity you paid for, too low gets processes evicted under pressure.
- **The declaration becomes a second source of truth**, and it drifts from what the team believes is running the first time somebody fixes production by hand.
- **Stateful services fight the model**, because an instance the loop may move at any moment is awkward when identity and attached storage matter.
- **Debugging crosses a new layer**: an application symptom now has a scheduling, networking or eviction explanation too, and telling them apart needs someone who knows the platform.
- **The control plane is a shared dependency**, and while it is down, running instances keep serving but nothing is rescheduled, scaled or rolled out.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You run many instances across** more than a handful of machines, and deciding where each one goes has quietly become someone's job.
- **You want a dead instance** replaced in seconds without a human deciding anything.
- **You deploy often enough** that rollout and rollback should be a change to a declaration rather than a runbook someone follows at 2am.
- **Your load varies enough** that instance count should track it instead of being sized for the peak all day.
- **Several teams deploy independently onto shared machines** and you need enforced resource limits between them.
- **You are running** [Microservices](../../architecture/microservices.md) and every service needs the same handful of operational capabilities — placement, health, rollout, a stable address.

### Avoid when
<!--meta polarity=avoid-->

- **You run one or two services** on a couple of machines. The control plane costs more to operate than the work it removes.
- **Nobody owns the platform**. An orchestrator no one upgrades or debugs adds failure modes without adding anyone who can read them.
- **Your workload is a single** long-lived process whose identity and local disk cannot move, and no amount of declaration makes it disposable.
- **The platform you deploy** to already runs containers this way without exposing the loop. You are using the pattern; implementing a second one underneath buys nothing.
- **Long-running business steps** — what you need is to sequence business steps that take hours and must be compensated on failure; that is [Saga](./saga.md) and workflow territory, and no scheduler will do it for you.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the reconciliation loop, minus the cluster"
type Desired = { service: string; replicas: number; image: string };
type Running = { id: string; service: string; image: string; ready: boolean };

// Simplification: unready instances are not counted, so a slow start is
// started again on every pass. A real controller counts starting instances
// and applies a surge limit and crash-loop backoff. Nothing here knows WHY
// the numbers differ, so there is one path and no event to miss.
function reconcile(want: Desired, have: Running[], engine: Engine): void {
  const ready = have.filter((i) => i.service === want.service && i.ready);
  const current = ready.filter((i) => i.image === want.image);
  const stale = ready.filter((i) => i.image !== want.image);

  // Add before removing, so capacity never dips below what was declared.
  if (current.length < want.replicas) return engine.start(want.service, want.image);
  if (stale.length > 0) return engine.stop(stale[0].id);
  if (current.length > want.replicas) engine.stop(current[0].id);
}

// One change per pass, forever. Convergence is the loop's job.
setInterval(() => reconcile(readDeclaration(), observeCluster(), engine), 5_000);
```

## In the wild
<!--meta block=wild-->

- **Kubernetes** — The reference implementation, and the reason the vocabulary is what it is. Controllers watch declared objects in the API server and act until observed matches desired; a scheduler places each new instance on a node with room for its requests. {#wild-kubernetes}
- **Nomad** — A single-binary scheduler driven by declarative job files. It orchestrates containers and plain executables under the same loop, which suits a fleet that has not containerized everything. {#wild-nomad}
- **Docker Swarm mode** — Built into the Docker engine: `docker service create --replicas 3` declares a count, and the manager nodes keep three tasks running across the swarm. {#wild-docker-swarm}
- **Argo CD** — Pull-based reconciliation on top of an orchestrator. An in-cluster controller compares the live cluster against manifests in a Git repository and converges the cluster to the repository, so no build job needs cluster credentials. {#wild-argo-cd}
- **K3s** — A certified Kubernetes distribution packaged as a single binary with a reduced footprint, aimed at edge and small-cluster deployments where the full control plane is more than the workload justifies. {#wild-k3s}
- **Rancher** — Manages many clusters rather than one: provisioning, access control and policy applied across a fleet, which is the problem that appears once orchestration itself is solved several times over. {#wild-rancher}
- **Flux** — Reconciles cluster state against a Git repository, so the desired state is a commit and drift is corrected by the same control loop the orchestrator already runs — the GitOps sibling of Argo CD. {#wild-flux}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Replica count** — The declared number of instances per service, and the first dial for both capacity and redundancy. At one replica, every restart, node drain and rollout step is an outage of that service.
- **Resource requests and limits** — The request is what the scheduler reserves when it places the container; the limit is what the runtime enforces once it runs. Requests too high strand capacity you paid for, and too low puts the instance on a machine that cannot feed it.
- **Readiness and liveness thresholds** — Readiness gates traffic, liveness triggers a restart. Their period, timeout and failure count decide how long a sick instance keeps serving and how quickly a merely slow one is killed for being slow.
- **Rolling update surge and unavailability** — How many instances may exist above the declared count during a rollout, and how many may be missing below it. Surge buys rollout speed with temporary capacity; unavailability buys the same speed out of your headroom.
- **Spread and placement constraints** — Rules that force instances of one service apart across machines, racks or zones, and rules that restrict a workload to eligible machines. Without them the scheduler is free to pack all three replicas onto one machine.
- **Disruption budget** — The minimum instances that must stay available while the platform does voluntary work such as draining a machine for an upgrade, so maintenance cannot take a service below its own floor.
- **Termination grace period** — How long a container has between the stop signal and being killed. Too short cuts in-flight requests; too long makes every rollout and every machine drain crawl.

### Signals to watch
<!--meta polarity=signal-->

- **Declared replicas against ready replicas** — Per service, the gap the loop is trying to close. It is the single number that says a rollout is stuck.
- **Container restart count** — Per instance. A restart loop is the liveness check and the application disagreeing about what healthy means.
- **Instances pending placement** — The scheduler telling you no machine has room for the requests you declared. It stays pending indefinitely rather than failing, so nothing alerts unless you watch it.
- **Node resource pressure and eviction events** — What requests set below real consumption look like from the outside: the machine runs out before the declaration says it should.
- **Rollout age** — How long a service has been part-old and part-new. A rollout that never finishes is the most common silent failure of this pattern.
- **Control-plane latency and error rate** — A slow state store or an overloaded control plane makes reconciliation lag, and from above that looks exactly like an application problem.

### Failure modes under load
<!--meta polarity=failure-->

- **Requests set below real usage** — The scheduler packs machines it believes have room, memory runs out, and the runtime kills whichever container is furthest over its request — usually not the one that caused the pressure.
- **Liveness check served by the request thread pool** — Under load the check times out, the platform restarts an instance that was healthy but busy, and its load moves to peers that are also busy. The restart wave then spreads on its own.
- **Readiness that passes before dependencies are reachable** — The rollout retires old instances against a new one that cannot serve, and the errors start at the moment the last old instance goes away.
- **All replicas on one machine** — Nothing asked for spread, so the scheduler packed them together. The declared count reads three, and one machine failure takes all three.
- **A rollout stalled half-finished** — Two versions serve indefinitely because nobody noticed the stall, and an incompatibility that was tolerable for ten minutes is now load-bearing for a week.
- **Control plane under-provisioned** — Reconciliation lag grows, replacement and scaling fall behind the load that caused them, and every dashboard blames the application instead.

### Readiness checklist
<!--meta polarity=check-->

- Every service declares resource requests measured from real load rather than guessed
- Readiness and liveness are separate checks with different meanings, and neither depends on a downstream service you do not control
- Replicas of the same service are spread across failure domains by an explicit rule, not by luck of scheduling
- Rollback has been rehearsed under time pressure, so somebody knows what to run without reading a wiki
- The declaration lives in version control, and a change made directly to the cluster can be detected
- Anything that must not lose all its instances at once during maintenance carries a disruption budget
- Someone owns the platform: upgrades are scheduled, and at least two people can read its failure modes

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Cloud Native](../../../themes/cloud-native.md) — Who decides where it runs and when it restarts {#fluency-cloud-native}
- [Continuous Delivery](../../../themes/continuous-delivery.md) — Roll out by changing declared state {#fluency-continuous-delivery}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Health Endpoint Monitoring](../resilience/health-endpoint.md) — The probe is the signal the control loop reads — a wrong one makes the orchestrator the cause of the outage.
- [Stateless Service](../routing/stateless-service.md) — Reconciliation assumes any instance can be destroyed and replaced, which only holds if it carries no per-client state.
- [Autoscaling](../routing/autoscaling.md) — Scaling is the same control loop with load as its input rather than instance health.
- [Sidecar](../routing/sidecar.md) — Co-scheduling the helper with the service, on one lifecycle, is what makes the sidecar shape practical.
- [Microservices](../../architecture/microservices.md) — The orchestrator earns its complexity at many services and many nodes, which is where this style puts you.
- [Compute Resource Consolidation](../routing/compute-resource-consolidation.md) — The scheduler is what places colocated workloads by their declared resource needs
- [Blue-Green Deployment](../routing/blue-green-deployment.md) — The stable name moves between two full sets; the orchestrator holds both and flips the name.
- [Canary Release](../routing/canary-release.md) — Replica share gives a coarse canary for free; finer slices need proxy weighting.

**Requires**

- [Containerization](./containerization.md) — Requires an immutable image to schedule — the orchestrator never builds one

**Often confused with**

- [Workflow Orchestration](./workflow-orchestration.md) — Same word, two jobs: this one reconciles infrastructure state, that one drives business steps through a long-running process.

**Prevents**

- [Noisy Neighbour](../../../hazards/noisy-neighbour.md) — Per-container central processing unit (CPU) and memory limits give the scheduler a stated share to enforce for each workload

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Managed Kubernetes is this control loop rented by the hour: you declare the desired state, the service reconciles it.

<!-- relationships:end -->
