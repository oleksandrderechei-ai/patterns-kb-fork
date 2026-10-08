# Software Design Atlas

A cross-linked reference of **255 software design patterns, 41 design case studies, 51
themes, 45 hazards, 36 principles, 10 cloud capabilities and 10 product comparisons — 448
pages in all**, written to be learned from: every page answers the same questions in the
same order, and every page says how it relates to its neighbours.

Live at **https://odere-pro.github.io/software-design-atlas/**. Formerly `patterns-kb`.

## What you'll find

| Kind | What it is |
|---|---|
| **Patterns** | the mechanisms — GoF, concurrency, caching, distributed systems, enterprise integration |
| **Designs** | worked case studies: system-design and low-level-design katas, arguing the hard sub-problems |
| **Themes** | narratives that cut across patterns (CAP, streaming, traffic spikes, auth) |
| **Hazards** | anti-patterns, and what they cost |
| **Principles** | design maxims (SOLID, DRY, KISS, YAGNI) — including how each fails when overapplied |
| **Capabilities** | categories of managed cloud service, mapped across AWS/Azure/Google Cloud and back to the patterns they package |
| **Comparisons** | one product decision each: the managed services and open-source contenders side by side, and the conditions that decide |

Every page of a kind carries the same blocks in the same order — a pattern is always
`description → explain → structure → variations → tradeoffs → usage → sketch → relationships`,
with "In the wild", "In production" and "Where it shows up" before the last when it has them.
Same question, same place, on every page: that is what makes it readable as a course rather
than a pile of articles.

## Three ways to use it

- **Browse the site.** Build it with `make site-build` and open `site/dist/index.html`, or
  read it live: one hub per area, each row with a one-line essence, a practiced mark and a
  favourite star. The built site works offline from its folder; no server needed.
- **Search by symptom.** Type the problem you actually have — "one slow dependency blocks
  my threads" — and the search box ranks the pages that fix it, each row quoting the
  symptom it answers.
- **Follow the relationships.** Every page ends with typed neighbours — `combines-with`,
  `alternative-to`, `prevents-hazard` — each with a note saying why. The sidebar's
  **From Pattern to Product** link (`map/stack.html` on the site) lists every pattern beside
  the cloud product that sells it.

## From a terminal

`scripts/kb.mjs` searches the full prose of every page and returns clean text, so you never
have to open a page whole. The pages themselves are markdown under [`docs/`](docs/README.md):

```bash
node scripts/kb.mjs find "one slow dependency blocks my threads"   # symptom → pattern
node scripts/kb.mjs get circuit-breaker --block usage              # one block, ~180 tokens
node scripts/kb.mjs related circuit-breaker                        # typed neighbours + notes
```

Every claim has an id, so it can be cited precisely: `…/circuit-breaker.md#tradeoffs-con-2`.
Programs read a page as JSON, with `node scripts/kb.mjs record circuit-breaker` or the site's
`<page>.json`; what they can rely on is in the
[retrieval contract](docs/concepts/retrieval-contract.md).

## Licence

The code is under the [MIT licence](LICENSE): `tools/`, `site/`, `scripts/`, `.claude/`,
`.githooks/` and `.github/`. The content, meaning the pages and data under `docs/` with their
diagrams, is under [Creative Commons Attribution 4.0](LICENSE-CC-BY-4.0) (CC BY 4.0). You may
copy, adapt and share it, commercially too, as long as you give credit:

> [Software Design Atlas](https://odere-pro.github.io/software-design-atlas/) by Oleksandr
> Derechei, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

A code sketch inside a page may also be used under the MIT licence.

---

Your practiced and favourite marks stay in `localStorage`; nothing leaves your machine.
Contributing — the page format, the build, how to add a page — is covered in
[.claude/rules/markdown-authoring.md](.claude/rules/markdown-authoring.md); `make gen` and
`make validate` are the loop.
