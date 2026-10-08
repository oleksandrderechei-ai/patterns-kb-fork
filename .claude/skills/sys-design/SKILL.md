---
name: sys-design
description: "Run a full KB-grounded system design — grill the requirements, size it, design entities and API, draft a high-level design with priced tradeoffs, zoom into components, sweep for bottlenecks, pick a stack. Use when asked to \"design a system for X\", \"architect this service\" or \"solve this design kata\". Not for one component (kb-compose)."
---

# Designing a system from the KB

**The deliverable is a design document in which every decision routes to a stated
requirement and every pattern claim carries a KB citation** — assembled through a fixed
pipeline, with the heavy KB reading delegated to subagents so the main context stays
lean. This skill is the conductor: the interview is [grill-me](../grill-me/SKILL.md),
the per-component composition is [kb-compose](../kb-compose/SKILL.md) run inside a
subagent, the diagrams follow [diagram-draw](../diagram-draw/SKILL.md), the stack table
follows [stack-pick](../stack-pick/SKILL.md), and the prose register is
[style-system-design](../style-system-design/SKILL.md) — verdict first, claim + reason,
no unpriced adjectives.

## Context economy

The corpus is millions of tokens and the design conversation is long; both facts are
constraints on *you*, the orchestrator:

- Never open a page file (`docs/**.md`, or the HTML `make site-build` writes). Everything goes
  through `node scripts/kb.mjs`.
- In the main loop, run only cheap calls: `ls`, single `find` probes, one targeted
  `get <id> --block <b>`. Anything that needs block reads across more than ~3 pages is
  a subagent's job.
- **`kb.mjs brief <query>` is the scouting call.** It returns the find hits, the
  governing theme's `decide` table and the top hits' typed neighbours in one
  round-trip (~500ms, ~600 tokens) — what otherwise costs five or six separate calls.
  Use it for your own cheap probes, and it is the first call every scout makes.
- Every subagent returns a brief in a fixed shape, **≤ ~500 tokens** (component briefs
  may run longer; they say so in their contract). Raw page text never crosses back.
- Launch independent subagents in parallel — scouts together, component designers
  together.

## The pipeline

Work the phases in order. Each phase's output is input to the next; skipping one leaves
a later verdict with nothing to route to.

1. **Frame.** Restate the ask in two sentences: what the system is for and what shape
it has (read-heavy, write-heavy, fan-out, pipeline, request/response, streaming).
Draft the candidate FRs/NFRs you can already see — these seed the grill, so it never
asks what the ask answered.

**1.5. Precedent — do this before designing anything.** The KB holds 40 worked design
case studies. One call says whether the kata is already answered:

```
node scripts/kb.mjs find "<the kata in the user's words>" --kind design --n 3
```

Read the hits' essences. Then choose, and say which you chose:

- **Close hit** (the same problem) — anchor on it. Read its `requirements`, `sizing`
  and `architecture` blocks, present it as the baseline, and spend the pipeline on
  what makes *this* ask different. Working out from scratch what the corpus already
  argued is the most expensive mistake this pipeline can make.
- **Adjacent hit** (a different problem, shared machinery) — cite it as a reference
  point in the architecture phase and design normally.
- **No hit** — say so in one line and design from scratch.

2. **Grill.** Run the [grill-me](../grill-me/SKILL.md) skill. Output: the requirement
card — falsifiable FRs, numbered NFRs, out-of-scope, assumptions, unanswerables. The
card is the routing target for every verdict downstream; nothing below may appeal to a
requirement that is not on it.

When the run is **unattended** (a batch evaluation, a scheduled run, or a user who
asked not to be interviewed), pass `--defaults` to grill-me: it takes every question's
default option, records each as an assumption, and asks nothing. The card is weaker
and the assumptions list carries the risk — say so in the delivery.

3. **Size.** Verdict-first, about 30 lines: name the interaction shape, run the
back-of-envelope numbers from the card's NFRs (peak RPS, data per day and at one year,
working-set size, connection count), work out the required technology capabilities in
capability-level language — "a durable log", "a coordination service", never a product —
and give each candidate a verdict: **adopt** (a number forces it), **reject** (the
number says no — quote it), **defer** (name the threshold that would change the
answer). Close with "when this stops being right". One node is a valid answer when the
numbers say so; the point of the phase is to refuse machinery the numbers do not force.

4. **Entities.** Two to four observation sentences (what the data *is* — mutable or
append-only, how it is keyed, what grows fastest), then entities grouped by domain
role. Each: a name, a one-line description, and a trimmed-DDL sketch carrying only the
fields an FR forces plus its key and its one load-bearing index.

5. **API.** Endpoints grouped by caller/audience — public, authenticated client,
internal service, admin — because auth follows audience. Each: `METHOD /path`, one
sentence of what it does, and a request/response contract sketch. Worked out from the
entities and FRs; an endpoint no FR forces is decoration. Name the failure responses
that matter (429, 409, 503), since the deep dives will refer to them.

*(These three follow the kb-design-[sizing](../kb-design-sizing/SKILL.md) /
[entities](../kb-design-entities/SKILL.md) / [interface](../kb-design-interface/SKILL.md)
disciplines. Read those skills only when publishing to the KB — they carry the page's
block rules (headings and `<!--meta-->` markers), which a plain doc does not need.)*

6. **High-level design.** First, identify the 1–3 central tensions the NFRs create
(consistency vs availability, scaling writes, resilience under partial failure,
contention…). Launch one **kb-scout** agent per tension, in parallel, each with the
scout input contract (below). While they run, you hold the entities and API; when the
briefs return, compose:

- **The L1 board** — one mermaid flowchart, diagram-draw rules: ≤8 nodes, ≤12 edges,
  numbered happy-path edge labels carrying verb + payload, `:::ext` marking what is
  given rather than built, data stores as cylinders.
- **Components and communication** — a numbered walk of the board: each component's
  single responsibility and what crosses each arrow.
- **Requirement trace** — where each FR lands (`→ FR: label.`) and which component or
  edge answers each mandatory NFR (`→ NFR: label.`). An FR that lands nowhere is a
  missing component; find it now, not in phase 8.
- **At least one named alternative** — a genuinely different architecture (not a
  parameter tweak), with the condition that would flip to it and the decide-row or
  cited tradeoff that says so. Verdict first: name the chosen architecture and why in
  one sentence, then the alternative.

7. **Zoom-ups.** For every non-trivial component on the board, launch one
**component-designer** agent — all of them in parallel, each owning a disjoint
component, each given the input contract below. Each returns a kb-compose brief
(boundary, requirements, adopted/rejected/deferred roster with cites, composition walk,
the bill, sensitivity list) plus an L2 zoom flowchart. You then write **one sequence
diagram per critical flow** — the happy path plus the one failure branch that matters,
≤6 participants, per diagram-draw. Trivial components (a static asset bucket) get one
sentence, not an agent.

8. **Critique.** Assemble the draft (phases 3–7) and hand it to one **design-critic**
agent. It returns findings — bottlenecks, unguarded hazards, antipattern matches,
principle overreach — each with severity, failure scenario and KB cite. Fold each
finding back in: change the design, add a guard to a roster, or record it under Open
risks as explicitly accepted. No finding disappears silently.

9. **Stack map.** Only now do product names enter. Apply the
[stack-pick](../stack-pick/SKILL.md) skill over the adopted rosters: follow
"Implemented by" edges to capability and comparison pages, read one vendor's column
(AWS by default; Azure, Google Cloud or open source on request), and produce the
`Need | Pattern | Service | Why` table — including the mandatory do-less row and
stack-pick's anti-fabrication rule. Delegate to a kb-scout if the edge-following
exceeds your cheap-call budget.

10. **Assemble and deliver.** Write the design doc to `tmp/designs/<slug>.md`
(gitignored; `mkdir -p tmp/designs/` makes the folder on a fresh checkout), in this
order — it mirrors the KB design-page block order so it can become a page later:

1. Problem (the framed ask + grill summary)
2. Requirements (the card)
3. Right-sizing
4. Core entities
5. API
6. Architecture (L1 board, walk, requirement trace, alternatives)
7. Deep dives (per-component briefs, zoom diagrams, sequence diagrams)
8. Limitations & tradeoffs (ledger: biggest flaw first, then strengths and risks,
   ≤7 each — per [kb-design-tradeoffs](../kb-design-tradeoffs/SKILL.md))
9. Stack map
10. Open risks (accepted critic findings + the card's unanswerables)
11. Self-assessment (below)

**Validate the diagrams before delivering.** Every mermaid fence in the doc goes
through the engine that renders it — a syntax error otherwise ships silently as a
placeholder box:

```bash
make gate G=check-mermaid ARGS=tmp/designs/<slug>.md
```

Fix what it reports and re-run until clean. Diagrams in the doc are raw mermaid: `-->`
and `<br/>`, never HTML-escaped (`--&gt;` parses but renders as literal text in a
markdown fence).

**Self-assess before delivering.** Score the doc against the interview rubric the KB
already carries — read one design's `levels` block for the bar
(`node scripts/kb.mjs get <a-design-id> --block levels`) and add a short table: for
Mid / Senior / Staff, what this doc demonstrates and what it does not. Honest gaps
here are worth more than a clean sweep; they tell the reader where to push.

In chat, lead with the verdict — the chosen architecture and its biggest flaw in two
sentences — then the doc path and a compact summary. Then **offer, opt-in, never
automatic**: (a) publish as a `docs/designs/` case-study page via
[kb-add](../kb-add/SKILL.md) and the kb-design-* block skills; (b) publish an Artifact
web page of the doc (mermaid renders natively there).

Make the KB offer with a reason, because it is what keeps phase 1.5 useful: a design
that lands in `docs/designs/` becomes the precedent the next kata finds, while one
left in `tmp/designs/` is invisible to every future run.

## Subagent contracts

Launch these with the Agent tool by `subagent_type`. Give each exactly its input
contract — a subagent cannot ask the user anything, so a missing input becomes a wrong
assumption. **The conductor never does the reading it hands off**: it does not read the
KB pages a kb-scout would read, assemble the pattern roster a component-designer would
assemble, or critique the draft a design-critic would critique — it launches the
subagent and works from the brief that comes back.

**kb-scout** (sonnet, parallel-safe) — *input*: one question or tension, the relevant
FR/NFR lines verbatim, any band/tag scoping you already know. *Output*: **≤500 tokens** —
question restated, the governing theme and the decide-row taken plus rows rejected,
3–7 candidate pattern ids each with a one-line why and stable-id cite, hazards
surfaced. No adoption verdicts, no vendor names, no raw page text.

**component-designer** (opus, one per component, parallel) — *input*: component name
and boundary sentence, its FRs, its numeric NFRs, the CAP/PACELC stance, and its
upstream/downstream neighbours from the board. *Output*: the kb-compose component
brief, **≤1,500 tokens with a roster of ≤12 rows**, plus one fenced-mermaid L2
flowchart (≤8 nodes, numbered edges, raw mermaid — never HTML-escaped).
Technology-agnostic throughout. A brief that overruns is a brief you have to re-read;
the cap is what keeps this pipeline affordable.

**design-critic** (opus, one per run) — *input*: the assembled draft — requirement
card, sizing verdicts, L1 board source, component rosters with cites, sequence
diagrams. *Output*: findings, most severe first, **≤8 of them**, each with claim,
failure scenario, KB cite, and a proposed guard or "accept explicitly". An empty list
is a valid answer.

**Give every subagent the same preamble**: work from the repo root, read only through
`node scripts/kb.mjs` (starting with `kb.mjs brief`), never open a page file
(`docs/**.md`, or the HTML `make site-build` writes), and
return the contract shape with no preamble or narration — the output is consumed by an
orchestrator, not read by a human.

## What this skill is not

- **Not [kb-compose](../kb-compose/SKILL.md).** That solves one bounded component;
  this designs the whole system and runs kb-compose inside subagents for each box.
- **Not [stack-pick](../stack-pick/SKILL.md) alone.** Stack mapping is phase 9 of ten;
  a user who only wants services for a known design should get stack-pick directly.
- **Not the kb-design-\* page skills.** Those author the blocks of a `docs/designs/`
  page; this produces a chat-and-file deliverable and only hands off to them if the
  user accepts the publish offer.
- **Not [kb-find](../kb-find/SKILL.md).** One symptom, one pattern, one answer — no
  pipeline needed.

## Running it at scale

For a batch of katas, an unattended run, or a design big enough that losing progress
hurts, drive phases 6–8 through the **Workflow** tool rather than ad-hoc Agent calls.
The script is written: `.claude/workflows/sys-design-batch.mjs` — scouts in parallel,
component-designers pipelined, the critic as the join.

```
Workflow({ scriptPath: ".claude/workflows/sys-design-batch.mjs", args: {
  system: "…", card: "<the requirement card>",
  tensions: ["…"],
  components: [{ name, boundary, frs, nfrs, stance, neighbours }],
  board: "<L1 mermaid, if drawn>" } })
```

It returns `{ scouts, components, findings }`; you still write the doc, the diagrams
and the stack map. What it buys over a hand-rolled fan-out is a token budget, a
journal, and resume-from-run — an Agent fan-out has none of the three, so an
interruption at phase 8 restarts from zero. Keep the plain pipeline for interactive
single katas, where the interview dominates the wall clock anyway.

## Done means

1. Every FR from the card lands on a named component in the requirement trace; every
   mandatory NFR has a deep dive or an explicitly accepted risk.
2. Every adopted pattern in every roster carries a stable-id cite; every rejection
   cites the con or violated stance that killed it.
3. At least one alternative architecture is named with the condition that flips to it.
4. No vendor or product name appears before phase 9.
5. Every diagram obeys diagram-draw caps (flowcharts ≤8 nodes; sequence diagrams ≤6
   participants; one question per diagram) and the L1 board's edges are numbered.
6. Every critic finding was folded in or recorded under Open risks — none vanished.
7. The main loop never opened a page file and never held more than one page-block read
   at a time; everything bigger went through a subagent brief.
8. The precedent check ran and its verdict is stated — anchored on a case study,
   cited one as adjacent, or said the KB has none.
9. `make gate G=check-mermaid ARGS=tmp/designs/<slug>.md` passed on the finished doc, and no
   fence is HTML-escaped.
10. The doc exists at `tmp/designs/<slug>.md`, carries the self-assessment table, the
    chat summary leads with the verdict, and both publish offers were made opt-in.
