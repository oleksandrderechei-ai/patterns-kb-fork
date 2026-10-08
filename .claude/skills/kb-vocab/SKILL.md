---
name: kb-vocab
description: "Review, extend or retire the KB's vocabularies: tags, relation verbs, page kinds, blocks, section facts, suffix keys, value sets, areas, banned words, kb.mjs commands, search synonyms. Use when someone says 'add a tag', 'add a synonym', 'ban a word', 'what are the legal values'. Not for retagging one page (kb-edit)."
---

# Evolving the vocabularies

Every page and every tool that reads the pages share a set of closed vocabularies — a value
outside the set fails a gate. They live in a handful of data files under `docs/data/`, each
opening with a note that says what it holds and who reads it, and **none may be edited
alone**: each has a generated reference page, a tuple in the site's code or a gate that must
move with it.

| Vocabulary | Source | Enforced by | Breaks if wrong |
|---|---|---|---|
| Page kinds (7) | `glossary.json` `kinds`; `content-model.json` `kinds` (folder, blocks) | kb-shape | a page sits in a folder no kind owns |
| Blocks (35) | `glossary.json` `blocks`; `content-model.json` `kinds[].blocks` / `optional` | kb-shape | a missing or out-of-order block |
| Section facts and suffix keys | `content-model.json` `facts`, `suffix` | kb-shape | an unknown `<!--meta k=v-->` or `{key=…}` ships |
| Polarity values (8) | `glossary.json` `polarities`; `content-model.json` `facts.polarity` | kb-shape (KB-007) | an item argues no side |
| Relation verbs (19) | `glossary.json` `verbs`; `content-model.json` `relations` (inverse, order) | relations | an edge with a verb nothing defines |
| Properties (7) | `glossary.json` `properties` | vocabulary | a fact kb.mjs or a data file records goes undefined |
| House words | `glossary.json` `house` (`avoid` phrasings) | vocabulary | a banned phrasing ships |
| Areas | `site-structure.json` + `AREAS` in `site/src/lib/types.ts` | site-structure | a page filed under no hub |
| Tags (61) | `tags.json` + `TAGS` in `site/src/lib/types.ts` | tags, tags-fresh | a page filters into nothing |
| Sketch languages (10) | `content-model.json` `sketchLangs` | kb-shape | a sketch ships un-highlighted |
| CLI commands (15) | `tools/src/kb/spec.ts` | — (kb.mjs renders its usage from it) | the docs drift from the tool |
| Synonyms | `search-synonyms.json` (`curated` + `expansions`) | search-synonyms, search-synonyms-fresh | a bridge that never fires |
| Search oracle | `search-oracle.json` (`cases`) | search-oracle | a query the search answers wrong, unrecorded |

The glossary is the one home for a definition: `content-model.json` says what shape a page
may take, never what a word means, and only the sketch languages carry their gloss there,
because the glossary does not list them.

Three reference pages are generated and never edited:
[docs/reference/glossary.md](../../../docs/reference/glossary.md) from `glossary.json`
(`gen-vocabulary`), [docs/reference/tags.md](../../../docs/reference/tags.md) from
`tags.json` (`gen-taxonomy`) and
[docs/reference/search-synonyms.md](../../../docs/reference/search-synonyms.md) from
`search-synonyms.json` (`gen-search-synonyms`). Edit the data file, then `make gen`; the
glossary-fresh, tags-fresh and search-synonyms-fresh gates fail a stale page.

**Start every task here:**

```bash
make validate                          # the vocabulary, tags, kb-shape and relations gates
make tools-test T=relevance            # the search fixture: does find still rank the right page first
```

There is no worklist program. The pages no synonym points at are found by asking: for a page,
run `node scripts/kb.mjs find "<a word a searcher would type>"` and see whether it ranks.

## Adding a tag

A tag exists to group. One that groups nothing is worse than none, because it spends one of
a page's five slots. Before adding one:

- **It applies to 3+ pages that already exist.** Not "will apply once I write them". The
  tags gate fails a term no page uses; under three uses is a review warning, not a red, so
  hold the line yourself.
- **It is a concept, not a kind marker.** A tag that lands on every page of one kind and
  nowhere else says what the page's folder already says; the Kind facet groups those pages
  for free.
- **It is not a near-duplicate.** Check the existing set in
  [docs/reference/tags.md](../../../docs/reference/tags.md) for a neighbour first. The 2026-08
  sweep retired four tags for exactly this — `test-doubles` folded into `testing`, `legacy`
  into `integration`/`maintainability`, `instantiation-control` into `lifecycle`, and
  `buffering` into `backpressure` — so the surviving neighbours are the ones to reach for
  before adding a fifth. `testability` beside `testing`, and `batching` beside
  `backpressure`, are the distinctions still worth drawing.
- **It sits in one facet, in alphabetical position.** A `topic` says what a page is about
  and carries a `label`, a `skill` what the reader does, a `language` the machinery. Add the
  term to `docs/data/tags.json` and its id to the flat `TAGS` tuple in
  `site/src/lib/types.ts` in the same change — the tags gate holds the two to each other both
  ways. Each list is sorted; a tag appended to the end is a merge conflict waiting to happen.

Then tag the pages in the same change: `node scripts/kb.mjs set <id> --tags '["a","b"]'`,
the one topic first and the rest in facet order. The writer rejects an unknown tag, a count
outside 2-5 and a list out of facet order before it reaches a file.

## Retiring a tag

Criteria: under three uses, a kind marker, or subsumed by a neighbour. **The honest cost is
retagging every page that carries it** — removing the tag from `tags.json` without that fails
the tags gate on every one of those pages. That makes retirement a separate,
explicitly-approved act, not something to slip into another change.

The 2026-08 sweep retired four and retagged the 25 pages carrying them: `test-doubles` → the
`testing`/`testability` pair it duplicated, `legacy` → `integration` or `maintainability`
depending on the page, `instantiation-control` → `lifecycle` (&ldquo;creation, reuse and
disposal&rdquo; is the wider home), `buffering` → `backpressure`. That is the worked example
of what retirement costs.

Standing candidates, with counts from the last audit (count again with
`git grep -l "tags:.*<tag>" -- docs`; they move):
`immutability` (7), `authentication` (7), `transformation` (8), `low-level-design` (9).
None is an obvious retirement — each names something no neighbour covers — so the next tag
move is more likely enrichment than trimming. `principle` pages average 3.41 tags and never
reach five, which is the weakest facet on the hub and the one kind worth enriching.

## Banning a word

A house word goes into `docs/data/glossary.json` under `house`: the `term` to write and the
`avoid` phrasings banned in its place. The vocabulary gate then fails every markdown prose
line git lists that uses a banned phrasing, outside code and the lines that opt out with
`<!-- vocab-ok -->`. Ban a phrasing only when failing a build over it is acceptable, and
never one whose words appear in a path. Run `make gen` so the glossary page shows the term.

## The synonym table

Two layers in `docs/data/search-synonyms.json`, and **curated always wins**: a key in
`curated` takes its value wholesale, so any target only `expansions` names under that key is
dead; the search-synonyms gate fails an expansion key that curated holds too.

**The rule that governs every bridge:** both scorers match a word whole, at the start of a word
or inside one from four letters, so a corpus word already retrieves itself. `"microservice"`
finds a page saying `microservices` with no help.
**A bridge pays only where the word a searcher types differs from the word the corpus
uses** — which is why counting "new words since the last stamp" measures nothing, and why
295 of the existing keys are themselves corpus words. The table is morphological and
near-synonym bridging, not vocabulary import.

Adding a bridge, in order:

1. Pick a page that ranks only for a word from its own name: `node scripts/kb.mjs find` with
   the words its sufferer would type finds it low or not at all. Record the miss as a case in
   `docs/data/search-oracle.json` first (`{"q": "<the query>", "top": ["<page id>"]}`), so the
   search-oracle gate is red until the bridge works.
2. Ask what someone with that problem would type who does not know the page's name. Plain
   English and ops vocabulary pay best; the obvious technical word usually matches already.
3. Check the key does not already match directly. If any page's id, title, description,
   aliases, tags or solves *contains* the key as a word (or, from four letters, as a substring),
   the bridge is dead weight.
4. Pick targets **from the corpus vocabulary**. An invented target is the most common
   mistake — `saturated`, `fragile` and `coupling` all read like corpus words and are not.
5. **Then check what the target actually retrieves.** A target can be in the corpus, pass
   every structural rule, and still be wrong, because it means something else here:
   `governance → hierarchy` shipped a bridge whose top hits were `visitor` and
   `composition-over-inheritance`, since `hierarchy` in this corpus is a *class* hierarchy
   five times out of six. Polysemy is invisible to every gate and to the df count. Run
   `kb.mjs find <key>` on every new key before you keep it.
6. Add it under `expansions`, alphabetically, 1-4 targets.

Structural rules every key must meet: a lowercase word of 2+ characters **and letters only**
— `ai`, `ml` and `db` are keys, and a product name carrying a digit is out, so `ec2` is not
available and the bridge has to be built from a letters-only word a searcher would also type;
not a stopword (the two-letter function words `is`, `to`, `my`, `it` … are stopwords); 1-4
targets; no self-reference; every target is in the corpus vocabulary; **no target that
contains its key** (the shorter key already matched it — note this is directional,
`alerting → alert` is the whole point); no duplicate targets; keys sorted. One gate holds
them all: the search-synonyms gate (`tools/src/gates/check-search-synonyms.ts`), where the corpus
vocabulary is the words of every page's declared facts (slug, title, description, aliases, tags,
`solves`). `curated` keeps its own order and may bridge a word to a longer one.

Two rules the machine cannot check, so they are yours: **do not bridge to a broad word**
(a target on 40+ pages — bridging to `latency` or `resilience` floods every result set;
`grep -rlw <target> docs | wc -l` counts it), and **do not add a marginal bridge for the count**. A two-letter key matches a whole word only (`ai`
never finds "maintain"), so its targets do the reaching. Ranking is
zero-sum; the relevance test's top-1 floor is the canary, so run
`make tools-test T=relevance` every ~20 keys rather than once at the end, or a regression
cannot be bisected.

## Re-stamping

The stamp is the `expansionMeta` object in `search-synonyms.json`: the corpus the expansions
were written against. Update it by hand at a release boundary, **not after every page** —
`entries` to the number of keys under `expansions`, `generated` to the day — and keep the keys
sorted; the diff is then exactly the stamp. No program writes it.

## Done means

- `make gen && make validate` exits 0 — the vocabulary, glossary-fresh, tags, tags-fresh,
  search-synonyms, search-synonyms-fresh, search-oracle, kb-shape, relations and
  site-structure gates among them.
- A new tag or area is in its data file and in its tuple in `site/src/lib/types.ts`, in the
  same commit as the pages that use it.
- `make tools-test T=relevance` passes after any change to the synonym table.
- `node scripts/kb.mjs find "<the words a searcher would actually type>"` actually retrieves
  the page a new bridge targets — a structurally valid bridge can still be useless.
