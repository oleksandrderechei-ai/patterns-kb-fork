---
title: Quarantine
description: Holds an external artifact in isolation until checks mark it trusted
area: security
owner: Oleksandr Derechei
tags: [security, validation, boundaries]
status: stable
aliases: [artifact quarantine, trusted artifact store]
solves: [a public container image went straight into our build with nobody checking it, we pull third-party packages and nothing verifies them before they ship, a vendor image turned out to carry a known vulnerability after we deployed it, "every team scans dependencies differently, or not at all"]
---

# Quarantine

Puts every externally-sourced artifact into an isolated holding store, runs an agreed set of checks against it there, and publishes it to the trusted store only once it passes — so nothing enters the build that has not been looked at.

## What it is
<!--meta block=description-->

Your build pulls base images, packages, infrastructure modules and vendor installers across your trust boundary, and usually nothing inspects them. Quarantine gives an artifact two states: it arrives untrusted in an isolated store no production system reads, an agreed set of checks runs on that copy, and a pass republishes it to the trusted store with an annotation while a failure deletes it. The process never modifies the artifact, and the consumer invokes it.

## Explained
<!--meta block=explain-->

Quarantine is a holding area for outside artifacts, such as base images, packages and infrastructure modules. Each one lands first in an isolated store that nothing in production can read, gets the same agreed checks (vulnerability scan, malware scan, signature, and a review of the list of parts inside it), and is copied to the trusted store only if it passes, otherwise destroyed. What you ship is exactly the bytes you inspected. Choose it over scanning in each team's pipeline when many teams pull from public sources, because a single gate makes the rules the same for everyone and leaves one audit trail.

- **Perishable verdict.** A pass is true only for the day given; stamp the report with an expiry and keep scanning the trusted store.
- **Store separation.** Two stores that share access are one store; separate them by identity and network.
- **Latency.** Checks take minutes to hours; request ahead and notify on finish, or people switch the gate off.
- **Manual hand-offs.** A manual step gets skipped under deadline; automate every hand-off.

**Example.** On Monday a team requests python:3.12 as a base image. It lands in the untrusted store, and a 20-minute scan finds one critical vulnerability, so the image is rejected and destroyed, and no pipeline can pull it. A later request for a patched build passes and is published to the trusted store with a 30-day report. On day 40 a new vulnerability is published for that image. The day-0 pass says nothing about it, so the expired report forces a rescan and the continuous scanner flags it. The cost is the 20 minutes of waiting, which is why teams request images the day before.

## How it works
<!--meta block=structure-->

```mermaid caption="How does an artifact cross from untrusted to trusted? The boundary is the subgraph: nothing in production can read the quarantine store, so the only route out of it is step 5, and a failed check leaves the artifact where it cannot be reached."
flowchart LR
    REQ["Consumer request — use blocked"]
    EXT[("Public source")]:::ext
    ORCH["Validation orchestrator"]
    subgraph UZ["Untrusted zone"]
        QS[("Quarantine store")]
        CHK["Scanners"]
    end
    TS[("Trusted store")]
    AUD[("Audit trail")]
    REQ -->|"1 signal intent, name the source"| ORCH
    EXT -->|"2 import a local copy"| QS
    ORCH -->|"3 run the agreed checks"| CHK
    CHK -->|"4 record the verdict"| AUD
    ORCH -->|"5 pass: publish, then delete the copy"| TS
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="The checks are independent and slow, which is why this is an asynchronous process rather than a pipeline stage. The gate is the publish decision at the end, so a pipeline that cannot wait must be blocked on the trusted store rather than on the scan."
sequenceDiagram
    autonumber
    participant T as Workload team
    participant O as Orchestrator
    participant Q as Quarantine store
    participant S as Scanners
    participant P as Trusted store
    T->>O: request image X from public registry
    O->>O: verify requester identity and destination
    O->>Q: import X
    par independent checks
        O->>S: vulnerability scan
    and
        O->>S: malware scan
    and
        O->>S: bill-of-materials and signature
    end
    S-->>O: results, minutes to hours later
    alt all checks pass
        O->>P: publish with an annotated, expiring report
        O->>Q: delete the local copy
    else any check fails
        O->>Q: delete — never published
    end
```

## Variations
<!--meta block=variations-->

- **Push model — the process decides** — The orchestrator evaluates the results itself, promotes on a pass and deletes on a failure. One policy, applied uniformly, and teams get a binary answer they cannot argue with — which is exactly right when every consumer shares a risk tolerance.
- **Pull model — the consumer decides** — The orchestrator publishes the findings through an API and holds the artifact in quarantine for a window; each team reads the report and pulls if it meets their own tolerance. The practical shape when one quarantine serves several teams whose appetites genuinely differ, at the cost that the trusted store no longer means one thing.
- **Central versus per-team** — A workload team can run its own quarantine, or a central function can standardise it across the organisation. Once there are several variations of the same process, centralising it is the cheaper answer — teams offload the process management and the checks stop drifting apart.
- **Outsourced validation** — Vendors sell public-artifact validation as a service, which trades a build-and-maintain cost for a subscription. Weigh both against the risk; keep it in-house where your security requirements need control over which checks run and what a failure means.
- **Per-artifact-type check sets** — Evaluating an operating-system image is not the same work as evaluating a language package or an infrastructure module, so each type gets its own agreed set of checks. The rule is that the set is fixed per type — a different set applied each time makes the verdict meaningless.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Supply-chain risk gets a single choke point**. One place decides what may enter, instead of every pipeline deciding by accident.
- **The trusted store becomes a real assertion**. Anything in it has been through a known set of checks, and the annotation says which.
- **The audit trail comes free**. Requester, source, checks run and verdict are recorded per artifact, which is most of what an audit asks for.
- **It costs nothing at build time**. The gate is a store the pipeline already reads from, so pulls stay as fast as they were.

### Cons
<!--meta polarity=con-->

- **It is a point-in-time verdict**, not a standing guarantee. A vulnerability published tomorrow is in an artifact that passed today, so expire the report and keep scanning continuously.
- **Segmentation is the part people skip**, and skipping it voids the pattern. Trusted and untrusted stores must be separate resources with identity and network controls, or the quarantine store is just another registry someone can pull from.
- **A bypassable gate is not a gate**. Invocation and signalling have to be automated, because any manual step is a step that gets skipped under deadline.
- **Validation takes real time** — minutes to hours — so anything that blocks a synchronous pipeline on it will be turned off within a week.
- **It needs an owner** and an agreed rule set. Without consensus on what "checked" means for each artifact type, the verdicts are inconsistent and nobody trusts them.
- **Vendor trust sits upstream** of all of it. A quarantine cannot fix a supplier with no responsible-disclosure process; it only tells you what today's scanners already know.
- **It is not free to build or run**, and where the risk of skipping verification is genuinely small, the process costs more than it saves.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The workload consumes artifacts** built outside it — public container images, public packages, third-party infrastructure modules, vendor images or installers.
- **Team knows the cost of compromise** — the team understands what a compromised artifact would cost and has decided that risk is worth mitigating.
- **Agreed meaning of validation** — there is agreement on what validation means for each artifact type, so the same checks run every time.
- **Several teams pull from the same public sources**, and one standard gate is cheaper than each of them improvising.

### Avoid when
<!--meta polarity=avoid-->

- **The artifact is produced** by your own team or a trusted partner whose pipeline you already govern.
- **The cost of building** and maintaining the process exceeds the risk it removes.
- **Nobody will own the check set**. An unowned quarantine decays into a registry with an extra hop.
- **You need it to catch novel attacks**. It applies known checks, so treat it as a floor and not as a substitute for continuous scanning.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — import to the untrusted store, run the checks, publish or destroy"
type ArtifactRef = { source: string; digest: string; type: 'oci' | 'package' | 'iac' | 'osimage' }
type CheckResult = { name: string; passed: boolean; critical: boolean; detail: string }
const REPORT_TTL_DAYS = 30
interface Store { import(ref: ArtifactRef): Promise<void>; publish(ref: ArtifactRef, report: unknown): Promise<void>; destroy(ref: ArtifactRef): Promise<void> }
interface Audit { record(ref: ArtifactRef, results: CheckResult[], verdict: string): Promise<void> }
// The check set is fixed per artifact type. Varying it per request is what
// makes a quarantine verdict meaningless.
const CHECKS: Record<ArtifactRef['type'], ((r: ArtifactRef) => Promise<CheckResult>)[]> = {
  oci: [scanVulnerabilities, scanMalware, verifySignature, evaluateBillOfMaterials],
  package: [scanVulnerabilities, evaluateBillOfMaterials, checkLicence],
  iac: [scanPolicy, verifySignature],
  osimage: [scanVulnerabilities, scanMalware, verifySignature],
}

async function quarantine(ref: ArtifactRef, untrusted: Store, trusted: Store, audit: Audit) {
  // Copy first: checks must run on the exact bytes that get published.
  await untrusted.import(ref)
  const results = await Promise.all(CHECKS[ref.type].map((check) => check(ref)))
  const blocking = results.filter((r) => !r.passed && r.critical)
  if (blocking.length > 0) {
    await audit.record(ref, results, 'rejected')
  } else {
    await audit.record(ref, results, 'trusted')
    await trusted.publish(ref, { results, expiresInDays: REPORT_TTL_DAYS })
  }
  // Destroy either way — an artifact reachable by accident is used by accident.
  await untrusted.destroy(ref)
}
```

## In the wild
<!--meta block=wild-->

- **Azure Container Registry** — The worked reference implementation uses two registry instances — one untrusted, holding the imported copy while validation runs, and one trusted that the workload pulls from — with policy restricting cluster image pulls to the trusted one. {#wild-acr-quarantine}
- **JFrog Artifactory** — Remote repositories proxy public package sources and can be gated so artifacts are scanned and policy-checked before promotion to a release repository, which is the same untrusted-to-trusted promotion with the stores as repository types. {#wild-artifactory}
- **Sigstore** — Provides the signing and verification half — `cosign` signs an artifact and records it in a public transparency log, so a consumer can verify provenance rather than trusting the registry it came from. {#wild-sigstore}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Check set per artifact type** — Fixed per type and agreed in advance. A set that varies per request makes the trusted label meaningless.
- **Report expiry** — How long a pass remains valid before the artifact must be revalidated.
- **Failure severity threshold** — Which findings block promotion and which are recorded and allowed through.
- **Quarantine retention window** — How long a pending artifact stays available in the pull model before it is deleted.

### Signals to watch
<!--meta polarity=signal-->

- **Time from request to trusted** — The number that decides whether teams use the process or route around it.
- **Rejection rate by source and artifact type** — Shows which upstream sources are actually costing you, and where an approved-vendor conversation is overdue.
- **Pulls from outside the trusted store** — Any non-zero value is a bypass, and a bypassable gate is not a gate.
- **Age of the oldest passing report** — Rising age means artifacts in production are trusted on evidence nobody has refreshed.

### Failure modes under load
<!--meta polarity=failure-->

- **The gate gets bypassed under deadline** — Any manual invocation step is the step that gets skipped, and nothing in the build says the artifact was never checked.
- **Segmentation is nominal** — When the quarantine store is reachable by the same identity as the trusted one, the isolation exists only on the diagram.
- **Slow checks block a synchronous pipeline** — Validation takes minutes to hours, so a pipeline gated on the scan rather than on the trusted store gets disabled within a week.
- **Stale trust** — An artifact that passed months ago carries a vulnerability published since, and nothing rechecks it.

### Readiness checklist
<!--meta polarity=check-->

- Trusted and untrusted stores are separate resources with separate access control.
- Consumption from anywhere but the trusted store is blocked by policy, not by convention.
- Invocation and signalling are automated end to end, with no manual step to skip.
- The check set per artifact type is written down and has an owner.
- Reports carry an expiry, and continuous scanning runs after promotion.
- Failed artifacts are deleted rather than left where someone can reach them.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Securing Availability](../../themes/securing-availability.md) — Keep an external artifact isolated until checks mark it trusted. {#fluency-securing-availability}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Intercepting Validator](./intercepting-validator.md) — Same instinct at a different boundary: check untrusted input before anything acts on it
- [Least Privilege](./least-privilege.md) — The trusted and untrusted stores are only separate if access to each is scoped
- [Canary Release](../distributed/routing/canary-release.md) — Verify the artifact before release, then expose it progressively once it ships

**Often confused with**

- [Gatekeeper](../distributed/routing/gatekeeper.md) — Gatekeeper validates a request at runtime; quarantine validates an artifact before you ever ship it

**Implemented by**

- [Storage](../../capabilities/storage.md) — Object malware scanning holds an upload apart until it is checked, then promotes or deletes it.

<!-- relationships:end -->
