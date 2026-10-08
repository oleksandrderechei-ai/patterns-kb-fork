/**
 * The parity gate (spec kb.pagedata.two-layers): a built site whose HTML, record
 * and markdown say the same thing passes, and each way one of them can say
 * something else is named by the page, the element and both readings. The site
 * is the parity fixture, built from the repo's own code; each test breaks one
 * file of it, the way a build that read a page two ways would have.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PageGraph, PageRecord } from '../kb/record.js';
import { expectFail, expectMisuse, expectPass, makeSandbox, REPO_ROOT, type Captured, type Sandbox } from '../lib/sandbox.js';
import type { Content } from '../lib/kb-record.js';
import { readPageRecord } from '../site/page-record-read.js';
import { paritySite, writeParitySite } from '../site/parity-fixtures.js';
import { builtSite } from '../site/site-fixtures.js';

import { COMPARED, expectedElements, graphDiffs, indexDiffs, introWords, markdownDiffs, pageDiffs, PROJECTIONS, SHOWN, spec, type Surface } from './check-site-parity.js';

const DIST = 'site/dist';
const BREAKER = `${DIST}/patterns/distributed/resilience/breaker`;
const RETRY = `${DIST}/patterns/distributed/resilience/retry`;
const BOUNDARY = `${DIST}/principles/boundary`;

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
  writeParitySite(sb);
});
afterEach(() => sb.cleanup());

const run = (): Promise<Captured> => sb.run(spec);

/** Replace one stretch of a file, which has to be there. */
function edit(file: string, from: string | RegExp, to: string): void {
  const text = sb.read(file);
  const next = text.replace(from, to);
  expect(next, `${file} holds ${String(from)}`).not.toBe(text);
  sb.write(file, next);
}

/** A JSON file, changed by a function and written back as the build writes it. */
function editJson<T>(file: string, change: (value: T) => void): void {
  const value = JSON.parse(sb.read(file)) as T;
  change(value);
  sb.write(file, `${JSON.stringify(value, null, 2)}\n`);
}

const findings = (r: Captured): string[] => r.err.split('\n').filter((l) => l.startsWith('[site-parity] FAIL'));

/** The fixture's records and graph, to hand to the functions the gate is made of. */
const site = paritySite();
const records = new Map(site.records.map((r) => [r.id, r]));
const recordOf = (id: string): PageRecord => structuredClone(records.get(id) as PageRecord);
const graphOf = (): PageGraph => JSON.parse(site.dist.get('graph.json') as string) as PageGraph;
const htmlOf = (id: string): string => site.dist.get((records.get(id) as PageRecord).route.slice(1)) as string;
const readOf = (id: string, change: (html: string) => string = (h) => h) => readPageRecord(change(htmlOf(id))) as NonNullable<ReturnType<typeof readPageRecord>>;

describe('a site whose HTML, record and markdown agree', () => {
  it('passes, and says how much it read', async () => {
    const r = await run();
    expectPass(r);
    const pages = site.records.length;
    const elements = site.records.reduce((n, rec) => n + Object.keys(rec.anchors).length, 0);
    const relations = site.records.reduce((n, rec) => n + rec.relations.length, 0);
    expect(r.out).toBe(`[site-parity] ${pages} pages, ${elements} elements, ${relations} relations and ${graphOf().edges.length} graph edges: the HTML, the record and the markdown say the same thing`);
    expect(pages).toBeGreaterThan(10);
    expect(relations).toBeGreaterThan(0);
  });

  it('says the same on a second run, and writes nothing', async () => {
    const before = sb.snapshot();
    const first = await run();
    const second = await run();
    expect(second.output).toBe(first.output);
    expect(sb.snapshot()).toEqual(before);
  });

  it('reads past an id on a heading the record gave none, a raw anchor, and pages that are no part of the knowledge base', async () => {
    edit(`${BREAKER}.html`, '<p id="description-p-1">', '<p id="description-p-1"><a id="raw-anchor"></a>');
    edit(`${BOUNDARY}.html`, '<h4 id="a-deeper-heading">', '<h4 id="a-deeper-heading" data-x="1">');
    editJson<{ pages: Record<string, unknown>[] }>(`${DIST}/index.json`, (index) => {
      index.pages.unshift({
        route: '/index.html',
        title: 'KB',
        description: '',
        area: 'patterns',
        owner: 'Test Owner',
        status: 'stable',
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
    });
    expectPass(await run());
  });

  it('collapses ASCII whitespace in the page and nothing else', async () => {
    edit(`${BREAKER}.html`, 'Frees threads.', 'Frees \n\t  threads.');
    expectPass(await run());
  });
});

describe('the HTML against the record', () => {
  it('names a changed word by its id, with both readings', async () => {
    edit(`${BREAKER}.html`, 'Fails fast.', 'Fails slow.');
    const r = await run();
    expectFail(r);
    expect(findings(r)).toEqual(['[site-parity] FAIL site/dist/patterns/distributed/resilience/breaker.html: #tradeoffs-pro-1: the words differ — html "Fails slow." record "Fails fast."']);
  });

  it('shows the stretch of a long text that holds the first difference', async () => {
    edit(`${BREAKER}.html`, 'so measure it', 'so weigh it');
    const r = await run();
    expectFail(r, /#explain-text: the words differ — html "…[^"]*so weigh it[^"]*…" record "…[^"]*so measure it[^"]*…"/);
    expect(findings(r)).toHaveLength(1);
  });

  it('reads a no-break space as text, and shows it so that the finding is not two lines that look alike', async () => {
    edit(`${BREAKER}.html`, 'Frees threads.', 'Frees&nbsp;threads.');
    const r = await run();
    expectFail(r, '#tradeoffs-pro-2: the words differ — html "Frees\\u00a0threads." record "Frees threads."');
  });

  it('names a fact the article states otherwise, and one it does not state', async () => {
    edit(`${BREAKER}.html`, 'data-kind="pattern"', 'data-kind="hazard"');
    edit(`${BREAKER}.html`, ' data-band="distributed"', '');
    edit(`${BREAKER}.html`, 'data-tags="resilience,latency"', 'data-tags="latency,resilience"');
    const r = await run();
    expectFail(r, 'breaker.html: the article\'s data-tags differs — html "latency,resilience" record "resilience,latency"');
    expectFail(r, 'the article\'s data-band differs — html none record "distributed"');
    expectFail(r, 'the article\'s data-kind differs — html "hazard" record "pattern"');
  });

  it('names the blocks of another order or name, and each element that moved with one', async () => {
    edit(`${BREAKER}.html`, '<section data-block="usage">', '<section data-block="when">');
    const r = await run();
    expectFail(r, /the blocks differ — html "[^"]*when[^"]*" record "[^"]*usage[^"]*"/);
    expectFail(r, '#usage-when-1: the block differs — html "when" record "usage"');
  });

  it('names an item under the wrong polarity', async () => {
    edit(`${BREAKER}.html`, '<section data-polarity="pro">', '<section data-polarity="con">');
    const r = await run();
    expectFail(r, '#tradeoffs-pro-1: the group differs — html "con" record "pro"');
    expectFail(r, '#tradeoffs-pro-2: the group differs — html "con" record "pro"');
  });

  it('names an element that stands outside the group the record puts it in', async () => {
    edit(`${BREAKER}.html`, '<section data-polarity="avoid">', '<section>');
    const r = await run();
    expectFail(r, '#usage-avoid-1: the group differs — html none record "avoid"');
  });

  it('names an id the HTML lacks, and an id the record lacks', async () => {
    edit(`${BREAKER}.html`, ' id="tradeoffs-con-1"', '');
    edit(`${BOUNDARY}.html`, '<p>A plain quote about edges.</p>', '<p id="stray-id">A plain quote about edges.</p>');
    const r = await run();
    expectFail(r, '#tradeoffs-con-1: the html has no element with this id — html none record "<li>"');
    expectFail(r, '#stray-id: the record has no element with this id — html "<p>" record none');
  });

  it('names an element that is another kind from the one the record gives the id', async () => {
    edit(`${BREAKER}.html`, '<p id="description-p-1">', '<span id="description-p-1">');
    edit(`${BREAKER}.html`, /(<span id="description-p-1">[^]*?)<\/p>/, '$1</span>');
    const r = await run();
    expectFail(r, '#description-p-1: the element differs — html "<span>" record "<p>"');
  });

  it('names an id on two elements', async () => {
    edit(`${BREAKER}.html`, '<li id="tradeoffs-pro-2">', '<li id="tradeoffs-pro-1">');
    const r = await run();
    expectFail(r, '#tradeoffs-pro-1: the id is on a second element — html "<li>" record "one element"');
    expectFail(r, '#tradeoffs-pro-2: the html has no element with this id');
  });

  it('names the first place the elements are in another order', async () => {
    edit(`${BREAKER}.html`, 'id="tradeoffs-pro-1"', 'id="swap"');
    edit(`${BREAKER}.html`, 'id="tradeoffs-pro-2"', 'id="tradeoffs-pro-1"');
    edit(`${BREAKER}.html`, 'id="swap"', 'id="tradeoffs-pro-2"');
    const r = await run();
    expectFail(r, /the elements are in another order, first at position \d+ — html "#tradeoffs-pro-2" record "#tradeoffs-pro-1"/);
  });

  it('names a relation item whose verb differs, and one whose target differs', async () => {
    edit(`${BREAKER}.html`, 'data-verb="combines-with" data-to="retry"', 'data-verb="alternative-to" data-to="retry"');
    edit(`${BREAKER}.html`, 'data-verb="prevents-hazard" data-to="storm"', 'data-verb="prevents-hazard" data-to="queue"');
    const r = await run();
    expectFail(r, 'relation 1 differs — html "alternative-to retry" record "combines-with retry"');
    expectFail(r, 'relation 2 differs — html "prevents-hazard queue" record "prevents-hazard storm"');
  });

  it('names a relation item the page states and the record lacks', async () => {
    edit(`${BREAKER}.html`, '<!-- relationships:end -->', '<ul><li data-verb="extra" data-to="page">x</li></ul><!-- relationships:end -->');
    expectFail(await run(), 'relation 3 differs — html "extra page" record none');
  });

  it('names a relation the page does not state at all', async () => {
    edit(`${BREAKER}.html`, ' data-verb="prevents-hazard" data-to="storm"', '');
    const r = await run();
    expectFail(r, 'relation 2 differs — html none record "prevents-hazard storm"');
  });

  it('names a prerequisite list that differs, in either of the two', async () => {
    edit(`${BREAKER}.html`, 'data-related="retry"', 'data-related="queue"');
    edit(`${BREAKER}.html`, 'data-requires=""', 'data-requires="retry"');
    const r = await run();
    expectFail(r, 'the card\'s data-related differs — html "queue" record "retry"');
    expectFail(r, 'the card\'s data-requires differs — html "retry" record ""');
  });

  it('names an intro paragraph that says something else', async () => {
    edit(`${BREAKER}.html`, 'Stops calling a failing thing', 'Stops calling a failing item');
    const r = await run();
    expectFail(r, /breaker\.html: intro paragraph 1 differs — html "[^"]*failing item[^"]*" record "[^"]*failing thing[^"]*"/);
  });

  it('names a page that is not there, and a page with no knowledge region', async () => {
    sb.rm(`${RETRY}.html`);
    edit(`${BOUNDARY}.html`, 'data-kb-region', 'data-kb-regio');
    const r = await run();
    expectFail(r, 'retry.html: is missing — build it first: make site-build');
    expectFail(r, 'boundary.html: has no knowledge region to read — build it first: make site-build');
  });

  it('shows five findings of a page and counts the rest', async () => {
    edit(`${BREAKER}.html`, /<li id="/g, '<li id="x-');
    const total = pageDiffs(recordOf('breaker'), readOf('breaker', (h) => h.replace(/<li id="/g, '<li id="x-'))).length;
    const r = await run();
    expectFail(r);
    const own = findings(r).filter((l) => l.includes('breaker.html'));
    expect(total).toBeGreaterThan(SHOWN + 1);
    expect(own).toHaveLength(SHOWN + 1);
    expect(own.at(-1)).toBe(`[site-parity] FAIL site/dist/patterns/distributed/resilience/breaker.html: and ${total - SHOWN} more`);
  });

  it('goes on to the next page after one that has findings', async () => {
    edit(`${BREAKER}.html`, 'Fails fast.', 'Fails slow.');
    edit(`${RETRY}.html`, 'Recovers blips.', 'Recovers nothing.');
    const r = await run();
    expectFail(r, 'breaker.html: #tradeoffs-pro-1');
    expectFail(r, 'retry.html: #tradeoffs-pro-1');
  });
});

describe('the markdown against the record', () => {
  it('names a changed word by its id, and the hash that does not match', async () => {
    edit(`${BREAKER}.md`, '- Fails fast.', '- Fails slow.');
    const r = await run();
    expectFail(r, /breaker\.md: the markdown is not the file the record's source\.sha256 names — md "[0-9a-f]{12}" record "[0-9a-f]{12}"/);
    expectFail(r, 'breaker.md: #tradeoffs-pro-1: the words differ — md "Fails slow." record "Fails fast."');
  });

  it('names an id the markdown gives that the record lacks, and the ids the written one moved', async () => {
    // A written id takes no number, so the item after it is the first the build numbers.
    edit(`${BREAKER}.md`, '- Fails fast.', '- Fails fast. {#tradeoffs-fast}');
    const r = await run();
    expectFail(r, '#tradeoffs-pro-1: the words differ — md "Frees threads." record "Fails fast."');
    expectFail(r, '#tradeoffs-pro-2: the md has no element with this id — md none record "Frees threads."');
    expectFail(r, '#tradeoffs-fast: the record has no element with this id — md "Fails fast." record none');
  });

  it('names an id the markdown lacks', async () => {
    edit(`${BREAKER}.md`, ' {#wild-opossum}', '');
    expectFail(await run(), '#wild-opossum: the md has no element with this id — md none record "opossum — The Node breaker: errorThresholdPercentage & more."');
  });

  it('shows an element with no words as such', async () => {
    edit(`${BOUNDARY}.md`, '\n{#rationale-where}\n', '\n');
    const r = await run();
    expectFail(r, '#rationale-where: the md has no element with this id — md none record "no words"');
  });

  it('names an intro paragraph that says something else', async () => {
    edit(`${BREAKER}.md`, 'Stops calling a failing thing', 'Stops calling a failing item');
    const r = await run();
    expectFail(r, /breaker\.md: intro paragraph 1 differs — md "[^"]*failing item[^"]*" record "[^"]*failing thing[^"]*"/);
  });

  it('names a markdown file that is not the one the record was built from, when only its frontmatter changed', async () => {
    edit(`${BREAKER}.md`, 'status: stable', 'status: draft');
    const r = await run();
    expectFail(r, /breaker\.md: the markdown is not the file the record's source\.sha256 names/);
    expect(findings(r)).toHaveLength(1);
  });

  it('names a record whose hash is not the markdown it sits beside', async () => {
    editJson<PageRecord>(`${BREAKER}.json`, (rec) => {
      (rec.source as { sha256: string }).sha256 = '0'.repeat(64);
    });
    expectFail(await run(), /breaker\.md: the markdown is not the file the record's source\.sha256 names — md "[0-9a-f]{12}" record "000000000000"/);
  });

  it('names a markdown file that is not there', async () => {
    sb.rm(`${BREAKER}.md`);
    expectFail(await run(), 'breaker.md: is missing — the markdown of every page of the knowledge base ships beside it');
  });
});

describe('index.json against the records', () => {
  it('names the field an entry says otherwise, with the page', async () => {
    editJson<{ pages: Record<string, unknown>[] }>(`${DIST}/index.json`, (index) => {
      const entry = index.pages.find((p) => p['id'] === 'breaker') as Record<string, unknown>;
      entry['title'] = 'Fuse';
      entry['tags'] = ['latency'];
      delete entry['markdown'];
    });
    const r = await run();
    expectFail(r, 'site/dist/index.json: /patterns/distributed/resilience/breaker.html: title differs — index "Fuse" record "Breaker"');
    expectFail(r, '/patterns/distributed/resilience/breaker.html: tags differs — index "["latency"]" record "["resilience","latency"]"');
    expectFail(r, '/patterns/distributed/resilience/breaker.html: markdown differs — index none record "/patterns/distributed/resilience/breaker.md"');
  });

  it('shows five findings of the file and counts the rest', async () => {
    editJson<{ pages: Record<string, unknown>[] }>(`${DIST}/index.json`, (index) => {
      for (const entry of index.pages.slice(0, 7)) entry['title'] = 'Wrong';
    });
    const r = await run();
    const own = findings(r).filter((l) => l.includes('index.json'));
    expect(own).toHaveLength(SHOWN + 1);
    expect(own.at(-1)).toBe('[site-parity] FAIL site/dist/index.json: and 2 more');
  });

  it('is held to its schema: a file that does not parse, one that breaks it, one that lists no page', async () => {
    sb.write(`${DIST}/index.json`, '{ not json');
    expectFail(await run(), /site\/dist\/index\.json: is not valid JSON — /);

    sb.write(`${DIST}/index.json`, '{}');
    expectFail(await run(), "site/dist/index.json: breaks kb-index-1: /: must have required property '$schema' (required), and 3 more");

    writeParitySite(sb);
    editJson<{ pages: Record<string, unknown>[] }>(`${DIST}/index.json`, (index) => {
      for (const entry of index.pages) entry['record'] = null;
    });
    expectFail(await run(), 'site/dist/index.json: lists no page with a record — build it first: make site-build');
  });
});

describe('graph.json against the records', () => {
  it('names an edge no record carries on one side, and the row its record keeps', async () => {
    const without = (id: string, edit_: (rec: PageRecord) => void) => editJson<PageRecord>(`${DIST}/${(records.get(id) as PageRecord).route.slice(1).replace(/\.html$/, '.json')}`, edit_);
    without('retry', (rec) => {
      (rec as { relations: PageRecord['relations'] }).relations = [];
    });
    const r = await run();
    expectFail(r, 'site/dist/graph.json: the edge breaker combines-with retry is not among the relations of retry — graph "combines-with breaker" record none');
  });

  it('names a row a record keeps that no edge states', async () => {
    editJson<PageGraph>(`${DIST}/graph.json`, (g) => {
      (g as { edges: PageGraph['edges'] }).edges = g.edges.filter((e) => e.b !== 'storm');
    });
    const r = await run();
    expectFail(r, 'breaker lists a relation no edge of graph.json states — graph none record "prevents-hazard storm"');
    expectFail(r, 'storm lists a relation no edge of graph.json states — graph none record "mitigated-by breaker"');
  });

  it('names an edge worded differently on the page that reads it', async () => {
    editJson<PageGraph>(`${DIST}/graph.json`, (g) => {
      const e = g.edges.find((x) => x.a === 'breaker' && x.b === 'retry') as { noteA: { text: string; md: string } };
      e.noteA = { text: 'Else', md: 'Else' };
    });
    expectFail(
      await run(),
      /the edge breaker combines-with retry: breaker words it differently — graph "\[\{"text":"Else","md":"Else"\},"Combines with",null\]" record "\[\{"text":"Retry transient errors"/,
    );
  });

  it('names a node that says something else of its page, a node with no page and a page with no node', async () => {
    editJson<PageGraph>(`${DIST}/graph.json`, (g) => {
      const nodes = g.nodes as PageGraph['nodes'][number][];
      (nodes.find((n) => n.id === 'breaker') as { title: string }).title = 'Fuse';
      nodes.push({ id: 'ghost', kind: 'pattern', band: 'x', group: 'x', title: 'Ghost', route: '/ghost.html', record: '/ghost.json' });
      (g as { nodes: PageGraph['nodes'] }).nodes = nodes.filter((n) => n.id !== 'queue');
    });
    const r = await run();
    expectFail(r, 'node breaker: title differs — graph "Fuse" record "Breaker"');
    expectFail(r, 'node ghost: no page of the index has this id — graph "/ghost.html" record none');
    expectFail(r, 'the page queue has no node — graph none record "queue"');
  });

  it('is held to its schema, and to being there', async () => {
    sb.write(`${DIST}/graph.json`, '[');
    expectFail(await run(), /site\/dist\/graph\.json: is not valid JSON/);
    sb.write(`${DIST}/graph.json`, '{}');
    expectFail(await run(), /site\/dist\/graph\.json: breaks kb-graph-1: /);
    sb.rm(`${DIST}/graph.json`);
    expectFail(await run(), 'site/dist/graph.json: is missing — build it first: make site-build');
  });
});

describe('a tree that holds no knowledge base', () => {
  it('has no page with a record to compare, says so and passes: the build of any other site is not its business', async () => {
    const bare = makeSandbox();
    try {
      builtSite(bare);
      const r = await bare.run(spec);
      expectPass(r);
      expect(r.out).toBe('[site-parity] this tree holds no knowledge base (docs/data/content-model.json is not there): no page has a record to compare');
    } finally {
      bare.cleanup();
    }
  });

  it('is a finding when the tree has a knowledge base and the index lists none of its pages', async () => {
    editJson<{ pages: Record<string, unknown>[] }>(`${DIST}/index.json`, (index) => {
      index.pages = [];
    });
    expectFail(await run(), 'site/dist/index.json: lists no page with a record — build it first: make site-build');
  });
});

describe('a file the gate cannot compare', () => {
  it('names a record that is not there, and goes on to the next page', async () => {
    sb.rm(`${BREAKER}.json`);
    edit(`${RETRY}.html`, 'Recovers blips.', 'Recovers nothing.');
    const r = await run();
    expectFail(r, 'breaker.json: is missing — build it first: make site-build');
    expectFail(r, 'retry.html: #tradeoffs-pro-1: the words differ');
    // graph.json is not held to the records of a site that lacks one: every edge of that page would be a finding.
    expect(findings(r).filter((l) => l.includes('graph.json'))).toEqual([]);
  });

  it('names a record that does not parse, and one that breaks its schema, counting the rest of the ways', async () => {
    sb.write(`${BREAKER}.json`, '{"id":');
    editJson<Record<string, unknown>>(`${RETRY}.json`, (rec) => {
      delete rec['blocks'];
      rec['title'] = 5;
    });
    editJson<Record<string, unknown>>(`${BOUNDARY}.json`, (rec) => {
      delete rec['blocks'];
    });
    const r = await run();
    expectFail(r, /breaker\.json: is not valid JSON — /);
    expectFail(r, "retry.json: breaks kb-record-1: /: must have required property 'blocks' (required), and 1 more");
    expect(findings(r)).toContain("[site-parity] FAIL site/dist/principles/boundary.json: breaks kb-record-1: /: must have required property 'blocks' (required)");
  });

  it('names the schema it is missing, and reads nothing without it', async () => {
    sb.rm('tools/src/contract/schema/kb-record-1.json');
    sb.rm('tools/src/contract/schema/kb-graph-1.json');
    const r = await run();
    expect(findings(r)).toEqual([
      '[site-parity] FAIL tools/src/contract/schema/kb-record-1.json: is missing — the records, the graph and the index are held to it',
      '[site-parity] FAIL tools/src/contract/schema/kb-graph-1.json: is missing — the records, the graph and the index are held to it',
    ]);
  });

  it('asks for a build when there is none, or when the index is not there', async () => {
    sb.rm(DIST);
    expectFail(await run(), '[site-parity] FAIL: no built site at site/dist — build it first: make site-build');
    writeParitySite(sb);
    sb.rm(`${DIST}/index.json`);
    expectFail(await run(), '[site-parity] FAIL: no built site at site/dist — build it first: make site-build');
  });

  it('is misuse with an argument, and writes nothing', async () => {
    const before = sb.snapshot();
    for (const argv of [['--nope'], ['--dist', 'site/dist'], ['site/dist']]) {
      const r = await sb.run(spec, argv);
      expectMisuse(r);
      expect(r.out).toBe('');
    }
    expect(sb.snapshot()).toEqual(before);
  });
});

describe('the functions it is made of', () => {
  it('reads the elements of every page of the fixture as its record lists them', () => {
    for (const rec of site.records) {
      expect(pageDiffs(rec, readOf(rec.id)), rec.id).toEqual([]);
      expect(markdownDiffs(rec, Buffer.from(site.dist.get(rec.markdown.slice(1)) as string)), rec.id).toEqual([]);
    }
    expect(graphDiffs(graphOf(), records)).toEqual([]);
  });

  it('puts a tag, a block and a group on every id a record holds, and the words its element shows', () => {
    const at = new Map(expectedElements(recordOf('boundary')).map((e) => [e.id, e]));
    const show = (id: string): unknown => {
      const e = at.get(id);
      return e === undefined ? undefined : [e.tag, e.block, e.group, e.text];
    };
    expect(show('applying-fig-1')).toEqual(['div', 'applying', null, 'Where does a request get checked?']);
    expect(show('rationale-where')).toEqual(['table', 'rationale', null, '']);
    expect(show('rationale-core')).toEqual(['tr', 'rationale', null, 'Core | an outage | 40']);
    expect(show('applying-li-1')).toEqual(['li', 'applying', null, 'Every field has a type and a bound']);
    expect(show('sketch-variant-1')).toEqual(['details', 'sketch', null, 'TypeScript — parse at the edge']);
    expect(show('applying-sketch-1')).toEqual(['details', 'applying', null, '']);
    expect(show('selfcheck-sketch-1')).toEqual(['details', 'selfcheck', null, 'Why not check again deeper?']);
    expect(show('a-deeper-heading')).toBeUndefined();
  });

  it('knows each node type of the body, the ones the fixture does not hold too', () => {
    const inline = (text: string) => ({ text, md: text });
    const node = (type: string, rest: Record<string, unknown>) => ({ type, id: null, fp: null, ...rest });
    const content = {
      intro: [node('paragraph', { id: 'intro-p', text: 'Intro', md: 'Intro' })],
      blocks: [
        {
          id: 'b',
          name: 'b',
          heading: inline('B'),
          generated: null,
          content: [
            node('heading', { id: 'b-h4', depth: 4, text: 'Deeper', md: 'Deeper' }),
            node('group', {
              id: undefined,
              fact: 'requirement',
              value: 'fr',
              heading: { id: 'frs', fp: 'x', text: 'Functional', md: 'Functional' },
              content: [node('paragraph', { id: 'fr-p', text: 'Must', md: 'Must' })],
            }),
            node('list', {
              id: 'l',
              ordered: true,
              start: 1,
              items: [{ id: 'l-1', fp: 'x', text: 'One', md: 'One', lead: null, checked: null, content: [node('code', { id: 'l-code', lang: null, code: 'x' })] }],
            }),
            node('table', { id: 't', align: [], header: [inline('H')], rows: [{ id: 't-r1', fp: 'x', cells: [inline('a'), inline('b')] }] }),
            node('figure', { id: 'f-ts', lang: 'ts', caption: inline('Caption'), wide: false, code: 'x' }),
            node('figure', { id: 'f-mm', lang: 'mermaid', caption: null, wide: false, code: 'x' }),
            node('sketch', { id: 's-prose', form: 'prose', lang: null, summary: null, caption: null, wide: false, code: null, content: [node('paragraph', { id: 's-p', text: 'In', md: 'In' })] }),
            node('quote', { id: 'q', content: [node('paragraph', { id: 'q-p', text: 'Said', md: 'Said' })] }),
            { type: 'html', md: '<hr>' },
          ],
        },
      ],
    } as unknown as Content;
    expect(expectedElements(content).map((e) => [e.id, e.tag, e.block, e.group, e.text])).toEqual([
      ['intro-p', 'p', null, null, 'Intro'],
      ['b', 'h2', 'b', null, 'B'],
      ['b-h4', 'h4', 'b', null, 'Deeper'],
      ['frs', 'h3', 'b', 'fr', 'Functional'],
      ['fr-p', 'p', 'b', 'fr', 'Must'],
      ['l', 'ol', 'b', null, ''],
      ['l-1', 'li', 'b', null, 'One'],
      ['l-code', 'div', 'b', null, ''],
      ['t', 'table', 'b', null, ''],
      ['t-r1', 'tr', 'b', null, 'a | b'],
      ['f-ts', 'figure', 'b', null, 'Caption'],
      ['f-mm', 'div', 'b', null, ''],
      ['s-prose', 'details', 'b', null, ''],
      ['s-p', 'p', 'b', null, 'In'],
      ['q', 'details', 'b', null, ''],
      ['q-p', 'p', 'b', null, 'Said'],
    ]);
  });

  it('names the block and the group a page puts an element in as none when it puts it in none', () => {
    const rec = recordOf('breaker');
    const read = JSON.parse(JSON.stringify(readOf('breaker'))) as { elements: { id: string; block: string | null; group: string | null }[] };
    (read.elements.find((e) => e.id === 'description-p-1') as { block: string | null }).block = null;
    (read.elements.find((e) => e.id === 'usage-p-2') as { group: string | null }).group = 'when';
    const found = pageDiffs(rec, read as unknown as NonNullable<ReturnType<typeof readPageRecord>>);
    expect(found).toContain('#description-p-1: the block differs — html none record "description"');
    expect(found).toContain('#usage-p-2: the group differs — html "when" record none');
  });

  it('takes the words of an intro from its paragraphs alone', () => {
    const intro = [
      { type: 'paragraph', id: null, fp: null, text: 'Said.', md: 'Said.' },
      { type: 'html', md: '<hr>' },
    ];
    expect(introWords({ intro, blocks: [] } as unknown as Content)).toEqual(['Said.']);
  });

  it('reads a node of a fact the entry spells differently as the string it is, and a list as JSON', () => {
    const rec = recordOf('breaker');
    expect(indexDiffs({ ...Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v])), record: '/patterns/distributed/resilience/breaker.json' }, rec)).toEqual([]);
    const said = indexDiffs({ route: rec.route, title: rec.title, tags: ['x'], record: 'elsewhere' }, rec);
    expect(said).toContain(`${rec.route}: tags differs — index "["x"]" record "["resilience","latency"]"`);
    expect(said).toContain(`${rec.route}: record differs — index "elsewhere" record "/patterns/distributed/resilience/breaker.json"`);
  });

  it('counts a mention twice and a tour it was not given as differences', () => {
    const graph = graphOf();
    (graph as { mentions: PageGraph['mentions'] }).mentions = [...graph.mentions, { from: 'breaker', to: 'queue' }];
    (graph as { tours: PageGraph['tours'] }).tours = graph.tours.map((t) => (t.theme === 'steady' ? { ...t, stages: t.stages.slice(1) } : t));
    const found = graphDiffs(graph, records);
    expect(found).toContain('breaker: its mentions differ — graph "queue,queue" record "queue"');
    expect(found.some((f) => f.startsWith('steady: its tour differs'))).toBe(true);
    expect(found.some((f) => f.startsWith('breaker: its themes differ'))).toBe(true);
  });

  it('names an edge whose page has no record', () => {
    const fewer = new Map(records);
    fewer.delete('storm');
    const found = graphDiffs(graphOf(), fewer);
    expect(found).toContain('the edge breaker prevents-hazard storm is not among the relations of storm — graph "mitigated-by breaker" record none');
  });
});

describe('what each surface carries', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tools/src/contract/schema/kb-record-1.json'), 'utf8')) as { properties: Record<string, unknown> };
  const SURFACES: readonly Surface[] = ['html', 'md', 'index', 'graph'];

  it('classifies every key of a record, and no other', () => {
    expect(Object.keys(PROJECTIONS).sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it('puts each key on the surfaces that carry it, or says why none does', () => {
    for (const [key, p] of Object.entries(PROJECTIONS)) {
      expect(p.note.length, key).toBeGreaterThan(20);
      if (p.on === 'record-only') continue;
      expect(p.on.length, key).toBeGreaterThan(0);
      for (const s of p.on) expect(SURFACES, `${key} on ${s}`).toContain(s);
      expect(new Set(p.on).size, key).toBe(p.on.length);
    }
  });

  it('is what the gate reads: the keys it compares on a surface are the keys classified on it', () => {
    for (const surface of SURFACES) {
      const classified = Object.entries(PROJECTIONS)
        .filter(([, p]) => p.on !== 'record-only' && p.on.includes(surface))
        .map(([key]) => key)
        .sort();
      expect([...COMPARED[surface]].sort(), surface).toEqual(classified);
    }
  });
});
