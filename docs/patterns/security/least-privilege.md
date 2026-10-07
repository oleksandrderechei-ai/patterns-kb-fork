---
title: Least Privilege
description: "Every component gets the minimum access it needs, no more"
area: security
owner: Oleksandr Derechei
tags: [security, access-control, isolation]
status: stable
aliases: [PoLP, principle of least privilege, POLA]
solves: [one leaked API key gave an attacker everything we own, every service runs with the same admin credentials because that was the quickest way to ship, our CI job can deploy to production and also read every customer database, nobody can tell me why this role has these permissions or whether anyone still needs them, a compromised container reached services it had no business touching]
---

# Least Privilege

Every identity, service, and process is granted only the access its current task requires — nothing broader, nothing inherited, and nothing left standing once the task is done.

## What it is
<!--meta block=description-->

Least privilege is a lens, not a component: every identity, whether a person, a service account, a CI job or a single API call, holds only the permissions its current task needs, scoped narrowly and held briefly. It resolves ambient over-provisioning, where copying an admin policy is quicker than listing needed actions and permissions pile up. It does not stop a compromise; it bounds the blast radius, so a leaked read-one-bucket token is an incident, not a breach.

## Explained
<!--meta block=explain-->

Least privilege means every identity, whether a person, a service, a build job or a single call, gets only the permissions its current task needs, on the narrowest target, for the shortest time. It does not stop a component from being compromised. It limits what a compromised one can do. Choose it over a broad shared role when a leaked credential would otherwise reach everything, because copying an admin policy is quick and permissions then pile up and are never trimmed. Give credentials an expiry, so a leaked one stops working by itself.

- **Finding the minimum.** You learn it by trial; start with nothing and add what the access logs show was denied.
- **Creep.** Needs change, so review grants on a schedule or broad access returns.
- **Friction.** Very fine scoping pushes engineers to ask for broad grants; make narrow scopes easy to request.
- **Role sprawl.** Many roles must be tested and kept in sync; generate them from a short template.

**Example.** A build job uploads reports to one storage bucket, and its token leaks in a public build log. A broad admin token can read and delete all 120 buckets, including the backups. A token scoped to write on reports-bucket and expiring after 5 minutes can touch one bucket, and the attacker finds the log 10 minutes later, when the token is already dead. The cost: on its first run the narrow job fails because it also needs to list the bucket. You see the denied list action in the logs, add that one permission, and rerun.

## How it works
<!--meta block=structure-->

```mermaid caption="What does a stolen credential get an attacker? Only step 4 — the one bucket the task named — because step 5 was never granted and the grant issued at step 3 expires on its own."
flowchart LR
    Task["Job with one task to do"]
    Pol[("Policy: what this task needs")]
    subgraph Grant["One task, one narrow grant"]
        Br["Credential broker"]
        Cred["Scoped credential, short lifetime"]
    end
    R1["Reports bucket"]
    R2["User database"]
    Task -->|"1 ask for access for this task"| Br
    Pol -->|"2 the exact actions it needs"| Br
    Br -->|"3 issue read-only, expiring in minutes"| Cred
    Cred -->|"4 inside the scope: allowed"| R1
    Cred -->|"5 outside it: denied, and denied again once it expires"| R2
```

## Variations
<!--meta block=variations-->

- **[Authorization Enforcer (role-based access control, RBAC)](./authorization-enforcer.md)** — Collapse individual permissions into roles, then grant each role only what its job needs; a common way to enforce least privilege.
- **[Valet Key](../distributed/routing/valet-key.md)** — Issue a scoped, time-boxed credential for one operation instead of a long-lived, broad one — least privilege applied directly to the credential.
- **Just-in-time elevation** — Grant a higher privilege only for the duration of a specific task, then revoke it automatically — no standing admin access sitting around to be stolen.
- **Attribute-based access control (ABAC)** — Evaluate fine-grained conditions — resource owner, time of day, request origin — at the moment of the request, narrowing the grant to the exact context instead of a fixed role.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Shrinks the blast radius** of any single compromised credential, token, or component.
- **Limits lateral movement** even after an attacker gets an initial foothold.
- **Makes audits and compliance reviews tractable** — every grant maps to an explicit, statable need.
- **Forces access decisions** to be explicit instead of relying on ambient, inherited trust.

### Cons
<!--meta polarity=con-->

- **Requires ongoing upkeep** — needs shift as systems evolve, and privilege creep returns the moment reviews lapse.
- **Finding the true minimum access** for a task is hard and is often discovered by trial, error, and a broken deploy.
- **Very fine scoping adds friction**, and engineers start asking for broad, convenient grants.
- **Multiplies the number** of roles and policies that must be defined, tested, and kept in sync.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You're provisioning any identity** — human, service account, or CI job — that will hold credentials or a token.
- **A breach of one component must not cascade** into access over everything else.
- **Compliance or audit requires a clear**, defensible mapping between each grant and a real need.

### Avoid when
<!--meta polarity=avoid-->

- **One trusted operator needs audited**, time-boxed emergency access: keep a logged break-glass path outside normal scoping, since a broad but logged account beats a lockout mid-incident.
- **The system holds nothing sensitive** and scoping access would slow delivery without reducing any real risk.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a scoped, expiring credential"
interface Permission { resource: string; actions: string[] }

class ScopedCredential {
  private constructor(
    private readonly permissions: readonly Permission[],
    private readonly expiresAt: number,
  ) {}

  // Grant exactly the actions requested, nothing implied or inherited.
  static issue(actions: string[], resource: string, ttlMs = 5 * 60_000): ScopedCredential {
    return new ScopedCredential([{ resource, actions: [...actions] }], Date.now() + ttlMs);
  }

  can(action: string, resource: string): boolean {
    if (Date.now() > this.expiresAt) return false; // expired grants deny by default
    return this.permissions.some(
      (p) => p.resource === resource && p.actions.includes(action),
    );
  }
}

// A build job that only writes reports gets exactly that, nothing else.
const token = ScopedCredential.issue(["write"], "reports-bucket");
token.can("write", "reports-bucket");  // true
token.can("delete", "reports-bucket"); // false: never granted
token.can("write", "users-table");     // false: different resource
```

## In the wild
<!--meta block=wild-->

- **OpenBSD pledge** — A process calls pledge(2) to voluntarily restrict itself to a named set of promises (stdio, rpath, inet, ...); once pledged it cannot widen the set, and a call outside the set usually aborts the process with SIGABRT. Pledging the error promise instead makes most violating calls fail with ENOSYS, so the process can handle the refusal rather than die. Its companion unveil(2) does the same for filesystem paths. {#wild-openbsd-pledge}
- **Linux capabilities** — The monolithic power of root is split into discrete units (capabilities(7)); a process granted only CAP_NET_BIND_SERVICE can bind a port below 1024 without holding any other superuser power, so a daemon runs with a fraction of full privilege. {#wild-linux-capabilities}
- **AWS STS temporary credentials** — AssumeRole issues short-lived credentials with an explicit session duration (DurationSeconds, from 15 minutes up to 12 hours, so a shorter TTL such as the 5-minute token in the example needs another issuer) in place of long-lived access keys, and an inline session policy can further narrow the assumed role to only what the current task needs. {#wild-aws-sts}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Credential / session lifetime (time to live, TTL)** — How long a granted credential stays valid before it must be re-issued. Shorter shrinks the window a leaked token is useful; longer reduces re-issuance churn but leaves standing access lying around.
- **Grant scope granularity** — How narrowly each grant enumerates the exact resources and actions a task needs, versus a broad wildcard. Tighter scoping shrinks blast radius; too tight multiplies the policies to maintain and adds friction.
- **Just-in-time elevation window** — For privileges granted only for a specific task, how long the elevation is held before automatic revocation. It bounds how long standing admin access exists to be stolen.
- **Access-review / recertification cadence** — How often standing grants are re-examined and unused ones pruned. Privilege creep returns the moment reviews lapse, so the interval sets the ceiling on how stale the grant set can get.

### Signals to watch
<!--meta polarity=signal-->

- **Dormant / unused permissions** — Permissions granted but not exercised within a window (surfaced by last-accessed or access-advisor data). An unused grant adds blast radius with no benefit, so it is a removal candidate unless it is a deliberate break-glass or recovery path.
- **Count of long-lived standing credentials** — Inventory of non-expiring keys and broad roles still in circulation. A rising count is the measurable form of privilege sprawl.
- **Credential age / time since last rotation** — How old the oldest active credentials are. Long-lived secrets that never rotate are the ones whose compromise is both likely and maximally damaging.
- **Elevation / break-glass request rate** — How often identities need to step up to a higher privilege. A high rate signals baseline grants are too tight; a rate of zero on a sensitive system may mean elevation is being avoided via standing broad access.

### Failure modes under load
<!--meta polarity=failure-->

- **Privilege creep** — Grants accumulate as tasks change and are never trimmed back. The blast radius of any one compromised identity grows silently until an audit or an incident reveals how much it could actually do.
- **Over-scoping breaks a task at runtime** — The minimum was guessed too narrow, so a job hits a missing permission mid-run and fails. The denied action in the logs names the one permission to add; add that one, never a wildcard.
- **Leaked long-lived broad credential** — A single non-expiring key carrying an inherited org-wide role is compromised; because it was never scoped or time-boxed, a contained incident becomes a full breach with lateral movement.
- **Scoping friction defeats the control** — Granular policies are so tedious to author that teams copy an existing broad admin policy instead. The pattern is nominally in place but the actual grants are wide open.
- **Expiry mid-task or issuer outage** — Short TTLs make long jobs and the renewal path a dependency. A job that outlives its token fails, and an issuer outage looks like an auth outage. Set the TTL above the job's runtime.

### Readiness checklist
<!--meta polarity=check-->

- Default to deny: grant each identity explicit permissions mapped to a stated need, not an inherited broad role.
- Prefer short-lived, scoped credentials over long-lived broad keys wherever the workflow allows.
- Recertify standing grants on a schedule and prune permissions the usage data shows are dormant.
- Provide an audited, time-boxed break-glass path so least privilege never locks out incident response.
- Rotate long-lived secrets that cannot be made short-lived, and track their age.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Auth & Access](../../themes/auth-and-access.md) — Grant the minimum needed, no more {#fluency-auth-and-access}
- [Securing Availability](../../themes/securing-availability.md) — Bound how far any single compromise reaches {#fluency-securing-availability}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Authorization Enforcer (RBAC)](./authorization-enforcer.md) — Grant only what the role needs
- [Valet Key](../distributed/routing/valet-key.md) — Scoped, expiring access is least privilege
- [Identity Is the Perimeter](../../principles/identity-as-perimeter.md) — Privilege scoped per identity is what makes identity the real boundary
- [Identity & Access](../../capabilities/identity.md) — The cloud gives you the scoping tools; granting narrowly remains a choice.
- [Resource Organisation](../../capabilities/resources.md) — Scope starts with the resource hierarchy, before any role is written.
- [Quarantine](./quarantine.md) — What keeps a quarantine store from being just another registry people can pull from
- [Defense in Depth](../../principles/defense-in-depth.md) — Each component's narrow access is a layer that bounds a breach.

**Generalizes**

- [Agent Sandboxing](./agent-sandboxing.md) — The general rule this narrows: an agent gets the paths and hosts its task needs, and no more

**Demonstrated by**

- [LeetCode](../../designs/leetcode.md) — untrusted submitted code is granted only the minimum it needs to be graded and nothing more
- [Dropbox](../../designs/dropbox.md) — short-lived, single-object signed URLs are least privilege applied to a bearer token, limiting the blast radius of a leaked link
- [Amazon Locker](../../designs/amazon-locker.md) — access is bounded to a single compartment and expires after seven days rather than being an open-ended credential
- [Instagram](../../designs/instagram.md) — A small case of granting a caller only its own identity rather than trusting an id it supplies

<!-- relationships:end -->
