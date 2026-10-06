---
title: External Configuration Store
description: "Settings live in a central store, not in the deployment package"
area: distributed-coordination
owner: Oleksandr Derechei
tags: [operations, maintainability, decoupling, cloud]
status: stable
aliases: [config store, centralized configuration]
solves: [changing one setting means redeploying the whole application, instances are running different settings after a rolling update, the same connection string is copy-pasted into six applications, we cannot tell who changed a setting or roll it back]
---

# External Configuration Store

Moves settings out of the deployment package into a central store behind a typed interface, so a change is an edit rather than a release, every instance reads the same value, and several applications can share one definition.

## What it is
<!--meta block=description-->

Settings shipped inside the deployment package need a release for every change, get copied across applications and drift during rolling updates. An external configuration store moves them to one central place that applications read through an interface with access control and versions, then cache in memory. Ship a last-known-good file for startup, and keep secrets out.

## Explained
<!--meta block=explain-->

An external configuration store keeps your settings in one central place that applications read at startup and on refresh, instead of inside each deployment package. Changing a value then needs no release, every copy of a service converges on the same value, and a shared setting such as a queue address has one definition. Choose it over config files in the package when several services share settings or when values must change at runtime, such as feature flags. For one application whose settings change only at release time, it is added complexity. Keep secrets in a secret manager, and store only a reference to them here.

- **Stale cache.** Reads are remote, so applications cache them. Add a change notification or expiry so values refetch.
- **Boot dependency.** A cache does not help if the store is down at start. Ship a last-known-good file and fall back to it.
- **Shared blast radius.** One bad value reaches every service. Stage changes like code and keep revision history for rollback.

**Example.** A service runs 40 copies and each re-reads its settings every 60 s. You change max-items from 50 to 20, and within 60 s all 40 copies use 20, with no release. At 03:00 the store goes down, and the running copies keep their cached values. A crash loop then restarts all 40. Without a fallback file, none of the 40 can boot. With a last-known-good file shipped in the package, all 40 start with the values from the last deploy, missing every runtime change made since that deploy. That lag is what the fallback costs.

## How it works
<!--meta block=structure-->

```mermaid caption="What reads what, and where does the fallback come from? Applications never touch the store directly — everything crosses the interface at step 1, which is what makes typing, authorisation and caching one concern instead of a habit each application reimplements."
flowchart LR
    A1["App instance"]
    A2["App instance"]
    IF["Configuration interface"]
    LC[("Local cache")]
    ST[("Central store")]
    SEC[("Secret manager")]
    FB["Last-known-good file"]
    A1 -->|"1 read a typed setting"| IF
    A2 -->|"1 read a typed setting"| IF
    IF -->|"2 hit"| LC
    IF -->|"3 miss or refresh"| ST
    ST -->|"4 a reference, never the value"| SEC
    FB -->|"5 startup only, store unreachable"| IF
```

```mermaid caption="A shared setting has a shared blast radius, so treat a change like a deployment. Revision history and rollback are what turn a bad edit into a rollback to the previous revision instead of an incident across every application reading that key."
sequenceDiagram
    autonumber
    participant O as Operator
    participant S as Config store
    participant A as App instance
    participant C as In-memory cache
    A->>S: read all settings at startup
    S-->>C: populate
    O->>S: change a shared timeout
    alt change notification wired up
        S-->>A: setting changed
        A->>S: refetch
        A->>C: replace
    else no notification, expiry only
        Note over A,C: instance keeps the old value until the cache expires
    end
    O->>S: bad value published
    O->>S: roll back to the previous revision
```

## Variations
<!--meta block=variations-->

- **Managed configuration service** — A purpose-built service with namespaced keys, labelled variants per environment, content types telling the client how to interpret a value, revision history and point-in-time recovery. The default answer, because the operationally hard parts — versioning, rollback, audit — arrive already built.
- **Immutable snapshots** — A named, frozen set of key-values that a running application can be pointed at without a code change or a redeployment. It converts configuration into something you can roll forward and back as a unit, which is the difference between changing settings and changing one setting at a time and hoping.
- **Custom backing store** — A key-value table or an object store, wrapped in your own interface. Workable, and you now own the version token for change detection, the notification mechanism, and a [Cache-Aside](../../caching/cache-aside.md) layer — an object store's entity tag changes on every write and makes a serviceable version token.
- **Cluster-native projection** — A provider that renders the central store into the orchestrator's own configuration and secret objects, so containers consume settings the way they already do and need no client library. The application stays ignorant of the store entirely, which is the cleanest form when everything runs on one platform.
- **Geo-replicated store** — Replicas in several regions with per-replica endpoints, so applications read from the nearest and switch endpoints during a regional outage. Worth it once the store is on the startup path of something that must not have a regional dependency.
- **[Feature Flag](../routing/feature-flag.md) hosting** — The most common resident of these stores, and the reason many teams adopt one. Flags need exactly what the pattern provides — runtime change, shared visibility across instances, and an audited history of who turned what on.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Changing a setting stops requiring a release** for applications that reread it, which removes the release's downtime and administrative cost.
- **Instances converge on one value** instead of drifting apart during a rolling update, after at most one refresh interval; until then they may disagree.
- **Shared settings get one definition**. A queue endpoint changes once rather than in six repositories that will not all be found.
- **Access becomes auditable and revertible** — you can see who changed what, and roll back to the previous revision.
- **It gives feature flags** and progressive rollout somewhere to live, which makes safe deployment practices possible rather than aspirational.

### Cons
<!--meta polarity=con-->

- **Store outage can stop startup** — the store lands on the startup path of every application. A cache covers a runtime blip and nothing else, so without a shipped last-known-good file a store outage becomes a fleet that cannot boot.
- **Cached values go stale silently**. Without change notification or an expiry policy, an edit reaches nobody and the store quietly stops being the source of truth.
- **A shared setting has a shared blast radius**. An administrator tuning one value for one application can break every other application reading that key, which is why changes need staging like code does.
- **Permissions have to be split and enforced**. Read and write need separating, and the backing store itself must be closed to anyone bypassing the interface — including the local fallback copy, which needs the same audit treatment.
- **Schema must be extensible** — typed values, collections and several versions must be designed in from day one. Retrofitting structure onto a flat key-value store in use is painful.
- **Edge cases must be specified** — missing keys, malformed values, key case sensitivity, nulls and empty strings each need a decided answer before launch, rather than being discovered in production.
- **For a single application** with settings that change at release cadence, it is pure added operational complexity.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several applications or instances must share settings**, or a standard configuration has to be enforced across them.
- **Settings need to change at runtime** — feature flags, rollout percentages, tuning values — without a deployment.
- **The built-in configuration system cannot** hold the types you need, such as complex structures or binary values.
- **You need an audit trail** and a rollback path for configuration changes, not just for code.

### Avoid when
<!--meta polarity=avoid-->

- **The configuration is simple**, local to one application, and changes only at normal release cadence.
- **You would be storing secrets in it**. Those belong in a secret manager the configuration store references.
- **Nothing can be made to reread the values**, since a central store nobody refetches from is a slower file with more failure modes.
- **There is no plan for the cold-start dependency**, because the first regional outage will make that decision for you.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a typed reader with refresh on change and a startup fallback"
type Settings = Record<string, string>
interface SettingsStore {
  version(): Promise<string>        // an entity tag or revision id
  fetchAll(): Promise<Settings>
}
export class Configuration {
  private cache: Settings = {}
  private version = ''
  constructor(
    private readonly store: SettingsStore,
    // Shipped with the deployment: covers a store that is down at process start.
    private readonly fallback: Settings,
  ) {}
  async start(): Promise<void> {
    await this.refresh().catch(() => { this.cache = this.fallback /* emit fallback-activation metric here */ })
    setInterval(
      () => void this.refresh().catch(() => { /* emit fetch-failure metric and record lastSuccess here */ }),
      30_000,
    )
  }
  private async refresh(): Promise<void> {
    // Version first: an unchanged store costs one cheap call, not every key.
    const version = await this.store.version()
    if (version === this.version) return
    this.cache = await this.store.fetchAll()
    this.version = version
  }
  // A missing key gets a decided answer, not an undefined in the caller.
  getNumber(key: string, fallback: number): number {
    const n = Number(this.cache[key])
    return Number.isFinite(n) ? n : fallback
  }
}
```

## In the wild
<!--meta block=wild-->

- **Azure App Configuration** — A managed store for namespaced key-value pairs with labels for environment variants, revision history with point-in-time recovery, immutable snapshots, and Key Vault references so credentials stay in the secret manager and only a pointer lives in configuration. {#wild-app-configuration}
- **HashiCorp Consul** — Its key-value store is widely used for shared configuration, with blocking queries that let a client long-poll a key and be woken when it changes — which is the change-notification half most homegrown stores forget. {#wild-consul}
- **etcd** — The configuration store behind Kubernetes: a watch API streams changes on a key or prefix, and every key carries a revision, so clients can refresh on change rather than on a timer. {#wild-etcd}
- **Spring Cloud Config** — Serves configuration to applications from a backing Git repository, which makes the version history, review and rollback of settings the same workflow as for code. {#wild-spring-cloud-config}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Cache refresh interval** — How long an instance may serve a superseded value. Shorter costs requests to the store; longer widens the window where instances disagree. The sketch polls every 30 s and the example 60 s; pick the longest staleness a flag flip or rollback can tolerate, and check the store's request quota against fleet size divided by interval.
- **Startup fallback path** — The last-known-good file the deployment ships, read when the store is unreachable at boot. Regenerate it from the store at build time, so its age is the gap since the last deploy.
- **Sentinel key for change detection** — Poll one version key rather than every setting, so an unchanged store costs one cheap call per tick.
- **Read and write role separation** — Distinct identities for reading settings and for changing them, enforced at the store rather than by convention.

### Signals to watch
<!--meta polarity=signal-->

- **Configuration fetch failure rate** — Rising failures mean instances are drifting onto cached or fallback values without saying so.
- **Time since last successful refresh, per instance** — The number that reveals a fleet quietly running on a stale cache.
- **Startup fallback activations** — Any non-zero value means an instance booted without reaching the store — worth an alert, not a log line.
- **Configuration change events by key and actor** — The audit signal, and the first thing you want when behaviour changed and no code shipped.

### Failure modes under load
<!--meta polarity=failure-->

- **Cold-start dependency during an incident** — The store is unreachable exactly when you are restarting the fleet, and without a shipped fallback nothing boots.
- **Silent staleness** — No change notification and no expiry means an edit reaches nobody, and the store stops being the source of truth without any error.
- **One edit, many broken applications** — A shared key changed for one consumer changes behaviour for every other reader of it.
- **Secrets creeping in** — A connection string added as a convenience turns a configuration store into an unaudited credential store.

### Readiness checklist
<!--meta polarity=check-->

- A last-known-good file ships with the deployment and is proven to work with the store blocked.
- Cached values refresh on change or on a bounded expiry, and that path is tested.
- Secrets live in a secret manager; the store holds only references.
- Read and write permissions are separate, and direct backing-store access is closed.
- Configuration changes are staged and revertible, like code.
- Reads and writes are audited, including against the local fallback copy.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Twelve-Factor](../../../themes/twelve-factor.md) — Configuration outside the build, not inside it {#fluency-twelve-factor}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Cache-Aside](../../caching/cache-aside.md) — Settings are cached in memory at startup, which is what makes reads cheap and staleness possible
- [Blue-Green Deployment](../routing/blue-green-deployment.md) — Snapshots and revision history let a bad setting roll back like a bad release
- [Secure Session Manager](../../security/secure-session-manager.md) — Settings live here; credentials and keys live in a secret manager the store only references
- [Microservices](../../architecture/microservices.md) — Many deployables multiply the places a setting can drift, which is what earns the store its own dependency
- [Convention over Configuration](../../../principles/convention-over-configuration.md) — An external store holds the settings a convention cannot supply

**Enables**

- [Feature Flag](../routing/feature-flag.md) — Flags need exactly this: runtime change, one value across instances, an audited history

**Exposed to**

- [Lava Flow](../../../hazards/lava-flow.md) — Can fall into lava flow when stale keys and flags accumulate that no one dares remove

**Demonstrated by**

- [Persona Identification & Sanction Check](../../../designs/persona-identification.md) — the list roster, each list's criticality, the recheck cadences, vendor quotas and fallback weights move without a deploy — and a worker that cannot reach the store boots from its last cached version rather than from defaults
- [Persona Identification & Sanction Check (V2)](../../../designs/persona-identification-v2.md) — configuration that decides what an unreachable check costs, which is why compiled-in defaults would screen the wrong lists and look successful doing it

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Every cloud sells a managed configuration store; you still decide how your service reloads a changed value.

<!-- relationships:end -->
