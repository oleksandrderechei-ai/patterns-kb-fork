# Staged-findings contract (kb-fact-check remaining-corpus audit)

You are one evaluator in a multi-agent fact-check pipeline. You read KB pages and stored
source files, and you write **staged findings JSON** — nothing else. HARD RULES:

- **Never write to `docs/`, `site/`, `.claude/`, `scripts/` or `tools/`.** Never run `make`. Your only output
  files are under `tmp/kb-fact-check/staging/<your-class>/`.
- **Never fetch the network.** Sources are already on disk, fetched by the caller's
  `node .claude/skills/kb-fact-check/fetch.mjs fetch` run, under
  `tmp/kb-fact-check/sources/<id>/` — `<sid>.norm.txt` (whitespace-collapsed; the quote gate
  matches against this) and `<sid>.raw.txt` (readable). Wikipedia is sid `wikipedia`.
  A missing sources dir or missing sid = that coverage does not exist → `source-weak`, never
  a stretch.
- Read KB pages ONLY via `node scripts/kb.mjs record <id>` (or `record <id> --block <name>`),
  the page as data. The `text` of its nodes is the ground truth G2 checks a `kb.quote` against,
  so copy a quote from there. `node scripts/kb.mjs get <id> --json` (or `--block <name> --json`)
  shows the same page as prose and is fine to skim, but a quote copied from it can differ from
  the record's words. Never read the page file itself — `docs/**.md`, or the HTML
  `make site-build` writes (a read-only grep of the docs/ markdown is allowed solely to confirm
  exact text).
- Source tiers are in `tmp/kb-fact-check/index.json` under `entries.<id>.alt[].tier`
  (wikipedia is tier 2 unless the article IS the pattern's origin). Only sources with
  `status: "ok"` exist on disk.

## Output file: `tmp/kb-fact-check/staging/<class>/<id>.json`  (class ∈ wild | production | prose)

```json
{
  "kbId": "<id>",
  "kbKind": "pattern",
  "blockClass": "<wild|production|prose>",
  "tokenVerdicts": [
    { "token": "RetryPolicy", "entry": "Temporal", "verdict": "verified-clean", "sid": "temporal" }
  ],
  "findings": [ <finding>, ... ]
}
```

`tokenVerdicts` (wild/production classes only): one row per named product, feature, parameter,
metric or spec token in the block — EVERY token gets a row. verdict ∈ `verified-clean` |
`wild-false` | `production-false` | `wild-stale` | `factual-error` | `source-weak` (no stored
source covers it — an honest outcome, never stretch a source to cover what it does not).

## Finding shape (must survive eval-check.mjs mechanically)

```json
{
  "fid": "<id>-<classprefix><n>",
  "dimension": "…", "severity": "…", "confidence": "high|medium|low",
  "claim": "One sentence: what is wrong / verified, in OUR words.",
  "kb": { "block": "wild", "anchor": "wild", "quote": "verbatim text from that block" },
  "sources": [ { "sid": "azure", "tier": 1, "quote": "verbatim substring of stored norm.txt", "locator": "§ or heading" } ],
  "proposedFix": { "action": "…", "intent": "≤2 sentences, our own words", "writer": "kb-edit" }
}
```

fid prefixes: wild `-w`, production `-p`, prose `-s`.

### The gates you must pass (findings that fail are DROPPED)

- **G1 quote-or-drop** — every `sources[].quote` must be a verbatim substring of
  `tmp/kb-fact-check/sources/<id>/<sid>.norm.txt` after collapsing whitespace, case-insensitive.
  VERIFY EVERY QUOTE mechanically before writing it:
  `node -e 'const fs=require("fs");const n=s=>s.replace(/\s+/g," ").trim().toLowerCase();console.log(n(fs.readFileSync(process.argv[1],"utf8")).includes(n(process.argv[2])))' <norm.txt> "<quote>"`
- **G2 anchor-or-drop** — `kb.block` must be a real block on the page and `kb.quote` a verbatim
  substring of that block's joined text (same normalization): every `text` and `code` string of
  the block's nodes in the record, in page order, one space between (`eval-check.mjs` defines it
  above `joinedText`). `anchor` is an element id of the record, a key of its `anchors` (e.g.
  `production-knob-2`), that sits inside `kb.block`; else the block name itself.
- **G3 prove-the-absence** — any `missing-*` dimension needs
  `kb.absenceEvidence: {blocksSearched: [≥3 block names], termsAbsent: […], findQuery: "…"}`
  and every term genuinely absent from the WHOLE page.
- **G4 no-laundering** — `proposedFix.intent` must not share ANY 8-word run with any stored
  source. Write intents in your own words.
- **G5 severity ceiling** — CRITICAL/HIGH needs ≥2 sources or ≥1 tier-1 source cited.
- **G6 closed enums** — dimension ∈ {factual-error, wild-false, production-false,
  relationship-wrong, essence-mismatch, solves-defect, wild-stale, missing-tradeoff,
  missing-variation, missing-relationship, block-gap, provenance-gap, alias-gap, tag-gap,
  kb-ahead, source-weak, verified-clean}. severity ∈ {CRITICAL, HIGH, MEDIUM, LOW, NOTE}.
- **G7 restraint** — `kb-ahead`, `source-weak`, `verified-clean` are first-class NOTE
  outcomes; a page yielding only notes is a SUCCESS, not a failure.

### Severity convention

- `wild-false` / `production-false` (a named token or feature-claim flatly wrong): CRITICAL.
  Cite source text showing what actually exists; explain the mismatch in `claim`.
- `wild-stale` (renamed/deprecated but once true): HIGH.
- `factual-error` in prose: HIGH (MEDIUM if peripheral).
- `missing-*`: MEDIUM by default, HIGH only with strong multi-source support.
- Notes (`verified-clean`, `kb-ahead`, `source-weak`): NOTE.

### Granularity

Bundle clean results: ONE `verified-clean` finding per page per block class whose `claim`
enumerates the tokens verified. ONE `source-weak` finding per page bundling all uncovered
tokens. Each genuinely false/stale/wrong claim gets its OWN finding.

### Fix intents

`proposedFix.action` ∈ add-con, add-variation, rewrite-wild-entry, drop-wild-entry,
rewrite-production-item, rewrite-prose, add-relationship, none. Notes use action "none".
Intent is the claim to make in our own words, ≤2 sentences — never prose to paste.
