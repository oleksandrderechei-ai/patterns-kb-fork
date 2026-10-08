---
title: Fallacies of Distributed Computing
description: "Eight false assumptions about networks, each with the design habit that replaces it"
area: principles-systems
owner: Oleksandr Derechei
tags: [resilience, availability]
status: stable
aliases: [eight fallacies, Deutsch fallacies, network fallacies]
solves: [my code works on my laptop and falls apart when the services run on separate machines, a remote call hangs forever and takes every thread that made it down too, a page needs a dozen calls to other services and feels slow even though each one is fast, we hard-coded the address of another service and it broke when the instance moved, an internal call was never encrypted because everyone on the network was trusted]
---

# Fallacies of Distributed Computing

Eight assumptions that hold on one machine and are false across a network: it is reliable, latency is zero, bandwidth is infinite, it is secure, the topology never changes, there is one administrator, transport costs nothing, and the network is homogeneous. A design that leans on any of them works in a test and fails in production.

## What it says
<!--meta block=description-->

Peter Deutsch and colleagues at Sun Microsystems listed seven false assumptions that programmers new to distributed systems make, and James Gosling added an eighth. Each is something a local call gives you for free and a remote call does not. The list is a checklist of what your code silently relies on. The misreading is that these are network problems for the network team: each fallacy taken as true hides a decision you then never make.

## Explained
<!--meta block=explain-->

The fallacies are eight things a local function call gives you for free that a call across a network does not: it can fail, it takes time, it has limited capacity, it can be watched or forged, its route changes, other people run parts of it, it costs money to use, and the machines at each end differ. Peter Deutsch and others at Sun listed seven of them and James Gosling added the eighth. Use them as a review checklist when you add a remote call, ahead of [failure mode analysis](./failure-mode-analysis.md), which then takes each answer further. The defaults they demand: a deadline on every call so a hang becomes an error, retries only for work that is safe to repeat, batched calls, only the fields needed, an authenticated and encrypted hop, peers looked up at call time, and versioned contracts.

- **Every defence is code you maintain.** Skip it on a link that cannot fail the way you fear, such as two processes on one host.
- **Deadlines need choosing.** Pick each from the caller's own budget, and design the page or response to survive a missing piece.
- **Batching and parallel calls add complexity.** Count calls per request first, and batch only on the hot path.

**Example.** A product page makes 12 sequential calls, each 25 ms, and no deadline beyond a 30 s client default. It takes 300 ms when quiet. Then one of the 12 services starts hanging, and each request reaching it holds a thread until that 30 s default gives up. At 10 page requests a second, 200 threads are all stuck within 20 s and every page fails, with a pool of 200 threads. A 100 ms deadline on each call turns the hang into a fast error and a page missing one panel. Running 4 calls in parallel cuts the quiet-day time from 300 ms to about 225 ms. The cost is choosing deadlines and designing for a missing panel.

## Why it helps
<!--meta block=rationale-->

Each fallacy fails the same way: the code is correct on the machine where it was written and wrong across a network, and nothing in the code says so. A call that never times out works until the day a peer hangs, and then every thread that made the call waits behind it. The defect is not in the call. It is in the assumption the call carried, and a test environment on one laptop cannot expose it.

Naming the assumptions turns each into a question you can ask in review: what happens here when the reply is lost, slow, large, forged or in the wrong format? That is the same question [Failure Mode Analysis](./failure-mode-analysis.md) asks of a whole system, and the fallacies are a short list to start it from. They also explain why some failures arrive together. A missing timeout plus an unbounded retry loop is the first fallacy applied twice, and it is how a [Retry Storm](../hazards/retry-storm.md) starts.

## Applying it
<!--meta block=applying-->

Turn each fallacy into a default in the code you write:

- Give every remote call a deadline picked from the caller's own budget, not the callee's best day: start from the callee's p99 latency plus a margin, cap it at the caller's remaining budget, and pass what is left to downstream calls. A [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) turns an unbounded wait into a failure you can handle.
- [Retry](../patterns/distributed/resilience/retry-backoff.md) with a cap on attempts, exponential backoff with jitter, and a retry budget set as a share of normal traffic, and only where repeating the call is safe; send an idempotency key for work that is not. An unlimited immediate retry multiplies load on a service that is already struggling.
- Count the remote calls on your hottest path and put the number in the design. Ten sequential calls at 20 ms each is 200 ms before any work happens.
- Return only the fields and rows the caller asked for, and set a page size. A response that grows with the data will one day exceed the link or the memory on either end.
- Authenticate and encrypt every hop that leaves the host, including internal ones, and give each caller only the access it needs.
- Resolve addresses at call time, through DNS or a [registry](../patterns/distributed/routing/service-discovery.md), and expect them to change; do not bake addresses into builds. Check resolver TTL and connection-pool lifetime so a moved peer is picked up.
- Write the contract down, version it, and test a new caller against an old callee and the reverse.
- Assume every call can fail in the middle. Where the work spans several services, that means asking which of them are still allowed to hold locks or reservations and for how long; [Minimize Coordination](./minimize-coordination.md) covers the rest.
- Treat every dependency you do not run as having its own change schedule and limits: agree rate limits and notice of change, and count egress and per-call cost beside the call count.

The compact test: for each remote call, can you say what the caller does when the reply is lost, late, huge, forged or unreadable?

## Taken too far
<!--meta block=overreach-->

Treating every fallacy as an emergency produces a system armoured against failures it will never see. A retry layer, a circuit breaker, a cache, an encrypted channel and a schema registry on a call between two processes on the same host is cost with no matching risk. The assumptions are false in general, and a given link may still be reliable enough, fast enough and trusted enough that the cheap design is the right one.

Price each habit against the call it protects. A batch job that runs nightly and can simply rerun does not need the retry budget of a payment path. An internal call that crosses one switch in one rack does not need the same compression and pagination as a mobile client on a weak link. Put the defences on the calls where a failure costs money or an outage, and keep the rest plain.

The list is also from 1994 and 1997, and it is not complete. It says nothing about partial failure of storage, clock drift or a dependency that answers wrongly instead of not at all. Use it as a starting set of questions and extend it with what your own incidents teach.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Analyse Failure Modes](./failure-mode-analysis.md) — The fallacies are the starter list of questions; failure-mode analysis carries them across the whole system.
- [Minimize Coordination](./minimize-coordination.md) — Every remote agreement pays latency and failure costs the fallacies hide.
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — The first and second fallacies demand a deadline on every remote call.
- [Identity Is the Perimeter](./identity-as-perimeter.md) — The fourth fallacy, a secure network, is why location cannot grant access.
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — The capped, jittered retry the second habit asks for is this pattern
- [Service Discovery](../patterns/distributed/routing/service-discovery.md) — Topology never changes is false, so peers are looked up at call time

**Prevents**

- [Retry Storm](../hazards/retry-storm.md) — Treating the network as reliable gives unbounded retries with no deadline.

<!-- relationships:end -->
