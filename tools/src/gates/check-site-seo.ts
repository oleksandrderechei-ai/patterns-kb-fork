/**
 * What a search engine and a link preview read off the built site, held where
 * the build writes it (site/dist). Over every built page:
 *
 *   1. its `<title>` is its own: no two pages share one, read with their
 *      entities decoded, so no two search results look alike;
 *   2. it has a meta description of at most DESCRIPTION_MAX characters, the
 *      length a result shows whole;
 *   3. its canonical link, its `og:url` and its JSON-LD `url` are one
 *      address, under the published root (publicRoot), so search, a preview
 *      and a machine reader all name the page the same way;
 *   4. its `og:image` sits under the published root and names a file the
 *      build wrote, so a preview has a picture to show.
 *
 * And over the sitemap: it lists the canonical address of every page that
 * does not ask to stay out of search, and nothing else. A page whose robots
 * meta says `noindex` is in no sitemap.
 *
 * Dates are not checked. The CI checkout that runs this gate is shallow, so
 * every page's date there is the tip commit's; the Pages workflow builds from
 * full history.
 *
 * Every finding names its file from the repository root, whatever form
 * `--dist` was given in.
 *
 * Usage: check-site-seo [--dist <dir>]   (default site/dist)
 */

import fs from 'node:fs';
import path from 'node:path';

import { attrValue, decode, elements, jsonLdBlocks, metaContent, parseAttrs, stripTags, tags } from '../lib/built-page.js';
import { main, type GateContext, type GateSpec } from '../lib/gate.js';
import { DIST, publicRoot } from '../site/site-output.js';

/** The longest meta description a search result shows whole. */
export const DESCRIPTION_MAX = 160;

/** What this gate reads off one built page. */
export interface SeoFacts {
  readonly title: string;
  readonly description: string | null;
  readonly canonical: string | undefined;
  readonly ogUrl: string | undefined;
  readonly ogImage: string | undefined;
  readonly ldUrl: string | undefined;
  readonly noindex: boolean;
}

/** The content of the first `<meta property="…">` naming `property`. */
export function metaProperty(html: string, property: string): string | undefined {
  for (const t of tags(html)) {
    if (t.closing || t.name !== 'meta') continue;
    const attrs = parseAttrs(t.source);
    if (attrValue(attrs, 'property') === property) return attrValue(attrs, 'content');
  }
  return undefined;
}

/** The `href` of the first `<link rel="canonical">`. */
export function canonicalOf(html: string): string | undefined {
  for (const t of tags(html)) {
    if (t.closing || t.name !== 'link') continue;
    const attrs = parseAttrs(t.source);
    if (attrValue(attrs, 'rel') === 'canonical') return attrValue(attrs, 'href');
  }
  return undefined;
}

/** The JSON-LD block's top-level `url`, if the page has one block that parses and names it. */
export function jsonLdUrl(html: string): string | undefined {
  const block = jsonLdBlocks(html)[0];
  if (block === undefined) return undefined;
  try {
    const url = (JSON.parse(block) as { url?: unknown }).url;
    return typeof url === 'string' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Everything this gate reads off one built page. */
export function seoFacts(html: string): SeoFacts {
  const title = elements(html, (name) => name === 'title')[0];
  const description = metaContent(html, 'description');
  return {
    title: title === undefined ? '' : decode(stripTags(html.slice(title.innerStart, title.innerEnd))).trim(),
    description: description === null ? null : decode(description),
    canonical: canonicalOf(html),
    ogUrl: metaProperty(html, 'og:url'),
    ogImage: metaProperty(html, 'og:image'),
    ldUrl: jsonLdUrl(html),
    noindex: /\bnoindex\b/i.test(metaContent(html, 'robots') ?? ''),
  };
}

/** Every `<loc>` of a sitemap file, entities decoded. */
export function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => decode(m[1] as string).trim());
}

/** Every `.html` file under `dir`, relative to it, sorted. */
function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else if (e.name.endsWith('.html')) out.push(next);
    }
  };
  walk('');
  return out.sort();
}

export const spec: GateSpec = {
  name: 'site-seo',
  usage: 'usage: check-site-seo [--dist <dir>]',
  options: ['--dist'],
  run(ctx: GateContext): string {
    const dist = path.resolve(ctx.root, ctx.options.get('--dist') ?? DIST);
    const shown = (rel: string): string => path.relative(ctx.root, path.join(dist, rel));
    if (!fs.existsSync(dist)) {
      ctx.fail(path.relative(ctx.root, dist) || '.', 'is missing — make site-build writes the site');
      return '';
    }
    const root = publicRoot().href;
    const titles = new Map<string, string[]>();
    const indexable = new Set<string>();
    let pages = 0;

    for (const rel of htmlFiles(dist)) {
      pages += 1;
      const file = shown(rel);
      const facts = seoFacts(fs.readFileSync(path.join(dist, rel), 'utf8'));

      if (facts.title === '') ctx.fail(file, 'has no <title> — Starlight writes one from the page title');
      else titles.set(facts.title, [...(titles.get(facts.title) ?? []), file]);

      if (facts.description === null || facts.description.trim() === '') {
        ctx.fail(file, 'has no meta description — it comes from the page description (frontmatter or hub row)');
      } else if (facts.description.length > DESCRIPTION_MAX) {
        ctx.fail(file, `has a ${facts.description.length}-character meta description, over ${DESCRIPTION_MAX} — shorten the description at its source`);
      }

      const canonical = facts.canonical;
      if (canonical === undefined) ctx.fail(file, 'has no canonical link');
      else {
        if (!canonical.startsWith(root)) ctx.fail(file, `has canonical ${canonical}, outside the published root ${root}`);
        if (facts.ogUrl !== canonical) ctx.fail(file, `has og:url ${facts.ogUrl ?? '(none)'}, not its canonical ${canonical}`);
        if (facts.ldUrl !== canonical) ctx.fail(file, `has JSON-LD url ${facts.ldUrl ?? '(none)'}, not its canonical ${canonical}`);
        if (!facts.noindex) indexable.add(canonical);
      }

      if (facts.ogImage === undefined) ctx.fail(file, 'has no og:image — site/astro.config.mjs names the picture every page carries');
      else if (!facts.ogImage.startsWith(root)) ctx.fail(file, `has og:image ${facts.ogImage}, outside the published root ${root}`);
      else if (!fs.existsSync(path.join(dist, facts.ogImage.slice(root.length)))) {
        ctx.fail(file, `has og:image ${facts.ogImage}, a file the build did not write`);
      }
    }

    for (const [title, files] of titles) {
      if (files.length > 1) ctx.fail(files[0] as string, `shares its title "${title}" with ${files.slice(1).join(', ')}`);
    }

    const sitemaps = fs.readdirSync(dist).filter((f) => /^sitemap-\d+\.xml$/.test(f));
    if (sitemaps.length === 0) ctx.fail(shown('sitemap-index.xml'), 'lists no sitemap file — the sitemap integration writes sitemap-0.xml');
    const listed = new Set(sitemaps.flatMap((f) => sitemapLocs(fs.readFileSync(path.join(dist, f), 'utf8'))));
    for (const url of [...indexable].sort()) {
      if (!listed.has(url)) ctx.fail(shown('sitemap-0.xml'), `does not list ${url}, an indexable page`);
    }
    for (const url of [...listed].sort()) {
      if (!indexable.has(url)) ctx.fail(shown('sitemap-0.xml'), `lists ${url}, which is no indexable page's canonical address`);
    }

    return `[${ctx.name}] ${pages} page(s): titles their own, descriptions within ${DESCRIPTION_MAX}, canonical, og:url and JSON-LD url agree under ${root}, every og:image built; the sitemap lists the ${indexable.size} indexable page(s)`;
  },
};

main(spec, import.meta.url);
