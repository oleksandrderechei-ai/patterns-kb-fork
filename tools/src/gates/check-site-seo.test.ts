/**
 * The search and preview gate: over a small built site, every page's title
 * is its own, its description fits a result, its canonical link, og:url and
 * JSON-LD url are one address under the published root, its og:image is a
 * file the build wrote, and the sitemap lists exactly the indexable pages.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectFail, expectMisuse, expectPass, makeSandbox, type Sandbox } from '../lib/sandbox.js';
import { publishedUrl, seoPage, seoSite, seoSitemap } from '../site/site-fixtures.js';
import { publicRoot } from '../site/site-output.js';
import {
  canonicalOf,
  DESCRIPTION_MAX,
  jsonLdUrl,
  metaProperty,
  seoFacts,
  sitemapLocs,
  spec,
} from './check-site-seo.js';

const ROOT = publicRoot().href;

describe('the readers', () => {
  it('reads a meta property, the canonical link and the JSON-LD url off a head', () => {
    const html = seoPage({ route: '/patterns/a.html', title: 'A' });
    expect(metaProperty(html, 'og:url')).toBe(`${ROOT}patterns/a.html`);
    expect(metaProperty(html, 'og:title')).toBeUndefined();
    expect(canonicalOf(html)).toBe(`${ROOT}patterns/a.html`);
    expect(canonicalOf('<link rel="stylesheet" href="a.css"></link>')).toBeUndefined();
    expect(jsonLdUrl(html)).toBe(`${ROOT}patterns/a.html`);
  });

  it('answers no JSON-LD url for no block, a block that does not parse, or a url that is no string', () => {
    expect(jsonLdUrl('<p>no block</p>')).toBeUndefined();
    expect(jsonLdUrl('<script type="application/ld+json">{not json</script>')).toBeUndefined();
    expect(jsonLdUrl('<script type="application/ld+json">{"url":3}</script>')).toBeUndefined();
  });

  it('decodes a title and a sitemap address, and reads a page with no title or description as such', () => {
    const facts = seoFacts(seoPage({ route: '/a.html', title: 'Key-value &amp; cache stores', noindex: true }));
    expect(facts.title).toBe('Key-value & cache stores');
    expect(facts.noindex).toBe(true);
    const bare = seoFacts('<html><head></head></html>');
    expect(bare).toMatchObject({ title: '', description: null, canonical: undefined, noindex: false });
    expect(sitemapLocs('<urlset><url><loc>https://x.test/a?b=1&amp;c=2</loc></url></urlset>')).toEqual([
      'https://x.test/a?b=1&c=2',
    ]);
  });
});

describe('the search and preview gate', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => sb.cleanup());

  /** Write one page of the fixture site again, with some of its facts changed. */
  const rewrite = (p: Parameters<typeof seoPage>[0]): void => {
    sb.write(`site/dist${p.route}`, seoPage(p));
  };

  it('passes a site whose titles, descriptions, addresses, pictures and sitemap agree', async () => {
    seoSite(sb);
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toContain('[site-seo] 3 page(s)');
    expect(r.out).toContain('the sitemap lists the 2 indexable page(s)');
  });

  it('reads another built folder through --dist', async () => {
    seoSite(sb, 'out');
    expectPass(await sb.run(spec, ['--dist', 'out']));
  });

  it('names a title two pages share, and a page with no title', async () => {
    seoSite(sb);
    rewrite({ route: '/patterns/b.html', title: 'A pattern' });
    sb.write('site/dist/sitemap-0.xml', seoSitemap(['/index.html', '/patterns/a.html', '/patterns/b.html'].map(publishedUrl)));
    expectFail(await sb.run(spec), 'site/dist/patterns/a.html: shares its title "A pattern" with site/dist/patterns/b.html');
    rewrite({ route: '/patterns/b.html', title: '' });
    expectFail(await sb.run(spec), 'site/dist/patterns/b.html: has no <title>');
  });

  it('names a missing description and one too long for a result', async () => {
    seoSite(sb);
    rewrite({ route: '/patterns/a.html', title: 'A pattern', description: null });
    expectFail(await sb.run(spec), 'has no meta description');
    rewrite({ route: '/patterns/a.html', title: 'A pattern', description: 'x'.repeat(DESCRIPTION_MAX + 1) });
    expectFail(await sb.run(spec), `has a ${DESCRIPTION_MAX + 1}-character meta description, over ${DESCRIPTION_MAX}`);
  });

  it('names a canonical outside the root, an og:url or JSON-LD url that disagrees, and a missing canonical', async () => {
    seoSite(sb);
    const away = 'https://elsewhere.test/a.html';
    rewrite({ route: '/patterns/a.html', title: 'A pattern', canonical: away, ogUrl: away, ldUrl: away });
    expectFail(await sb.run(spec), 'outside the published root');
    rewrite({ route: '/patterns/a.html', title: 'A pattern', ogUrl: null, ldUrl: `${ROOT}patterns/x.html` });
    const r = await sb.run(spec);
    expectFail(r, 'has og:url (none), not its canonical');
    expect(r.output).toContain(`has JSON-LD url ${ROOT}patterns/x.html, not its canonical`);
    rewrite({ route: '/patterns/a.html', title: 'A pattern', canonical: null });
    expectFail(await sb.run(spec), 'site/dist/patterns/a.html: has no canonical link');
  });

  it('names a missing og:image, one outside the root, and one the build did not write', async () => {
    seoSite(sb);
    rewrite({ route: '/patterns/a.html', title: 'A pattern', ogImage: null });
    expectFail(await sb.run(spec), 'has no og:image');
    rewrite({ route: '/patterns/a.html', title: 'A pattern', ogImage: 'https://elsewhere.test/og.png' });
    expectFail(await sb.run(spec), 'has og:image https://elsewhere.test/og.png, outside the published root');
    rewrite({ route: '/patterns/a.html', title: 'A pattern', ogImage: `${ROOT}missing.png` });
    expectFail(await sb.run(spec), `has og:image ${ROOT}missing.png, a file the build did not write`);
  });

  it('names a sitemap that misses an indexable page or lists one that stays out of search, and a site with none', async () => {
    seoSite(sb);
    sb.write('site/dist/sitemap-0.xml', seoSitemap([publishedUrl('/index.html'), publishedUrl('/marks.html')]));
    const r = await sb.run(spec);
    expectFail(r, `does not list ${ROOT}patterns/a.html, an indexable page`);
    expect(r.output).toContain(`lists ${ROOT}marks.html, which is no indexable page's canonical address`);
    fs.rmSync(path.join(sb.dir, 'site/dist/sitemap-0.xml'));
    expectFail(await sb.run(spec), 'lists no sitemap file');
  });

  it('names a missing build, and is misused by an unknown flag', async () => {
    expectFail(await sb.run(spec), 'site/dist: is missing');
    expectMisuse(await sb.run(spec, ['--nope']));
  });
});
