---
name: kb-intake
description: "Merge a pattern found on the web into the KB: triage against existing pages, compare block by block, then improve a page, skip when the KB is ahead, or create one. Use when someone says 'I found this pattern on the web', 'compare this article with our page'. Not for finding sources (kb-harvest) or sourceless ideas (kb-add)."
---

# kb-intake — improve, skip, or create, from a web-discovered pattern

The repeatable intake loop: candidates in (URLs, pattern names, or both — one or many per
run), and for each one exactly one verdict out: **IMPROVED**, **SKIPPED**, or **CREATED**.
Candidates may also arrive from `kb-harvest`, in which case a `NEW` candidate carries a
ready raw capture under `tmp/kb-harvest/captures/…` (scaffolded there by kb-harvest's
`node .claude/skills/kb-harvest/harvest.mjs`) that substitutes for §2's fetch — all the
§5–§6 bars still apply.
Unlike `kb-fact-check`, which only writes findings, this skill **applies** its changes — it
is the edit step. The full data contract is
**[.claude/rules/markdown-authoring.md](../../rules/markdown-authoring.md)**; everything below is
the procedure plus the rules you need inline.

Read the KB through the CLI, never by opening a page file — `docs/**.md`, or the HTML `make site-build`
writes; a page is thousands of tokens:

```
node scripts/kb.mjs find "<words>"            # symptom/name search over all pages
node scripts/kb.mjs get <id> [--block b] [--json] [--diagrams]
node scripts/kb.mjs related <id>
```

## The loop — per candidate

### 1. Triage against the KB, before fetching anything

```
node scripts/kb.mjs find "<pattern name>"
node scripts/kb.mjs find "<the symptom it fixes, in plain words>"   # 2–3 phrasings
```

A name miss is not proof of absence — the KB may hold it under another name, so search the
symptom too, and run `node scripts/kb.mjs backlinks <id>` on the closest page: the prose
mentions that never became edges often name the gap you are looking at.

Verdict per candidate:

| verdict | meaning | next step |
|---|---|---|
| `EXISTS` | a KB page covers the same mechanism | §2–§4: fetch, compare, improve or skip |
| `EXISTS-AS-VARIANT` | it is a variation of a KB page, not a peer | usually a `variations` entry + alias on that page, not a new page |
| `NEW` | no page and no covering variant | §2, then §5: create — if it clears the new-page bar |
| `OUT-OF-SCOPE` | not a software design pattern (a product, a tutorial, a vague practice) | SKIP, one-line reason |

### 2. Capture the web explanation as facts, not prose

Fetch the URL with WebFetch (browser tools if the page is login-gated). For a bare name
with no URL, search for the canonical write-up first. Extract **neutral bullet facts**:
intent, mechanism, variants, tradeoffs, applicability ("use when…"), named real
implementations, related patterns. Not the source's sentences.

**No-laundering rule:** nothing the source wrote lands in `docs/` — the KB is public and
the source's prose is copyrighted. Every claim you carry forward is restated in your own
words, in the house register (second person, failure-first, every claim carries its
consequence — `.claude/rules/tone.md`). No 8-word run of a source may survive into a page.

### 3. Compare block by block (`EXISTS` only)

```
node scripts/kb.mjs get <id> --json --diagrams
```

Diff the captured facts against what the page already says. Classify each genuine gain:

- **missing variation** — the web names a variant our `variations` block lacks
- **missing tradeoff** — a real con/limit our `tradeoffs` block omits
- **missing / wrong "In the wild" entry** — subject to the anti-fabrication bar in §6
- **missing relationship** — a typed edge to a page we already have
- **missing alias** — a genuinely used alternate name (never an invented one)
- **better `solves` phrasing** — the article surfaces symptom words ours lack (3 to 5 phrases, at most 20 words each)
- **factual error** — ours says something the better source contradicts

**KB-ahead is a success, not a failure to route around.** If the web source adds nothing
the page does not already say — the common case for a mature page — the verdict is
**SKIPPED (kb-ahead)** with a one-line reason. Never invent an edit to justify the run.

### 4. Improve (`EXISTS` with gains)

Follow the kb-edit discipline — the writers validate; hand-edited attributes break:

| what | how |
|---|---|
| prose in a block | edit the markdown directly — bold, code spans and links only; **never `*italic*`/`_italic_`** |
| aliases / tags / solves | `kb.mjs set <id> --aliases … --tags … --solves …` — never hand-edit the frontmatter key |
| "In the wild" | `kb.mjs wild <id> --items '[…]'` — it **replaces the whole list**: dump the current one with `get <id> --block wild --json` and re-supply it with your addition, never re-typed from the rendered prose |
| production block | same replace-whole-block rule via `kb.mjs production`, dumped with `get <id> --block production --json` |
| add a relationship | `kb.mjs link <id> <verb> <other> --note "…" --note-back "…"` — writes the one edge record both pages render from; verbs are closed ([the glossary](../../../docs/reference/glossary.md#verbs)) |
| a new tag | only if already in the closed list ([docs/reference/tags.md](../../../docs/reference/tags.md)); otherwise add it to `docs/data/tags.json` (and `TAGS` in `site/src/lib/types.ts`) first, and only if it honestly applies to 3+ pages |
| anything between `<!-- …:start -->` and `<!-- …:end -->` | do not touch — `make gen` rewrites it |

Rewriting a wrong claim beats deleting it — a corrected note teaches more than a gap. If
you cannot make it accurate, drop it.

### 5. Create (`NEW` that clears the bar)

Follow the kb-add procedure end to end:

1. Decide kind and area (the `areas` of `docs/data/site-structure.json`; a pattern's band
   is its area under `patterns`).
2. `node scripts/kb.mjs new <id> --kind pattern --band <band> [--group <area>] --name "…" [--order <n>]`
   — order is **editorial, not alphabetical**: `--order` is the page's place in its area
   (1 first, the end when left out). `new` writes the structure row and the rows after it
   shift, so there is nothing to renumber and no build to run before the writers know the id.
3. Study the exemplar (`kb.mjs get circuit-breaker`) and write every block in order, from
   the **captured facts in your own words**: description, the explain block (`kb.mjs explain <id> --text … --example …`), structure with its numbered
   topology walk, variations, tradeoffs, usage, sketch.
4. Wire relationships on **both** sides with `kb.mjs link`; metadata with `kb.mjs set`
   (symptomatic `solves` — the words of someone who does not know the page exists yet).
   `solves` rule: 3 to 5 phrases, each one problem stated problem first, at most 20 words,
   short common words, specific to this page, never a product choice or the page's name;
   `set --solves` refuses a longer phrase ([full rule](../../rules/markdown-authoring.md)).

### 6. The new-page and wild bar — anti-fabrication

A pattern earns a page only if it is **recognized beyond the one article**: a second
independent source, or a canonical corpus (AWS/Azure/GCP architecture guidance, Wikipedia,
Fowler, GoF / EIP / PoEAA). One blog's private coinage → **SKIPPED (uncorroborated)**,
recorded as such. The same standard governs every "In the wild" entry and every
`production` knob/signal: a named product feature or parameter you are sure exists, or
nothing. When unsure, omit — a three-item list of true things beats five with one lie.

### 7. Verify

```
make gen && make validate
```

Then prove it landed rather than assuming:

```
node scripts/kb.mjs find "<the candidate's symptom>"   # does the page come back?
node scripts/kb.mjs related <id>                       # both sides wired?
```

## The report — every run ends with this table

| candidate | source | verdict | detail |
|---|---|---|---|
| write-behind cache | url | IMPROVED | +1 variation, +1 wild entry, retagged |
| sidecar-less mesh | url | SKIPPED (kb-ahead) | page already covers ambient mode |
| cell-based architecture | url | CREATED | `docs/patterns/distributed/…` + 4 edges |
| "the lasagna pattern" | blog | SKIPPED (uncorroborated) | single-blog coinage |

Repeated runs are the point: the table is the audit trail, and a run that only produces
SKIPPED rows is a healthy run over a mature KB.

## Done means

- Every candidate carries exactly one verdict: `IMPROVED`, `SKIPPED`, or `CREATED`.
- Every `IMPROVED` or `CREATED` page has gone through `make gen && make validate` clean, and
  `kb.mjs find`/`kb.mjs related` confirm it lands and is wired both ways (§7).
- No 8-word run of the source survives into `docs/` — every claim is restated in the house
  register, and every "In the wild"/production claim clears the anti-fabrication
  bar (§6).
- The report table above is filled, one row per candidate, including the SKIPPED ones.
