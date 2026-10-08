---
title: Build for the Needs of the Business
description: "The non-functional numbers are requirements, and the business owns them"
area: principles-systems
owner: Oleksandr Derechei
tags: [operations, availability, maintainability]
status: stable
solves: [nobody can tell me how much downtime a year the product is actually allowed, we found out during the outage that losing an hour of orders was not acceptable, the requirement just says the system must be highly available, our uptime promise to customers is higher than what our own suppliers promise us, the monthly bill doubled and nobody had a number it was supposed to stay under]
---

# Build for the Needs of the Business

How much downtime the product may take, how fast it must recover, how much data it may lose and what it may cost are business decisions with a business owner — not engineering preferences settled by taste. A number nobody wrote down still gets set, by whoever was writing the code that night, and the assumption surfaces during the incident.

## What it says
<!--meta block=description-->

Treat non-functional requirements as requirements. Downtime a year, recovery time, tolerable data loss and cost each belong to a business owner; engineering says what each choice buys and costs, then builds to the number that comes back. Skip the conversation and an engineer assumes a number while choosing a database. This is not [YAGNI](./yagni.md)'s question of what to build, nor [KISS](./kiss.md)'s of how elaborately: it asks which properties the system must hold.

## Explained
<!--meta block=explain-->

Building for the needs of the business means you treat non-functional requirements, such as how much downtime a year is allowed, how long recovery may take, how much data may be lost and what it may all cost, as requirements with a business owner's name beside each figure. Skip the talk and the numbers still get set, because an engineer assumes one while choosing a database, and everyone learns which one during the outage. Convert each target to minutes and read it back to whoever asked: 99.9% a year is about 8.8 hours of downtime. Ask how long you may be down and how much you may lose before you pick a database, and keep the promise to customers below your internal goal.

- **An ambitious target is paid for.** Four nines rules out manual recovery and most maintenance windows, so show the price before anyone signs.
- **A stakeholder's figure is only a request.** It becomes a requirement once they have seen the cost and still want it.
- **Numbers go stale as the business changes.** Recompute them when it re-plans, and lower an over-served target as readily as you raise one.

**Example.** A product owner asks for 99.99% uptime on checkout. Engineering reads it back: 52 minutes of downtime a year, 4.4 minutes a month. That rules out recovery by hand and any release that cannot roll itself back, and it needs a second region, which doubles the infrastructure bill from 20,000 to 40,000 dollars a month. Seeing the price, the owner picks 99.9% for checkout, 8.8 hours a year, and 99% for recommendations, and agrees that recommendations are shed first under load. The promise to customers is 99.5%, below the internal goal, so a miss opens a review, not a refund.

## Why it helps
<!--meta block=rationale-->

A target is what makes an architecture arguable. “Highly available” cannot be designed to and cannot be tested against; 99.9% is a budget of about nine hours of downtime a year, and you can hold a design review about whether deploys, dependency failures and one bad night fit inside it. Every further nine divides that budget by ten and has to be bought with machinery — more copies in more failure domains and automatic failover instead of a person with a runbook, so the target sentence is among the largest drivers of the system's cost.

Recovery is two separate numbers, and each one buys a different piece of the design. How long you may take to come back settles whether standby capacity runs warm and whether failover is automatic or a phone call. How much data you may lose settles the replication mode, because asynchronous [Replication](../patterns/distributed/coordination/replication.md) is cheap and fast and by definition discards whatever had not reached the follower when the primary died, while making that number zero means acknowledging each write only after a second copy has it, which adds that round trip's latency to every write. Both questions are cheap to answer in a planning meeting and expensive to answer after the storage engine is chosen.

## Applying it
<!--meta block=applying-->

Get each number written down with an owner's name beside it:

- Turn every “must be reliable” into a percentage over a stated window, then convert it to minutes and read the minutes back to whoever asked. Define the measure first: what counts as a failed request, where it is measured, over what window, and what is excluded (planned maintenance, degraded but serving). A target nobody will recognise once it is expressed as downtime is a target nobody has actually agreed to.
- Ask the two recovery questions before you choose a database: how long may we be down (recovery time objective, RTO), and how much may we lose (recovery point objective, RPO). Those answers pick the backup schedule, the replication mode and the failover design, so asking them afterwards turns them into a rebuild.
- Keep what you promise and what you aim for as two different numbers. The commitment published to a customer carries a penalty and belongs below the internal goal you operate to, so that missing the goal opens a review instead of triggering a refund.
- Multiply your dependencies' availabilities before signing anything. A request that crosses four components at 99.9% each succeeds about 99.6% of the time, so a promise above what your suppliers commit to is one you fund yourself with extra copies in independent failure domains. Copies that share a deploy pipeline, config or provider fail together, so count them as one.
- State the cost ceiling the way you state the latency one. What the system may cost per month, or per thousand requests, is a requirement with a budget owner, and a design that hits every other number at four times the budget has failed a requirement rather than exceeded one.
- Decide in advance which behaviour may disappear to protect the number. If checkout must hold its target and recommendations need not, [Load Shedding](../patterns/distributed/resilience/load-shedding.md) the second to save the first is a business decision taken calmly in a design review rather than a judgement call taken at 3am by whoever is on call.
- Draw the system's boundaries on the business's own divisions — what it sells, who owns each line, how each is priced. When the business reorganises what it sells, a system cut that way tends to follow with a change per division, while one cut along technical layers has to be re-sliced across all of them. Give each division its own targets and a cost owner.
- If no owner will give a number, write down the figure you assumed, its price and who was asked, and ship it as a flagged assumption.

A [System Design Interview](../themes/system-design-interview.md) opens with exactly this move, for exactly this reason: no box on the diagram can be defended until the numbers it is answering exist. Outside the interview the only difference is that the numbers have an owner you can go and ask.

## Taken too far
<!--meta block=overreach-->

The first way this goes wrong is a target chosen by ambition. Four nines picked because it sounded appropriately serious is a commitment to under five minutes of downtime a month, which rules out manual recovery, most maintenance windows and any release that cannot roll itself back, and nobody who picked the number was shown that bill. Recovery objectives copied from a template fail the same way: “zero data loss” written into a document by someone who never priced it buys synchronous replication and the write latency that comes with it, on every write, forever.

The second is using the business as a trump card. “The business asked for it” ends a conversation engineering was supposed to have. It is the one where you say what the request costs, what it rules out, and what the next cheapest option would give up in exchange. A stakeholder naming a figure is making a request, and it becomes a requirement only once they have seen the price and still want it. Passing the figure straight through to a design skips the conversation engineering owed the business.

The third is treating the numbers as settled. They were priced against a business with a particular traffic shape, customer mix and tolerance for a bad hour, and each of those moves: the tier that once justified cross-region failover becomes 2% of revenue, and the batch job that used to have all night now feeds a screen someone watches. Recompute the figures on whatever cadence the business re-plans on, and be as willing to lower a target as to raise one, because an over-served requirement is money that was never asked for, and unlike a missed target it never files a ticket.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [You Aren't Gonna Need It (YAGNI)](./yagni.md) — Scope discipline decides what to build; this decides which numbers count as requirements
- [Keep It Simple (KISS)](./kiss.md) — The simplest design that meets the target — but the target has to be written down
- [Make Everything Redundant](./redundancy.md) — How many nines the business will pay for is what sizes the duplication
- [Analyse Failure Modes](./failure-mode-analysis.md) — Recovery objectives are the yardstick the analysis rates risk against
- [Load Shedding](../patterns/distributed/resilience/load-shedding.md) — Which traffic is worth keeping under strain is a business call, made in advance
- [Design to Scale Out](./scale-out.md) — How far it must grow is a stated number, and it decides the shape
- [Record Architecture Decisions](./architecture-documentation.md) — The reason behind a technical choice is usually a business one, and it is the part that gets lost
- [Replication](../patterns/distributed/coordination/replication.md) — The data-loss target decides sync or async replication, so ask it before choosing

<!-- relationships:end -->
