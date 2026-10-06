---
title: Feature Flag
description: "Ship the code dark, then turn the behaviour on separately"
area: distributed-routing
owner: Oleksandr Derechei
tags: [operations, extensibility, lifecycle, availability]
status: stable
aliases: [feature toggle, kill switch, dark launch]
solves: [turning a broken feature off means waiting for another build, unfinished work sits on a branch for weeks and the merge is a nightmare, we cannot let a few customers try something without shipping it to everyone, product wants to launch on a date and engineering wants to ship when it is ready, an expensive optional feature is dragging the whole service down under load]
---

# Feature Flag

Compiles both the old and the new behaviour into the same build and picks between them at runtime from a value someone can change without a deployment — so shipping code and releasing a feature become two separate decisions, and turning something off takes seconds rather than a build.

## What it is
<!--meta block=description-->

A feature flag separates putting code on a machine from letting users see what it does. Both behaviours ship in one build, and a condition reads a value you can change at runtime. Flags do different jobs: release toggles hide unfinished work and should be deleted, kill switches live for years, experiment and entitlement toggles are product logic. Evaluation can be at startup, polled or per request. Every flag multiplies the paths you must test.

## Explained
<!--meta block=explain-->

A feature flag is a condition in your code that reads a value you can change while the system runs, so you can put code on a machine and decide separately who sees what it does. Without it, a half-finished feature lives on a long branch whose merge is a fight, a wrong feature can be withdrawn only by shipping again, and a failing dependency at midnight can be switched off only by someone who can run a build. Choose it when the unit of risk is a behaviour, not a build; for a whole release, a router switch or a canary is the better tool, and the two combine.

- **Flag combinations.** Every flag doubles code paths, so three make eight untested configurations; give each release flag an owner and a build-failing expiry.
- **Invisible changes.** A flip leaves no deployment record, so write flag changes into the same timeline as deploys.
- **Uneven reads.** A value read on a timer reaches instances at different moments, so one user can see both behaviours for one interval.

**Example.** The new checkout ships in the same build as the old, behind the flag new_checkout, off. At 11:00 you turn it on for 5% of 40,000 daily users, 2,000 people. At 11:20 errors rise, you turn it off, and every instance follows within its 30 s refresh. When the flag store is down, instances keep the last value they read. The cost is the flag itself: it carries an owner and an expiry two weeks after full rollout, and the old checkout code is deleted then, because three forgotten flags like it would leave eight untested configurations.

## How it works
<!--meta block=structure-->

```mermaid caption="Why is step 4 drawn at all? Because the request at step 5 reads from memory, not from the flag store. That is what keeps the store off the request path and keeps the service working when the store is unreachable — at the price of the flip at step 7 taking one poll interval to arrive."
flowchart LR
    Pipe["Pipeline"]
    Op["Operator"]
    Store[("Flag store")]
    App["Service — both paths in the build"]
    Cache[("Last value held in memory")]
    User["Client"]
    Pipe -->|"1 ship both paths, flag off"| App
    Op -->|"2 set the value"| Store
    App -->|"3 poll"| Store
    Store -->|"4 fill"| Cache
    User -->|"5 request"| App
    App -->|"6 read the flag, choose a path"| Cache
    Op -->|"7 flip it off under load"| Store
```

```mermaid caption="What happens when the flag store goes down? Nothing visible, as long as the service holds the last value it read. A service that fetches per request instead has just acquired a dependency that can take it offline."
sequenceDiagram
    autonumber
    participant O as Operator
    participant F as Flag store
    participant S as Service
    participant U as User
    S->>F: poll
    F-->>S: new_checkout = off
    U->>S: request
    S-->>U: old path
    O->>F: new_checkout = on for 5% of users
    S->>F: poll
    F-->>S: rule updated
    U->>S: request
    S-->>U: new path, if this user is in the 5%
    Note over S,F: store unreachable — the service keeps the last value it saw
```

Targeting is what turns a flag from a switch into a rollout mechanism. The stored value need not be a boolean: it can be a rule — this percentage of users, this plan, this region, this list of accounts — evaluated against attributes the service already has. A percentage rule evaluated against a stable hash of the user id gives you [Canary Release](./canary-release.md) at the feature level rather than at the deployment level, which is how you ramp one feature while everything around it stays put.

The two mechanisms are worth keeping distinct even though they overlap. A canary ramps a whole build behind the router and rolls back by moving traffic; a flag ramps one behaviour inside a build and rolls back by changing a value. Use the router when the risk is the release, and the flag when the risk is the feature. A team with both can deploy at will and release on a schedule, which is the arrangement continuous delivery actually describes.

## Variations
<!--meta block=variations-->

- **Release toggle** — Hides work in progress so unfinished code can be merged and deployed safely. It exists to let the branch die young, and it should be removed the week the feature is fully on — the only kind that is genuinely temporary.
- **Kill switch** — Disables an expensive, fragile or optional path so an operator can shed it under load or when a dependency degrades. It is long-lived on purpose, and it earns its keep by being the fastest response available during an incident.
- **Experiment toggle** — Splits users into groups to measure which behaviour performs better. The assignment has to be stable per user and recorded, because an experiment whose participants drift between arms measures nothing.
- **Entitlement toggle** — Encodes which customers may use which capability. It is product configuration rather than a release mechanism, it never goes away, and giving it its own store keeps it from being swept up by a script hunting stale release toggles.
- **Where the value is read** — Baked into configuration at startup, polled into memory on an interval, or fetched per request. The three differ in how fast a change takes effect and in what a flag-store outage costs: startup is free and needs a restart, polling costs one interval of delay, and per-request is instant and puts a remote call in the path of every request.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Turning a feature off** needs no build and takes effect within one refresh interval, seconds to a minute when polled, which is faster than any redeploy.
- **Unfinished work can be merged and deployed continuously**, so long-lived branches and their merge conflicts disappear.
- **Deploying and releasing become separate decisions**, so engineering and product stop having to agree on a date.
- **Targeting rules** let one feature ramp gradually while the rest of the build stays untouched.
- **Optional and expensive** work can be shed deliberately under load rather than failing at random.

### Cons
<!--meta polarity=con-->

- **Every flag doubles the paths through the code**, and combinations multiply: three flags are eight configurations, and a typical suite exercises only all-off and all-on.
- **Flags outlive their features**. Left in place they become permanent conditionals nobody dares remove (the [lava flow](../../../hazards/lava-flow.md) pattern) because nobody knows what depends on them.
- **The flag store becomes something** the system depends on, and how much depends on it is set by where the value is read.
- **A change with no deployment** leaves no deployment record, so the flip has to be audited deliberately or an incident timeline will not show it.
- **Polled values are eventually consistent across the fleet**, so for one poll interval some instances run the new path and some the old — visible whenever a user's two requests land on different instances.
- **Flags at the wrong altitude** leak into the domain: a conditional inside business logic that should have been a strategy or a policy object ends up encoding a release decision permanently.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need to disable something in seconds**, and a build takes minutes you will not have.
- **Work in progress** must be merged and deployed before it is ready to be seen.
- **A feature should reach some** users before all of them, independently of when the code ships.
- **An expensive or optional path** exists that you would want to shed deliberately during a spike.

### Avoid when
<!--meta polarity=avoid-->

- **The change is a straightforward** replacement with no need to run both paths — a flag adds a branch to delete later for nothing.
- **Nobody owns removing it**, in which case you are choosing a permanent conditional rather than a temporary one.
- **The variation is genuinely a domain concept**, such as a pricing rule, which belongs in the model as a policy rather than behind a release switch.
- **Whole release, not one behaviour** — the router and a canary control a whole release; a flag controls one behaviour inside it.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — read from memory, default to the old path"
// The value is refreshed in the background, so the request path never waits on
// the flag store and an outage there costs nothing once a value has been read.
class Flags {
  private values = new Map<string, Rule>();
  private lastOkAt = 0;

  constructor(private store: FlagStore, intervalMs = 30_000) {
    setInterval(() => this.refresh(), intervalMs).unref();
  }

  private async refresh() {
    try {
      this.values = await this.store.fetchAll();
      this.lastOkAt = Date.now();
    } catch (err) {
      console.warn("flag refresh failed", err);
      // Keep the last known values. A flag store outage must not be an outage.
    }
  }

  staleness(): number { return Date.now() - this.lastOkAt; }  // export as a gauge

  enabled(flag: FlagDef, userId: string): boolean {
    const rule = this.values.get(flag.key);
    if (!rule) return flag.default;  // unknown means the declared default
    return hash32(`${flag.key}:${userId}`) % 100 < rule.percent;
  }
}

if (flags.enabled(NEW_CHECKOUT, user.id)) {
  return newCheckout(cart);
}
return legacyCheckout(cart);

```

```typescript summary="TypeScript — declaring a flag so it can be found and removed"
// Flag debt is what kills this pattern, and it is prevented at declaration
// rather than by a cleanup sprint. Kind and expiry are the fields that matter.
export const NEW_CHECKOUT = defineFlag({
  key: "new_checkout",
  kind: "release",           // release toggles are temporary; kill switches are not
  owner: "payments",
  expiresOn: "2026-12-01",   // a build after this date fails, rather than warns
  default: false,            // what every caller gets when the store is silent
});

// A kill switch is declared the same way and says so, which keeps the stale-flag
// report from nagging about a flag that is meant to live for years.
export const RECOMMENDATIONS = defineFlag({
  key: "recommendations",
  kind: "ops",
  owner: "discovery",
  default: true,
});

```

## In the wild
<!--meta block=wild-->

- **OpenFeature** — A Cloud Native Computing Foundation (CNCF) specification and set of SDKs that put a vendor-neutral evaluation API in front of whichever flag backend you use, so the branch points in the code do not have to be rewritten when the provider changes. {#wild-openfeature}
- **LaunchDarkly** — A hosted flag service whose SDKs stream rule updates into an in-process store, so evaluation happens locally against cached rules rather than as a network call on each request. {#wild-launchdarkly}
- **Unleash** — An open-source flag service built around activation strategies — gradual rollout, user lists, and similar rules — evaluated by the client SDK from a periodically fetched rule set. {#wild-unleash}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Refresh interval** — How often the service pulls the current rules into memory. It bounds how long a kill switch takes to reach the fleet (the interval plus fetch time), and how long two behaviours coexist after any change. Start from your kill-switch deadline minus fetch time.
- **Default value** — What every call site returns when the store has never answered. Default to the old behaviour and a flag-store failure is invisible; default to the new one and it becomes an uncontrolled release.
- **Evaluation location** — In-process against cached rules, or a call to the store per request. Local keeps the store off the request path; remote makes changes instant and adds a dependency that can take the service down.
- **Targeting rule** — Percentage, plan, region or account list, and the attribute the percentage hashes on. Hashing on the user id keeps a person on one side; hashing per request does not.
- **Expiry on release toggles** — The date after which the build fails rather than warns. A failing build is a strong forcing function, because warnings tend to be ignored; pair it with an owner and a removal ticket.

### Signals to watch
<!--meta polarity=signal-->

- **Evaluations per flag, split by variant** — Shows what the fleet is actually doing, and it is how you find a flag that everyone has forgotten: no evaluations at all, or one hundred percent on one side for months.
- **Age of the oldest release toggle** — The single number that tracks flag debt. Left unwatched it grows until nobody will touch a conditional because nobody knows what still depends on it.
- **Rule cache staleness** — Time since the last successful refresh, per instance. A stale instance will not honour a kill switch, and the fleet-wide maximum is the number that matters; alert when it exceeds two refresh intervals.
- **Flag changes on the incident timeline** — Flips leave no deployment record, so they have to be emitted deliberately. Without this, a review of a flag-caused incident finds no change at all around the time it started.

### Failure modes under load
<!--meta polarity=failure-->

- **The flag store is unreachable and defaults take over** — Every evaluation falls to the compiled-in default at once. Harmless when the default is the old path, and an unplanned release of everything otherwise.
- **A kill switch does not take effect** — Some instances have a stale cache, or the refresh loop died quietly while the service kept serving. The switch is flipped, the dashboard says so, and part of the fleet carries on.
- **An untested flag combination** — Two flags are each safe on their own and broken together. It appears only when both are on, which is usually a configuration nobody assembled deliberately or reproduced in a test.
- **Per-request evaluation becomes a bottleneck** — A remote call at every branch point adds latency to every request and gives the whole system a new hard dependency, which fails exactly when load is highest.
- **An abandoned flag turns into dead code** — The feature launched, the toggle stayed, and years later nobody can say whether the other branch still works. The removal is now a risky change rather than a trivial one.

### Readiness checklist
<!--meta polarity=check-->

- Every flag declares a kind, an owner and — for release toggles — an expiry that fails the build
- The default value is the old behaviour, so a flag-store outage cannot release anything
- Evaluation reads from memory, and the refresh loop reports its own failures rather than dying quietly
- Percentage rules hash on a stable user attribute wherever the change is visible to a user
- Flag changes are emitted into the same audit trail as deployments
- The removal ticket exists before the flag does, and shipping the feature closes it

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Continuous Validation](../../../themes/continuous-validation.md) — Validate one behaviour rather than a whole build {#fluency-continuous-validation}
- [Operating a Live System](../../../themes/operating-a-live-system.md) — The fastest lever an operator has in an incident {#fluency-operating-a-live-system}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Canary Release](./canary-release.md) — A percentage rule ramps one behaviour without a new deployment
- [Strangler Fig](../coordination/strangler-fig.md) — The flag is the switch that sends a slice to the replacement
- [Load Shedding](../resilience/load-shedding.md) — A kill switch sheds an expensive path deliberately, before the server has to
- [Rolling Deployment](./rolling-deployment.md) — Decouples enabling a feature from the roll that carries its code

**Alternative to**

- [Strategy](../../gof/behavioral/strategy.md) — A runtime switch between two paths, chosen by configuration rather than by type

**Requires**

- [External Configuration Store](../coordination/external-configuration-store.md) — Where flags live once more than one instance has to agree on them

**Exposed to**

- [Boat Anchor](../../../hazards/boat-anchor.md) — Can fall into boat anchor when flags nobody removes after rollout become permanent dead branches
- [Lava Flow](../../../hazards/lava-flow.md) — Flags nobody removes after rollout become permanent conditionals nobody dares touch, which is lava flow

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Clouds sell flag evaluation and rollout as a service; removing the flag from your code once it has served stays your job.

<!-- relationships:end -->
