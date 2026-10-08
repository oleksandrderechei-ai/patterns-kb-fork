---
name: stack-pick
description: "Compose a technology stack for a task from the KB: split it into needs, find each pattern, follow its \"Implemented by\" edges, read the chosen vendor's column (AWS by default). Use when asked to \"pick a stack\", \"what AWS services for X\" or \"build this on Azure\". Not for one product's alternative (alt-pick) or one pattern (pattern-tech-map)."
---

# stack-pick — from a task to a vendor's stack

The deliverable is a stack: one row per need, each row a pattern and the service that sells
it, all from ONE vendor — **AWS unless the user names another** (Azure, Google Cloud, or
open source / self-hosted). Grounded in the KB's mapping tables first, certain knowledge
second, fabrication never. The neighbour skill `pattern-tech-map` maps ONE pattern to its
technologies; this one composes a whole stack. Never open a page file — `docs/**.md`, or the HTML
`make site-build` writes — every step below goes through `node scripts/kb.mjs` (~600 tokens per grounded answer).

## The workflow

1. **Decompose the task into needs.** A "task" hides several: where state lives, how
   services talk, what fronts the traffic, who signs the users in, what runs the code.
   List the needs before touching the KB — 3 to 7 is typical. Keep the user's own words
   for each.

2. **Find the pattern for each need.** `node scripts/kb.mjs find "<the need, in their
   words>"` — the `solves` phrases are written as symptoms, so the raw complaint beats a
   paraphrase. Confirm fit with `kb.mjs get <id> --block usage` when the hit is not
   obvious; check "Avoid when".

3. **Follow the pattern to its products.** `node scripts/kb.mjs related <pattern>` and
   read the **Implemented by** entries. A `capability` page (e.g. `messaging`) carries the
   cross-cloud mapping table; a `comparison` page (e.g. `message-brokers`) argues the
   product choice in depth. No "Implemented by" edge means the cloud does not sell this
   pattern — you build it; say so in the row.

4. **Read the vendor's column.** `node scripts/kb.mjs get <capability> --block mapping`
   and take the requested vendor's cell for the row that matches the need. For an
   open-source stack, or when the user asks "which of these products", switch to the
   comparison page: `kb.mjs get <comparison> --block matrix` for the facts and
   `--block choosing` for the verdict logic. The site's stack page
   (`map/stack.html`, built by `tools/src/site/gen-map-pages.ts`, one top-level sidebar link
   named From Pattern to Product) is the reader-facing flat index of the same join — point the
   user at it.

5. **Answer as a stack table, then a verdict.** Columns: `Need | Pattern | Service | Why`.
   One vendor consistently down the Service column. Always include the **do-less row** —
   the need the user can meet with what they already run (a database table as queue, the
   framework's session auth). Close with 2–3 sentences on the one or two decisions that
   actually shape this stack, citing stable ids
   (`patterns/messaging/message-queue.md#usage`).

## Anti-fabrication

Every service name comes from a KB cell or from knowledge you are certain of. "The KB has
no mapping for this need" is a good row. Never invent a service, a feature, or a price;
never guess a license — the comparison pages carry the verified ones.

## Done means

- Every Service cell traces to a mapping-table cell, a comparison page, or knowledge you
  are certain of: no invented service, feature or price.
- The Service column holds one vendor top to bottom, with any deviation called out
  explicitly.
- The do-less row is present.
- At least one stable id is cited per pattern picked
  (`patterns/messaging/message-queue.md#usage`).
