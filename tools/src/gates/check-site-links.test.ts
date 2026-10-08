/**
 * The built-site half of link integrity (spec kb.gates.link-integrity), and
 * the site half of link-integrity-O1: with nothing built the gate names the
 * build command; built, a folder link, an orphan page, a page linked only from
 * a hub's next-steps section and a stage with no page are exactly four
 * findings.
 */

import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectFail, expectMisuse, expectPass, makeSandbox, type Sandbox } from '../lib/sandbox.js';
import { builtPage, builtSite, STRUCTURE } from '../site/site-fixtures.js';
import { REPO_BLOB } from '../site/site-output.js';
import {
  fragmentId,
  hubBody,
  hubRuns,
  isExternal,
  LEARNING_PATHS,
  outOfOrder,
  rankedPages,
  readLinks,
  repoFileOf,
  resolveFromRoot,
  routeToPage,
  spec,
  splitUrl,
} from './check-site-links.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  vi.restoreAllMocks();
  sb.cleanup();
});

/** A learning-path file with one profile and these stages. */
const paths = (stages: readonly string[], id = 'starter'): string =>
  `${JSON.stringify({ version: 1, updated: '2026-09-28', note: 'Fixture paths.', profiles: [{ id, label: 'Starter', stages }] }, null, 2)}\n`;

const CACHING_HUB = 'site/dist/patterns/caching.html';

describe('link-integrity-O1 (the built-site gate)', () => {
  it('link-integrity-O1: nothing built — the built-site gate exits 1 naming the build command', async () => {
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual(['[site-links] FAIL: no built site at site/dist — build it first: make site-build']);
  });

  it('link-integrity-O1: built — a folder link, a page no hub links, one linked only from next steps, a stage with no page: exactly four findings', async () => {
    builtSite(sb);
    sb.write(LEARNING_PATHS, paths(['/patterns/caching/alpha.html', '/']));
    expectPass(await sb.run(spec));

    // An href naming a folder.
    const alpha = 'site/dist/patterns/caching/alpha.html';
    sb.write(alpha, sb.read(alpha).replace('<p id="description-p-1">Alpha.</p>', '<p id="description-p-1">Alpha. <a href="../caching">All of it</a></p>'));
    // A page no hub links.
    sb.write('site/dist/patterns/caching/delta.html', builtPage({ route: '/patterns/caching/delta.html', title: 'Delta', area: 'caching', body: '<p>Delta.</p>' }));
    // A page linked only from the hub's next-steps section.
    sb.write('site/dist/patterns/caching/epsilon.html', builtPage({ route: '/patterns/caching/epsilon.html', title: 'Epsilon', area: 'caching', body: '<p>Epsilon.</p>' }));
    sb.write(CACHING_HUB, sb.read(CACHING_HUB).replace('</ol>', '</ol><h2 id="next-steps">Next steps</h2><p><a href="./caching/epsilon.html">Epsilon</a></p>'));
    // A stage matching no built page.
    sb.write(LEARNING_PATHS, paths(['/patterns/caching/alpha.html', '/patterns/caching/missing.html']));

    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([
      `[site-links] FAIL ${alpha}: link '../caching' → patterns/caching is a folder, not a page — a folder opens nothing from disk`,
      '[site-links] FAIL site/dist/patterns/caching/delta.html: is linked from no hub — a reader browsing the hubs never finds it',
      '[site-links] FAIL site/dist/patterns/caching/epsilon.html: is linked from no hub — a reader browsing the hubs never finds it',
      `[site-links] FAIL ${LEARNING_PATHS}: profile "starter" stage /patterns/caching/missing.html matches no built page (site/dist/patterns/caching/missing.html)`,
    ]);
  });
});

describe('the built-site gate', () => {
  it('passes a clean built site with one summary line', async () => {
    builtSite(sb);
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toMatch(/^\[site-links\] \d+ links across 7 pages land on a file and an anchor; 0 links to a repository file name one in the tree; 4 hubs hold every page once, 3 in reading order within each group; 0 learning-path stages are built pages$/);
  });

  it('names a hub listing its pages out of reading order within one group, and lets two groups each keep their own order', async () => {
    builtSite(sb);
    const hub = sb.read(CACHING_HUB);
    const alpha = '<li><a href="./caching/alpha.html">Alpha</a></li>';
    const beta = '<li><a href="./caching/beta.html">Beta</a></li>';
    sb.write(CACHING_HUB, hub.replace(`${alpha}${beta}`, `${beta}${alpha}`));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([
      '[site-links] FAIL site/dist/patterns/caching.html: lists patterns/caching/beta.html before patterns/caching/alpha.html in one group, ' +
        'against the reading order of docs/data/site-structure.json — the hub generator keeps each group in reading order ' +
        '(tools/src/site/gen-site-hubs.ts, orderHub); rebuild: make site-build',
    ]);

    sb.write(CACHING_HUB, hub.replace(`${alpha}${beta}`, `<h2>Topic</h2>${beta}<h2>Other</h2>${alpha}`));
    expectPass(await sb.run(spec));
  });

  it('names a dead page, a dead anchor, an id only a code sample shows, and a climb out of the site', async () => {
    builtSite(sb);
    const beta = 'site/dist/patterns/caching/beta.html';
    sb.write(
      beta,
      sb
        .read(beta)
        .replace(
          '<p>Beta.</p>',
          '<p>Beta. <a href="./gone.html">x</a> <a href="./alpha.html#nowhere">y</a> <a href="./alpha.html#shown">z</a> <a href="../../../out.html">w</a> <a href="docs:page.html">v</a></p>' +
            '<pre><code><span id="shown">a sample</span></code></pre>',
        ),
    );
    const r = await sb.run(spec);
    expectFail(r);
    // In the page's own order, each link once.
    expect(r.err.split('\n')).toEqual([
      `[site-links] FAIL ${beta}: link './gone.html' → patterns/caching/gone.html does not exist`,
      `[site-links] FAIL ${beta}: link './alpha.html#nowhere' → patterns/caching/alpha.html has no element with id 'nowhere'`,
      `[site-links] FAIL ${beta}: link './alpha.html#shown' → patterns/caching/alpha.html has no element with id 'shown'`,
      `[site-links] FAIL ${beta}: link '../../../out.html' climbs out of the site root`,
      `[site-links] FAIL ${beta}: link 'docs:page.html' → patterns/caching/docs:page.html does not exist`,
    ]);
  });

  it('names a link to a repository file that is not in the tree, or to none, and passes one that is', async () => {
    builtSite(sb);
    sb.write('docs/patterns/singleton.md', '# Singleton\n');
    const beta = 'site/dist/patterns/caching/beta.html';
    const kept = `${REPO_BLOB}/docs/patterns/singleton.md#usage`;
    const typo = `${REPO_BLOB}/docs/patterns/singletno.md`;
    sb.write(beta, sb.read(beta).replace('<p>Beta.</p>', `<p>Beta. <a href="${kept}">kept</a> <a href="${typo}">typo</a> <a href="${REPO_BLOB}/">bare</a></p>`));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([
      `[site-links] FAIL ${beta}: link '${typo}' → docs/patterns/singletno.md is no file in this repository — fix the link in the page under docs/ and rebuild`,
      `[site-links] FAIL ${beta}: link '${REPO_BLOB}/' → the repository root is no file in this repository — fix the link in the page under docs/ and rebuild`,
    ]);
  });

  it('reads the repository path a GitHub file link names, and nothing from any other link', () => {
    expect(repoFileOf(`${REPO_BLOB}/docs/a%20b.md?plain=1#top`)).toBe('docs/a b.md');
    expect(repoFileOf(`${REPO_BLOB}/`)).toBe('');
    expect(repoFileOf('https://github.com/odere-pro/software-design-atlas')).toBeNull();
    expect(repoFileOf('./alpha.html')).toBeNull();
  });

  it('checks a fragment on the page itself, and a src or xlink:href in either quote style', async () => {
    builtSite(sb);
    const gamma = 'site/dist/hazards/gamma.html';
    sb.write(gamma, sb.read(gamma).replace('<p>Gamma.</p>', "<p>Gamma. <a href='#_top'>top</a> <a href='#gone'>gone</a></p><img src='../none.png'><svg><a xlink:href=\"../hazards.html#nope\"><text>h</text></a></svg>"));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toContain(`${gamma}: link '#gone' → hazards/gamma.html has no element with id 'gone'`);
    expect(r.err).toContain(`${gamma}: link '../none.png' → none.png does not exist`);
    expect(r.err).toContain(`${gamma}: link '../hazards.html#nope' → hazards.html has no element with id 'nope'`);
    expect(r.err).not.toContain("'#_top'");
  });

  it('names a root-absolute link in any quoting as its own finding, never as a path from the page folder', async () => {
    builtSite(sb);
    const home = 'site/dist/index.html';
    sb.write(home, sb.read(home).replace('</article>', "<p><a href='/patterns.html'>p</a> <img src=/favicon.svg alt=x></p></article>"));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([
      `[site-links] FAIL ${home}: link '/patterns.html' is root-absolute — from a folder it opens nothing; the post-build pass makes every link relative, so run make site-build`,
      `[site-links] FAIL ${home}: link '/favicon.svg' is root-absolute — from a folder it opens nothing; the post-build pass makes every link relative, so run make site-build`,
    ]);
  });

  it('names a folder of pages with no hub, and a page two hubs hold', async () => {
    builtSite(sb);
    sb.write('site/dist/extra/lone.html', builtPage({ route: '/extra/lone.html', title: 'Lone', area: 'hazards', body: '<p>Lone.</p>' }));
    const hazards = 'site/dist/hazards.html';
    sb.write(
      hazards,
      sb
        .read(hazards)
        .replace('Gamma</a></p>', 'Gamma</a> <a href="./extra/lone.html">Lone</a> <a href="./patterns/caching/beta.html">Beta</a> <a href="./patterns/caching/beta.html#_top">again</a></p>'),
    );
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toContain('[site-links] FAIL site/dist/extra: is a folder of pages with no hub page site/dist/extra.html');
    expect(r.err).toContain('[site-links] FAIL site/dist/patterns/caching/beta.html: is linked from 2 hubs — every page belongs to exactly one');
    expect(r.err).not.toContain('lone.html: is linked');
    expect(r.err.split('\n')).toHaveLength(2);
  });

  it('needs no hub for a folder holding only the row of a link area, and still names one holding any other page', async () => {
    builtSite(sb);
    const hub = { description: 'd', intro: 'i', tags: ['caching'] };
    const withLink = { areas: [...STRUCTURE.areas, { id: 'extra', label: 'Extra', nav: 'link', hub, pages: [{ slug: 'lone', label: 'Lone', source: 'site', route: '/extra/lone.html' }] }] };
    sb.write('docs/data/site-structure.json', `${JSON.stringify(withLink, null, 2)}\n`);
    sb.write('site/dist/extra/lone.html', builtPage({ route: '/extra/lone.html', title: 'Lone', area: 'extra', body: '<p>Lone.</p>' }));
    const home = 'site/dist/index.html';
    sb.write(home, sb.read(home).replace('Hazards</a>.</p>', 'Hazards</a>. <a href="./extra/lone.html">Lone</a></p>'));
    expectPass(await sb.run(spec));

    sb.write('site/dist/extra/other.html', builtPage({ route: '/extra/other.html', title: 'Other', area: 'extra', body: '<p>Other.</p>' }));
    sb.write(home, sb.read(home).replace('Lone</a>', 'Lone</a> <a href="./extra/other.html">Other</a>'));
    expectFail(await sb.run(spec), 'site/dist/extra: is a folder of pages with no hub page site/dist/extra.html');
  });

  it('names an unreadable learning-path file, and reads a profile with no id or stages as nothing to check', async () => {
    builtSite(sb);
    sb.write(LEARNING_PATHS, '{ not json');
    expectFail(await sb.run(spec), `${LEARNING_PATHS}: is not readable`);
    sb.write(LEARNING_PATHS, JSON.stringify({ profiles: [{ stages: ['/nowhere.html', 7] }, { id: 'empty' }] }));
    expectFail(await sb.run(spec), `${LEARNING_PATHS}: profile "?" stage /nowhere.html matches no built page`);
    sb.write(LEARNING_PATHS, JSON.stringify({ profile: [] }));
    expectFail(await sb.run(spec), `${LEARNING_PATHS}: is not readable`);
  });

  it('names an unreadable structure file, since which pages are hubs is its answer', async () => {
    builtSite(sb);
    sb.write('docs/data/site-structure.json', '{ nope');
    expectFail(await sb.run(spec), 'docs/data/site-structure.json: is not readable JSON');
  });

  it('reads each page once, however many links name it', async () => {
    builtSite(sb);
    const spy = vi.spyOn(fs, 'readFileSync');
    expectPass(await sb.run(spec));
    const pagesRead = spy.mock.calls.map((c) => String(c[0])).filter((f) => f.endsWith('.html'));
    expect(pagesRead).toHaveLength(new Set(pagesRead).size);
    expect(pagesRead).toHaveLength(7);
  });

  it('asks for a build over an empty site, an empty --dist, and takes a --dist with a trailing slash', async () => {
    sb.mkdir('site/dist');
    expectFail(await sb.run(spec), 'no .html files under site/dist — build it first: make site-build');
    expectFail(await sb.run(spec, ['--dist', '']), "no built site at '' — build it first: make site-build");
    builtSite(sb, 'out');
    expectPass(await sb.run(spec, ['--dist', 'out/']));
  });

  it('exits 2 on an unknown flag, writing nothing', async () => {
    builtSite(sb);
    const before = sb.snapshot();
    expectMisuse(await sb.run(spec, ['--nope']));
    expect(sb.snapshot()).toEqual(before);
  });
});

describe('the pieces', () => {
  it('tells somebody else’s URL from a link to resolve', () => {
    for (const u of ['https://x.org', 'http://x', 'mailto:a@b', 'tel:1', 'data:x', 'javascript:void(0)', '//cdn.x', 'ftp://x']) expect(isExternal(u)).toBe(true);
    for (const u of ['docs:page.html', './a.html', '../b.html#c', 'a.html?x=1']) expect(isExternal(u)).toBe(false);
  });

  it('resolves from the linking folder, and refuses a climb above the root', () => {
    expect(resolveFromRoot('a/b', '../c.html')).toBe('a/c.html');
    expect(resolveFromRoot('.', './x/./y.html')).toBe('x/y.html');
    expect(resolveFromRoot('a', '../../c.html')).toBeNull();
  });

  it('maps a stage to its built page', () => {
    expect(routeToPage('/')).toBe('index.html');
    expect(routeToPage('/patterns/caching/alpha.html')).toBe('patterns/caching/alpha.html');
    expect(routeToPage('/guides/authoring/')).toBe('guides/authoring.html');
  });

  it('splits a link into path and fragment, the query dropped, and reads a fragment as an id', () => {
    expect(splitUrl('a.html?q=1#frag')).toEqual({ target: 'a.html', frag: 'frag' });
    expect(splitUrl('#only')).toEqual({ target: '', frag: 'only' });
    expect(splitUrl('b.html?q')).toEqual({ target: 'b.html', frag: '' });
    expect(fragmentId('caf%C3%A9')).toBe('café');
    expect(fragmentId('100%')).toBe('100%');
  });

  it('collects ids and names outside code, and every link value once', () => {
    const html =
      '<h2 id="a">A</h2><a name="b" href="x.html">x</a><a href="x.html">again</a><pre id="p"><code><i id="in-code"></i></code></pre>' +
      '<script>var s = \'<b id="in-script">\';</script><code/><em id="after">e</em><img src=\'i.png\'><a href>bare</a>';
    const { anchors, urls } = readLinks(html);
    expect([...anchors].sort()).toEqual(['a', 'after', 'b']);
    expect(urls).toEqual(['x.html', 'i.png']);
  });

  it('cuts a hub body into its groups at each h2, keeping what leads them', () => {
    expect(hubRuns('<p>lead</p><h2>A</h2><a href="a.html">a</a><h2 id="b">B</h2>')).toEqual(['<p>lead</p>', '<h2>A</h2><a href="a.html">a</a>', '<h2 id="b">B</h2>']);
    expect(hubRuns('<h2>A</h2>x')).toEqual(['<h2>A</h2>x']);
    expect(hubRuns('')).toEqual([]);
  });

  it('ranks a run’s own-area pages once each, and nothing else it links', () => {
    const placed = new Map([
      ['p/a.html', { area: 'p', rank: 2 }],
      ['p/b.html', { area: 'p', rank: 1 }],
      ['q/c.html', { area: 'q', rank: 0 }],
    ]);
    const run =
      '<a href="#top">frag</a><a href="https://x.test/p/a.html">out</a><a href="/p/a.html">root</a>' +
      '<a href="../../../x.html">climb</a><a href="./p/a.html">A</a><a href="./q/c.html">C</a>' +
      '<a href="./p.html">hub</a><a href="./p/a.html#h">A again</a><a href="./p/b.html?x">B</a>';
    expect(rankedPages(run, '.', 'p', placed)).toEqual([
      { page: 'p/a.html', rank: 2 },
      { page: 'p/b.html', rank: 1 },
    ]);
  });

  it('finds the first pair out of reading order', () => {
    expect(outOfOrder([{ page: 'a', rank: 1 }, { page: 'b', rank: 3 }, { page: 'c', rank: 2 }])).toEqual(['b', 'c']);
    expect(outOfOrder([{ page: 'a', rank: 1 }, { page: 'b', rank: 2 }])).toBeNull();
    expect(outOfOrder([])).toBeNull();
  });

  it('counts a hub’s links up to its next-steps section, and nothing of a page with no region', () => {
    const hub = '<nav><a href="n.html">n</a></nav><div data-kb-region><p><a href="a.html">a</a></p><h2 id="next-steps">Next</h2><a href="b.html">b</a></div>';
    expect(readLinks(hubBody(hub)).urls).toEqual(['a.html']);
    expect(readLinks(hubBody('<div data-kb-region><a href="a.html">a</a></div>')).urls).toEqual(['a.html']);
    expect(hubBody('<p><a href="a.html">a</a></p>')).toBe('');
  });
});
