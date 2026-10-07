---
title: Boat Anchor
description: Dead code or hardware kept around unused
area: hazards
owner: Oleksandr Derechei
tags: [anti-pattern, code-smell, maintainability, readability]
status: stable
solves: [nobody can explain what breaks if we delete this module, "a server is racked, patched and monitored but has served no traffic for a year", "code marked do not remove, may be needed later, with no ticket or owner", a search for callers turns up nothing yet nobody dares delete the file]
---

# Boat Anchor

Dead code or disused hardware kept around unused — not because anyone still needs it, but because nobody is willing to be the one who removes it.

## What it is
<!--meta block=description-->

A boat anchor is a component that stays in the system long after it stopped earning its keep: a module with no callers, a flag nobody has flipped in years, a deprecated server still patched while its traffic graph reads zero. You recognize it by a comment like DO NOT REMOVE, may be needed later, with no owner or date. The defining trait is a missing decision: nobody chose to keep it and nobody chose to remove it.

## Explained
<!--meta block=explain-->

A boat anchor is a component that stays in the system long after it stopped being used, such as a module with no callers, a flag nobody has flipped in years, or a server racked and patched while its traffic graph reads zero. It survives by default. Blame is asymmetric: a deletion that breaks something has a name on it, while a box costing money every month has none, so fear of regret beats checking. Flip the default: removal happens on a dated schedule unless someone shows evidence of use. Pay for being wrong in stages, so a path nobody instrumented announces itself while the revert is cheap: fail the calls for a week, then stop the process, then delete. Remove a big one slice by slice behind a routing layer, and give that layer its own removal date. Better still, build nothing for later, and add the option the day a caller exists.

- **Running cost.** It burns money for power and licences, and attention in every refactor and patch cycle.
- **Patching lags.** Nobody owns it, so it can carry known vulnerabilities. Put it on the normal patch schedule or remove it.

**Example.** A team runs a legacy report server at 400 dollars a month. Its access log, which keeps only the last 30 days, shows zero requests, and nobody will delete it. The owner announces removal in 30 days unless someone claims it. On day 30 the server's calls start to fail for a week, and one finance script, run only each quarter, breaks and is moved to the new service. Then the process is stopped for another week, and finally deleted. Keeping it for the year cost 4,800 dollars plus every patch cycle. The fix cost two weeks of staged steps and one broken script.

## How it happens
<!--meta block=causes-->

```mermaid caption="A reinforcing loop, not a single decision. The longer it survives unexamined, the more removing it looks like the risky move."
flowchart TB
    A["Feature or service is replaced"] -->|"kept just in case"| B["Old code or box left in place"]
    B -->|"no owner assigned to verify"| C["Nobody confirms it is safe to remove"]
    C -->|"context and callers fade"| D["Remaining usage is forgotten"]
    D -->|"removal now feels risky"| E["Leaving it looks safer than cutting it"]
    E -->|"so it stays"| B
```

- Sunk cost: real effort built it, so deleting it feels like admitting that effort was wasted.
- Fear substitutes for verification: "it might still be used" beats confirming zero callers or zero traffic.
- No deprecation process with a hard removal date, so "we'll clean it up later" never arrives.
- Dead-code and dead-traffic detection isn't run, so the thing is invisible until someone happens to grep for it.
- Hardware, licenses, or contracts were already paid for, so keeping them running feels free even though it isn't.
- The original owner left or moved teams, and no one inherited the authority to decide it's safe to cut.

## Why it hurts
<!--meta block=cost-->

- **It keeps costing money.** Racked hardware still draws power and cooling; unused services still consume compute, licenses, and support contracts, all paid indefinitely.
- **It keeps costing attention.** Refactors, migrations, and code reviews still have to account for it, and security patching still has to cover it.
- **It misleads by presence.** Its mere existence implies relevance, so engineers build around it, avoid touching adjacent code out of caution, or waste time reverse-engineering what it's for.
- **It quietly rots.** An unused service or dependency still collects unpatched vulnerabilities, because nobody treats it as in use.
- **It normalizes the next one.** Once one boat anchor survives unexamined, "we never delete anything here" becomes the default answer, and the pile only grows.

## How to avoid it
<!--meta block=mitigation-->

The cheapest anchor is the one you never build. When someone asks for a flag, a hook or a service "for later", ship the version without it and add it the day a caller exists — an option nobody called is the thing that becomes undeletable. For what already exists, delete it outright rather than commenting it out, because a copy left in the file is a copy every reader still has to account for.

Something too big to delete in one commit comes out slice by slice. Put a routing layer in front of it, move one slice of callers to the replacement, and delete that slice's code once its counter reads zero. Each step is small enough to revert until that slice's code is deleted, so delete only after the counter has read zero for an agreed period. The old thing shrinks on a schedule instead of waiting for one decision nobody wants to sign. Keep those removals in the same backlog as the feature work, or the last slice never comes out.

Give the removal machinery its own removal date. The routing layer and the compatibility shim you added to retire something are anchors in waiting, and they carry the best excuse for staying. Treat the sweep as a standing job rather than a cleanup sprint, too: a scheduled pass that assigns owners and dates keeps the pile from growing when every item has a named owner and a removal date that applies if the owner is missing, while a one-off purge tends to be followed by regrowth.

Find candidates before you sweep: count callers and traffic per component and attribute spend to an owner, so zero use shows without a grep. Hold each removal stage longer than the slowest known caller cycle, such as a quarter or year-end, or a rare job passes unseen and breaks after deletion.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Lava Flow](./lava-flow.md) — Both are dead code kept out of fear; a boat anchor was built on purpose and never removed, lava flow is accidental residue nobody can explain. Often found together.

**Mitigated by**

- [Strangler Fig](../patterns/distributed/coordination/strangler-fig.md) — Retire dead legacy slice by slice
- [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) — Build only what is needed now and there is no speculative code left to fossilise
- [Record Architecture Decisions](../principles/architecture-documentation.md) — A dated record of why something was kept makes it possible to tell a live constraint from a dead one

**Threatens**

- [Feature Flag](../patterns/distributed/routing/feature-flag.md) — Flags nobody removes after rollout become permanent dead branches

<!-- relationships:end -->
