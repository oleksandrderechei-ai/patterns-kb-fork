/**
 * What the map page draws: the stack index, over a tiny structure of its own
 * and against the real tree, row by row against the page today's builder
 * writes (site/map/stack.html), while that page exists.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { PhrasingContent } from 'mdast';
import { parse } from 'node-html-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeSandbox, REPO_ROOT, type Sandbox } from './sandbox.js';
import {
  buildStack,
  cellHtml,
  DASH,
  escapeHtml,
  linkerOf,
  productLinker,
  SERVICE_COLUMNS,
  stackData,
  tableRows,
  type StackNotes,
  type Linkify,
  type Relation,
  type StackRow,
} from './site-map.js';
import type { Structure } from './site-routes.js';

const hub = { description: 'd', intro: 'i', tags: [] };

/** Two bands (one subdivided, one not), a hazard, a capability and a comparison, and a generated area. */
const STRUCTURE: Structure = {
  areas: [
    { id: 'patterns', label: 'Patterns', hub, pages: [] },
    { id: 'gof', label: 'Objects', nestUnder: 'patterns', hub: { ...hub, description: 'The book' }, pages: [] },
    {
      id: 'gof-creational',
      label: 'Creational',
      nestUnder: 'gof',
      hub,
      pages: [{ slug: 'singleton', label: 'Singleton', source: 'docs/patterns/gof/creational/singleton.md' }],
    },
    {
      id: 'caching',
      label: 'Caching',
      nestUnder: 'patterns',
      hub: { ...hub, description: 'Keeping answers close' },
      pages: [
        { slug: 'cache-aside', label: 'Cache-Aside', source: 'docs/patterns/caching/cache-aside.md' },
        { slug: 'write-through', label: 'Write-Through', source: 'docs/patterns/caching/write-through.md' },
        { slug: 'lonely', label: 'Lonely', source: 'docs/patterns/caching/lonely.md' },
      ],
    },
    { id: 'empty-band', label: 'Empty', nestUnder: 'patterns', hub, pages: [] },
    { id: 'hazards', label: 'Hazards', hub, pages: [{ slug: 'stale-cache', label: 'Stale Cache', source: 'docs/hazards/stale-cache.md' }] },
    {
      id: 'capabilities',
      label: 'Cloud capabilities',
      hub,
      pages: [
        { slug: 'caches', label: 'Caches & Stores', source: 'docs/capabilities/caches.md' },
        { slug: 'databases', label: 'Databases', source: 'docs/capabilities/databases.md' },
      ],
    },
    { id: 'comparisons', label: 'Comparisons', hub, pages: [{ slug: 'cache-servers', label: 'Cache servers', source: 'docs/comparisons/cache-servers.md' }] },
    { id: 'map', label: 'Map', generated: 'gen', hub, pages: [{ slug: 'stack', label: 'Stack', source: 'generated', route: '/map/stack.html' }] },
  ],
};

/** The capability page's mapping table, as the converter writes one. */
const CACHES = [
  '---',
  'title: Caches & Stores',
  '---',
  '',
  '## Mapping',
  '<!--meta block=mapping-->',
  '',
  '| Capability | AWS | Azure | Google Cloud | Open source |',
  '| --- | --- | --- | --- | --- |',
  '| Managed cache | Amazon ElastiCache | Azure Cache | Memorystore | [Redis](../comparisons/cache-servers.md#why), `valkey` |',
  '| Short row | only AWS |',
  '',
].join('\n');

const CACHE_SERVERS = ['## Matrix', '<!--meta block=matrix-->', '', '| Criterion | Redis | Valkey |', '| --- | --- | --- |', '| Survives a restart | *yes* | yes |', ''].join('\n');

/** Marks each linked cell with its column, so a test sees which provider it was linked for. */
const linkify: Linkify = (html, provider) => `${html}@${provider}`;

const docs: Record<string, string> = {
  'docs/capabilities/caches.md': CACHES,
  'docs/capabilities/databases.md': '# Databases\n',
  'docs/comparisons/cache-servers.md': CACHE_SERVERS,
};

/** The book's band is unbuyable as a whole; one caching pattern is unbuyable on its own. */
const NOTES: StackNotes = { bands: { gof: 'Inside one process.' }, patterns: { lonely: 'Code you write.' } };

function rowsOf(relations: Relation[], notes?: StackNotes): StackRow[] {
  const s = buildStack(STRUCTURE, relations, (source) => docs[source] ?? '', linkify, notes);
  return s.bands.flatMap((b) => b.groups.flatMap((g) => g.rows));
}

describe('the stack index', () => {
  it('bands the patterns in reading order, labelling the groups of a subdivided band only', () => {
    const s = buildStack(STRUCTURE, [], (x) => docs[x] ?? '', linkify, NOTES);
    expect(s.bands.map((b) => [b.id, b.label, b.description, b.groups.map((g) => g.label ?? '-')])).toEqual([
      ['gof', 'Objects', 'The book', ['Creational']],
      ['caching', 'Caching', 'Keeping answers close', ['-']],
    ]);
    expect(s.bands[0]?.unbuyable).toBe('Inside one process.');
    expect(s.bands[1]).not.toHaveProperty('unbuyable');
    expect([s.patterns, s.covered, s.rows]).toEqual([4, 0, 4]);
    expect([s.sold, s.byNature, s.open]).toEqual([0, 2, 2]);
  });

  it('tells a dash that is a verdict from a gap: a band note, or a reason of its own', () => {
    const rows = rowsOf([{ a: 'caches', verb: 'implements', b: 'cache-aside', maps_a: 'mapping-row-1' }], NOTES);
    expect(rows.map((r) => [r.pattern.title, r.state, r.reason ?? '-'])).toEqual([
      ['Singleton', 'none', '-'],
      ['Cache-Aside', 'mapped', '-'],
      ['Write-Through', 'gap', '-'],
      ['Lonely', 'none', 'Code you write.'],
    ]);
    expect(rows.find((r) => r.state === 'none' && r.reason !== undefined)?.cells).toEqual(SERVICE_COLUMNS.map(() => DASH));
    const s = buildStack(STRUCTURE, [{ a: 'caches', verb: 'implements', b: 'cache-aside' }], (x) => docs[x] ?? '', linkify, NOTES);
    expect([s.sold, s.byNature, s.open]).toEqual([1, 2, 1]);
  });

  it('refuses a reason a capability contradicts, one its band already gives, and a name the index does not hold', () => {
    const build = (relations: Relation[], notes: StackNotes) => () => buildStack(STRUCTURE, relations, (x) => docs[x] ?? '', linkify, notes);
    expect(build([{ a: 'caches', verb: 'implements', b: 'lonely' }], NOTES)).toThrow(
      'docs/data/stack.json says no cloud sells lonely, but caches implements it',
    );
    expect(build([], { bands: NOTES.bands, patterns: { singleton: 'x' } })).toThrow(
      'docs/data/stack.json gives singleton a reason of its own, but its band "gof" already says none of its patterns is for sale',
    );
    expect(build([], { bands: { ghost: 'x' }, patterns: { nobody: 'y', 'stale-cache': 'z' } })).toThrow(
      'docs/data/stack.json names band "ghost", pattern "nobody", pattern "stale-cache", which the stack index does not hold',
    );
  });

  it("copies a pinned mapping row's cells, links each for its column, and names the row it came from", () => {
    const [row] = rowsOf([{ a: 'caches', verb: 'implements', b: 'cache-aside', maps_a: 'mapping-row-1' }]).filter((r) => r.pattern.title === 'Cache-Aside');
    expect(row).toEqual({
      id: 'stack-cache-aside',
      pattern: { title: 'Cache-Aside', href: '/patterns/caching/cache-aside.html' },
      state: 'mapped',
      source: { title: 'Caches & Stores', href: '/capabilities/caches.html#mapping-row-1', html: 'Managed cache' },
      cells: [
        'Amazon ElastiCache@aws',
        'Azure Cache@azure',
        'Memorystore@google',
        '<a href="/comparisons/cache-servers.html#why">Redis</a>, <code>valkey</code>@oss',
      ],
      compare: [],
    });
  });

  it('dashes a column the pinned row does not have', () => {
    const [row] = rowsOf([{ a: 'caches', verb: 'implements', b: 'cache-aside', maps_a: 'mapping-row-2' }]).filter((r) => r.pattern.title === 'Cache-Aside');
    expect(row?.cells).toEqual(['only AWS@aws', DASH, DASH, DASH]);
  });

  it("links a capability's whole table when no row is pinned, or the pinned row is gone", () => {
    const rows = rowsOf([
      { a: 'caches', verb: 'implements', b: 'cache-aside' },
      { a: 'caches', verb: 'implements', b: 'write-through', maps_a: 'mapping-row-9' },
    ]);
    for (const title of ['Cache-Aside', 'Write-Through']) {
      const row = rows.find((r) => r.pattern.title === title);
      expect(row?.state).toBe('linked');
      expect(row?.source).toEqual({ title: 'Caches & Stores', href: '/capabilities/caches.html#mapping', html: 'all of Caches &amp; Stores' });
      expect(row?.cells).toEqual(SERVICE_COLUMNS.map(() => `<a href="/capabilities/caches.html#mapping">${DASH}</a>`));
    }
  });

  it('gives a pattern two capabilities sell one row each, capabilities first, the comparison chip on the first row only', () => {
    const rows = rowsOf([
      { a: 'cache-servers', verb: 'implements', b: 'cache-aside', maps_a: 'matrix-row-1' },
      { a: 'databases', verb: 'implements', b: 'cache-aside' },
      { a: 'caches', verb: 'implements', b: 'cache-aside', maps_a: 'mapping-row-1' },
    ]).filter((r) => r.pattern.title === 'Cache-Aside');
    expect(rows.map((r) => [r.id, r.source?.title, r.compare.length])).toEqual([
      ['stack-cache-aside', 'Caches & Stores', 1],
      ['stack-cache-aside-2', 'Databases', 0],
    ]);
    expect(rows[0]?.compare).toEqual([{ title: 'Cache servers', href: '/comparisons/cache-servers.html#matrix-row-1', criterion: 'Survives a restart' }]);
  });

  it('keeps the comparison chip off a later row that is pinned too', () => {
    const read = (source: string): string => (source === 'docs/capabilities/databases.md' ? CACHES : (docs[source] ?? ''));
    const rows = buildStack(
      STRUCTURE,
      [
        { a: 'cache-servers', verb: 'implements', b: 'cache-aside', maps_a: 'matrix-row-1' },
        { a: 'caches', verb: 'implements', b: 'cache-aside', maps_a: 'mapping-row-1' },
        { a: 'databases', verb: 'implements', b: 'cache-aside', maps_a: 'mapping-row-1' },
      ],
      read,
      linkify,
    )
      .bands.flatMap((b) => b.groups.flatMap((g) => g.rows))
      .filter((r) => r.pattern.title === 'Cache-Aside');
    expect(rows.map((r) => [r.state, r.source?.title, r.compare.length])).toEqual([
      ['mapped', 'Caches & Stores', 1],
      ['mapped', 'Databases', 0],
    ]);
  });

  it('rides a comparison on a gap row, linking its whole page when no criterion is pinned or found', () => {
    const rows = rowsOf([
      { a: 'cache-servers', verb: 'implements', b: 'write-through' },
      { a: 'cache-servers', verb: 'implements', b: 'lonely', maps_a: 'matrix-row-7' },
    ]);
    const write = rows.find((r) => r.pattern.title === 'Write-Through');
    expect(write?.state).toBe('gap');
    expect(write?.cells).toEqual(SERVICE_COLUMNS.map(() => DASH));
    expect(write?.compare).toEqual([{ title: 'Cache servers', href: '/comparisons/cache-servers.html' }]);
    expect(rows.find((r) => r.pattern.title === 'Lonely')?.compare).toEqual([{ title: 'Cache servers', href: '/comparisons/cache-servers.html' }]);
  });

  it('counts a pattern a comparison argues as covered, like one a capability sells', () => {
    const s = buildStack(STRUCTURE, [{ a: 'cache-servers', verb: 'implements', b: 'write-through' }], (x) => docs[x] ?? '', linkify);
    expect(s.covered).toBe(1);
  });

  it('reads only implements relations from a capability or a comparison to a published page', () => {
    const rows = rowsOf([
      { a: 'caches', verb: 'combines-with', b: 'cache-aside' },
      { a: 'stale-cache', verb: 'implements', b: 'cache-aside' },
      { a: 'caches', verb: 'implements', b: 'not-published' },
      { a: 'not-published', verb: 'implements', b: 'cache-aside' },
    ]);
    expect(rows.every((r) => r.state === 'gap')).toBe(true);
  });

  it('refuses to call a band unbuyable once a capability sells one of its patterns', () => {
    expect(() => buildStack(STRUCTURE, [{ a: 'caches', verb: 'implements', b: 'singleton' }], (x) => docs[x] ?? '', linkify, NOTES)).toThrow(
      'the stack index calls band "gof" unbuyable, but a capability implements singleton',
    );
    // A comparison arguing the choice is no product for sale: the band stays unbuyable.
    expect(() => buildStack(STRUCTURE, [{ a: 'cache-servers', verb: 'implements', b: 'singleton' }], (x) => docs[x] ?? '', linkify, NOTES)).not.toThrow();
  });

  it('reads each capability page once, however many rows it pins', () => {
    const read: string[] = [];
    buildStack(
      STRUCTURE,
      [
        { a: 'caches', verb: 'implements', b: 'cache-aside', maps_a: 'mapping-row-1' },
        { a: 'caches', verb: 'implements', b: 'write-through', maps_a: 'mapping-row-2' },
      ],
      (x) => {
        read.push(x);
        return docs[x] ?? '';
      },
      linkify,
    );
    expect(read).toEqual(['docs/capabilities/caches.md']);
  });
});

describe('cells and rows', () => {
  const routes = new Map([['docs/comparisons/cache-servers.md', '/comparisons/cache-servers.html']]);
  const cell = (md: string): PhrasingContent[] => [...tableRows(`## Mapping\n<!--meta block=mapping-->\n\n| a |\n| - |\n| ${md} |\n`).values()][0]?.[0] ?? [];

  it("turns a cell into inner HTML, a published page's link into its route with the fragment kept", () => {
    expect(cellHtml(cell('[R](../comparisons/cache-servers.md#x) and [S](../comparisons/cache-servers.md)'), 'docs/capabilities/caches.md', routes)).toBe(
      '<a href="/comparisons/cache-servers.html#x">R</a> and <a href="/comparisons/cache-servers.html">S</a>',
    );
  });

  it('leaves an external link, an unpublished target and an anchor as written', () => {
    expect(cellHtml(cell('[E](https://e.test) [U](./nowhere.md) [A](#top)'), 'docs/capabilities/caches.md', routes)).toBe(
      '<a href="https://e.test">E</a> <a href="./nowhere.md">U</a> <a href="#top">A</a>',
    );
  });

  it('rewrites a link nested in emphasis, and never changes the tree it was given', () => {
    const nodes = cell('**[R](../comparisons/cache-servers.md)**');
    expect(cellHtml(nodes, 'docs/capabilities/caches.md', routes)).toBe('<strong><a href="/comparisons/cache-servers.html">R</a></strong>');
    expect(JSON.stringify(nodes)).toContain('../comparisons/cache-servers.md');
  });

  it('finds every table row by its id', () => {
    expect([...tableRows(CACHES).keys()]).toEqual(['mapping-row-1', 'mapping-row-2']);
  });

  it('escapes the characters HTML reads as markup', () => {
    expect(escapeHtml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; &quot;c&quot;');
  });
});

describe('linkerOf', () => {
  const linkify = linkerOf({ aws: { SQS: 'https://sqs.test/', 'Amazon SQS': 'https://amazon-sqs.test/', Batch: 'https://batch.test/' }, oss: {} });
  const a = (href: string, name: string): string => `<a class="kb-product" href="${href}" target="_blank" rel="noopener noreferrer">${name}</a>`;

  it('links the longest registered name, whole words only, in its own provider column', () => {
    expect(linkify('Amazon SQS, then SQS', 'aws')).toBe(`${a('https://amazon-sqs.test/', 'Amazon SQS')}, then ${a('https://sqs.test/', 'SQS')}`);
    expect(linkify('Batching and Batch', 'aws')).toBe(`Batching and ${a('https://batch.test/', 'Batch')}`);
    expect(linkify('SQS', 'azure')).toBe('SQS');
    expect(linkify('SQS', 'oss')).toBe('SQS');
    expect(linkify('', 'aws')).toBe('');
  });

  it('never links inside an existing link, a code span or a tag', () => {
    const cell = '<a href="../comparisons/queues.md">SQS</a> <code>SQS</code> <span title="SQS">x</span> SQS';
    expect(linkify(cell, 'aws')).toBe(`<a href="../comparisons/queues.md">SQS</a> <code>SQS</code> <span title="SQS">x</span> ${a('https://sqs.test/', 'SQS')}`);
  });
});

describe('reading a tree', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => sb.cleanup());

  it('reads the stack index from the data files and the pages, linking products through the registry', async () => {
    sb.write('docs/data/site-structure.json', JSON.stringify(STRUCTURE));
    sb.write('docs/data/relations.json', JSON.stringify({ relations: [{ a: 'caches', verb: 'implements', b: 'cache-aside', maps_a: 'mapping-row-1' }] }));
        for (const p of STRUCTURE.areas.flatMap((a) => a.pages)) {
      if (p.source !== 'generated') sb.write(p.source, docs[p.source] ?? `---\ntitle: ${p.label}\n${p.slug === 'lonely' ? 'favourite: true\n' : ''}---\n`);
    }
    sb.write('docs/data/products.json', JSON.stringify({ products: { aws: { 'Amazon ElastiCache': 'https://aws.test/' } } }));
    const s = await stackData(sb.dir);
    const row = s.bands.flatMap((b) => b.groups.flatMap((x) => x.rows)).find((r) => r.state === 'mapped');
    expect(row?.cells[0]).toBe('<a class="kb-product" href="https://aws.test/" target="_blank" rel="noopener noreferrer">Amazon ElastiCache</a>');
    expect(row?.cells[1]).toBe('Azure Cache');
    expect(typeof (await productLinker(sb.dir))).toBe('function');
  });

  it('links nothing when the product registry has no products', async () => {
    sb.write('docs/data/products.json', JSON.stringify({ version: 1 }));
    expect((await productLinker(sb.dir))('Amazon ElastiCache', 'aws')).toBe('Amazon ElastiCache');
  });
});

describe('the real tree', () => {
  it('reads its verdicts from stack.json, and every count adds up', async () => {
    const s = await stackData(REPO_ROOT);
    expect(s.bands.find((b) => b.id === 'gof')?.unbuyable).toMatch(/inside one process/);
    expect(s.sold + s.byNature + s.open).toBe(s.patterns);
  });

  it("lists the rows today's stack page lists, cell for cell", async () => {
    const today = path.join(REPO_ROOT, 'site/map/stack.html');
    // The HTML page leaves at the cutover, and this comparison with it.
    if (!fs.existsSync(today)) return;
    const text = (html: string): string => parse(html).text.replace(/\s+/g, ' ').trim();
    const want = parse(fs.readFileSync(today, 'utf8'))
      .querySelectorAll('table.stack-table tbody tr')
      .map((tr) => tr.querySelectorAll('td').map((td) => text(td.innerHTML)));
    const s = await stackData(REPO_ROOT);
    const got = s.bands
      .flatMap((b) => b.groups.flatMap((g) => g.rows))
      .map((r) => [
        text(`${r.pattern.title}${r.source === undefined ? '' : r.source.html}${r.compare.map((c) => `Compare ${c.title}`).join('')}`),
        ...r.cells.map(text),
      ]);
    expect(got).toEqual(want);
    expect(s.rows).toBe(want.length);
  });
});
