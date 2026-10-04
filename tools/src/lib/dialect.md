# The markdown dialect — how a page under `docs/` is written

Every page under `docs/` is written in this dialect, and every rule is numbered `D-nn` (or
`X-nn`) so a gate, a test or a commit can cite it. The pages were converted once from the
HTML pages the site used to be built from, by a converter and a round-trip proof that have
since retired with that HTML (git history holds both). Rules that say what the converter did with an HTML construct record where a page's
shape came from; the rule for the markdown itself holds for every page written since.

The executable half of this specification is `tools/src/lib/kb-attrs.ts` (suffix grammar,
section facts, the ids it issues, the element list), `tools/src/lib/md-text.ts` (the text escaping
every writer shares: D-06, D-07, X-02, the relative link of D-03) and
`tools/src/lib/frontmatter.ts` (the frontmatter printer, and the door to the one parser,
`scripts/fm-json.sh`). Where prose here and code there disagree, the code decides and this
file is fixed in the same change.

Measured over the 382 pages at `fdcab47`; the numbers are for orientation.

---

## 1. Shared conventions

**D-01 · Paths.** One page, one file. `site/<path>.html` → `docs/<path>.md`, same folders,
same basename: `site/patterns/distributed/resilience/circuit-breaker.html` →
`docs/patterns/distributed/resilience/circuit-breaker.md`. The slug is the basename and
equals today's `data-kb-id`.

**D-02 · Routes.** A page's route is `/` + its site-relative HTML path:
`/patterns/distributed/resilience/circuit-breaker.html`. Every data file that names a page
by route uses exactly this string (`site-structure.json` `route`, `learning-paths.json`
`stages` and `notes` keys). It keeps every inbound URL, and it deviates from the spec's
"slashed at both ends" on purpose — the plan keeps file routes (`build.format: 'file'`).

**D-03 · Links.** Every prose link today targets a page, never a fragment (5,115 links, all
page-to-page). A link becomes the relative path to the target's markdown file, computed from
the linking file's folder: `href="../routing/service-mesh.html"` →
`](../routing/service-mesh.md)`. A `#fragment` is kept after `.md` when one ever appears; a
target that is not a page is reported, never rewritten.

**D-04 · Levels (retired).** Reading levels are gone: a page reads at one depth, no element carries a
level and none is shown or hidden by one. `data-kb-level` and `data-kb-register` on a source page are
dropped.

**D-05 · Bytes.** Output is deterministic and idempotent: the same HTML gives the same
bytes on every run. UTF-8, LF line endings, exactly one `\n` at the end of the file, no
trailing spaces, one blank line between blocks, never two. No line wrapping: a paragraph, a
list item's text, a heading and a table row are each one line (a hard break is the only line
break inside them, D-30). Nothing in any file depends on the date; a data file's `updated`
is the committer date of `HEAD` (`git log -1 --format=%cs HEAD`) at the run that changed its
content. A run whose output differs from the file on disk only in `updated` keeps the file as
it is (`dataDate` in `tools/src/lib/data-json.ts`), so a later commit alone, on another day, never makes a
data file stale to its own `--check`; any other changed byte takes HEAD's date.

**D-06 · Markup characters.** Text is written so that CommonMark + GFM reads back exactly the
HTML text (entities decoded). Escape with a backslash only where the character would really
start markup, so the source stays readable:

- always: `\`, `` ` ``, `*`, `[`, `]`;
- `_` unless it sits between two letters or digits (an intraword `_` cannot open emphasis);
- a `<` before a letter, `/`, `!` or `?` (one that could open a tag);
- an `&` that would form an entity or character reference;
- `|` inside a table cell;
- `~` only when two tildes in one inline could pair as GFM strikethrough — a left-flanking
  `~` before a right-flanking one, by CommonMark's flanking rules — so `~100 … ~42` and
  `(~1k)` stay as written while `a ~b~ c` is escaped;
- at the start of a line, only when the line would otherwise start a block: `#` to `######`
  followed by a space or the end, `>`, `-` or `+` followed by a space or the end, `N.` or
  `N)` followed by a space or the end, a line of `=` only, a `---` thematic break, a `~~~`
  fence. `99.9%`, `-5` and `#hashtag` stay as written.

U+00A0 is written `&nbsp;` (337 inside pages today) so it stays visible, and it is text, not
whitespace, to every reader of the dialect (`plainText`, the round-trip's words), exactly as
in a browser. A literal brace group that ends an element's text after a space is written
`\{` (D-22, X-02).

**D-07 · Autolinks.** GFM turns a bare email address, a `www.` host and an `http://` or
`https://` URL in text into a link, and neither a backslash escape nor a character reference
stops it: the autolink-literal pass runs on decoded text nodes. Where today's text holds one
outside a link, the writer splits the text node with an empty HTML comment, before the `@` of
an address, the `.` of `www.` or the `:` of a scheme — `john<!-- -->@example.com`. Readers
drop raw html from text, so the words do not change. `autolinkBreaks` in
`tools/src/lib/md-text.ts` mirrors the pass (its two patterns, its previous-character and
domain tests). One today: `designs/job-scheduler`, `entities-li-2` (X-14).

If you stringify through `remark-stringify`, the options that give these bytes are
`bullet: '-'`, `strong: '*'`, `fence` as a backtick, `listItemIndent: 'one'`,
`incrementListMarker: true` and, for GFM, `tablePipeAlign: false`. Add suffix text after
stringifying: `mdast-util-to-markdown` escapes a backslash you put in a text node, so a `\{`
written into the tree comes out `\\{`.

---

## 2. The file

```markdown
---
title: Circuit Breaker
description: Stops calling a service that's already failing
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, isolation, latency]
status: stable
aliases: [breaker, CB]
solves: [my thread pool is exhausted and every request hangs, …]
source: site/patterns/distributed/resilience/circuit-breaker.html
---

<!-- GENERATED by tools/src/migrate/html-to-md.ts from site/patterns/distributed/resilience/circuit-breaker.html. Do not edit this file. -->

# Circuit Breaker

Stops calling a service that's already failing — so callers fail fast instead of piling on, and the struggling dependency gets room to recover.

## What it is
<!--meta block=description-->

A service you call stops answering. …
```

**D-10 · Frontmatter.** Printed by `printFrontmatter` in `tools/src/lib/frontmatter.ts` and
by nothing else, keys in this order, each present exactly when stated:

| Key | Value | From today |
| --- | --- | --- |
| `title` | the H1, trimmed | `h1.doc-title` text |
| `description` | one line | `data-kb-essence`, verbatim (4 pages exceed 160 characters; written anyway, the frontmatter gate reports them) |
| `area` | a leaf area id | the area table, D-11 |
| `owner` | `Oleksandr Derechei` | constant |
| `tags` | inline list, today's order | `data-kb-tags`; `[]` on the 2 pages that carry none (the tags gate reports them; the facet retag is a later phase) |
| `status` | `stable` | constant |
| `aliases` | inline list | `data-kb-aliases`, only when the attribute is present (303 pages, 5 of them `[]`) |
| `solves` | inline list | `data-kb-solves`, only when present (340 pages) |
| `favourite` | `true` | only when `data-kb-favourite="true"` (37 pages) |
| `source` | — | not written on a page (D-13) |

`id`, `kind`, `band`, `group` and `order` are not keys. The slug is the file name, the kind
is the top folder under `docs/` (D-11), band and group come from the area chain, order from
the structure file's row order.

Scalars and list items are plain unless plain YAML would read them back differently; then
they are double-quoted with `\\` and `\"` as the only escapes. Quoted when the value holds a
comma or a colon (owner's rule), any of `# [ ] { } " \`, starts with a YAML indicator
(`- ? & * ! | > ' % @` backtick) or a space, ends with a space, is empty, or reads as a
boolean, a null or a number. `yamlScalar` is the rule; its test proves every printed value
reads back unchanged through `scripts/fm-json.sh --lists`.

**D-11 · Area.** `area` is the leaf area the page sits in on today's hub. Case studies are
banded foundational, intermediate and advanced only through their `designs-*` areas. Area
ids of the page-kind subgroups are prefixed with their kind so no area id is also a level
name.

| Area id | Parent area | From | Pages |
| --- | --- | --- | --- |
| `gof-creational`, `gof-structural`, `gof-behavioral`, `gof-extra` | `gof` → `patterns` | `data-kb-group` | 5, 7, 11, 6 |
| `enterprise`, `architecture` | `patterns` | `data-kb-group` (= band) | 8, 17 |
| `distributed-resilience`, `-routing`, `-scale`, `-coordination`, `-data` | `distributed` → `patterns` | `data-kb-group` | 13, 19, 13, 16, 14 |
| `concurrency`, `ml` | `patterns` | `data-kb-group` | 14, 7 |
| `messaging`, `caching`, `ddd`, `functional`, `security` | `patterns` | `data-kb-group` | 21, 8, 6, 6, 9 |
| `testing`, `frontend` | `patterns` | `data-kb-group` | 10, 6 |
| `hazards` | — | kind | 36 |
| `principles-craft` / `principles-systems` | `principles` | `PRINCIPLE_GROUPS` membership | 15 / 12 |
| `themes-starting` | `themes` | `THEME_GROUPS` | 4 |
| `themes-shaping`, `themes-data`, `themes-scale` | `themes` | `THEME_GROUPS` | 7, 8, 7 |
| `themes-operating` | `themes` | `THEME_GROUPS` | 13 |
| `designs-foundational` / `designs-intermediate` / `designs-advanced` | `designs` | `DESIGN_GROUPS` | 13 / 16 / 15 |
| `capabilities`, `comparisons` | — | kind | 10, 10 |

An area's `label` is the hub's own short name for it: a kind's area takes its hub section's
`h2` title without a tagline (`Hazards & Antipatterns`, `Themes`, `Case Studies`), and any
tagline goes in `hub.description`; it falls back to the Kind facet chip only where the hub has
no section. A band takes its `BANDS` label, a band's group its group label, an editorial group
its `*_GROUPS` label. `hub.description` and `hub.intro` come from `KINDS`, `BANDS` `desc`, the
groups' `note` and the hub's section leads (the retired converter named each
rule where it applied it). Three theme-kind pages
(`harmful-content`, `bot-detection`, `video-recommendations`) are placed by `DESIGN_GROUPS`,
not `THEME_GROUPS`: their area is their designs tier, their file stays in `docs/themes/`, and
their kind is `theme` because **kind is the top folder under `docs/`** (`patterns`, `hazards`,
`themes`, `principles`, `designs`, `capabilities`, `comparisons` → the seven kinds), not the
top ancestor area. That is the one place those two derivations differ; see decision X-03.

**D-12 · Body opening.** A blank line after the frontmatter, then the stamp line of D-13 and a
blank line, then `# <title>`, a blank line, then the intro paragraph: the inline content of
`p.doc-essence` (it may hold `code` and a link). Nothing else sits above the first `##`
(PAGE-001). Nothing above the first `##` gets an id.

**D-13 · The page is the source.** Until the P5 cutover a converted page was build output of
its site page: it carried the converter's whole-file stamp as its first body line and a
`source: site/<path>.html` key as its last frontmatter key, and a gate failed a hand edit. The
cutover dropped both, so a page carries no stamp and no `source` key, and it is edited in
place. `source` stays a legal key only for a page a generator writes (page-block `OPTIONAL`).

---

## 3. The data layer: suffixes, fence meta, section facts

**D-20 · Blocks.** Every `<section data-kb-block="X">` becomes

```markdown
## <text of its h2>
<!--meta block=X-->

<content>
```

The fact comment sits on the line right under the heading. The heading's id is issued from
the fact (`X`); it is never written. The `h2`'s own id today (`h-desc`, `h-trade` — aria
wiring) is dropped (D-72). A block heading takes no explicit id.

**D-21 · Groups.** An `h3` that heads a sided column becomes an `###` heading plus a fact:

| Today | Markdown |
| --- | --- |
| `.col.pros` / `.col.cons` (tradeoffs) | `### <h3>` + `<!--meta polarity=pro-->` / `polarity=con` |
| `.when` / `.avoid` (usage) | `polarity=when` / `polarity=avoid` |
| `.prod-knobs` / `.prod-signals` / `.prod-failures` / `.prod-checklist` (production) | `polarity=knob` / `signal` / `failure` / `check` |
| `.functional` / `.nonfunctional` (requirements) | `requirement=fr` / `requirement=nfr` |

A group runs from its `###` to the next heading of depth 3 or less. `requirement` is the one
fact key beyond `block` and `polarity`; today's FR/NFR ids are projected from a class, and a
class is never data (X-01). Each group value belongs to one block — `pro`/`con` to
`tradeoffs`, `when`/`avoid` to `usage`, `knob`/`signal`/`failure`/`check` to `production`,
`fr`/`nfr` to `requirements` (`GROUP_BLOCKS` in `kb-attrs.ts`, which `content-model.json`
publishes) — and a group under any other block is a `fact` problem, since its ids would be issued
as `<wrong block>-pro-N`.

**D-22 · Inline form.** A trailing `{…}` at the end of a paragraph, a heading, a list item
(the end of its first paragraph) or a table row (the end of its last cell) applies to that
element. The `{` follows a space. Contents: `#id` alone. `{#wild-envoy}`.

**D-23 · Block form.** A paragraph that is only `{…}`, one blank line after a table, a list,
a blockquote or a fence, applies to that block. The blank line is required: CommonMark glues
a brace line straight after a table into a row, and after a list or blockquote into its last
paragraph (the parser reports both).

```markdown
| Axis | Result |
| --- | --- |
| Writes | 5 row-writes/s |

{#sizing-table-1}
```

**D-24 · Fence meta.** A fence's info string is the language, then `key=value` pairs:
`caption`, `summary`, `wide=true` (and `#id`, never needed); a `level=` token is a KB-004
finding ("`level=` is retired; delete it"). A value is `[a-z0-9-]+` or double-quoted with `\"`
and `\\`. A fence whose meta holds a backtick opens with `~~~` (a backtick fence cannot carry
one in its info string); every other fence opens with three backticks, or more when the code
holds a line starting with three.

**D-25 · Writing levels (retired).** There is no level to write. A `level=` token in a suffix or a
fence's info string is refused with "`level=` is retired; delete it".

**D-26 · Grammar errors.** `parseKb` reports, it never throws: an unknown key, a
`level=` token, a bad id, a brace line glued to its block, a fact on the wrong heading depth, a
duplicate id. A brace group that is refused — it fails to parse, or a block form follows
something that is not a block — stays in the text, so nothing an author wrote disappears. The
kb-shape gate (P3a) turns the problems into numbered-rule findings.

---

## 4. Inline content

**D-30 · Inline elements.** The corpus uses five inline elements inside sections, and each has
one spelling:

| HTML | Markdown |
| --- | --- |
| `<strong>x</strong>` | `**x**` |
| `<code>x</code>` | `` `x` `` (no code span today holds a backtick or markup) |
| `<a href="….html">x</a>` | `[x](….md)` (D-03) |
| `<br>` | a backslash at the end of the line, the text continuing on the next (9, all in `designs/persona-identification`) |
| `<sup>x</sup>` | raw `<sup>x</sup>` (2: `consistent-hashing`, `hyperloglog`) |

HTML whitespace collapses to one space and the element's text is trimmed; only `<pre>` keeps
its bytes. There is no `em`, `i`, `abbr`, `img` or `hr` in any page.

**D-31 · Sublines.** `<span class="subline">X</span>` is the second line of a title (149, all
on the persona pair). It becomes inline text where the span sits, joined by ` — ` (space, em
dash, space), or by a single space when `X` starts with `→`:

- `<h3>1 · The queue lives in the database<span class="subline">→ NFR: scale</span></h3>` →
  `### 1 · The queue lives in the database → NFR: scale`
- `<h4>Mandatory<span class="subline">the product promise</span></h4>` →
  `**Mandatory — the product promise**` (an `h4` is a run-in title, D-45)
- `<p><strong>Q1 — How many flows a week?</strong><span class="subline">→ NFR: scale.</span> Assumed, …</p>`
  → `**Q1 — How many flows a week?** → NFR: scale. Assumed, …`

The class is paint and does not survive; the text does.

---

## 5. Construct by construct

**D-40 · Prose.** `div.prose` dissolves: its children become top-level blocks in place, each
becoming a block of its own. A `p` is a paragraph; `ul` / `ol` a `-` / `1.` list;
nested lists indent to the parent item's content column (2 spaces under `-`, 3 under `1.`).
Two adjacent lists of one type (both `-`, or both ordered) with no block-form suffix after
the first would join into one list across the blank line, so the printer separates them with
a line holding only `<!-- -->` (an html node, which `mintIds` and `deriveElements` pass over).
No page needs it today.

**D-41 · Diagrams.** `figure.diagram > pre.mermaid + figcaption` (629) is one fence:

````markdown
```mermaid caption="How does a dead dependency stop costing the caller anything? The gate passes calls through …"
flowchart LR
    Caller["Your service"]
    Caller -->|"1 call"| Gate
```
````

- The code is the `pre`'s inner HTML with entities decoded (`--&gt;` → `-->`, `&ge;` → `≥`)
  and any element kept as written (`<br>`, 23 today), minus the first newline and the
  whitespace-only last line; internal indentation is kept byte for byte.
- `caption` is the figcaption's text; a `<code>` inside it is written in backticks (15), which
  makes the fence a `~~~` fence (D-24).
- `figure.diagram.wide` (6) adds `wide=true`.
- A `click X "<relative .html>"` line (393, every target a page) is rewritten to the target's
  route (D-02): `click RB "/patterns/distributed/resilience/retry-backoff.html"`. The build's
  portability pass makes it relative again.

**D-42 · Code sketches.** `details.sketch > summary + pre > code[data-kb-lang]` (356) is one
fence whose language is `data-kb-lang` and whose `summary` is the summary text:

````markdown
```typescript summary="TypeScript — one breaker per vendor, state in a shared cache"
class SharedBreaker { … }
```
````

The code is the `code` element's text, entities decoded, exactly (no trailing newline added).
`class="language-…"` is computed and dropped. No sketch is `open` today.

**D-43 · Prose sketches.** A `details.sketch` holding `div.prose` instead of code (22, all on
the persona pair) is a blockquote. Its first paragraph is the summary, alone and bold; the
paragraphs of the `div.prose` follow:

```markdown
> **Why publisher-generated keys fail this exact case**
>
> A key minted when we publish can only collide with events that already exist …

```

A blockquote means this and only this in the dialect (no page uses a `blockquote` today).
A sketch with no summary is reported (D-73) and opens with `***`, a thematic break, so its
first paragraph is not read as the summary.
Inside a list item it indents with the item: 13 on `persona-identification`'s levels block
(`levels-sketch-N` inside `levels-li-N`).

**D-44 · Tables.** `div.table-scroll > table.decision` (82) is a GFM table: the `thead` row is
the header, each `tbody` row a row, cells' inline content per D-30, `|` escaped. The first
column is the row header (the site renders it `th scope=row`). The wrapper's id goes in
a block form after the table:

```markdown
| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Object storage | Amazon S3 | Azure Blob Storage | Cloud Storage | [MinIO](../comparisons/object-stores.md), Ceph |
| Shared file storage, SMB | FSx for Windows File Server | Azure Files | no first-party equivalent | Samba |
```

No table has a span cell, a block element in a cell, a body `th` or more than one header row.

**D-45 · Run-in titles (`h4`).** PAGE-002 forbids H4. An `h4` (150, all on the persona pair)
becomes one of two things:

- In `div.nfr`, `div.entity` and `div.endpoint` it is the bold lead of a list item (D-46).
- Everywhere else (81 in `div.prose` of architecture, sizing and deepdives; 4 functional-tier
  titles in requirements) it is a **run-in title**: a paragraph that is exactly one bold span,
  holding the `h4`'s inline content and subline, with its id:

```markdown
**Rung one — the backlog, because a slow system and a stalled one break the same promise** {#deepdives-h-rung-1}
```

Every `h4` in prose carries a hand-written id today, so a run-in title always has an explicit
`#id` and takes no paragraph number (D-61). The two id-less functional-tier titles become
paragraphs that do take one (`requirements-p-N`, a block with no paragraph ids today).

**D-46 · Containers the markdown has no element for.** Their id moves to the element that now stands for them, or is dropped:

| Container | Becomes | Its id |
| --- | --- | --- |
| `div.entity-group`, `div.endpoint-group` (h3 + items) | `### <h3 + subline>` then a `-` list of the items | on the `###` (`{#entities-group-1}`) |
| `div.entity`, `div.endpoint` (h4 + p + sketch) | a list item: `- **<h4>** — <p inline>`, the sketch fence nested under it | on the item |
| `div.nfr` (h4 + ul) | a top-level item of the nfr list: `- **<h4>**`, the `ul` nested under it; a plain `ul` directly before the `div.nfr` entries in the same `.nonfunctional` (no id) is the start of that one list | today's id is on the `h4` and is issued positionally (`requirements-nfr-N`) |
| `div.outofscope` (h3 + ul) | `### Out of scope`, then the list | on the `###` (`requirements-outofscope`) |
| `ul#…`, `ol#…` | the list | block form after the list (`{#description-ul-1}`) |
| `div.table-scroll#…` | the table | block form after the table (`{#architecture-table-1}`) |
| `div.prose#…` | its children | **dropped and reported**: its first child already has an id of its own in every case (17: `deepdives-prose-1…16` less 10 and 11, `architecture-prose-2`, `-3`, `interface-prose-1`) |
| `div.requirements`, `div.functional`, `div.nonfunctional`, `div.usage`, `div.tradeoffs`, `div.col`, `div.production`, `div.prod-group`, `div.explain`, `div.tour`, `div.wild-list`, `div.fluency-list`, `dl.variations`, `div.rel-list`, `div.rel-group` | their children, per the block's shape (§6) | none today |

The entity and endpoint items make a list the HTML did not have. Their list items take
`<block>-li-N` numbers; every today-id in those two blocks precedes the first group, so no
existing number moves (checked on both persona pages).

---

## 6. Blocks, kind by kind

Every block not named here is generic (D-40 to D-46): `description`, `structure`, `causes`,
`cost`, `mitigation`, `rationale`, `applying`, `overreach`, `tradespace`, `decide`,
`architecture`, `sizing`, `entities`, `interface`, `deepdives`, `levels`, `choosing`,
`portability`, `mapping`, `matrix`.

**D-50 · explain** (every kind; optional on a design). One paragraph, a costs list, then one
example. The paragraph carries no bold label and no level mark, and may link a term on its first
use to that term's page; the costs list is 2 to 4 bullets, each a bold lead and at most 25 words
(required on a pattern, optional elsewhere); the example is a paragraph that opens with the bold
label `Example.`, or one captioned non-mermaid fence (at most 25 lines):

```markdown
## Explained
<!--meta block=explain-->

A circuit breaker is a gate in front of one dependency. It counts recent failures and … (60–180 words)

- **Latency.** Every call pays for the extra check. (2 to 4 bullets, at most 25 words each)
- **Upkeep.** Someone owns the thresholds.

**Example.** Checkout calls a fraud-check service that normally answers in 50 ms. … (at most 120 words)
```

or, with a sketch as the example:

````markdown
## Explained
<!--meta block=explain-->

A circuit breaker is a gate in front of one dependency. … (60–180 words)

- **Latency.** Every call pays for the extra check.
- **Upkeep.** Someone owns the thresholds.

```typescript caption="How does a caller guard one vendor call?"
…(at most 25 lines)
```
````

The block holds exactly these elements, in this order, and no level mark
([KB-014](../../../docs/reference/page-rules.md#KB-014)). The explanation paragraph is issued the
id `explain-text`, each costs bullet `explain-li-N` and the example, paragraph or fence, the id
`explain-example`. The `Example.`
label is the paragraph's first bold run and is part of its text.

**D-51 · tradeoffs, usage, production.** Lead paragraphs (a design's tradeoffs lead, 6) stay in
place; each column is a group (D-21) holding one list:

```markdown
## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- Stops cascading failures from spreading across services.
- Gives the failing dependency space to recover instead of hammering it.

### Cons
<!--meta polarity=con-->

- Another stateful component to tune — bad thresholds cause flapping or false trips.
```

Production items keep their bold label and dash as authored:
`- **Failure threshold** — The count of consecutive failures, …`. A
`p.smell` (17) and the two usage `div.prose` blocks that follow the columns
(`object-storage`, `fan-out`) become paragraphs after the last list; they sit inside the last
group's section and are not items of it (X-06).

**D-52 · variations, capabilities, contenders.** `dl.variations` is a list, one item per
`dt`/`dd` pair, the `dt`'s inline content bold, ` — `, the `dd`'s inline content. A `dt` that links a page links inside the bold:

```markdown
- **Count-based vs. time-window** — Trip after N consecutive failures, or after a failure rate (e.g. >50% of calls in the last 10 s). …
- **[Null Object](../../gof/extra/null-object.md) fallback** — An open breaker can return a cached value …
```

**D-53 · wild.** One item per `div.wild-item`: `- **<strong text>** — <span inline>`, always
with its keyed id: `- **Netflix Hystrix** — Popularized the pattern … {#wild-hystrix}`.
The key is `data-kb-example`, which the name does not determine — hence explicit.

**D-54 · sketch.** Only fences (D-42), in order; ids `sketch-variant-N`.

**D-55 · fluency** (patterns, 130). The heading and fact are written; the content is the
generated `fluency` marked block (D-81).

**D-56 · tour** (themes, 42). Heading and fact, then anything hand-written that precedes the
steps (one figure today, `system-design-interview#tour-fig-1`), then the generated `tour`
marked block (D-82).

**D-57 · siblings** (themes, 42). Hand-written, one item per `div.fluency-item`:
`- [<a text>](<target>.md) — <span inline>`. The link text is kept as authored
(7 differ from the target's title — `Spike Handling` for `Handling Spikes`).

**D-58 · relationships** (340 sections). Heading and fact, then the generated
`relationships` marked block (D-80), and nothing else. The block renders as its list only; no
neighbour figure is drawn, on the page or at build.

**D-59 · requirements** (41 designs).

```markdown
## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Submit a long URL and receive a short URL in return.
2. Optionally choose a custom alias, and optionally set an expiration date.

Out of scope: accounts and click analytics — named explicitly so the design stays narrow.

### Non-functional
<!--meta requirement=nfr-->

- **Uniqueness** — every short code maps to exactly one long URL.
- **Scale**
  - 1M uploads and 100M watches a day, roughly 100 watches per upload.
  - Popularity is concentrated: … {#requirements-nfr-scale-2}
```

The functional list keeps its element (`ol` → `1.`, `ul` → `-`). `p.prose` is a paragraph.
The persona pair's tiers are run-in titles over their lists
(`**Additional — ongoing obligations and governance** {#requirements-h4-2}`,
then the list with `{#requirements-ol-2}` after it); its `div.nfr` entries
are items (D-46); its `div.outofscope` is `### Out of scope {#requirements-outofscope}`
and a list.

---

## 7. Ids

**D-60 · The id table.** `mintIds` in `kb-attrs.ts` assigns every id below from the
markdown structure; the converter writes none of them. "Block" is the `block` fact of the
nearest `##` above; counters restart at every `##`; nothing above the first `##`, and nothing
under a `##` without a fact, is issued an id. "Top-level item" is an item of a list that is a direct
child of the page root.

| Today's id | Issued today from (`build-pages.mjs`) | Markdown construct |
| --- | --- | --- |
| `<block>` (3,443) | `section[data-kb-block]` | the `##` carrying `<!--meta block=…-->` |
| `explain-{text,example}` | `.explain-text`, `.explain-example` | the paragraph, and the `**Example.**` paragraph or the fence, of `explain` |
| `<block>-{pro,con,when,avoid,knob,signal,failure,check}-N` | `.col.pros li` … `.prod-checklist li` | top-level items under a `###` with that polarity, N per block and polarity |
| `requirements-fr-N`, `requirements-nfr-N` | `.functional ol/ul > li`; `.nonfunctional > ul > li` or `> .nfr > h4` | top-level items under a `###` with `requirement=fr` / `nfr` |
| `variations-item-N`, `capabilities-item-N`, `contenders-item-N` | `dl.variations dt` | top-level items in those blocks |
| `siblings-item-N` | `.fluency-item` in siblings | top-level items in `siblings` |
| `mapping-row-N`, `matrix-row-N` (and hand-written `decide-row-N`, 24) | `tbody tr` | table body rows, any block, N across the block |
| `deepdives-dive-N` | `.prose > h3` in deepdives | `###` in `deepdives` |
| `sketch-variant-N` | `details.sketch` in sketch | fences that are not mermaid, and blockquotes, in `sketch` |
| `<block>-sketch-N` | `details.sketch` elsewhere | the same, in every other block |
| `<block>-fig-N` | `figure.diagram` | mermaid fences |
| `<block>-p-N` | `.prose > p` (incl. inside a sketch's `div.prose`) | every paragraph, except a list item's first paragraph, a blockquote's first (summary) paragraph, and paragraphs of `explain` |
| `<block>-li-N` | `.prose li`, nested included | every other list item, any depth, except under a polarity/requirement `###` and in `variations`, `capabilities`, `contenders`, `siblings`, `fluency`, `wild`, `relationships`, `tour` |
| `tour-p-N` | `.tour-step p` | `<block>-p-N` in `tour` (the step paragraphs are the block's only paragraphs) |

**D-61 · Explicit ids.** Everything else travels as an explicit `{#id}`, and an element with an
explicit id takes **no number** in any positional sequence — today's hand-written ids sit exactly
on elements the build never counted, so their neighbours keep their numbers:

- keyed: `wild-<example>` (626), `tour-<member>` (290, written by the generator),
  `fluency-<theme>` (290, written by the generator);
- hand-written headings: `<block>-h-<slug>` (`sizing-h-numbers`, `levels-h-mid`, …),
  `architecture-h3-N`, `levels-h3-N`, `arch-fr-N`, `sizing-cap-N`, `sizing-num-N`,
  `sizing-verdict-N`, `deepdives-h-*`, `requirements-h4-2`, `requirements-h-additional`;
- hand-written containers (D-46): `entities-group-N`, `entities-entity-N`,
  `interface-group-N`, `interface-group-1b`, `interface-endpoint-N`,
  `requirements-outofscope`, `description-ul-N`, `entities-ul-N`, `levels-ul-N`,
  `requirements-ol-2`, `requirements-ol-additional`, `architecture-table-N`,
  `deepdives-metrics-table`;
- hand-written items and paragraphs: `requirements-nfr-<slug>-2` (4, youtube),
  `requirements-oos-N` (4), `requirements-scope-1`.

The procedure that makes this exact without a list: write the markdown with an explicit id on
every keyed element and every container of D-46, then `parseKb` + `deriveElements` it, and for
each today-id that did not come back on its element add `{#id}` to that element and repeat
(an explicit id removes the element from its sequence, so re-check after each addition). A
today-id that still does not come back is reported, never forced.

**D-62 · Extra ids** are allowed: elements with no id today may be issued one
(`requirements-p-N`, `choosing-row-N`, `relationships-p-N`, the entity and endpoint items'
`-li-N`, a v1 out-of-scope item's `requirements-li-N`).

---

## 8. Generated marked blocks

Three regions of a page are rendered from data files by pure functions — `renderRelations`
in `tools/src/lib/render-relations.ts` and `renderTour` / `renderFluency` in
`tools/src/lib/render-tours.ts` (the shapes below are fixed). Until the cutover the converter
calls them and owns the whole page (D-13); the block stamps already name `gen-relations` and
`gen-tours`, the P3c generators that will splice the blocks from the data files and answer
`--check` once the pages are the source (X-22).
Each sits between `<!-- <name>:start -->` and `<!-- <name>:end -->` under its block's `##` and
fact line, and is spliced by `splice` in `tools/src/lib/generated.ts`, which writes the start
marker, a blank line, the block's lines, a blank line, the end marker. The block's first line
is `blockStamp(<generator>, <source>, 'block')`, then a blank line, then the content.

**D-80 · relationships** — `gen-relations` from `docs/data/relations.json`:

```markdown
## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Retry with Backoff](./retry-backoff.md) — Retry transient errors; trip the breaker on sustained ones
- [Bulkhead](./bulkhead.md) — Isolate the pool, then stop calling it when it's failing.

**Requires**

- [Timeout / Deadline](./timeout-deadline.md) — You can't trip on slowness without bounding how long a call may take.

<!-- relationships:end -->
```

- A group is a bold label paragraph, then a `-` list. The label is the side's `group_*` when
  the record carries one (13 custom headings, persona pair), else the verb's display label
  from `RELATION_TYPES` (`prerequisite` → `Requires`, `prevents-hazard` → `Prevents`).
- An item is `- [<target title>](<relative .md>)`, then ` — <note>` when this side's note is
  non-empty. The note is markdown inline text (D-30). Link text is the target's frontmatter
  `title` (today one item differs: `Timeout & Deadline`), and every item links (5 today are
  unlinked `span`s).
- Group order, item order and whether a `maps_*` value shows are the generator's to decide
  deterministically; the round-trip compares the edges as sets (plan RT-1), and separately
  holds the order a reader sees (`relationships-block.order`), because the generator keeps
  today's order: groups in `REL_ORDER` order with custom labels after them, unless
  the file's top-level `group_order` (`{ <slug>: [<labels in display order>] }`, written only
  for a page whose order is not that default — the persona pair today) pins them; rows in record
  order.
- A record is written with the verb its pair lists first in `RELATION_TYPES`; a symmetric
  verb's `a` is the page first in site-path order. Records are in a topological order of
  "row X comes right before row Y in one group on one page", ties broken by where the edge is
  first met (pages in site-path order, rows in page order), so every page keeps its authored
  row order unless two pages contradict each other (none do today).

**D-81 · fluency** — `gen-tours` from `docs/data/learning-paths.json`, on a pattern page:

```markdown
<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Resilience](../../../themes/resilience.md) — Stop hammering a failing dependency so the system degrades gracefully. {#fluency-resilience}
- [Handling Spikes](../../../themes/spike-handling.md) — Fail fast when a downstream is saturated, instead of queueing forever. {#fluency-spike-handling}

<!-- fluency:end -->
```

One item per theme touring the page: the theme's title, its relative link, ` — ` and the
fluency sentence (omitted with its dash when empty), and the id `fluency-<theme slug>`. Items follow the order of the page's `notes` entry, which is the order the
page lists its themes today (hand-kept, on 36 of the 69 pages with two or more it is not the
hub's profile order); a touring theme the entry does not name comes last, in profile order.
The round-trip compares membership as a set and the order separately
(`fluency-block.order`).

**D-82 · tour** — `gen-tours` from `docs/data/learning-paths.json`, on a theme page:

```markdown
<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Quorum & Consensus](../patterns/distributed/coordination/quorum-consensus.md) {#tour-quorum-consensus}

The dial itself. Requiring a majority to agree before a write counts is how a CP store …

### [Replication](../patterns/distributed/coordination/replication.md) {#tour-replication}

The copies whose agreement CAP is about. …

<!-- tour:end -->
```

One step per stage of the theme's profile, in order: `### [<heading>](<relative .md>)` with
`{#tour-<member slug>}`, then the tour paragraph. The heading is
the note's `heading` when it has one, else the member's title: 7 steps today word it
otherwise ("Transactional Outbox" for `outbox`, "Content Delivery Network" for `cdn`), and
the theme's wording is authored prose, so it is kept (X-15). One step is unlinked today; the
generator links it.

**D-83 · The data these blocks need.** Beyond the shapes the task gives:

- `learning-paths.json` `notes[<route>][<theme slug>]` holds `role` (plain text,
  `data-kb-role`), `tour` and `fluency` (markdown inline), `heading` (plain text, the step
  heading, present only when it is not the member's title — 7 today, X-15). `<route>` is
  the pattern page's route (D-02).
- Order: profiles follow the hub (`THEME_GROUPS` ids, then `DESIGN_GROUPS` ids); `notes` keys
  are routes in sorted order, and a route's themes are in the order that page lists them —
  the key order is data, since it is the order the fluency block renders (D-81, X-17).
- `relations.json` notes (`note_a`, `note_b`) are markdown inline text, `""` when the side
  has none.

---

## 9. What is dropped, and what cannot come back

**D-70 · Chrome, never written.** `head` (title, meta description, the asset pair, JSON-LD —
all generated), `nav.crumb`, `header.doc-head` except the H1 and intro (kicker, badges,
`.doc-metarow`, `label.practice`), `nav.docnav`, `aside.mentions` (built from other pages'
prose links), every `<!-- kb:generated -->` region, `data-kb-polarity` (computed from the
column), `data-kb-order` (the structure file), classes.

Not all of that is generated. The kicker, the badges and the prev/next links are hand-kept:
`scripts/lib/template.mjs` seeds them for a new page and no build rewrites them. Where they
say only what the template writes for the kind, or a pattern's band and group names (which
the area chain keeps), they are chrome. Anything else was written by hand, and the round-trip
reports each one (`header.kicker`, `header.badge[N]`, `docnav.prev|next`) so
`known-losses.json` names the loss with its count: the `Theme · …` kickers on 25 themes, ten themes' muted subtitle badges, four stale pattern
kickers, and the authored prev/next trails. After cutover prev/next follow the structure
file's reading order (areas in file order, rows in order) — the spec's sidebar order — which
has no place for a second sequence; the frontmatter keys are fixed (D-10), so nothing in the
dialect carries the header text. One kicker came back as a tag: the six hazards whose kicker
says `Anti-pattern` carry the `anti-pattern` topic since the P3b facet split, and the
round-trip holds the kicker and the tag together, both ways (`KICKER_TAGS`, X-21).

**D-71 · Rewritten by a generator, compared as data.** Relationship rows, tour steps and
fluency items: their text in markdown is the generator's (link text = title, D-80 and D-81;
a tour heading is the note's own wording when it has one, D-82); their facts live in
`relations.json` and `learning-paths.json`.

**D-72 · Ids that do not come back in the markdown** — the round-trip reports each one it
meets in a section like any missing id, and `known-losses.json` names these classes with their
exact counts (D-74), so nothing is excused inside the comparison. The two ids of the generated
mentions aside sit outside every section, with the rest of the chrome (D-70):

| Ids | Count | Why |
| --- | --- | --- |
| `h-*` on block `h2`s (`h-desc`, `h-trade`, …) | 3,443 | `aria-labelledby` wiring; the section anchor is the block id |
| `mentioned-by`, `h-mentions` | 183 each | the generated aside |
| `deepdives-prose-N`, `architecture-prose-2`, `-3`, `interface-prose-1` | 17 | a `div.prose` wrapper has no markdown element and its first child has its own id (D-46) |

**D-73 · Reported, never guessed.** Anything the converter meets that this file does not
describe is written to the report (`tmp/convert-report.json`) with its page and today's id,
and the element is converted as generic prose where it can be, or skipped where it cannot.

**D-74 · Decided losses.** What the round-trip still finds after all of the above is listed,
with its exact count and reason, in the retired round trip's ledger (`known-losses.json`, in git history) — never normalised
away inside the comparison. Today twelve: the 137 hand-drawn neighbour diagrams and the two
non-edge neighbours two of them draw (D-58); the 3,443 block-heading aria ids and the 17
`div.prose` wrapper ids (D-72); the stale link text "Timeout &
Deadline" on `deadlock`'s row to `timeout-deadline` (a row's link text is its target's name,
which `kb.mjs link` writes); the `distributed` band's reading order, whose `data-kb-order`
interleaves its five group areas while the structure file can only order rows inside an area
(X-19); and the hand-written header and prev/next text D-70 drops (25 theme kickers, ten theme badges, four stale pattern kickers, and 70 authored prev/next
links across themes, hazards and patterns). Counts are exact, so re-running on a newer `main`
(a page added, a defect fixed) means re-deciding the entries whose counts moved. Two entries
move with the corpus by nature and are written so a page add leaves them met: the aria ids
count `per` block heading (a tally the round-trip takes of today's pages), and the band order
pins the shape of the difference — interleaved today, grouped by area in the file — rather
than today's exact runs.

A key names where a difference is, not what it is. Where one key can carry more than one
difference — a page's whole row order, a band's whole reading order, one row's link text —
the entry also pins the exact finding messages it accepts (`messages`), and the round-trip
writes those findings whole, never clipped (a band's order as its runs of areas, where it is
not the grouping above), so a second, undecided difference under the same key is reported
rather than excused. When the only finding under an entry's match carries another message,
the round-trip says so and quotes it whole: re-pin it if it is the same loss reworded.

---

## 10. The round-trip reads this dialect so

- Frontmatter through the one parser, a whole tree per spawn:
  `frontmatterMany(root, files, { lists: true })` from `tools/src/lib/frontmatter.ts`
  (`scripts/fm-json.sh --lists --many`). Lists arrive split; nothing re-splits them.
- A page body through `parseKb(markdown)` from `tools/src/lib/kb-attrs.ts` — remark-parse,
  remark-gfm and the KB data layer in one call, returning the tree and its problems.
- `deriveElements(tree)` lists every element in document order with `id`, `kind`
  (`heading`, `paragraph`, `item`, `list`, `table`, `row`, `figure`, `sketch`), `block`,
  `polarity` / `requirement` (top-level items of a group), own `text`,
  for fences `lang`, `code` and `wide`, and `generated` — the marked block's name — on an
  element inside one. A list item's text is its first paragraph; a figure's is its caption; a
  sketch's its summary. Text collapses HTML whitespace only (D-06): a U+00A0 is a character.
- Words compare per block after these known rewrites: the `**Example.**` label (D-50),
  ` — ` between a `dt`/`strong` lead and its body (D-52, D-53, D-46), subline joins (D-31),
  and the three generated blocks, which compare as data (D-71).
- Marks compare per block, in order, beside the words (X-18): every `strong`, code span,
  link, `<sup>` and hard break with its text. The bold leads this dialect writes are marks on
  the HTML side too — a `dt` (D-52), an `h4` (D-45, D-46), the `**Example.**` label
  (D-50), a prose sketch's summary (D-43) — and a caption or summary contributes only its code
  spans (D-41, D-42). Any other inline element today (`em`, `kbd`, `abbr`, …) and any other
  inline node in the markdown (emphasis, strikethrough, raw html) is a mark the other side
  lacks, so it is reported. The notes of generated rows compare the same way, with each
  link's target resolved: today's row against the data file, the data file against the block.
- Shape compares per block, in order (X-18): headings with depth and text, ordered lists with
  their length and any start other than 1, tables with their width and body rows, and
  blockquotes (D-43). An `h4` and the example label are bold leads, not headings; unordered lists
  are left out, because this dialect writes one from a `ul`, a `dl` and a row of containers.
- Units compare per block, in order (X-18): every paragraph, heading, list (its item count),
  list item, quote, fence, table (its body rows) and row, each with its container path and its
  word count — `list>item>quote>p:12`. The HTML side is read in the dialect's terms: a `dt`
  and its `dd`, a wild item, a sibling row, an entity or endpoint and a `div.nfr` are items; a
  plain `ul` before `div.nfr` entries starts their list; an `h4` elsewhere is a
  paragraph; a prose sketch is a quote. A split, merged, re-nested or re-parented element
  changes a count or a path even where every word and every id's opening words survive.
- Ids compare both ways: every id today's page has must come back on its element (a list or a
  table id on the whole container's words), and every id the markdown has that today's page
  does not is reported — an explicit `{#id}` always, an issued one unless it is a paragraph,
  list-item or row number D-62 allows.
- The three marked blocks must be byte for byte what `render-relations` / `render-tours`
  render from the data files (the P3c generators' own `--check` comes later). That holds the data's
  order — record order inside a group, `group_order`, a route's `notes` order — to the block,
  whose order the rest of the proof holds to today's page, and leaves nothing inside a block
  the generator does not write.
- Frontmatter: besides the fields graph.json carries, `owner` and `status` are the constants
  D-10 fixes, `source` names the page's own site
  path (D-13), and no key outside D-10 appears. The first body line is D-13's stamp for the
  same page.
- The base is the working tree by default (the roundtrip gate's run: until the cutover docs/
  is build output of the same tree), or one commit with `--base <rev>`.
- The data files: `profiles` follow `THEME_GROUPS` then `DESIGN_GROUPS`, each with its theme's
  title; every area's label, `hub.description`, `hub.intro`, parent and row labels, and the order of areas
  under each parent, against today's model and hub; `tags.json`'s terms against `TAGS` and
  `TAG_DESC`, each in the `skill` facet. `hub.tags`, a term's `applies` and `owner`, and
  `content-model.json` are new data with no source today; `extract-model --check` holds them.
- Code compares byte for byte: a sketch's `code` text as it stands, a diagram's source after
  exactly the two trims D-41 names, with click targets as routes.
- The structure file's order compares per area (today's hub order) and per pattern band
  (today's `data-kb-order` across the band's areas, read as the areas in file order, each
  area's rows in order).

---

## Decisions this file takes (not given by the task)

- **X-01** `requirement=fr|nfr` is a third section-fact key; FR/NFR numbering needs a carrier
  and a class cannot be one.
- **X-02** A suffix `{` must follow whitespace, so `/persons/{id}` is text without escaping;
  `\{` is still the escape for a literal group after a space.
- **X-03** Kind is the top folder under `docs/`, area the hub placement; the three ML case
  studies are the only pages where the two differ.
- **X-04** An explicit `{#id}` takes no positional number.
- **X-05** Retired with the reading levels: a note carries no level key.
- **X-06** Prose after a sided block's last column stays a paragraph inside the last group's
  section; only list items are group members. Its placement is position only: a plain
  markdown reader shows the 17 smell notes under the last `###` ("Avoid when"), where today's
  page shows them full-width after both columns. The site renderer (P5) places a trailing
  non-item paragraph of `usage` after the columns, and RT-2 holds that.
- **X-07** An `h4` is a run-in title (bold paragraph) or a list item's bold lead; no H3
  promotion, which would renumber `deepdives-dive-N`.
- **X-08** A prose `details.sketch` is a blockquote whose first paragraph is its bold summary.
- **X-09** Routes are `/` + the site path including `.html` (D-02).
- **X-10** `aliases` is written whenever the attribute is present, `[]` included; `tags: []`
  on a page with no tags, which the frontmatter gate reports as a missing key (the two
  untagged theme pages have been tagged at their source).
- **X-11** `h2` aria ids, `div.prose` wrapper ids and the hand-drawn neighbour figure's id
  are dropped (D-72).
- **X-12** Page-kind subgroup areas are prefixed with their kind (`principles-craft`,
  `themes-operating`, `designs-advanced`); pattern areas keep today's band and group ids.
- **X-13** Frontmatter lists are split by the shell parser (`fm-json.sh --lists`), never in
  TypeScript, so a quoted `solves` sentence may hold commas and colons.
- **X-14** A would-be GFM autolink in text is split with `<!-- -->` (D-07), rather than
  disabling autolink literals in the parser: the site build (P5) runs stock remark-gfm, which
  has no switch for that one extension, and the page must read the same everywhere.
- **X-15** A tour step's authored heading travels as the note's optional `heading` (D-82,
  D-83); relationship and fluency link text stays the target's title, because `kb.mjs link`
  builds it from the target's name and every row but one agrees (D-74).
- **X-16** U+00A0 is text, not whitespace, in `plainText` and in the round-trip's words, so a
  non-breaking space the markdown lost is a changed word, not an invisible one.
- **X-17** A page's fluency order travels as the key order of its `notes[<route>]` object
  (JSON keeps it), not as a new field: it is exactly the order the block renders, and a
  separate list would be a second place to keep it.
- **X-18** The round-trip reads four channels per block, not one: words (what a reader sees
  to a reader), marks (the inline markup), shape (headings, ordered lists, tables, quotes)
  and units (every element's boundaries, container and word count). Words alone would pass a
  page that kept every word and dropped its bold, its code spans, a link inside a tour note,
  the numbering of a list, or split an item in two.
- **X-19** A pattern band's reading order is its areas in the structure file's order, each
  area's rows in order. Where today's `data-kb-order` crosses a band's group areas (only
  `distributed`, split five ways without renumbering), the cross-area sequence is a decided
  loss (D-74); the order inside each area is kept.
- **X-20** A data file keeps its `updated` date while nothing else in it changes (D-05), so
  its `--check` is about content, never about which day the last commit landed.
- **X-21** The hand-written page header and prev/next text D-70 drops is reported and ledgered
  rather than carried: the frontmatter keys are the owner's (D-10), and after cutover prev/next
  follow the structure file. The `Anti-pattern` classification came back as a closed tag in
  the P3b facet split: the `anti-pattern` topic on exactly the six hazards whose kicker says
  so, which the round-trip holds both ways until the header goes.
- **X-22** Until the cutover the converter is the one writer of every page, marked blocks
  included, and `relations.json` / `learning-paths.json` are its output too. So the block
  renderers are libraries (`tools/src/lib/render-*.ts`), not programs: a `gen-relations` or
  `gen-tours` CLI now would either re-check what `convert-fresh` already holds byte for byte,
  or be a second writer of pages the converter owns. Their CLIs, `--check` and registry rows
  arrive with P3c, when the data files become the sources.
