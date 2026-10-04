/**
 * The map and the page tree reach each other both ways (spec:
 * kb.content.docs-map): every page is one link from docs/README.md or two
 * through a hub it links, and every `.md` link on the map and its hubs lands.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAP_PAGE, mappedTree, mapText as mapPage, PAGE_ALPHA, PAGE_GUIDE, PAGE_THEME, structureJson } from '../lib/fixtures.js';
import { capture, expectFail, expectMisuse, expectPass, makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';
import { spec as frontmatterGate } from './check-doc-frontmatter.js';
import { isHub, LAYER, MAP, markdownLinksOf, spec } from './check-docs-map.js';
import { spec as shapeGate } from './check-docs-style.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

/** The real tree is 380-odd pages: on a loaded machine one run outlasts the suite's default. */
const REAL_TREE_TIMEOUT = 180_000;

const PAGE_A = 'docs/reference/a.md';
const HUB = 'docs/guides/README.md';
const PAGE_B = 'docs/guides/b.md';
const PAGE_C = 'docs/reference/c.md';

/** A map whose rows link `targets`, several to a cell. */
const mapText = (...cells: string[]): string =>
  ['# Docs map', '', 'Every page, one link away.', '', '| Pages | Read it when |', '| --- | --- |', ...cells.map((c) => `| ${c} | you need it |`), ''].join('\n');

/** The findings a run printed. */
const findings = (err: string): string[] => err.split('\n').filter((l) => l.startsWith('[docs-map] FAIL'));

/** docs-map-O1's tree: the map links A and a hub, the hub links B; the layer and C are linked nowhere. */
function scenarioTree(): void {
  sb.write(MAP, mapText('[A](reference/a.md)', '[Guides](guides/README.md)'));
  sb.write(HUB, '# Guides\n\n- [B](b.md)\n');
  sb.write(PAGE_A, '# A\n');
  sb.write(PAGE_B, '# B\n');
  sb.write(PAGE_C, '# C\n');
  sb.write(LAYER, '# Working in docs/\n');
}

it('docs-map-O1: C is the one finding; deleting A, then B, gives one finding each, on the map and the hub; the layer never appears', async () => {
  scenarioTree();
  const unlinked = await sb.run(spec);
  expectFail(unlinked);
  expect(unlinked.out).toBe('');
  expect(findings(unlinked.err)).toEqual([`[docs-map] FAIL ${PAGE_C}: no link from ${MAP}, directly or from a hub it links — an unlisted page is a page nobody finds`]);

  sb.rm(PAGE_C);
  expectPass(await sb.run(spec));

  sb.rm(PAGE_A);
  const noA = await sb.run(spec);
  expectFail(noA);
  expect(findings(noA.err)).toEqual([`[docs-map] FAIL ${MAP}: links ${PAGE_A}, which does not exist — fix the row or delete it`]);

  sb.write(PAGE_A, '# A\n');
  sb.rm(PAGE_B);
  const noB = await sb.run(spec);
  expectFail(noB);
  expect(findings(noB.err)).toEqual([`[docs-map] FAIL ${HUB}: links ${PAGE_B}, which does not exist`]);

  for (const r of [unlinked, noA, noB]) expect(r.err).not.toContain(LAYER);
});

/**
 * content-O1 and content-O2 hold the unit's three gates to one tree, so they
 * live with the last of the three to be built. The published page is the
 * fixture tree's fourth structure row.
 */
describe('the page contract (kb.content)', () => {
  const NEW = 'docs/reference/new.md';

  /**
   * content-O1's page. This KB's block has seven required keys (`status`
   * too), so with `owner` gone the block closes on line 8 and the body starts
   * on line 9: the H4 opens the body there, and the H1 and its intro follow,
   * so each of the three gates has exactly one thing to find.
   */
  const BROKEN = [
    '---',
    'title: New',
    'description: A page added without its owner or its map row',
    'area: reference',
    'tags: [testing, readability]',
    'status: stable',
    '---',
    '#### Too deep',
    '',
    '# New',
    '',
    'What this page is, and who it is for.',
    '',
    '## About',
    '',
    'More.',
    '',
  ].join('\n');

  const REPAIRED = BROKEN.replace('status: stable\n', 'status: stable\nowner: Tests\n').replace('#### Too deep\n\n', '');

  const EXERCISE = 'docs/exercises/caching/warm-up.md';
  /** An exercise, in its own regime: no intro before its first H2, which the shape gate would fail on a page it measured. */
  const EXERCISE_TEXT = ['---', 'description: Warm a cache before the traffic arrives.', 'area: caching', 'type: exercise', 'level: [beginner]', 'tags: [caching, latency, testing]', '---', '', '# Warm up', '', '## Try it', '', 'Fill the cache, then send the load.', ''].join('\n');

  const LINKS = { Alpha: 'patterns/caching/alpha.md', Tour: 'themes/tour.md', Guide: 'reference/guide.md' };

  function publishedTree(): void {
    mappedTree(sb);
    sb.write('docs/data/site-structure.json', structureJson({ caching: [PAGE_ALPHA], 'themes-data': [PAGE_THEME], reference: [PAGE_GUIDE, NEW] }));
    sb.write(NEW, BROKEN);
  }

  it('content-O1: no owner, an H4 on line 9 and no map row: the frontmatter, shape and map gates each exit 1 with their one finding', async () => {
    publishedTree();

    const fm = await sb.run(frontmatterGate);
    expectFail(fm);
    expect(fm.err.split('\n').filter((l) => l.startsWith('[frontmatter] FAIL'))).toEqual([`[frontmatter] FAIL ${NEW}: missing required key: owner`]);

    const shape = await sb.run(shapeGate);
    expectFail(shape);
    const cited = shape.err.split('\n').filter((l) => /^[A-Z]+-[0-9]+ /.test(l));
    expect(cited).toHaveLength(1);
    expect(cited[0]).toMatch(new RegExp(`^PAGE-002 ${NEW}:8 \\S.* \\(docs/reference/page-rules\\.md#PAGE-002\\)$`));
    expect(shape.err).not.toContain('FAIL');

    const map = await sb.run(spec);
    expectFail(map);
    expect(findings(map.err)).toEqual([`[docs-map] FAIL ${NEW}: no link from ${MAP}, directly or from a hub it links — an unlisted page is a page nobody finds`]);
  });

  it('content-O2: repaired, plus one exercise, the three gates each exit 0 with one summary line; the shape gate skips the exercise', async () => {
    publishedTree();
    sb.write(NEW, REPAIRED);
    sb.write(EXERCISE, EXERCISE_TEXT);
    sb.write(MAP_PAGE, mapPage({ ...LINKS, New: 'reference/new.md', 'Warm up': 'exercises/caching/warm-up.md' }));

    const fm = await sb.run(frontmatterGate);
    expectPass(fm);
    expect(fm.out).toBe('[frontmatter] OK — 5 pages, 1 exercises');
    expect(fm.err).toBe('');

    const shape = await sb.run(shapeGate);
    expectPass(shape);
    expect(shape.out).toBe('[docs-style] OK — 4 page(s) keep the shape of docs/reference/page-rules.md');
    expect(shape.err).toBe('');
    // Named, the exercise is still not the shape gate's to measure.
    const named = await sb.run(shapeGate, [EXERCISE]);
    expectPass(named);
    expect(named.err).toBe('');

    const map = await sb.run(spec);
    expectPass(map);
    expect(map.out).toBe(`[docs-map] OK — ${MAP} reaches 5 page(s) through 0 hub(s), and every link on it leads somewhere`);
    expect(map.err).toBe('');

    // The map gate still wants the exercise's link: an exercise is a page to find.
    sb.write(MAP_PAGE, mapPage({ ...LINKS, New: 'reference/new.md' }));
    expect(findings((await sb.run(spec)).err)).toEqual([`[docs-map] FAIL ${EXERCISE}: no link from ${MAP}, directly or from a hub it links — an unlisted page is a page nobody finds`]);
  });
});

describe('the map gate', () => {
  it('a clean tree: exit 0, one summary line, nothing on stderr', async () => {
    scenarioTree();
    sb.rm(PAGE_C);
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe(`[docs-map] OK — ${MAP} reaches 3 page(s) through 1 hub(s), and every link on it leads somewhere`);
    expect(r.err).toBe('');
  });

  it('a page linked only from an ordinary page is unmapped: only a hub’s links map', async () => {
    sb.write(MAP, mapText('[A](reference/a.md)'));
    sb.write(PAGE_A, '# A\n\nSee [C](c.md).\n');
    sb.write(PAGE_C, '# C\n');
    expectFail(await sb.run(spec), `FAIL ${PAGE_C}: no link from ${MAP}`);
  });

  it('a row linking a missing hub: the map names it, the hub is not read, each page it listed is unmapped', async () => {
    scenarioTree();
    sb.rm(PAGE_C);
    sb.rm(HUB);
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([
      `[docs-map] FAIL ${MAP}: links ${HUB}, which does not exist — fix the row or delete it`,
      `[docs-map] FAIL ${PAGE_B}: no link from ${MAP}, directly or from a hub it links — an unlisted page is a page nobody finds`,
    ]);
  });

  it('a nested layer and a loose working file are pages: each needs its link', async () => {
    sb.write(MAP, mapText('[A](reference/a.md)'));
    sb.write(PAGE_A, '# A\n');
    sb.write('docs/reference/CLAUDE.md', '# Reference layer\n');
    sb.write('docs/notes/sweep.md', '# Sweep\n');
    const r = await sb.run(spec);
    expect(findings(r.err).map((l) => l.split(':')[0])).toEqual(['[docs-map] FAIL docs/notes/sweep.md', '[docs-map] FAIL docs/reference/CLAUDE.md']);
    sb.write(MAP, mapText('[A](reference/a.md) · [layer](reference/CLAUDE.md) · [sweep](notes/sweep.md)'));
    expectPass(await sb.run(spec));
  });

  it('three links in one cell: deleting any one page yields exactly one finding', async () => {
    const pages = ['docs/reference/x.md', 'docs/reference/y.md', 'docs/reference/z.md'];
    sb.write(MAP, mapText('[X](reference/x.md) · [Y](reference/y.md) · [Z](reference/z.md)'));
    for (const p of pages) sb.write(p, '# P\n');
    expectPass(await sb.run(spec));
    for (const gone of pages) {
      sb.rm(gone);
      const r = await sb.run(spec);
      expect(findings(r.err), gone).toEqual([`[docs-map] FAIL ${MAP}: links ${gone}, which does not exist — fix the row or delete it`]);
      sb.write(gone, '# P\n');
    }
  });

  it('never reads an address, a protocol-relative link, a bare anchor, a non-page target or a fenced sample as a row', async () => {
    sb.write(
      MAP,
      [
        '---',
        'related: "[fm](reference/front.md)"',
        '---',
        mapText('[A](reference/a.md "the A page") [web](https://example.com/x.md) [cdn](//cdn.example.com/y.md) [top](#pages)', '[data](data/gates.json) [q](reference/a.md?plain=1#top)'),
        '```markdown',
        '[sample](reference/sample.md)',
        '```',
        '',
      ].join('\n'),
    );
    sb.write(PAGE_A, '# A\n');
    expectPass(await sb.run(spec));
  });

  it('a commented-out row or a link in a code span maps nothing, and a dead one there is no finding', async () => {
    sb.write(MAP, `${mapText('[A](reference/a.md)')}\n<!-- | [C](reference/c.md) | you need it | -->\n\nA sample row: \`[old](reference/gone.md)\`, and \`\`[C](reference/c.md)\`\`.\n`);
    sb.write(PAGE_A, '# A\n');
    sb.write(PAGE_C, '# C\n');
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([`[docs-map] FAIL ${PAGE_C}: no link from ${MAP}, directly or from a hub it links — an unlisted page is a page nobody finds`]);
  });

  it('a row whose case differs from the page is dead, as the CI runner reads it, and maps nothing', async () => {
    sb.write(MAP, mapText('[A](reference/A.md)'));
    sb.write(PAGE_A, '# A\n');
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([
      `[docs-map] FAIL ${MAP}: links docs/reference/A.md, which does not exist — fix the row or delete it`,
      `[docs-map] FAIL ${PAGE_A}: no link from ${MAP}, directly or from a hub it links — an unlisted page is a page nobody finds`,
    ]);
  });

  it('a committed page deleted from disk is no longer a page', async () => {
    sb.write(MAP, mapText('[A](reference/a.md)'));
    sb.write(PAGE_A, '# A\n');
    sb.write(PAGE_C, '# C\n');
    sb.commit('pages');
    sb.rm(PAGE_C);
    expectPass(await sb.run(spec));
  });

  it('a missing map is one finding and nothing else is checked', async () => {
    sb.write(PAGE_A, '# A\n');
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([`[docs-map] FAIL ${MAP}: is missing — the docs map is the one page every page is reached from`]);
  });

  it('any argument, --fix included, exits 2 before anything is read, and no run writes', async () => {
    scenarioTree();
    const before = sb.snapshot();
    for (const argv of [['--fix'], ['--nope'], [PAGE_A]]) {
      const r = await sb.run(spec, argv);
      expectMisuse(r);
      expect(r.out).toBe('');
    }
    await sb.run(spec);
    expect(sb.snapshot()).toEqual(before);
  });
});

describe('the helpers', () => {
  it('reads a file’s .md targets, resolved; nothing from a missing file', () => {
    sb.write('docs/guides/README.md', '# G\n\n[b](b.md) [up](../reference/a.md#x) [img](p.png)\n');
    expect(markdownLinksOf(sb.dir, 'docs/guides/README.md')).toEqual(['docs/guides/b.md', 'docs/reference/a.md']);
    expect(markdownLinksOf(sb.dir, 'docs/nope.md')).toEqual([]);
  });

  it('knows a hub: a README under the page tree that is not the map', () => {
    expect(isHub('docs/guides/README.md')).toBe(true);
    expect(isHub(MAP)).toBe(false);
    expect(isHub('README.md')).toBe(false);
    expect(isHub('docs/guides/index.md')).toBe(false);
  });
});

it(
  'holds the real tree',
  async () => {
    const r = await capture(spec, [], REPO_ROOT);
    expectPass(r);
    expect(r.out).toMatch(/^\[docs-map\] OK — docs\/README\.md reaches \d+ page\(s\) through \d+ hub\(s\)/);
  },
  REAL_TREE_TIMEOUT,
);
