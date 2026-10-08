---
name: kb-edit
description: "Change an existing KB page: rewrite block prose, add or drop a relationship, retag, fix a real-world example, update metadata, repair cross-page links. Use when someone reports something wrong or outdated on a page. Not for a whole-page improvement pass (kb-improve), a new page (kb-add) or re-filing (kb-move)."
---

# Editing a page

The pages are the data, so an edit can break a relation, a link, the hub or a closed
vocabulary — none of which shows up in the diff you just made. That is why you run
`make gen && make validate` after every edit; the after-edit hook only names it. While
another writer is still busy, run `node scripts/kb.mjs validate --file docs/<…>.md` instead,
and build once it is done.

## 1. Read the block first — not the file

```
node scripts/kb.mjs get <id> --block tradeoffs
```

Element ids make the target exact: if someone says "the second con on circuit-breaker is
wrong", that is `#tradeoffs-con-2`, and you can quote it before changing it.

## 2. What you may edit, and how

| what | how |
|---|---|
| prose in a block | edit the markdown under `docs/` directly — it is authored |
| aliases / tags / solves / essence | `kb.mjs set` — **never** hand-edit the frontmatter key; `solves` is 3 to 5 phrases of at most 20 words, one problem each, problem first |
| the explain block | `kb.mjs explain <id> --text "…" --costs '[…]' --example "…"` — rewrites the whole block; leave `--costs` out to keep the page's own list. Paragraph 60 to 180 words, 2 to 4 costs of at most 25 words (required on a pattern), see **kb-explain** |
| the description block | edit the markdown directly; it is one paragraph of at most 80 words (KB-015). Shortening a page listed under `description` in `docs/data/allow/kb-shape.json` means deleting its entry once it passes; the gate fails an entry that excuses nothing |
| "In the wild" examples | `kb.mjs wild --items '[…]'` — rewrites the whole list |
| "In production" block | `kb.mjs production --knobs … --signals … --failures … --checklist …` — rewrites the whole block |
| adding a relationship | `kb.mjs link <from> <verb> <to> --note … --note-back …` — writes both pages |
| removing a relationship | `kb.mjs unlink <a> <b>` — removes both sides, whatever verb each used |
| re-typing a relationship | `unlink`, then `link` with the new verb |
| a relationship's note | edit the edge's `note_a` / `note_b` in `docs/data/relations.json` — each side phrases it its own way; or `unlink`, then `link` with both new notes |
| a relationship's heading on a design | `unlink`, then `link … --group "…"` (`--group-back` for the far side) — see [references/group-relationships.md](references/group-relationships.md) |
| a page's area | not here — it is a re-filing: the page's `area:` and its row in `docs/data/site-structure.json` move together. See **kb-move** |
| anything between `<!-- …:start -->` and `<!-- …:end -->` | **do not.** The relationships, tour and fluency blocks are generated from the data files, and `make gen` rewrites them |
| anything on a hub | **do not.** Hubs are generated from `docs/data/site-structure.json` and the pages' frontmatter — change the page's row or frontmatter instead |

When you rewrite prose, the inline vocabulary is bold, code spans and links. **Never
introduce `*italic*` or `_italic_` emphasis in `docs/**.md`:** the corpus carries none and
no stylesheet renders italic, so an italic run is both off-register and invisible.
`**bold**` for a run-in label, backticks for an identifier, and for contrast, rewrite the
sentence so the stress falls where you wanted the italic.

`solves` rule: 3 to 5 phrases, each one problem stated problem first, at most 20 words, short common words, specific to this page, never a product choice or the page's name; `kb.mjs set <id> --solves '[…]'` refuses a longer phrase. Full rule: [markdown-authoring.md](../../rules/markdown-authoring.md).

`kb.mjs set` validates the JSON before it lands and never guesses placement. Hand-editing a
`solves:` list in the frontmatter is how you get a key that fails
[KB-013](../../../docs/reference/page-rules.md#KB-013). After any edit,
`node scripts/kb.mjs validate <id>` (~50ms) names what broke, if anything — run it yourself;
the after-edit hook only names it.

## 3. A relationship is one record, and one command writes it

`kb.mjs link` adds an edge; `kb.mjs unlink` retires one. Each edge is **one record** in
`docs/data/relations.json` that both pages render their relationships block from, so an edge
cannot be one-way. The `relations` gate fails a record only when someone hand-edited the
file: a verb outside the closed set, a missing side's note, a page that does not exist, or
the same edge twice. Check what exists before you change it:

```
node scripts/kb.mjs related <id>
node scripts/kb.mjs backlinks <id>    # inbound edges as the OTHER side phrases them
```

Directional verbs are paired (`variant-of` ↔ `has-variant`, `prevents-hazard` ↔
`mitigated-by`), so the two sides read *different* verbs — `link` writes the edge under
the pair's first verb and both pages render their side (every kind, hazards included,
carries a `relationships` block), and `unlink` is
verb-agnostic, removing whatever each side declared. See
[the glossary](../../../docs/reference/glossary.md#verbs). The **notes** may differ per side by design —
each page describes the relationship from its own end.

## 4. When an edit changes what the page uses

Rewriting prose routinely changes which other pages a page leans on, and none of that shows
up in the diff of the page you edited. A cross-page reference rides on **four** carriers —
the typed relation, the prose link, a mermaid `click`, and membership (a theme's tour
step and a pattern's fluency note, both in `docs/data/learning-paths.json`). Only the first
has a writer.

```
node scripts/kb.mjs refs <id>          # everything this page points AT, read off the page and the data files as they stand
```

`backlinks` answers the other question — what points here. Snapshot `refs <id> --json`
before you start (or `git diff` the page after), then reconcile the difference:

1. **Started using something** — write the prose link into the sentence that uses it, then
   `kb.mjs link <id> <verb> <other> --note "…" --note-back "…"`. A design → pattern edge is
   always `demonstrates`. Write the two notes from each page's own end; they should read
   differently.
2. **Stopped using it** — `kb.mjs unlink <id> <other>`, then sweep the carriers no writer
   can see: the prose link, any mermaid `click`, the theme's tour step and the fluency note
   in `docs/data/learning-paths.json`.
3. **Still uses it, differently** — do **not** unlink. Rewrite the edge's two notes in
   `docs/data/relations.json`. This is the most common case and the one that rots silently.

> A typed relation is a claim about the design, not a by-product of a hyperlink. Unlink when
> the page genuinely no longer does the thing — not because a link moved out of a paragraph.

`refs` ends with an **untyped** line: pages linked in prose with no typed relation. That is
usually a relation you owe, occasionally a passing mention that deserves none. `make validate`
cannot make that call; it only catches the halves you left behind.

Carrier-by-carrier detail, a worked example and the failure signatures:
[references/reconcile-links.md](references/reconcile-links.md).

## 5. Retagging

Tags are a closed vocabulary (the list in [docs/reference/tags.md](../../../docs/reference/tags.md)).
The `tags` gate fails a page that carries anything not in it, naming the tag.

That is not an obstacle to route around. A tag exists to group pages; inventing one for a
single page is how the vocabulary rotted last time — the first sweep of this KB produced
280 tags, 154 of them used exactly once. A page carries **2-5 tags**, all from that closed
list — the `tags` gate enforces that, and fails a term no page uses. Every tag should also be
used on **3+ pages**; under three is a review warning, not a red (an owner call, logged in
`plans/backlog.md`), so a speculative tag slips through the build and is yours to refuse.
If the tag genuinely applies to three
pages that already exist, add it to `docs/data/tags.json` (and `TAGS` in
`site/src/lib/types.ts`) and say which pages.
Growing or retiring the vocabulary itself is the **kb-vocab** skill.

## 6. Fixing a wrong real-world example

Rewriting beats deleting — a corrected note usually teaches more than the claim it replaces.
When Sidekiq was wrongly credited with re-queueing jobs from dead workers, the fix documented
the actual gap (open-source uses BRPOP and loses in-flight jobs; durable re-queue is Pro),
which is more useful than the original claim. But if you cannot make it accurate, drop it —
a fabricated example on a public site is worse than a missing one.

`wild --items` replaces the whole list, so pass the entries you are keeping too.

## Done means

- `make gen && make validate` exits 0 — `make gen` rewrites every generated block and
  reference page built from the pages and the data files; if you only changed prose,
  `make validate` alone says whether anything is stale.
- `node scripts/kb.mjs validate <id>` reports nothing wrong.
- `node scripts/kb.mjs refs <id>` matches what the edit actually changed — no reference you
  added or dropped is left unreconciled.
- Every relationship you touched reads right from **both** pages (`node scripts/kb.mjs related <id>`).
