/**
 * The relations gate over docs/data/relations.json. Every case plants one
 * fault in a clean fixture tree and asserts the whole answer — exit status,
 * the exact finding lines and the record's line — because a gate that says
 * "something is wrong" somewhere in a file of 1,300 records has not said
 * enough. The last block runs it on the real tree.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capture, expectFail, expectMisuse, expectPass, makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';
import {
  CONTENT_MODEL,
  publishedPages,
  RELATIONS,
  spec,
  STRUCTURE,
  verbTable,
  type VerbTable,
} from './check-relations.js';
import {
  HEADER,
  json,
  lineOf,
  RELATION_RECORDS,
  relationsJson,
  relationsTree,
  row,
  structureFileJson,
  AREAS,
  STORE_PAGE,
  verbModelJson,
  VERBS,
  type RecordFixture,
} from '../lib/fixtures.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const findings = (err: string): string[] => err.split('\n').filter((l) => l.startsWith('[relations] FAIL'));
const FAIL = `[relations] FAIL ${RELATIONS}`;

/** Run the gate over the fixture tree with `records` as the edges. */
async function withRecords(records: readonly unknown[], extra: Readonly<Record<string, unknown>> = {}) {
  relationsTree(sb, records, extra);
  return sb.run(spec);
}

/** The line a record opens on: the line above its `"a"` key, which the test keeps unique. */
const recordLine = (a: string): number => lineOf(sb.read(RELATIONS), `"a": "${a}"`) - 1;

const edge = (a: string, verb: string, b: string, more: Readonly<Record<string, unknown>> = {}): RecordFixture => ({
  a,
  verb,
  b,
  note_a: `${a} side`,
  note_b: `${b} side`,
  ...more,
});

describe('a clean tree', () => {
  it('passes with one summary line counting edges, sides, pages and mapped rows', async () => {
    const r = await withRecords(RELATION_RECORDS);
    expectPass(r);
    expect(r.err).toBe('');
    expect(r.out).toBe(
      '[relations] 4 edges (8 sides) on 5 pages, 1 mapped to a table row: every edge resolved and closed over 9 verbs',
    );
  });

  it('keeps two verb families on one pair: two true things, not a duplicate', async () => {
    const r = await withRecords([...RELATION_RECORDS, edge('beta', 'variant-of', 'alpha'), edge('alpha', 'combines-with', 'gamma')]);
    expectPass(r);
  });

  it('answers --nope and --fix with exit 2, writing nothing', async () => {
    relationsTree(sb);
    const before = sb.snapshot();
    for (const arg of ['--nope', '--fix', 'docs/data/relations.json']) {
      const r = await sb.run(spec, [arg]);
      expectMisuse(r);
      expect(r.out).toBe('');
    }
    expect(sb.snapshot()).toEqual(before);
  });
});

describe('exposed-to', () => {
  const withDesign = (records: readonly unknown[]) => {
    relationsTree(sb, records);
    sb.write(
      STRUCTURE,
      structureFileJson({ ...AREAS, designs: [row('designs', 'shop')] }),
    );
    return sb.run(spec);
  };

  it('passes from a pattern or a design to a hazard, and written from the hazard side as threatens', async () => {
    expectPass(await withDesign([edge('alpha', 'exposed-to', 'delta'), edge('shop', 'exposed-to', 'delta')]));
  });

  it('rejects a threatens record, which is the second verb of its pair', async () => {
    const r = await withDesign([edge('delta', 'threatens', 'alpha')]);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('delta')}: delta threatens alpha: writes "threatens", the second verb of its pair — write it as alpha exposed-to delta, notes swapped`,
    ]);
  });

  it('rejects an exposed side that is not a pattern or a design, and a threat that is not a hazard', async () => {
    const r = await withDesign([edge('delta', 'exposed-to', 'alpha'), edge('store', 'exposed-to', 'beta')]);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('delta')}: delta exposed-to alpha: delta is exposed to a hazard, so it must be a pattern or a design — exposed-to runs from a pattern or design to a hazard`,
      `${FAIL}:${recordLine('delta')}: delta exposed-to alpha: alpha threatens delta, so it must be a hazard — exposed-to runs from a pattern or design to a hazard`,
      `${FAIL}:${recordLine('store')}: store exposed-to beta: store is exposed to a hazard, so it must be a pattern or a design — exposed-to runs from a pattern or design to a hazard`,
      `${FAIL}:${recordLine('store')}: store exposed-to beta: beta threatens store, so it must be a hazard — exposed-to runs from a pattern or design to a hazard`,
    ]);
  });

  it('leaves an unpublished page to the resolved rule, with no direction finding', async () => {
    const r = await withDesign([edge('alpha', 'exposed-to', 'nowhere')]);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('alpha')}: alpha exposed-to nowhere: nowhere is no published page — ${STRUCTURE} has no row with that slug`,
    ]);
  });
});

describe('the files it reads', () => {
  it('names each missing file once, and checks nothing further', async () => {
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}: is missing — every page's relationships block is rendered from it`,
      `[relations] FAIL ${CONTENT_MODEL}: is missing — the relations gate reads the closed verbs from it`,
      `[relations] FAIL ${STRUCTURE}: is missing — the relations gate reads the published pages from it`,
    ]);
  });

  it('names a relations file that is not JSON at the parser’s line, and nothing else (data-C3)', async () => {
    relationsTree(sb);
    sb.write(RELATIONS, '{\n  "version": 1,\n  not json\n}\n');
    const r = await sb.run(spec);
    expectFail(r);
    const f = findings(r.err);
    expect(f).toHaveLength(1);
    expect(f[0]?.startsWith(`${FAIL}:3: is not valid JSON — `)).toBe(true);
  });

  it('names a content model with no verb table, one with a broken entry, and one whose pair does not pair back', async () => {
    const cases: [unknown, string][] = [
      [{ ...HEADER }, 'has no relations.verbs list'],
      [{ ...HEADER, relations: { verbs: [] } }, 'has no relations.verbs list'],
      [{ ...HEADER, relations: { verbs: [{ id: 'x', label: 'X' }] } }, 'relations.verbs holds an entry without id, label and inverse'],
      [
        { ...HEADER, relations: { verbs: [...VERBS.slice(0, 2), { id: 'has-variant', label: 'Has variant', inverse: 'combines-with' }] } },
        'relations.verbs pairs "variant-of" with "has-variant", which does not pair back',
      ],
    ];
    for (const [model, what] of cases) {
      relationsTree(sb);
      sb.write(CONTENT_MODEL, json(model));
      const r = await sb.run(spec);
      expectFail(r);
      expect(findings(r.err)).toEqual([`[relations] FAIL ${CONTENT_MODEL}: ${what}`]);
    }
  });

  it('names a structure file with no areas, and a relations file that is not an object, in one run', async () => {
    relationsTree(sb);
    sb.write(STRUCTURE, json({ ...HEADER }));
    sb.write(RELATIONS, '[]\n');
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `[relations] FAIL ${STRUCTURE}: has no areas list, so no page is published`,
      `${FAIL}: is not a JSON object`,
    ]);
  });

  it('names an unknown top-level key and a missing relations list at their lines', async () => {
    relationsTree(sb);
    sb.write(RELATIONS, json({ ...HEADER, relation: [] }));
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:5: unknown key "relation" — the file holds version, updated, note, relations, group_order`,
      `${FAIL}: has no relations list`,
    ]);
  });
});

describe('one record', () => {
  it('names a record that is not an object, an unknown key and a missing a, verb or b', async () => {
    const r = await withRecords([...RELATION_RECORDS, 'alpha', { a: 'beta', verb: '', note_a: '', note_b: '', flavour: 1 }]);
    expectFail(r);
    const text = sb.read(RELATIONS);
    const beta = recordLine('beta');
    expect(findings(r.err)).toEqual([
      `${FAIL}:${lineOf(text, '    "alpha",')}: relations[4] is not an object`,
      `${FAIL}:${beta}: beta ? ?: unknown key "flavour" — a record holds a, verb, b, note_a, note_b, group_a, group_b, maps_a, maps_b, maps_label_a, maps_label_b`,
      `${FAIL}:${beta}: beta ? ?: has no verb`,
      `${FAIL}:${beta}: beta ? ?: has no b`,
    ]);
  });

  it('names a side with no note as the one-way edge it is, and passes an empty note', async () => {
    const r = await withRecords([{ a: 'beta', verb: 'combines-with', b: 'gamma', note_a: '' }]);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('beta')}: beta combines-with gamma: has no note_b — b's side of the edge is missing; write its note, "" for none`,
    ]);
  });

  it('names a verb outside the closed list, and stops there', async () => {
    const r = await withRecords([edge('beta', 'resembles', 'nobody')]);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('beta')}: beta resembles nobody: "resembles" is not one of the 9 verbs ${CONTENT_MODEL} lists`,
    ]);
  });

  it('names the second verb of a pair, spelling the record it should be', async () => {
    const r = await withRecords([edge('alpha', 'has-variant', 'gamma')]);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('alpha')}: alpha has-variant gamma: writes "has-variant", the second verb of its pair — write it as gamma variant-of alpha, notes swapped`,
    ]);
  });

  it('names an edge from a page to itself, and each side that is no published page', async () => {
    const r = await withRecords([edge('beta', 'combines-with', 'beta'), edge('ghost', 'prevents-hazard', 'phantom')]);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('beta')}: beta combines-with beta: relates a page to itself`,
      `${FAIL}:${recordLine('ghost')}: ghost prevents-hazard phantom: ghost is no published page — ${STRUCTURE} has no row with that slug`,
      `${FAIL}:${recordLine('ghost')}: ghost prevents-hazard phantom: phantom is no published page — ${STRUCTURE} has no row with that slug`,
    ]);
  });
});

describe('one edge per pair and verb family', () => {
  it('names the same edge twice, a symmetric edge written back, and an inverse spelling of an edge already there', async () => {
    const r = await withRecords([
      edge('alpha', 'combines-with', 'beta'),
      edge('beta', 'variant-of', 'gamma'),
      edge('gamma', 'combines-with', 'alpha'),
      edge('delta', 'combines-with', 'store'),
      edge('store', 'combines-with', 'delta'),
      edge('gamma', 'has-variant', 'beta'),
    ]);
    expectFail(r);
    const text = sb.read(RELATIONS);
    const second = lineOf(text, '"a": "store"') - 1;
    const hasVariant = lineOf(text, '"verb": "has-variant"') - 2;
    expect(findings(r.err)).toEqual([
      `${FAIL}:${second}: store combines-with delta: repeats the edge at line ${recordLine('delta')}`,
      `${FAIL}:${hasVariant}: gamma has-variant beta: writes "has-variant", the second verb of its pair — write it as beta variant-of gamma, notes swapped`,
      `${FAIL}:${hasVariant}: gamma has-variant beta: repeats the edge at line ${recordLine('beta')}`,
    ]);
  });

  it('names a directed edge that points both ways as a contradiction, citing the first', async () => {
    const r = await withRecords([edge('beta', 'variant-of', 'gamma'), edge('gamma', 'variant-of', 'beta')]);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('gamma')}: gamma variant-of beta: contradicts line ${recordLine('beta')}, which says beta variant-of gamma — a directed edge points one way`,
    ]);
  });
});

describe('groups and mapped rows', () => {
  it('names a group that is not a heading and one that repeats the verb’s label', async () => {
    const r = await withRecords([
      edge('alpha', 'combines-with', 'beta', { group_a: '' }),
      edge('gamma', 'prevents-hazard', 'delta', { group_b: 'Mitigated by' }),
    ]);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('alpha')}: alpha combines-with beta: group_a is not a heading — drop the key, or write the heading`,
      `${FAIL}:${recordLine('gamma')}: gamma prevents-hazard delta: group_b "Mitigated by" is the verb's own label — drop the key`,
    ]);
  });

  it('names a map that is no id, one on a side that does not read implements, and one naming no row', async () => {
    const r = await withRecords([
      edge('store', 'implements', 'alpha', { maps_a: 3 }),
      edge('beta', 'combines-with', 'gamma', { maps_a: 'mapping-row-1' }),
      edge('store', 'implements', 'gamma', { maps_b: 'mapping-row-1', maps_a: 'mapping-row-9' }),
      edge('store', 'implements', 'beta', { maps_a: 'mapping-row-1', maps_label_a: 'Blobs' }),
    ]);
    expectFail(r);
    const text = sb.read(RELATIONS);
    // The first and second store records open on the line above their "a" key.
    const [first, third] = text.split('\n').flatMap((l, i) => (l.includes('"a": "store"') ? [i] : []));
    expect(findings(r.err)).toEqual([
      `${FAIL}:${String(first)}: store implements alpha: maps_a is not an element id`,
      `${FAIL}:${recordLine('beta')}: beta combines-with gamma: maps_a sits on beta's side, which reads "combines-with" — only a side that reads "implements" maps to a table row`,
      `${FAIL}:${String(third)}: store implements gamma: maps_b sits on gamma's side, which reads "implemented-by" — only a side that reads "implements" maps to a table row`,
      `${FAIL}:${String(third)}: store implements gamma: maps_a "mapping-row-9" names no row of store's mapping or matrix table (docs/capabilities/store.md)`,
    ]);
  });

  it('names a pin with no label, a label with no pin, and a row that moved or left', async () => {
    const r = await withRecords([
      edge('store', 'implements', 'alpha', { maps_a: 'mapping-row-1' }),
      edge('beta', 'combines-with', 'gamma', { maps_label_a: 'Blobs' }),
      edge('store', 'implements', 'gamma', { maps_a: 'mapping-row-1', maps_label_a: 'Queues' }),
      edge('store', 'implements', 'beta', { maps_a: 'mapping-row-2', maps_label_a: 'Streams' }),
    ]);
    expectFail(r);
    const [first, second, third] = sb
      .read(RELATIONS)
      .split('\n')
      .flatMap((l, i) => (l.includes('"a": "store"') ? [i] : []));
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('beta')}: beta combines-with gamma: maps_label_a sits on a side that maps to no row — drop it, or write maps_a`,
      `${FAIL}:${String(first)}: store implements alpha: maps_a "mapping-row-1" has no maps_label_a — write the row's label, "Blobs"`,
      `${FAIL}:${String(second)}: store implements gamma: maps_a "mapping-row-1" reads "Blobs", not its maps_label_a "Queues" — that row is mapping-row-2 now; re-pin maps_a to it`,
      `${FAIL}:${String(third)}: store implements beta: maps_a "mapping-row-2" reads "Queues", not its maps_label_a "Streams" — that row is gone from the table; re-pin the edge or drop it`,
    ]);
  });

  it('fails a pin when a row is inserted above it, and names where its row went', async () => {
    relationsTree(sb);
    sb.write('docs/capabilities/store.md', STORE_PAGE.replace('| Blobs | S3 |', '| Files | EFS |\n| Blobs | S3 |'));
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('store')}: store implements alpha: maps_a "mapping-row-2" reads "Blobs", not its maps_label_a "Queues" — that row is mapping-row-3 now; re-pin maps_a to it`,
    ]);
  });

  it('names a map into a page whose file is gone, or which is no published page', async () => {
    relationsTree(sb, [edge('store', 'implements', 'alpha', { maps_a: 'mapping-row-1' }), edge('shop', 'implements', 'beta', { maps_a: 'mapping-row-1' })]);
    sb.rm('docs/capabilities/store.md');
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${recordLine('shop')}: shop implements beta: shop is no published page — ${STRUCTURE} has no row with that slug`,
      `${FAIL}:${recordLine('store')}: store implements alpha: maps_a "mapping-row-1" names no row of store's mapping or matrix table (docs/capabilities/store.md)`,
      `${FAIL}:${recordLine('shop')}: shop implements beta: maps_a "mapping-row-1" names no row of shop's mapping or matrix table`,
    ]);
  });

  it('passes a group_order that pins every group, and names each fault in one that does not', async () => {
    const records = [
      edge('alpha', 'combines-with', 'beta', { group_a: 'Together' }),
      edge('alpha', 'prevents-hazard', 'delta'),
    ];
    let r = await withRecords(records, { group_order: { alpha: ['Prevents', 'Together'] } });
    expectPass(r);

    r = await withRecords(records, {
      group_order: { alpha: ['Prevents', 'Prevents', 'Combines with'], ghost: ['Together'], beta: 'Combines with' },
    });
    expectFail(r);
    const text = sb.read(RELATIONS);
    expect(findings(r.err)).toEqual([
      `${FAIL}:${lineOf(text, '"alpha": [')}: group_order.alpha pins "Prevents" twice`,
      `${FAIL}:${lineOf(text, '"alpha": [')}: group_order.alpha pins "Combines with", a group none of its edges sit under`,
      `${FAIL}:${lineOf(text, '"ghost": [')}: group_order names ghost, which is no published page`,
      `${FAIL}:${lineOf(text, '"ghost": [')}: group_order.ghost pins "Together", a group none of its edges sit under`,
      `${FAIL}:${lineOf(text, '"beta": ')}: group_order.beta is not a list of group headings`,
    ]);

    r = await withRecords(records, { group_order: [] });
    expectFail(r);
    expect(findings(r.err)).toEqual([`${FAIL}:${lineOf(sb.read(RELATIONS), '"group_order"')}: group_order is not an object of page slugs`]);
  });
});

describe('the helpers', () => {
  it('verbTable writes a symmetric verb and the first of each pair', () => {
    const t = verbTable({ relations: { verbs: VERBS } }) as VerbTable;
    expect([...t.written]).toEqual(['combines-with', 'variant-of', 'prevents-hazard', 'exposed-to', 'implements']);
    expect(verbTable(null)).toBe('has no relations.verbs list');
  });

  it('publishedPages reads slugs and sources, skipping rows it cannot read', () => {
    expect(publishedPages({ areas: 'x' })).toBeNull();
    expect(publishedPages(null)).toBeNull();
    expect(
      publishedPages({ areas: [{ pages: [{ slug: 'a', source: 'docs/a.md' }, { slug: 'b' }, { source: 'docs/c.md' }, 7] }, { id: 'no-rows' }, 3] }),
    ).toEqual(new Map([['a', 'docs/a.md'], ['b', '']]));
  });

  it('the fixture writer keeps notes as given', () => {
    expect(JSON.parse(relationsJson([], { group_order: {} }))).toEqual({ ...HEADER, relations: [], group_order: {} });
    expect(JSON.parse(verbModelJson([])).relations.verbs).toEqual([]);
  });
});

describe('the real tree', () => {
  it('passes the real relations file with nothing on stderr', async () => {
    const r = await capture(spec, [], REPO_ROOT);
    expectPass(r);
    expect(r.err).toBe('');
    const file = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, RELATIONS), 'utf8')) as { relations: unknown[] };
    expect(r.out).toContain(`[relations] ${file.relations.length} edges (${2 * file.relations.length} sides)`);
  });
});
