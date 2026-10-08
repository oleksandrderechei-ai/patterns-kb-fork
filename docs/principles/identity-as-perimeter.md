---
title: Identity Is the Perimeter
description: A verified identity grants access; where the packet came from does not
area: principles-systems
owner: Oleksandr Derechei
tags: [security, authentication, access-control, boundaries]
status: stable
aliases: [zero trust]
solves: [someone got onto the internal network and could reach everything from there, our services trust each other because they sit on the same network, the same password is in twelve config files and we cannot rotate it, we disabled the account but they were still logged in an hour later, an internal tool skipped the front door and talked straight to the database]
---

# Identity Is the Perimeter

Grant access on the strength of a verified identity and the claims attached to it, checked wherever the work is actually done. A network position proves nothing about who is asking, so “inside the firewall” is not a permission — and services need identities of their own for exactly the reason people do.

## What it says
<!--meta block=description-->

Decide what a request may do from the identity behind it, not from where it arrived. A source address stopped being evidence once laptops, contractors, integrations and a compromised internal host could all send from the trusted side. Authenticate the caller, read the claims its identity carries, and check them where the work is done. Network controls narrow what an attacker reaches but no longer grant permission, and a service calling a service is a caller like any other.

## Explained
<!--meta block=explain-->

Identity as perimeter means you decide what a request may do from who is behind it, not from which network it came from. A source address stopped being evidence once laptops, contractors, integrations and a compromised internal host could all send from the trusted side. So authenticate the caller, read the claims its identity carries, and check them where the work is done. Service-to-service calls count too: give each workload its own short-lived credential issued by an authority both ends trust, not a shared secret pasted into a config file, since a static secret names no caller and cannot be rotated without redeploying everything that holds it. Choose it over a trusted-network model whenever more than one kind of thing can send from inside. Network controls still help by limiting what an attacker reaches after a foothold.

- **The issuer is a single point of failure.** If it is down, nobody logs in, so decide in daylight whether live sessions keep working.
- **Short credentials revoke fast but load the issuer.** Renew at half life and retry, so an outage shorter than half the lifetime passes unnoticed.
- **Permissions pile up.** Expire access instead of granting it forever, and do not write the identity system yourself.

**Example.** A billing service obeys any call from the office network. A contractor's laptop on that network calls its refund endpoint and is obeyed, because the network was the check. The team moves to workload identity: each service gets a certificate that lasts 1 hour, renewed by a service mesh, and the refund endpoint accepts only the orders service, named in a policy. A copied certificate works for at most 1 hour, unless the attacker also holds the workload, and only as one named caller. The cost shows up when the issuer goes down. Renewing at minute 30 with retries survives an outage shorter than 30 minutes; a 30-minute outage leaves no margin, so the team alerts on failed renewals.

## Why it helps
<!--meta block=rationale-->

The value shows up in the second hour of a breach. Where permission comes from network position, one compromised host inherits everything that host could reach, so a phished laptop or an unpatched internal service becomes access to the estate. Where permission comes from a verified identity checked at each service, the same foothold gets only the credentials it stole, and whatever those are scoped to allow. That is the difference between an incident and a disclosure.

It also makes access something you can reason about after the fact. An identity carries claims you can read, log and revoke, so you can answer who called this, with which rights, and when that stopped being true. A firewall rule records where a packet came from, not who sent it, which is why estates built on network trust struggle to say what an intruder reached.

## Applying it
<!--meta block=applying-->

Make identity the thing every decision reads:

- Authenticate once, somewhere you control, and pass the result on as a claim the next hop can verify. An [Authentication Enforcer](../patterns/security/authentication-enforcer.md) keeps credential checking in one reviewed place rather than in every handler, where one of them will get it wrong.
- Decide authorisation where the work happens. An [Authorization Enforcer](../patterns/security/authorization-enforcer.md) inside the service is what stops a batch job, an admin tool or another team’s process from being obeyed simply because it never crossed the front door.
- Give every workload an identity of its own, issued rather than configured. A service should prove who it is the way a person does, with a short-lived credential from an authority both ends trust, bound to that workload and renewed automatically. A static secret names no caller, so an audit log cannot say which service used it. It cannot be rotated without redeploying everything that holds it, and it outlives the person who added it in repository history or an image layer.
- Let the platform issue and renew those credentials, so no team has to build it. A [Service Mesh](../patterns/distributed/routing/service-mesh.md) that issues a per-workload certificate, rotates it on a short cycle and requires both ends to present one turns service-to-service authentication into infrastructure — and gives you one place where “which services may call this one” is a policy you can read instead of a firewall rule you have to infer.
- Trust one issuer for human identity, and hold the session carefully. [Federated Identity](../patterns/distributed/coordination/federated-identity.md) gives you a single place to disable an account, and a [Secure Session Manager](../patterns/security/secure-session-manager.md) keeps the token out of the places that leak it — a session that survives logout on one service is an account you cannot actually close.
- Scope every credential to the smallest thing it can do and the shortest time it can live. [Least Privilege](../patterns/security/least-privilege.md) is what makes a stolen token bounded, and handing out a narrow, expiring [Valet Key](../patterns/distributed/routing/valet-key.md) for one object is the same move applied to data.
- Do not write the identity system. Credential storage, session handling, multi-factor, federation, revocation and the standards behind each are separate specialist problems, and getting one subtly wrong produces a breach rather than a bug — silent, remote, and usually reported to you by somebody else.

Every one of these decides who is asking. Get that right and the network goes back to being a way to limit damage, rather than the only thing between an attacker and your data.

## Taken too far
<!--meta block=overreach-->

A checkpoint at the edge is not a check at the point of use. A [Gatekeeper](../patterns/distributed/routing/gatekeeper.md) that validates every request before it reaches the protected service is a real reduction in exposure, and it turns into a false floor the moment something can reach that service another way — a batch job, an internal admin tool, a debugging port, a second entrance added a year later. Test the assumption rather than trusting it: send a service a request with nothing in front of it, and if it does as it is told, your perimeter is still the network. Log the requests that pass on network position alone and cut each service over when that count reaches zero. A credential can be replayed by whoever holds it, so scope each to one audience and keep the key inside the workload where the platform allows.

Concentrating identity concentrates failure. One issuer for everything is one outage away from nobody logging in and no service calling another, so decide deliberately whether live sessions and already-issued credentials keep working through an issuer outage — that is the trade, and it should be made in daylight. Credential lifetime is the same trade in miniature: short ones revoke quickly and load the issuer, long ones are cheap and stay valid for minutes after you disabled the account. Set the lifetime from how fast you must be able to cut somebody off, then add an explicit revocation check on the few operations that cannot wait that long.

Permissions accrete, because removing one is unrewarded and mildly risky. Nobody is thanked for revoking a role that turns out to have been needed, so grants pile up until a typical identity can do far more than its job requires and least privilege describes nothing real. Expire access instead of granting it: time-bounded elevation, periodic review whose default is removal, and usage data that shows which permissions have gone untouched long enough to delete. The opposite failure is friction — a re-authentication prompt every few minutes trains people to click through prompts without reading them, and a control awkward enough that a team routes around it with one shared account has cost you more than it bought.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Federated Identity](../patterns/distributed/coordination/federated-identity.md) — One authority issues the identity that every service agrees to trust
- [Authentication Enforcer](../patterns/security/authentication-enforcer.md) — Verifying who is asking belongs in one place, not in every handler
- [Authorization Enforcer (RBAC)](../patterns/security/authorization-enforcer.md) — Identity answers who; the claims still have to be checked against what
- [Secure Session Manager](../patterns/security/secure-session-manager.md) — A session is a credential with a lifetime, and both halves matter
- [Gatekeeper](../patterns/distributed/routing/gatekeeper.md) — Screen at the entrance, but never only at the entrance
- [Least Privilege](../patterns/security/least-privilege.md) — A verified identity should still carry the smallest claim set that works
- [Service Mesh](../patterns/distributed/routing/service-mesh.md) — Services prove who they are to each other, not only to users
- [Prefer Managed Services](./managed-services.md) — Identity is the system least worth building yourself
- [Fallacies of Distributed Computing](./fallacies-of-distributed-computing.md) — Identity checks replace the secure-network assumption.
- [Defense in Depth](./defense-in-depth.md) — Identity at every service is the layer behind the network edge.
- [Valet Key](../patterns/distributed/routing/valet-key.md) — A narrow, expiring credential for one object is the same identity-scoping move applied to data
- [Make Everything Redundant](./redundancy.md) — The issuer is a single point of failure; run it redundantly and decide what survives its outage

<!-- relationships:end -->
