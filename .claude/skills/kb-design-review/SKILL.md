---
name: kb-design-review
description: "Review, critique or grade an existing KB page or one block of it. Writes findings only. Use when asked to \"review this design page\", \"critique docs/designs/X.md\", \"is this design any good\", \"grade this kata\", or handed a docs path with a review verb. Not for fixes (kb-edit), discussion (kb-discuss) or quizzing (kb-grill-design)."
---

# Reviewing an existing page

**The deliverable is a severity-ranked findings list, not an edited page.** Two-stage, the
same discipline `kb-fact-check` uses: this skill *finds and cites*, `kb-edit` *applies*
after the user approves. Never edit a page from here.

## 1. Resolve the reference — never open the page file

The corpus is millions of tokens and over half of any page is markup. A `file://` URL, an
absolute path (`docs/**.md`, or the HTML `make site-build` writes) and a bare id are all the same thing: **an id
plus an optional block**.

```
file:///Users/…/site/dist/designs/persona-identification.html#tradeoffs
             └─ id: persona-identification ─┘          └─ block: tradeoffs ─┘
```

Strip the directory and `.html` (or `.md`) for the id; the `#fragment` names the block. Then
read it:

```
node scripts/kb.mjs get persona-identification --block tradeoffs   # one block, ~180 tokens
node scripts/kb.mjs get persona-identification                     # whole page, cleaned
node scripts/kb.mjs validate persona-identification                # structural lint first
```

A fragment that is an *element* id (`#tradeoffs-con-2`) still names its block — review the
block, cite the element. No fragment means the whole page.

**`Read` and `WebFetch` on a page file — `docs/**.md`, or the HTML `make site-build` writes — are wrong here,
always.** If `kb.mjs get` returns nothing, the id is wrong — `kb.mjs ls --kind design` lists them.

## 2. Pick the axis — say which one you are on

A review request is one of two questions, and they have different owners. Ambiguous asks
("review this") get the page-shape axis plus a one-line offer of the other.

| axis | question | how |
|---|---|---|
| **Page shape** | Does the block obey its own contract? | the owning skill's closing checks |
| **Design soundness** | Is the architecture actually right? | `design-critic` agent, or inline `kb.mjs brief` |

### Page shape — run the owning skill's closing checks

Every block skill closes with a "Done means" list, most of them after a self-check of
judgment questions. **Load the owning skill and run both. Do not invent criteria** — a
review that judges by taste rather than by the stated contract is why blocks drift.

| block | owning skill |
|---|---|
| `description` | kb-design-problem |
| `explain` | kb-explain |
| `requirements` | kb-design-requirements |
| `sizing` | kb-design-sizing |
| `entities` | kb-design-entities |
| `interface` | kb-design-interface |
| `architecture`, `deepdives` | kb-design-architecture |
| `tradeoffs` | kb-design-tradeoffs |
| `levels` | kb-design-levels |
| `relationships` | kb-edit — the block is generated from `relations.json`; regroup a row with `kb.mjs unlink` then `kb.mjs link … --group "…"` |
| any block of a **pattern** page | kb-pattern-blocks |
| any block of a **hazard** page | kb-hazard-blocks |
| any block of a **theme** page | kb-theme-blocks |
| any block of a **principle** page | kb-principle-blocks |
| any block of a **capability** page | kb-capability-blocks |
| any block of a **comparison** page | kb-comparison-blocks |

Whole-page review runs every block's closing checks in page order, plus the cross-block
coverage contract: every FR lands somewhere visible in `architecture`, every NFR has a deep
dive, the `tradeoffs` lead names the flaw the `levels` block defends, and the `sizing`
verdicts still match what `architecture` built.

Two page-wide reads worth running because they are cheap and mechanical:

```bash
node scripts/kb.mjs validate <id>          # structural lint against the data contract
node scripts/kb.mjs refs <id>              # every page it links, to check against the pages its prose names
```

`make validate` does **not** judge a block's prose against its contract, so everything above
is honour-system except the lint. The explain block's word bounds are read by eye (the **kb-explain** skill has them).

### Design soundness — hand it to the critic

Hazards, performance antipatterns and principle overreach are the `design-critic` agent's
job, with `kb-scout` for cited KB backing. Launch them **only when subagents are
permitted in the session** — once one runs, the caller does not repeat that reading
itself. When they are not permitted, say so plainly and run the sweep inline yourself:

```
node scripts/kb.mjs brief "<the design's hardest tension>" --n 5
node scripts/kb.mjs find "<symptom the design might have>" --kind hazard
```

Inline costs main context, so scope it to the two or three tensions the page itself flags —
usually the `tradeoffs` risks and the NFR with the thinnest dive.

## 3. Report

Findings only, severity-ranked, every one anchored to a stable id.

| severity | means |
|---|---|
| **CRITICAL** | a factual error or a fabricated product/API claim that ships to a public site |
| **HIGH** | a contract violation the build cannot catch — an uncovered FR, a missing NFR dive, a block that renders wrong |
| **MEDIUM** | shape drift — over-long list, essay where a ledger belongs, collapsed sketch |
| **LOW** | wording, register, a missing prose link |

Each finding: the anchor (`…#tradeoffs-con-2`), the rule it fails — the owning skill plus the
Done-means item it breaks, quoted (e.g. *kb-design-tradeoffs — Done means: "The lead is ≤2
sentences …"*) or, for a body rule, the skill's section heading — what is wrong, and
the smallest fix. No rewritten prose in the report — that is the fix step, and it needs
approval first.

Close with the verdict and the handoff: **"N findings — approve and I'll apply them with
kb-edit."** Never apply unasked.

When the review turns into an argument about whether the design is *right* — not whether the
block obeys its contract — stop producing findings and offer **kb-discuss**. A disagreement
about the architecture is a conversation, and filing it as a finding gives an opinion the
authority of a contract violation.

## Done means

- Every read went through `kb.mjs`, and no tool call opened a page file (`docs/**.md`, or the HTML
  `make site-build` writes).
- The axis is named — page shape, design soundness, or both.
- Each finding was judged against a stated rule, cited by the skill that owns it and the
  quoted Done-means item or section heading it breaks.
- Every finding carries a stable anchor id a reader can click.
- The report is findings-only, with the fix deferred to an approved `kb-edit` pass.
