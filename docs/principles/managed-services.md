---
title: Prefer Managed Services
description: Run only what your users pay you for; rent the rest
area: principles-systems
owner: Oleksandr Derechei
tags: [operations, maintainability, resource-management]
status: stable
aliases: [buy vs build]
solves: [two engineers spend most of every week keeping the database alive, we have never actually tested whether our backups restore, the on-call rotation is mostly for infrastructure nobody wanted to own, we built our own queue and now only one person understands it, our small team patches and babysits servers instead of building the product customers pay for]
---

# Prefer Managed Services

Give the operational burden of a commodity capability — a database, a queue, a cache, an identity system — to someone whose full-time job is running it. Engineering attention is the scarcest thing you have, and spending it on infrastructure nobody buys from you is a decision, whether or not you made it deliberately.

## What it says
<!--meta block=description-->

Where a capability is a commodity, rent it rather than run it. A database, broker, cache, object store or identity system is a standing commitment to patching, upgrades, restored backups, failover and on-call, none of which your users pay for. Hand it to a provider and spend the attention on what only you can build. Build it yourself only when it is a differentiator, no offering meets a requirement you can state, or the numbers stop working at your scale.

## Explained
<!--meta block=explain-->

Preferring managed services means that where a capability is a commodity, such as a database, a message broker, a cache or an object store, you rent it instead of running it. Running one means patching, upgrades, backups someone has actually restored, failover and an on-call rotation, none of which your users pay you for. Decide per capability, and build it yourself only when it is what sets you apart, when no offering meets a requirement you can state exactly, or when the numbers stop working at your scale. State the requirement as a test an offering passes or fails, not as a worry that it might not be flexible enough. Reach the service through an interface your own code owns, so replacing it means writing one adapter, and re-run the arithmetic, salaries included, whenever scale grows tenfold.

- **Lock-in.** Services are cheap to enter and costly to leave, so sketch the exit and the growth curve of the bill when you adopt.
- **Borrowed outages.** A provider's limits and outages become yours, so decide which capabilities deserve a second path.
- **Thin know-how.** A team that never ran the thing cannot debug it, so keep enough understanding to reason about it.

**Example.** A 6-person team needs a Postgres database. Running it themselves means patching, backups, a standby and a rotation, assumed at a fifth of one engineer's time. A managed instance costs 400 dollars a month and brings automated backups and zone failover. Their requirement test is that writes stay inside the EU, so they rent it behind a repository interface. Two years later traffic is 10 times higher and the bill is 4,000 dollars a month on a steady workload. They price the build from payroll, hardware and incident hours. It still exceeds the bill, so they keep renting. Failover covers a failed instance or zone, not a provider-wide outage, so a 90-minute outage left them waiting.

## Why it helps
<!--meta block=rationale-->

The work you avoid is the work that never appears in a plan. Plans rarely estimate the afternoon lost to a minor-version upgrade that went sideways, the sprint spent proving the backups actually restore, or the year of nights on a rotation for a broker that four people understand. That is what running a commodity yourself costs, and it is paid in exactly the hours you would otherwise have spent on the product.

The second thing you buy is a floor under your worst day. A managed store that replicates across failure domains, takes point-in-time backups and fails over without a human once replicas are configured gives you a durability posture a small team reaches only after several incidents have taught it what to build. That floor exists only in the tier you configure and pay for, so check what the default gives you. Renting costs a line item you can see and argue about; building costs those incidents, and you pay for them in customer trust rather than in currency.

## Applying it
<!--meta block=applying-->

Decide it capability by capability, never once for the whole system:

- Write down what your users actually pay you for, and defend that list. Everything on it deserves your best engineers; everything off it is a candidate for somebody else to run, and the burden of proof sits with keeping it in-house.
- Start with the storage tiers, which carry the most operating work and the least that sets you apart. A managed relational database, a hosted [Object Storage](../patterns/distributed/routing/object-storage.md) service and a [Distributed Cache](../patterns/caching/distributed-cache.md) you never patch remove a frequent source of unplanned weekend work.
- Rent the plumbing next. A hosted broker behind a [Message Queue](../patterns/messaging/message-queue.md), or a managed [API Gateway](../patterns/distributed/routing/api-gateway.md) in front of your services, replaces two systems that are cheap to stand up and expensive to keep healthy under real traffic.
- State the requirement before you shop, as something an offering passes or fails. “Writes acknowledged inside a named jurisdiction” or “a ninety-day immutable audit trail” is a test; “it might not be flexible enough” is how a team talks itself into a build it will still be maintaining in five years.
- Keep your code portable at the seam, not throughout. Reach the service through an interface your own domain owns, so replacing it means writing one adapter — but do not reimplement its features to stay neutral, because a lowest-common-denominator wrapper discards the reason you rented it.
- Shape your own tier so the rented one can move underneath it. A [Stateless Service](../patterns/distributed/routing/stateless-service.md) that holds no session and no local durable state lets you resize instances, migrate a store or ride a provider failover without a migration plan for your own processes.
- Re-run the arithmetic whenever scale moves by an order of magnitude, and whenever the monthly bill reaches the cost you estimated for building it yourself. Set a budget alert on the bill at adoption, with that estimate as the trigger, so the crossover is seen rather than watched for. A rental that was obvious at a tenth of today’s traffic may no longer be.
- Price the build as a method, not a guess: monthly hardware, plus engineer fraction times loaded salary, plus rotation cost, plus incident hours times your cost per hour. Take each input from your own payroll and incident log. An infrastructure-line-only build omits staff and incident cost, so it understates the build.

None of this is laziness dressed up as strategy. It is [Keep It Simple](./kiss.md) and [You Aren’t Gonna Need It](./yagni.md) applied one level down from the code: run the least infrastructure that satisfies a requirement you can name out loud.

## Taken too far
<!--meta block=overreach-->

Managed services are cheap to enter and expensive to leave, and that asymmetry is part of how the product is priced. The bill can curve the wrong way too: pricing that makes a small workload trivial may cross over the cost of running the same thing yourself once the workload is large and steady, and the crossing is invisible unless somebody is watching for it. Estimate the exit and sketch the growth curve at the moment you adopt, while you still have the option not to.

A provider’s limits become your limits. A cap on payload size, a maximum retention, a query timeout you cannot raise: each is harmless until a requirement lands on the wrong side of it, and then it is an architecture problem rather than a configuration one. Its outages become your outages as well, with no lever for you to pull. You cannot roll back somebody else’s deployment, and the honest thing to tell your own users during that hour is that you are waiting. Give a capability a second path when its expected downtime (hours at the provider’s stated availability times your cost per hour down) costs more than building and running that path; otherwise accept being down with it. Provider-driven change lands on its schedule too: forced version end-of-life upgrades, deprecations and price changes. Egress fees add to the exit cost, and the provider’s patching leaves access, network and configuration mistakes yours.

The subtlest cost is the understanding you never acquire. Debugging eventually needs a model of how the thing behaves — how the storage engine plans that query, what the broker does when one consumer stalls — and a team that has never run one has nothing to reason with when the managed version misbehaves in a way the console does not explain. Some decisions are also not yours to make: data-residency rules, an air-gapped deployment or a certification a customer demands can rule an offering out whatever its engineering merits. Keep enough depth to reason about what you depend on, treat the provider’s documentation as required reading rather than optional, and notice the day “we use the managed one” stops being a decision and becomes a [Golden Hammer](../hazards/golden-hammer.md), the one tool you reach for whatever the problem.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Object Storage](../patterns/distributed/routing/object-storage.md) — Durability at scale is work you would otherwise build and then staff
- [Distributed Cache](../patterns/caching/distributed-cache.md) — Running a cache tier is a job; depending on one is a line of config
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — Edge concerns are a solved product, and never the differentiator
- [Message Queue](../patterns/messaging/message-queue.md) — Brokers are the classic thing teams rebuild badly and then maintain forever
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — Push state into managed stores and the compute becomes disposable
- [Keep It Simple (KISS)](./kiss.md) — The simplest system is the one with fewer parts you personally operate
- [You Aren't Gonna Need It (YAGNI)](./yagni.md) — Build the platform only when a named requirement forces you to
- [Design for Operations](./design-for-operations.md) — Renting a service moves the operational burden; it does not delete it
- [Identity Is the Perimeter](./identity-as-perimeter.md) — Identity is the highest-value instance of the buy-rather-than-build argument
- [Repository](../patterns/enterprise/repository.md) — The interface your own code owns is a repository; swapping the rented store means one adapter

<!-- relationships:end -->
