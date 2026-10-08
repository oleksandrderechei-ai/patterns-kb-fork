---
title: Retrieval contract
description: What a program can rely on when it reads the KB from kb.mjs or the site, how the contract changes and which test holds each promise.
area: reference
owner: Oleksandr Derechei
tags: [api-design, testability]
status: stable
---

# Retrieval contract

This page is for whoever builds a reader of the KB: a crawler that collects pages from the site,
or an agent that calls `kb.mjs`. It says what you can count on, where each file is, how a call
fails, how the contract changes and which test holds each promise. The contract has four parts:
`kb-record/1` for a page, `kb-graph/1` for the link graph, `kb-index/1` for the site's
`index.json` and `kb-cli/1` for the `--json` output of the other `kb.mjs` read commands.

## What you can rely on

A page has one JSON shape, the record, and five things hold for it.

- **One record, two ways to get it.** `kb.mjs record <id>` prints the same bytes as the site's
  `<page>.json`, so what you test on the command line is what a crawler downloads.
- **Every key is there.** A key that does not apply holds `null`, `[]` or `false`, so you read
  a key without asking whether it exists.
- **Every output fits its schema.** The record of every page and the `--json` output of every
  read command are checked against a published JSON Schema on every commit, and the check
  refuses a key the schema does not list.
- **The same pages give the same bytes.** Keys come in the order the schema lists them, lists
  come in page order, and a record holds no date: `source.sha256` changes when the page does.
- **Element ids follow position.** `tradeoffs-con-2` is the second con today, and another item
  if someone adds one above it. Cite `circuit-breaker#tradeoffs-con-2@<fp>`, where `fp` is a
  hash of the element's words, and ask `kb.mjs resolve` later whether the citation still holds.

## The surfaces

The site is at `https://odere-pro.github.io/software-design-atlas/`. Each page's files sit beside its
`.html`: `circuit-breaker.html` has `circuit-breaker.md` and `circuit-breaker.json` next to it.

| What | Get it with | Schema | Notes |
| --- | --- | --- | --- |
| A page as data | `kb.mjs record <id>`, or the site's `<page>.json` | `kb-record-1.json` | The same bytes both ways. `--block a,b` keeps only those blocks and names them in `scope`. |
| Every page as data | `kb.mjs record --all` | `kb-record-1.json`, once per line | One compact record to a line (JSON Lines), in `ls` order. On the site, fetch the records `index.json` lists. |
| A page as markdown | the site's `<page>.md` | none | The file under `docs/`, byte for byte. The record's `source.sha256` is its hash. |
| The link graph | `kb.mjs graph`, or the site's `graph.json` | `kb-graph-1.json` | Every page and every typed edge once, with both sides' notes, then the tours and the prose mentions. |
| The page list | the site's `index.json` | `kb-index-1.json` | Every built page. A page of the KB names its `record`; a hub or a map holds `null` in `id`, `kind`, `band`, `group` and `record`. |
| Search and lookup | `kb.mjs find`, `brief`, `get`, `related`, `backlinks`, `refs`, `ls` and `validate`, each with `--json` | `kb-cli-1.json`, one definition per command | Command line only. On a relation row read `verb`; `type` (and `rel` in `refs`) is an old alias. |
| A citation check | `kb.mjs resolve <ref>…` | `kb-cli-1.json`, the `resolve` definition | Command line only. Each ref comes back ok, moved, changed, ambiguous or gone. |
| A list of the site | the site's `llms.txt` | none | The llmstxt.org shape: a list of `index.json`, `graph.json`, the schemas and `llms-full.txt`, then one line per page, grouped by kind, linking its `.md`. |
| All the markdown | the site's `llms-full.txt` | none | Every page's markdown in `ls` order, each after a `<!-- kb:page id=<id> route=<route> -->` line. |
| The schemas | the site's `schema/<name>.json` | the file itself | Byte copies of `tools/src/contract/schema/`. A record, `index.json` and `graph.json` each name theirs in `$schema`. |

## How to read it

### From the site

1. Fetch `index.json`, or `llms.txt` for a list written for a language model. Both list every
   page of the KB.
2. For a page of the KB, `index.json` gives its `record`: fetch it. A hub or a map has none, and
   its `record` is `null`.
3. Read the page from `blocks`, which hold typed nodes. `anchors` maps every element id to the
   JSON Pointer of its node, such as `/blocks/4/content/1/content/0/items/1`, so you reach an
   element without walking the tree.
4. Cite `id#element@fp`, taking `fp` from the node. The schema's description gives the exact
   rule, so you can compute an `fp` yourself from words you read elsewhere.
5. Treat any answer but 200 as not there. A record exists exactly when `index.json` lists it,
   and a missing path answers 404.

Each page's head also links its files: `<link rel="alternate" type="text/markdown">` to the
`.md` and, for a page of the KB, `type="application/json"` to the record. A crawler that holds
only a page can follow them.

### From kb.mjs

Find the page, then read only the blocks you need:

```bash
node scripts/kb.mjs brief "one slow dependency blocks my threads" --json
node scripts/kb.mjs record circuit-breaker --block usage,tradeoffs
node scripts/kb.mjs resolve circuit-breaker#tradeoffs-con-2@<fp>
```

`find` ranks pages for a symptom, and `brief` adds the theme that governs them and the
neighbours of the best hits. `record --block` returns the blocks as typed nodes with ids and
fingerprints. `get <id> --block usage` returns the same block as clean text, about 180 tokens,
for a prompt. Before you hand an answer on, run `resolve` on every citation: exit 0 means each
one still says what you cited.

## Exit codes and errors

| Code | Meaning | For example |
| --- | --- | --- |
| `0` | Done, including a search that found nothing. | |
| `1` | A well-formed call the KB refuses. Fix the content. | An unknown id or block; `validate` found problems; `resolve` found a citation that is not ok. |
| `2` | A malformed call, or a crash. Fix the command. | An unknown command or flag, `-n` for `--n`, a flag with no value, a missing id or query, a value of the wrong form. |

A call that fails writes one line to stderr and nothing to stdout, with or without `--json`.
The exceptions are the commands whose findings are the answer: `validate --json` and `resolve`
print them and still exit 1, and `validate` without `--json` writes one stderr line per problem.
A call that works with `--json` prints one JSON document and a newline, and `record --all`
prints one record to a line.

The site has no error body to read: any status but 200 means the file is not there.

## How the contract changes

The version is the number after the slash: `kb-record/1` in a record's `contract` key,
`schema/kb-record-1.json` for its schema. Inside one version a schema only gains.

- **Stays in `/1`:** a new key, a new entry in `required`, a new value in an `enum`, a new
  definition, a new branch after the last of a `oneOf` or `anyOf`, `null` added to a `type`, and
  any change to words in a `title` or `description`. A new key may sit anywhere among the
  others; the keys you know keep their order.
- **Needs `/2`:** a key renamed or removed, a type changed or narrowed, an `enum` value or a
  `required` entry removed, a changed `const`, `pattern` or bound, a key moved before one it
  followed.

A new major is a new file, `kb-record-2.json`, beside the old one. The old schema stays
published and frozen, so a reader that knows only `/1` keeps working. What this asks of you:
ignore keys you do not know, expect a new value in a list of allowed values and refuse a
`contract` value you do not know.

The guard is [evolution.test.ts](../../tools/src/contract/evolution.test.ts). Each published
schema has a frozen copy in the [golden folder](../../tools/src/contract/golden/), a byte copy of
the schema as it was last frozen, and any edit of a schema fails the guard until its copy is
current. A break is named with its JSON Pointer. An edit that lost nothing reads "gained only",
and `KB_GOLDEN=update make tools-test T=evolution` refreshes the copy, so the new keys are held
from then on. Update refuses a break, so a break is never frozen by accident. A copy with no
schema file means a published schema was deleted, and a schema with no copy was never frozen:
both fail too.

## What proves each guarantee

Each promise has a test or a gate that fails when it breaks. **Commit** means `make validate`,
the pre-commit hook on the files you staged, and CI. **Site build** means `make site-build` and
the CI `site` job. **Deploy** means the run after each deploy to GitHub Pages.

| Promise | Held by | Runs |
| --- | --- | --- |
| Every record and every `--json` output fits its schema, with no extra key and keys in schema order, for every page | gate `kb-record-schema`, [check-kb-records.ts](../../tools/src/gates/check-kb-records.ts) | Commit |
| The same, plus the error shape and the exit codes, on a fixture tree | [json-contract.test.ts](../../tools/src/kb/json-contract.test.ts) | Commit |
| The same pages give the same bytes: twice, on a cold and a warm cache, on two dates, with LF and one newline at the end | [determinism.test.ts](../../tools/src/kb/determinism.test.ts) | Commit |
| A record's bytes change only on purpose | [record-golden.test.ts](../../tools/src/kb/record-golden.test.ts), with its files in the [golden folder](../../tools/src/kb/golden/) | Commit |
| A record holds what the page says: its elements, ids and words equal what the site's own markdown pipeline renders | [kb-record.test.ts](../../tools/src/lib/kb-record.test.ts) | Commit |
| A schema only gains inside its version, and its frozen copy is kept current | [evolution.test.ts](../../tools/src/contract/evolution.test.ts) | Commit |
| Retrieval finds the right pages | the `covers` cases of [search-oracle.json](../../docs/data/search-oracle.json) and the floors of [relevance.test.ts](../../tools/src/kb/relevance.test.ts) | Commit |
| The site serves what `kb.mjs` prints: records byte for byte, `graph.json`, `schema/`, `llms.txt`, `llms-full.txt`, `index.json` and the links in each head | gate `site-portable`, check 8, [check-site-portable.ts](../../tools/src/gates/check-site-portable.ts) | Site build |
| The HTML data layer says what the record says | gate site-parity, [check-site-parity.ts](../../tools/src/gates/check-site-parity.ts) | Site build |
| The live site answers as the contract says | [site-smoke.ts](../../tools/src/site/site-smoke.ts), the `smoke` job of [pages.yml](../../.github/workflows/pages.yml) | Deploy |

## Known limits

- **Diagram source is in the `.md` and the record, not in the HTML.** The HTML holds the drawn
  diagram. A crawler that needs the source reads a figure's `code` in the record, or the `.md`.
- **Three theme pages have two kinds.** `harmful-content`, `bot-detection` and
  `video-recommendations` are themes filed under case-study areas. The search payload the site's
  search box loads takes a page's kind from its top area, so it calls them case studies. The
  record takes the kind from the folder and says theme. The record wins, and `index.json`
  agrees with it.
- **Search is a way in, not a full answer.** Use each case study's non-functional requirements
  and `solves` lines as queries. `find` returns 0.40 of the patterns the case study
  demonstrates in its first five hits, and `brief` reaches 0.83 of them with its matches, the
  edges it lists and its theme's tour together (measured 2026-10-08). The floors in
  [relevance.test.ts](../../tools/src/kb/relevance.test.ts) are 0.38 and 0.80. For the rest, read
  the case study's `demonstrates` edges.
