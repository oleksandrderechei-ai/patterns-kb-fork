---
name: kb-move
description: "Move a KB page to another area (band or group): its area line and its structure-file row together, the file move, and the relative links that break. Use when someone says 'move this pattern to another band', 'this belongs under Resilience', 're-file this page'. Not for a new page (kb-add) or regrouping relationships (kb-edit)."
---

# Moving a page

A page's **`area:` must name the area whose row lists it** in
[docs/data/site-structure.json](../../../docs/data/site-structure.json) — exactly one row
names the page's path as its `source`, and the `kb-shape` gate fails the page when the two
disagree ([KB-001](../../../docs/reference/page-rules.md#KB-001)). So re-filing a page is
never just a `git mv`, and never just a frontmatter edit. Decide which of the three shapes
you are in before touching anything.

## Which move is this?

| Situation | Cost |
|---|---|
| **New place in the same area** | move the row within its area's `pages` list. Nothing else. |
| **New area, same folder** | the `area:` line and the row, moved to the new area's `pages`. No file move, no link changes. |
| **New area, new folder** | file move + `area:` + the row's area and `source` + links, and the page's own `../` depth may change |

A page's file basename is the key a reader's saved marks (favourites, practiced) are stored under in the browser, so renaming a file orphans every reader's marks for it; a move between folders keeps the basename.

**Prefer the first two.** The folder is not checked against the area — KB-001 ties the page
to its row, not to a directory — which is how `distributed-routing`/`distributed-scale` and
`distributed-coordination`/`distributed-data` share one folder each. If the move is
editorial (this subsection got too big, these pages belong together) and the pages stay
under the same band, add an area and move the rows, not the files. The page still names
its own area honestly; only the folder is shared.

Adding an area is a new entry in the structure file's `areas` (its `nestUnder` parent and
its `hub`) plus its id in `AREAS` in `site/src/lib/types.ts`, in the same order; the
`site-structure` gate fails the two out of step. The hub for it is generated.

## Why links break, and in which direction

Pages link to each other with **relative `.md` links**, so a file move breaks links two
ways, and they fail differently:

- **Outbound** — every `../` inside the moved page. These break only when the move changes
  the page's **depth**. `patterns/distributed/routing/x.md` →
  `patterns/distributed/coordination/x.md` is the same depth and outbound links survive;
  `patterns/enterprise/x.md` → `patterns/distributed/resilience/x.md` is one level deeper
  and every `../` in the file is now wrong.
- **Inbound** — every link from another page to this one. These break on **any** file move.
  Sibling links (`./foo.md`) from pages left behind become `../<newfolder>/foo.md`.

The `repo-links` gate catches both, anchors included. Mermaid `click` lines carry the
page's **route**, not its file path, so they survive a file move as long as the row's
`route` stays; change the route only when the URL should follow the folder, and then the
`site-links` gate on `make site-build` lists every click and link still on the old one.

## The procedure

1. **Confirm the target exists.** The area must already be in the structure file. If you
   are inventing one, add it first (above).

2. **Move the file** (skip when only the area changes):
   ```bash
   git mv docs/patterns/<old>/<id>.md docs/patterns/<new>/<id>.md
   ```

3. **Move the row and the area together.** `kb.mjs set` handles `--aliases`, `--tags`,
   `--solves`, `--essence` and `--favourite` — it has **no area setter**. Edit the page's
   `area:` line and move its row to the new area's `pages` list in the same change, with
   its `source` pointing at the new path. The row's place in that list is the page's place
   on the hub. For a batch, script the two edits rather than making them by hand — a
   hard-coded id map, idempotent, dry run first.

4. **Fix the links.** Run `make gate G=check-repo-links` and let it list them. Fix outbound
   first (they are all in the one moved file), then inbound.

5. **Regenerate and verify:**
   ```bash
   make gen && make validate
   ```

## What moves with it, that you did not edit

- **The hubs, the map and the breadcrumbs**, which the site build reads from the structure
  file — both the old area's hub and the new one change on the next `make site-build`.
- **`docs/data/learning-paths.json`**, whose stages name the page's route: when the route
  changes, change it there in the same commit, or the `learning-paths` gate fails.

Commit all of it **together**: the pre-commit hook validates the **staged** tree, so a
commit of the page without its row is rejected.

## What does not move

Visitor state is safe. `elevation-map-progress-v1` and `kb-favourites-v1` key by **page
slug**, and a move never changes the slug. Nothing keys on area or on path, so no move loses
anyone's progress or favourites.

## Done means

1. `make gen && make validate` — clean, including `kb-shape`, `site-structure` and
   `repo-links`.
2. `node scripts/kb.mjs get <id>` resolves, and `node scripts/kb.mjs ls --band <band>` lists
   it under the new band.
3. `git diff --stat` shows the moved file, its `area:` change, the structure file, and
   `learning-paths.json` when the route moved — **nothing else**.
4. `make site-build` is green, and on `make site-dev` the moved page's breadcrumb and
   prev/next lead where they should. Those come from the row, and are the first place a
   row in the wrong area shows up.
