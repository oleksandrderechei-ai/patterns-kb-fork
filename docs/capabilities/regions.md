---
title: Regions & Availability
description: "Regions, zones and fault domains — how far apart to put things to survive each kind of failure"
area: capabilities
owner: Oleksandr Derechei
tags: [resilience, availability, isolation, latency, cloud]
status: stable
aliases: [availability zones, AZ, multi-region]
solves: [we deployed to three availability zones and I still cannot say which outages that survives, our failover plan assumes a paired backup region and the cloud we are moving to has no such thing, two instances died at the same moment and it turned out they shared a rack, the whole service restarted during a planned platform update nobody told us about, I know what my cloud calls this piece of geography but not what the other two call it]
---

# Regions & Availability

The geography a cloud sells you — region, zone, and the anti-affinity layer beneath the zone — and how far apart two copies of a thing have to sit before one event can no longer reach both.

## What the cloud gives you here
<!--meta block=description-->

Distance buys you a ladder of failures survived: a disk, a rack, a datacenter, a whole region. Redundancy crosses each step with a copy far enough away that one event cannot reach both, and every step up costs more money and latency than the one below. The top two rungs, [region](../principles/redundancy.md) and zone, carry the same names on every cloud. Below the zone the constructs do not line up, and the gaps in the mapping are the content.
## Explained
<!--meta block=explain-->

A region is a named geographic area, and a zone inside it is a group of datacenters whose power, cooling and network no other zone shares. Spreading copies of your system across zones or regions lets one failure hit only one copy. Choose the scope from the failure you are contractually required to survive, because each step up multiplies the bill and everything past the zone adds delay that no engineering removes. Zones are where most systems should stop: they are cheap, replicate in step, and cover the failure that actually happens. A second region covers the rare regional outage, and costs what is listed below.

- **Surviving copies need headroom** They must absorb the lost one's load, so size for that or the failure cascades.
- **Replication lag means a nonzero recovery point** Write it down as a number and alert on lag against it.
- **A failover path you never run is a plan** Exercise it on a schedule.
- **Two writers in two regions have no clean fix** Partition records by key, one home each, or agree a merge rule first.

**Example.** You run 3 zones, each able to serve 100 requests a second. Traffic is 240 a second, so each zone carries 80. A zone fails, and the other two must carry 120 each. Both pass 100, queue up and fail, and the outage spreads. At 180 a second, each zone carries 60, and after a failure 90 each is survivable. The cost is that 300 of capacity serves at most 200 safely, so a third of what you pay for sits idle until the day you need it.

## The capabilities
<!--meta block=capabilities-->

- **Region** — A named geographic area with its own datacenters, its own service catalog and its own copy of whatever you put there. It is the choice you make first, because it fixes your latency to users, your legal jurisdiction and which services you can use at all.
- **Availability zone** — One or more datacenters inside a region whose power, cooling and network are independent of every sibling zone, and close enough that a round trip between them stays in single-digit milliseconds. This is the sweet spot of the whole ladder: far enough apart to survive losing a building, close enough to replicate synchronously.
- **Anti-affinity within a datacenter** — A guarantee that two of your instances do not land on the same rack, switch or power feed inside one zone. It costs nothing beyond the instances you were already running, and it removes the failure people misread as bad luck: two servers dying in the same minute because they shared one piece of hardware.
- **Planned-maintenance batching** — A grouping the platform updates one part at a time when it patches the hosts underneath you. Without it, a planned update can restart every instance you own inside the same window — an outage you scheduled without knowing it.
- **Zonal versus zone-redundant services** — Two different deals sold under one product name: a zonal deployment lives in a single zone and leaves the redundancy to you, while a zone-redundant one is spread across zones by the platform. Check which one you bought before you count it as redundant, because the console usually shows the same service name for both.
- **[Cross-region data replication](../patterns/distributed/coordination/replication.md)** — Copies of your data kept in a second region, almost always asynchronously, because a synchronous write across a continent is too slow to sit inside a request. The replication lag is your recovery point: whatever has not shipped when the first region goes is what you lose.
- **Statically paired regions** — A fixed partner region the platform assigns to a region, used to stagger platform updates across the pair and to give some services a default replication target. Only one of the three clouds offers it, so a recovery plan that leans on the pairing has to be rewritten before it moves.
- **Multi-region active-passive** — A second region that holds your data and enough of your stack to take traffic, but serves none of it until you fail over. It is the cheapest answer at region scope, and its risk sits entirely in the switch: a failover path you never exercise is a plan, not a capability.
- **Multi-region active-active** — Two or more regions serving live traffic at once, with each user routed to the nearest. It takes failover off the critical path and hands you the harder problem in exchange — two places accepting writes for the same data, which you must partition or reconcile.
- **Global versus regional resources** — Some resources exist once for the whole account and some exist once per region, and the split is not the same on any two clouds. It decides what you must recreate in every region you enter and what you configure once, which is the difference between a two-day region rollout and a two-month one.
- **Metro and carrier edge locations** — Small extensions of a parent region placed in a metro area or inside a mobile operator's network, running a subset of services a few milliseconds from the users there. Reach for them when compute or state must sit near the user; cached bytes belong on a [content delivery network (CDN)](../patterns/distributed/routing/cdn.md) instead.
- **Data residency and sovereign boundaries** — Constraints on where data may be stored and processed, ranging from choosing an in-country region to running in a separate partitioned cloud with its own identity system and its own endpoints. Placing the compute is the easy half; the leak is the managed services around it, whose control plane, logs or backups may live somewhere you did not choose.

## What each cloud calls it
<!--meta block=mapping-->

| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Geographic area | Region | region | region | no direct open-source equivalent |
| Isolated datacenter group within a region | Availability Zone | availability zone | zone | no direct open-source equivalent |
| Zone-spanning deployment of a managed service | Multi-AZ deployment | zone-redundant deployment | regional resource | Kubernetes topology spread constraints |
| Anti-affinity within one datacenter | spread placement group | availability set, fault domains | spread placement policy | no direct open-source equivalent |
| Planned-maintenance batching | no named construct | update domain | no named construct | no direct open-source equivalent |
| Statically paired disaster-recovery region | no equivalent | paired region | no equivalent | no direct open-source equivalent |
| Stable cross-account zone identifier | Availability Zone ID | logical-to-physical zone mapping | not needed — zone names are already physical | no direct open-source equivalent |
| Scope of the virtual network | VPC is regional | virtual network is regional | VPC is global, subnets are regional | no direct open-source equivalent |
| Metro edge extension of a region | AWS Local Zones | Azure Extended Zones | no first-party equivalent | no direct open-source equivalent |
| Cloud-managed hardware in your own datacenter | AWS Outposts | Azure Local, formerly Azure Stack HCI | Google Distributed Cloud | no direct open-source equivalent |
| DNS-based failover between regions | Route 53 health checks and failover routing | Azure Traffic Manager | Cloud DNS routing policies | PowerDNS with health checks |
| Single global anycast entry point | AWS Global Accelerator | Azure Front Door | global external Application Load Balancer | no direct open-source equivalent |
| Isolated cloud for US government workloads | AWS GovCloud (US) | Azure Government | Assured Workloads — controls on the same regions, not a separate cloud | no direct open-source equivalent |
| Presence in mainland China | AWS China Regions, operated by local partners | Azure China, operated by 21Vianet | no first-party equivalent | no direct open-source equivalent |

## Choosing between them
<!--meta block=choosing-->

Pick the scope from the failure you are required to survive, not from the worst one you can imagine. Each rung of the ladder multiplies the bill, and past the zone it also adds latency you cannot engineer away. Two instances behind a [load balancer](../patterns/distributed/routing/load-balancer.md) in one zone is a real answer for a system whose users tolerate an hour of downtime a year; three zones in one region is the answer for most of the rest.

| If you need… | Choose | Because |
| --- | --- | --- |
| To survive one machine dying | Two or more instances behind a load balancer | Cheapest step up from one, and it covers the failure that actually happens most |
| To survive a rack, a switch or a power feed | Anti-affinity across fault domains in the zone | Costs nothing beyond the instances you already run, and it stops two of them sharing one failure |
| To survive losing a datacenter | Three zones in one region | Zones fail independently, and the round trip between them is short enough to replicate synchronously |
| To survive losing a region | A second region, running warm | The only scope a region-wide outage cannot reach; the price is a second copy of the data |
| To serve two continents with low latency | Active-active regions, partitioned by user | Each user's writes land near them, instead of every request paying a transatlantic round trip |
| To keep data inside a legal boundary | An in-boundary region, plus an audit of every dependent service | Compute placement is easy to control; the managed services around it are where residency leaks |
| To reach a metro your nearest region does not cover | A metro edge location tied to that region | Puts compute a few milliseconds from those users without you operating a datacenter there |

Two details decide whether the design you drew is the design you deployed. The first is whether each managed service in it is zonal or zone-redundant — the same product name often offers both, and a zonal database under a three-zone application tier gives you a three-zone diagram with a one-zone failure scope. The second is the paired-region construct, which exists on one cloud and has no counterpart on the other two: it pairs most regions statically, keeps the partner a substantial distance away inside the same geography, and staggers platform updates so both halves are never updated at once. A recovery plan that assumes any of those three properties stops being true the day you move it, so if you expect to move, deploy each region as one repeatable unit — a [deployment stamp](../patterns/distributed/routing/deployment-stamp.md) with the region as a parameter — rather than as a set of resources somebody clicked into place.

The cost of spanning zones is not only the extra instances. Traffic between zones is metered per gigabyte on some clouds and free on others, so a chatty pair of services split across three zones can pay more in transfer than in compute; keep the chatty pair together and span the tier that talks less. Failover carries a capacity bill of its own, because the surviving zones must absorb the load of the one that went — size for that, or [partition around the limit](../principles/partition-around-limits.md) you will otherwise hit, and expect a [cascading failure](../hazards/cascading-failure.md) a few minutes after the event you thought you had survived. Automatic failover also needs a signal you trust: a [health endpoint](../patterns/distributed/resilience/health-endpoint.md) that checks its dependencies, not one that returns 200 while the database behind it is unreachable.

Active-active raises the cost the other shapes let you defer. Two regions accepting writes for the same record is [split-brain](../hazards/split-brain.md) by design rather than by accident, and redundancy does not resolve a conflict you never decided how to resolve. There are two honest answers: [shard](../patterns/distributed/routing/sharding.md) the keyspace so each record has exactly one home region and cross-region traffic is a read, or pick a merge rule the data can actually tolerate and write it down before the first conflict arrives. Choosing neither means choosing whichever write happened to land last, which is a decision either way.

## What does not port
<!--meta block=portability-->

- **Zone identifiers are per-account aliases on some clouds**: the zone named "a" in your account and the zone named "a" in another account can be different physical places, because the name is a per-account alias over the physical zone. Capacity planning or cost splitting that joins two accounts on the zone name is comparing different buildings — use the stable physical identifier where the provider publishes one.
- **Zonal and zone-redundant hide behind one product name**: the same managed service is often sold in both shapes, and only one of them survives losing a zone without you doing anything. This is the single most misread thing in the area, and it is usually discovered during the outage rather than during the review.
- **Not every region has zones**: on at least one cloud some regions offer no availability zones at all, and elsewhere the zone count per region varies. "Deploy across three zones" is not a portable instruction, so make the zone count a parameter of the deployment rather than a constant in the diagram.
- **The paired-region construct exists on one cloud only**: static pairing, guaranteed distance within a geography, and staggered platform updates across the pair come as a package on one provider and not at all on the other two. A disaster-recovery design that leans on any of the three has to be redesigned from scratch to move, not translated.
- **Cross-zone traffic is billed on some clouds and not others**: on at least one provider every gigabyte crossing a zone boundary is metered in each direction, which turns a zone-spanning architecture into a line item as well as an availability decision. Price the chattiest path across the boundary before you draw it, because the topology is far more expensive to change later than to choose now.
- **A region that exists is not a region where your service exists**: region counts differ, and within a cloud the newest services reach the largest regions first and the smallest regions late or never. Check every service in your stack against the target region before you commit to it, or you will discover the gap after the network and identity work is already done.
- **A zone is not a building**: every provider defines a zone as one or more datacenters, so the number of zones tells you how many independent failure domains you get and nothing about how far apart they are. Read the provider's own statement about distance and independence if the difference matters to your regulator, and never infer physical separation from a zone count.
- **Sovereign and government clouds are separate partitions, not extra regions**: they carry their own identity system, their own endpoints, their own resource identifiers and a service catalog that lags the commercial one. Code that hard-codes an endpoint or an identifier format works in the commercial cloud and fails there, so treat the partition as a second cloud you are porting to.

## Patterns it implements
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Make Everything Redundant](../principles/redundancy.md) — The failure-scope ladder is what decides how far apart the copies have to be.
- [Analyse Failure Modes](../principles/failure-mode-analysis.md) — Each rung of the ladder — host, rack, datacenter, region — is a failure mode to decide about in advance.

**Implements**

- [Deployment Stamp](../patterns/distributed/routing/deployment-stamp.md) — A stamp per region or zone is how multi-region deployments are actually cut.
- [Failover](../patterns/distributed/coordination/failover.md) — Multi-zone managed services promote a standby in another zone without a person in the loop.
- [Geode](../patterns/distributed/routing/geode.md) — A global anycast entry point sends each request to the nearest healthy region.

<!-- relationships:end -->
