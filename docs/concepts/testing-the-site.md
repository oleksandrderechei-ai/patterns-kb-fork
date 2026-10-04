---
title: Testing the site
description: A hands-on walk through building, opening and testing the site — the commands, what each one prints, and what to try by hand in a browser.
area: reference
owner: Oleksandr Derechei
tags: [testing, testability]
status: stable
---

# Testing the site

This page walks you through testing the site by hand, from a fresh clone to a change you watch
break and then restore. It is for whoever dev-tests the site before a release: every command
here was run on 2026-09-30 against a build made with `make site-clean && make site-build`, and
every "you should see" is what that build showed. Run the commands from the repository root.

## Set up

Do this once per clone, and again when `package-lock.json` changes.

1. Use the Node version in `.nvmrc` (24). With nvm, `nvm use` reads the file; `node --version`
   should then print `v24.…`.
2. `make install` runs `npm ci` for the whole workspace. It writes a stamp inside
   `node_modules`, so later targets skip it until the lockfile changes.
3. `make site-deps` downloads the headless Chromium the build draws diagrams in, and the one
   the reader flows run in. Playwright keeps it outside the repository, so `make site-clean`
   never removes it.
4. `git config core.hooksPath .githooks` turns on the pre-commit hook, which runs the gates on
   what you stage ([why](working-in-this-repo.md#the-staged-tree-pre-commit)).

```bash
nvm use
make install
make site-deps
git config core.hooksPath .githooks
```

## Build and open

### Build

`make site-build` runs lint, the site's unit tests, the generators, the type check and Astro,
then the post-build passes, then the six site gates. From nothing (`make site-clean` first) it
takes about two minutes. It ends with one line per gate and a total:

| Gate line | What it proves |
| --- | --- |
| Site built links | every link and fragment lands on a built file and anchor, every link to a repository file on GitHub names a file in the tree, every page sits in exactly one hub, in reading order |
| Site portability | every page opens from a folder: relative links, the manifest `index.json` and the search payload `search-index.js` present, and each page's markdown source beside it, byte-equal to its file under `docs/` |
| Site accessibility floor | the static checks: `lang`, one H1 first, named graphics, focus rings, and page chrome under 80% of the page |
| Site noise and data layer | the formatter's fixed point, one script and one stylesheet per page, facts only on class-free data blocks |
| Site accessibility in a browser | axe-core over every page in Chromium, in both themes |
| Site size budget | every page, the bundle, the search payload and the manifest inside the sizes in `BUDGETS` (`tools/src/gates/check-site-budget.ts`); what a host adds is in [Hosting the site](hosting-the-site.md) |

A clean build ends `✓ 6 gates, no findings`. A red line names the page and the fix, and the
command exits non-zero, but `site/dist/` is still written, so you can open what failed.

### Open it the way an offline reader does

`make site-open` opens `site/dist/index.html` from disk (`file://`), the way a reader who
downloaded the folder sees it. Everything a reader uses works from disk: links, search, the
theme and the marks, the phone "On this page" menu and the code copy button. The browser console
stays empty: the site's scripts are all classic, which a browser runs from disk, and the reader
flows fail on any console error. How a host should serve the same files is in
[Hosting the site](hosting-the-site.md). To open any other page, run `open site/dist/<path>` (macOS) with a path from the
table below.

### Live reload while you edit

`make site-dev` mirrors `docs/` once, bundles the client and starts Astro's dev server at
`http://localhost:4321`. Pages there live at folder-style URLs such as
`/patterns/distributed/resilience/circuit-breaker/`. Stop it with Ctrl-C; if it started in the
background (Astro does this when it detects an agent), stop it with `cd site && npx astro dev stop`.

It shows less than a build, so never sign a change off from it:

- **An edit under `docs/` does not reach it by itself.** The mirror ran once at start: run
  `cd site && npm run gen`, and the page reloads a few seconds later. An edit under
  `site/src/` reloads at once.
- **No post-build pass runs.** There is no search payload, so the search box says "Search is
  not built yet — build the site (make site-build).", no manifest, and links are not made
  relative.
- **No gate runs.** Nothing checks links, accessibility or the data layer.

## Run the safety nets

Before you commit a change that touches the site, run `make verify`: it runs `make site-build`,
`make site-e2e` and `make validate` in that order and stops at the first red step. The three
below are the same commands one at a time.

### The gates over the source

`make validate` runs every registered gate over `docs/`, the data files, the tools and the
harness, the ones the gate registry lists under `make validate` (38 as of this edit), in about
two and a half minutes. It ends `✓ <n> gates, no findings` or with
one block per red gate: the finding, a `repro:` command, a `fix:` line and a `more:` link to
its section in [Triage a red gate](../reference/triage.md). It never runs a site gate, since
those need a build.

### The reader's flows

`make site-e2e` runs 57 reader flows under `tools/e2e/` over the built site. Each runs four
ways: `file-desktop`, `file-phone`, `served-desktop` and `served-phone` (from disk and from a
local server, at 1600px and 390px). The 14 flows tagged `@tablet` run a fifth way,
`served-tablet`, at 800px, where cards sit side by side and the sidebar is still a drawer; three
of them (`tablet-cards`, `tablet-drawer`, `tablet-table-scroll`) run only there. It takes about
twenty seconds and never rebuilds. A green run prints `214 passed, 16 skipped` over 230 runs.
`draft-chip` skips its second half because no page is a draft, `phone-menu`,
`phone-home-menu`, `phone-table-scroll`, `phone-diagram-size` and `action-bar-clear-of-toc`
skip at desktop width, and `toc-tracking` skips on a phone, where the outline is the phone
menu. The seven entries are pinned in `docs/data/allow/site-e2e.json`: a skip beyond them
fails the gate, and so does an allowance that is higher than the skips that happen. With no
Chromium the gate skips and exits 0 on your machine; CI sets `KB_REQUIRE_BROWSER=1`, which
makes a missing browser a failure.

The flows added after the first 35 hold what a screenshot cannot:

- **`tour-progress`**: a theme page is a tour, and it says "n of m practiced" for the pages it
  walks, counted in the browser from the build's page list and the reader's marks; the count
  holds after a reload, and the home page lists only tours the reader has begun.
- **`not-found`** and **`not-found-deep`**: `404.html` loads no file and carries its own style,
  so it renders in both colour schemes and at any depth, from a server that answers 404 for a
  missing path four folders down and from a file put that deep on disk.

- **`deep-link`** (five flows, one per kind of target: a list item, a heading, a table row, a
  code sketch, an element inside a closed sketch): `route#id` lands the target below the sticky
  header, opens the sketch around it and paints the `:target` highlight.
- **`toc-tracking`**: on a desktop the "On this page" rail marks the section being read, and a
  rail link lands its heading below the header.
- **`diagram-tools`** and **`diagram-fullscreen`**: zoom in, the zoom-out floor, the arrow-key
  pan, and fullscreen with its way out.
- **`search-keyboard`** (four flows): the shortcut, arrow and Enter, Escape returning focus to
  the button, Tab staying in the open dialog, and Meta K on an Apple user agent.
- **`theme-first-paint`**, **`theme-across-tabs`** and **`theme-storage-blocked`**: the page is
  in its theme when parsed, a choice made in one tab holds in the next, and the button still
  cycles when the browser refuses site data.
- **`print`**: the page in print media drops its sidebar, buttons and action bar, keeps its
  words and the cards' borders, and does not run sideways.

After you add or change a flow, run `make site-e2e-repeat`: it runs every flow three times in a
row, with the gate's config and without its skip check, and prints one dot per run. A flow that
passes once and fails once in three is a flake, usually a read that does not wait for the page
to settle; fix it with an `expect` that polls, never with a retry. A green run ends
`618 passed` and `48 skipped`, the gate's counts three times over, in about a minute.

To watch one flow, or stop inside it, run Playwright yourself with the same config. Each flag
below was run on 2026-09-30:

```bash
npx playwright test -c tools/e2e/playwright.config.ts --list
npx playwright test -c tools/e2e/playwright.config.ts --headed --grep search --project file-desktop
npx playwright test -c tools/e2e/playwright.config.ts --debug --grep keyboard --project file-desktop
npx playwright test -c tools/e2e/playwright.config.ts --trace on --grep theme --project file-desktop
```

- **`--list`** prints all 230 runs (57 flows over the five ways) without running them.
- **`--headed`** opens a visible browser; `--grep <flow>` picks flows by title (a regular
  expression); `--project <name>` picks one of the five ways.
- **`--debug`** opens the Playwright Inspector and pauses on the first step; step through it,
  and close the Inspector when you are done.
- **`--trace on`** records a trace into `$TMPDIR/kb-e2e-results/<spec>-<flow>-<project>/trace.zip`;
  open it with `npx playwright show-trace <that path>`. A failed run leaves an
  `error-context.md` beside it, with the page's accessibility tree at the moment it failed.

If a run fails with `http://127.0.0.1:4719/index.html is already used`, a server from an
interrupted run is still up. `lsof -nP -iTCP:4719 -sTCP:LISTEN` names it: stop it, or run
`KB_E2E_PORT=4720 make site-e2e`.

### Screenshots for your eyes

`make site-shots OUT=/tmp/kb-shots` writes 56 PNGs in seconds: seven pages (six
templates, the pattern one twice for its polarity cards), at four widths, in both themes, named
like `desktop-home-dark.png`. No gate reads them; they are for you to look at.

### When something is red

Every red line names its gate. Its section in [Triage a red gate](../reference/triage.md) says
what it protects and how to fix it, and the **gate-red** skill
([SKILL.md](../../.claude/skills/gate-red/SKILL.md)) finds the section and the one command
that reproduces the failure.

## What to test by hand

Build once, then walk the table in a desktop browser. Each "open this" path is under the
repository root and exists in the 2026-09-30 build. The last column names what already checks
the same thing on every run, so a row that fails by hand but passes there is a gap in the test.
A flow picks its pages from the data (`tools/e2e/fixtures.ts`), so it may use a different page
of the same kind; the row names the page it uses when that matters.

| Open this | Do this | You should see | Guarded by |
| --- | --- | --- | --- |
| `site/dist/index.html` | Read the cards, then click **Hazards & Antipatterns**, then **God Object** in its list | Eight cards, each with no stray backtick; the hub's breadcrumb reads Home › Hazards & Antipatterns; God Object opens with its H1 and its sidebar entry highlighted | `navigation.spec.ts` › `home-to-page` |
| `site/dist/hazards/god-object.html` | Click **Spaghetti Code** in the sidebar, then **Cloud Capabilities** | Only the current page is highlighted; other areas are one bold link with a caret each, and Compute shows in the sidebar only once you are on the Capabilities hub | `navigation.spec.ts` › `sidebar` |
| `site/dist/patterns/distributed/resilience/circuit-breaker.html` | Click **Timeout / Deadline** in the card under the title; go back and click **Bulkhead** | A card with a READ FIRST row (Timeout / Deadline) and a RELATED row (Retry with Backoff, Bulkhead and seven more); each link opens its page (the flow uses Microservices) | `navigation.spec.ts` › `prerequisite-card` |
| the same page, at its foot | Click the first entry under **Mentioned by**, then come back and use **Next** and **Up** | Mentioned by lists Microservices and System Design Interview, each with its kind; Next → Retry with Backoff; ↑ Up → Resilience (the flow uses Singleton and God Object) | `navigation.spec.ts` › `mentioned-by-and-next-steps` |
| `site/dist/hazards/god-object.html` at 390px wide (the browser's device mode) | Tap **Menu**, then **Spaghetti Code**; also scroll the home page, the Hazards hub and `comparisons/application-platforms.html` sideways | The sidebar hides behind the Menu button and the drawer opens on tap; no page scrolls sideways | `navigation.spec.ts` › `phone-menu` |
| `site/dist/comparisons/object-stores.html` at 390px wide | Swipe the table sideways, or click inside it and press → | The table sits in a box with a fade at the edge that has more behind it; the first column stays under 14rem wide; the box takes focus and scrolls under the arrow key | `reading.spec.ts` › `phone-table-scroll` |
| `site/dist/patterns/distributed/resilience/circuit-breaker.html` at 390px wide | Look at the first diagram, swipe it sideways, tap the fullscreen button in its toolbar | The labels are about 11px tall rather than a few pixels; the diagram scrolls inside its own frame; the fullscreen button is on screen (the flow uses a page with a diagram 1000 units wide) | `reading.spec.ts` › `phone-diagram-size` |
| the same page at 390px wide | Tap **On this page**, then close it and scroll to the foot of the page | The three icons of the bar sit under the open menu and never cover it; the page ends with padding as tall as the bar | `reading.spec.ts` › `action-bar-clear-of-toc` |
| the same page | Click the theme button at the top right (labelled "Theme: auto — click to change") until it is dark, reload, then light | The whole page turns dark and stays dark after a reload; text stays readable in both themes | `reading.spec.ts` › `theme` |
| the same page | Scroll to the diagrams, then open the first sketch under **Code sketch** and click its copy button; paste somewhere | Three drawn diagrams with captions; two closed sketches ("TypeScript — the smallest breaker that works, state in this process" first); the code you paste is the sketch's code (the flow uses Singleton) | `reading.spec.ts` › `diagram-sketch-copy` |
| the same page, at 390px | Open **On this page**, pick a heading; then open a sketch and click its copy button | The menu opens, names the section being read and closes when you pick a heading; the copy button answers with its own note, and the console stays empty (from disk too) | `reading.spec.ts` › `starlight-scripts` |
| the same page | In the toolbar at the bottom right click **View source** | The browser shows the page's markdown as text: the `title:` line of its frontmatter, then its `# ` heading; it works from disk and from a server | `reading.spec.ts` › `view-source` |
| `site/dist/hazards/god-object.html`, then `site/dist/comparisons/object-stores.html` | Press Tab once on the first; on the second, click inside the table and press → several times | A **Skip to content** link appears with a focus ring; the table scrolls sideways under the arrow key | `reading.spec.ts` › `keyboard` |
| `site/dist/404.html` (the page GitHub Pages serves for an address the site lacks), in a light and a dark colour scheme | Read it; click **home page** and **search** | H1 Page not found, one sentence, no header, no sidebar and no buttons; a narrow readable column in both schemes; the two links are absolute (`https://…/index.html` and `…/index.html#search`), so they land from any depth; the page loads no stylesheet, script or icon and carries one inline style | `navigation.spec.ts` › `not-found` |
| `/patterns/a/b/c/missing.html` from the local server (from disk, the same file put four folders down) | Open an address the site does not hold | The server answers 404 with the not-found page, styled, and the browser asks for nothing but the page itself | `navigation.spec.ts` › `not-found-deep` |
| `site/dist/index.html` | Click the example symptom under the search prompt | The search box opens already filled and answered, with the cursor in the field | `navigation.spec.ts` › `home-search-example` |
| `site/dist/index.html` at 390px wide | Tap **Menu** | The home page has the menu button; the drawer opens on My marks and the theme toggle, then the areas | `navigation.spec.ts` › `phone-home-menu` |
| the circuit-breaker page (any page with more than five related pages) | Read the card under the title, click **See all N** | Each link says why it is there; five links show, and the rest open under "See all N" | `navigation.spec.ts` › `related-reasons` |
| `site/dist/marks.html` | Read the lists; unstar an editors' pick on its page; star another page | The picks sit under Suggested and the reader's own stars under Yours; an unstarred pick leaves Suggested and does not move to Yours; the hub chip reads Starred with a tooltip naming the editors' picks | `marks.spec.ts` › `marks-suggested` |
| `site/dist/patterns/distributed/resilience.html` | Press a chip, then **Clear filters**; press **Starred**; press two chips no row shares | A pressed chip shows a check mark; Clear filters appears with any filter and puts every row back; Starred sits on its own **Show:** row; two chips with no common row say "No pages match these filters." | `marks.spec.ts` › `facets-clear` |
| `site/dist/hazards.html` | Scroll down, open a row, press Back | The page returns to the same scroll position | `marks.spec.ts` › `hub-scroll-back` |
| `site/dist/index.html` | Click **Search** (or press Ctrl K / ⌘ K), type `qqxzv wkjzq`, then `circuit breaker`, then pick the result | "Type a name, or what went wrong, to search every page." before you type; "Nothing matched “qqxzv wkjzq”."; then Circuit Breaker first, and it opens on click | `search.spec.ts` › `search` |
| `site/dist/index.html`, search box | Type a line from a page's `solves`; read the shortcut cap on the search button | Each row wears a quiet kind badge (pattern, hazard, case study, theme, principle, capability or comparison) beside its title; the cap reads "⌘ K" on a Mac and "Ctrl K" on every other keyboard | `search.spec.ts` › `search: each result wears a quiet kind badge` and `search: the shortcut cap names this keyboard` |
| `site/dist/index.html`, search box | Type `ai`, then `gen`, then `case study` | `ai`: AI Agent first. `gen`: page rows first (Gen AI at Scale, Unique ID Generation), and any definition card the word only begins ("generalizes") sits below the rows, at most three. `case study`: a case study first, then more case studies. A list never draws more than 20 rows; past that the note says "Showing the first 20 of N results" | `search.spec.ts` › the three `search:` flows |
| `site/dist/patterns/distributed/resilience/circuit-breaker.html#tradeoffs-con-2`, then the same page with `#sketch-variant-1`, and `designs/persona-identification.html#deepdives-p-50`, an id inside a closed code sketch (the flows pick their own pages of each kind) | Paste each address into the bar | The page scrolls to the target and stops with it just under the header, not behind it; a sketch that was closed around the target is open; the target wears a tint and an accent bar on its left | `anchors.spec.ts` › the five `deep-link:` flows |
| `site/dist/patterns/distributed/resilience/circuit-breaker.html` at 1600px wide | Scroll until the third section heading is at the top; then click a later entry in "On this page" | The entry for the section you are in is marked; the click scrolls the heading to just under the header, and one entry stays marked | `anchors.spec.ts` › `toc-tracking` |
| the same page | Press **Zoom in** and **Zoom out** until it stops going smaller; click the diagram, press → ; press **Fullscreen**, then Esc | The drawing grows by a quarter per press and stops at 40% of its size; → moves it to the left; fullscreen shows the diagram alone and Esc brings the page back with focus on the button (headless Chromium cannot press Esc for the browser, so the flow ends fullscreen with `exitFullscreen()`) | `diagrams.spec.ts` › `diagram-tools` and `diagram-fullscreen` |
| `site/dist/index.html` | Press Ctrl K (⌘ K on a Mac), type `circuit breaker`, press ↓ then Enter; open the box again and press Esc; open it once more and press Tab many times | ↓ moves the highlight one row down and Enter opens that row; the first row is already highlighted, so Enter alone opens Circuit Breaker; Esc closes the box and puts focus on the Search button; Tab walks the box and then out to the browser's own bar, and never to the page behind it | `search.spec.ts` › the four `search-keyboard` flows |
| the same page, with the OS set to dark and no stored choice | Reload; then choose Light in one tab and open the page in a second tab | The page is dark from its first paint and the button says "Theme: auto"; the second tab is light from its first paint, with no dark flash; with the browser blocking site data the page still renders and the button still cycles, with a silent console | `reading.spec.ts` › `theme-first-paint`, `theme-across-tabs` and `theme-storage-blocked` |
| `site/dist/designs/bitly.html`, in the browser's print preview | Open Print (Cmd P) | The sidebar, the header buttons, the star and practiced bar and the right rail are gone; the Pros and Cons cards keep their borders and words; nothing runs off the sheet | `layout.spec.ts` › `print` |
| `site/dist/designs/bitly.html` at 800px wide, then 799px (the flows use the first design with both cards) | Drag the window narrower by one pixel at 800px | At 800px the Pros and Cons cards sit side by side and the sidebar is behind **Menu**; at 799px the cards stack. A comparison table scrolls inside its own box at 800px | `layout.spec.ts` › `tablet-cards`, `tablet-drawer` and `tablet-table-scroll` (the `served-tablet` project) |
| `site/dist/hazards/god-object.html`, then `site/dist/hazards.html` | Click **Favourite** in the toolbar; on the hub click **Starred**, then click it again | God Object's star is filled on the hub; the filter leaves only starred rows (the reader's and the editors' picks) (Split-Brain, Cache Stampede and Cascading Failure are starred by the author), and the second click brings every row back | `marks.spec.ts` › `favourites` |
| `site/dist/hazards.html`, then `site/dist/hazards/god-object.html` | Note the count, click **Practiced** on God Object, go back and reload | In a fresh browser "0 of 36 practiced" becomes "1 of 36 practiced", and stays after a reload | `marks.spec.ts` › `practiced` |
| a theme page (the flow picks a tour), two of its pages, then `site/dist/index.html` | Open the theme page; practice two of the pages it walks, each on its own page; open the theme page, reload, then open the home page | "0 of N practiced" under the title at first; then "2 of N practiced", and the same after a reload; the home page lists the tour with "2 of N practiced" and lists no tour before any mark | `marks.spec.ts` › `tour-progress` |
| `site/dist/patterns/gof/creational.html` | Click the **decoupling** chip, then click it again | "3 of 5 shown" and three rows; the second click shows all five and clears the count | `marks.spec.ts` › `facets` |
| `site/dist/patterns/gof/creational.html` | Click the **decoupling** chip, reload, open a row, then press Back | The address bar gains `?f=…`; after the reload and after Back the chip is still pressed and the same three rows show; a link with an unknown `f=` value shows every row | `marks.spec.ts` › `facet-url` |
| `site/dist/hazards/god-object.html` | Click **Favourite** and reload | The star is in the state you left it | `marks.spec.ts` › `favourite-reload` |
| `site/dist/marks.html` (the **My marks** link in the header) | Star and practice a page first; then click **Export**, **Reset** (cancel, then confirm) and **Import** with the file you saved, then import a text file that is no JSON | Both marks are listed with title, kind and link; the exported file reads `{"version": 1, "favourites": …, "practiced": …}`; Reset empties both lists only after you confirm; Import brings them back; the text file is refused with a "Not imported" message; a mark for a page the site no longer has sits under **No longer in the site** with a Remove button | `marks.spec.ts` › `marks-page` |
| `site/dist/hazards.html` | Look at the rows | No row wears a **draft** chip: no page is a draft today, so the flow's second half skips | `marks.spec.ts` › `draft-chip` |
| `site/dist/hazards/god-object.html` | Find **From Pattern to Product** in the sidebar, among the areas and in no group, and click it | One plain link, not bold and with no caret; it opens `map/stack.html` with its H1, the sidebar entry highlighted and Home as the only crumb; the map has no hub page | `navigation.spec.ts` › `sidebar-stack-link` |
| `site/dist/map/stack.html` | Hover a product link, then click **Singleton** in the first row | 20 tables, a row per pattern; product links go to vendor documentation; Singleton opens its page | `map.spec.ts` › `stack` |
| `site/dist/designs/bitly.html` | Read the section list in the right rail | Among the sections: Understanding the problem, Requirements, Right-sizing, Core entities, The interface, How the system is built, Deep dives, Limitations & trade-offs; many diagrams | the site gates (Site built links, Site portability) |
| `docs/reference/glossary.md`, `docs/reference/tags.md`, `docs/reference/search-synonyms.md`; also `ls site/dist` | Open each on GitHub or in an editor and follow a few links in its tables; list the built site's top folders | The Reference area is unpublished: `site/dist` has no `reference` folder and no `reference.html`, and no sidebar entry or home card names it. Glossary: sections from Who decides a word through Kinds, Blocks, Verbs, Polarities, Levels, Properties and House; Tags: Facets, Topics, Skills, Languages; Search synonyms: Curated and Expansions tables; every link lands | `glossary-fresh`, `tags-fresh` and `search-synonyms-fresh` in `make validate` |
| `site/dist/index.html`, search box | Search each query in the list below | Each query's first result is the page named beside it | `search.spec.ts` and `make gate G=check-search-oracle`, which runs the oracle's queries through this ranking and through `kb.mjs find` |

The search queries, each checked in the built search box from disk on 2026-09-30:

- `circuit breaker` → Circuit Breaker
- `pub/sub` → Publish-Subscribe (an alias)
- `my thread pool is exhausted and every request hangs` → Circuit Breaker, then
  Connection-Pool Exhaustion
- `url shortener` → Bitly
- `cache is stale` → Stale Cache
- `alternative to kafka` → Message brokers & streams
- `ai` → AI Agent; `llm` → ChatGPT or AI Agent; `ml` → ML System Design
- `gen` → Gen AI at Scale, then Unique ID Generation
- `case study` → the case studies; `machine learning` → the Machine Learning pages
- `resilience` → the Resilience theme, then Circuit Breaker among the first five
- `CB` → Circuit Breaker; `DRY` and `KISS` → their principles; `kafka` → Message brokers & streams

`docs/data/search-oracle.json` lists these and more; a query that goes wrong is added there first.

The whole-corpus search check asks every page's own symptom lines and titles and holds the
top-1 rates: `make tools-test T=search-relevance` runs it. To print the rate table instead,
run `cd tools && KB_RELEVANCE=report npx vitest run src/lib/search-relevance.test.ts --reporter=verbose`;
on 2026-10-02 it read top-1 99.7% for the symptom lines as written and 99.0% over all 1,989
queries.

## Change something and watch it

### Edit a page

Make one edit through a writer and one by hand, then rebuild:

```bash
node scripts/kb.mjs set circuit-breaker --essence "Stops calling a service that is already failing, so callers fail fast"
make gen && make site-build
```

For the hand edit, open `docs/patterns/distributed/resilience/circuit-breaker.md` and add a
sentence to the paragraph under the H1 before you run the two commands. After the build:

- `site/dist/patterns/distributed/resilience/circuit-breaker.html` shows your sentence near the
  top, under the card.
- `site/dist/patterns/distributed/resilience.html` shows the new line beside Circuit Breaker,
  and so does its search result.
- `make gen` rewrote `docs/data/prerequisites.json` and `docs/reference/prerequisites.md`,
  because the prerequisite card shows each page's description.

Restore the page, then run `make gen` again and check that nothing is left over:

```bash
git show HEAD:docs/patterns/distributed/resilience/circuit-breaker.md > docs/patterns/distributed/resilience/circuit-breaker.md
make gen
git status --short
```

If `git status` still lists `docs/data/prerequisites.json` with only its `updated` date
changed, restore that file the same way.

### Break a link

Open `docs/hazards/god-object.md` and misspell the `dependency-injection.md` link on the first
line that has one (`dependency-injectoin.md`). Then:

- **`make validate`** goes red on two gates: `repo-links` names
  `docs/hazards/god-object.md:51`, and `tests-vitest` fails the two tests that run that gate over
  the real tree.
- **`make site-build`** goes red on Site built links. The build turned the link into a link to
  the file on GitHub, since the site publishes no such page, and the gate names
  `site/dist/hazards/god-object.html` and the missing path.
- **`make site-e2e`** stays green. The flows walk the reader's paths (hubs, sidebar, cards,
  search), not every prose link: that is Site built links' job.

To watch a flow go red, break what a flow uses. In
`site/src/components/MentionedBy/MentionedBy.astro`, change the heading text `Mentioned by`
to `Linked from`. `make site-build` now stops early, at the site's unit tests
(`mentioned-by.render.test.ts`), before anything is built. Build past them with
`cd site && npm run build`, then run `make site-e2e`: `mentioned-by-and-next-steps` fails in
all four projects, each finding naming the line of `tools/e2e/navigation.spec.ts` that looks
for the aside named Mentioned by.

Restore both files and rebuild:

```bash
git show HEAD:docs/hazards/god-object.md > docs/hazards/god-object.md
git show HEAD:site/src/components/MentionedBy/MentionedBy.astro > site/src/components/MentionedBy/MentionedBy.astro
make site-build && make site-e2e
```

Restore with `git show HEAD:<path> > <path>`, never `git checkout -- <path>`: other sessions
stage into the same index ([why](working-in-this-repo.md#staging-and-restoring)).

## The authoring loop

Most changes to a page go through `scripts/kb.mjs`, which reads the corpus a block at a time
and writes through validated writers:

```bash
node scripts/kb.mjs find "one slow dependency blocks my threads"
node scripts/kb.mjs get circuit-breaker --block usage
node scripts/kb.mjs related circuit-breaker
node scripts/kb.mjs validate circuit-breaker
make gen && make validate
```

`node scripts/kb.mjs` alone prints every command. The first four above only read. `set`,
`wild`, `production`, `explain`, `level`, `link`, `unlink` and `new` are the writers, as in
[Edit a page](#edit-a-page); anything else on a page is a hand edit
under the page rules in `.claude/rules/markdown-authoring.md`. `make gen` rebuilds every
generated block and reference page, and a second run writes nothing; `make validate` then
checks the lot. Rebuild the site only when you want to see the page.

## What the tests do not cover

The gates and flows prove that the site works; they do not prove that it reads well.

- **Visual taste**: spacing, hierarchy and colour choices past the contrast floor. Look at the
  `make site-shots` pictures, or run the **site-audit** skill, which walks the same pages and
  reports what looks wrong, each finding measured.
- **Copy quality**: whether a page's prose is clear, true and in the house register. Review
  catches it, with the kb-design-review and kb-fact-check skills for depth.
- **Widths other than the three**: the flows run at 1600px and 390px, and 14 of them at 800px;
  the screenshots add two more. Drag the window through the widths between, and past 1216px
  where the sidebar pins, yourself.
- **What a machine reader sees**: the **page-audit** skill reads one built page's data layer
  and knowledge share.
- **Other browsers**: every automated run uses Chromium. Open the site in Safari and Firefox
  once before a release.
