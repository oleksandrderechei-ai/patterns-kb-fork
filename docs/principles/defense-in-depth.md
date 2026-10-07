---
title: Defense in Depth
description: "Independent layers of protection, so one failed or bypassed control is not a breach"
area: principles-systems
owner: Oleksandr Derechei
tags: [security, boundaries]
status: stable
aliases: [layered security, layered defence]
solves: [one leaked credential or one missed check on one endpoint gave an attacker access to everything, we trust the firewall and nothing inside the network checks who is calling, a new service shipped without its own access check and relied on the gateway to filter, "a bug in one security control would expose our data, and nothing else would stop it"]
---

# Defense in Depth

Stack several independent protections between an attacker and what you guard, so that when one fails or is bypassed the next still holds. No single control has to be perfect, because a breach needs every layer to fail at once.

## What it says
<!--meta block=description-->

Instead of one wall, give an attacker a series of obstacles, each costing time and each able to be noticed. No single check, whether firewall, login or input filter, is all that stands between a request and your data; each layer assumes the one before it was fooled. More layers does not mean more security: five layers sharing one library, credential or misconfigured rule are one layer counted five times. Independence is what counts.

## Explained
<!--meta block=explain-->

Defence in depth puts several separate protections between an attacker and what you guard, so that no single failure is a breach. A request is checked by the network, then by an identity check, then by an access check inside the service, then by validation of its input, and finally by limits on what the data store will return. Choose it over one strong perimeter when a mistake in any single control would be costly, because every control has a failure rate you cannot bring to zero. Its value is independence: layers that share a credential, a library or a trusted header fail together and count as one. Each layer has a cost and a counter-move. Latency and double maintenance grow with each, so make each layer check something the others do not. A team that trusts the count maintains each layer less, so test every layer with the ones in front of it switched off. Layers that block without a signal teach the attacker, so alert at each one.

**Example.** A shop has a gateway that checks login tokens, and its order service trusts any call that arrives from the gateway. A new internal report endpoint is deployed without the gateway rule. With one layer, anyone on the network can read all 40,000 orders. With the order service checking the token and the caller's role itself, the same call is refused, and the refusal raises an alert in under a minute. The extra check adds about 2 ms per request and a second place to change when roles change.

## Why it helps
<!--meta block=rationale-->

Every control has a failure rate you cannot drive to zero. Firewall rules are misconfigured, credentials leak, a new endpoint ships without its check, and a library has a flaw nobody has found yet. If one control stands alone, its failure rate is the system's breach rate, and the first mistake is the last line of defence.

With layers the maths changes: a breach needs the layers to fail together, so independent layers multiply their failure rates instead of adding them. Two controls that each fail one time in a hundred fail together about one time in ten thousand, but only if one failure does not cause the other. The layer behind also catches what the layer in front was never built to see, such as a valid employee account used for the wrong purpose, which a perimeter cannot tell apart from a legitimate user.

Layers give you time and evidence as well. An attacker who must beat several controls touches several places that log, so the attempt is more likely to be seen while it is still in progress. A single control that fails quietly gives you nothing to see.

## Applying it
<!--meta block=applying-->

Pick layers that fail for different reasons and check each one stands alone:

- Authenticate and authorise at every service, not only at the edge. Check the caller's identity where the work is done, as [Identity as Perimeter](./identity-as-perimeter.md) argues, so a request that slips past the gateway still meets a refusal.
- Validate input again at each trust boundary, using the same rules or stricter ones. An [Intercepting Validator](../patterns/security/intercepting-validator.md) at the edge does not excuse the service that stores the value.
- Give each component the least access it needs, so a breach of one yields little. [Least Privilege](../patterns/security/least-privilege.md) bounds what one stolen credential can reach.
- Segment the network so a compromised host cannot reach every other host. The segment is a cheap layer that limits movement, and it is not what grants permission.
- Encrypt data at rest and in transit with keys held apart from the data, so reading storage is not enough to read the data.
- Log and alert at every layer. A layer that blocks silently teaches the attacker; a layer that blocks and raises an alert starts your response.
- Test each layer with the layers before it switched off. If the service only works safely when the gateway filters its input, it is not a layer, it is a dependency.

The compact test: for each control, can you say what it still stops when the one in front of it has been bypassed?

## Taken too far
<!--meta block=overreach-->

Layers have a running cost, and past a point each new one buys less than it costs. Every check adds latency, a configuration to keep correct and a place for a legitimate user to be refused. A request that passes four near-identical validations pays four times for one assurance, and a change of rule now has to land in four places. The cost shows up as slower releases and as incidents caused by the defences themselves, such as an overly strict rule that blocks real traffic during an outage.

The worse failure is false confidence. A team that knows three layers exist stops treating each as essential, so each is maintained a little less carefully and the combined strength is below what the count suggests. Layers that quietly depend on one another, such as every service trusting a header set by the gateway, collapse together the day the gateway is bypassed.

Keep the layers that stop different failures and drop the ones that repeat each other. Review the set after each incident: if an attacker or an error passed through three layers at once, those layers were not independent, and the fix is to make one of them check something the others do not.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Multi-Tenancy](../patterns/distributed/routing/multi-tenancy.md) — Tenant isolation is a worked case of layered controls.
- [Make Everything Redundant](./redundancy.md) — Both need independence between the parts, controls here and copies there.
- [Identity Is the Perimeter](./identity-as-perimeter.md) — A per-service identity check is one independent layer.
- [Single Access Point](../patterns/security/single-access-point.md) — A hardened front door is one layer; depth assumes someone gets past it.
- [Least Privilege](../patterns/security/least-privilege.md) — Least privilege limits what one breached layer yields.
- [Intercepting Validator](../patterns/security/intercepting-validator.md) — Validate again at each trust boundary.
- [Agent Sandboxing](../patterns/security/agent-sandboxing.md) — An agent boundary is a worked layer for a non-human actor.

<!-- relationships:end -->
