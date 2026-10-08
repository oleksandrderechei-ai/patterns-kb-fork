---
name: kb-fact-check
description: "Check KB pages against Wikipedia and other trusted sources: a script fetches them, then you diff each page's claims and write cited findings. Use when someone says 'fact-check the KB', 'check this pattern against Wikipedia', 'are our tradeoffs right'. Not for applying findings (kb-edit) or claims about this repo (docs-sweep)."
---

# kb-fact-check — corroborate the KB against outside sources

A **two-stage pipeline**, mirroring `site-extract → kb-add`. This skill *fetches sources and
writes cited findings*; **`kb-edit` applies them** as a separate, explicitly-approved step. It
never writes to `docs/` or `site/`. Everything lands in gitignored `tmp/kb-fact-check/`.

```
resolve   kb id → Wikipedia title (4-stage ladder) + committed alt-source allowlist
fetch     fetch.mjs pulls each source into tmp/kb-fact-check/  (raw.txt readable + norm.txt match-target)
evaluate  diff KB blocks (kb.mjs record) against sources, BY BLOCK CLASS across the corpus
verify    a second reader tries to REFUTE each finding; REJECTED ones are kept, flagged
gate      eval-check.mjs re-verifies every quote and anchor mechanically
roll up   rank by fix-class + severity — the human reads this, then hands the slice to kb-edit
```

## Why a script, and why block-class not page-by-page

Wikipedia is a documented JSON API — resolution and fetch are deterministic, so `fetch.mjs` owns
both (no browser, no model tokens). The **evaluation** is inverted: judge *all* `wild` blocks in
one context, then all `production`, then prose — never page-by-page. A page-by-page sweep costs
~1.8M tokens and reproduces the KB's own "many agents → drifting standards" failure. One agent
per block class holds one consistent bar.

## 1. Resolve

```
node .claude/skills/kb-fact-check/fetch.mjs plan     [--only a,b] --captured-at <ISO>
node .claude/skills/kb-fact-check/fetch.mjs resolve  [--only a,b] --captured-at <ISO>
```

`plan` seeds `index.json` from `node scripts/kb.mjs ls --json` and merges the alt-source
allowlist in [`sources.json`](sources.json). `resolve` runs the title ladder: sentence-cased name
→ `"<name> pattern"`/qualified forms → gated aliases → `nearmatch` → band-context search. It
**quarantines** wrong-sense hits (a design's company article, `The Blob`→1958 film) and records
every miss. **A `none` result is a correct answer** — Wikipedia has no article for ~15-25% of
patterns and almost no designs.

## 2. Pin — when there is no source, say so

```
node .claude/skills/kb-fact-check/fetch.mjs pin <id> --wikipedia "<Exact Title>"
node .claude/skills/kb-fact-check/fetch.mjs pin <id> --none --reason "KB coinage; no article"
```

The anti-fabrication valve: never let the pipeline guess a plausible-but-wrong article. Designs,
themes, and house coinages usually `--none`; they are evaluated **internally** instead (§4).

## 3. Fetch

```
node .claude/skills/kb-fact-check/fetch.mjs fetch [--only a,b] [--refresh] [--force] --captured-at <ISO>
node .claude/skills/kb-fact-check/fetch.mjs status [--only a,b] --json      # exit 0 done / 2 pending
```

Serial, 1 req in flight, 1s delay, compliant `User-Agent`, `maxlag=5`, honours `Retry-After`.
Idempotent: stores `revid`; unchanged pages skip. Wikipedia arrives as plain text via
`prop=extracts`; alt HTML is reduced with the tools workspace's node-html-parser. Each source is stored twice:
`<sid>.raw.txt` (readable, carries `> Source:`) and `<sid>.norm.txt` (whitespace-collapsed — the
quote gate matches against this). Add a one-off source with `alt add <id> --url … --label … --tier N`.

## 4. Evaluate — by block class, honestly

Read the KB via `kb.mjs record <id> --block <name>`: the page as data, whose node `text` is
what a quote is checked against and whose `code` holds a diagram's source (the
`architecture`/`structure` blocks of designs and patterns are often mermaid). Cite an
element's `id` as the finding's `anchor`. Write one
`findings/<kind>/<id>.eval.json` per page. Every finding carries a closed `dimension`
(fabrication `wild-false`/`production-false`, `factual-error`, `missing-tradeoff`,
`missing-variation`, `missing-relationship`, …), a `severity`, a one-line `claim`, a `kb`
block (`{block, anchor, quote}` + `absenceEvidence` for any `missing-*`), a `sources[]` array
whose `quote` is a **verbatim substring** of the stored source, and a `proposedFix.intent` — the
*claim to make in our own words, ≤2 sentences*, never prose to paste. `kb-ahead`, `source-weak`,
and `verified-clean` are first-class NOTE outcomes: a page that yields only notes is a success.

**Designs and themes have no external evaluator** — Wikipedia serves them at ~5%/~30%. Judge them
with zero network instead: does the design's prose exercise the pattern each `demonstrates` edge
names (`demonstrates-unsupported`/`-missing`), and is the `estimation` arithmetic self-consistent
(`estimation-arithmetic`)?

At corpus scale one evaluator cannot hold every class, so each writes **staged** findings to
`staging/<class>/<id>.json` against the contract in
[`staged-findings-contract.md`](staged-findings-contract.md) — one file per page per class, written
the moment that page is done so a run interrupted mid-batch loses nothing and a re-run skips what
already exists. `merge-staged.mjs` then assembles the classes into one findings file per page:

```
node .claude/skills/kb-fact-check/merge-staged.mjs --all-staged --captured-at <ISO>
node .claude/skills/kb-fact-check/merge-staged.mjs <id,id,…>  --captured-at <ISO>
```

It **replaces** the page's findings file from staging, so merge before repairing anything — a
re-merge silently discards edits (verdicts, `absenceEvidence`) made in `findings/` afterwards.

Once the evaluators are launched, the caller merges their staged files and does not evaluate
those block classes itself: a second, inline reading costs the context the fan-out saved.

## 5. Verify + gate

A second reader gets only `{claim, source quotes, kb quote, absenceEvidence}` — never the first
reader's reasoning — and returns `CONFIRMED | PLAUSIBLE | REJECTED`. REJECTED findings stay in the
file (so they are not re-raised) but are excluded from the roll-up. Then:

```
node .claude/skills/kb-fact-check/eval-check.mjs [--only a,b]     # exit 0 clean / 2 none / 3 issues
node .claude/skills/kb-fact-check/eval-check.mjs --self-check     # the gate on two real pages, exit 0 / 3
```

It re-verifies mechanically: **quote-or-drop** (every source quote is a real substring),
**anchor-or-drop** (block ∈ the kind's blocks in `docs/data/content-model.json`, kb quote in that
block's joined text, `anchor` an element id of the record that sits inside that block),
**prove-the-absence** (every `missing-*` term is genuinely absent from the page),
**no-laundering** (no 8-word run of a fix intent appears in any source — Wikipedia is CC BY-SA;
never copy prose into `docs/`), **severity ceiling** (CRITICAL/HIGH needs ≥2 sources or 1
tier-1), and the closed enums.

After a change to `eval-check.mjs`, or to what `kb.mjs record` prints, run `--self-check`: it
builds findings from two real pages, some clean and some seeded with one fault each, and fails
when the gate gives any of them the wrong verdict.

## 6. Roll up and hand off

Rank `rollup.md` by fix-class then severity; lead with the CRITICAL count and the count of pages
with zero findings (the honest denominator). Each finding's `proposedFix` is written to paste
into a **`kb-edit`** session — the validated writers (`kb.mjs set` / `wild` / `production` /
`link`) apply it, then `make gen && make validate`. Rewriting a wrong `wild`/`production` entry beats
deleting it; a claim you cannot make accurate gets dropped.

## Loop mode

Once: `plan` + `resolve` the target set. Each iteration: `fetch --only <next 3-5>`, evaluate that
block class, run `eval-check`. Stop when `status` exits 0 and `eval-check` is green. `tmp/kb-fact-check/`
is gitignored and holds "all rights reserved" pages — delete it after the editing pass.

## Done means

- Every targeted page has an `.eval.json` — even a page with zero findings, recorded with its
  note outcome (`verified-clean`, `kb-ahead` or `source-weak`) rather than skipped silently.
- `node .claude/skills/kb-fact-check/eval-check.mjs` exits 0: every quote and anchor checks
  out mechanically, and no `missing-*` finding names something the page actually says.
- A second reader has run the REFUTE pass (§5); REJECTED findings stay in the file, flagged,
  and are excluded from `rollup.md`.
- `rollup.md` is written, ranked by fix-class then severity, and the run wrote nothing to
  `docs/` or `site/` — the handoff to `kb-edit` is a separate, approved step.
