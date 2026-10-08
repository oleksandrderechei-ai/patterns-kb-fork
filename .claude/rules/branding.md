---
description: "The project's name and how to write it: Software Design Atlas in full first, the Atlas after, the KB as the plain noun; the old names kept out; the tools that keep the kb prefix; where the URLs, page titles and licence line come from. Use when writing anything a reader or an agent reads."
paths: ["README.md", "CLAUDE.md", "docs/**", "site/**", ".claude/**", "tools/src/site/**", "package.json", "Makefile", ".github/**"]
---

# Branding

**Question:** what is this project called, and where is each piece of its name decided?

## The name

- **Software Design Atlas** is the name. Write it in full at its first mention in anything a
  reader sees, such as a page, the README, the site, or a commit or pull request title, and
  **the Atlas** after that.
- **The KB** stays the plain noun for the knowledge base itself: "a KB page", "search the KB".
  It describes the thing, so it never stands where the name belongs, in a title or a heading.
- **No acronym.** Spell the name out.

## The old names

The old names, `patterns-kb` and `Patterns KB`, stay out of prose. Write one only inside a
code span that records the history, as the README's "Formerly `patterns-kb`." does.

The clone's folder and Claude's project memory may still carry the old name. That is a path,
not the name: renaming the folder leaves the memory keyed to the old path behind, and the
worktrees' hook paths with it, so leave the folder as it is.

## What keeps the kb prefix

Internal names are handles, not the brand, and stay as they are: `scripts/kb.mjs`, the `kb-*`
skills and agents, the `data-kb-*` attributes and `kb:*` meta names on a built page,
`window.kb`, the `kb`, `kb-site` and `kb-tools` packages, the `KB_*` environment variables, and
`site/src/lib/atlas.ts`, which is the retired home hub, not the brand. Renaming one is a
refactor in its own change, never part of a wording edit.

## Where each piece is decided

| Piece | Source |
| --- | --- |
| Site name: the header, the title suffix, `og:site_name` | `title` in `site/astro.config.mjs` |
| Home page h1 | `title` in `site/src/content/docs/index.mdx` |
| Every page's `<title>` | `titleFor()` in `site/src/lib/page-title.ts` |
| Repository and site URLs | `REPO_OWNER` and `REPO_NAME` in `tools/src/site/site-output.ts` |
| Licence | `LICENSE` (MIT) and `LICENSE-CC-BY-4.0` |

- **Titles.** `titleFor()` adds the kind's word ("Circuit Breaker pattern") and drops the
  site name from a long title. Never write a suffix or a kind word into a page's `title`.
- **URLs.** `PUBLIC_ROOT`, `REPO_URL` and `REPO_BLOB` are built from the owner and name pair,
  and the Pages workflow sets `SITE_URL` from what `configure-pages` reports. Import a URL in
  code; never type it again. Prose that shows the address, the README and
  [hosting the site](../../docs/concepts/hosting-the-site.md), names it in full and changes
  with a rename ([claims.md](claims.md)).

## The licence line

Code, meaning `tools/`, `site/`, `scripts/`, `.claude/`, `.githooks/` and `.github/`, is MIT.
Content, meaning the pages and data under `docs/`, is CC BY 4.0, and a code sketch inside a
page may also be used under MIT. The credit reads "Software Design Atlas by Oleksandr
Derechei", with a link to the site.

## What holds it

The vocabulary gate does: the `word-software-design-atlas` term in
[glossary.json](../../docs/data/glossary.json) bans both old names in the prose of every
tracked markdown file, code spans aside. The site name, the URLs and the page titles are held
by their tests, `site/src/lib/page-title.test.ts` and `tools/src/site/site-sandbox.test.ts`.
The short form and the licence line are review's.
