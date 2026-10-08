---
name: kb-compose
description: "Compose a component-level solution from the KB: from one sub-problem's FRs, NFRs and CAP stance, return the minimal pattern set with adopted, rejected and deferred verdicts and cited ids. Use when asked to \"design this component\", \"make this part resilient\", or \"which patterns satisfy these requirements\". Not for a whole system (sys-design)."
---

# Composing a component from the KB

**The deliverable is a component brief: one bounded piece of a larger system, solved by
the smallest pattern set that satisfies the stated FRs, NFRs and CAP stance.** Every
adoption traces to a requirement; every rejection cites the con that killed it; and the
brief ends with the conditions under which the answer changes. The corpus is millions of
tokens — never open a page file (`docs/**.md`, or the HTML `make site-build` writes).
Everything goes through `scripts/kb.mjs`, and a full brief costs about 2–3k tokens of
reading. The brief is technology-agnostic end to end: pattern names and capability-level
language ("a durable log", "a coordination service"), never a vendor, product or
managed-service name — mapping the roster to real services is a downstream skill's job,
and the roster table is its clean input.

## The loop

1. **Frame the sub-problem.** Restate it before searching: FRs (3–5, what the component
must do), NFRs with numbers (latency, availability, durability, scale), and the
CAP/PACELC stance — chosen deliberately, not inherited by default. If the ask is vague
("make it resilient"), ask one round of questions to pin the numbers; a verdict cannot
route to a requirement that was never stated. Everything downstream carries a routing
tag back to this list: `→ FR: label.` or `→ NFR: label.`

2. **Seed one search per requirement.** Use the failure words a sufferer would type, not
pattern vocabulary — `solves` phrases are written as symptoms. Scope with `--tag`,
`--band` or `--kind` when the territory is obvious.

```
node scripts/kb.mjs find "every order must survive a crash between DB write and publish"
node scripts/kb.mjs find "reads overwhelm the primary" --tag caching
```

Collect the top candidates per requirement. Hazards surfacing here are requirements in
disguise — "cache stampede" arriving as a hit means the brief must guard it.

3. **Branch on the governing theme.** Find the theme that owns the central tension —
`cap-theorem`, `consistency-and-replication`, `scaling-writes`, `resilience`,
`dealing-with-contention`, … — and read its steering blocks:

```
node scripts/kb.mjs get cap-theorem --block decide       # "If you need… | Lean | Reach for"
node scripts/kb.mjs get cap-theorem --block tradespace   # the argument behind the table
```

The `decide` table is the steering wheel: each row is a requirement profile and the
patterns it selects. When an NFR changes, a different row applies — note which row you
took and which rows you rejected, because they become the sensitivity list.

4. **Expand the frontier.** One call per seed candidate gives the composition edges, the
hazards it prevents, and the alternatives:

```
node scripts/kb.mjs related outbox
```

`Combines with` fills the roster, `Prevents` names the guards, `Alternative to` supplies
the load-bearing rejections. One hop is usually enough; never take more than two — a
roster built three hops from a requirement is decoration.

5. **Judge every candidate.** Read `usage` for every candidate and `tradeoffs` for the
finalists — rarely the whole page:

```
node scripts/kb.mjs get outbox --block usage
node scripts/kb.mjs get outbox --block tradeoffs
```

Three verdicts, reason on the same line, routing tag at the end:

- **adopted** — a stated requirement forces this mechanism. `→ NFR: durability.`
- **rejected** — a con violates a stated requirement; cite the con's stable id
  (`patterns/…/saga.md#tradeoffs-con-1`).
- **deferred** — becomes necessary only if a named condition arrives; say which.

A con that violates a stated NFR is an automatic rejection. A pattern no requirement
forces is decoration — drop it, however good the pattern.

6. **Guard the composition.** For each adopted pattern, check the hazards it invites:
the `Prevents` column from step 4 covers what it guards, but the composition itself
creates exposure (a cache invites `cache-stampede`; a retry invites `retry-storm`).
When unclear, read the hazard's `mitigation` block. Every hazard in scope ends the brief
either guarded by a roster member or named as an accepted risk — never silently open.

7. **Deliver the component brief.**

## The component brief

- **Boundary** — one sentence: what is inside the box and what it promises its callers.
  This is what makes the brief reusable as a box in a high-level design, or as the zoom
  of a box that already exists.
- **Requirements** — the FR/NFR/CAP restatement the verdicts route to.
- **Roster** — `| Pattern | Verdict | Why | Cite |`, adopted rows first, then the
  rejections a reader would ask about. Every Why ends in a routing tag.
- **How it composes** — a numbered walk of the happy path across the adopted patterns.
  When the composition has three or more moving parts, add a small mermaid board —
  diagram-draw altitude rules: ≤9 nodes, one question per diagram.
- **The bill** — what the composition costs, taken from the cited cons: consistency
  given up, operational surface added, latency added. Figures and mechanisms, not
  adjectives.
- **Sensitivity** — 2–5 bullets, `If <condition changes> → <alternative>`, each naming
  the concrete pattern(s) that replace a roster row and the decide-table row or cited
  tradeoff that flips. This section is mandatory: a brief with no flip conditions means
  the requirements were never load-bearing.

## Worked example

> ❌ "For the order write path use CQRS, event sourcing, saga and the outbox pattern —
> this gives a robust, scalable design."

> ✅ **Boundary**: accepts order writes, guarantees every accepted order is durably
> recorded and its event published at least once.
> **Requirements**: FR publish an event per state change; NFR 2k writes/s, no lost
> events; AP within the region.
> **Roster**: outbox — adopted, removes the dual-write gap
> (`patterns/distributed/coordination/outbox.md#description`) `→ NFR: no lost events.`
> distributed-lock — rejected, a stalled holder can be double-granted, breaking no lost events
> (`patterns/…/distributed-lock.md#tradeoffs-con-1`).
> saga — deferred until a second service must commit in the same flow.
> **Sensitivity**: if cross-service atomicity becomes an FR → saga + compensating
> transaction (cap-theorem decide: "Cross-service transaction without a global lock");
> if staleness becomes unacceptable → the CP row: quorum + leader election.

The ❌ names five patterns and routes none of them; the ✅ adopts one, rejects one with
the violated stance, defers one with its trigger, and says what would change the answer.

## What this skill is not

- **Not kb-find.** That skill answers one symptom with one pattern (and its close
  combinations). This one takes a requirement set and returns a justified composition.
- **Not a technology chooser.** No vendors, products or managed services anywhere in
  the brief. When the user asks "what do I actually run", hand the adopted roster to a
  mapping skill ([pattern-tech-map](../pattern-tech-map/SKILL.md) or its successor).
- **Not a whole-system design.** A brief solves one box. A full design with entities,
  interfaces and sizing is a design page — the `system-design-interview` theme and the
  kb-design-* skills own that shape.
- **Not a page author.** The brief is a chat deliverable; nothing under `docs/` is
  written. When a brief should become a design page, hand off to
  [kb-add](../kb-add/SKILL.md) and the kb-design-* block skills.

## Done means

1. Every adopted pattern routes to a stated FR or NFR — no decoration on the roster.
2. Every rejection cites the con or the violated stance that killed it, by stable id
   where one exists.
3. The sensitivity list is non-empty and each bullet names a concrete alternative.
4. Every hazard raised by the search or the composition is guarded or explicitly
   accepted.
5. No vendor, product or managed-service name anywhere in the brief.
6. No page file (`docs/**.md`, or the HTML `make site-build` writes) was opened; every claim
   came through `kb.mjs` and carries its id.
