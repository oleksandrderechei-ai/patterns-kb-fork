/**
 * The scenarios that need a real build (oracle offline-O1, pagedata-O1,
 * head-O1, search-O1, and the built-site half of maturity-O1 with the
 * prerequisite card of prerequisites-C8): each builds a small site in a
 * throwaway checkout with the real workspace, the real steps and the real Head
 * component, then reads the head, the article block and the manifest the build
 * wrote. A build takes a few seconds on an idle machine, so each scenario is
 * one test with room to wait; the two learning scenarios share one build.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { spec as absenceGate } from '../gates/check-site-absence.js';
import { spec as linksGate } from '../gates/check-site-links.js';
import { spec as portableGate } from '../gates/check-site-portable.js';
import { attrValue, elements, jsonLdBlocks, metaContent, metaCount, metas, parseAttrs, tags } from '../lib/built-page.js';
import { expectPass, makeSandbox, type Sandbox } from '../lib/sandbox.js';
import { PAYLOAD_FILE_NAME } from '../lib/asset-names.js';
import { decodePage, type SearchPayload, type WirePayload } from '../lib/search-score.js';
import type { Structure } from '../lib/site-routes.js';
import { publicRoot } from './site-output.js';
import { buildSite, commitAt, COPIED, HOME, SANDBOX_CONFIG, siteSandbox, sitePage, type SiteBuild } from './site-sandbox.js';

/** A build that must pass, with everything it said in the failure message. */
function expectBuilt(b: SiteBuild): void {
  if (b.status !== 0) throw new Error(`the build failed (exit ${b.status}):\n${b.output}`);
}

/** The attributes of the article block on a built page. */
function articleAttrs(html: string): { name: string; value: string | null }[] {
  const [article] = elements(html, (name, attrs) => name === 'article' && attrValue(attrs, 'data-page') !== undefined);
  expect(article).toBeDefined();
  const open = html.slice((article as { start: number }).start, (article as { innerStart: number }).innerStart);
  return parseAttrs(open.replace(/^<article/, '').replace(/>$/, ''));
}

interface ManifestEntry {
  route: string;
  area: string;
  tags: string[];
}

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

/** The built payload's text, under the hashed name the build gave it. */
const payloadText = (box: Sandbox): string =>
  box.read(`site/dist/${fs.readdirSync(path.join(box.dir, 'site/dist')).find((f) => PAYLOAD_FILE_NAME.test(f)) as string}`);

/** The payload as a script context holds it, its wire headings decoded the way the search box does. */
const decoded = (kb: unknown): SearchPayload => ({ ...(kb as WirePayload), pages: (kb as WirePayload).pages.map(decodePage) });

describe('the site sandbox', () => {
  it('copies what the build writes beside, links node_modules, and adds only the one config line', () => {
    siteSandbox(sb);
    for (const p of COPIED) expect(sb.exists(p)).toBe(true);
    expect(fs.lstatSync(path.join(sb.dir, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(sb.read('site/astro.sandbox.mjs')).toBe(SANDBOX_CONFIG);
    expect(sb.git('status', '--porcelain').stdout).toBe('');
  });

  it('stops at the first step that fails, and says which', { timeout: 240_000 }, () => {
    siteSandbox(sb, { 'docs/patterns/caching/alpha.md': '# No frontmatter\n', 'docs/hazards/gamma.md': sitePage('Gamma', { area: 'hazards' }) });
    const b = buildSite(sb);
    expect(b.status).not.toBe(0);
    expect(b.steps.map((s) => s.name)).toEqual(['prebuild']);
    expect(b.output).toContain('docs/patterns/caching/alpha.md: has no frontmatter');
  });
});

describe('offline-O1', () => {
  it('offline-O1: after a real build, the home page and a page one folder down are real files at their routes, link each other relatively, every link resolves on disk, and the portability gate exits 0', { timeout: 240_000 }, async () => {
    siteSandbox(sb, {
      'docs/patterns/caching/alpha.md': sitePage('Alpha', { tags: '[caching, performance]' }),
      'docs/hazards/gamma.md': `${sitePage('Gamma', { area: 'hazards', tags: '[resilience, caching]' })}\nBack [home](/index.html).\n`,
    });
    sb.write('site/src/content/docs/index.mdx', HOME.replace('Start at the hubs.', 'Start at the hubs, or go to [Gamma](/hazards/gamma.html).'));
    sb.commit('the home page links a page one folder down');
    expectBuilt(buildSite(sb));

    // Each route is its own file (build.format 'file'), where the link says.
    for (const file of ['site/dist/index.html', 'site/dist/hazards/gamma.html']) expect(fs.statSync(path.join(sb.dir, file)).isFile(), file).toBe(true);
    const home = sb.read('site/dist/index.html');
    const gamma = sb.read('site/dist/hazards/gamma.html');
    expect(home).toMatch(/<a href="\.\/hazards\/gamma\.html"[^>]*>Gamma<\/a>/);
    expect(gamma).toMatch(/<a href="\.\.\/index\.html"[^>]*>home<\/a>/);

    // Every internal link and source resolves to a file on disk, the way a
    // browser reading the folder resolves it.
    for (const [file, html] of [
      ['site/dist/index.html', home],
      ['site/dist/hazards/gamma.html', gamma],
    ] as const) {
      for (const t of tags(html)) {
        if (t.closing) continue;
        const attrs = parseAttrs(t.source);
        for (const name of ['href', 'src']) {
          const v = attrValue(attrs, name);
          if (v === undefined || v === '' || v.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(v)) continue;
          expect(v.startsWith('/'), `${file}: ${name}="${v}"`).toBe(false);
          const target = path.resolve(path.dirname(path.join(sb.dir, file)), decodeURI(v.replace(/[?#].*$/, '')));
          expect(fs.existsSync(target), `${file} → ${v}`).toBe(true);
        }
      }
    }
    const r = await sb.run(portableGate);
    expectPass(r);
    expect(r.out.split('\n')).toHaveLength(1);
  });
});

describe('the published root', () => {
  it('names each built page, and every sitemap URL, under the project path the site is served from', { timeout: 240_000 }, () => {
    siteSandbox(sb);
    expectBuilt(buildSite(sb));
    const root = publicRoot().href;
    expect(root).toBe('https://odere-pro.github.io/software-design-atlas/');
    const html = sb.read('site/dist/hazards/gamma.html');
    const canonical = [...tags(html)].find((t) => t.name === 'link' && attrValue(parseAttrs(t.source), 'rel') === 'canonical');
    expect(attrValue(parseAttrs((canonical as { source: string }).source), 'href')).toBe(`${root}hazards/gamma.html`);
    const og = [...tags(html)].find((t) => t.name === 'meta' && attrValue(parseAttrs(t.source), 'property') === 'og:url');
    expect(attrValue(parseAttrs((og as { source: string }).source), 'content')).toBe(`${root}hazards/gamma.html`);
    const block = /<script[^>]*type="application\/ld\+json"[^>]*>([^]*?)<\/script>/.exec(html)?.[1] ?? '{}';
    const ld = JSON.parse(block) as { url?: string; mainEntityOfPage?: { '@id'?: string } };
    expect(ld.url).toBe(`${root}hazards/gamma.html`);
    expect(ld.mainEntityOfPage?.['@id']).toBe(ld.url);
    const sitemaps = fs.readdirSync(path.join(sb.dir, 'site/dist')).filter((f) => /^sitemap.*\.xml$/.test(f));
    expect(sitemaps.length).toBeGreaterThan(0);
    const locs = sitemaps.flatMap((f) => [...sb.read(`site/dist/${f}`).matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1] as string));
    expect(locs).toContain(`${root}hazards/gamma.html`);
    for (const loc of locs) expect(loc.startsWith(root), loc).toBe(true);
  });
});

describe('pagedata-O1', () => {
  it('pagedata-O1: one page’s area and two tags reach its head, its article block and its index entry — and tags changed in its frontmatter reach all three on the next build', { timeout: 240_000 }, () => {
    siteSandbox(sb);
    const page = 'docs/patterns/caching/alpha.md';
    const built = 'site/dist/patterns/caching/alpha.html';

    const agree = (tags: string[]): void => {
      const html = sb.read(built);
      expect(metaContent(html, 'kb:area')).toBe('caching');
      expect(metaContent(html, 'kb:tags')).toBe(tags.join(','));

      const attrs = articleAttrs(html);
      expect(attrs.map((a) => a.name)).toEqual(['data-page', 'data-area', 'data-tags']);
      const fact = (n: string): string | undefined => attrValue(attrs, n);
      expect([fact('data-area'), fact('data-tags')]).toEqual(['caching', tags.join(',')]);

      const manifest = JSON.parse(sb.read('site/dist/index.json')) as { pages: ManifestEntry[] };
      const entry = manifest.pages.find((p) => p.route === '/patterns/caching/alpha.html') as ManifestEntry;
      expect(entry).toMatchObject({ area: 'caching', tags });
      expect(fact('data-page')).toBe(entry.route);
    };

    expectBuilt(buildSite(sb));
    agree(['caching', 'performance']);

    // The one edit: the page's frontmatter. No program file changes.
    sb.write(page, sb.read(page).replace('tags: [caching, performance]', 'tags: [caching, resilience]'));
    expect(sb.git('status', '--porcelain').stdout).toBe(` M ${page}\n`);
    expectBuilt(buildSite(sb));
    agree(['caching', 'resilience']);
    // The build leaves nothing new, changed or untracked in its input folder (output-ownership-C9).
    expect(sb.git('status', '--porcelain').stdout).toBe(` M ${page}\n`);
  });
});

describe('head-O1', () => {
  it('head-O1: a page with a closing script tag in its description and no status — each head fact once, one structured-data block with no `<` in its text, the page-tree file’s commit date; with no version control, no date and still exit 0', { timeout: 240_000 }, () => {
    const description = 'Why </script> cannot end this block';
    const page = [
      '---',
      'title: Alpha',
      `description: ${description}`,
      'area: caching',
      'owner: Oleksandr Derechei',
      'tags: [caching, performance]',
      '---',
      '',
      '# Alpha',
      '',
      'Alpha keeps answers.',
      '',
    ].join('\n');
    siteSandbox(sb, { 'docs/hazards/gamma.md': sitePage('Gamma', { area: 'hazards', tags: '[resilience, caching]' }) });
    // The page-tree file's own commit, dated apart from everything else.
    sb.write('docs/patterns/caching/alpha.md', page);
    const committed = '2021-03-04T05:06:07+02:00';
    commitAt(sb, 'the page', committed);

    expectBuilt(buildSite(sb));
    const html = sb.read('site/dist/patterns/caching/alpha.html');

    // Exactly one meta element each, and exactly four kb: names.
    for (const name of ['kb:area', 'kb:status', 'kb:owner', 'kb:tags', 'description']) expect(metaCount(html, name)).toBe(1);
    const kbNames = metas(html)
      .map((a) => attrValue(a, 'name'))
      .filter((n): n is string => n !== undefined && n.startsWith('kb:'));
    expect(kbNames.sort()).toEqual(['kb:area', 'kb:owner', 'kb:status', 'kb:tags']);
    expect(metaContent(html, 'kb:area')).toBe('caching');
    expect(metaContent(html, 'kb:status')).toBe('stable');
    expect(metaContent(html, 'kb:owner')).toBe('Oleksandr Derechei');
    expect(metaContent(html, 'kb:tags')).toBe('caching,performance');
    expect(metaContent(html, 'description')).toBe(description);

    const blocks = jsonLdBlocks(html);
    expect(blocks).toHaveLength(1);
    const text = blocks[0] as string;
    expect(text).not.toContain('<');
    expect(text).toContain('\\u003c/script>');
    const ld = JSON.parse(text) as Record<string, unknown>;
    expect(ld['headline']).toBe('Alpha');
    expect(ld['description']).toBe(description);
    expect(ld['isPartOf']).toMatchObject({ name: 'caching' });
    expect(ld['keywords']).toBe('caching, performance');
    // The date of docs/, never of the ignored mirror, which git has no date for.
    expect(ld['dateModified']).toBe(committed);

    // No version control for the step that asks it: no date, and the build still exits 0.
    expectBuilt(buildSite(sb, { noVersionControl: true }));
    const again = JSON.parse(jsonLdBlocks(sb.read('site/dist/patterns/caching/alpha.html'))[0] as string) as Record<string, unknown>;
    expect(again).not.toHaveProperty('dateModified');
    expect(again['headline']).toBe('Alpha');
  });
});

describe('search-O1', () => {
  it('search-O1: three ordinary pages beside one hub — the payload, loaded with no network, carries exactly the three, the row with a row header and not the one without, each page carrying facts and no prose', { timeout: 240_000 }, () => {
    const structure: Structure = {
      areas: [
        {
          id: 'patterns',
          label: 'Patterns',
          hub: { description: 'Reusable answers', intro: 'Reusable answers.', tags: ['caching', 'performance'] },
          pages: [
            { slug: 'alpha', label: 'Alpha', source: 'docs/patterns/alpha.md' },
            { slug: 'beta', label: 'Beta', source: 'docs/patterns/beta.md' },
          ],
        },
      ],
    };
    // One table row with an id and a row-header cell, one with an id and none.
    const table =
      '<table><tbody><tr id="named-row"><th scope="row">Named row</th><td>x</td></tr>' +
      '<tr id="bare-row"><td>No header</td><td>y</td></tr></tbody></table>';
    siteSandbox(sb, {
      'docs/patterns/alpha.md': `${sitePage('Alpha', { area: 'patterns' })}\n${table}\n`,
      'docs/patterns/beta.md': sitePage('Beta', { area: 'patterns' }),
    });
    sb.write('docs/data/site-structure.json', `${JSON.stringify(structure, null, 2)}\n`);
    commitAt(sb, 'three pages, one hub', '2026-09-28T10:00:00+02:00');

    expectBuilt(buildSite(sb));
    expect(sb.exists('site/dist/patterns.html')).toBe(true);

    // A fresh script context: no fetch, no XMLHttpRequest, nothing but a window.
    const context: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(payloadText(sb), context);
    expect(Object.keys(context)).toEqual(['window']);
    expect(Object.keys(context.window)).toEqual(['kb']);
    const kb = decoded(context.window['kb']);
    expect(Object.keys(kb)).toEqual(['pages', 'terms', 'tagLabels', 'synonyms']);
    // The glossary's terms fill the definition cards.
    expect(kb.terms.map((t) => t.id)).toEqual(['breaker']);
    expect(kb.pages.map((p) => p.route)).toEqual(['/index.html', '/404.html', '/marks.html', '/patterns/alpha.html', '/patterns/beta.html']);

    const alpha = kb.pages[3] as SearchPayload['pages'][number];
    expect(alpha.headings).toContainEqual({ id: 'named-row', text: 'Named row' });
    expect(alpha.headings.some((h) => h.id === 'bare-row' || h.text === 'No header')).toBe(false);
    // A navigation index: each page's facts and landing places, never its prose.
    for (const p of kb.pages) expect('body' in p, p.route).toBe(false);
    expect(kb.pages.map((p) => p.kind)).toEqual(['patterns', 'patterns', 'patterns', 'patterns', 'patterns']);
    expect(alpha.description).toBe('What Alpha does');
  });
});

/**
 * One build for the two learning scenarios: a hub listing a draft page and a
 * stable one, a second area with one page, and a prerequisite file in which
 * the draft requires the stable page and sits beside the third.
 */
describe('the learning surfaces on a built site', () => {
  const LEARNING_STRUCTURE: Structure = {
    areas: [
      {
        id: 'patterns',
        label: 'Patterns',
        hub: { description: 'Reusable answers', intro: 'Reusable answers.', tags: ['caching', 'performance'] },
        pages: [],
      },
      {
        id: 'caching',
        label: 'Caching',
        nestUnder: 'patterns',
        hub: { description: 'Keeping answers close', intro: 'Keeping answers close.', tags: ['caching', 'performance'] },
        pages: [
          { slug: 'alpha', label: 'Alpha', source: 'docs/patterns/caching/alpha.md', route: '/patterns/caching/alpha.html' },
          { slug: 'beta', label: 'Beta', source: 'docs/patterns/caching/beta.md', route: '/patterns/caching/beta.html' },
        ],
      },
      {
        id: 'hazards',
        label: 'Hazards',
        hub: { description: 'What goes wrong', intro: 'What goes wrong.', tags: ['resilience', 'caching'] },
        pages: [{ slug: 'gamma', label: 'Gamma', source: 'docs/hazards/gamma.md' }],
      },
    ],
  };
  const RECORDS = [
    { id: 'alpha', label: 'Alpha', definition: 'What Alpha does', route: '/patterns/caching/alpha.html', requires: ['beta'], related: ['gamma'] },
    { id: 'beta', label: 'Beta', definition: 'What Beta does', route: '/patterns/caching/beta.html', requires: [], related: [] },
    { id: 'gamma', label: 'Gamma', definition: 'What Gamma does', route: '/hazards/gamma.html', requires: [], related: ['alpha'] },
  ];
  /** Each page's declared status. */
  const DECLARED: Record<string, { status: string }> = {
    '/patterns/caching/alpha.html': { status: 'draft' },
    '/patterns/caching/beta.html': { status: 'stable' },
    '/hazards/gamma.html': { status: 'stable' },
  };

  let lsb: Sandbox;
  let build: SiteBuild;
  beforeAll(() => {
    lsb = makeSandbox();
    siteSandbox(lsb, {
      'docs/patterns/caching/alpha.md': sitePage('Alpha', { tags: '[caching, performance]', status: 'draft' }),
      'docs/patterns/caching/beta.md': sitePage('Beta', { tags: '[caching, performance]' }),
      'docs/hazards/gamma.md': sitePage('Gamma', { area: 'hazards', tags: '[resilience, caching]' }),
      'docs/data/prerequisites.json': `${JSON.stringify({ version: 1, updated: '2026-09-29', note: 'Fixture graph.', records: RECORDS }, null, 2)}\n`,
    });
    lsb.write('docs/data/site-structure.json', `${JSON.stringify(LEARNING_STRUCTURE, null, 2)}\n`);
    lsb.commit('a hub with a draft and a stable page, and a prerequisite file');
    build = buildSite(lsb);
  }, 240_000);
  afterAll(() => lsb.cleanup());

  /** One hub entry's markup: the list row, never the sidebar's, whose link ends in `target` (the pass makes it relative). */
  const hubRow = (hub: string, target: string): string => {
    const row = elements(hub, (name, attrs) => name === 'li' && attrValue(attrs, 'class') === 'kb-hub-item').find((r) => hub.slice(r.start, r.end).includes(`${target}"`));
    expect(row, target).toBeDefined();
    return hub.slice((row as { start: number }).start, (row as { end: number }).end);
  };

  it('maturity-O1 (the built-site half): the draft’s hub entry carries a chip, the stable one none; the draft’s status meta, manifest entry and payload status read draft', () => {
    expectBuilt(build);
    const hub = lsb.read('site/dist/patterns/caching.html');
    expect(hubRow(hub, '/caching/alpha.html')).toMatch(/<span class="kb-status kb-status--draft">\s*draft\s*<\/span>/);
    expect(hubRow(hub, '/caching/beta.html')).not.toContain('kb-status');

    const manifest = JSON.parse(lsb.read('site/dist/index.json')) as { pages: { route: string; status: string }[] };
    const context: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(payloadText(lsb), context);
    const payload = decoded(context.window['kb']).pages;
    for (const [route, want] of Object.entries(DECLARED)) {
      const html = lsb.read(`site/dist${route}`);
      expect(metaContent(html, 'kb:status'), route).toBe(want.status);
      expect(manifest.pages.find((p) => p.route === route)?.status, route).toBe(want.status);
      expect(payload.find((p) => p.route === route)?.status, route).toBe(want.status);
    }
    // The hub itself declares stable.
    expect(metaContent(hub, 'kb:status')).toBe('stable');
    expect(manifest.pages.find((p) => p.route === '/patterns/caching.html')?.status).toBe('stable');
  });

  it('prerequisites-C8: a record’s page carries one card, a class-free block whose two facts are its arrays, one link per requires id then per related id; a record with no edge gets none, and the site gates and RT-2 pass over it', async () => {
    expectBuilt(build);
    const cardOf = (route: string): { facts: { requires: string; related: string }; links: string[]; classed: boolean }[] => {
      const html = lsb.read(`site/dist${route}`);
      return elements(html, (_name, attrs) => attrs.some((a) => a.name === 'data-requires')).map((c) => {
        const open = html.slice(c.start, c.innerStart);
        const attrs = parseAttrs(open.replace(/^<[a-z]+/, '').replace(/>$/, ''));
        const inner = html.slice(c.innerStart, c.innerEnd);
        return {
          facts: { requires: attrValue(attrs, 'data-requires') ?? '', related: attrValue(attrs, 'data-related') ?? '' },
          links: [...inner.matchAll(/<a href="([^"]*)" title="([^"]*)"[^>]*>\s*([^<]*?)\s*<\/a>/g)].map((m) => `${m[3] as string} ${m[1] as string} "${m[2] as string}"`),
          classed: attrValue(attrs, 'class') !== undefined,
        };
      });
    };
    const alpha = cardOf('/patterns/caching/alpha.html');
    expect(alpha).toEqual([
      { facts: { requires: 'beta', related: 'gamma' }, links: ['Beta ../../patterns/caching/beta.html "What Beta does"', 'Gamma ../../hazards/gamma.html "What Gamma does"'], classed: false },
    ]);
    expect(cardOf('/hazards/gamma.html')).toEqual([{ facts: { requires: '', related: 'alpha' }, links: ['Alpha ../patterns/caching/alpha.html "What Alpha does"'], classed: false }]);
    expect(cardOf('/patterns/caching/beta.html')).toEqual([]);
    // No skip marker: the card is knowledge, inside the article block.
    const html = lsb.read('site/dist/patterns/caching/alpha.html');
    const [article] = elements(html, (name) => name === 'article');
    const inArticle = html.slice((article as { innerStart: number }).innerStart, (article as { innerEnd: number }).innerEnd);
    expect(inArticle).toContain('data-requires="beta"');
    expect(inArticle).not.toContain('data-kb-skip');

    for (const gate of [absenceGate, linksGate]) expectPass(await lsb.run(gate));
  });

  it('prerequisites-C9: the search payload carries each record’s edges as its neighbours’ routes, and none on a page with no edge', () => {
    expectBuilt(build);
    const context: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(payloadText(lsb), context);
    const pages = decoded(context.window['kb']).pages;
    const edges = (route: string) => {
      const p = pages.find((x) => x.route === route);
      return { requires: p?.requires, related: p?.related };
    };
    expect(edges('/patterns/caching/alpha.html')).toEqual({ requires: ['/patterns/caching/beta.html'], related: ['/hazards/gamma.html'] });
    expect(edges('/hazards/gamma.html')).toEqual({ requires: [], related: ['/patterns/caching/alpha.html'] });
    expect(edges('/patterns/caching/beta.html')).toEqual({ requires: undefined, related: undefined });
  });

  // Last, since it rebuilds the shared tree with a page that fails.
  it('maturity-C3: with the learning extension, a page with no status fails the build, naming that page', () => {
    lsb.write('docs/patterns/caching/beta.md', lsb.read('docs/patterns/caching/beta.md').replace(/^status: .*\n/m, ''));
    expect(lsb.read('docs/patterns/caching/beta.md')).not.toMatch(/^status:/m);
    lsb.commit('beta without a status');
    const failed = buildSite(lsb);
    expect(failed.status, failed.output).not.toBe(0);
    expect(failed.steps.at(-1)?.name).toBe('astro build');
    expect(failed.output).toContain('patterns/caching/beta data does not match collection schema');
    expect(failed.output).toMatch(/^\s*status: /m);
    expect(failed.output).toMatch(/site\/src\/content\/docs\/patterns\/caching\/beta\.md/);
  });
});
