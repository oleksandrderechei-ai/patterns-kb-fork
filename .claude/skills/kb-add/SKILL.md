---
name: kb-add
description: "Add a new pattern, hazard, theme, principle, design, capability or comparison page to the KB. Use when someone wants to document something the KB does not cover yet, or asks how to add to it. Not for a page that already exists (kb-edit) or for merging a pattern found on the web (kb-intake)."
---

# Adding a page

A page is not a document here — it is the data. Adding one correctly means the hub, the
map, the search and the neighbours' relationships blocks all update themselves. Getting it
wrong means `make validate` fails, which is the system working.

Read **[.claude/rules/markdown-authoring.md](../../rules/markdown-authoring.md)** first. It is the
contract; this is the procedure.

## 1. Check it does not already exist

```
node scripts/kb.mjs find "<the concept>"
```

A name miss is not proof of absence, so search the symptom in two or three phrasings too.
There is no stub list to promote from: the `relations` gate fails an edge whose far end has
no page, so every typed edge already points at a real one.

## 2. Decide where it goes

Every page is placed by **its row in [docs/data/site-structure.json](../../../docs/data/site-structure.json)**:
the area it sits in and its place in reading order. The page's `area:` frontmatter names
that row's area, and the `kb-shape` gate fails the page when the two disagree
([KB-001](../../../docs/reference/page-rules.md#KB-001)). A page with no row is not
published. `kb.mjs new` writes the row for you, so the decision here is which area.

**A pattern** sits in an area under `patterns`. Ask which altitude it works at (an object?
one app? a whole system? a network?) or which viewpoint it is (concurrency, messaging, caching,
ddd, functional, testing, security, frontend, ml). Two bands split into sub-areas: `gof` four
ways (`gof-creational`, `-structural`, `-behavioral`, `-extra`), and the Network band five ways:
`distributed-resilience`, `-routing`, `-scale`, `-coordination`, `-data` — and the last two
pairs share a folder each, so the folder alone will not tell you the area.

**Every other kind** sits in its kind's area, or one of its sub-areas:

| kind | area |
|---|---|
| hazard | `hazards` |
| theme | one of the five `themes-*` areas |
| design / ML case study | one of the three `designs-*` complexity tiers |
| principle | `principles-craft` or `principles-systems` |
| capability | `capabilities` |
| comparison | `comparisons` |

The hubs are generated from this file, so there is no hub to edit. Moving a page to another
area later is the **kb-move** skill.

## 3. Scaffold it

```
node scripts/kb.mjs new <id> --kind <kind> [--band <band>] [--group <area>] --name "Name" [--order <n>]
```

`--kind` is one of `pattern|hazard|theme|principle|design|capability|comparison`. A pattern
takes `--band`, its area under `patterns`, plus `--group <area>` where that band splits (a
`gof-*` or `distributed-*` area); `new` refuses a split band with no `--group` and names
the areas it takes. A principle, design or theme takes `--group <area>`, the sub-area
from the table above. A hazard, capability or comparison has one area and needs neither.
`--order` is the page's place in that area, 1 first, the end when left out — the rows after
it shift, so there is nothing to renumber.

This writes the page under `docs/<kind>s/` (a pattern under its band's folder) with every
block its kind requires, in order, and its row in the structure file; a theme also gets its
profile in `docs/data/learning-paths.json`. The page is a draft until you say otherwise, and
it already passes `kb.mjs validate --file`. There is no `<head>` and no JSON-LD to write: the
site's layout builds both. Then study an exemplar for what good content looks like:

```
node scripts/kb.mjs get circuit-breaker          # pattern
node scripts/kb.mjs get cap-theorem              # theme
node scripts/kb.mjs get god-object               # hazard
node scripts/kb.mjs get dry                       # principle
node scripts/kb.mjs get thread-pool --block production   # the production block
```

## 4. Write it

- Replace every TODO the scaffold left: prose, diagram, sketch, essence (both the
  frontmatter `description` — the terse hub-chip line, set with `kb.mjs set --essence` —
  and the longer intro paragraph under the title; they are different by design).
- **The `description` block is one paragraph of at most 80 words** (KB-015): what the page
  is for, nothing more. A new page is never added to the `description` ratchet in
  `docs/data/allow/kb-shape.json`; cut it down instead.
- **The `explain` block is a paragraph of 60 to 180 words, a costs list, then an example**
  (KB-014). A pattern scaffolds two TODO cost bullets and must keep the list: 2 to 4 bullets,
  each a bold lead and at most 25 words. Write it through `kb.mjs explain --text … --costs …
  --example …`; the **kb-explain** skill holds the contract. The paragraph may link a term on
  its first use to that term's page with `[term](path.md)`.
- Sketches are TypeScript; `go` is for a pattern of the concurrency area only.
- Place — pattern order is **editorial, not alphabetical**. It drives the hub and
  prev/next. Pick `--order` where the page belongs pedagogically; to change it later, move
  the page's row within its area in the structure file.
- **Inline markup is bold, code spans and links.** No `*italic*` and no `_italic_` — the
  corpus carries none and no stylesheet renders italic. `**bold**` for a run-in label,
  backticks for an identifier, nothing at all when the sentence already puts the stress
  where you want it. Italic contrast is a sentence to rewrite, not to mark up.
- In a `variations` block, when a variant names a page the KB already has, link it from the
  item's term — wrapping only the page-name portion: `[Sidecar](./sidecar.md) data plane`.
  Link the page, not the word: a name collision ("Streaming Gateway" is not the `streaming`
  theme) is not a reference, and a wrong link costs more than a missing one.
- `node scripts/kb.mjs validate <id>` at any point tells you what is still structurally wrong.

## 5. Wire the relationships — both sides

A relationship is **one edge record** in `docs/data/relations.json` that both pages render
their relationships block from, and the `relations` gate holds it closed and paired. The
`link` command writes it in one step, with a per-side note:

```
node scripts/kb.mjs link <id> combines-with bulkhead --note "why, from this page's view" --note-back "why, from bulkhead's view"
```

Verbs are closed — see [the glossary](../../../docs/reference/glossary.md#verbs). Directional verbs
(`variant-of`/`has-variant`) get the inverse written on the far side automatically.

Hazards carry a real `relationships` block like every other kind, so `kb.mjs link` writes
a `prevents-hazard`/`mitigated-by` edge like any other (common when adding a principle that
guards against an anti-pattern, e.g. `single-responsibility` → `god-object`). The hazard's
`mitigation` block holds prose narrative only — never typed edges.

## 6. Metadata

```
node scripts/kb.mjs set <id> \
  --aliases '["real alternate names, or [] "]' \
  --tags '["from the closed vocabulary only"]' \
  --solves '["the symptom, in the words of someone who does not know this page yet"]'
```

`solves` is 3 to 5 phrases. Each is one problem, problem first, at most 20 words, in short common words, specific to this page, never a product choice or the page's own name. Write it with `node scripts/kb.mjs set <id> --solves '[…]'`. Full rule: [markdown-authoring.md](../../rules/markdown-authoring.md#field-rules).

Tags must be in the closed list in [docs/reference/tags.md](../../../docs/reference/tags.md) —
the `tags` gate rejects anything else. Add a new tag (to `docs/data/tags.json`, and `TAGS` in
`site/src/lib/types.ts`) only if 3+ pages that already exist would carry it (see [kb-vocab](../kb-vocab/SKILL.md)).

Optionally, real implementations — **only ones you are sure exist**:

```
node scripts/kb.mjs wild <id> --items '[{"id":"envoy","name":"Envoy","note":"one sentence"}]'
```

And, where the pattern has real operational content, the system-builder block (see the
anti-fabrication rule in the authoring contract — when unsure, omit):

```
node scripts/kb.mjs production <id> --knobs '[{"label":"…","note":"…"}]' \
  --signals '[…]' --failures '[…]' --checklist '["…"]'
```

## 7. Build and verify

```
make gen && make validate
```

Then confirm it actually landed, rather than assuming:

```
node scripts/kb.mjs get <id>
node scripts/kb.mjs related <id>          # both directions wired?
node scripts/kb.mjs find "<its symptom>"  # does it come back?
```

If the `relations` gate fails, an edge record was hand-edited — re-write it with
`kb.mjs unlink` and `link`. If `kb-shape` fails KB-001, the page's `area:` and its row in the
structure file disagree.

## Done means

- `make gen && make validate` exits 0.
- `node scripts/kb.mjs get <id>` resolves and reads the way an exemplar page does.
- `node scripts/kb.mjs related <id>` shows every relationship wired on both sides.
- `node scripts/kb.mjs find "<its symptom>"` returns the new page.
- The page has its row in `docs/data/site-structure.json` (`kb.mjs new` writes it), in the
  area chosen in step 2, and its `area:` names that row's area.
