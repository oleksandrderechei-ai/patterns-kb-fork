---
title: Authorization Enforcer (RBAC)
description: Centralizes checking what a role is allowed to do
area: security
owner: Oleksandr Derechei
tags: [security, access-control]
status: stable
aliases: [RBAC, authz, PEP]
solves: [a user changed the id in the URL and pulled up another customer record, checking whether someone is an admin is copy-pasted in forty places and each copy is slightly different, compliance asked me who can delete records and I had to grep the whole codebase to answer, giving a new team read-only access requires a code change and a deploy, a regular user reached an endpoint that was only ever meant for staff]
---

# Authorization Enforcer (RBAC)

Centralizes every check of what a role is allowed to do into one enforcement point, so an action is granted or refused the same way everywhere it's requested.

## What it is
<!--meta block=description-->

An authorization enforcer is the single choke point every access decision passes through: given a subject, an action and a resource, it answers whether the action is allowed. It replaces permission checks copy-pasted into controllers, services and jobs, where one missed check is a privilege-escalation bug. It sits at a fixed point in the request path, decoupled from where the role-to-permission mapping lives, so swapping that source never touches a call site.

## Explained
<!--meta block=explain-->

An authorization enforcer is one place that answers the question can this person do this action on this thing, and the rest of the system is meant to accept its answer. Without it, the check gets copied into controllers, services and background jobs, each slightly different, and one missing check lets an ordinary user do an administrator's task. Choose it over checks written inside each handler when permissions change often or must be audited, because you then change a role once and it takes effect everywhere, and you read one policy to see who can do what.

- **Role explosion.** A role per edge case becomes per-user exceptions; keep roles few and coarse.
- **Over-granting.** Coarse roles grant too much; pass the resource to the enforcer for rules like owner-only edit.
- **Hot path.** Every request waits on it and it is one point of failure; keep decisions fast and choose per route what failure does.
- **Context rules.** Rules about time or location need extra inputs; pass them in deliberately.

**Example.** A document service has viewer, editor and admin roles, and DELETE /documents/42 needs admin. Removing the delete button protects nothing: a viewer can send the request by hand. The enforcer finds no delete permission and answers 403 before the handler runs. Without it, say one of 30 handlers forgot its check and would delete the document. The cost shows with the rule editors edit only their own documents. That is not a role; one role per team would mean, say, 200 roles for 200 teams. Instead the enforcer receives the document owner with each call and compares it to the caller.

## How it works
<!--meta block=structure-->

```mermaid caption="What stops a handler from deciding for itself who may delete a document? Step 3 answers subject, action and resource in one place, so a permission change lands everywhere at once and step 5 hands the handler an action already known to be allowed."
flowchart LR
    Cl["Caller"]:::ext
    AE["Authentication enforcer"]:::ext
    subgraph PDP["One place decides allow or deny"]
        Enf["Authorization enforcer"]
        Policy[("Roles and permissions")]
    end
    H["Request handler"]
    Cl -->|"1 request: this action, this resource"| AE
    AE -->|"2 hand on the verified identity"| Enf
    Enf -->|"3 which roles, and what may they do?"| Policy
    Enf -->|"4 not permitted: 403, stops here"| Cl
    Enf -->|"5 permitted: run the action"| H
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Attribute-Based Access Control (ABAC)** — Decisions weigh attributes of subject, resource, and environment — department, classification, time of day — instead of a fixed role, at the cost of rules that are harder to audit at a glance.
- **Access Control Lists (ACL)** — Permissions attach directly to each resource as a list of subjects allowed to act on it — fine-grained, but unwieldy once resources number in the thousands.
- **Policy-based / externalized authorization** — Push the decision out to a policy engine (Open Policy Agent (OPA)/Rego, Cedar) that evaluates rules against a request — keeps policy versioned and testable independently of application code.
- **Relationship-Based Access Control (ReBAC)** — Access follows a graph of relationships between subjects and resources — "member of," "owns," "shared with" — the model behind Google Zanzibar and most modern sharing permissions.
- **Role hierarchy** — Roles inherit permissions from parent roles, so "Admin" gets everything "Editor" gets plus more, without every grant being repeated per role.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Centralizes every access decision** in one auditable place instead of scattered checks, provided every path routes through it.
- **Changing a role's permissions takes effect everywhere** once caches and policy copies refresh, bounded by the cache TTL and refresh interval, with no code redeploy.
- **Makes "who can do what" answerable** by reading one policy, not grepping the codebase.
- **Decouples the decision itself** from where the role-to-permission mapping is stored.

### Cons
<!--meta polarity=con-->

- **Role explosion** — a role for every edge case — collapses back into per-user special-casing.
- **Coarse roles either over-grant** permissions or force awkward role-splitting to stay precise.
- **The enforcer is a single point** of failure and a hot path that has to stay fast.
- **Doesn't capture context-dependent rules** — ownership, time, location — without extra machinery.
- **Coverage depends on every path** calling the enforcer; one unrouted path is unguarded.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple roles need different**, well-defined sets of permissions across the system.
- **You need one auditable place** to answer "who can do what" for a security or compliance review.
- **Permissions change often enough** that hard-coding a check per call site is unsustainable.

### Avoid when
<!--meta polarity=avoid-->

- **Rules depend heavily on resource attributes or relationships** — reach for ABAC or ReBAC instead.
- **There's effectively one role** — every authenticated user can do everything — so the check is a no-op.
- **Permissions genuinely differ per individual**, not per role — a role invented per user isn't RBAC.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal RBAC enforcer"
type Role = "viewer" | "editor" | "admin";

const permissions: Record<Role, Set<string>> = {
  viewer: new Set(["read"]),
  editor: new Set(["read", "write"]),
  admin: new Set(["read", "write", "delete"]),
};

class AuthorizationEnforcer {
  constructor(private readonly rolesOf: (userId: string) => Role[]) {}

  can(userId: string, action: string, resource?: { ownerId: string }): boolean {
    const roles = this.rolesOf(userId);
    // Owner-only edit: a non-owner needs the admin role.
    if (action === "write" && resource && resource.ownerId !== userId && !roles.includes("admin")) {
      return false;
    }
    // An unknown role has no entry, so it denies.
    return roles.some((role) => permissions[role]?.has(action) ?? false);
  }

  enforce(userId: string, action: string, resource?: { ownerId: string }): void {
    if (!this.can(userId, action, resource)) {
      throw new Error(`forbidden: ${action}`); // nothing past this line runs
    }
  }
}

// Every mutating call passes through the same gate.
const authz = new AuthorizationEnforcer(getUserRoles);
authz.enforce(currentUser.id, "delete");
await documents.delete(docId);

// Owner-only edit: pass the resource so the rule can compare owners.
authz.enforce(currentUser.id, "write", { ownerId: doc.ownerId });
```

## In the wild
<!--meta block=wild-->

- **Open Policy Agent** — A general-purpose policy decision point: applications ask OPA whether an action is allowed and it evaluates Rego policies against the request. Policy and data are distributed as bundles the agent polls on an interval, and every decision can be emitted to a decision log for audit. {#wild-open-policy-agent}
- **Kubernetes RBAC** — Role and ClusterRole objects define permissions; RoleBinding and ClusterRoleBinding attach them to subjects. With the RBAC authorization mode enabled, the API server checks every request against the bindings and denies by default — a subject with no binding can do nothing. {#wild-kubernetes-rbac}
- **AWS identity and access management (IAM)** — Every API call is evaluated against attached identity-based and resource-based policies in one central decision point. Access is denied by default, an explicit Deny always overrides an Allow, and the effective decision is the combined result of all applicable policies. {#wild-aws-iam}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Default effect (deny-by-default)** — What happens to a request that matches no rule. Deny-by-default refuses it. Allow-by-default turns every policy gap into access.
- **Decision cache time to live (TTL)** — How long an allow/deny decision is memoized before re-evaluation. Longer cuts evaluation cost on hot paths but means a revoked permission can still be honored until the entry expires. Set it from the longest revocation delay you accept, and measure staleness against it.
- **Policy / role-data refresh interval** — How often the enforcer pulls updated roles and policy from its source (a bundle server, a database, an external PDP). Sets the ceiling on how long a permission change takes to take effect everywhere. Set it from the same revocation delay.
- **Deployment topology (local PDP vs remote decision service)** — A colocated sidecar or embedded library keeps decision latency and availability under local control; a central remote service is easier to govern but adds a network hop and a shared dependency to every request.

### Signals to watch
<!--meta polarity=signal-->

- **403 / denial rate** — A jump after a policy change usually means over-restriction (a needed grant was dropped); an unexpected drop toward zero can mean over-grant or a check being skipped. Alert on deviation from a per-route baseline, and compare with the policy deploy time.
- **Authorization decision latency (p99)** — Time to evaluate a single allow/deny on the request path.
- **Policy / role-data staleness** — Age of the policy and role mapping the enforcer is actually using versus the source of truth. Rising staleness means revocations and new grants are not yet in effect.
- **Decision cache hit ratio** — Fraction of decisions served from cache versus fully re-evaluated. A falling ratio predicts rising evaluation cost and latency on the hot path.

### Failure modes under load
<!--meta polarity=failure-->

- **Policy engine unreachable** — The central decision point goes down. Deny-by-default then locks legitimate users out of everything, an availability outage across every protected action. Mitigate: run the decision point embedded or as a sidecar, fail closed for writes, and limit any fail-open to named read routes.
- **Stale policy after a revocation** — A role loses a permission but the enforcer keeps an old cached decision or an un-refreshed policy copy, so the revoked action keeps succeeding until the cache/bundle refreshes.
- **Over-broad role (privilege creep)** — Coarse or accreted roles grant more than any holder needs; a compromised or mistaken account can then do far more than intended. Nobody notices until an audit or incident.
- **Slow evaluation on the hot path** — Complex rules or a slow remote PDP add latency to every request; under load the enforcer becomes the bottleneck.
- **Allow-by-default breach** — If the engine is unreachable and the default is allow, every request is granted silently, with the same blast radius as a lockout.

### Readiness checklist
<!--meta polarity=check-->

- Confirm the default effect is deny: a request matching no rule is refused, not allowed.
- Verify every mutating path routes through the enforcer — grep for inline permission checks that decide on their own.
- Test that revoking a permission takes effect within the refresh/cache window you claim, not just eventually.
- Load-test decision latency on the hot path with the decision cache cold.
- Decide and document the fail mode when the policy source is unreachable — fail closed unless a route has a stated reason not to.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Auth & Access](../../themes/auth-and-access.md) — Decide what the role may do {#fluency-auth-and-access}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Least Privilege](./least-privilege.md) — Grant only what the role needs
- [Secure Session Manager](./secure-session-manager.md) — Reads the identity and roles the session carries forward
- [Identity Is the Perimeter](../../principles/identity-as-perimeter.md) — Authorization is the half of the boundary that identity alone cannot cover
- [Intercepting Validator](./intercepting-validator.md) — Validation rejects malformed input at the edge; this decides what the valid caller may do, per service.
- [Gatekeeper](../distributed/routing/gatekeeper.md) — The gatekeeper screens requests at the perimeter; this enforces the role's permissions at each service behind it.
- [Single Access Point](./single-access-point.md) — The single entry point guards the perimeter; this decides what an admitted caller may do.
- [Defense in Depth](../../principles/defense-in-depth.md) — Defense in depth asks for this check behind the gateway too

**Requires**

- [Authentication Enforcer](./authentication-enforcer.md) — Needs a verified identity to check, since a role check means nothing before you know who is asking; identity and permission are distinct steps

**Implemented by**

- [Identity & Access](../../capabilities/identity.md) — The cloud's identity and access management (IAM) engine is this, applied to every resource.
- [Resource Organisation](../../capabilities/resources.md) — Service control policies, Azure Policy and Organization Policy are decision points above the account, consulted on every control-plane call.

<!-- relationships:end -->
