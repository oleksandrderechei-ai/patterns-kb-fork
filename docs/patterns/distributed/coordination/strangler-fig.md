---
title: Strangler Fig
description: Replaces a legacy system one slice at a time
area: distributed-coordination
owner: Oleksandr Derechei
tags: [modularity, maintainability, boundaries]
status: stable
aliases: [strangler application, strangler pattern, Ship of Theseus pattern]
solves: [our rewrite has been going for two years and has not shipped anything yet, I cannot take the old system offline but I need to replace it, every attempt to modernize turns into a big-bang cutover nobody will approve, the business will not let us freeze features for a year while we rebuild, I want to move one piece at a time and roll back if it goes wrong]
---

# Strangler Fig

Replaces a legacy system one slice at a time — routing each capability through a facade to a new implementation until the old system has nothing left to do and can be switched off.

## What it is
<!--meta block=description-->

A big-bang rewrite freezes feature work for months and bets the business on one cutover. The strangler fig replaces a legacy system one capability at a time. A routing layer in front sends migrated capabilities to the new code and leaves the rest on legacy, which shrinks until you can switch it off. Each slice is checked in production and can be routed back.

## Explained
<!--meta block=explain-->

The strangler fig replaces a legacy system one capability at a time, named for the vine that grows around a tree until the tree is gone. A routing layer (a facade) in front intercepts every call, sends migrated capabilities to the new code, and leaves the rest on the legacy system, which shrinks until you can switch it off. Choose it over a full rewrite when the system is business-critical and one cutover would be unrecoverable: each slice is checked in production and can be rolled back by routing it back to legacy. For a small system a plain rewrite is faster than building the routing layer.

- **Router on every path.** The routing layer sits on every request, so it needs the same care as anything behind it.
- **Two systems, shared data.** Keeping data consistent is harder than moving code. Decide which store owns each piece before you move it.
- **Stalls halfway.** A migration with no end date leaves a two-headed system. Set a switch-off date and delete the seam.

**Example.** A shop has 40 endpoints on a legacy monolith. You put a router in front, still sending 100% to legacy. You rebuild search and route 5% of search traffic to it, then 50%. At 50% you find a ranking bug and route search back to legacy in minutes. You fix it and reach 100%. Search only reads, so rollback loses nothing; a slice that writes must mirror its writes back first. The new search index is fed from the legacy database with about 2 s of lag, which is the data cost. After 3 months only 4 of 40 endpoints have moved, so you set a date for the rest or you will run both for years.

## How it works
<!--meta block=structure-->

```mermaid caption="How do you replace a system you are not allowed to switch off? Every call enters through one seam at 1, and a capability is pointed at the new system at 2 only once it is trusted — so the legacy path at 3 shrinks release by release until it receives nothing at all."
flowchart LR
    C["Client"]:::ext
    subgraph Seam["One routing seam — the only way in"]
        F["Routing facade"]
    end
    N["New system"]
    L["Legacy system"]
    D[("Shared data store")]
    C -->|"1 request for a capability"| F
    F -->|"2 migrated slice"| N
    F -->|"3 everything not yet migrated"| L
    N -->|"4 read and write"| D
    L -->|"5 read and write"| D
    N -->|"6 result"| F
    F -->|"7 response"| C
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Branch by abstraction** — An in-process variant: put an interface in front of the code to be replaced and swap implementations behind it, migrating without a network hop or a separate deployable.
- **[API Gateway](../routing/api-gateway.md) routing** — An edge router dispatches each request to old or new backend by path or feature flag — the most common way to build the facade at the network boundary.
- **Database strangling** — Migrate the data layer slice by slice too, using dual writes or change-data-capture to keep old and new stores consistent during the transition.
- **[Anti-Corruption Layer](../../ddd/acl.md) facade** — The routing seam also translates models, so the new system is built against a clean domain and never coupled to the legacy schema.
- **Edge-first ordering** — Which slice to carve out first is its own decision: the cheap answer is the one with the fewest inbound dependencies. A notification module that everything calls but that calls nothing back can leave as a standalone service the day you extract it. Start at the core instead and the first slice drags half the system out with it. Ordering by dependency count gives early wins that prove the seam works before the hard extractions, at the cost of leaving the core, where the risk sits, for last.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The business keeps shipping** — no long feature freeze while a rewrite catches up.
- **Risk is spread across many** small cutovers instead of one irreversible big-bang release.
- **Each slice can be rolled** back independently by pointing the router back at legacy, provided writes made on the new path were also mirrored to legacy.
- **The legacy system remains** a working safety net until the new one has proven itself.

### Cons
<!--meta polarity=con-->

- **The routing facade becomes a new**, mission-critical piece of infrastructure to get right.
- **Running two systems**, often with two data stores, in parallel adds operational overhead, sometimes for years.
- **Keeping shared data consistent across** old and new is usually harder than the code migration itself.
- **A migration with no firm** end date can stall halfway, leaving a permanent two-headed system.
- **A real share of the effort** goes into the seam, the dual paths and the sync jobs, all written to be deleted, so the migration ends when that plumbing goes, not when legacy switches off.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The legacy system is business-critical** and can't be taken offline for a rewrite.
- **You want to de-risk** a large migration by shipping and validating small increments.
- **Different capabilities can be migrated and verified independently**, without one atomic cutover.

### Avoid when
<!--meta polarity=avoid-->

- **The system is small enough** that a straightforward rewrite is faster than building and running a routing seam.
- **There's no clean seam to route through** — a tangled monolith may need decomposition work before slices can be carved out at all.
- **The team can't commit to finishing the migration** — a stalled strangler just leaves two systems running forever.

Prevents the smell of a stalled or ever-growing rewrite calcifying into a [Big Ball of Mud](../../../hazards/big-ball-of-mud.md) — routing incrementally keeps the system shippable at every step instead of frozen mid-migration.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal routing facade"
type Handler = (req: Request) => Promise<Response>;

// Capability prefix -> share of traffic (0..1) sent to the new system.
const weights = new Map<string, number>([
  ["/api/users", 1],
  ["/api/orders", 0.05],
]);

class StranglerFacade {
  constructor(
    private readonly legacy: Handler,
    private readonly modern: Handler,
    private readonly timeoutMs = 500,
  ) {}

  async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const prefix = [...weights.keys()].find((p) => path.startsWith(p));
    if (!prefix || Math.random() >= weights.get(prefix)!) return this.legacy(req);
    const timeout = new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), this.timeoutMs));
    try {
      return await Promise.race([this.modern(req.clone()), timeout]);
    } catch {
      return this.legacy(req); // safe only while legacy holds current data
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **Martin Fowler, "StranglerFigApplication"** — The original article: Fowler borrows the strangler fig vine as the image for growing a new system around the edges of the old one and replacing it gradually instead of by a rewrite. {#wild-fowler-strangler}
- **Azure Architecture Center: Strangler Fig pattern** — Microsoft documents the pattern with a facade that routes each request to the legacy or the new system while functionality is migrated piece by piece. {#wild-azure-strangler}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Per-capability routing rule** — The map from route (or feature flag) to legacy-vs-new backend, and the percentage of traffic sent to the new path. A weighted rollout lets a slice ramp from canary to full before the legacy path is cut off.
- **Traffic mirroring / shadowing** — Whether requests are duplicated to the new backend without serving its response, so its output can be compared against legacy under real load before any user depends on it.
- **Data-sync mechanism and lag tolerance** — How old and new stores are kept consistent during the dual-run — dual writes or change-data-capture — and how much replication lag is acceptable before the new path is trusted for reads.
- **Facade timeout and legacy fallback** — How long the facade waits on the new backend before it fails or falls back to the legacy path, bounding the blast radius of a bad slice. Fallback is safe only while legacy still holds current data for that slice.

### Signals to watch
<!--meta polarity=signal-->

- **Fraction of traffic migrated** — Share of routes or request volume served by the new system. The concrete measure of migration progress against a system meant to shrink release by release.
- **New-vs-legacy error rate and latency** — Per-route comparison of the two backends. Divergence flags a slice that is not yet safe to cut over, especially when read from mirrored traffic.
- **Data divergence count** — Mismatches found reconciling old and new stores during the dual-run. Non-zero and growing means the sync mechanism is losing ground to write volume.
- **Facade latency overhead** — The added hop the routing facade imposes on every request — the tax the whole system pays for the seam, and a leading indicator if the facade is saturating.

### Failure modes under load
<!--meta polarity=failure-->

- **Facade becomes a single point of failure** — Every call now flows through the routing seam; if it saturates or crashes, both legacy and new paths go dark at once. It has to be as available as the systems behind it.
- **Data drift between stores** — Dual writes or CDC fall behind or lose an update, and old and new stores diverge; a request served by whichever backend gives a different answer than the other.
- **Stalled migration** — With no firm end date the migration halts halfway, leaving a two-headed system whose parallel running cost keeps accruing until it is finished or abandoned.
- **Irreversible slice cutover** — The new path writes data that was never mirrored back to legacy, so pointing the route back at the old system silently loses those writes — the rollback is no longer clean.

### Readiness checklist
<!--meta polarity=check-->

- The facade routes by capability and a single config change points a route back at legacy
- Each slice is validated in production via shadow or canary traffic before full cutover
- Consistency between old and new stores is reconciled and monitored throughout the dual-run
- A firm decommission date and owner exist, so the migration cannot stall into a permanent two-headed system
- The routing facade has its own high availability (HA) — it must not become a new single point of failure

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Service Boundaries](../../../themes/service-boundaries.md) — Move a boundary in production, one capability at a time {#fluency-service-boundaries}
- [Continuous Delivery](../../../themes/continuous-delivery.md) — Earn independent deployment one slice at a time {#fluency-continuous-delivery}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [API Gateway](../routing/api-gateway.md) — Route slices old-vs-new at the gateway
- [Anti-Corruption Layer](../../ddd/acl.md) — An anticorruption layer (ACL) shields new code from the legacy model
- [Micro-Frontends](../../frontend/micro-frontends.md) — Micro-frontends are a vehicle for strangling a legacy user interface (UI) incrementally
- [Golden Master](../../testing/golden-master.md) — Golden files prove a migrated capability still matches
- [Wire Tap](../../messaging/wire-tap.md) — Shadow the real flow into the replacement before routing users to it
- [Design for Evolution](../../../principles/design-for-evolution.md) — The fig is the route from the system you have to the one you want
- [Blue-Green Deployment](../routing/blue-green-deployment.md) — Each migrated slice can be cut over with a reversible switch
- [Feature Flag](../routing/feature-flag.md) — Each intercepted call can be routed by a flag rather than a deploy
- [Messaging Bridge](../../messaging/messaging-bridge.md) — The messaging half of an incremental migration, so both sides work during it
- [Microservices](../../architecture/microservices.md) — The replacement targets are services, each owning one capability.

**Requires**

- [Reverse Proxy](../routing/reverse-proxy.md) — A routing layer in front of the legacy system is what sends each migrated capability to the new code

**Often confused with**

- [Canary Release](../routing/canary-release.md) — Moves routes one by one from a legacy system to its replacement, until the old one can be removed

**Prevents**

- [Big Ball of Mud](../../../hazards/big-ball-of-mud.md) — Replace the mud incrementally instead of a rewrite
- [Boat Anchor](../../../hazards/boat-anchor.md) — Retire dead legacy slice by slice
- [Distributed Monolith](../../../hazards/distributed-monolith.md) — Splitting the core first is how a decomposition produces services that still ship together.

**Exposed to**

- [Lava Flow](../../../hazards/lava-flow.md) — Can fall into lava flow when the old system lingers unowned when the cutover is never finished

**Implemented by**

- [Networking](../../../capabilities/networking.md) — An API gateway is the facade: route each path to the legacy system or its replacement.

<!-- relationships:end -->
