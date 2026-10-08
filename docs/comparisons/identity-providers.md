---
title: Identity providers
description: "Self-hosted Keycloak, Authentik, Ory and ZITADEL against the managed answers from your cloud, Auth0 and Okta"
area: comparisons
owner: Oleksandr Derechei
tags: [security, authentication, access-control, cloud]
status: stable
aliases: [keycloak, ory, authentik, zitadel, cognito, auth0, okta]
solves: [I cannot tell whether to run our own login server or pay a vendor per user, every service we write ends up with its own login page and its own users table, an enterprise customer is asking for SAML single sign-on and we have no way to give it to them, our per-user login bill grows faster than the revenue those users bring, we want to move off our login vendor and cannot get the password hashes out]
---

# Identity providers

Six ways to stop every service writing its own login: four self-hosted identity servers, and the managed answers your cloud and the identity vendors sell — compared on protocol surface, license, operational weight and how the bill grows.

## What this compares
<!--meta block=description-->

Pick an identity provider once, and every service you write delegates login to it. Pick badly and you pay twice to leave: moving users whose password hashes may never export, and re-pointing every application that trusted the old issuer. This page compares four servers you run, the [managed identity](../capabilities/identity.md) your cloud sells and two vendors who sell nothing else. The protocol decides nothing; license, enterprise surface and cost curve do.
## Explained
<!--meta block=explain-->

An identity provider is the server your services send people to for login, and it hands back a signed token each service can check. Every product here speaks OIDC, the login layer on OAuth2. Enterprise buyers also want SAML, a sign-in format many companies use, and directory federation: Keycloak, Authentik and Auth0/Okta cover both, so check the protocol and directory rows for the details. Managed products charge per monthly active user, so success makes the same component more expensive; where the vendor meters machine-to-machine clients separately, keep them out of the user count, and renegotiate before renewal. Self-hosting makes you own a service every login depends on, so publish the issuer on a hostname you control and the product underneath stays replaceable. AGPL, a license that makes you publish source to users of a modified copy, also binds when you ship it inside a product; run it unmodified and internally and it binds nothing. Choose how you split customers (the tenancy model) before you have tenants, because retrofitting it means a login outage.

**Example.** Illustrative numbers. A managed provider charges 0.02 dollars per monthly active user. Self-hosting costs 1,000 dollars a month in servers and engineer time, nearly flat as users arrive. The lines cross at 1,000 divided by 0.02, or 50,000 users. At 10,000 users managed costs 200 dollars and wins. At 200,000 it costs 4,000, four times the self-hosted figure. The cost of switching is a user move: if password hashes cannot be exported, every user must reset a password.

## The contenders
<!--meta block=contenders-->

- **Keycloak** — Apache-2.0, a CNCF (Cloud Native Computing Foundation) project out of Red Hat, and the self-hosted choice with the widest built-in protocol and directory coverage: OIDC, OAuth2, full SAML both ways, Active Directory federation, realms per tenant. The price is operating weight: a JVM (Java virtual machine) service and a database to cluster and upgrade.
- **Authentik** — An MIT-licensed core with paid enterprise features, and the least friction of the self-hosted four to stand up: login sequences are assembled from stages in the admin UI, so an unusual sign-up flow is configuration rather than a compiled plugin. Reach for it when a small team wants self-hosted single sign-on this month.
- **Ory** — Apache-2.0, and identity as separate Go services rather than one server: Kratos for users, Hydra for OAuth2 and OIDC, Keto for permissions. You compose the parts and assemble them yourself, including the login interface. Ory Network is the vendor's hosted version of the same components.
- **ZITADEL** — Go, API-first and multi-tenant by design, with an event-sourced core: every change to a user or a grant stays a queryable event rather than overwriting a row. It moved from Apache-2.0 to AGPL-3.0 in 2025, so weigh the copyleft before shipping it inside a product. ZITADEL Cloud is the vendor's SaaS.
- **Your cloud's own** — Amazon Cognito user pools, Microsoft Entra ID for workforce and Entra External ID for customers, Google Cloud Identity Platform on Firebase Auth. Each is proprietary, operated for you, and wired into its own platform's authorization rather than anyone else's. Reach for one when you are single-cloud and its limits fit.
- **Auth0 and Okta** — The incumbent identity vendors, one company since Okta bought Auth0, priced per monthly active user. Every protocol, enterprise connections and a support contract arrive on day one. Cost tracks your user count rather than your traffic, so success is the expensive case.

## How they compare
<!--meta block=matrix-->

| Criterion | Keycloak | Authentik | Ory | ZITADEL | Your cloud's own | Auth0 / Okta |
| --- | --- | --- | --- | --- | --- | --- |
| License | Apache-2.0 | MIT core, paid enterprise tier | Apache-2.0 | AGPL-3.0 since 2025 | Proprietary | Proprietary |
| Who operates it | You | You | You | You, or ZITADEL Cloud | Your cloud provider | The vendor |
| How the bill grows | With infrastructure | Infrastructure, plus the enterprise tier | With infrastructure | Infrastructure, or usage-based on Cloud; check the vendor's current pricing | Per monthly active user | Per monthly active user |
| Protocol surface | OIDC, OAuth2, SAML both ways | OIDC, OAuth2, SAML | OIDC and OAuth2, split across services | OIDC and OAuth2, API-first | Entra ID issues SAML; Cognito only consumes it | OIDC, OAuth2, SAML both ways |
| What you run | A JVM service and a database, clustered | Server, worker, PostgreSQL, Redis | Several Go services, each with a store | One Go binary and PostgreSQL | Nothing | Nothing |
| Directory federation | Lightweight Directory Access Protocol (LDAP) and Active Directory built in | LDAP source, plus an LDAP provider for legacy apps | Not in the core services | External providers, per organization | Cognito federates them; Entra ID is the directory | Active Directory and LDAP through an agent |
| Multi-tenancy model | Realms, isolated per tenant | Brands change the look, not the isolation | One deployment per tenant; projects on Ory Network | Organizations, by design | One user pool or directory per tenant | Auth0 Organizations for business customers |
| Audit trail | Event log in the database, retention you set | Events stored, retention configurable | Per-service logs, aggregated by you | Event-sourced, every change queryable | CloudTrail, Entra sign-in logs | Tenant system log, retention by plan |
| Cost of leaving | Realm export plus your database | Config and database on your disk | Each service's store is yours | Your database; AGPL binds you only if you modify it and expose it, or ship it | Cognito exports users, not password hashes; check Entra and Identity Platform separately | Vendor export, then re-point every integration |

## Choosing between them
<!--meta block=choosing-->

Choose Keycloak when you need the whole enterprise protocol surface — SAML both ways, Active Directory federation, realms per tenant — and someone will operate a clustered stateful service. Choose Authentik when a smaller team wants self-hosted single sign-on with the least setup. Choose your cloud's own when you are committed to one platform, because it removes an availability tier you would otherwise own.

Choose Auth0 or Okta when time to market beats cost growth: every protocol works this week, and theirs is the contract you renegotiate in two years. Run the arithmetic against your expected user count before you sign.

Choose ZITADEL for multi-tenant SaaS where the API, not an admin console, is the primary interface and the AGPL suits how you ship. Choose Ory when you want components rather than a server — a team that already knows it wants a custom login experience and its own permission model will fight a monolith.

Do less first. Your framework's own session authentication is the right answer until a second application needs the same users, or an enterprise buyer asks for single sign-on. Both are visible events, so wait for one rather than predicting it.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Multi-Tenancy](../patterns/distributed/routing/multi-tenancy.md) — Realms, organizations and per-tenant pools are this pattern's isolation choices, picked per product.

**Specializes**

- [Identity & Access](../capabilities/identity.md) — The customer-identity slice of the identity capability, argued product by product.

**Implements**

- [Federated Identity](../patterns/distributed/coordination/federated-identity.md) — Keycloak, Authentik, Ory and ZITADEL are this pattern self-hosted; Cognito, Entra and Auth0 are it rented.
- [Authentication Enforcer](../patterns/security/authentication-enforcer.md) — The issuer these products give you is what every service's token check points at.

<!-- relationships:end -->
