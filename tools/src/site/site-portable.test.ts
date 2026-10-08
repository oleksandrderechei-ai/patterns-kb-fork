/**
 * The post-build pass. Every rule here exists because of something a browser
 * reading `file://` will not do, so each is tested against the exact markup
 * that breaks without it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parse } from 'parse5';

import { SCHEMA_DIR } from '../contract/contract.js';
import { pageFindings } from '../gates/check-site-absence.js';
import { Corpus } from '../kb/corpus.js';
import { graphOf, recordOf } from '../kb/record.js';
import { serialize } from '../lib/kb-record.js';
import { expectFail, expectMisuse, expectPass, makeSandbox, type Sandbox } from '../lib/sandbox.js';
import { spec as searchSpec } from './gen-search-index.js';
import { GLOSSARY_JSON, rawKbSite } from './site-fixtures.js';
import { readSchemas } from './site-records.js';
import {
  STARLIGHT_CHROME,
  type IndexEntry,
  type PageError,
  type RelationFact,
  manifestOrder,
  dataAttrs,
  dropEmptyStyles,
  focusScrollableCode,
  labelTaskCheckboxes,
  mergeNextSteps,
  externalizeInlineScripts,
  groupEnd,
  pruneOrphanChunks,
  outsideCode,
  portableUrl,
  copySources,
  markdownRoute,
  publicSitemap,
  publicUrls,
  readPage,
  rewriteLinks,
  shieldChrome,
  spec,
  stampRelations,
  wrapArticle,
  wrapScrollableTables,
} from './site-portable.js';
import type { Structure } from '../lib/site-routes.js';
import { PUBLIC_ROOT, publicRoot, toPublic } from './site-output.js';

describe('dropEmptyStyles', () => {
  it('drops a style attribute that declares nothing, keeps every one that does', () => {
    // The two shapes mermaid emits, on the elements it emits them on.
    expect(dropEmptyStyles('<rect style="" x="1" />')).toBe('<rect x="1" />');
    expect(dropEmptyStyles('<path style=";" d="M0 0" />')).toBe('<path d="M0 0" />');
    expect(dropEmptyStyles('<g style="  ;  " id="a"></g>')).toBe('<g id="a"></g>');

    const keeps = '<span style="--depth: 0;">x</span><div style="display: table;">y</div>';
    expect(dropEmptyStyles(keeps)).toBe(keeps);
  });

  it('leaves prose alone — it scans tags, not the whole page', () => {
    // A doc page is allowed to write about markup without losing its words.
    const prose = '<p>Never ship a bare style="" attribute.</p>';
    expect(dropEmptyStyles(prose)).toBe(prose);
  });

  it('does not reach into a script or style body', () => {
    const code = '<script>const a = \'style=""\';</script>';
    expect(dropEmptyStyles(code)).toBe(code);
  });

  it('is safe to run twice', () => {
    const once = dropEmptyStyles('<rect style="" x="1" />');
    expect(dropEmptyStyles(once)).toBe(once);
  });
});

describe('externalizeInlineScripts', () => {
  // As site/src/components/ThemeProvider emits it — the pre-paint assignment
  // with no window.StarlightThemeProvider around it, because this site's
  // override drops the icon template that was the object's only reason to
  // exist.
  const THEME =
    "\n  (() => {\n    const storedTheme = typeof localStorage !== 'undefined' && null;\n  })();\n";

  it('replaces a recognised classic with a root-absolute src, keeping attributes', () => {
    const html = `<script aria-hidden="true">${THEME}</script>`;
    const out = externalizeInlineScripts(html, (entry) => `${entry.file}.abc12345.js`);
    expect(out).toBe('<script aria-hidden="true" src="/_astro/sl-theme.abc12345.js"></script>');
  });

  it('touches nothing with a src, a type, or an unrecognised body', () => {
    // The JSON-LD is typed, external scripts already are files, and a snippet
    // no fingerprint knows is left inline for check-site-absence to report —
    // externalising code blind would hide the re-audit moment.
    const html =
      '<script type="application/ld+json">{ "@context": "https://schema.org" }</script>' +
      '<script src="/x.js"></script>' +
      '<script>alert(1);</script>';
    const calls: string[] = [];
    const out = externalizeInlineScripts(html, (entry) => {
      calls.push(entry.id);
      return 'never.js';
    });
    expect(out).toBe(html);
    expect(calls).toEqual([]);
  });
});

describe('shieldChrome', () => {
  const header = '<header class="header astro-x">h</header>';

  it('marks each landmark it finds, and says nothing about the ones it does not', () => {
    const out = shieldChrome(`${header}<main>content</main>`);
    expect(out).toContain('<header data-kb-skip class="header astro-x">');
    // No sidebar on this page, and that is a page shape, not a fault — the
    // splash and the 404 have none either.
    expect(out).not.toContain('<nav');
  });

  it('is safe to run twice — the attribute is added once', () => {
    const once = shieldChrome(header);
    expect(shieldChrome(once)).toBe(once);
  });

  it('matches on the landmark class, not on a class that merely contains it', () => {
    // The metadata dialog's own <header class="kb-meta-dialog-head"> is this
    // site's and is marked in the component; upstream's site header is the one
    // here.
    const out = shieldChrome('<header class="kb-meta-dialog-head">x</header>');
    expect(out).not.toContain('data-kb-skip');
  });

  it('names a reason for every landmark it shields', () => {
    for (const chrome of STARLIGHT_CHROME) {
      expect(chrome.why.length).toBeGreaterThan(20);
    }
  });
});

describe('portableUrl', () => {
  it('makes a root-absolute link relative to the page depth', () => {
    // `prefix` is the page's own way back to dist, and it is prepended as
    // written — a top-level page gets './', one a folder down gets '../'.
    expect(portableUrl('/guides/authoring/', './')).toBe('./guides/authoring.html');
    expect(portableUrl('/guides/authoring/', '../')).toBe('../guides/authoring.html');
  });

  it('puts .html back on an extensionless link', () => {
    // A browser reading from disk will not turn /guides/authoring/ into
    // .../index.html.
    expect(portableUrl('/guides/authoring', './')).toBe('./guides/authoring.html');
  });

  it('turns a bare directory URL into its index.html', () => {
    expect(portableUrl('/', './')).toBe('./index.html');
  });

  it('keeps a query and a fragment, in that order', () => {
    expect(portableUrl('/guides/x?a=1#b', './')).toBe('./guides/x.html?a=1#b');
  });

  it('leaves anything with a scheme, a fragment or a protocol-relative start', () => {
    for (const u of ['https://x/', 'mailto:a@b.c', '#anchor', '//cdn/x']) {
      expect(portableUrl(u, './')).toBe(u);
    }
  });

  it('leaves a name that already has an extension alone', () => {
    expect(portableUrl('/_astro/x.css', './')).toBe('./_astro/x.css');
  });

  it('leaves a query-only link, and keeps a fragment holding a line break', () => {
    expect(portableUrl('?q=1', './')).toBe('?q=1');
    expect(portableUrl('/a#x\ny', '../')).toBe('../a.html#x\ny');
  });
});

describe('outsideCode', () => {
  it('skips the contents of script and style, but not their opening tags', () => {
    // JavaScript that happens to contain the text `href=` is not a link;
    // `<script src="/_astro/…">` is exactly the reference that has to move.
    const html = '<a href="/a/">x</a><script src="/b.js">var s = \'href="/c/"\';</script>';
    const out = rewriteLinks(html, './');
    expect(out).toContain('href="./a.html"');
    expect(out).toContain('src="./b.js"');
    expect(out).toContain('\'href="/c/"\'');
  });

  it('rewrites only real link attributes: a code sample’s copy keeps its text, a bare or unquoted one is read whole', () => {
    const html = '<button hidden data-code="<a href=\'/x/\'>x</a>" title=\'t\' data-href="/kept/">c</button><img src=/i.png alt>';
    expect(rewriteLinks(html, '../')).toBe('<button hidden data-code="<a href=\'/x/\'>x</a>" title=\'t\' data-href="/kept/">c</button><img src=../i.png alt>');
    expect(rewriteLinks('<a href>bare</a><a href="#top">t</a>', '../')).toBe('<a href>bare</a><a href="#top">t</a>');
  });

  it('visits every chunk exactly once', () => {
    expect(outsideCode('a<script>b</script>c', (s) => s.toUpperCase())).toBe(
      'A<SCRIPT>b</script>C',
    );
  });
});

describe('rewriteLinks over a diagram', () => {
  it('makes a mermaid click link relative, in the markup rehype-mermaid writes for it', () => {
    // `click MD "/patterns/gof/behavioral/mediator.html"` in a fence on
    // hazards/god-object: the inline SVG carries the target as xlink:href on
    // an <a> inside the graphic, and from disk it must open like any link.
    const svg =
      '<svg id="mermaid-0"><g><a xlink:href="/patterns/gof/behavioral/mediator.html" data-look="classic" transform="translate(305, 35)">' +
      '<g class="node"><text>Mediator</text></g></a></g></svg>';
    const out = rewriteLinks(svg, '../');
    expect(out).toContain('<a xlink:href="../patterns/gof/behavioral/mediator.html" data-look="classic"');
    expect(out).not.toMatch(/href="\//);
    expect(rewriteLinks(out, '../')).toBe(out);
  });
});

describe('the published root', () => {
  const root = new URL('https://odere-pro.github.io/patterns-kb/');

  it('is the project path, and SITE_URL moves it, with or without its end slash', () => {
    expect(publicRoot({}).href).toBe(PUBLIC_ROOT);
    expect(publicRoot({ SITE_URL: 'https://kb.example/docs' }).href).toBe('https://kb.example/docs/');
    expect(publicRoot({ SITE_URL: '' }).href).toBe(PUBLIC_ROOT);
  });

  it('moves a URL on the origin under the root, once, and leaves every other URL alone', () => {
    expect(toPublic('https://odere-pro.github.io/patterns/a.html', root)).toBe('https://odere-pro.github.io/patterns-kb/patterns/a.html');
    expect(toPublic('https://odere-pro.github.io/patterns-kb/patterns/a.html', root)).toBe('https://odere-pro.github.io/patterns-kb/patterns/a.html');
    expect(toPublic('https://github.com/odere-pro/patterns-kb', root)).toBe('https://github.com/odere-pro/patterns-kb');
    expect(toPublic('https://odere-pro.github.io/', root)).toBe('https://odere-pro.github.io/patterns-kb/');
  });

  it('names the page where it is served: its canonical link and og:url, never another absolute link', () => {
    const head =
      '<link rel="canonical" href="https://odere-pro.github.io/patterns/a.html"/>' +
      '<meta property="og:url" content="https://odere-pro.github.io/patterns/a.html"/>' +
      '<meta property="og:site_name" content="https://odere-pro.github.io/x"/>' +
      '<a href="https://odere-pro.github.io/elsewhere.html">out</a>';
    const moved = publicUrls(head, root);
    expect(moved).toBe(
      '<link rel="canonical" href="https://odere-pro.github.io/patterns-kb/patterns/a.html"/>' +
        '<meta property="og:url" content="https://odere-pro.github.io/patterns-kb/patterns/a.html"/>' +
        '<meta property="og:site_name" content="https://odere-pro.github.io/x"/>' +
        '<a href="https://odere-pro.github.io/elsewhere.html">out</a>',
    );
    expect(publicUrls(moved, root)).toBe(moved);
  });

  it('moves every sitemap URL under the root as the file it names, the index’s pointer to its chunk included', () => {
    const xml =
      '<urlset><url><loc>https://odere-pro.github.io/</loc></url><url><loc>https://odere-pro.github.io/hazards.html</loc></url>' +
      '<url><loc>https://odere-pro.github.io/capabilities/compute</loc></url><url><loc>https://elsewhere.test/x</loc></url></urlset>';
    const moved = publicSitemap(xml, root);
    expect(moved).toBe(
      '<urlset><url><loc>https://odere-pro.github.io/patterns-kb/</loc></url><url><loc>https://odere-pro.github.io/patterns-kb/hazards.html</loc></url>' +
        '<url><loc>https://odere-pro.github.io/patterns-kb/capabilities/compute.html</loc></url><url><loc>https://elsewhere.test/x</loc></url></urlset>',
    );
    expect(publicSitemap(moved, root)).toBe(moved);
    expect(publicSitemap('<sitemap><loc>https://odere-pro.github.io/sitemap-0.xml</loc></sitemap>', root)).toContain(
      'https://odere-pro.github.io/patterns-kb/sitemap-0.xml',
    );
  });
});

describe('groupEnd', () => {
  const at = (html: string): number => groupEnd(html, 0, html.length);

  it('ends after the last list when prose follows it, and nowhere else', () => {
    const html = '<ul><li>a</li></ul><p>note</p>';
    expect(at(html)).toBe('<ul><li>a</li></ul>'.length);
    expect(at('<ul><li>a</li></ul>\n<!-- relationships:end -->\n')).toBe('<ul><li>a</li></ul>\n<!-- relationships:end -->\n'.length);
    expect(at('<p>no list</p>')).toBe('<p>no list</p>'.length);
    // A list inside another element is not the group's own.
    expect(at('<div><ul><li>a</li></ul></div><p>x</p>')).toBe('<div><ul><li>a</li></ul></div><p>x</p>'.length);
    // The heading wrapper's own close, met first, opens nothing.
    expect(at('</div><ol><li>a<br></li></ol><p>x</p>')).toBe('</div><ol><li>a<br></li></ol>'.length);
  });
});

describe('dataAttrs', () => {
  it('turns a meta comment spec into data- attributes, lowercased', () => {
    expect(dataAttrs('topic=portability note=deeper')).toEqual([
      'data-topic="portability"',
      'data-note="deeper"',
    ]);
  });

  it('does not double the data- prefix', () => {
    expect(dataAttrs('data-topic=x')).toEqual(['data-topic="x"']);
  });

  it('escapes a value that would break the attribute', () => {
    expect(dataAttrs('t="a & \'b\'"')).toEqual(['data-t="a &amp; \'b\'"']);
  });

  it('reads a single-quoted value too', () => {
    expect(dataAttrs("t='a \"b\"'")).toEqual(['data-t="a &quot;b&quot;"']);
  });
});

describe('wrapArticle', () => {
  const region = (inner: string): string => `<main><div class="sl-markdown-content" data-kb-region>${inner}</div></main>`;
  const facts = { area: 'caching', tags: 'a,b', place: null };
  const place = { kind: 'pattern', band: 'distributed', group: 'distributed-resilience' };

  it('wraps the region in an article carrying the route, the area and the tags, and nothing else on a page outside the knowledge base', () => {
    const errors: PageError[] = [];
    expect(wrapArticle(region('<p>x</p>'), '/a/b.html', facts, errors)).toBe(
      '<main><div class="sl-markdown-content" data-kb-region><article data-page="/a/b.html" data-area="caching" data-tags="a,b"><p>x</p></article></div></main>',
    );
    expect(errors).toEqual([]);
  });

  it('adds the kind, the band and the group after those three on a page of the knowledge base, each escaped like the rest', () => {
    const html = wrapArticle(region('<p>x</p>'), '/a/b.html', { ...facts, place: { kind: 'pattern', band: 'a"b', group: 'g&h' } }, []);
    expect(html).toContain(
      '<article data-page="/a/b.html" data-area="caching" data-tags="a,b" data-kind="pattern" data-band="a&quot;b" data-group="g&amp;h"><p>x</p></article>',
    );
  });

  it('replaces the block an earlier run wrote, so a second wrap changes nothing and a page that lost its place loses the three facts', () => {
    const once = wrapArticle(region('<p>x</p>'), '/a/b.html', { ...facts, place }, []);
    expect(wrapArticle(once, '/a/b.html', { ...facts, place }, [])).toBe(once);
    expect(wrapArticle(once, '/a/b.html', facts, [])).toBe(wrapArticle(region('<p>x</p>'), '/a/b.html', facts, []));
  });

  it('names a page with no knowledge region and returns it as it came', () => {
    const errors: PageError[] = [];
    const bare = '<main><p>x</p></main>';
    expect(wrapArticle(bare, '/a/b.html', facts, errors)).toBe(bare);
    expect(errors).toEqual([{ route: '/a/b.html', what: 'no knowledge region: no one element carries data-kb-region to wrap in the article block' }]);
  });
});

describe('stampRelations', () => {
  const ROUTE = '/patterns/a/page.html';
  const rel = (verb: string, to: string): RelationFact => ({ verb, to, route: `/patterns/b/${to}.html` });
  const link = (to: string): string => `<a href="../b/${to}.html">${to}</a>`;
  /** A page whose relationships section holds `list`, with a list of its own before the section and one after it. */
  const page = (list: string): string =>
    '<p>Intro.</p><ul><li><a href="../b/outside.html">Before</a></li></ul>' +
    '<section data-block="relationships"><div class="sl-heading-wrapper level-h2"><h2 id="relationships">How it relates</h2></div>' +
    `<p id="relationships-p-1"><strong>Combines with</strong></p>${list}</section>` +
    '<section data-block="next"><ul><li><a href="../b/outside.html">After</a></li></ul></section>';
  const RELATIONS = [rel('combines-with', 'one'), rel('prevents-hazard', 'two')];
  const LIST = `<ul><li>${link('one')} — first</li><li>${link('two')}</li></ul>`;

  it('stamps the n-th item with the verb and the target page of the n-th relation, and touches nothing outside the section', () => {
    const refusals: PageError[] = [];
    expect(stampRelations(page(LIST), ROUTE, RELATIONS, refusals)).toBe(
      page(
        `<ul><li data-verb="combines-with" data-to="one">${link('one')} — first</li>` +
          `<li data-verb="prevents-hazard" data-to="two">${link('two')}</li></ul>`,
      ),
    );
    expect(refusals).toEqual([]);
  });

  it('keeps an item’s own attributes, replaces a stamp an earlier run wrote whatever its quoting, and leaves a name that only starts like one', () => {
    const list = `<ul><li id="r1" data-verb="old" data-total="9">${link('one')}</li><li data-to='old' data-verb=old >${link('two')}</li></ul>`;
    expect(stampRelations(page(list), ROUTE, RELATIONS, [])).toBe(
      page(
        `<ul><li id="r1" data-total="9" data-verb="combines-with" data-to="one">${link('one')}</li>` +
          `<li data-verb="prevents-hazard" data-to="two">${link('two')}</li></ul>`,
      ),
    );
  });

  it('changes nothing a second time', () => {
    const once = stampRelations(page(LIST), ROUTE, RELATIONS, []);
    expect(stampRelations(once, ROUTE, RELATIONS, [])).toBe(once);
  });

  it('reads a link’s target as the page now links it: its folder, with a query or a fragment cut off', () => {
    const list = `<ul><li><a href="../b/one.html#why">one</a></li><li><a href="../b/./two.html?x=1">two</a></li></ul>`;
    const refusals: PageError[] = [];
    expect(stampRelations(page(list), ROUTE, RELATIONS, refusals)).toContain('<li data-verb="prevents-hazard" data-to="two">');
    expect(refusals).toEqual([]);
  });

  it('leaves a page with no relationships section and no relations as it was, and refuses one that has relations', () => {
    const none = '<p>Intro.</p><ul><li><a href="../b/outside.html">Before</a></li></ul>';
    const refusals: PageError[] = [];
    expect(stampRelations(none, ROUTE, [], refusals)).toBe(none);
    expect(refusals).toEqual([]);
    expect(stampRelations(none, ROUTE, RELATIONS, refusals)).toBe(none);
    expect(refusals.map((r) => r.what)).toEqual([
      'its relationships block lists 0 item(s) and its record holds 2 relation(s) — the block is stale: run make gen, then make site-build',
    ]);
  });

  it('refuses a block with fewer or more items than the record has relations, and returns the page as it came', () => {
    const cases: [string, string][] = [
      [`<ul><li>${link('one')}</li></ul>`, 'lists 1 item(s) and its record holds 2'],
      [`<ul><li>${link('one')}</li><li>${link('two')}</li><li>${link('three')}</li></ul>`, 'lists 3 item(s) and its record holds 2'],
    ];
    for (const [list, said] of cases) {
      const refusals: PageError[] = [];
      const html = page(list);
      expect(stampRelations(html, ROUTE, RELATIONS, refusals), said).toBe(html);
      expect(refusals, said).toEqual([
        { route: ROUTE, what: `its relationships block ${said} relation(s) — the block is stale: run make gen, then make site-build` },
      ]);
    }
  });

  it('refuses an item whose first link opens another page than its relation’s, or no page, naming the first such item only', () => {
    const swapped = page(`<ul><li>${link('one')}</li><li>${link('three')}</li></ul>`);
    const refusals: PageError[] = [];
    expect(stampRelations(swapped, ROUTE, RELATIONS, refusals)).toBe(swapped);
    expect(refusals).toEqual([
      {
        route: ROUTE,
        what:
          'item 2 of its relationships block opens /patterns/b/three.html, and relation 2 of its record, prevents-hazard two, is for /patterns/b/two.html — ' +
          'the block and the record disagree: run make gen, then make site-build',
      },
    ]);

    const bare = page('<ul><li>one, without a link</li><li>two</li></ul>');
    const none: PageError[] = [];
    expect(stampRelations(bare, ROUTE, RELATIONS, none)).toBe(bare);
    expect(none.map((r) => r.what)).toEqual([
      'item 1 of its relationships block opens no page, and relation 1 of its record, combines-with one, is for /patterns/b/one.html — ' +
        'the block and the record disagree: run make gen, then make site-build',
    ]);
  });

  it('reads the first link of an item, and no link of its note', () => {
    const list = `<ul><li>${link('one')} — see ${link('two')}</li><li>${link('two')} — see ${link('one')}</li></ul>`;
    const refusals: PageError[] = [];
    expect(stampRelations(page(list), ROUTE, RELATIONS, refusals)).toContain('data-to="two">');
    expect(refusals).toEqual([]);
  });
});

describe('readPage, the place of a page of the knowledge base', () => {
  const head = (metas: string): string =>
    `<!doctype html><html><head><meta name="kb:area" content="a"><meta name="kb:owner" content="o">${metas}</head><body><div data-kb-region><p>x</p></div></body></html>`;
  const KIND = '<meta name="kb:kind" content="pattern">';
  const BAND = '<meta name="kb:band" content="distributed">';
  const GROUP = '<meta name="kb:group" content="distributed-resilience">';
  const read = (metas: string, found: string[] = []): ReturnType<typeof readPage> =>
    readPage('/dist/a.html', '/a.html', head(metas), (what) => found.push(what));

  it('reads the three facts a head states together, and none on a page that states none', () => {
    expect(read(KIND + BAND + GROUP)?.place).toEqual({ kind: 'pattern', band: 'distributed', group: 'distributed-resilience' });
    expect(read('')?.place).toBeNull();
  });

  it('refuses a head that states some of the three, or states one empty, naming the ones it lacks', () => {
    const cases: [string, string][] = [
      [KIND + BAND, 'kb:group'],
      [BAND, 'kb:kind, kb:group'],
      [KIND + BAND + '<meta name="kb:group" content="">', 'kb:group'],
    ];
    for (const [metas, lacks] of cases) {
      const found: string[] = [];
      expect(read(metas, found), lacks).toBeNull();
      expect(found, lacks).toEqual([
        `the head states part of a place, without ${lacks} — a page of the knowledge base states kb:kind, kb:band, kb:group together and any other page none; site/src/components/Head/Head.astro emits them`,
      ]);
    }
  });
});

describe('the pass end to end', () => {
  let sb: Sandbox;

  const META = [
    '<meta name="kb:area" content="guides">',
    '<meta name="kb:owner" content="Tests">',
    '<meta name="description" content="A page.">',
  ].join('');

  const page = (body: string, head = ''): string =>
    `<!doctype html><html><head><title>A page</title>${META}${head}</head><body>${body}</body></html>\n`;

  const withRegion = (inner: string, head = ''): string =>
    page(`<div class="sl-markdown-content" data-kb-region>${inner}</div>`, head);

  beforeEach(() => {
    sb = makeSandbox();
    sb.write('docs/data/site-structure.json', JSON.stringify({ areas: [{ id: 'start', pages: [] }, { id: 'guides', pages: [] }] }));
  });
  afterEach(() => sb.cleanup());

  it('rewrites links, writes the manifest, and says what it did', async () => {
    sb.write(
      'site/dist/index.html',
      withRegion('<a href="/guides/one/">g</a><h2 id="a">A</h2><p>Text.</p>'),
    );
    sb.write('site/dist/guides/one.html', withRegion('<a href="/">home</a>'));

    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toContain('2 page(s) made portable');

    expect(sb.read('site/dist/index.html')).toContain('href="./guides/one.html"');
    // A page one level down has to climb back out.
    expect(sb.read('site/dist/guides/one.html')).toContain('href="../index.html"');

    expect(sb.exists('site/dist/index.json')).toBe(true);
    // This tree has no content model, so it holds no knowledge base and no file of the contract is written.
    for (const file of ['llms.txt', 'llms-full.txt', 'graph.json', 'schema']) expect(sb.exists(`site/dist/${file}`), file).toBe(false);
    expect(r.out).not.toContain('record(s)');
  });

  it('reduces 404.html to a page that links no file of the site, with absolute links under the root, and leaves every other page alone', async () => {
    const chrome =
      '<link rel="stylesheet" href="/_astro/style.css"><script src="/kb.js" defer data-kb="bundle"></script><link rel="shortcut icon" href="/favicon.svg">';
    const notFound = (title: string): string =>
      page(
        `<header>Chrome</header><main><div data-page-head><h1>${title}</h1></div>` +
          '<div class="sl-markdown-content" data-kb-region><p>Gone. <a href="/index.html">Home</a>.</p></div></main>',
        chrome,
      );
    sb.write('site/dist/404.html', notFound('Page not found'));
    sb.write('site/dist/guides/one.html', notFound('One'));

    const r = await sb.run(spec);
    expectPass(r);
    const lost = sb.read('site/dist/404.html');
    expect(lost).not.toMatch(/<link\b[^>]*stylesheet|<script\b[^>]*\bsrc=|favicon|<header/);
    expect(lost).toContain('<style>');
    expect(lost).toContain(`href="${publicRoot().href}index.html"`);
    expect(lost).toContain('<article data-page="/404.html" data-area="guides"');
    // A page that is not the 404 keeps its chrome and gets depth-relative links.
    const other = sb.read('site/dist/guides/one.html');
    expect(other).toContain('<header>Chrome</header>');
    expect(other).toContain('href="../_astro/style.css"');
    expect(other).not.toContain('<style>');
    // The manifest still lists it, with its title.
    expect(sb.read('site/dist/index.json')).toContain('"route": "/404.html"');

    const once = sb.snapshot();
    expectPass(await sb.run(spec));
    expect(sb.snapshot()).toEqual(once);
  });

  it('refuses a 404.html with no title block, naming the page', async () => {
    sb.write('site/dist/404.html', withRegion('<p>Gone.</p>'));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toContain('404.html');
    expect(r.err).toContain('title block');
  });

  it('moves the canonical link and the sitemap under the published root, and a second run changes nothing', async () => {
    const origin = publicRoot().origin;
    sb.write('site/dist/index.html', withRegion('<p>Home.</p>', `<link rel="canonical" href="${origin}/index.html"/>`));
    sb.write('site/dist/sitemap-0.xml', `<urlset><url><loc>${origin}/</loc></url></urlset>`);
    sb.write('site/dist/robots.xml.txt', `${origin}/`);
    expectPass(await sb.run(spec));
    expect(sb.read('site/dist/index.html')).toContain(`<link rel="canonical" href="${publicRoot().href}index.html"/>`);
    expect(sb.read('site/dist/sitemap-0.xml')).toBe(`<urlset><url><loc>${publicRoot().href}</loc></url></urlset>`);
    expect(sb.read('site/dist/robots.xml.txt')).toBe(`${origin}/`);
    const once = sb.snapshot();
    expectPass(await sb.run(spec));
    expect(sb.snapshot()).toEqual(once);
  });

  it('fills the index with what each page actually says, not just that it exists', async () => {
    // The file exists even when its content is garbage; downstream readers
    // care about the content. Title comes from the JSON-LD headline,
    // tags split into a list, and the headings carry their anchor ids.
    const head =
      '<meta name="kb:tags" content="alpha,beta">' +
      '<meta name="kb:alias" content="FP"><meta name="kb:alias" content="">' +
      '<meta name="kb:solves" content="one slow call, then &quot;all&quot; of them"><meta name="kb:solves" content="retries pile up">' +
      '<script type="application/ld+json" data-kb="page">{"headline":"Fixture page"}</script>';
    sb.write('site/dist/index.html', withRegion('<h2 id="top">Top</h2><p>Text.</p>', head));
    sb.write('site/dist/guides/one.html', withRegion('<h2 id="rules">Rules</h2><p>Text.</p>'));

    expectPass(await sb.run(spec));

    const index = JSON.parse(sb.read('site/dist/index.json')) as {
      pages: {
        route: string;
        title: string;
        area: string;
        status: string;
        tags: string[];
        headings: { id: string }[];
      }[];
    };
    expect(index.pages).toHaveLength(2);
    expect(index.pages.map((p) => p.route)).toEqual(['/index.html', '/guides/one.html']);
    // Home sorts first, so pages[0] is the one with the richer head.
    expect(index.pages[0]?.title).toBe('Fixture page');
    expect(index.pages[0]).toMatchObject({ area: 'guides', status: 'stable', owner: 'Tests' });
    expect(index.pages[0]?.tags).toEqual(['alpha', 'beta']);
    // One element per value, in order, decoded, the empty one dropped; a page
    // stating none has empty lists.
    expect(index.pages[0]).toMatchObject({ aliases: ['FP'], solves: ['one slow call, then "all" of them', 'retries pile up'] });
    expect(index.pages[1]).toMatchObject({ aliases: [], solves: [] });
    expect(index.pages[0]?.headings[0]?.id).toBe('top');

    // The reader-facing tags land on the article data block with the audience.
    expect(sb.read('site/dist/index.html')).toContain('data-tags="alpha,beta"');
  });

  it('externalises the inline classics into one shared chunk, idempotently', async () => {
    const snippet =
      '<script aria-hidden="true">(() => { const storedTheme = typeof localStorage !== \'undefined\' && localStorage.getItem(\'starlight-theme\'); })();</script>';
    sb.write('site/dist/index.html', withRegion('<p>Text.</p>', snippet));
    sb.write('site/dist/guides/one.html', withRegion('<p>Text.</p>', snippet));

    expectPass(await sb.run(spec));

    const home = sb.read('site/dist/index.html');
    const deep = sb.read('site/dist/guides/one.html');
    expect(home).not.toContain('storedTheme');
    // One shared file, depth-relative from each page like every other asset.
    const src =
      /<script aria-hidden="true" src="\.\/(_astro\/sl-theme\.[0-9a-f]{8}\.js)"><\/script>/.exec(
        home,
      );
    expect(src).not.toBeNull();
    expect(deep).toContain(`src="../${src?.[1] as string}"`);
    expect(sb.read(`site/dist/${src?.[1] as string}`)).toContain('storedTheme');

    // Safe to run twice: the tag now has a src, so nothing changes.
    await sb.run(spec);
    expect(sb.read('site/dist/index.html')).toBe(home);
  });

  it('wraps the article in the page data block, and is safe to run twice', async () => {
    sb.write('site/dist/index.html', withRegion('<p>Text.</p>'));
    await sb.run(spec);
    const once = sb.read('site/dist/index.html');
    // The block carries only bare data-* facts — no class — and sits directly
    // inside the classed (decoration) markdown wrapper.
    expect(once).toContain(
      '<div class="sl-markdown-content" data-kb-region>' +
        '<article data-page="/index.html" data-area="guides" data-tags="">' +
        '<p>Text.</p></article></div>',
    );
    // <body> is decoration and carries no facts.
    expect(once).toContain('<body>');
    await sb.run(spec);
    expect(sb.read('site/dist/index.html')).toBe(once);
  });

  it('scrubs the body stamp a previous version wrote', async () => {
    sb.write(
      'site/dist/index.html',
      withRegion('<p>Text.</p>').replace(
        '<body>',
        '<body data-area="x" data-tags data-page="/x.html">',
      ),
    );
    await sb.run(spec);
    expect(sb.read('site/dist/index.html')).toContain('<body>');
  });

  it('wraps a meta section inside the article block, never interleaved with it', async () => {
    // A <!--meta--> section can close exactly at the region end; the article
    // wrapper runs after sectionMeta so the section nests inside it.
    sb.write(
      'site/dist/index.html',
      withRegion('<h2 id="t">T</h2><!--meta topic=portability--><p>Text.</p>'),
    );
    await sb.run(spec);
    const html = sb.read('site/dist/index.html');
    expect(html).toContain('<section data-topic="portability">');
    expect(html).toContain('</section></article></div>');
  });

  it('closes a sided block’s last group after its list, so a trailing note stands after both columns (dialect X-06)', async () => {
    const usage =
      '<h2 id="usage">When</h2><!--meta block=usage-->' +
      '<div class="sl-heading-wrapper level-h3"><h3 id="use-when">Use when</h3></div><!--meta polarity=use--><ul><li>a</li></ul>' +
      '<div class="sl-heading-wrapper level-h3"><h3 id="avoid-when">Avoid when</h3></div><!--meta polarity=avoid--><ul><li>b <ul><li>c</li></ul></li></ul>\n' +
      '<p>Prevents the smell of a whole system frozen.</p>' +
      '<h2 id="next">Next</h2><p>After.</p>';
    sb.write('site/dist/index.html', withRegion(usage));
    await sb.run(spec);
    const html = sb.read('site/dist/index.html');
    expect(html).toContain('<ul><li>b <ul><li>c</li></ul></li></ul></section>\n<p>Prevents the smell of a whole system frozen.</p></section>');
    // The first group was followed by a heading, not prose: it ends where it did.
    expect(html).toContain('<ul><li>a</li></ul></section><section data-polarity="avoid">');
    const once = sb.read('site/dist/index.html');
    await sb.run(spec);
    expect(sb.read('site/dist/index.html')).toBe(once);
  });

  it('wraps a meta comment into a section carrying its data attributes', async () => {
    sb.write(
      'site/dist/index.html',
      withRegion('<h2 id="t">T</h2><!--meta topic=portability--><p>Text.</p>'),
    );
    await sb.run(spec);
    const html = sb.read('site/dist/index.html');
    expect(html).toContain('<section data-topic="portability">');
    expect(html).not.toContain('<!--meta');
  });

  it('opens the section outside the heading wrapper, and closes it before the next one', async () => {
    // Starlight wraps each heading with its anchor link in a div. A boundary
    // sliced between the div and the h2 leaves the div opened in one section
    // and closed in the next — malformed nesting a browser will "fix" into
    // something nobody meant.
    sb.write(
      'site/dist/index.html',
      withRegion(
        '<div class="sl-heading-wrapper level-h2"><h2 id="one">One</h2></div>' +
          '<!--meta topic=portability note=deeper-->' +
          '<p>body of one</p>' +
          '<div class="sl-heading-wrapper level-h2"><h2 id="two">Two</h2></div>' +
          '<p>body of two</p>',
      ),
    );
    expectPass(await sb.run(spec));
    const html = sb.read('site/dist/index.html');
    expect(html).toContain(
      '<section data-topic="portability" data-note="deeper"><div class="sl-heading-wrapper level-h2"><h2 id="one">',
    );
    expect(html).toContain('</section><div class="sl-heading-wrapper level-h2"><h2 id="two">');
    expect(html.match(/<\/section>/g)).toHaveLength(1);
  });

  it('ignores a meta comment sitting inside an attribute value', async () => {
    // expressive-code's copy button carries the raw code in data-code="…", so
    // a sample DEMONSTRATING the comment puts a literal one inside an
    // attribute. Matching it wrapped a spurious section and stripped the
    // comment out of the copy-to-clipboard payload.
    sb.write(
      'site/dist/index.html',
      withRegion(
        '<h2 id="t">T</h2><div data-code="&lt;!--meta topic=x--&gt;"></div><pre data-code="## T\n<!--meta topic=x-->"></pre>',
      ),
    );
    await sb.run(spec);
    const html = sb.read('site/dist/index.html');
    expect(html).not.toContain('<section data-topic=');
    expect(html).toContain('data-code="## T\n<!--meta topic=x-->"');
  });

  it('fails a page missing required metadata, and writes nothing', async () => {
    // Pass one verifies everything before pass two writes: a half-transformed
    // dist is worse than none.
    const before = '<html><body><a href="/x/">x</a></body></html>\n';
    sb.write('site/dist/index.html', before);
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toContain('missing page facts: kb:area, kb:owner');
    expect(sb.read('site/dist/index.html')).toBe(before);
    expect(sb.exists('site/dist/index.json')).toBe(false);
  });

  it('reports a meta comment with no heading above it', async () => {
    sb.write('site/dist/index.html', withRegion('<!--meta topic=x--><p>Text.</p>'));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toContain('site/dist/index.html: a <!--meta--> section fact with no heading above it');
  });

  it('prints nothing on success with --quiet', async () => {
    sb.write('site/dist/index.html', withRegion('<p>Text.</p>'));
    const r = await sb.run(spec, ['--quiet']);
    expectPass(r);
    expect(r.out).toBe('');
  });

  it('fails a dist that is not there, and rejects an unknown flag', async () => {
    expectFail(await sb.run(spec));
    expectMisuse(await sb.run(spec, ['--fix']));
  });
});

/** The parse5 node shape the scenarios read. */
interface El {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: El[];
}

const elementKids = (el: El): El[] => (el.childNodes ?? []).filter((c) => c.tagName !== undefined);

/** The first element, depth first, that `pick` accepts. */
function find(el: El, pick: (e: El) => boolean): El | undefined {
  if (pick(el)) return el;
  for (const c of elementKids(el)) {
    const hit = find(c, pick);
    if (hit) return hit;
  }
  return undefined;
}

const hasAttr = (name: string) => (e: El): boolean => (e.attrs ?? []).some((a) => a.name === name);

/** Every element under `el` with this tag, in document order. */
const within = (el: El, tag: string): El[] => elementKids(el).flatMap((c) => [...(c.tagName === tag ? [c] : []), ...within(c, tag)]);

describe('blocks-O1', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
    sb.write('docs/data/site-structure.json', JSON.stringify({ areas: [{ id: 'caching', pages: [] }] }));
    sb.write('docs/data/glossary.json', GLOSSARY_JSON);
  });
  afterEach(() => sb.cleanup());

  it('blocks-O1: a stale body fact, a heading, a section fact, a paragraph and a second heading — one class-free article with the four facts holding one section that closes before the second heading; a second run changes no byte', async () => {
    const heading = (id: string, text: string): string =>
      `<div class="sl-heading-wrapper level-h2"><h2 id="${id}">${text}</h2><a class="sl-anchor-link" href="#${id}">#</a></div>`;
    sb.write(
      'site/dist/patterns/caching/alpha.html',
      '<!doctype html><html><head>' +
        '<meta name="kb:area" content="caching">' +
        '<meta name="kb:owner" content="Tests"><meta name="kb:tags" content="caching,performance">' +
        '<meta name="description" content="What Alpha does">' +
        '<script type="application/ld+json">{"headline":"Alpha"}</script></head>' +
        '<body class="frame" data-area="stale"><main><div class="sl-markdown-content" data-kb-region>' +
        `${heading('what-it-is', 'What it is')}\n<!--meta block=description-->\n<p>Alpha keeps answers.</p>\n` +
        `${heading('how-it-works', 'How it works')}\n<p>It works.</p>\n` +
        '</div></main></body></html>\n',
    );

    expectPass(await sb.run(spec));
    expectPass(await sb.run(searchSpec));
    const html = sb.read('site/dist/patterns/caching/alpha.html');

    const doc = parse(html) as unknown as El;
    const body = find(doc, (e) => e.tagName === 'body') as El;
    // The stale copy on <body> is gone: the body never carries a page fact.
    expect((body.attrs ?? []).map((a) => a.name)).toEqual(['class']);
    const region = find(doc, hasAttr('data-kb-region')) as El;
    const kids = elementKids(region);
    expect(kids).toHaveLength(1);
    const article = kids[0] as El;
    expect(article.tagName).toBe('article');
    expect(article.attrs).toEqual([
      { name: 'data-page', value: '/patterns/caching/alpha.html' },
      { name: 'data-area', value: 'caching' },
      { name: 'data-tags', value: 'caching,performance' },
    ]);
    // One section data block, class-free, holding the first heading and its
    // paragraph and closing before the second heading.
    expect(html.match(/<section data-/g)).toHaveLength(1);
    const section = find(article, (e) => e.tagName === 'section') as El;
    expect(section.attrs).toEqual([{ name: 'data-block', value: 'description' }]);
    expect(find(section, (e) => (e.attrs ?? []).some((a) => a.name === 'id' && a.value === 'what-it-is'))).toBeDefined();
    expect(find(section, (e) => (e.attrs ?? []).some((a) => a.name === 'id' && a.value === 'how-it-works'))).toBeUndefined();
    expect(html.indexOf('</section>')).toBeLessThan(html.indexOf('id="how-it-works"'));
    expect(html).toContain('<p>Alpha keeps answers.</p>');
    expect(html).not.toContain('<!--meta');

    // A second run of the passes over their own output changes no byte.
    const before = sb.snapshot();
    expectPass(await sb.run(spec));
    expectPass(await sb.run(searchSpec));
    expect(sb.snapshot()).toEqual(before);
  });
});

describe('manifest-O1', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
    sb.write('docs/data/site-structure.json', JSON.stringify({ areas: [{ id: 'guides', pages: [] }, { id: 'patterns', pages: [] }] }));
  });
  afterEach(() => sb.cleanup());

  const built = (route: string, area: string, head: string, region: string): void => {
    sb.write(
      `site/dist${route}`,
      '<!doctype html><html><head><title>From the title element</title>' +
        `<meta name="kb:area" content="${area}"><meta name="kb:owner" content="Tests">` +
        `<meta name="description" content="About ${route}">${head}</head>` +
        `<body><div class="sl-markdown-content" data-kb-region>${region}</div></body></html>\n`,
    );
  };

  it('manifest-O1: a site with no manifest — one JSON file at its root holding a generator and a page list, home first, titled by its headline, headed by the H2 and the id-less H3, never the deeper', async () => {
    built(
      '/index.html',
      'patterns',
      '<script type="application/ld+json">{"headline":"The home headline"}</script>',
      '<h2 id="start">Start here</h2><p>Home words.</p><h3>No id <code>here</code></h3><h5 id="deep">Too deep</h5>',
    );
    // The first area's page: sorting by area alone would put it before home.
    built('/guides/one.html', 'guides', '', '<h2 id="rules">Rules</h2>');
    expect(sb.exists('site/dist/index.json')).toBe(false);

    expectPass(await sb.run(spec));

    expect([...sb.snapshot().keys()].filter((f) => /^site\/dist\/[^/]+\.json$/.test(f))).toEqual(['site/dist/index.json']);
    const manifest = JSON.parse(sb.read('site/dist/index.json')) as Record<string, unknown>;
    // The schema and the contract first, as in every document of the contract.
    expect(Object.keys(manifest)).toEqual(['$schema', 'contract', 'generator', 'pages']);
    expect(manifest).toMatchObject({ $schema: 'https://odere-pro.github.io/patterns-kb/schema/kb-index-1.json', contract: 'kb-index/1' });
    const pages = manifest['pages'] as { route: string; title: string; headings: { id: string; text: string }[] }[];
    expect(pages.map((p) => p.route)).toEqual(['/index.html', '/guides/one.html']);
    // Every entry has the five knowledge-base fields, null here: this tree holds no knowledge base.
    for (const p of pages) {
      expect(Object.keys(p)).toEqual(['route', 'title', 'description', 'area', 'owner', 'status', 'tags', 'aliases', 'solves', 'id', 'kind', 'band', 'group', 'record', 'headings']);
      expect(p).toMatchObject({ id: null, kind: null, band: null, group: null, record: null });
    }
    expect(pages[0]?.title).toBe('The home headline');
    expect(pages[0]?.headings.map((h) => ({ id: h.id, text: h.text }))).toEqual([
      { id: 'start', text: 'Start here' },
      { id: '', text: 'No id here' },
    ]);
    expect(pages[1]?.title).toBe('From the title element');
    // No page text in it: the words under the headings stay in the page.
    expect(sb.read('site/dist/index.json')).not.toContain('Home words');
    expect(sb.read('site/dist/index.json')).not.toContain('Too deep');

    // A second run over the same built site writes the same bytes (manifest-C8).
    const once = sb.read('site/dist/index.json');
    expectPass(await sb.run(spec));
    expect(sb.read('site/dist/index.json')).toBe(once);
  });
});

describe('the pass — the edges', () => {
  let sb: Sandbox;
  const META =
    '<meta name="kb:area" content="nowhere"><meta name="kb:owner" content="Tests">';
  const page = (body: string, head = ''): string =>
    `<!doctype html><html><head>${META}${head}</head><body>${body}</body></html>\n`;
  const region = (inner: string, head = ''): string => page(`<div class="sl-markdown-content" data-kb-region>${inner}</div>`, head);

  beforeEach(() => {
    sb = makeSandbox();
    sb.write('docs/data/site-structure.json', JSON.stringify({ areas: [{ id: 'guides', pages: [] }] }));
  });
  afterEach(() => sb.cleanup());

  it('reads a title-less, description-less page as empty strings, an unknown area last', async () => {
    sb.write('site/dist/a.html', region('<h2>Unnamed</h2><h3 id="x">X</h3><h4 id="empty"></h4><h5 id="deep">Deep</h5>'));
    sb.write(
      'site/dist/b.html',
      region('<p>Text.</p>', '<title>From the title</title><script type="application/ld+json" data-kb="page">{"name":"n"}</script>').replace(
        'nowhere',
        'guides',
      ),
    );
    expectPass(await sb.run(spec));
    const index = JSON.parse(sb.read('site/dist/index.json')) as {
      pages: { route: string; title: string; description: string; headings: { depth: number; id: string; text: string }[] }[];
    };
    expect(index.pages.map((p) => p.route)).toEqual(['/b.html', '/a.html']);
    expect(index.pages[0]?.title).toBe('From the title');
    expect(index.pages[1]).toMatchObject({ title: '', description: '' });
    // H2 to H4, an unidentified one with an empty id, never deeper.
    expect(index.pages[1]?.headings).toEqual([
      { depth: 2, id: '', text: 'Unnamed' },
      { depth: 3, id: 'x', text: 'X' },
    ]);
  });

  it('fails a page whose JSON-LD is not JSON, and a page with no knowledge region', async () => {
    sb.write('site/dist/a.html', region('<p>Text.</p>', '<script type="application/ld+json" data-kb="page">{nope</script>'));
    sb.write('site/dist/b.html', page('<p>No region.</p>'));
    const r = await sb.run(spec);
    expectFail(r, '/a.html: the JSON-LD block is not valid JSON');
    expect(r.err).toContain('site/dist/b.html: no knowledge region — no element carries data-kb-region');
  });

  it('fails a page whose knowledge region is missing, doubled or never closes, naming each and writing nothing', async () => {
    sb.write('site/dist/none.html', page('<div class="sl-markdown-content"><p>No hook.</p></div>'));
    sb.write('site/dist/two.html', page('<div data-kb-region><p>A.</p></div><div data-kb-region><p>B.</p></div>'));
    sb.write('site/dist/open.html', page('<div data-kb-region><p>Cut off.</p>'));
    const before = sb.snapshot();
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([
      '[site-pass] FAIL site/dist/none.html: no knowledge region — no element carries data-kb-region; site/src/components/MarkdownContent writes it on the rendered body',
      '[site-pass] FAIL site/dist/open.html: the knowledge region (data-kb-region) never closes',
      '[site-pass] FAIL site/dist/two.html: 2 elements carry data-kb-region — a page has one knowledge region',
    ]);
    expect(sb.snapshot()).toEqual(before);
  });

  it('fails a page with two JSON-LD blocks before writing anything', async () => {
    const ld = '<script type="application/ld+json">{"headline":"a"}</script>';
    sb.write('site/dist/a.html', region('<p>Text.</p>', ld + ld));
    const before = sb.snapshot();
    expectFail(await sb.run(spec), 'site/dist/a.html: 2 JSON-LD blocks — a page carries one');
    expect(sb.snapshot()).toEqual(before);
  });

  it('reads a description holding a closing tag whole, and a headline that is no string as none', async () => {
    const head = '<script type="application/ld+json">{"headline":7}</script>';
    sb.write('site/dist/a.html', region('<p>Text.</p>', head).replace('<head>', '<head><title>T</title><meta name="description" content="Ends at </script> here">'));
    expectPass(await sb.run(spec));
    const [entry] = (JSON.parse(sb.read('site/dist/index.json')) as { pages: { title: string; description: string }[] }).pages;
    expect(entry).toMatchObject({ title: 'T', description: 'Ends at </script> here' });
  });

  it('drops a section fact sitting inside its heading, wraps nothing for it, and still wraps the next one', async () => {
    sb.write('site/dist/a.html', region('<h2 id="t">T <!--meta block=x--></h2><p>In.</p><h2 id="u">U</h2><!--meta block=y--><p>Also.</p>'));
    const r = await sb.run(spec);
    expectFail(r, 'site/dist/a.html: a <!--meta--> section fact inside its heading');
    const html = sb.read('site/dist/a.html');
    expect(html).not.toContain('<!--meta');
    expect(html).not.toContain('data-block="x"');
    expect(html).toContain('<section data-block="y"><h2 id="u">U</h2><p>Also.</p></section>');
  });

  it('drops a section fact with no heading above it and still wraps the one below it', async () => {
    sb.write('site/dist/a.html', region('<!--meta block=x--><p>Loose.</p><h2 id="u">U</h2><!--meta block=y--><p>In.</p>'));
    expectFail(await sb.run(spec), 'site/dist/a.html: a <!--meta--> section fact with no heading above it');
    const html = sb.read('site/dist/a.html');
    expect(html).not.toContain('<!--meta');
    expect(html.match(/<section /g)).toHaveLength(1);
    expect(html).toContain('<section data-block="y"><h2 id="u">U</h2><p>In.</p></section>');
  });

  it('never ends a section, or finds a fact, inside a code sample’s copy of its source', async () => {
    // Expressive Code's copy button holds the sample's raw source in data-code:
    // a heading or a section fact written in the sample is its text, and the
    // clipboard must get it back byte for byte.
    const button = '<button data-code="<article>\n  <h2>{user.name}</h2>\n<!--meta block=nope-->\n</article>"></button>';
    sb.write('site/dist/a.html', region(`<h2 id="t">T</h2><!--meta block=sketch--><div class="expressive-code">${button}</div><h2 id="u">U</h2>`));
    expectPass(await sb.run(spec));
    const html = sb.read('site/dist/a.html');
    expect(html).toContain(`<section data-block="sketch"><h2 id="t">T</h2><div class="expressive-code">${button}</div></section><h2 id="u">U</h2>`);
    expect(html.match(/<section /g)).toHaveLength(1);
  });

  it('nests a section under an H3 inside the section of the H2 above it', async () => {
    sb.write('site/dist/a.html', region('<h2 id="t">T</h2><!--meta block=x--><p>A.</p><h3 id="s">S</h3><!--meta polarity=pro--><p>B.</p><h2 id="u">U</h2>'));
    expectPass(await sb.run(spec));
    expect(sb.read('site/dist/a.html')).toContain(
      '<section data-block="x"><h2 id="t">T</h2><p>A.</p><section data-polarity="pro"><h3 id="s">S</h3><p>B.</p></section></section><h2 id="u">U</h2>',
    );
  });

  it('leaves a section open to the region end when the next heading sits outside it', async () => {
    sb.write('site/dist/a.html', region('<h2 id="t">T</h2><!--meta block=x--><p>In.</p>').replace('</body>', '<h2>Footer</h2></body>'));
    expectPass(await sb.run(spec));
    expect(sb.read('site/dist/a.html')).toContain('<section data-block="x"><h2 id="t">T</h2><p>In.</p></section></article></div><h2>Footer</h2>');
  });

  it('runs a section past a deeper heading to the next one of its rank', async () => {
    sb.write('site/dist/a.html', region('<h2 id="t">T</h2><!--meta block=x--><h3>Sub</h3><p>In.</p><h2 id="u">U</h2>'));
    expectPass(await sb.run(spec));
    expect(sb.read('site/dist/a.html')).toContain('<section data-block="x"><h2 id="t">T</h2><h3>Sub</h3><p>In.</p></section><h2 id="u">U</h2>');
  });

  it('gives up on a page holding more than 200 section facts', async () => {
    sb.write('site/dist/a.html', region(`<h2 id="t">T</h2>${'<h3>s</h3><!--meta k=v-->'.repeat(201)}`));
    expectFail(await sb.run(spec), 'more than 200 <!--meta--> comments');
  });

  it('says how many chunks it pruned', async () => {
    sb.write('site/dist/a.html', region('<p>Text.</p>'));
    sb.write('site/dist/_astro/orphan.js', 'x;\n');
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toContain('pruned 1 unreferenced chunk(s)');
  });

  it('names an empty built site, and the repository root when --dist is it', async () => {
    sb.mkdir('site/dist');
    expectFail(await sb.run(spec), 'no .html files under site/dist');
    expectFail(await sb.run(spec, ['--dist', '.']), 'no .html files under .');
  });
});

describe('manifestOrder', () => {
  it('puts home first, then area order, then route — and calls two equal entries equal', () => {
    const e = (route: string, area: string): IndexEntry => ({
      route,
      area,
      title: '',
      description: '',
      owner: '',
      status: '',
      tags: [],
      aliases: [],
      solves: [],
      id: null,
      kind: null,
      band: null,
      group: null,
      record: null,
      headings: [],
    });
    const rank = (a: string): number => (a === 'first' ? 0 : 1);
    const order = manifestOrder(rank);
    const sorted = [e('/z.html', 'first'), e('/b.html', 'second'), e('/index.html', 'second'), e('/a.html', 'second')].sort(order);
    expect(sorted.map((x) => x.route)).toEqual(['/index.html', '/z.html', '/a.html', '/b.html']);
    expect(order(e('/a.html', 'first'), e('/a.html', 'first'))).toBe(0);
    expect(order(e('/b.html', 'first'), e('/a.html', 'first'))).toBe(1);
  });
});

describe('focusScrollableCode and labelTaskCheckboxes', () => {
  it('puts a code block in the tab order once, and nothing else', () => {
    expect(focusScrollableCode('<pre data-language="ts">x</pre>')).toBe('<pre data-language="ts" tabindex="0">x</pre>');
    expect(focusScrollableCode('<pre data-language="ts" tabindex="0">x</pre>')).toBe('<pre data-language="ts" tabindex="0">x</pre>');
    expect(focusScrollableCode('<pre>plain</pre>')).toBe('<pre>plain</pre>');
  });

  it('names a ticked task box, hides an empty one, and leaves every other input', () => {
    expect(labelTaskCheckboxes('<input type="checkbox" disabled checked>')).toBe('<input type="checkbox" disabled checked role="img" aria-label="done">');
    expect(labelTaskCheckboxes('<input type="checkbox" disabled>')).toBe('<input type="checkbox" disabled aria-hidden="true">');
    expect(labelTaskCheckboxes('<input type="checkbox" disabled aria-hidden="true">')).toBe('<input type="checkbox" disabled aria-hidden="true">');
    expect(labelTaskCheckboxes('<input type="checkbox">')).toBe('<input type="checkbox">');
    expect(labelTaskCheckboxes('<input type="text" disabled>')).toBe('<input type="text" disabled>');
  });
});

describe('wrapScrollableTables', () => {
  const region = (inner: string): string => `<nav><table></table></nav><div class="c" data-kb-region><article>${inner}</article></div>`;
  const wrapped = (name: string, table: string): string => `<div class="kb-wide" role="region" tabindex="0" aria-label="${name}">${table}</div>`;

  it('wraps a table in the region in one focusable scroll region named by the heading above it, and no table outside', () => {
    const html = region(
      '<h2 id="a">What each cloud calls it</h2><table><tr><td>a</td></tr></table><table data-note="deeper"></table><button data-code="<table>">c</button>',
    );
    const once = wrapScrollableTables(html);
    expect(once).toBe(
      region(
        `<h2 id="a">What each cloud calls it</h2>${wrapped('What each cloud calls it table', '<table><tr><td>a</td></tr></table>')}` +
          `${wrapped('What each cloud calls it table 2', '<table data-note="deeper"></table>')}<button data-code="<table>">c</button>`,
      ),
    );
    expect(wrapScrollableTables(once)).toBe(once);
    expect(wrapScrollableTables('<table></table>')).toBe('<table></table>');
  });

  it('names a table with no heading above it, and keeps two touching tables apart', () => {
    const once = wrapScrollableTables(region('<table></table><table></table>'));
    expect(once).toBe(region(`${wrapped('Table', '<table></table>')}${wrapped('Table 2', '<table></table>')}`));
  });

  it('gives a wrapper a component already drew the same three attributes instead of a second wrapper', () => {
    const html = region('<h3 id="g">Group</h3><div class="kb-wide astro-x">\n<table class="kb-stack-table"></table></div>');
    const once = wrapScrollableTables(html);
    expect(once).toBe(
      region('<h3 id="g">Group</h3><div class="kb-wide astro-x" role="region" tabindex="0" aria-label="Group table">\n<table class="kb-stack-table"></table></div>'),
    );
    expect(wrapScrollableTables(once)).toBe(once);
  });

  it('wraps a table that sits in some other element, inside it, and leaves a wrapper with its own tabindex alone', () => {
    const inCell = region('<div class="note"><table></table></div>');
    expect(wrapScrollableTables(inCell)).toBe(region(`<div class="note">${wrapped('Table', '<table></table>')}</div>`));
    const own = region('<div class="kb-wide" tabindex="0"><table></table></div>');
    expect(wrapScrollableTables(own)).toBe(own);
  });

  it('escapes a heading with a quote in the region name', () => {
    expect(wrapScrollableTables(region('<h2 id="q">The "why"</h2><table></table>'))).toContain('aria-label="The &quot;why&quot; table"');
  });
});

describe('mergeNextSteps', () => {
  const page = (section: string): string =>
    `<main><div class="sl-markdown-content" data-kb-region><article data-page="/a.html"><p>Body.</p>${section}</article></div></main>`;
  const heading = '<div class="sl-heading-wrapper level-h2"><h2 id="next-steps">Next steps</h2></div><p>Read on.</p>';

  it('turns a list of one link and its reason per item into one labelled nav of cards, once', () => {
    const html = page(`${heading}<ul>\n<li><a href="./b.html">Beta</a> — where it goes wrong.</li>\n<li><a href="./c.html">Gamma</a></li>\n</ul>`);
    const once = mergeNextSteps(html);
    expect(once).toBe(
      page(
        `<div class="kb-next-steps-block">${heading}<nav class="kb-next-steps kb-card-grid" aria-labelledby="next-steps">` +
          '<a class="kb-card" href="./b.html"><span class="kb-card-title">Beta</span> <span class="kb-card-desc">— where it goes wrong.</span></a>' +
          '<a class="kb-card" href="./c.html"><span class="kb-card-title">Gamma</span></a></nav></div>',
      ),
    );
    expect(mergeNextSteps(once)).toBe(once);
  });

  it('leaves the list as written when an item opens with prose, holds a second link or nests a list', () => {
    for (const item of [
      '<li>See <a href="./b.html">Beta</a>.</li>',
      '<li><a href="./b.html">Beta</a> and <a href="./c.html">Gamma</a></li>',
      '<li><a href="./b.html">Beta</a><ul><li>x</li></ul></li>',
    ]) {
      const html = page(`${heading}<ul>${item}</ul>`);
      expect(mergeNextSteps(html)).toBe(html);
    }
  });

  it('changes nothing with no next-steps heading, no list under it, an empty list or no knowledge region', () => {
    for (const html of [
      page('<ul><li><a href="./b.html">Beta</a></li></ul>'),
      page(heading),
      page(`${heading}<h2 id="more">More</h2><ul><li><a href="./b.html">Beta</a></li></ul>`),
      page(`${heading}<ul></ul>`),
      '<h2 id="next-steps">Next steps</h2><ul><li><a href="./b.html">Beta</a></li></ul>',
    ]) {
      expect(mergeNextSteps(html)).toBe(html);
    }
  });
});

describe('pruneOrphanChunks', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => sb.cleanup());

  const pages = (): string[] => [`${sb.dir}/site/dist/index.html`];
  const dist = (): string => `${sb.dir}/site/dist`;

  it('keeps what a page loads and what that chunk imports, to a fixed point', () => {
    sb.write('site/dist/index.html', '<script src="./_astro/page.aaa.js"></script>');
    sb.write('site/dist/_astro/page.aaa.js', 'import"./mid.bbb.js";\n');
    sb.write('site/dist/_astro/mid.bbb.js', 'import"./leaf.ccc.js";\n');
    sb.write('site/dist/_astro/leaf.ccc.js', 'export const a = 1;\n');

    expect(pruneOrphanChunks(dist(), pages())).toEqual([]);
    expect(sb.exists('site/dist/_astro/leaf.ccc.js')).toBe(true);
  });

  it('deletes a chunk nothing reaches, and reports which', () => {
    // Astro hoists a component's script from the import graph, so a component
    // that never renders still gets a chunk. This is that chunk.
    sb.write('site/dist/index.html', '<script src="./_astro/page.aaa.js"></script>');
    sb.write('site/dist/_astro/page.aaa.js', 'export const a = 1;\n');
    sb.write('site/dist/_astro/ui-core.zzz.js', 'export const dead = 1;\n');

    expect(pruneOrphanChunks(dist(), pages())).toEqual(['ui-core.zzz.js']);
    expect(sb.exists('site/dist/_astro/ui-core.zzz.js')).toBe(false);
    expect(sb.exists('site/dist/_astro/page.aaa.js')).toBe(true);
  });

  it('follows a dynamic import — a lazily loaded chunk is still loaded', () => {
    sb.write('site/dist/index.html', '<script src="./_astro/page.aaa.js"></script>');
    sb.write('site/dist/_astro/page.aaa.js', 'const f = () => import("./lazy.ddd.js");\n');
    sb.write('site/dist/_astro/lazy.ddd.js', 'export const a = 1;\n');

    expect(pruneOrphanChunks(dist(), pages())).toEqual([]);
  });

  it('does nothing when there is no _astro directory at all', () => {
    sb.write('site/dist/index.html', '<p>hi</p>');
    expect(pruneOrphanChunks(dist(), pages())).toEqual([]);
  });
});

describe('copySources', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => sb.cleanup());

  const structure: Structure = {
    areas: [
      {
        id: 'patterns',
        label: 'Patterns',
        pages: [
          { slug: 'alpha', label: 'Alpha', source: 'docs/patterns/alpha.md' },
          { slug: 'unbuilt', label: 'Unbuilt', source: 'docs/patterns/unbuilt.md' },
          { slug: 'ghost', label: 'Ghost', source: 'docs/patterns/ghost.md' },
          { slug: 'map', label: 'Map', source: 'generated', route: '/patterns/map.html' },
        ],
      },
    ],
  } as unknown as Structure;
  const dist = (): string => `${sb.dir}/site/dist`;

  it('names the markdown route beside a page', () => {
    expect(markdownRoute('/patterns/distributed/circuit-breaker.html')).toBe('/patterns/distributed/circuit-breaker.md');
  });

  it('copies the source bytes of each built page-tree page, and leaves a generated or unbuilt row alone', () => {
    const bytes = '---\ntitle: Alpha\n---\n\n# Alpha\n\u00e9\r\n';
    sb.write('docs/patterns/alpha.md', bytes);
    sb.write('docs/patterns/unbuilt.md', 'x');
    sb.write('site/dist/patterns/alpha.html', '<p>a</p>');
    sb.write('site/dist/patterns/map.html', '<p>m</p>');
    const r = copySources(sb.dir, dist(), structure);
    expect(r.copied).toEqual(['/patterns/alpha.md']);
    expect(r.missing).toEqual([]);
    expect(sb.read('site/dist/patterns/alpha.md')).toBe(bytes);
    expect(sb.exists('site/dist/patterns/unbuilt.md')).toBe(false);
    expect(sb.exists('site/dist/patterns/map.md')).toBe(false);
  });

  it('reports a built row whose source is gone, and deletes every other markdown file, idempotently', () => {
    sb.write('docs/patterns/alpha.md', 'a');
    sb.write('site/dist/patterns/alpha.html', '<p>a</p>');
    sb.write('site/dist/patterns/ghost.html', '<p>g</p>');
    sb.write('site/dist/stray.md', 'stray');
    sb.write('site/dist/patterns/old/deep.md', 'deep');
    const first = copySources(sb.dir, dist(), structure);
    expect(first.missing).toEqual([{ route: '/patterns/ghost.html', source: 'docs/patterns/ghost.md' }]);
    expect(first.pruned).toEqual(['/patterns/old/deep.md', '/stray.md']);
    const once = sb.snapshot();
    const second = copySources(sb.dir, dist(), structure);
    expect(second.pruned).toEqual([]);
    expect(sb.snapshot()).toEqual(once);
  });
});

describe('the pass ships the markdown', () => {
  let sb: Sandbox;
  const META = '<meta name="kb:area" content="guides"><meta name="kb:owner" content="Tests">';
  const built = `<!doctype html><html><head>${META}</head><body><div class="sl-markdown-content" data-kb-region><p>x</p></div></body></html>\n`;
  beforeEach(() => {
    sb = makeSandbox();
    sb.write(
      'docs/data/site-structure.json',
      JSON.stringify({ areas: [{ id: 'guides', label: 'Guides', pages: [{ slug: 'one', label: 'One', source: 'docs/guides/one.md' }] }] }),
    );
    sb.write('site/dist/guides/one.html', built);
  });
  afterEach(() => sb.cleanup());

  it('writes the source beside the page, names it in the manifest and the summary, and prunes a stray', async () => {
    sb.write('docs/guides/one.md', '# One\n');
    sb.write('site/dist/stray.md', 'x');
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toContain('copied 1 markdown source(s)');
    expect(sb.read('site/dist/guides/one.md')).toBe('# One\n');
    expect(sb.exists('site/dist/stray.md')).toBe(false);
    const manifest = JSON.parse(sb.read('site/dist/index.json')) as { pages: { route: string; markdown?: string }[] };
    expect(manifest.pages).toMatchObject([{ route: '/guides/one.html', markdown: '/guides/one.md' }]);
  });

  it('fails, writing no manifest, when a built row has no source file', async () => {
    const r = await sb.run(spec);
    expectFail(r, 'site/dist/guides/one.html: its source docs/guides/one.md is not in the repository');
    expect(sb.exists('site/dist/index.json')).toBe(false);
  });
});

describe('the pass ships the contract files', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
    rawKbSite(sb);
  });
  afterEach(() => sb.cleanup());

  const BREAKER = 'docs/patterns/distributed/resilience/breaker.md';
  const manifest = (): { pages: Record<string, unknown>[] } => JSON.parse(sb.read('site/dist/index.json')) as { pages: Record<string, unknown>[] };

  it('writes a record beside each page of the knowledge base, the bytes kb.mjs prints, and says how many in its summary', async () => {
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe(
      '[site-pass] 14 page(s) made portable; copied 13 markdown source(s); wrote index.json, 12 record(s), graph.json, llms.txt, llms-full.txt and 4 schema(s)',
    );
    const corpus = new Corpus(sb.dir);
    for (const page of corpus.listing) {
      expect(sb.read(`site/dist${page.route.replace(/\.html$/, '.json')}`), page.slug).toBe(serialize(recordOf(corpus, page.slug)));
    }
    expect(sb.read('site/dist/graph.json')).toBe(serialize(graphOf(corpus)));
    // Not a page of the knowledge base: no record, though its markdown ships.
    expect(sb.exists('site/dist/reference/notes.json')).toBe(false);
    expect(sb.exists('site/dist/reference/notes.md')).toBe(true);
    expect(sb.exists('site/dist/index.md')).toBe(false);
  });

  it('copies each schema whole under schema/, and writes llms.txt and llms-full.txt from the same pages', async () => {
    expectPass(await sb.run(spec));
    for (const schema of readSchemas(sb.dir)) expect(sb.read(`site/dist/schema/${schema.name}`), schema.name).toBe(sb.read(`${SCHEMA_DIR}/${schema.name}`));
    const llms = sb.read('site/dist/llms.txt');
    expect(llms.split('\n')[0]).toBe('# Patterns KB');
    // Every link of llms.txt names a file the pass wrote, from the site root.
    for (const m of llms.matchAll(/\]\(([^)]+)\)/g)) expect(sb.exists(`site/dist/${m[1] as string}`), m[1]).toBe(true);
    const full = sb.read('site/dist/llms-full.txt');
    expect(full.startsWith('<!-- kb:page id=breaker route=/patterns/distributed/resilience/breaker.html -->\n---\n')).toBe(true);
    expect(full).toContain(sb.read(BREAKER));
  });

  it('gives each entry of the manifest its id, kind, band, group and record, and null in all five on a page outside the knowledge base', async () => {
    expectPass(await sb.run(spec));
    const byRoute = new Map(manifest().pages.map((p) => [p['route'], p]));
    expect(byRoute.get('/patterns/distributed/resilience/breaker.html')).toMatchObject({
      id: 'breaker',
      kind: 'pattern',
      band: 'distributed',
      group: 'distributed-resilience',
      record: '/patterns/distributed/resilience/breaker.json',
      markdown: '/patterns/distributed/resilience/breaker.md',
    });
    expect(byRoute.get('/themes/loop.html')).toMatchObject({ id: 'loop', kind: 'theme', band: 'theme', group: 'theme' });
    for (const route of ['/reference/notes.html', '/index.html']) {
      expect(byRoute.get(route), route).toMatchObject({ id: null, kind: null, band: null, group: null, record: null });
    }
    for (const p of manifest().pages) {
      const keys = Object.keys(p);
      expect(keys.slice(0, 15), p['route'] as string).toEqual(['route', 'title', 'description', 'area', 'owner', 'status', 'tags', 'aliases', 'solves', 'id', 'kind', 'band', 'group', 'record', 'headings']);
      // A record the manifest names is a file, and a page with none names no file.
      if (p['record'] !== null) expect(sb.exists(`site/dist${p['record'] as string}`), p['record'] as string).toBe(true);
    }
  });

  it('makes the discovery links of every page relative like the rest, so each opens the file beside it', async () => {
    expectPass(await sb.run(spec));
    const html = sb.read('site/dist/patterns/distributed/resilience/breaker.html');
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="../../../patterns/distributed/resilience/breaker.md">');
    expect(html).toContain('<link rel="alternate" type="application/json" href="../../../patterns/distributed/resilience/breaker.json">');
    expect(sb.read('site/dist/reference/notes.html')).not.toContain('application/json');
    expect(sb.read('site/dist/index.html')).not.toContain('rel="alternate"');
  });

  it('writes the same bytes a second time', async () => {
    expectPass(await sb.run(spec));
    const once = sb.snapshot();
    expectPass(await sb.run(spec));
    expect(sb.snapshot()).toEqual(once);
  });

  it('refuses a page of the knowledge base that has no built page, naming it and its markdown, and writes nothing', async () => {
    sb.rm('site/dist/themes/steady.html');
    const before = sb.snapshot();
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toBe(
      '[site-pass] FAIL site/dist/themes/steady.html: no HTML was built for this page of the knowledge base (docs/themes/steady.md) — its record would sit beside nothing',
    );
    expect(sb.snapshot()).toEqual(before);
  });

  it('refuses a page whose record cannot be built, naming its markdown, and writes nothing', async () => {
    sb.write(BREAKER, sb.read(BREAKER).replace('<!-- relationships:end -->', ''));
    const before = sb.snapshot();
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toBe(`[site-pass] FAIL ${BREAKER}: its record cannot be built: breaker: the region "relationships" is never closed`);
    expect(sb.snapshot()).toEqual(before);
  });

  it('says a page it could not read is that, and not that no HTML was built for it', async () => {
    const file = 'site/dist/patterns/messaging/queue.html';
    sb.write(file, sb.read(file).replace('<meta name="kb:area" content="messaging">', ''));
    const r = await sb.run(spec);
    expectFail(r, `${file}: missing page facts: kb:area`);
    expect(r.err).not.toContain('no HTML was built');
  });
});

describe('the pass states where each page sits, and which relation each relationship item shows', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
    rawKbSite(sb);
  });
  afterEach(() => sb.cleanup());

  const BREAKER = 'site/dist/patterns/distributed/resilience/breaker.html';
  const STORM_ITEM = '<li><a href="/hazards/storm.html">Storm</a> — Fails fast</li>';
  const HTML = (): string[] => [...sb.snapshot().keys()].filter((f) => f.startsWith('site/dist/') && f.endsWith('.html'));
  const articleOf = (file: string): El => {
    const region = find(parse(sb.read(file)) as unknown as El, hasAttr('data-kb-region')) as El;
    return elementKids(region)[0] as El;
  };

  it('gives the article block of each page of the knowledge base its kind, band and group, as its record says, and every other page its three facts alone', async () => {
    expectPass(await sb.run(spec));
    const corpus = new Corpus(sb.dir);
    for (const page of corpus.listing) {
      const record = recordOf(corpus, page.slug);
      const article = articleOf(`site/dist${page.route}`);
      expect((article.attrs ?? []).map((a) => a.name), page.slug).toEqual(['data-page', 'data-area', 'data-tags', 'data-kind', 'data-band', 'data-group']);
      expect((article.attrs ?? []).slice(3), page.slug).toEqual([
        { name: 'data-kind', value: record.kind },
        { name: 'data-band', value: record.band },
        { name: 'data-group', value: record.group },
      ]);
    }
    // A theme filed under another area still states the theme's own place.
    expect(sb.read('site/dist/themes/loop.html')).toContain('data-kind="theme" data-band="theme" data-group="theme">');
    for (const file of ['site/dist/reference/notes.html', 'site/dist/index.html']) {
      expect((articleOf(file).attrs ?? []).map((a) => a.name), file).toEqual(['data-page', 'data-area', 'data-tags']);
    }
  });

  it('keeps the place off <body>, and off any copy a page held there', async () => {
    sb.write(BREAKER, sb.read(BREAKER).replace('<body>', '<body data-kind="x" data-band data-group="y" data-page-head="kept">'));
    expectPass(await sb.run(spec));
    expect(sb.read(BREAKER)).toContain('<body data-page-head="kept">');
  });

  it('stamps each item of each relationships block with the verb and target of its record’s relation, in order, and no other list item', async () => {
    expectPass(await sb.run(spec));
    const corpus = new Corpus(sb.dir);
    let stamped = 0;
    for (const page of corpus.listing) {
      const doc = parse(sb.read(`site/dist${page.route}`)) as unknown as El;
      const section = find(doc, (e) => e.tagName === 'section' && (e.attrs ?? []).some((a) => a.name === 'data-block' && a.value === 'relationships'));
      const items = section === undefined ? [] : within(section, 'li');
      const relations = recordOf(corpus, page.slug).relations;
      expect(
        items.map((li) => li.attrs),
        page.slug,
      ).toEqual(relations.map((r) => [{ name: 'data-verb', value: r.verb }, { name: 'data-to', value: r.to }]));
      stamped += items.length;
      expect(within(doc, 'li').filter(hasAttr('data-to')), page.slug).toHaveLength(items.length);
    }
    // Both sides of every edge of the fixture: each shows its own row.
    expect(stamped).toBe(corpus.listing.reduce((sum, page) => sum + recordOf(corpus, page.slug).relations.length, 0));
    expect(stamped).toBeGreaterThan(5);
    expect(sb.read(BREAKER)).toContain('<li data-verb="prevents-hazard" data-to="storm"><a href="../../../hazards/storm.html">Storm</a> — Fails fast</li>');
  });

  it('writes pages the data-layer gate accepts: one article of three or six facts, and the stamps on class-free items', async () => {
    expectPass(await sb.run(spec));
    expect(HTML()).toHaveLength(14);
    for (const file of HTML()) expect(pageFindings(sb.read(file), file === 'site/dist/index.html'), file).toEqual([]);
  });

  it('refuses a block that lists fewer items than the record has relations, naming the page, and writes nothing', async () => {
    sb.write(BREAKER, sb.read(BREAKER).replace(STORM_ITEM, ''));
    const before = sb.snapshot();
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.trim().split('\n')).toEqual([
      `[site-pass] FAIL ${BREAKER}: its relationships block lists 1 item(s) and its record holds 2 relation(s) — the block is stale: run make gen, then make site-build`,
    ]);
    expect(sb.snapshot()).toEqual(before);
  });

  it('refuses an item whose link opens another page than its relation’s, or none, and writes nothing', async () => {
    const swapped = '<li><a href="/patterns/distributed/resilience/retry.html">Storm</a> — Fails fast</li>';
    sb.write(BREAKER, sb.read(BREAKER).replace(STORM_ITEM, swapped));
    const before = sb.snapshot();
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.trim().split('\n')).toEqual([
      `[site-pass] FAIL ${BREAKER}: item 2 of its relationships block opens /patterns/distributed/resilience/retry.html, and relation 2 of its record, prevents-hazard storm, ` +
        'is for /hazards/storm.html — the block and the record disagree: run make gen, then make site-build',
    ]);
    expect(sb.snapshot()).toEqual(before);

    sb.write(BREAKER, sb.read(BREAKER).replace(swapped, '<li>Storm — Fails fast</li>'));
    const linkless = sb.snapshot();
    expectFail(await sb.run(spec), 'item 2 of its relationships block opens no page');
    expect(sb.snapshot()).toEqual(linkless);
  });

  it('refuses a page of the knowledge base whose block is gone, though its record lists relations', async () => {
    const html = sb.read(BREAKER);
    sb.write(BREAKER, html.slice(0, html.indexOf('<div class="sl-heading-wrapper level-h2"><h2 id="relationships">')) + html.slice(html.indexOf('<!-- relationships:end -->') + '<!-- relationships:end -->'.length));
    const r = await sb.run(spec);
    expectFail(r, `${BREAKER}: its relationships block lists 0 item(s) and its record holds 2 relation(s)`);
  });

  it('reports every refusal and every other finding of the run together, and writes nothing, not even a chunk of script', async () => {
    const snippet =
      '<script aria-hidden="true">(() => { const storedTheme = typeof localStorage !== \'undefined\' && localStorage.getItem(\'starlight-theme\'); })();</script>';
    const file = 'site/dist/hazards/storm.html';
    // A page that would write the shared chunk, one refusal and one section fact with no heading.
    sb.write(file, sb.read(file).replace('</head>', `${snippet}</head>`).replace('<p>', '<!--meta block=loose--><p>'));
    sb.write(BREAKER, sb.read(BREAKER).replace(STORM_ITEM, ''));
    const before = sb.snapshot();
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.trim().split('\n')).toEqual([
      `[site-pass] FAIL ${BREAKER}: its relationships block lists 1 item(s) and its record holds 2 relation(s) — the block is stale: run make gen, then make site-build`,
      `[site-pass] FAIL ${file}: a <!--meta--> section fact with no heading above it — it goes on the line after a heading; dropped`,
    ]);
    expect(sb.snapshot()).toEqual(before);
  });

  it('refuses a head that states part of a place, naming the page and what it lacks, and writes nothing', async () => {
    sb.write(BREAKER, sb.read(BREAKER).replace('<meta name="kb:band" content="distributed">', ''));
    const before = sb.snapshot();
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.trim().split('\n')).toEqual([
      `[site-pass] FAIL ${BREAKER}: the head states part of a place, without kb:band — a page of the knowledge base states kb:kind, kb:band, kb:group together and any other page none; ` +
        'site/src/components/Head/Head.astro emits them',
    ]);
    expect(sb.snapshot()).toEqual(before);
  });
});
