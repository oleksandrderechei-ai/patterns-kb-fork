---
name: kb-improve
description: "Improve one patterns-kb page: six persona reviewers, one merged edit plan, applied through the writers, gated, one pull request. Use when asked to improve, groom or tighten a page, an area or a kind. Not for findings only (kb-design-review) or one reported fault (kb-edit)."
---

# Improving a page for every reader it has

Gates prove a page's shape, `kb-design-review` finds its faults and `kb-edit` fixes the one
someone reported. Nothing walks a page as its readers do: the engineer who builds with it
tomorrow, the sceptic who doubts its numbers, the expert who knows what it left out, the
architect who places it among its neighbours, the model that cites one block of it on a
budget, and the editor who hears generated text in it. This skill does that for one page and
lands the result: six readers in parallel, one merged plan, one writer, the gates, one pull
request. The bar is the KB's own: **expert-grade, in plain words, at one depth** — every
sentence followable by a smart outsider, and enough knobs, failure modes and sources for a
reader to build or fix a real system with it.

## 1. Resolve the page, and read nothing yourself

A `file://` URL, a `docs/**.md` path, the HTML `make site-build` writes and a bare id are the
same thing: the id is the basename minus its extension, as
[kb-design-review](../kb-design-review/SKILL.md) resolves it. Lint first; a page that is red here belongs to `kb-edit` before it belongs here:

```bash
node scripts/kb.mjs validate <id>
```

Do not `kb.mjs get` the page into your own context. The readers do that in theirs; yours
holds the plan.

More than one page is a batch. Resolve the ids, then go to step 6:

| asked for | the ids |
|---|---|
| a kind | `node scripts/kb.mjs ls --kind <kind>` |
| an area | `jq -r '.areas[] \| select(.id=="<area>") \| .pages[].slug' docs/data/site-structure.json` |
| a list | as given |

## 2. Fan out the six readers

Launch [kb-persona-reviewer](../../agents/kb-persona-reviewer.md) six times in parallel, one
call per section of [personas.md](references/personas.md): practitioner, sceptic,
senior-expert, architect, agent-consumer, plain-language. Each call carries the id, the kind,
its brief pasted whole, and the skill that owns the kind's blocks:

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

Ask for the fixed reply and nothing else, returned and also sent to you by message when the
reader runs as a named teammate: six returns landing together are truncated past about 16,000
characters, a message is not. A reader whose reply still arrives cut off is asked once, by
name, to resend it with every F line under 60 words; the synthesizer waits for the full set. When the request narrows the readers, launch only those. When subagents are not permitted in the session, say so and run the six briefs
yourself, one block at a time through `kb.mjs get <id> --block <b>`, scoped to the blocks
each brief names first.

## 3. Synthesize, and believe nothing

Launch kb-persona-reviewer once more in the `synthesizer` role with the six replies pasted
verbatim and the cap on edits (8 unless the request says otherwise). Its brief, the last
section of personas.md, dedupes, re-reads every anchored block, resolves the conflicts between
readers in a fixed order and returns the edit plan:

```text
PAGE <id>  KIND <kind>  REVIEWS MERGED <n>
E1 | #<anchor> | <action> | <instruction naming the kb.mjs writer or "hand-edit prose"> | from <roles> | rule <skill and item>
DROPPED | #<anchor> | <reason>
NO-FABRICATION CHECK: <every added name or number and its source, or "nothing added">
```

Read the plan before you apply it. A plan whose `NO-FABRICATION CHECK` names a source you do
not recognise, or whose edits delete or move an existing item, goes back with the line that
failed. When the user asked to see the plan first, stop here and show it.

## 4. Apply through the writers

Hand the plan to [kb-author](../../agents/kb-author.md) for this one id, or apply it yourself
under the table in [kb-edit](../kb-edit/SKILL.md) step 2 when subagents are off. Either way:

- Frontmatter, `wild`, `production`, `explain` and edges go through `kb.mjs set`, `wild`,
  `production`, `explain`, `link` and `unlink`. `wild` and `production` replace their whole
  block, so dump the current one first with `kb.mjs get <id> --block wild --json`.
- Other block prose is edited in the file, under the owning skill's rules.
- Generated blocks (`relationships`, `tour`, `fluency`) and hub pages are never touched.
- An existing list item is fixed in place or followed by a new one, never moved, and a
  replaced or appended item copies its neighbours' lead form (`**Lead.** text` or
  `**Lead** — text`, whichever the list already uses).

An essence or `solves` change moves search ranking for every page near it: a theme that took
a pattern's symptom words once pushed `circuit-breaker` out of its oracle answer. Run
`make gate G=check-search-oracle` after one, and narrow the words if a case breaks.

Then lint and reconcile what the page points at, as [kb-edit](../kb-edit/SKILL.md) step 4
does with [reconcile-links.md](../kb-edit/references/reconcile-links.md):

```bash
node scripts/kb.mjs validate <id>
node scripts/kb.mjs refs <id>
```

## 5. Gate, commit, open the pull request

```bash
make gen && make validate-changed
git add docs/<path-to-page>.md docs/data/relations.json
```

Stage only the paths `git status` shows you changed. An edge edit also changes the other
page's relationships block, `docs/data/prerequisites.json` and `docs/reference/prerequisites.md`
through `make gen`; stage those with it. Run the whole `make validate` before the pull
request. On a branch named `kb-improve/<id>`, commit and push the change and open one
pull request. Its body is the per-page table, one row per page, followed by every `DROPPED`
line so a reader can supply what the synthesizer would not invent:

```text
| page | readers | findings raised / kept / dropped | edits applied | kb.mjs validate | diff lines |
```

## 6. A batch of pages

Resolve the ids with the table in step 1, then run the saved workflow with the Workflow tool:
`scriptPath` `.claude/workflows/kb-improve-batch.mjs`, `args` `{ ids, label, personas?,
maxEdits? }`. It runs steps 2 to 4 per page, readers in parallel, and returns `{ pages }`,
one summary per page with the files it touched. Then this session runs `make gen && make
validate` once, stages exactly the paths the summaries name, and opens one pull request on
`kb-improve/<label>` with the table from step 5.

Never run a batch before a pilot of five single pages, one per kind, has been read and
approved by the owner on its pull request: a brief that fabricates once will fabricate at
scale.

## Done means

- Every read went through `kb.mjs`; no tool call opened a page file except the writer editing
  block prose.
- Every applied edit traces to a finding with a stable anchor and a cited rule: the owning
  skill and its quoted Done-means item or section.
- No existing list item was moved, renumbered or deleted; new items were appended.
- Nothing was added to `wild`, `production`, `mapping` or `contenders` without a named
  source, and every dropped finding is listed with its reason.
- `node scripts/kb.mjs validate <id>` reports nothing, `kb.mjs refs <id>` matches the edit,
  and `make gen && make validate` exits 0.
- One pull request per run, exact paths staged, the per-page table and the dropped lines in
  its body.
