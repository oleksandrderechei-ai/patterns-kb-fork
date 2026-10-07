---
title: Premature Optimization
description: "Speed work done before measuring, which adds complexity and misses the real bottleneck"
area: hazards
owner: Oleksandr Derechei
tags: [anti-pattern, maintainability]
status: stable
solves: [we hand-tuned a function for speed but the endpoint is still slow and the profiler points elsewhere, the code got hard to read after someone made it faster without any benchmark, we added a cache everywhere just in case and now stale data causes bugs, a clever data structure saved microseconds in a path that runs once per day]
---

# Premature Optimization

You trade clarity for speed before you have measured where the time goes, so you pay the complexity and miss the bottleneck.

## What it is
<!--meta block=description-->

**Premature optimization** is making code harder to read or change for a speed or memory gain that nobody measured and no requirement asked for. It builds up through reasonable instincts: a hand-rolled cache, a denormalised table, a lock-free structure, each added "to be safe". You recognise it when the fastest-looking code sits in a path that runs rarely, while the profiler names a different function.

## Explained
<!--meta block=explain-->

Premature optimization is spending complexity on speed before a measurement says the code is slow. You add a hand-rolled cache, a denormalised table or a lock-free structure because it looks like the slow part, and it pays off only if the guess was right. Often the guess misses: the time goes to a query, a network hop or a serialisation step that you never looked at. Measure first: a profile shows which few functions dominate the time, and a hunch does not. The principle is the same as [YAGNI](../principles/yagni.md): a need you have not shown has not earned its cost. Write the code plain first, so it stays easy to change, and give the one hot spot the profile finds the clever treatment, with a recorded number as the reason.

**Example.** A team rewrites an order-total loop with a lookup table to save 0.2 ms per request. The endpoint's p99 is 900 ms against a 300 ms budget, so the change moves nothing. A trace shows 700 ms in one unindexed query. Adding the index takes the p99 to about 200 ms in an afternoon. The lookup table stays in the code: 140 extra lines, a stale-data bug two months later, and no benefit. The cost of the guess is the wasted week and the permanent complexity. The fix is a written latency budget and a trace before any speed work.

## How it happens
<!--meta block=causes-->

```mermaid caption="The loop: guessed speed work adds complexity, and complexity hides the real hot spot."
flowchart TB
    A["Guess where the system will be slow"] -->|"optimise that code first"| B["Harder code in a path that is not hot"]
    B -->|"harder to read and profile"| C["The real bottleneck stays hidden"]
    C -->|"production is slow somewhere else"| D["More guessing under pressure"]
    D --> A
```

- **Intuition about speed is often wrong.** Developers guess the slow path from how the code looks, and the real cost sits in a query, a network hop or a serialisation step they never considered.
- **Performance feels like rigour.** Reviewers credit a clever data structure and ignore a plain loop, so cleverness wins.
- **No target exists.** With no latency or throughput budget written down, "fast enough" has no definition and the work never has a stopping point.
- **Profiling is skipped because it is slow to set up.** Without a benchmark harness or production tracing, a guess is cheaper than a measurement.
- **Fear of a later rewrite.** Teams assume that speed cannot be added afterwards, so they spend complexity up front on a need that may never arrive.

## What it costs
<!--meta block=cost-->

- **Every optimisation is permanent complexity.** The cache needs invalidation, the denormalised copy needs syncing, and the hand-tuned loop needs a comment that the next reader must trust.
- **The real bottleneck survives.** Speeding up code that takes 2% of a serial request cannot lower latency by more than 2%.
- **Changes slow down.** Code tuned for one access pattern resists the next feature, because the structure encodes assumptions that no longer hold.
- **Bugs move into the hard places.** Caches, threads and hand-managed memory hide the subtle defects, and code that did not need them now carries them.
- **The speed-up can be negative.** A change that is faster in a micro-benchmark can lose on the real workload because of cache misses, contention or extra allocation.

## Getting out
<!--meta block=mitigation-->

Write the plain version first and put a number on "fast enough" before you touch it. A latency budget, such as a p99 of 300 ms for one endpoint, tells you when to stop, and a load test tells you whether you are inside it. Take the budget from the user-facing target and set the endpoint's share beneath it.

When the budget is missed, profile the real workload and fix the largest cost first. Change one thing, measure again, and keep the change only if the number moved. A profiler flame graph or a distributed trace usually shows one or two hot spots, and they are rarely the ones the team suspected. Keep a change only if the gain is larger than the run-to-run variation across repeated runs.

Keep the optimised code honest afterwards. Put the measurement that justified it in a comment or the commit message, and add a benchmark that fails if the gain disappears. An optimisation with no recorded number is a candidate for deletion at the next refactor.

Donald Knuth's often-quoted line carries a second half that gets dropped: forget small efficiencies about 97% of the time, but do not pass up the critical 3%. The hazard is optimising before you know which 3% it is.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Spaghetti Code](./spaghetti-code.md) — Tangled, hand-tuned code is harder to untangle than plain code

**Mitigated by**

- [Distributed Tracing](../patterns/distributed/resilience/distributed-tracing.md) — Measure first: a trace names the slow step before anyone rewrites code
- [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) — Skip the speed-up until a requirement or a measurement asks for it
- [Keep It Simple (KISS)](../principles/kiss.md) — Simple code is the default, and a hand-tuned structure has to show its gain

**Threatens**

- [Lock-Free](../patterns/concurrency/lock-free.md) — Complex lock-free structures are built for a contention nobody measured
- [Double-Checked Locking](../patterns/concurrency/double-checked-locking.md) — A subtle memory-model trick added to save a lock that was never the bottleneck
- [In-Process Cache](../patterns/caching/in-process-cache.md) — A hand-rolled cache adds staleness and invalidation to a path that was fast enough

<!-- relationships:end -->
