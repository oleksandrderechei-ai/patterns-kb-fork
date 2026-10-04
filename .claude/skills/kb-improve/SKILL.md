---
name: kb-improve
description: "Improve a patterns-kb page (an id or a docs/**.md path), an area or a kind: six reader reviews, one merged edit plan, applied, gated, one pull request. Use when asked to improve, rewrite, polish, clarify, simplify or make a KB page easier to learn or apply. Not for findings only (kb-design-review) or one reported fault (kb-edit)."
---

# Improving a page for every reader it has

Gates prove a page's shape, `kb-design-review` finds its faults and `kb-edit` fixes the one
someone reported. Nothing walks a page as its readers do: the engineer who builds with it
tomorrow, the sceptic who doubts its numbers, the expert who knows what it left out, the
architect who places it among its neighbours, the model that cites one block of it on a
budget, and the editor who hears generated text in it. This skill does that and lands the
result. The bar is the KB's own: **expert-grade, in plain words, at one depth**, with enough
knobs, failure modes and sources for a reader to build or fix a real system with it.

**You are the orchestrator and the judge.** Every reader, the synthesizer and the writer run
as subagents pinned to Sonnet 5.5 (`model: claude-sonnet-5-5` in both agent files); you
never write a page yourself. Never pass a `model` when you launch them: the Agent tool's
`model` overrides the file's pin and takes only an alias, so `"sonnet"` there would undo it.

You start them, test every reply against [judging.md](references/judging.md), send back what
fails with the line that failed, restart an agent that cannot pass, and land only what you
would accept.

The owner asks in plain words, and every form below means this skill:

| They say | You run |
|---|---|
| `improve singleton`, or a `docs/**.md` path | one page |
| `improve singleton, builder and prototype` | those pages |
| `improve gof-creational`, or its sidebar name `Creational` | every page in the area |
| `improve Objects & Classes` (a sidebar section) | every area in the section, one after another |
| `improve all hazards` (a kind) | every page of the kind |
| `continue improving` | the next pages not yet done |

## 1. Resolve the work

A `file://` URL, a `docs/**.md` path, the HTML `make site-build` writes and a bare id are the
same thing: the id is the basename minus its extension, as
[kb-design-review](../kb-design-review/SKILL.md) resolves it. An area or a kind resolves to
its ids:

| asked for | the ids |
|---|---|
| an area | `jq -r '.areas[] \| select(.id=="<area>") \| .pages[].slug' docs/data/site-structure.json` |
| a sidebar name | the same, with `select(.label=="<name>")` |
| a sidebar section | its id by `.label` the same way (`Objects & Classes` is `gof`, `Network` is `distributed`), then its areas: those whose id starts with that id and a hyphen (`gof` holds `gof-creational`, `gof-structural`, `gof-behavioral`, `gof-extra`), each resolved as an area, in file order |
| a list | as given |
| a kind | `node scripts/kb.mjs ls --kind <kind>` |
| `continue` | the next area in `docs/data/site-structure.json` order with pages not yet done |

Drop the ids already done. Git is the progress record, so no tracker file can drift from it:
every finished page is a commit whose subject is `feat: <id> groomed by kb-improve`, or one
that names several ids when their edges shared `docs/data/relations.json`.

```bash
git log --oneline --grep "groomed by kb-improve"
```

Lint each remaining id. A page that is red before you start goes to `kb-edit` first:

```bash
node scripts/kb.mjs validate <id>
```

Work on one branch, `kb-improve/<id>` for a page or `kb-improve/<area>` for more. Do not
`kb.mjs get` a page into your own context: the readers read it in theirs, and yours holds
the judging.

## 2. Fan out the readers

For each page, launch [kb-persona-reviewer](../../agents/kb-persona-reviewer.md) six times
in parallel with the Agent tool, one call per section of
[personas.md](references/personas.md): practitioner, sceptic, senior-expert, architect,
agent-consumer, plain-language. Give each call a name (`<id>-<role>`) so you can steer it by
message, and carry the id, the kind, its brief pasted whole, and the skill that owns the
kind's blocks:

| kind | owning skill |
|---|---|
| pattern | kb-pattern-blocks |
| hazard | kb-hazard-blocks |
| theme | kb-theme-blocks |
| principle | kb-principle-blocks |
| design | kb-design-problem, -requirements, -sizing, -entities, -interface, -architecture, -tradeoffs, -levels |
| capability | kb-capability-blocks |
| comparison | kb-comparison-blocks |
| `explain` on any kind | kb-explain |
| a code sketch on any kind | kb-sketch |

Ask for the fixed reply, also sent to you by message: six returns that land together are
truncated past about 16,000 characters, a message is not. On an area, run the readers for up
to three pages at a time; more than that floods your context with replies. When subagents are
not permitted in the session, say so and stop: this skill exists to keep the pages out of
your context.

## 3. Judge the reviews

Test every reply against hand-off 1 of [judging.md](references/judging.md). Send a failing
one back by name with the checks it failed, on the retry ladder that file gives. Wait for all
six to pass before you go on: a plan built on five readers is missing a sixth of the page.

## 4. Get the plan, and judge it

Launch kb-persona-reviewer once more in the `synthesizer` role, with the
six accepted replies pasted verbatim and the cap on edits (8 unless the owner says
otherwise). Its brief, the last section of personas.md, dedupes, re-reads every anchored
block, settles the conflicts between readers in a fixed order and returns the edit plan:

```text
PAGE <id>  KIND <kind>  REVIEWS MERGED <n>
E1 | #<anchor> | <action> | <instruction naming the kb.mjs writer or "hand-edit prose"> | from <roles> | rule <skill and item>
DROPPED | #<anchor> | <reason>
NO-FABRICATION CHECK: <every added name or number and its source, or "nothing added">
```

Test it against hand-off 2. That means re-reading the anchored blocks yourself and redoing
the arithmetic behind every new number. When the owner asked to see plans first, show the
accepted plan and wait.

## 5. Apply, and judge the diff

Hand the accepted plan to [kb-author](../../agents/kb-author.md) for this
one id. Its rules: frontmatter, `wild`, `production`, `explain` and edges go through the
`kb.mjs` writers; other block prose is edited in the file under the owning skill; generated
blocks and hub pages are never touched; an existing list item is fixed in place or followed
by a new one, never moved, and copies its neighbours' lead form. On an area, hold back every
`link` and `unlink` and run them yourself after the writers finish, one at a time: two
writers that edit `relations.json` together lose an edge.

Test the result against hand-off 3, reading the diff yourself:

```bash
node scripts/kb.mjs validate <id>
node scripts/kb.mjs refs <id>
git diff -- <the page> docs/data/relations.json
```

After an essence or `solves` change, run `make gate G=check-search-oracle`: a theme that took
a pattern's symptom words once pushed `circuit-breaker` out of its oracle answer.

## 6. Gate and commit each page

```bash
make gen && make validate-changed
git add docs/<path-to-page>.md docs/data/relations.json
```

Stage only the paths this page changed. An edge also changes the far page's relationships
block, `docs/data/prerequisites.json` and `docs/reference/prerequisites.md`; stage those with
it. Commit the page alone, with the subject `feat: <id> groomed by kb-improve`, so the next
run knows it is done. Pages whose edges both changed `relations.json` share one commit that
names each id, since one file's hunks cannot be split without an interactive add.

## 7. Open one pull request

Run the whole `make validate`, then push the branch and open one pull request. Its body is
the report; a run never writes a file under `docs/` about itself. It has one row per page,
then every `DROPPED` line, so a reader can supply what the synthesizer would not invent:

```text
| page | accepted / parked | findings raised / kept | retries | diff lines |
```

A parked page's row names the check that kept failing. A follow-up a reader asked for that
is no groom, such as a new block, goes to [the backlog](../../../plans/backlog.md).

For an unattended run with nobody watching, the saved workflow
`.claude/workflows/kb-improve-batch.mjs` runs steps 2, 4 and 5 per page without the judging
in between. Use it only when the owner asks for a workflow by name.

## Done means

- Every reader, the synthesizer and the writer ran as a Sonnet 5.5 subagent, and every reply
  passed its hand-off in [judging.md](references/judging.md) or its page was parked.
- Every read went through `kb.mjs`; no tool call opened a page file except the writer editing
  block prose.
- Every applied edit traces to a finding with a stable anchor and a cited rule.
- No existing list item was moved, renumbered or deleted; new items were appended.
- Nothing was added to `wild`, `production`, `mapping` or `contenders` without a named
  source, and every dropped finding is listed with its reason.
- Each accepted page is its own commit, `make gen && make validate` exits 0, and one pull
  request carries the per-page table, the parked pages and the dropped lines.
