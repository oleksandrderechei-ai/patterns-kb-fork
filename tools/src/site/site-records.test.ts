/**
 * The files the site ships for machine readers (tools/src/site/site-records.ts):
 * what each one holds, over the fixture tree of the page record and over small
 * hand-made pages, one sandbox edit for each way the build refuses a page, and
 * the files written under a built folder. The real tree is read once, to hold
 * llms.txt to the pages it lists.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SCHEMA_DIR } from '../contract/contract.js';
import { Corpus } from '../kb/corpus.js';
import { graphOf, recordOf } from '../kb/record.js';
import { REAL_TREE_TIMEOUT, writeRecordFixture } from '../lib/fixtures.js';
import { serialize } from '../lib/kb-record.js';
import { makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';

import {
  indexFieldsOf,
  isReserved,
  llmsFullOf,
  llmsText,
  pageMarker,
  readContract,
  readSchemas,
  recordAddress,
  writeContract,
  type KbPage,
  type KindName,
} from './site-records.js';

const KINDS: readonly KindName[] = [
  { id: 'pattern', folder: 'patterns' },
  { id: 'hazard', folder: 'hazards' },
  { id: 'comparison', folder: 'comparisons' },
];

/** A page of the knowledge base with every field a file reads; `over` changes what a test is about. */
function kbPage(id: string, over: Partial<KbPage> = {}): KbPage {
  return {
    id,
    kind: 'pattern',
    band: 'distributed',
    group: 'distributed-resilience',
    title: id.toUpperCase(),
    description: `What ${id} does`,
    route: `/patterns/distributed/resilience/${id}.html`,
    source: `docs/patterns/distributed/resilience/${id}.md`,
    record: `/patterns/distributed/resilience/${id}.json`,
    json: '{}\n',
    ...over,
  };
}

describe('the addresses', () => {
  it('writes a page’s record where the page is, with .json for .html, and only the end of the route', () => {
    expect(recordAddress('/patterns/distributed/resilience/breaker.html')).toBe('/patterns/distributed/resilience/breaker.json');
    expect(recordAddress('/a.html/b.html')).toBe('/a.html/b.json');
  });

  it('keeps the index, the graph and the schema folder for themselves', () => {
    for (const address of ['/index.json', '/graph.json', '/schema/kb-record-1.json', '/schema/x/y.json']) expect(isReserved(address), address).toBe(true);
    for (const address of ['/patterns/index.json', '/themes/graph.json', '/schemas/x.json', '/schema.json', '/graph.jsonl']) expect(isReserved(address), address).toBe(false);
  });
});

describe('the index fields', () => {
  it('are the page’s id, kind, band, group and record, in the order the index writes them', () => {
    const fields = indexFieldsOf(kbPage('breaker'));
    expect(fields).toEqual({
      id: 'breaker',
      kind: 'pattern',
      band: 'distributed',
      group: 'distributed-resilience',
      record: '/patterns/distributed/resilience/breaker.json',
    });
    expect(Object.keys(fields)).toEqual(['id', 'kind', 'band', 'group', 'record']);
  });

  it('are all five null for a page that is not a page of the knowledge base, in the same order', () => {
    const fields = indexFieldsOf(undefined);
    expect(fields).toEqual({ id: null, kind: null, band: null, group: null, record: null });
    expect(Object.keys(fields)).toEqual(['id', 'kind', 'band', 'group', 'record']);
  });
});

describe('llms.txt', () => {
  const pages = [
    kbPage('breaker'),
    kbPage('retry', { description: '' }),
    kbPage('storm', { kind: 'hazard', title: 'Storm [of retries]', description: 'Retries\n  that make   it worse', route: '/hazards/storm.html' }),
    kbPage('brokers', { kind: 'comparison', title: 'Kafka \\ RabbitMQ', route: '/comparisons/brokers.html' }),
  ];
  const lines = llmsText(pages, KINDS).split('\n');

  it('opens with the site’s name, a one-line summary and a paragraph on the files beside each page', () => {
    expect(lines.slice(0, 5)).toEqual([
      '# Patterns KB',
      '',
      '> Software design patterns, hazards, themes, principles, case studies, capabilities and comparisons, as markdown for people and JSON for programs.',
      '',
      expect.stringContaining('`<page>.html` has `<page>.md` and `<page>.json`'),
    ]);
  });

  it('lists the files that describe the whole site under Contract, each with a link relative to the root', () => {
    const at = lines.indexOf('## Contract');
    expect(lines.slice(at, at + 10)).toEqual([
      '## Contract',
      '',
      '- [index.json](index.json): every page with its kind and the address of its record (kb-index/1)',
      '- [graph.json](graph.json): every page and every typed link between pages (kb-graph/1)',
      '- [schema/kb-record-1.json](schema/kb-record-1.json): what each key of a page record means',
      '- [schema/kb-index-1.json](schema/kb-index-1.json): what each key of index.json means',
      '- [schema/kb-graph-1.json](schema/kb-graph-1.json): what each key of graph.json means',
      '- [schema/kb-cli-1.json](schema/kb-cli-1.json): what the `--json` output of each `kb.mjs` read command means (kb-cli/1)',
      '- [llms-full.txt](llms-full.txt): the markdown of every page in one file, each page after a `<!-- kb:page id=… route=… -->` line',
      '',
    ]);
  });

  it('links each schema file the repo publishes, so that a reader finds every one of them from here', () => {
    const published = readSchemas(REPO_ROOT).map((s) => `schema/${s.name}`);
    const linked = lines.filter((l) => l.startsWith('- [schema/')).map((l) => /\]\(([^)]+)\)/.exec(l)?.[1]);
    expect(linked.sort()).toEqual(published.sort());
  });

  it('heads each kind with its plural, once, and lists its pages under it in the order given: title, markdown, description', () => {
    const at = lines.indexOf('## Patterns');
    expect(lines.slice(at)).toEqual([
      '## Patterns',
      '',
      '- [BREAKER](patterns/distributed/resilience/breaker.md): What breaker does',
      '- [RETRY](patterns/distributed/resilience/retry.md)',
      '',
      '## Hazards',
      '',
      '- [Storm \\[of retries\\]](hazards/storm.md): Retries that make it worse',
      '',
      '## Comparisons',
      '',
      '- [Kafka \\\\ RabbitMQ](comparisons/brokers.md): What brokers does',
      '',
    ]);
  });

  it('ends in one newline, and has no page line that runs over two lines', () => {
    const text = llmsText(pages, KINDS);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    for (const line of lines.filter((l) => l.includes('](') && l.startsWith('- ['))) expect(line, line).toMatch(/^- \[.+\]\([^) ]+\)(: .+)?$/);
  });
});

describe('llms-full.txt', () => {
  const page = (id: string): Pick<KbPage, 'id' | 'route'> => ({ id, route: `/${id}.html` });

  it('puts a marker line before each page’s markdown, byte for byte, in the order given', () => {
    const a = Buffer.from('---\ntitle: A\n---\n\n# A\n');
    const b = Buffer.from('---\ntitle: B\n---\n\n# B é\n');
    const out = llmsFullOf([
      { page: page('a'), markdown: a },
      { page: page('b'), markdown: b },
    ]);
    expect(out.equals(Buffer.concat([Buffer.from('<!-- kb:page id=a route=/a.html -->\n'), a, Buffer.from('<!-- kb:page id=b route=/b.html -->\n'), b]))).toBe(true);
    expect(pageMarker(page('a'))).toBe('<!-- kb:page id=a route=/a.html -->');
  });

  it('ends a page that does not end in a newline with one, so the next marker starts a line, and does the same for an empty page', () => {
    const out = llmsFullOf([
      { page: page('a'), markdown: Buffer.from('no newline') },
      { page: page('b'), markdown: Buffer.alloc(0) },
      { page: page('c'), markdown: Buffer.from('fine\n') },
    ]);
    expect(out.toString('utf8')).toBe(
      '<!-- kb:page id=a route=/a.html -->\nno newline\n<!-- kb:page id=b route=/b.html -->\n\n<!-- kb:page id=c route=/c.html -->\nfine\n',
    );
  });

  it('is nothing for no pages', () => {
    expect(llmsFullOf([]).length).toBe(0);
  });
});

describe('the schemas', () => {
  let sb: Sandbox;
  beforeAll(() => {
    sb = makeSandbox();
  });
  afterAll(() => sb.cleanup());

  it('are none when the repo has no schema folder', () => {
    expect(readSchemas(sb.dir)).toEqual([]);
  });

  it('are the .json files of the folder in name order, whole, and nothing else in it', () => {
    sb.write(`${SCHEMA_DIR}/kb-record-1.json`, '{"b":1}\n');
    sb.write(`${SCHEMA_DIR}/Kb-Upper.json`, '{"a":1}\n');
    sb.write(`${SCHEMA_DIR}/notes.md`, 'not a schema');
    sb.mkdir(`${SCHEMA_DIR}/nested.json`);
    const got = readSchemas(sb.dir);
    expect(got.map((s) => s.name)).toEqual(['Kb-Upper.json', 'kb-record-1.json']);
    expect(got.map((s) => s.bytes.toString('utf8'))).toEqual(['{"a":1}\n', '{"b":1}\n']);
  });

  it('are the real tree’s own, every file under tools/src/contract/schema/, byte for byte', () => {
    const real = readSchemas(REPO_ROOT);
    expect(real.map((s) => s.name)).toEqual(fs.readdirSync(path.join(REPO_ROOT, SCHEMA_DIR)).filter((f) => f.endsWith('.json')).sort());
    for (const s of real) expect(s.bytes.equals(fs.readFileSync(path.join(REPO_ROOT, SCHEMA_DIR, s.name))), s.name).toBe(true);
  });
});

describe('readContract over the fixture tree', () => {
  let sb: Sandbox;
  let corpus: Corpus;
  let read: ReturnType<typeof readContract>;
  beforeAll(() => {
    sb = makeSandbox();
    writeRecordFixture(sb.dir);
    sb.copyRepo(SCHEMA_DIR);
    corpus = new Corpus(sb.dir);
    read = readContract(sb.dir);
  });
  afterAll(() => sb.cleanup());

  it('builds a record for every page of the knowledge base, the bytes `kb.mjs record` prints, in the order `kb.mjs ls` lists them', () => {
    const contract = read.contract;
    expect(read.findings).toEqual([]);
    expect(contract).not.toBeNull();
    expect(contract?.pages.map((p) => p.id)).toEqual(corpus.listing.map((p) => p.slug));
    expect(contract?.pages).toHaveLength(12);
    for (const p of contract?.pages ?? []) expect(p.json, p.id).toBe(serialize(recordOf(corpus, p.id)));
  });

  it('gives each page its route, the address of its record, and the facts the index repeats', () => {
    const breaker = read.contract?.pages.find((p) => p.id === 'breaker');
    expect(breaker).toMatchObject({
      kind: 'pattern',
      band: 'distributed',
      group: 'distributed-resilience',
      title: 'Breaker',
      description: 'The breaker page',
      route: '/patterns/distributed/resilience/breaker.html',
      source: 'docs/patterns/distributed/resilience/breaker.md',
      record: '/patterns/distributed/resilience/breaker.json',
    });
    // A theme filed in a designs tier is a theme: the kind is the folder, not the area.
    expect(read.contract?.pages.find((p) => p.id === 'loop')).toMatchObject({ kind: 'theme', band: 'theme', group: 'theme' });
  });

  it('builds the graph the bytes `kb.mjs graph` prints, the schemas as they are, and the two text files from the same pages', () => {
    const contract = read.contract;
    expect(contract?.graph).toBe(serialize(graphOf(corpus)));
    expect(contract?.schemas.map((s) => s.name)).toEqual(readSchemas(sb.dir).map((s) => s.name));
    expect(contract?.schemas.length).toBeGreaterThan(0);
    expect(contract?.llms).toBe(llmsText(contract?.pages ?? [], contract?.kinds ?? []));
    const markdown = (p: KbPage): Buffer => fs.readFileSync(path.join(sb.dir, p.source));
    expect(contract?.llmsFull.equals(llmsFullOf((contract?.pages ?? []).map((page) => ({ page, markdown: markdown(page) }))))).toBe(true);
  });

  it('heads one section for each of the seven kinds, in the order the pages are listed, and lists every page once', () => {
    const text = read.contract?.llms ?? '';
    const heads = text.split('\n').filter((l) => l.startsWith('## '));
    expect(heads).toEqual(['## Contract', '## Patterns', '## Hazards', '## Themes', '## Principles', '## Designs', '## Capabilities', '## Comparisons']);
    const targets = [...text.matchAll(/^- \[[^\]]*\]\(([^)]+)\)/gm)].map((m) => m[1] as string).filter((t) => t.endsWith('.md'));
    expect(targets).toEqual(corpus.listing.map((p) => p.route.slice(1).replace(/\.html$/, '.md')));
  });

  it('takes its kinds, in the model’s words, from the content model', () => {
    expect(read.contract?.kinds.map((k) => `${k.id}:${k.folder}`)).toEqual([
      'pattern:patterns',
      'hazard:hazards',
      'theme:themes',
      'principle:principles',
      'design:designs',
      'capability:capabilities',
      'comparison:comparisons',
    ]);
  });
});

describe('readContract refusing', () => {
  const made: Sandbox[] = [];
  afterEach(() => {
    for (const own of made.splice(0)) own.cleanup();
  });
  /** The fixture tree in a sandbox of its own, which the test may edit. */
  const fresh = (): Sandbox => {
    const own = makeSandbox();
    made.push(own);
    writeRecordFixture(own.dir);
    return own;
  };
  const BREAKER = 'docs/patterns/distributed/resilience/breaker.md';

  it('holds no knowledge base in a tree with no content model: no contract and nothing wrong', () => {
    const empty = makeSandbox();
    made.push(empty);
    empty.write('docs/data/site-structure.json', '{"areas":[]}\n');
    expect(readContract(empty.dir)).toEqual({ contract: null, findings: [] });
  });

  it('names the markdown of a page the record cannot hold and builds nothing, leaving the other pages’ records unbuilt too', () => {
    const own = fresh();
    own.write(BREAKER, own.read(BREAKER).replace('<!-- relationships:end -->', ''));
    expect(readContract(own.dir)).toEqual({
      contract: null,
      findings: [{ file: BREAKER, what: 'its record cannot be built: breaker: the region "relationships" is never closed' }],
    });
  });

  it('names every page that fails, not the first', () => {
    const own = fresh();
    own.write(BREAKER, own.read(BREAKER).replace('<!-- relationships:end -->', ''));
    own.write('docs/principles/boundary.md', own.read('docs/principles/boundary.md').replace('<!-- relationships:end -->', ''));
    expect(readContract(own.dir).findings.map((f) => f.file)).toEqual([BREAKER, 'docs/principles/boundary.md']);
  });

  it('names a page whose record would be written over a file the site keeps, and builds nothing', () => {
    const own = fresh();
    const structure = JSON.parse(own.read('docs/data/site-structure.json')) as { areas: { id: string; pages: { slug: string; route: string }[] }[] };
    const row = structure.areas.flatMap((a) => a.pages).find((p) => p.slug === 'quick') as { route: string };
    row.route = '/graph.html';
    own.write('docs/data/site-structure.json', `${JSON.stringify(structure, null, 2)}\n`);
    expect(readContract(own.dir)).toEqual({
      contract: null,
      findings: [{ file: 'docs/principles/quick.md', what: 'its record would be written at /graph.json, which the site keeps for another file' }],
    });
  });

  it('lets a fault of the build itself through, since it says nothing about a page', () => {
    const own = fresh();
    own.write('docs/data/relations.json', own.read('docs/data/relations.json').replace('"verb": "combines-with"', '"verb": "zzz"'));
    expect(() => readContract(own.dir)).toThrow('relations: unknown verb "zzz"');
  });
});

describe('writeContract', () => {
  let sb: Sandbox;
  beforeAll(() => {
    sb = makeSandbox();
    writeRecordFixture(sb.dir);
    sb.copyRepo(SCHEMA_DIR);
  });
  afterAll(() => sb.cleanup());

  it('writes each record beside its page’s route, the graph and the two text files at the root and each schema under schema/, creating the folders', () => {
    const contract = readContract(sb.dir).contract;
    if (contract === null) throw new Error('the fixture holds a knowledge base');
    const dist = path.join(sb.dir, 'dist');
    writeContract(dist, contract);
    for (const p of contract.pages) expect(fs.readFileSync(path.join(dist, p.record), 'utf8'), p.id).toBe(p.json);
    expect(fs.readFileSync(path.join(dist, 'patterns/distributed/resilience/breaker.json'), 'utf8')).toBe(serialize(recordOf(new Corpus(sb.dir), 'breaker')));
    expect(fs.readFileSync(path.join(dist, 'graph.json'), 'utf8')).toBe(contract.graph);
    expect(fs.readFileSync(path.join(dist, 'llms.txt'), 'utf8')).toBe(contract.llms);
    expect(fs.readFileSync(path.join(dist, 'llms-full.txt')).equals(contract.llmsFull)).toBe(true);
    for (const s of contract.schemas) expect(fs.readFileSync(path.join(dist, 'schema', s.name)).equals(s.bytes), s.name).toBe(true);
    expect(fs.readdirSync(path.join(dist, 'schema')).sort()).toEqual(contract.schemas.map((s) => s.name));
  });

  it('writes the same bytes a second time', () => {
    const contract = readContract(sb.dir).contract;
    if (contract === null) throw new Error('the fixture holds a knowledge base');
    const dist = path.join(sb.dir, 'again');
    writeContract(dist, contract);
    const once = readTree(dist);
    writeContract(dist, readContract(sb.dir).contract ?? contract);
    expect(readTree(dist)).toEqual(once);
    // A record each, then graph.json, llms.txt and llms-full.txt, then the schemas.
    expect(once.size).toBe(contract.pages.length + 3 + contract.schemas.length);
  });
});

/** Every file under `dir`, relative to it, with its bytes in base64. */
function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else out.set(child, fs.readFileSync(path.join(dir, child)).toString('base64'));
    }
  };
  walk('');
  return out;
}

describe('the real tree', () => {
  it('lists every page of the knowledge base once in llms.txt, under the plural of its kind, with a link no markdown reader would split', () => {
    const read = readContract(REPO_ROOT);
    expect(read.findings).toEqual([]);
    const contract = read.contract;
    if (contract === null) throw new Error('the real tree holds a knowledge base');
    const corpus = new Corpus(REPO_ROOT);
    expect(contract.pages.map((p) => p.id)).toEqual(corpus.listing.map((p) => p.slug));
    const pageLines = contract.llms.split('\n').filter((l) => /^- \[/.test(l) && !/\]\((?:index|graph|schema|llms)/.test(l));
    expect(pageLines).toHaveLength(contract.pages.length);
    for (const line of pageLines) expect(line, line).toMatch(/^- \[(?:[^\][\\]|\\.)+\]\([a-z0-9][a-z0-9._/-]*\.md\)(?:: \S.*)?$/);
    // Every page opens one marker line in llms-full.txt, in the same order.
    const markers = contract.llmsFull.toString('utf8').split('\n').filter((l) => l.startsWith('<!-- kb:page '));
    expect(markers).toEqual(contract.pages.map((p) => pageMarker(p)));
  }, REAL_TREE_TIMEOUT);
});
