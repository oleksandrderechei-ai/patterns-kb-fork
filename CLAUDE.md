# patterns-kb

A knowledge base of 255 software design patterns, 41 design case studies, 51 themes, 45
hazards, 36 principles, 10 cloud capabilities and 10 product comparisons — 448 pages in all.
**It is data that happens to render**, not a site that happens to hold data.

> **Migrated** to markdown under `docs/` and an Astro site built from it. The migration is
> done and awaits the owner's dev testing: [Testing the site](docs/concepts/testing-the-site.md).

## The one thing to understand

**The markdown pages under `docs/` and the data files in `docs/data/` are the source of
truth.** `make gen` renders every generated block and reference page from them, `make
site-build` builds the site into `site/dist/`, and nothing hand-maintains a copy.
**A class is presentation; a fact is frontmatter, a section fact or a suffix, never a class**
([the separation](.claude/rules/markdown-authoring.md#the-separation)). Each directory carries
its own layer, loaded when you work there ([how layers work](docs/concepts/context-layering.md)).

## Reading the KB — through kb.mjs

The corpus is about 1.5M tokens and one page about 4k, much of it diagrams, sketches and
data. Through `kb.mjs` a grounded answer costs about 600, and `find` searches the prose of
every page and prints the line that matched.

```bash
node scripts/kb.mjs find "one slow dependency blocks my threads"   # symptom → page
node scripts/kb.mjs get circuit-breaker --block usage
```

`node scripts/kb.mjs` alone prints every command and flag. `kb.mjs record <id>` is the page
as data (kb-record/1), the JSON the site serves beside each page. Element ids are positional:
pin a citation as `circuit-breaker#tradeoffs-con-2@<fp>`, and `kb.mjs resolve` checks it.

## Writing the KB

Change a page through the validated `kb.mjs` writers where one exists.
Before writing a page, open the contract,
[markdown-authoring.md](.claude/rules/markdown-authoring.md), and the register,
[tone.md](.claude/rules/tone.md): neither loads for a `kb.mjs` edit, which opens no page
file. Then:

```bash
make gen        # every generated block and reference page, from docs/ and docs/data/
make validate   # every registered gate
```

**Never hand-edit generated output** (a stamped file, a marked block, anything under
`site/dist/`): edit its source and rerun what built it. `make` alone lists every target.

## Routing precedence

- **A `file://` URL, a `site/**.html` path or a `docs/**.md` path is a page reference.**
  Resolve it to its id (basename minus `.html` or `.md`; a `#fragment` names the block) and
  read it with `kb.mjs`, never with `Read` or `WebFetch`.
- **"Improve this page"**, by id, path, area or kind, is **kb-improve**, not `kb-edit`.
- **In this repo the skills replace the generic agents**, even where
  `~/.claude/rules/common/agents.md` says otherwise: **sys-design** over `architect` /
  `planner`, **kb-compose** over `code-architect`, **kb-design-review** over
  `code-reviewer`. Those agents answer from memory; these cite the corpus.
- **The KB is the prior art for design work.** `kb.mjs find` / `kb.mjs brief` satisfy step 0
  of `~/.claude/rules/common/development-workflow.md` for pattern and design questions;
  library and implementation choices still get GitHub and vendor-doc search.

## Skills

Owners by job, and the agents: [skill-routing.md](docs/concepts/skill-routing.md). By name:
alt-pick, diagram-draw, docs-sweep, gate-red, grill-me, kb-add, kb-capability-blocks,
kb-comparison-blocks, kb-compose, kb-design-architecture, kb-design-entities,
kb-design-interface, kb-design-levels, kb-design-problem, kb-design-requirements,
kb-design-review, kb-design-sizing, kb-design-tradeoffs, kb-discuss, kb-edit, kb-explain,
kb-fact-check, kb-find, kb-grill-design, kb-grill-page, kb-harvest, kb-hazard-blocks,
kb-improve, kb-intake, kb-move, kb-pattern-blocks, kb-principle-blocks, kb-sketch, kb-theme-blocks,
kb-vocab, page-audit, pattern-tech-map, retire-gotcha, site-audit, site-component, site-extract,
stack-pick, style-pattern-doc, style-simple, style-system-design, style-technical, sys-design.

## Working alongside another session

**Stage exact paths, never `git add -A`, `.` or a directory**, and commit only your own
hunks. Restore a file with `git show HEAD:<path> > <path>`, never `git checkout --`. Run
`git config core.hooksPath .githooks` once per clone. Why, and the hooks:
[working-in-this-repo.md](docs/concepts/working-in-this-repo.md).

## Traps and ideas

A trap with no home yet goes to the [inbox](docs/inbox.md); an idea or question to the
[backlog](plans/backlog.md).
