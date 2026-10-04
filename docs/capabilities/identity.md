---
title: Identity & Access
description: "Staff, workloads and customers are three identity problems with three products"
area: capabilities
owner: Oleksandr Derechei
tags: [security, access-control, authentication, boundaries, cloud]
status: stable
aliases: [IAM, access management]
solves: [I know the AWS name for this identity service but not what Azure or Google Cloud calls it, our production database password sits in a config file and nobody knows who has copied it, customers live in the same directory as our employees and the admin work is out of hand, a contractor still has admin six months after the project ended, the access keys our deployment pipeline uses have never been rotated]
---

# Identity & Access

The three identity problems every cloud sells separately — your staff signing in, your workloads calling each other, and your customers signing in to your product — and the authorization engine that decides what any of them may do.

## What the cloud gives you here
<!--meta block=description-->

Three questions hide under the word identity, and every cloud sells a separate product for each: your staff signing in to a console, your workloads calling each other's APIs, and your customers signing in to the product you sell. Mixing the first and the third is the costly mistake. Putting customers in the staff directory works at a thousand users and becomes a migration at a million.

## Explained
<!--meta block=explain-->

Identity services decide who is calling and what they may do, from the caller rather than from the network the call came through. Three different problems hide under the word: your staff signing in, your services calling each other, and your customers signing in to your product. Each has its own product, so first name which one you have, because the wrong one is costly to leave. Put customers in a consumer identity product from the first user, since a staff directory assumes an administrator creates every account.

- **Central identity concentrates failure** Decide before an outage whether live sessions survive one, and cache token-checking keys where the answer must be yes.
- **Short-lived credentials add renewal work** Every client needs a renewal step, so set lifetime by how fast you must cut someone off.
- **Permissions pile up** Nobody is thanked for removing one, so make grants expire by default.
- **Customer accounts are the hardest to move** Keep your own user table keyed to the provider's subject identifier, its stable per-user ID.

**Example.** Your product has 1 million customers and 30 million orders. Version one stores the provider's subject ID on every order. Moving to a new provider changes every ID, so you rewrite 31 million rows and old links break. Version two gives each customer your own ID, and a mapping table holds one row per customer linking it to the provider's ID. A move now rewrites 1 million mapping rows and touches no order. The cost is one extra table you must keep in step with the provider, plus one more lookup at sign-in.

## The capabilities
<!--meta block=capabilities-->

- **[Workforce directory and single sign-on](../patterns/distributed/coordination/federated-identity.md)** — The record of your employees and contractors, plus one sign-in that carries them into every console, command-line interface (CLI) and internal application. Disabling the account once disables it everywhere, which is what makes a leaver actually gone.
- **[Resource authorization engine](../patterns/security/authorization-enforcer.md)** — The evaluator that decides whether this identity may take this action on this resource, from policies you attach to identities, to groups, or to the resources themselves. Every API call passes through it, which is also why one careless grant reaches further than you meant.
- **[Sign-in verification and multi-factor](../patterns/security/authentication-enforcer.md)** — Proving the human is the one the account claims, with a password plus a second factor bound to a device. Spend the phishing-resistant factors on accounts that can change the authorization rules, because those are the accounts an attacker is aiming at.
- **Conditional access** — Policy that reads the context of a sign-in — device state, location, what is being requested — and demands more proof or refuses outright. It is how a strong control stops being a tax on every routine login.
- **Workload identity attached to compute** — A name your running code carries because the platform attached it to the machine, container or function, not because someone pasted a key into the image. It is the largest available cut in standing credentials, and it costs a configuration change rather than a rewrite.
- **Short-lived credential issuance** — A token service that turns a proven identity into a credential that expires in minutes and names the exact role it stands for. The short lifetime is what makes a leaked credential a bounded incident.
- **Workload identity federation from outside** — Letting a workload already authenticated somewhere else — another cloud, a CI (continuous integration) runner, your own cluster — exchange that proof for a credential here, with no key stored on either side. It is how a deployment pipeline outside the cloud stops holding a permanent access key.
- **Customer and consumer identity** — A separate product for the people who buy from you: self-service sign-up, password reset, social and enterprise login, and a user store sized for millions. Keep it out of the workforce directory, which differs in who creates an account and in how it is billed.
- **[Just-in-time privilege elevation](../patterns/security/least-privilege.md)** — A grant that arrives on request, carries an approval, and removes itself on a timer. Standing admin is the permission nobody revokes; an expiring grant is the only kind that reliably goes away.
- **Secrets and key management** — One audited store for the credentials no identity can replace — third-party API tokens, signing keys, passwords for software that speaks nothing else. The workload identity is what opens the store, so the platform issues the only credential left in your system.
- **Certificate management** — Issuing and renewing the Transport Layer Security (TLS) certificates on your public endpoints, and running a private authority for the ones your services present to each other. Automatic renewal is the whole point: expiry is the outage that arrives on a date you already knew.
- **[Control-plane audit trail](../patterns/security/secure-logger.md)** — A record of every administrative API call — who, what, when, and from where. Check its default retention the day you turn it on, because it is usually shorter than the gap between a breach and its discovery.

## What each cloud calls it
<!--meta block=mapping-->

| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Workforce directory and single sign-on | AWS IAM Identity Center | Microsoft Entra ID | Cloud Identity | [Keycloak](../comparisons/identity-providers.md) |
| Resource authorization engine | AWS IAM | Azure RBAC | Cloud IAM | Open Policy Agent, OpenFGA |
| Workload identity attached to compute | IAM role, via instance profile or task role | managed identity | service account | SPIFFE/SPIRE |
| Short-lived credential issuance | AWS STS | Microsoft Entra ID access tokens | Security Token Service | OpenBao |
| Workload identity federation from outside | IAM OIDC or SAML provider with AssumeRole | workload identity federation | Workload Identity Federation | SPIFFE/SPIRE |
| Workload identity for Kubernetes | EKS Pod Identity; IAM roles for service accounts | Microsoft Entra Workload ID | Workload Identity Federation for GKE | SPIFFE/SPIRE |
| Customer and consumer identity | Amazon Cognito | Microsoft Entra External ID | Identity Platform | Keycloak, Authentik |
| Conditional and context-aware access | IAM policy conditions, including `aws:MultiFactorAuthPresent` | Microsoft Entra Conditional Access | Context-Aware Access | no direct open-source equivalent |
| Just-in-time privilege elevation | no first-party managed service | Microsoft Entra Privileged Identity Management | Privileged Access Manager | no direct open-source equivalent |
| Guardrails above the account boundary | AWS Organizations service control policies | management groups with Azure Policy | organization policy constraints | Open Policy Agent |
| Secrets management | AWS Secrets Manager | Azure Key Vault | Secret Manager | OpenBao |
| Key management | AWS KMS | Azure Key Vault; Managed HSM | Cloud KMS | OpenBao |
| Hardware security module | AWS CloudHSM | Azure Cloud HSM | Cloud HSM | no direct open-source equivalent |
| Public TLS certificates | AWS Certificate Manager | Azure Key Vault certificates | Certificate Manager | cert-manager with Let's Encrypt |
| Control-plane audit trail | AWS CloudTrail | Azure activity log | Cloud Audit Logs | no direct open-source equivalent |
| Managed Active Directory | AWS Directory Service for Microsoft Active Directory | Microsoft Entra Domain Services | Managed Service for Microsoft Active Directory | Samba Active Directory |

## Choosing between them
<!--meta block=choosing-->

Start by naming which of the three identity problems you have, because the wrong product is expensive to leave. Staff belong in the workforce directory, and everything they touch should reach them through it. Workloads should take the identity the platform attaches to the compute, never a credential a person typed. Customers belong in a consumer identity product from the first user, not the first million.

| If you need… | Choose | Because |
| --- | --- | --- |
| Staff to reach consoles and internal apps | Workforce directory with SSO | One place to disable an account, which is what makes offboarding real |
| One of your services to call another | Workload identity attached to the compute | The platform issues and renews it, so nothing is written down |
| A CI job outside the cloud to deploy | Workload identity federation from its OIDC token | Trades a permanent access key for one that expires in minutes |
| Millions of users who sign themselves up | Consumer identity product | Built and priced for accounts you never administer |
| A browser to read one private object | A signed, expiring URL — a [valet key](../patterns/distributed/routing/valet-key.md) | Keeps the bytes and the credential out of your service |
| A contractor to hold admin for two hours | Just-in-time elevation | An expiring grant is the only kind that gets removed |
| A database password out of the repository | Secrets manager, read by a workload identity | Moves the secret somewhere revocable and logs every read |
| To answer "who did this" six months later | Control-plane audit trail, exported | Default retention is shorter than the gap before you look |

One platform composes identity governance out of several services and another sells it as a single product, and that shapes any migration between them. On AWS, joiner-mover-leaver lifecycle, access review and privileged access come from IAM (identity and access management), IAM Access Analyzer, AWS Organizations, IAM Identity Center and CloudTrail working together, each configured separately. Microsoft sells the same ground as one governance product. Moving "the IAM setup" is therefore a many-services-to-one translation, so budget design time rather than a rename.

Human sessions and workload credentials pull the lifetime dial in opposite directions, and the same number cannot serve both. A workload renews automatically, so minutes cost nothing and buy you revocation that lands quickly; a person re-authenticating every hour will find a way around you, which is what conditional access is for — long sessions for routine work, a fresh proof when the request is sensitive. Consumer identity is the third case and the one that shapes the bill, because these products are priced by monthly active user rather than by request. Keep your own user record keyed to the provider's subject identifier from day one, and a later migration moves credentials instead of identities — a [secure session manager](../patterns/security/secure-session-manager.md) in your own system is what makes that key yours to hold.

## What does not port
<!--meta block=portability-->

- **The boundary a permission is scoped to differs**: one cloud scopes to an account, another to a subscription, another to a project, so the same wildcard covers a different share of your estate. Work out the blast radius of every policy again on arrival rather than translating the document.
- **Identity policies and resource policies compose differently**: whether an allow on the resource stands without a matching allow on the identity, and where an explicit deny can come from, differ by cloud. Port the deny paths first — a policy set that grants the same things and refuses different ones has not been ported.
- **A role is not the same object everywhere**: on one cloud it is an identity a caller assumes under a trust policy, on another a named bundle of permissions bound to a principal at a scope. Copying role names produces grants that read correctly and permit different things, so map on the permissions they carry.
- **Long-lived access keys have a short-lived replacement everywhere**: every cloud can federate an external workload's own token into a temporary credential. Porting keys as keys carries your worst practice across intact, and replacing them costs a day and removes a whole class of incident.
- **There is no universal cross-account resource sharing**: sharing a resource across an account boundary is a first-class mechanism on one cloud and absent on the next, where you re-express it as a role scoped into the other tenant. The sharing survives the port; the topology of who holds what does not, so redraw it before you migrate.
- **Consumer identity is the least portable thing on this page**: your users, their profile attributes and their password hashes live inside the product, and whether you can export usable hashes at all varies. Assume the exit is a forced password reset for every customer, and price that against the product before you commit.
- **Where multi-factor is required lives in a different layer**: on one cloud the requirement is a condition inside the permission statement, on another a separate policy object evaluated at sign-in. Porting the permissions therefore does not port the requirement, and nothing complains — the grants land and the second factor quietly stops being demanded.
- **Audit retention and export are their own service**: default retention for control-plane logs is measured in months on some clouds and shorter on others, and long-term retention means routing the events into storage you configure. Set that up when you enable the trail, because the day you need last year's log is the day you cannot create it.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Least Privilege](../patterns/security/least-privilege.md) — Scoped roles and short-lived credentials are the mechanism; the discipline is still yours.

**Generalizes**

- [Identity providers](../comparisons/identity-providers.md) — Which identity product to run or rent, compared on protocols, tenancy and the bill.

**Implements**

- [Federated Identity](../patterns/distributed/coordination/federated-identity.md) — Workload identity federation and external IdP trust are this pattern as a platform feature.
- [Authentication Enforcer](../patterns/security/authentication-enforcer.md) — The managed identity provider is the enforcement point.
- [Authorization Enforcer (RBAC)](../patterns/security/authorization-enforcer.md) — The resource authorization engine evaluates every control-plane call.
- [Secure Logger](../patterns/security/secure-logger.md) — The control-plane audit trail is append-only, so a caller inside the account cannot edit what it already recorded.
- [Secure Session Manager](../patterns/security/secure-session-manager.md) — Customer identity services issue, expire and revoke sign-in sessions for you.

<!-- relationships:end -->
