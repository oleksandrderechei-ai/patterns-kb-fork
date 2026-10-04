# StackIndex

## Intent

The pattern-to-product tables on `map/stack`: every pattern against the AWS, Azure, Google Cloud and open-source product that sells it.

## Purpose

One index answers "what do I buy for this pattern", and shows the gaps as plainly as the answers.

## Gotchas

The rows come from `tools/src/lib/site-map.ts` at build time: an `implements` relation with a pinned mapping row copies that row's cells; one without links the capability's whole table; none is a dash. An `implements` relation from a comparison page adds a Compare link to the row, and counts the pattern as covered even when its cells are dashes.

A dash is a verdict only where `docs/data/stack.json` gives one: a band note, or a pattern's own reason (row state `none`, the reason printed under the pattern). Every other dash is a `gap` in the index, never a claim about the market. A verdict fails the build the moment a capability implements the pattern: the note would be wrong.

Product links are the one kind of outbound link the site writes; the registry is `docs/data/products.json`, linked by `productLinker` in `tools/src/lib/site-map.ts`.

## Tradeoffs

Cells are copied HTML (`set:html`), not re-rendered markdown: the capability page's words, links and all, with no second renderer to keep in step.
