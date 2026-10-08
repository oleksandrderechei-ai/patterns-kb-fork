---
name: kb-find
description: "Find the right design pattern for a problem and answer with KB citations, without loading the corpus. Use when someone describes a symptom ('my thread pool is exhausted'), asks which pattern fits, or how two differ. Not for discussing one page (kb-discuss), reviewing it (kb-design-review) or composing a design (kb-compose)."
---

# Finding a pattern for a problem

The corpus is millions of tokens. Never open a page file — `docs/**.md`, or the HTML
`make site-build` writes: one raw page spends thousands of tokens, much of it markup.
Everything below goes through `scripts/kb.mjs`, which strips the markup and returns prose —
a full grounded answer costs about 600 tokens instead.

## 1. Search with the user's own words

Do not translate their symptom into pattern vocabulary first — the index is built for
exactly this. `solves` phrases are written as symptoms ("one failing dependency took
down my whole service"), so the raw complaint searches better than your paraphrase of
it.

```
node scripts/kb.mjs find "one slow dependency blocks my threads"
node scripts/kb.mjs find "stale reads" --tag caching       # scope by tag, band or kind
node scripts/kb.mjs find --tag resilience                  # filter alone = a listing
```

Each hit prints the line that matched, so you can often judge relevance without opening
anything. `find` ranks a name, a shelf or a tag (one or two words: "circuit breaker",
"resilience", "case study") by where the word is found, title first, then category, then tag,
and only then the text; a symptom (three words or more) by what the pages say — so pass the
whole sentence, not keywords. Short queries and acronyms work: `find ai`, `find gen`,
`find ml`, `find CB`. A word matches whole, at the start of a word, or inside one from four
letters, so `gen` finds "generation" and not "agent". A synonym map bridges near-misses
("outdated" reaches pages that say "stale"), at half weight so exact vocabulary still wins.

## 2. Open only the blocks you need

Usually `usage` (when to reach for it, when not to) and `tradeoffs`. For "how do I run
this in production" questions, the `production` block carries knobs, signals, failure
modes and a readiness checklist. Rarely the whole page.

```
node scripts/kb.mjs get circuit-breaker --block usage
node scripts/kb.mjs get bulkhead --block tradeoffs
node scripts/kb.mjs get thread-pool --block production
```

## 3. Check the neighbours before answering

Patterns are rarely the whole answer, and the relation notes say why two go together.
This is where the KB earns its keep.

```
node scripts/kb.mjs related circuit-breaker
```

`combines-with` → often both are the real answer. `alternative-to` → name the trade-off, do
not pick silently. `often-confused-with` → say so explicitly; that confusion is probably
why they are asking.

## 4. Answer with citations

Every claim has a stable id. Cite it:
`patterns/distributed/resilience/circuit-breaker.md#tradeoffs-con-2`.

## Answering well

- **Usually more than one pattern applies.** "One slow dependency blocks my threads" is
  Bulkhead (isolate the pool) *and* Circuit Breaker (stop calling it) — they combine. Say
  that rather than picking one.
- **Lead with the trade-off, not the name.** The user wants to fix a problem, not collect a
  pattern. Say what it costs: another stateful thing to tune, thresholds that flap.
- **Check `avoid-when` before recommending.** If their case is in it, say so. "A simple
  timeout plus a bounded retry already covers the risk" is often the honest answer.
- **Hazards are answers too.** If the symptom describes an anti-pattern (`kind: hazard` in
  the results), the fix is in its `mitigation` block, and the patterns that fix it are the
  `mitigated-by` edges in its `relationships` block.
- **Themes answer "how do I think about X".** For a broad question ("how do I handle traffic
  spikes"), a theme's `decide` block is a literal problem→pattern table.

## 5. If nothing good comes back

Try the symptom a second way — different words, no jargon — then scope it with `--kind` or
`--band`. If it is still thin, say so plainly rather than forcing a weak match; `ls --band
<band>` lets you browse an area instead. A wrong pattern is worse than none.

When a page that exists was missed, record the query in the search oracle,
[docs/data/search-oracle.json](../../../docs/data/search-oracle.json), first: add a case with
the query and the page it must reach, watch `make gate G=check-search-oracle` go red, then add
the synonym through the [kb-vocab](../kb-vocab/SKILL.md) skill until it is green.

## Done means

- The search ran on the user's own words before any paraphrase, and a second try used
  different wording if the first came back thin.
- The answer opens only the blocks the question needed, not the whole page.
- `related` was checked, and every relevant neighbour — `combines-with`,
  `alternative-to`, `often-confused-with` — is named rather than silently dropped.
- Every claim in the answer carries a stable, clickable element id, and no tool call opened
  a page file (`docs/**.md`, or the HTML `make site-build` writes).
- A weak or absent match was said plainly, not forced.
