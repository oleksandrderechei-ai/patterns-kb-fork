---
title: Hosting the site
description: What a host must do for the built site to load fast, namely compress text, cache fingerprinted files for good and revalidate pages, with the measured cost.
area: reference
owner: Oleksandr Derechei
tags: [performance, latency, throughput]
status: stable
---

# Hosting the site

Serve `site/dist/` with compression on and the cache rules below, or readers pay for bytes the
build already made small. The site is plain files and needs no server logic, so any static host
can do it; these are the settings that matter.

## What the host must do

1. **Compress every text file**: HTML, JavaScript, CSS, JSON, markdown, plain text and SVG, with
   brotli or gzip. The budgets in `tools/src/gates/check-site-budget.ts` hold the gzipped sizes,
   so compression is what the numbers assume. It matters most for `llms-full.txt`, the markdown
   of every page in one file.
2. **Cache the fingerprinted files for good**: send `Cache-Control: public, max-age=31536000, immutable`
   for everything under `_astro/`, for `kb.<hash>.js` and for `search-index.<hash>.js`. Each name
   carries a hash of its bytes, so a changed file is a new name and no reader is left with a stale one.
3. **Make readers revalidate the pages and every file with a published name**: send
   `Cache-Control: no-cache` (or a short `max-age`) for every `.html` file and for the files
   beside them that keep their names: each page's `.md` and `.json`, `index.json`, `graph.json`,
   `llms.txt`, `llms-full.txt` and the files under `schema/`. A page names the fingerprinted
   files it loads, so a fresh page is what points a reader at new scripts. The others keep their
   names because they are published addresses, and a reader that kept an old copy would cite a
   page that has since changed.
4. **Serve `404.html`** for an address the site does not hold, with status 404. That covers a
   missing `.json` too: a reader of the [retrieval contract](retrieval-contract.md) takes any
   status but 200 to mean the file is not there.

## What it buys

Measured on the site evaluation's mobile profile (390px wide, CPU slowed 4 times, 1.6 Mbps, 150 ms
round trip, median of three), over a local server that compressed with brotli or did not:

| Measure | Compressed | Raw |
| --- | --- | --- |
| First contentful paint, a singleton page | 576 ms | 1440 ms |
| DOMContentLoaded, the largest case study | 1047 ms | 5542 ms |
| First search open (the payload download) | 720 ms | 3570 ms |

A host that skips the second rule costs less but still costs: without `immutable`, a reader
revalidates the stylesheet, the bundle and the payload on every page.

## What the 404 page does

`404.html` is the one page that stands alone. A host that serves it for a missing path serves it
at the address that missed, so a link written relative to the page would resolve under whatever
folder the reader asked for, such as `/patterns/a/b/missing.html`, and a stylesheet link would
leave the page unstyled. So the build reduces this page to a title, one sentence and two links,
with a small `<style>` in the page and no stylesheet, script or icon link. It renders the same
at any depth and from a folder, in the reader's light or dark scheme (it uses the browser's own
`Canvas` and `CanvasText` colours, so it types none).

Its two links, **home page** and **search**, are absolute URLs under the published root
(`https://odere-pro.github.io/software-design-atlas/` unless `SITE_URL` moves it), so they
land from any depth on the real host. A root-relative link such as `/index.html` would not: the
site lives under the project path `/software-design-atlas/`, not at the host's root. The cost is
that from a folder on disk the two links open the published site, not the local copy; the search
link opens the home page at its search box (`#search`), since this page loads no script to host
the box.

This is a named exception in the absence gate (`NOT_FOUND_FILE` in `tools/src/lib/site-noise.ts`):
every other page loads one stylesheet and one bundle and carries no style element, while this one
must load nothing and carry exactly one small style that fetches nothing. The build step is
`tools/src/site/site-not-found.ts`, run by the post-build pass.

## Moving the site

The published root has one source. `REPO_OWNER` and `REPO_NAME` in
`tools/src/site/site-output.ts` build `PUBLIC_ROOT`, the repository link in the header and
the links to files the site does not publish. The Pages workflow sets `SITE_URL` from what
`configure-pages` reports, the address this repository publishes to, so a deploy after a
rename or a custom domain writes the right canonical links with no edit.

GitHub redirects a renamed repository's web and git addresses, but not its Pages site: every
page under the old project path answers 404. The host root, `https://odere-pro.github.io/`,
is the owner's user site, `odere-pro/odere-pro.github.io`, and it serves any path no project
claims. So old links stay alive through a page there for each old address, with an instant
meta refresh and a canonical link to the new one. Never create a repository under the old
name: GitHub then stops redirecting to the renamed one.

Crawlers read `robots.txt` only at the host root, so the sitemap line lives in that same user
site: `Sitemap: https://odere-pro.github.io/software-design-atlas/sitemap-index.xml`.

## Check it

Open the site from a server with the compression settings on, and read the response headers of one
page, one record, `_astro/style.<hash>.css` and `kb.<hash>.js`: the page and the record should say
`no-cache` and the other two `immutable`, each with a `content-encoding`. From a folder the same
site works with none of this, only slower.
