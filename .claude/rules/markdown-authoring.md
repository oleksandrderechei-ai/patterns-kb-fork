---
description: "The data contract for a KB page under docs/: where each fact sits, the field, block and relationship rules with the page-rule ids that decide them, the generated regions and how to add a page. Read it before writing or editing a page, through kb.mjs or by hand."
paths: ["docs/**/*.md"]
---

# Markdown authoring rules

**Question:** where does each fact of a page sit, and which rule decides it?

> The data contract for a page of the Software Design Atlas. [page-rules.md](../../docs/reference/page-rules.md)
> numbers every rule a gate decides — `PAGE-0nn` for any page, `KB-0nn` for a KB page — and
> names the gate; this file cites those ids rather than restating them, and adds the judgement
> no gate can make. The prose register is [tone.md](./tone.md).

> **The pages under `docs/` are the source.** Change one through a `kb.mjs` writer where one
> exists and by hand everywhere else, never inside a
> [generated region](#generated-regions--do-not-edit), then run `make gen && make validate`.

## The separation

A page says what it means in data, never through formatting or position. In a `docs/` page the
data sits in three places, and everything else — the wording of a heading, bold, lists,
tables — is presentation:

| Where | Carries | Rules |
|---|---|---|
| frontmatter | identity and search: `title`, `description`, `area`, `tags`, `aliases`, `solves`, `favourite` | [frontmatter gate](../../docs/reference/triage.md#page-frontmatter), [KB-001](../../docs/reference/page-rules.md#KB-001), [KB-013](../../docs/reference/page-rules.md#KB-013) |
| a section fact, `<!--meta k=v-->` | which block a `##` is; which side a `###` group is | [KB-003](../../docs/reference/page-rules.md#KB-003), [KB-006](../../docs/reference/page-rules.md#KB-006), [KB-007](../../docs/reference/page-rules.md#KB-007), [KB-008](../../docs/reference/page-rules.md#KB-008) |
| a trailing `{…}` suffix, a fence's info string | an element's id; a figure's language and caption | [KB-004](../../docs/reference/page-rules.md#KB-004), [KB-009](../../docs/reference/page-rules.md#KB-009), [KB-010](../../docs/reference/page-rules.md#KB-010) |

Data is never read off a heading's wording or a list's position. A relation is real because a
record in [relations.json](../../docs/data/relations.json) says so, not because a link sits under
"Combines with". That separation is what lets the site be restyled without damaging knowledge,
and re-authored without damaging structure.

## Field rules

**`description`**, the essence — the terse one-liner the hub chip and the index show, one plain
line ([PAGE-005](../../docs/reference/page-rules.md#PAGE-005)). It is **not** the intro
paragraph under the H1 ([PAGE-001](../../docs/reference/page-rules.md#PAGE-001)), which is
longer and reads as a definition. Both exist; do not collapse them. Write it with
`kb.mjs set <id> --essence "…"`.

**`solves`** (patterns, principles, hazards and designs, 3-5;
[KB-013](../../docs/reference/page-rules.md#KB-013)) — the single highest-value field, and the
easy one to get wrong. It is **not** a restatement of the `usage` block's "Reach for it when",
which is prescriptive and already exists. It is **symptomatic**: the words someone types when
they have the problem and do not yet know this page exists.

- ✅ `"my thread pool is exhausted and every request hangs"`
- ✅ `"adding a new export format means editing a giant switch statement"`
- ❌ `"You call a remote service that can fail"` — prescriptive, useless for search
- ❌ `"circuit breaker pattern"` — if they knew the name they would have searched it

Avoid the page's own name and its jargon inside `solves`. Use the vocabulary of the symptom,
not of the solution.

Each phrase is **one problem, problem first, in at most 20 words** — the gate counts them. It
has to read right to a small model with no page in front of it, and the search box prints it
as the result's snippet. So:

- **One problem per phrase.** Two problems joined by "and" are two phrases, or one dropped.
- **Say what goes wrong and where**, in short common words: a subject, what it does, what
  breaks. No pronoun without its noun, no half-finished clause, no aside between dashes.
- **Specific to this page.** A phrase that fits ten other pages finds none of them.
  - ❌ `"one instance cannot take the traffic anymore"`
  - ✅ `"one server cannot take all the traffic and I need to spread requests across several"`
- **A problem, not a product choice.** ❌ `"should we use Kafka or SQS"` — the product names
  are `aliases`; the phrase is what the reader cannot do yet.
- **No house-banned word** ([glossary](../../docs/reference/glossary.md)); the vocabulary gate
  leaves `solves` alone, so this one is yours to hold.

On a **hazard** the field reads the same way but points the other direction: the phrases are
what the sufferer **observes**, and the page they reach names it rather than fixing it — the fix
is a `mitigated-by` hop away. A hazard is the one kind whose `solves` and essence are close in
kind, so keep them distinct: the essence is the terse definition the hub chip renders, the
`solves` are the messy sentences nobody would put in a definition ("we restart the service
every night to keep it healthy"). **Themes carry no `solves`** — a theme is a tour, not a
problem, and its essence carries the search weight instead (`kb.mjs find` scores the essence
at the `solves` weight on any page that has none).

**`tags`** (2-5) — a **closed vocabulary**, [tags.json](../../docs/data/tags.json): exactly one
topic, written first, then skills, then languages, as
[how a page is tagged](../../docs/reference/tags.md#how-a-page-is-tagged) says; the
[tags gate](../../docs/reference/triage.md#tags) rejects anything else. Tags exist to group and
filter, and a tag on one page groups nothing, so a new term comes only with the pages that earn
it ([adding a term](../../docs/reference/tags.md#adding-a-term)). The first sweep of this KB,
written by 18 agents with no shared list, produced 280 tags of which 154 were used exactly once;
hence the closed list. Retiring a term means retagging every page that carries it, so it is its
own change: the **kb-vocab** skill.

**`aliases`** — only genuinely used alternate names ("CB", "pub/sub", "Policy", "The Blob").
`[]` is a perfectly good answer; many patterns have none. Do not invent nicknames.

**`favourite`** (optional) — `true` marks a page as an editorial pick; otherwise the key is
absent ([KB-013](../../docs/reference/page-rules.md#KB-013)). Write it with
`kb.mjs set <id> --favourite true|false`. The hub renders a `★` chip and a **★ Favourites**
filter from it. Favourite a page because it is worth reading first, not because it is good.
What you author is the **default**: a visitor can toggle any page, and their choice, kept in
their own browser, wins over yours only for them. It is a separate question from the
"Practiced" tracker: **worth reading first** versus **I have worked through this**.

**"In the wild"** (optional block) — real, well-known implementations only. This is the one
place you can do real damage: a fabricated library name is a lie that ships to a public site.
Include an entry only if you are confident it exists **and** genuinely exemplifies the pattern.
**If in doubt, leave it out** — plenty of patterns have no such block and that is fine. Avoid
vague claims ("most web frameworks"), and never attribute a feature to a product unless you are
sure that product has it. Feature-specific claims are the ones that turn out wrong.

## Prose links

Link a page the first time its prose names another page — "that is
`[Scatter-Gather](../messaging/scatter-gather.md)`" sends the reader where the corpus already
has the answer, and an unlinked name makes them search for it. Once per page is enough; a
second link to the same target is noise. In a `docs/` page the target is the other page's
`.md` file, as a relative path.

**Three blocks cannot carry a link, and this is mechanical rather than editorial.** `production`
and `wild` are written by `kb.mjs` from text arguments it escapes on write, so a link lands as
visible text rather than a link, and one written in by hand is destroyed by the next
`kb.mjs production`/`wild` call on that page. They pass inline code through as the single
exception, because their items name parameters and API calls. `relationships` is generated from
the relation records and already carries typed links. The one exception is the `explain`
paragraph: `kb.mjs explain --text` turns `[label](path.md)` into a link, and the dump
(`kb.mjs get <id> --block explain --json`) hands the link back in the same form. Everywhere
else is hand-written prose, and that is where a prose link belongs.

## Prose markup — the inline vocabulary

Three inline forms, and no others: a link, **bold** for a run-in label, and `code` for an
identifier. Italic is not in the vocabulary
([TONE-009](./tone.md#TONE-009)): emphasis that survives is bold, and emphasis that does not
survive was doing the work a better sentence should do. When you reach for italic contrast, move
the stressed word to where the sentence already stresses it, or split the sentence in two.

A title's qualifier — a routing tag (`→ NFR: scale`), the store a group of entities lives in,
the scope clause of a requirements tier — is part of the title's text, not a separate element:

```markdown
### 4 · Draining a backlog you did not choose → NFR: scale
```

## Blocks

Fixed vocabulary, fixed order, per kind:
[content-model.json](../../docs/data/content-model.json) lists each kind's blocks in order and
the ones that may be absent, and [KB-003](../../docs/reference/page-rules.md#KB-003) holds a page
to it. The [glossary](../../docs/reference/glossary.md#blocks) says what each block is for.
Every kind extends ONE base skeleton: it opens `description` → `explain` and closes
`relationships`; only the middle is kind-specific. A block's visible heading stays
kind-flavoured ("The question", "Understanding the problem"), but its fact is the same on every
kind, so `kb.mjs get <any-id> --block description` works everywhere. Same question, same place,
on every page — that is what makes block-level extraction possible.

**The `description` block is one paragraph of at most 80 words**, on every kind
([KB-015](../../docs/reference/page-rules.md#KB-015)). It is the prose read first, so it says
what the page is for and nothing else: the problem or idea, and who meets it. Background, history
and the long form belong in the blocks below it, not in a second paragraph. The gate fails a
description of more than 80 words, or of more than one paragraph, with the length it found.
Pages that have not been cut down yet are listed in
[kb-shape.json](../../docs/data/allow/kb-shape.json) under `description`, each held to the
length it had when listed; a new page is never listed.

A **design** is a worked case study (a system-design or low-level-design kata): its
`description` ("Understanding the problem") frames it, `requirements` states FR + NFR, `sizing`
("Right-sizing") argues from those requirements to the cheapest set of technology capabilities
the numbers allow, `architecture` carries the primary mermaid diagram, `deepdives` argues the
hard sub-problems, and the typed `relationships` block joins it to the patterns it uses via
`demonstrates`. A design carries `solves` like a pattern and tags an OOP kata
`low-level-design`. A distributed kata carries no kind tag at all: `system-design` was one until
it reached 31 of the 40 case studies and spent a slot at the five-tag ceiling to say what the
section already said, so the hub badges a case study **System design** whenever it claims
neither `low-level-design` nor `machine-learning`.

A **principle** is a design maxim (SOLID, DRY, KISS, YAGNI, …), not a mechanism: its
`description` ("What it says") states it, `rationale` why it helps, `applying` how to honour it,
an optional `sketch` — the smallest code that shows the maxim kept and broken, a captioned
fence like a pattern's — and `overreach` — a mandatory, honest block — how it fails when
taken too far. Principles carry
`solves` and link into the typed graph (usually `combines-with` a pattern that embodies them, or
`prevents-hazard` an anti-pattern they guard against). Hazards carry a real `relationships`
block like every other kind, so `kb.mjs link` writes both sides of a
`prevents-hazard`/`mitigated-by` edge — the `mitigation` block keeps its prose narrative and any
figure, but no typed edges.

A **capability** is one category of managed cloud service — storage, messaging, identity —
taking the **capability** as its subject and the vendors' products as evidence. Its
`capabilities` block is the provider-neutral taxonomy, one bold-led item per shape and no
product names inside it at all; `mapping` is the cross-cloud table, with columns Capability /
AWS / Azure / Google Cloud; `choosing` argues the decision; `portability` lists what breaks when
you move, each item a bold label then the difference and what it costs. Capabilities carry
`solves` like a pattern and always carry the `cloud` tag. The `mapping` table carries 12 to 16
rows, each a capability, never a product.

Two rules bite harder on a capability than anywhere else in the KB. The **anti-fabrication**
rule governs every cell of the mapping table: a service name you are sure of, or "no
first-party equivalent", or no row — an invented product feature is a lie that ships to a public
site. And **naming decay** is the standing cost of these pages, so prefer the stable
capability-level answer to the newest brand; the capability column is the durable part of the
table and the product columns are replaceable evidence. Capabilities join the graph through
`implements`, which gives each pattern an "Implemented by" list — distinct from "Demonstrated
by", which is a case study showing the pattern at work rather than a product you can buy. Where
the platform **requires** a discipline of you instead of providing it — elastic compute needs
your service to be stateless — the verb is `prerequisite`, not `implements`.

A **comparison** takes ONE product decision as its subject — the managed services and the
open-source contenders for a single capability area, side by side. Where a capability page
names provider-neutral **shapes** and keeps products out of its taxonomy, a comparison names
the **products**: `contenders` is one bold-led item per product, each carrying its shape, its
license and owner, and where to rent it; `matrix` is a table with the deciding conditions down
the side and the contenders across the top; `choosing` argues the per-condition verdicts, opening with the null option or
the cloud default. Comparisons carry `solves` like a pattern and take the product names as
`aliases` (that is how "alternative to Kafka" resolves). They join the graph through
`specializes` (the capability page is the wider subject) and `implements` (these products ARE
the pattern, runnable or buyable). The **anti-fabrication** rule bites hardest of all here, and
decays fastest: the contender items and the matrix carry license, ownership, managed-offering
and scale claims about named products, and licenses change — Redis relicensed, RabbitMQ changed
owners, Redpanda's BSL converts on a clock. State only what you are sure of at time of writing;
when unsure, omit the claim rather than the contender. These pages are standing targets for the
**kb-fact-check** sweep.

**`variations`** (and a capability's `capabilities`, a comparison's `contenders`) — one item per
variation, a short bold name, then ` — ` and the explanation. The bold name is the card's
heading on the site: keep it short, and never leave a name without its explanation. **When a
variation names a page the KB already has, the name links it.** Link only the page-name portion
and leave the qualifier as plain text — the variation is usually that pattern applied here, not
the pattern itself: `- **[API Gateway](../routing/api-gateway.md) routing** — …`. Link the
page, not the word. "Streaming Gateway" is not the `streaming` theme and "Per-aggregate stream"
is not the `aggregate` pattern — a name collision is not a reference, and a wrong link costs the
reader more than a missing one.

**`structure`** (patterns) — opens with a **numbered topology walk**. For an
implementation pattern (distributed, messaging, caching, enterprise, architecture, concurrency,
security) that walk is a `flowchart`: component nodes and data-store nodes (`[( )]` cylinders),
the critical boundary drawn as a `subgraph` (for the outbox: "One atomic transaction" wrapping
the state table and the outbox table), numbered edge labels `1..N` tracing the happy path, ≤9
nodes. It answers one question — how does the happy path cross the components? The **sequence
diagram**, which carries timing and the failure branches, follows it. Conceptual bands (gof, functional, testing, ddd,
frontend, ml) keep their class-style diagram. Exemplar: `outbox`. Drawing rules
are the **diagram-draw** skill.

**`production`** (patterns only, optional) — the system-builder block: what it takes to **run**
the pattern, written through the validated writer:

```bash
node scripts/kb.mjs production <id> \
  --knobs '[{"label":"pool size","note":"…"}]' --signals '[…]' \
  --failures '[…]' --checklist '["…"]'
```

Four labelled lists — **Tuning knobs** (the configuration surfaces), **Signals to watch**
(observable quantities: queue depth, replication lag, p99 latency), **Failure modes under
load** (what breaks first and how it looks), **Readiness checklist** (gates before shipping).
Any list may be empty; its group is simply omitted. The writer replaces the whole block, so
re-supply every list on edit — get them with `kb.mjs get <id> --block production --json`,
whose `items` field returns the four lists in exactly the shape the writer takes. Do not
re-type them from the rendered prose: it carries no inline code,
and a hand-typed re-supply silently deletes it. The same `items` dump covers `wild`.
Anti-fabrication rule, same standard as "In the wild": every knob must be a real, verifiable
configuration surface — either a named parameter you are certain exists (`corePoolSize`,
`max_connections`) or a generic dial described without attributing it to a product. Signals
must be observable quantities, not aspirations. Never invent a metric name, default value, or
product feature. When unsure, omit — a three-item list of true things beats a five-item list
with one lie. Conceptual pages (GoF, functional) may skip the block entirely; a forced block is
how fabrication happens.

## Selfcheck

**`selfcheck`** (patterns, hazards and principles; optional) — "Check yourself": three
questions that test whether the reader took the page in, each answerable from the page and
cited to it ([KB-016](../../docs/reference/page-rules.md#KB-016)). It sits just before
`relationships`, after `fluency` on a pattern:

```
## Check yourself
<!--meta block=selfcheck-->

> **Why trip on an error rate over a window rather than on one failure?**
>
> One slow call is noise, and a single trip would flap the breaker; the cost is thresholds you
> must tune, see [con 1](circuit-breaker.md#tradeoffs-con-1).
```

Exactly three blockquotes and nothing else; each folds to a `<details>` on the site, its bold
question the summary. The question is at most 25 words and ends in `?`; the answer is one or
two sentences of at most 60 words with at least one link to `page.md#element-id` (find ids with
`kb.mjs get <id> --block tradeoffs`; the link gate resolves them). Ask what tests
understanding: a tradeoff, a when-not-to-use, a failure mode, never a definition the heading
already gives. Write it by hand; `kb.mjs get <id> --block selfcheck` reads it.

## Depth

Every page has ONE depth, for every reader: expert-grade, in plain words. There are no
reading levels, no lens toggle, no `--level` flag and no `{level=…}` mark; every block and
every element shows to everyone. A page is sized by what the reader needs to use the thing,
not by how much a beginner can take.

**`explain`** (every kind; a design may leave it out) — the one explanation and its one
example, in the fixed shape [KB-014](../../docs/reference/page-rules.md#KB-014) holds:

```
## Explained
<!--meta block=explain-->

<one paragraph, 60–180 words, no bold run-in label>

- **<cost, a bold lead>.** <what it costs, at most 25 words in all>
- **<cost>.** <…>

**Example.** <one paragraph, at most 120 words>
```

The paragraph names the mechanism plainly and says when to choose it over the nearest
alternative. A term the reader may not know is linked on its first use to its own page
(`[term](../path/to/term.md)`, a relative link to the page's `.md`) or glossed in a short
parenthesis; link only when the corpus has the page, and never link the page's own subject.
What the mechanism costs does not go in the paragraph: it goes in the **costs list** right
after it, 2 to 4 bullets, each opening with a bold lead and at most 25 words in all, one cost
per bullet and its counter-move when it has a short one. The costs list is required on a
pattern and optional on every other kind that has an explain block. The example is one concrete scenario with real numbers that shows the mechanism
and its cost at work; it may be one captioned non-mermaid sketch fence of at most 25 lines
instead, when code is the clearest proof, and it never repeats the page's `sketch` or
`structure` block. It is written through the validated writer, which replaces the whole block:

```bash
node scripts/kb.mjs explain <id> --text "…" --costs '[{"lead":"Latency.","note":"…"}]' --example "…"
node scripts/kb.mjs explain <id> --text "…" --example "<code>" --example-lang <lang> --example-caption "…"
```

Leave `--costs` out and the writer keeps the page's own list; `--costs '[]'` drops it. The full
spec — what "expert-grade in plain words" means, sizing per kind and the six-point
audit — is the **kb-explain** skill. The `explain` block is a different thing from a design's
`levels` block (the Mid/Senior/Staff interviewer rubric); both may exist on a design page. A
design may carry neither: a case study already argues in full through its interview, sizing,
deep dives and rubric, so an explanation that only compresses those blocks is dropped rather
than written. When to keep one is the **kb-explain** skill.

## Relationships

An edge joins two pages, and both render it: `kb.mjs link <from> <verb> <to>` writes the one
record in [relations.json](../../docs/data/relations.json) both pages render from, and the [relations gate](../../docs/reference/triage.md#relations-closed-and-paired)
fails a one-way, dangling or contradictory edge. The 19 verbs are closed and paired
(`variant-of` ↔ `has-variant`, `prevents-hazard` ↔ `mitigated-by`, `exposed-to` ↔
`threatens`, `demonstrates` ↔ `demonstrated-by`); [content-model.json](../../docs/data/content-model.json) lists them with
their inverses and the [glossary](../../docs/reference/glossary.md#verbs) says what each means.
`demonstrates` runs from a **design** page to a pattern or principle it puts to work, and adds
the "Demonstrated by" backlink on the pattern. `exposed-to` runs from a **pattern** or **design** to a hazard that threatens it, and adds the
"Threatens" backlink on the hazard; the relations gate rejects it between any other kinds. Use
it where the hazard acts on the page's own mechanism (a lease and clock skew), and
`prevents-hazard` where the page is the fix. `implements` runs from a **capability** or
**comparison** to a pattern the cloud or the product sells ready-made, and adds the
"Implemented by" backlink. When the platform requires the pattern of you rather than providing
it, use `prerequisite` instead.

Retiring an edge goes through `kb.mjs unlink <a> <b>`, which removes the record whatever verb
each side reads. Re-typing an edge is `unlink` then `link`, and moving it under another heading
on its page is `unlink` then `link --group`. `kb.mjs refs <id>` lists everything a
page points at, read live, so an edit that changed what the page uses can be reconciled before
the build. Each side may phrase its **note** its own way — "Screen at the gate, then hand out
scoped keys" reads correctly from `gatekeeper`, while `valet-key` may say something else. Only
the edge and its verb must agree.

**Theme membership is two-sided in the same way.** A theme's tour steps and each member
pattern's "Where it shows up" block are one fact, which
[learning-paths.json](../../docs/data/learning-paths.json) holds once and the
[learning-paths gate](../../docs/reference/triage.md#learning-paths-resolve) checks. No writer
maintains it: add the member's route to the theme profile's `stages` and its note under
`notes`, then run `make gen`, which renders both blocks. The
**wording** is free — a tour role is terse by design ("Keep the GPU busy") and the pattern's
line often extends it. Only presence must agree.

## Generated regions — do not edit

A region between `<!-- <name>:start -->` and `<!-- <name>:end -->`, whose first line is a
`GENERATED by` stamp, is rendered from a data file: the `relationships` block from
[relations.json](../../docs/data/relations.json), a theme's `tour` block and a pattern's
`fluency` block from [learning-paths.json](../../docs/data/learning-paths.json). `make gen`
overwrites anything written inside one, and `make validate` fails a stale one. To change what
a region says, change its data file — through `kb.mjs link` and `unlink` for an edge — and run
`make gen`. A page's element ids are written as `{#id}` suffixes only where the page needs one
the build does not issue ([KB-009](../../docs/reference/page-rules.md#KB-009)).

## Adding a page

1. Scaffold it:
   `node scripts/kb.mjs new <id> --kind <kind> --name "…" [--band <b>] [--group <area>] [--order <n>]`.
   It writes every block its kind requires, in order, and gives the page its row in
   [site-structure.json](../../docs/data/site-structure.json), which decides where the file
   sits ([KB-001](../../docs/reference/page-rules.md#KB-001)). `--order` is the page's place in
   its area, 1 first, the end when left out. A theme also gets its profile in
   `learning-paths.json`. Read an exemplar first: **`circuit-breaker`** (pattern),
   **`cap-theorem`** (theme), **`dry`** (principle) or **`storage`** (capability), with
   `node scripts/kb.mjs get circuit-breaker`.
2. Write each block, in the order [KB-003](../../docs/reference/page-rules.md#KB-003) holds.
3. `node scripts/kb.mjs set <id> --aliases … --tags … --solves …`
4. Declare each relationship with `kb.mjs link`.
5. The page is a draft until you set `status: stable` in its frontmatter.
6. `make gen && make validate`.

The page then appears in the hub, the search and its neighbours' backlinks
automatically — that is the point of building everything from the pages and the data files.
