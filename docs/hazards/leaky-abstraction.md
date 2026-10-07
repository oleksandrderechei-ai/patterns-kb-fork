---
title: Leaky Abstraction
description: "The abstraction's promise breaks, and the substrate it hid shows through"
area: hazards
owner: Oleksandr Derechei
tags: [modularity, abstraction, maintainability, code-smell]
status: stable
aliases: [law of leaky abstractions, abstraction leak]
solves: ["the library works right up until it does not, and then I have to learn what it was hiding", two queries that return the same rows perform completely differently and the code looks identical, our code treats a remote call like a local one and has no timeout anywhere, debugging this means opening three layers I was told I would never need to understand, "the ORM is fine until a query is slow, and then nobody can explain why"]
---

# Leaky Abstraction

An abstraction promises that what is underneath it does not matter, and then what is underneath it matters — so callers built on the promise meet a failure, or a cost, that their interface gave them no way to talk about.

## What it is
<!--meta block=description-->

A **leaky abstraction** is a simple interface over a lower layer that cannot hide everything, so the layer below shows through when something goes wrong or slow. You recognise it when a failure at the top has its cause two layers down, or when code that treats a remote call as local has no timeout. The defining trait is that callers needed to know what the interface promised to hide.

## Explained
<!--meta block=explain-->

A leaky abstraction is a simple interface that hides a layer below it, but cannot hide everything about it, so the hidden layer shows through when something goes wrong or slow. A reliable data stream over a network still fails when the cable is cut, because its promise covered order and resending, never the cable. Callers are written against the promise: code that treats a remote file as a local one has no timeout and no failure branch, because the interface gave it nowhere to put them. The failure shows at the top while the cause sits two layers down, and the abstraction was sold as saving you from learning that layer, so you now need both. Plugging every leak makes the interface as complicated as what it hides, so ask which leaks you can afford before you depend on it. Write down what the abstraction does not cover. Put substrate failures in the signature, such as a call whose type admits a timeout. Keep an escape hatch to the raw layer where cost matters.

- **Wider interfaces.** Failures in the signature make every caller handle them; expose only the ones callers can act on.
- **Cost leaks.** No signature shows cost, so measure at the boundary.

**Example.** A page lists 500 orders with each customer's name, using an object mapper that loads each customer on first access. On a developer's machine, with 20 orders, that is 21 queries at 2 ms, 42 ms, which nobody notices. In production, 500 orders make 501 queries, about 1 s, while one join would take around 15 ms. The mapper hid that each name lookup is a query. The team adds an explicit join for list pages and alarms when a request runs over 20 queries.

## How it happens
<!--meta block=causes-->

Every leak is an abstraction modelling most of its substrate and quietly not modelling the rest. The happy path exercises the part it got right, so the gap is invisible until production finds the case the model does not cover. The forms below are the recurring ones: some hide something that breaks, some hide something that costs, and some mark where the model ends or stops fitting.

The structural reason they persist is that plugging a leak widens the interface. Report every failure mode the substrate has and the abstraction stops being simpler than the raw thing; report none and callers cannot handle them. Most abstractions settle somewhere in between without writing down where, and the undocumented middle is exactly the surface callers guess at.

```mermaid caption="Step 4 is the whole hazard: the abstraction has no vocabulary for what happened at step 3, so it returns something uninformative, and step 5 is the cost, because understanding the failure means reasoning about a layer the caller was told to ignore."
flowchart LR
    C["Caller, written against the promise"] -->|"1 ordinary call"| A["Abstraction"]
    A -->|"2 delegates"| S["Substrate"]
    S -->|"3 fails or is slow in a way the interface cannot express"| A
    A -->|"4 generic error, or just a long wait"| C
    C -->|"5 debugging has to skip the middle entirely"| S
```

- **A failure mode it cannot prevent.** Reliable delivery over an unreliable network still fails when the network does; the abstraction guaranteed retransmission, not connectivity.
- **A cost model rather than a behaviour.** A declarative query language promises the result and says nothing about the procedure, so equivalent queries differ by orders of magnitude.
- **Remote presented as local.** A file on another machine reads like a local file, so calling code inherits none of the latency or partial-failure handling it needs.
- **A non-uniform substrate presented as uniform.** A flat address space hides paging, so iterating an array along one axis and the other differ enormously while both look identical in the source.
- **The abstraction stops at its own edge.** A string type cannot make two adjacent literals concatenate, because they are not yet its type; the caller hits a boundary the abstraction never covered.
- **Reached for beyond the range it models.** An abstraction that fits one workload gets applied to a second whose substrate behaves differently, which is a [golden hammer](./golden-hammer.md) producing a leak that was never in the original design.

## What it costs
<!--meta block=cost-->

- **Learning time goes up, not down.** Debugging through the abstraction needs the layer beneath it as well, so you now maintain knowledge of two layers where you were promised one.
- **Debugging crosses layers the tooling does not.** The symptom is at the top, the cause is several layers down, and each layer's tools describe only that layer.
- **Estimates are wrong in a predictable direction.** The work looks like one function call and turns out to be that call plus its failure modes plus its cost model.
- **The interface widens anyway.** Callers grow the defensive code the abstraction was meant to make unnecessary, so you end up with the raw thing's complexity and a layer on top of it.
- **Knowledge concentrates in one person.** Whoever last debugged through the leak becomes the only person who can, and that is a dependency nobody chose.

You usually pay the cost either way. Leave the leak and callers meet it unprepared; widen the abstraction until it reports everything the substrate can do and it is as complicated as the substrate, plus indirection. So the useful question is rarely "how do we stop it leaking" but "which leaks does this thing have, and can we afford them". List the leaks in the abstraction's documentation as a first-class section; an author who cannot list them has not finished designing it.

## Getting out
<!--meta block=mitigation-->

Start by narrowing the promise rather than the leak. Write down what the abstraction does not cover, so callers stop treating the gaps as guarantees. Where the substrate can fail, put that failure in the signature: a remote call whose type admits it can time out cannot be forgotten about; one that looks like a local call will be.

Keep the escape hatch open. An abstraction over a query language should let a caller drop to the raw form where cost matters, because the alternative is a workaround pushed through the abstraction, which is slower and harder to read than the thing it was avoiding. Where what leaks is a cost model, no interface change helps: measure at the boundary, because real cost is observable and the interface rarely tells you.

Then choose deliberately. Prefer the abstraction that hides less over the one that hides more but hides it imperfectly, and treat [simplicity](../principles/kiss.md) as the tiebreaker it exists to be. An [anti-corruption layer](../patterns/ddd/acl.md) is an abstraction placed over something hostile, so it leaks by construction; its value is that the leak stays in one reviewed place instead of spreading through the domain.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Golden Hammer](./golden-hammer.md) — Reaching for one abstraction beyond its range creates a leak

**Mitigated by**

- [Keep It Simple (KISS)](../principles/kiss.md) — Prefer the abstraction that hides less over the one that hides more, imperfectly
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — Puts the remote failure mode in the signature, so a caller cannot inherit the local-call assumption
- [Fail Fast](../principles/fail-fast.md) — Surfacing the substrate's failure beats a generic error the caller cannot act on
- [Anti-Corruption Layer](../patterns/ddd/acl.md) — An abstraction over something hostile leaks by construction; the layer keeps the leak in one reviewed place
- [Distributed Tracing](../patterns/distributed/resilience/distributed-tracing.md) — Where the leak is a cost model, per-request time and call counts across layers find it; they do not prevent it

**Threatens**

- [Repository](../patterns/enterprise/repository.md) — It presents a collection but hides queries, latency and failures
- [Data Mapper](../patterns/enterprise/data-mapper.md) — Object access hides the SQL, so cost and failures show through
- [Proxy](../patterns/gof/structural/proxy.md) — A remote proxy makes a network call look local, with no timeout or failure branch

<!-- relationships:end -->
