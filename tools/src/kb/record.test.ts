/**
 * The page record and the checks that hang on it, over the fixture tree
 * (`writeRecordFixture` in tools/src/lib/fixtures.ts): the header read from the
 * frontmatter and the page's place, the relations in the order the page shows
 * them, a record of some blocks, themes and tours and prerequisites, the graph
 * and its agreement with the records, and the citation check with a sandbox
 * edit for each way a citation can stop being ok. The last group holds the
 * records of the real tree to the published schema; the schema file itself and
 * the CLI's output are held by json-contract.test.ts and cli.test.ts, and the
 * bytes of the fixture's records by record-golden.test.ts.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { contractSchemas, schemaUrl } from '../contract/contract.js';
import { REAL_TREE_TIMEOUT, writeKbFixture, writeRecordFixture } from '../lib/fixtures.js';
import { formatFinding } from '../lib/json-schema.js';
import { fingerprint, serialize } from '../lib/kb-record.js';
import { makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';

import { parseArgs } from './args.js';
import { Session } from './cli.js';
import { Corpus, KbError, KbUsageError, KIND_SEQ } from './corpus.js';
import { graphOf, recordOf, resolveLine, resolveRefs, type PageRecord, type Resolved } from './record.js';

let sb: Sandbox;
let corpus: Corpus;
beforeAll(() => {
  sb = makeSandbox();
  writeRecordFixture(sb.dir);
  corpus = new Corpus(sb.dir);
});
afterAll(() => sb.cleanup());

const BREAKER = 'docs/patterns/distributed/resilience/breaker.md';

/** A copy of the fixture tree with `edit` applied to it, and a corpus over the copy. */
function edited(edit: (own: Sandbox) => void): { own: Sandbox; corpus: Corpus } {
  const own = makeSandbox();
  writeRecordFixture(own.dir);
  edit(own);
  return { own, corpus: new Corpus(own.dir) };
}

/** `edit` applied to the text of one file of a sandbox. */
function rewrite(own: Sandbox, file: string, edit: (text: string) => string): void {
  own.write(file, edit(own.read(file)));
}

/** The object a JSON Pointer names in a record. */
function at(root: unknown, pointer: string): Record<string, unknown> {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root) as Record<string, unknown>;
}

/** The keys of a record, in the order the schema and the bytes carry them. */
const KEYS = [
  '$schema',
  'contract',
  'scope',
  'id',
  'title',
  'description',
  'kind',
  'band',
  'group',
  'area',
  'areaChain',
  'status',
  'owner',
  'tags',
  'aliases',
  'solves',
  'favourite',
  'route',
  'markdown',
  'source',
  'intro',
  'blocks',
  'relations',
  'themes',
  'tour',
  'prerequisites',
  'links',
  'mentions',
  'anchors',
];

describe('the header', () => {
  it('is read from the frontmatter and the page’s place, every key in the order the schema lists them', () => {
    const r = recordOf(corpus, 'breaker');
    expect(Object.keys(r)).toEqual(KEYS);
    expect(r).toMatchObject({
      $schema: 'https://odere-pro.github.io/patterns-kb/schema/kb-record-1.json',
      contract: 'kb-record/1',
      scope: null,
      id: 'breaker',
      title: 'Breaker',
      description: 'The breaker page',
      kind: 'pattern',
      band: 'distributed',
      group: 'distributed-resilience',
      area: 'distributed-resilience',
      status: 'stable',
      owner: 'Test Owner',
      tags: ['resilience', 'latency'],
      aliases: ['CB', 'fuse'],
      solves: ['my threads hang on a dead dependency', 'one failing call, and the whole service falls'],
      favourite: true,
      route: '/patterns/distributed/resilience/breaker.html',
      markdown: '/patterns/distributed/resilience/breaker.md',
    });
    expect(r.areaChain).toEqual([
      { id: 'patterns', label: 'patterns' },
      { id: 'distributed', label: 'distributed' },
      { id: 'distributed-resilience', label: 'distributed-resilience' },
    ]);
  });

  it('puts the same keys on a page that has none of the optional ones, with empty lists, false and null', () => {
    const r = recordOf(corpus, 'quick');
    expect(Object.keys(r)).toEqual(KEYS);
    expect(r).toMatchObject({ aliases: [], solves: [], favourite: false, relations: [], themes: [], tour: [], mentions: [], scope: null });
    expect(r.prerequisites).toEqual({ requires: [], related: [] });
  });

  it('says which file it was built from and the SHA-256 of that file’s bytes', () => {
    const r = recordOf(corpus, 'breaker');
    expect(r.source).toEqual({ path: BREAKER, sha256: createHash('sha256').update(fs.readFileSync(path.join(sb.dir, BREAKER))).digest('hex') });
    const { own, corpus: c } = edited((o) => rewrite(o, BREAKER, (t) => `${t}\nA last line.\n`));
    try {
      expect(recordOf(c, 'breaker').source.sha256).not.toBe(r.source.sha256);
    } finally {
      own.cleanup();
    }
  });

  it('names an id that is no page as a lookup that failed, and a page it cannot read', () => {
    expect(() => recordOf(corpus, 'no-such-id')).toThrow(new KbError('unknown id: no-such-id'));
    expect(() => recordOf(corpus, 'bre')).toThrow(/^unknown id: bre\ndid you mean: breaker/);
    const { own, corpus: c } = edited((o) => o.rm(BREAKER));
    try {
      expect(() => recordOf(c, 'breaker')).toThrow(new KbError(`breaker: cannot read ${BREAKER}`));
    } finally {
      own.cleanup();
    }
  });
});

describe('the body', () => {
  it('has every anchor point at the object that carries the id, and the intro of a page that has one', () => {
    for (const id of ['breaker', 'boundary', 'shortener', 'steady']) {
      const r = recordOf(corpus, id);
      const ids = Object.keys(r.anchors);
      expect(ids.length, id).toBeGreaterThan(10);
      for (const element of ids) expect(at(r, r.anchors[element] as string), `${id}#${element}`).toMatchObject({ id: element });
    }
    // Above the first block a paragraph is a node and has no id: nothing there is numbered.
    expect(recordOf(corpus, 'boundary').intro.map((n) => [n.type, 'id' in n ? n.id : undefined])).toEqual([['paragraph', null]]);
  });

  it('names the page each link of the page goes to, by the same rule the commands use', () => {
    const { links } = recordOf(corpus, 'breaker');
    const named = links.filter((l) => l.block === 'description').map((l) => [l.text, l.to, l.fragment]);
    expect(named).toEqual([
      ['Retry', 'retry', null],
      ['the storm', 'storm', 'cost'],
      ['itself', 'breaker', null],
      ['a site', null, null],
      ['a file', null, null],
      ['again', 'retry', null],
      ['the queue', 'queue', null],
    ]);
    // A click on a route reaches the page the route names; a click on a route with no page reaches none.
    const clicks = links.filter((l) => l.via === 'click').map((l) => [l.text, l.href, l.to]);
    expect(clicks).toEqual([
      ['B', '/patterns/distributed/resilience/retry.html', 'retry'],
      ['A', '/patterns/nowhere.html', null],
    ]);
    // `linkTarget` is the corpus's: the record asks the question the commands ask.
    for (const l of links.filter((x) => x.via === 'text')) expect(corpus.linkTarget(BREAKER, l.href)?.slug ?? null, l.href).toBe(l.to);
  });

  it('refuses a page the record cannot hold as a lookup that failed, naming the page', () => {
    const { own, corpus: c } = edited((o) => rewrite(o, BREAKER, (t) => t.replace('<!-- relationships:end -->', '')));
    try {
      expect(() => recordOf(c, 'breaker')).toThrow(KbError);
      expect(() => recordOf(c, 'breaker')).toThrow(/^breaker: the region "relationships" is never closed$/);
      // The other pages still have theirs.
      expect(recordOf(c, 'retry').id).toBe('retry');
    } finally {
      own.cleanup();
    }
  });

  it('lets what is not a refusal of the content through', () => {
    // A corpus of its own, so that no body made before is reused: the body of `retry` is made now, and it has a link.
    const fresh = new Corpus(sb.dir);
    vi.spyOn(fresh, 'linkTarget').mockImplementation(() => {
      throw new TypeError('not the record’s to hide');
    });
    expect(() => recordOf(fresh, 'retry')).toThrow(TypeError);
  });
});

describe('a record of some blocks', () => {
  it('keeps the blocks named, in page order, and the links and anchors of those alone', () => {
    const full = recordOf(corpus, 'boundary');
    const part = recordOf(corpus, 'boundary', { blocks: ['selfcheck', 'applying'] });
    expect(part.scope).toEqual(['applying', 'selfcheck']);
    expect(part.blocks.map((b) => b.name)).toEqual(['applying', 'selfcheck']);
    expect(part.intro).toEqual([]);
    // The intro's link goes, the two kept blocks' stay, in page order.
    expect(full.links.map((l) => l.block)).toEqual([null, 'applying', 'selfcheck']);
    expect(part.links).toEqual(full.links.filter((l) => l.block !== null));
    expect(Object.keys(part.anchors)[0]).toBe('applying');
    expect(part.anchors['applying']).toBe('/blocks/0');
    expect(part.anchors['selfcheck']).toBe('/blocks/1');
    expect(Object.keys(part.anchors).some((id) => id.startsWith('rationale'))).toBe(false);
    // The pointers read from the record that keeps the blocks.
    for (const [id, pointer] of Object.entries(part.anchors)) expect(at(part, pointer), id).toMatchObject({ id });
  });

  it('changes nothing else: the header, the relations, the themes and the mentions are the whole record’s', () => {
    const full = recordOf(corpus, 'breaker');
    const part = recordOf(corpus, 'breaker', { blocks: ['usage'] });
    expect(Object.keys(part)).toEqual(KEYS);
    for (const key of KEYS.filter((k) => !['scope', 'intro', 'blocks', 'links', 'anchors'].includes(k))) {
      expect(part[key as keyof PageRecord], key).toEqual(full[key as keyof PageRecord]);
    }
    expect(part.blocks[0]).toEqual(full.blocks.find((b) => b.name === 'usage'));
    expect(part.scope).toEqual(['usage']);
  });

  it('keeps no block for an empty list, and asks nothing twice for a name given twice', () => {
    const none = recordOf(corpus, 'retry', { blocks: [] });
    expect([none.scope, none.intro, none.blocks, none.links, none.anchors]).toEqual([[], [], [], [], {}]);
    expect(recordOf(corpus, 'retry', { blocks: ['usage', 'usage'] }).scope).toEqual(['usage']);
  });

  it('names the blocks the page has when asked for one it lacks, as get does', () => {
    expect(() => recordOf(corpus, 'retry', { blocks: ['usage', 'zzz'] })).toThrow(KbError);
    expect(() => recordOf(corpus, 'retry', { blocks: ['usage', 'zzz'] })).toThrow(
      'no block "zzz" on retry. has: description, explain, structure, variations, tradeoffs, usage, sketch, relationships',
    );
    // Own blocks only: what every object inherits names none.
    expect(() => recordOf(corpus, 'retry', { blocks: ['constructor'] })).toThrow('no block "constructor" on retry');
  });
});

describe('relations', () => {
  it('is a row for each side of an edge the page shows, with the other page’s title, kind and route', () => {
    const { relations } = recordOf(corpus, 'breaker');
    expect(relations).toEqual([
      {
        verb: 'combines-with',
        label: 'Combines with',
        inverse: 'combines-with',
        to: 'retry',
        title: 'Retry',
        kind: 'pattern',
        route: '/patterns/distributed/resilience/retry.html',
        note: { text: 'Retry transient errors', md: 'Retry transient errors' },
        group: 'Combines with',
        maps: null,
        edge: { a: 'breaker', verb: 'combines-with', b: 'retry' },
      },
      {
        verb: 'prevents-hazard',
        label: 'Prevents',
        inverse: 'mitigated-by',
        to: 'storm',
        title: 'Storm',
        kind: 'hazard',
        route: '/hazards/storm.html',
        note: { text: 'Fails fast', md: 'Fails *fast*' },
        group: 'Prevents',
        maps: null,
        edge: { a: 'breaker', verb: 'prevents-hazard', b: 'storm' },
      },
    ]);
  });

  it('reads an edge from its other end with the inverse verb, and says it is the same edge', () => {
    const [row] = recordOf(corpus, 'storm').relations;
    expect(row).toMatchObject({
      verb: 'mitigated-by',
      label: 'Mitigated by',
      inverse: 'prevents-hazard',
      to: 'breaker',
      note: { text: 'Fails fast', md: 'Fails fast' },
      edge: { a: 'breaker', verb: 'prevents-hazard', b: 'storm' },
    });
    // A symmetric verb reads the same from both ends, and the edge is still the one written from `a`.
    expect(recordOf(corpus, 'retry').relations[0]).toMatchObject({ verb: 'combines-with', inverse: 'combines-with', to: 'breaker', edge: { a: 'breaker', b: 'retry' } });
  });

  it('puts a row under its own group heading when the edge names one, and a row that pins a row says which', () => {
    const rows = recordOf(corpus, 'validators').relations;
    expect(rows.map((r) => [r.verb, r.group, r.label])).toEqual([
      ['implements', 'Implements', 'Implements'],
      ['prerequisite', 'Read first', 'Requires'],
    ]);
    expect(rows[0]?.maps).toEqual({ id: 'mapping-row-1', label: 'Schema validation' });
    expect(rows[1]?.maps).toBeNull();
  });

  it('keeps the order the page’s block shows them in, a pinned one included', () => {
    // The default would put the verb's own heading first; the page pins the custom one before it.
    expect(recordOf(corpus, 'boundary').relations.map((r) => [r.group, r.verb])).toEqual([
      ['Off the shelf', 'implemented-by'],
      ['Enables', 'enables'],
    ]);
    const block = recordOf(corpus, 'boundary').blocks.find((b) => b.name === 'relationships');
    const headings = (block?.content ?? []).flatMap((n) => (n.type === 'paragraph' ? [n.text] : []));
    expect(headings).toEqual(['Off the shelf', 'Enables']);
  });

  it('says in the generated relationships block of a page what its rows say: the same groups, in the same order, each with the same pages and notes', () => {
    let said = 0;
    for (const p of corpus.listing) {
      const record = recordOf(corpus, p.slug);
      const block = record.blocks.find((b) => b.name === 'relationships');
      if (block === undefined || block.generated !== 'relationships') continue;
      const written: string[] = [];
      let group = '';
      for (const node of block.content) {
        if (node.type === 'paragraph') group = node.text;
        if (node.type === 'list') for (const item of node.items) written.push(`${group} | ${item.text}`);
      }
      const rows = record.relations.map((r) => `${r.group} | ${r.title}${r.note.md === '' ? '' : ` — ${r.note.text}`}`);
      expect(written, p.slug).toEqual(rows);
      said += rows.length;
    }
    // Breaker (2), retry, storm, boundary (2) and validators (2) have edges and say them.
    expect(said).toBe(8);
  });

  it('lists exactly the sides, in exactly the order, `related` gives, for every page of the tree', () => {
    const session = new Session(corpus, parseArgs([]));
    for (const p of corpus.listing) {
      expect(recordOf(corpus, p.slug).relations.map((r) => [r.verb, r.to, r.note.text]), p.slug).toEqual(session.relations(p.slug).map((r) => [r.verb, r.to, r.note]));
    }
  });

  it('gives a pinned row no label when the edge carries none, on the page and in the graph', () => {
    const { own, corpus: c } = edited((o) =>
      rewrite(o, 'docs/data/relations.json', (t) => {
        const file = JSON.parse(t) as { relations: Record<string, unknown>[] };
        const edge = file.relations.find((r) => r['maps_a'] !== undefined) as Record<string, unknown>;
        delete edge['maps_label_a'];
        edge['maps_b'] = 'matrix-row-1';
        return JSON.stringify(file);
      }),
    );
    try {
      expect(recordOf(c, 'validators').relations[0]?.maps).toEqual({ id: 'mapping-row-1', label: '' });
      expect(recordOf(c, 'boundary').relations.find((r) => r.verb === 'implemented-by')?.maps).toEqual({ id: 'matrix-row-1', label: '' });
      expect(graphOf(c).edges.find((e) => e.mapsA !== null)).toMatchObject({ mapsA: { id: 'mapping-row-1', label: '' }, mapsB: { id: 'matrix-row-1', label: '' } });
    } finally {
      own.cleanup();
    }
  });

  it('refuses an edge that names a page there is not, naming the edge, from either of its ends', () => {
    const { own, corpus: c } = edited((o) => rewrite(o, 'docs/data/relations.json', (t) => t.replace('"b": "storm"', '"b": "ghost"')));
    try {
      expect(() => recordOf(c, 'breaker')).toThrow(new KbError('breaker: the relation breaker prevents-hazard ghost names "ghost", which is no page'));
      expect(() => recordOf(c, 'retry')).not.toThrow();
    } finally {
      own.cleanup();
    }
    const other = edited((o) => rewrite(o, 'docs/data/relations.json', (t) => t.replace('"a": "breaker",\n      "verb": "prevents-hazard"', '"a": "ghost",\n      "verb": "prevents-hazard"')));
    try {
      expect(() => recordOf(other.corpus, 'storm')).toThrow(new KbError('storm: the relation ghost prevents-hazard storm names "ghost", which is no page'));
    } finally {
      other.own.cleanup();
    }
  });
});

describe('themes, the tour and prerequisites', () => {
  it('names the themes a page is in, with its part in each, and the tour of a theme in stage order', () => {
    expect(recordOf(corpus, 'breaker').themes).toEqual([{ id: 'steady', title: 'Steady', route: '/themes/steady.html', role: { text: 'Stop hammering it', md: 'Stop hammering it' } }]);
    expect(recordOf(corpus, 'storm').themes).toEqual([]);
    expect(recordOf(corpus, 'steady').tour).toEqual([
      { id: 'breaker', title: 'Breaker', route: '/patterns/distributed/resilience/breaker.html', role: { text: 'Stop hammering it', md: 'Stop hammering it' } },
      { id: 'retry', title: 'Retry', route: '/patterns/distributed/resilience/retry.html', role: { text: 'Ride out blips', md: 'Ride out blips' } },
    ]);
    // Only a theme has a tour.
    expect(recordOf(corpus, 'breaker').tour).toEqual([]);
  });

  it('leaves out a stage whose route names no page, and a role keeps its markdown', () => {
    // The `loop` theme's second stage is /patterns/gone.html.
    expect(recordOf(corpus, 'loop').tour.map((s) => s.id)).toEqual(['queue']);
    const { own, corpus: c } = edited((o) => rewrite(o, 'docs/data/learning-paths.json', (t) => t.replace('"role": "Stop hammering it"', '"role": "Stop **hammering** it"')));
    try {
      expect(recordOf(c, 'breaker').themes[0]?.role).toEqual({ text: 'Stop hammering it', md: 'Stop **hammering** it' });
    } finally {
      own.cleanup();
    }
  });

  it('reads what to read first, and what sits beside the page, from the prerequisite file', () => {
    expect(recordOf(corpus, 'validators').prerequisites).toEqual({ requires: ['boundary'], related: [] });
    expect(recordOf(corpus, 'breaker').prerequisites).toEqual({ requires: [], related: ['retry'] });
    // A page with no record, and a record with no edge, have none.
    expect(recordOf(corpus, 'storm').prerequisites).toEqual({ requires: [], related: [] });
    expect(recordOf(corpus, 'boundary').prerequisites).toEqual({ requires: [], related: [] });
  });

  it('has none anywhere in a tree that has no prerequisite file', () => {
    const plain = makeSandbox();
    try {
      writeKbFixture(plain.dir);
      const c = new Corpus(plain.dir);
      for (const p of c.listing) expect(recordOf(c, p.slug).prerequisites, p.slug).toEqual({ requires: [], related: [] });
    } finally {
      plain.cleanup();
    }
  });
});

describe('mentions', () => {
  it('are the pages the prose links to that nothing typed already names: what backlinks lists', () => {
    expect(recordOf(corpus, 'breaker').mentions).toEqual(['queue']);
    expect(recordOf(corpus, 'retry').mentions).toEqual([]);
    expect(recordOf(corpus, 'boundary').mentions).toEqual(['quick']);
    const session = new Session(corpus, parseArgs([]));
    for (const p of corpus.listing) expect(recordOf(corpus, p.slug).mentions, p.slug).toEqual(session.mentions(p));
  });
});

describe('graphOf', () => {
  const graph = (): ReturnType<typeof graphOf> => graphOf(corpus);

  it('opens with its schema and its contract, the verbs of the content model and every page in listing order', () => {
    const g = graph();
    expect(Object.keys(g)).toEqual(['$schema', 'contract', 'verbs', 'nodes', 'edges', 'tours', 'mentions']);
    expect(g.$schema).toBe('https://odere-pro.github.io/patterns-kb/schema/kb-graph-1.json');
    expect(g.contract).toBe('kb-graph/1');
    expect(g.verbs).toHaveLength(19);
    expect(g.verbs[0]).toEqual({ id: 'combines-with', label: 'Combines with', inverse: 'combines-with', symmetric: true });
    expect(g.verbs.find((v) => v.id === 'variant-of')).toEqual({ id: 'variant-of', label: 'Variant of', inverse: 'has-variant', symmetric: false });
    expect(g.nodes.map((n) => n.id)).toEqual(corpus.listing.map((p) => p.slug));
    expect(g.nodes[0]).toEqual({
      id: 'breaker',
      kind: 'pattern',
      band: 'distributed',
      group: 'distributed-resilience',
      title: 'Breaker',
      route: '/patterns/distributed/resilience/breaker.html',
      record: '/patterns/distributed/resilience/breaker.json',
    });
    // By kind in the order the kinds are listed in, then in reading order.
    expect([...new Set(g.nodes.map((n) => n.kind))]).toEqual([...KIND_SEQ]);
  });

  it('lists each edge once, in the order of the relations file, with both sides’ words, groups and pins', () => {
    const { edges } = graph();
    expect(edges.map((e) => [e.a, e.verb, e.b])).toEqual([
      ['breaker', 'combines-with', 'retry'],
      ['breaker', 'prevents-hazard', 'storm'],
      ['validators', 'implements', 'boundary'],
      ['validators', 'prerequisite', 'boundary'],
    ]);
    expect(edges[1]).toEqual({
      a: 'breaker',
      verb: 'prevents-hazard',
      b: 'storm',
      inverse: 'mitigated-by',
      noteA: { text: 'Fails fast', md: 'Fails *fast*' },
      noteB: { text: 'Fails fast', md: 'Fails fast' },
      groupA: 'Prevents',
      groupB: 'Mitigated by',
      mapsA: null,
      mapsB: null,
    });
    expect(edges[2]).toMatchObject({
      inverse: 'implemented-by',
      groupA: 'Implements',
      groupB: 'Off the shelf',
      noteB: { text: 'Buy it off the shelf.', md: 'Buy it **off the shelf**.' },
      mapsA: { id: 'mapping-row-1', label: 'Schema validation' },
      mapsB: null,
    });
    expect(edges[3]).toMatchObject({ inverse: 'enables', groupA: 'Read first', groupB: 'Enables' });
  });

  it('lists a tour for each theme that is a page, in stage order, less a stage that names no page', () => {
    expect(graph().tours).toEqual([
      {
        theme: 'steady',
        stages: [
          { id: 'breaker', role: { text: 'Stop hammering it', md: 'Stop hammering it' } },
          { id: 'retry', role: { text: 'Ride out blips', md: 'Ride out blips' } },
        ],
      },
      { theme: 'loop', stages: [{ id: 'queue', role: { text: 'Holds the work', md: 'Holds the work' } }] },
    ]);
  });

  it('lists every prose mention under the page it is from, in listing order', () => {
    const { mentions } = graph();
    expect(mentions).toEqual([
      { from: 'breaker', to: 'queue' },
      { from: 'boundary', to: 'quick' },
    ]);
    const session = new Session(corpus, parseArgs([]));
    expect(mentions).toEqual(corpus.listing.flatMap((p) => session.mentions(p).map((to) => ({ from: p.slug, to }))));
  });

  it('writes each edge on both of its pages, the first with the verb and the other with the inverse', () => {
    const g = graph();
    for (const e of g.edges) {
      const edge = { a: e.a, verb: e.verb, b: e.b };
      const fromA = recordOf(corpus, e.a).relations.filter((r) => r.edge.a === e.a && r.edge.b === e.b && r.edge.verb === e.verb && r.to === e.b);
      const fromB = recordOf(corpus, e.b).relations.filter((r) => r.edge.a === e.a && r.edge.b === e.b && r.edge.verb === e.verb && r.to === e.a);
      expect(fromA, JSON.stringify(edge)).toHaveLength(1);
      expect(fromB, JSON.stringify(edge)).toHaveLength(1);
      expect(fromA[0]).toMatchObject({ verb: e.verb, inverse: e.inverse, group: e.groupA, maps: e.mapsA, note: e.noteA });
      expect(fromB[0]).toMatchObject({ verb: e.inverse, inverse: e.verb, group: e.groupB, maps: e.mapsB, note: e.noteB });
    }
  });

  it('builds the same bytes twice', () => {
    expect(serialize(graph())).toBe(serialize(graphOf(new Corpus(sb.dir))));
  });
});

describe('resolveRefs', () => {
  /** The fingerprint of the first pro of the breaker: its words, folded. */
  const pro1 = fingerprint('Fails fast.');

  it('finds an element by the page id, and tells where it sits: its block, its group, its place and its words', () => {
    const whole = recordOf(corpus, 'breaker');
    expect(at(whole, whole.anchors['tradeoffs-pro-1'] as string)['fp']).toBe(pro1);
    const [r] = resolveRefs(corpus, ['breaker#tradeoffs-pro-1']);
    expect(r).toEqual({
      ref: 'breaker#tradeoffs-pro-1',
      page: 'breaker',
      id: 'tradeoffs-pro-1',
      fp: null,
      status: 'ok',
      now: { id: 'tradeoffs-pro-1', fp: pro1 },
      pointer: recordOf(corpus, 'breaker').anchors['tradeoffs-pro-1'],
      block: 'tradeoffs',
      group: 'pro',
      text: 'Fails fast.',
    });
    const [pinned] = resolveRefs(corpus, [`breaker#tradeoffs-pro-1@${pro1}`]);
    expect(pinned).toMatchObject({ status: 'ok', fp: pro1, now: { id: 'tradeoffs-pro-1', fp: pro1 } });
  });

  it('has no group for an element outside one, and says so for the heading of a group and for a block', () => {
    expect(resolveRefs(corpus, ['breaker#description-p-1'])[0]).toMatchObject({ status: 'ok', block: 'description', group: null });
    // A requirement group, and the prose that follows a polarity group's list, which belongs to the block (X-06).
    expect(resolveRefs(corpus, ['shortener#requirements-fr-1'])[0]).toMatchObject({ block: 'requirements', group: 'fr' });
    expect(resolveRefs(corpus, ['breaker#usage-p-1'])[0]).toMatchObject({ block: 'usage', group: 'when', text: 'It holds a socket too.' });
    expect(resolveRefs(corpus, ['breaker#usage-p-2'])[0]).toMatchObject({ block: 'usage', group: null, text: 'A trailing smell paragraph.' });
    // A block is cited by its name, has no fingerprint, and sits in no block but itself.
    expect(resolveRefs(corpus, ['breaker#tradeoffs'])[0]).toMatchObject({ status: 'ok', now: { id: 'tradeoffs', fp: null }, block: 'tradeoffs', group: null, pointer: '/blocks/4' });
  });

  it('takes the page as an id, a path in docs/, a path on the site or a site address, with or without a pin', () => {
    const rest = `#tradeoffs-pro-1@${pro1}`;
    const forms = [
      'breaker',
      BREAKER,
      '/patterns/distributed/resilience/breaker.html',
      'patterns/distributed/resilience/breaker.html',
      '/patterns/distributed/resilience/breaker.md',
      'https://odere-pro.github.io/patterns-kb/patterns/distributed/resilience/breaker.html',
      'https://odere-pro.github.io/patterns-kb/patterns/distributed/resilience/breaker.md',
      './breaker.md',
      'https://example.test/anywhere/breaker.html?utm=1',
    ];
    for (const form of forms) {
      for (const pin of [rest, '#tradeoffs-pro-1']) {
        const [r] = resolveRefs(corpus, [`${form}${pin}`]);
        expect(r, `${form}${pin}`).toMatchObject({ page: 'breaker', id: 'tradeoffs-pro-1', status: 'ok' });
      }
    }
  });

  it('answers each citation in the order given, and checks them all before it looks at one', () => {
    const results = resolveRefs(corpus, ['retry#usage-when-1', 'breaker#tradeoffs-pro-1', 'nothing#x']);
    expect(results.map((r) => [r.page, r.status])).toEqual([
      ['retry', 'ok'],
      ['breaker', 'ok'],
      ['nothing', 'gone'],
    ]);
    expect(() => resolveRefs(corpus, ['breaker#tradeoffs-pro-1', 'breaker'])).toThrow(KbUsageError);
  });

  it.each([
    ['no #', 'breaker', 'breaker: not a citation — write <id>#<element>, and @<fp> after it to pin its words'],
    ['no element', 'breaker#', 'breaker#: names no element after the #'],
    ['no element, a pin', 'breaker#@aaaaaaaa', 'breaker#@aaaaaaaa: names no element after the #'],
    ['no page', '#tradeoffs-pro-1', '#tradeoffs-pro-1: names no page before the #'],
    ['no page, an address that ends in a slash', 'https://example.test/#x', 'https://example.test/#x: names no page before the #'],
    ['a pin that is too short', 'breaker#x@abc', 'breaker#x@abc: the fingerprint after @ is 8 lower-case hex digits'],
    ['a pin in capitals', 'breaker#x@ABCDEF12', 'breaker#x@ABCDEF12: the fingerprint after @ is 8 lower-case hex digits'],
    ['an empty pin', 'breaker#x@', 'breaker#x@: the fingerprint after @ is 8 lower-case hex digits'],
  ])('refuses a citation with %s, in one line, as a call made badly', (_name, ref, message) => {
    expect(() => resolveRefs(corpus, [ref])).toThrow(KbUsageError);
    expect(() => resolveRefs(corpus, [ref])).toThrow(new KbUsageError(message));
  });

  it('says gone for a page that is no page of the seven kinds, and for an element with no pin that is not there', () => {
    expect(resolveRefs(corpus, ['notes#x'])[0]).toEqual({
      ref: 'notes#x',
      page: 'notes',
      id: 'x',
      fp: null,
      status: 'gone',
      now: null,
      pointer: null,
      block: null,
      group: null,
      text: null,
    });
    expect(resolveRefs(corpus, ['breaker#tradeoffs-pro-99'])[0]).toMatchObject({ status: 'gone', now: null });
    // A page that is gone is gone with a pin too.
    expect(resolveRefs(corpus, ['nowhere#tradeoffs-pro-1@aaaaaaaa'])[0]).toMatchObject({ status: 'gone' });
  });

  it('says changed when the element is there and its words are not the ones cited, and what it says now', () => {
    const r = resolveRefs(corpus, ['breaker#tradeoffs-pro-1@00000000'])[0] as Resolved;
    expect(r).toMatchObject({ status: 'changed', fp: '00000000', now: { id: 'tradeoffs-pro-1', fp: pro1 }, block: 'tradeoffs', group: 'pro', text: 'Fails fast.' });
  });

  it('ignores a pin on a block, whose id is its name and does not renumber: ok, with no fingerprint cited or found', () => {
    const whole = recordOf(corpus, 'breaker');
    expect(at(whole, whole.anchors['tradeoffs'] as string)).not.toHaveProperty('fp');
    const expected = { status: 'ok', fp: null, now: { id: 'tradeoffs', fp: null }, pointer: '/blocks/4', block: 'tradeoffs', group: null };
    // A pin that matches nothing, and one that is the fingerprint of an element of the page: neither moves, splits or changes it.
    const pins = ['00000000', pro1, fingerprint('Check each value once, at the edge.')];
    for (const pin of pins) {
      const [r] = resolveRefs(corpus, [`breaker#tradeoffs@${pin}`]);
      expect(r, pin).toMatchObject({ ref: `breaker#tradeoffs@${pin}`, page: 'breaker', id: 'tradeoffs', ...expected });
    }
    // The pin is also ignored on a page where two elements say the pinned words, which would be ambiguous for any element.
    const said = fingerprint('Check each value once, at the edge.');
    expect(resolveRefs(corpus, [`boundary#description@${said}`, `boundary#applying@${said}`, `boundary#description-p-9@${said}`]).map((r) => [r.status, r.fp])).toEqual([
      ['ok', null],
      ['ok', null],
      ['ambiguous', said],
    ]);
    // With no pin it is the same answer.
    expect(resolveRefs(corpus, ['breaker#tradeoffs'])[0]).toMatchObject(expected);
  });

  it('says ambiguous when the cited words are on several elements and not on the cited id', () => {
    // Boundary says one sentence in two places.
    const said = fingerprint('Check each value once, at the edge.');
    const twice = resolveRefs(corpus, [`boundary#description-p-9@${said}`, `boundary#overreach-p-1@${said}`, `boundary#description-p-1@${said}`]);
    expect(twice.map((r) => r.status)).toEqual(['ambiguous', 'ambiguous', 'ok']);
    expect(twice[0]).toMatchObject({ now: null, pointer: null, block: null, group: null, text: null });
  });

  describe('when a page is edited', () => {
    const pros = '- Fails fast.\n- Frees threads.';
    const old = fingerprint('Frees threads.');

    /** The citation of the second pro of the breaker, as it was made, answered against the page after `edit`. */
    function after(edit: (text: string) => string): Resolved {
      const { own, corpus: c } = edited((o) => rewrite(o, BREAKER, (t) => t.replace(pros, edit(pros))));
      try {
        return resolveRefs(c, [`breaker#tradeoffs-pro-2@${old}`])[0] as Resolved;
      } finally {
        own.cleanup();
      }
    }

    it('says moved when the element is renumbered, and where its words went', () => {
      const r = after(() => '- Frees threads.\n- Fails fast.');
      expect(r).toMatchObject({ status: 'moved', id: 'tradeoffs-pro-2', now: { id: 'tradeoffs-pro-1', fp: old }, group: 'pro', block: 'tradeoffs', text: 'Frees threads.' });
    });

    it('says moved when something is put in above the element and its id moves down', () => {
      const r = after(() => '- Fails fast.\n- A new first thing.\n- Frees threads.');
      expect(r).toMatchObject({ status: 'moved', now: { id: 'tradeoffs-pro-3', fp: old } });
    });

    it('says changed when the cited id says something else and the words are nowhere else', () => {
      const r = after(() => '- Fails fast.\n- Frees threads and sockets.');
      expect(r).toMatchObject({ status: 'changed', now: { id: 'tradeoffs-pro-2', fp: fingerprint('Frees threads and sockets.') }, text: 'Frees threads and sockets.' });
    });

    it('says gone when the element is taken out and its words are nowhere on the page', () => {
      expect(after(() => '- Fails fast.')).toMatchObject({ status: 'gone', now: null, text: null });
    });

    it('says ambiguous when the words are now on two other elements', () => {
      expect(after(() => '- Fails fast.\n- Frees threads.\n- Frees threads.')).toMatchObject({ status: 'ok' });
      expect(after(() => '- Frees threads.\n- Fails fast.\n- Frees threads.')).toMatchObject({ status: 'ambiguous', now: null });
    });

    it('says ok for an element in the intro, which sits in no block', () => {
      const { own, corpus: c } = edited((o) => rewrite(o, BREAKER, (t) => t.replace('# Breaker\n\nStops calling', '# Breaker\n\nStops calling {#intro-keyed}\n\nStops calling')));
      try {
        // Two paragraphs, the first with the id; the second says it again, unkeyed.
        expect(resolveRefs(c, ['breaker#intro-keyed'])[0]).toMatchObject({ status: 'ok', block: null, group: null, pointer: '/intro/0' });
      } finally {
        own.cleanup();
      }
    });
  });
});

describe('resolveLine', () => {
  const base = { ref: 'breaker#x@aaaaaaaa', page: 'breaker', id: 'x', fp: 'aaaaaaaa', pointer: null, block: null, group: null, text: null };

  it('is the status in a column, then the citation, then where it went or what it says now', () => {
    expect(resolveLine({ ...base, status: 'ok', now: { id: 'x', fp: 'aaaaaaaa' } })).toBe('ok        breaker#x@aaaaaaaa');
    expect(resolveLine({ ...base, status: 'moved', now: { id: 'y', fp: 'aaaaaaaa' } })).toBe('moved     breaker#x@aaaaaaaa → y');
    expect(resolveLine({ ...base, status: 'changed', now: { id: 'x', fp: 'bbbbbbbb' } })).toBe('changed   breaker#x@aaaaaaaa → now @bbbbbbbb');
    expect(resolveLine({ ...base, status: 'ambiguous', now: null })).toBe('ambiguous breaker#x@aaaaaaaa');
    expect(resolveLine({ ...base, status: 'gone', now: null })).toBe('gone      breaker#x@aaaaaaaa');
  });

  it('prints a pin on a block as it was given, and says ok', () => {
    const [r] = resolveRefs(corpus, ['breaker#tradeoffs@00000000']);
    expect(resolveLine(r as Resolved)).toBe('ok        breaker#tradeoffs@00000000');
  });
});

describe('determinism', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes the same bytes for the same page, in one corpus and in another', () => {
    const first = serialize(recordOf(corpus, 'boundary'));
    expect(serialize(recordOf(corpus, 'boundary'))).toBe(first);
    expect(serialize(recordOf(new Corpus(sb.dir), 'boundary'))).toBe(first);
    expect(first.endsWith('}\n')).toBe(true);
  });

  it('writes the same bytes on any day and asks for no random number', () => {
    const random = vi.spyOn(Math, 'random');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-02-02T00:00:00Z'));
    const first = serialize(recordOf(new Corpus(sb.dir), 'breaker'));
    vi.setSystemTime(new Date('2031-03-03T00:00:00Z'));
    expect(serialize(recordOf(new Corpus(sb.dir), 'breaker'))).toBe(first);
    expect(random).not.toHaveBeenCalled();
  });

  it('never reads the clock, the locale, a random number or the environment', () => {
    for (const file of ['record.ts', '../lib/kb-place.ts']) {
      const source = fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source, file).not.toMatch(/Date\.now|new Date|Math\.random|localeCompare|Intl\.|randomUUID|process\.env/);
    }
  });
});

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

describe('the real tree', () => {
  /** Up to three pages of each kind: its first, its middle and its last in listing order. */
  function sample(real: Corpus): string[] {
    return KIND_SEQ.flatMap((kind) => {
      const ids = real.listing.filter((p) => p.kind === kind).map((p) => p.slug);
      return [...new Set([ids[0], ids[Math.floor(ids.length / 2)], ids.at(-1)])].flatMap((id) => (id === undefined ? [] : [id]));
    });
  }

  it('holds the record of twenty pages of every kind to the closed kb-record-1 schema, whole and one block at a time', () => {
    const real = new Corpus(REPO_ROOT);
    const schemas = contractSchemas(REPO_ROOT, { closed: true });
    const ids = sample(real);
    expect(ids.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ids.map((id) => real.need(id).kind)).size).toBe(KIND_SEQ.length);
    for (const id of ids) {
      expect(schemas.validate(schemaUrl('kb-record-1'), recordOf(real, id)).map(formatFinding), id).toEqual([]);
    }
    const usage = recordOf(real, 'circuit-breaker', { blocks: ['usage', 'tradeoffs'] });
    expect(usage.scope).toEqual(['tradeoffs', 'usage']);
    expect(schemas.validate(schemaUrl('kb-record-1'), usage).map(formatFinding)).toEqual([]);
  }, REAL_TREE_TIMEOUT);

  it('holds the graph to the closed kb-graph-1 schema, and has each of its edges on both of its pages', () => {
    const real = new Corpus(REPO_ROOT);
    const schemas = contractSchemas(REPO_ROOT, { closed: true });
    const g = graphOf(real);
    expect(schemas.validate(schemaUrl('kb-graph-1'), g).map(formatFinding)).toEqual([]);
    expect(g.nodes).toHaveLength(real.pages.length);
    expect(g.edges).toHaveLength(real.relations.relations.length);
    const records = new Map(g.nodes.map((n) => [n.id, recordOf(real, n.id)]));
    for (const e of g.edges) {
      const rows = (id: string, verb: string, to: string): PageRecord['relations'] =>
        (records.get(id) as PageRecord).relations.filter((r) => r.verb === verb && r.to === to && r.edge.a === e.a && r.edge.b === e.b && r.edge.verb === e.verb);
      const fromA = rows(e.a, e.verb, e.b);
      const fromB = rows(e.b, e.inverse, e.a);
      expect(fromA, `${e.a} ${e.verb} ${e.b}`).toHaveLength(1);
      expect(fromB, `${e.b} ${e.inverse} ${e.a}`).toHaveLength(1);
      expect(fromA[0], `${e.a} ${e.verb} ${e.b}`).toMatchObject({ inverse: e.inverse, group: e.groupA, maps: e.mapsA, note: e.noteA });
      expect(fromB[0], `${e.b} ${e.inverse} ${e.a}`).toMatchObject({ inverse: e.verb, group: e.groupB, maps: e.mapsB, note: e.noteB });
    }
    const session = new Session(real, parseArgs([]));
    for (const [id, record] of records) {
      expect(record.relations.map((r) => [r.verb, r.to]), id).toEqual(session.relations(id).map((r) => [r.verb, r.to]));
    }
  }, REAL_TREE_TIMEOUT);

  it('checks a citation of a real element against its own fingerprint: ok, then changed once the words differ', () => {
    const real = new Corpus(REPO_ROOT);
    const record = recordOf(real, 'circuit-breaker');
    const con = at(record, record.anchors['tradeoffs-con-2'] as string);
    const fp = con['fp'] as string;
    const [ok, other] = resolveRefs(real, [`circuit-breaker#tradeoffs-con-2@${fp}`, 'circuit-breaker#tradeoffs-con-2@00000000']);
    expect(ok).toMatchObject({ status: 'ok', now: { id: 'tradeoffs-con-2', fp }, block: 'tradeoffs', group: 'con', text: con['text'] });
    expect(other).toMatchObject({ status: 'changed', now: { id: 'tradeoffs-con-2', fp } });
  }, REAL_TREE_TIMEOUT);
});
