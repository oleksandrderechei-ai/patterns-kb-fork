---
title: Skill routing
description: Which skill owns which job in patterns-kb, the four ways a page can be used, and the read-only agents that keep the corpus out of the main context.
area: reference
owner: Oleksandr Derechei
tags: [routing, separation-of-concerns]
status: stable
---

# Skill routing

Every recurring job in this repo has one skill that owns it. A skill loads when its
description matches the request, so this page is the map a person reads; the precedence
rules that override the generic agents are in [the root layer](../../CLAUDE.md).

## Changing the KB

Which skill owns what:

| Job | Skill |
|---|---|
| adding a page of any kind | **kb-add** |
| fixing prose, metadata or a relationship on a page that exists | **kb-edit** |
| raising a page, an area or a kind to expert-grade in plain words: six reader reviews merged into one applied edit plan, ending in a pull request | **kb-improve** (findings only: **kb-design-review**) |
| where a page appears on its hub, or re-filing it into another area | **kb-move** (a new page's row: **kb-add**) |
| any block of a pattern page | **kb-pattern-blocks** |
| any block of a hazard page | **kb-hazard-blocks** |
| any block of a theme page | **kb-theme-blocks** |
| any block of a principle page | **kb-principle-blocks** |
| any block of a capability page | **kb-capability-blocks** |
| any block of a comparison page | **kb-comparison-blocks** |
| any block of a design case study | **kb-design-problem**, **kb-design-requirements**, **kb-design-sizing**, **kb-design-entities**, **kb-design-interface**, **kb-design-architecture**, **kb-design-tradeoffs**, **kb-design-levels**; regrouping its relationships block, **kb-edit** |
| the `explain` block: one expert-grade explanation in plain words and one example | **kb-explain** |
| a code sketch — its language, its highlighting, open vs collapsed | **kb-sketch** |
| the closed vocabularies, the glossary and tag references, and the search synonyms | **kb-vocab** |
| a page's tags: applying one from the closed set (`kb.mjs set <id> --tags`) / adding or retiring one in `TAGS` ([field rules](../../.claude/rules/markdown-authoring.md#field-rules)) | **kb-edit** / **kb-vocab** |
| merging a pattern found on the web | **kb-intake**, fed by **kb-harvest** |
| capturing a docs or course site into raw local data | `site-extract` |
| checking pages against outside sources | **kb-fact-check** |

## Using the KB

These read the KB and change nothing:

| Job | Skill |
|---|---|
| a symptom, and which pattern answers it | **kb-find** |
| talking a page through as a peer — arguing with it, replaying it under a changed requirement | **kb-discuss** |
| reviewing, auditing or grading an existing page | **kb-design-review** |
| being tested on a case study / on any other kind of page | **kb-grill-design** / **kb-grill-page** |
| interrogating a proposal that does not exist yet into requirements | **grill-me** |
| a full system design, or an architectural kata | **sys-design** |
| designing or hardening one bounded component | **kb-compose** |
| a mermaid diagram, at the right altitude | `diagram-draw` |
| picking a stack, an alternative to a named product, or the tech behind one pattern | `stack-pick`, `alt-pick`, `pattern-tech-map` |
| the register a piece of prose should be written in | **style-pattern-doc**, **style-simple**, **style-technical**, **style-system-design** |

## Keeping the harness true

These check the repo's own tools and docs rather than the KB:

| Job | Skill |
|---|---|
| a red gate, local or in CI, and its one-command repro | `gate-red` |
| moving an entry out of the [trap inbox](../inbox.md) into its home | `retire-gotcha` |
| checking that the docs and harness files still say what the tree does | `docs-sweep` |
| reading a built page of the Astro site as a machine reader would | `page-audit` |
| looking at the built Astro site at four widths, reported in the chat | `site-audit` |
| a site component or the shared stylesheets | `site-component` |

The last three serve the Astro site under `site/`.

## Four ways to use a page

**Four things a page can be to you, and they route differently.** **kb-design-review** finds
the page's faults and reports them as findings for an approved **kb-edit** pass.
**kb-grill-design** and **kb-grill-page** find the reader's, and forbid teaching while they
do it. **grill-me** interrogates a proposal that does not exist yet. **kb-discuss** talks a
page through as a peer — it argues, teaches, cites element ids, edits nothing, and names the
handoff when the conversation concludes somewhere else.

## Read-only agents

**Five agents keep the corpus out of the main context and change nothing**, because a page costs
about 4k tokens ([the root layer](../../CLAUDE.md) gives the figure) and a conversation
holds several:
`kb-scout` (one question → a cited brief), `kb-page-analyst` (one page → a discussion pack),
`kb-persona-reviewer` (one page, read as one reader → anchored findings; as the synthesizer,
several readers' findings → one edit plan, for **kb-improve**), `component-designer` (one
bounded component → a **kb-compose** brief) and `design-critic` (a draft → adversarial
findings).
Scouting agents open with `kb.mjs brief <query>`, which returns find hits, the governing
theme's decide table and the top hits' neighbours in one call. **sys-design** is the
conductor that drives them through a full design — interview → requirements →
entities/API → HLD → component zoom-ups → critique → stack (see Routing precedence in
[the root layer](../../CLAUDE.md): in this repo these replace the generic agents rather
than competing with them).

**Two verifiers read out of the caller's context and hold only Read, Glob and Grep**, so no
run changes the tree they report on: `claim-audit` checks one page's or a group's claims
against the tree for `docs-sweep`, and `gate-triage` answers five questions about one red
gate for `gate-red`.

## The writing agent

**`kb-author` writes pages**: it authors and updates the markdown under `docs/` for batch
work, each invocation owning a disjoint set of ids so several run in parallel, and it applies
the edit plan in **kb-improve** and its batch workflow, `.claude/workflows/kb-improve-batch.mjs`.
It does not run `make gen`; the orchestrator does that once at the end.

## Agent models

Workers run on Sonnet; the three agents that judge a design run on Opus.

| Agent | Model | Writes |
|---|---|---|
| `kb-scout` | sonnet | no |
| `claim-audit` | sonnet | no |
| `gate-triage` | sonnet | no |
| `kb-author` | sonnet | yes, pages under `docs/` |
| `kb-persona-reviewer` | sonnet | no |
| `kb-page-analyst` | opus | no |
| `component-designer` | opus | no |
| `design-critic` | opus | no |
