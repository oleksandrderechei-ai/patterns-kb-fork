/**
 * The record-schema gate: a tree whose pages and commands hold their schemas
 * passes with one line that counts what it held; each way a page can break a
 * schema is one finding that names the page, the command and the pointer; the
 * findings of one page are capped; a schema that is missing, is not JSON or
 * does not compile is named before any page is read; and the two small
 * judgements the gate makes of a call (how it ended, which element of a record
 * to cite) are held on their own.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SCHEMA_DIR } from '../contract/contract.js';
import { Corpus } from '../kb/corpus.js';
import { REAL_TREE_TIMEOUT, writeRecordFixture } from '../lib/fixtures.js';
import { serialize } from '../lib/kb-record.js';
import { capture, expectFail, expectMisuse, expectPass, makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';
import { answerOf, refOf, SHOWN, spec } from './check-kb-records.js';
import { SRC as ORACLE } from './check-search-oracle.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
  writeRecordFixture(sb.dir);
  sb.copyRepo(SCHEMA_DIR);
  oracle([{ q: 'breaker', top: ['breaker'] }, { q: 'queue', top: ['queue'] }, { q: 'zzzzqqq', top: ['breaker'] }]);
});
afterEach(() => sb.cleanup());

/** Write a search oracle holding `cases`: what the gate reads is each case's `q`. */
function oracle(cases: unknown): void {
  sb.write(ORACLE, `${JSON.stringify({ version: 1, updated: '2026-09-30', note: 'fixture', cases }, null, 2)}\n`);
}

/** A parsed JSON object, to be edited in place. */
type Json = Record<string, unknown>;

/** The member `key` of an object inside a parsed schema. */
const member = (node: unknown, key: string): Json => (node as Json)[key] as Json;

/** Rewrite the schema file `<base>.json` of the sandbox through `edit`. */
function editSchema(base: string, edit: (schema: Json) => void): void {
  const file = `${SCHEMA_DIR}/${base}.json`;
  const schema = JSON.parse(sb.read(file)) as Json;
  edit(schema);
  sb.write(file, `${JSON.stringify(schema, null, 2)}\n`);
}

/** The `$defs` entry `name` of a parsed schema. */
const definition = (schema: Json, name: string): Json => member(schema['$defs'], name);

/** The finding lines a run printed. */
const findings = (err: string): string[] => err.split('\n');

const BREAKER = 'docs/patterns/distributed/resilience/breaker.md';

/** How many pages the fixture tree has. */
const pages = (): number => new Corpus(sb.dir).listing.length;

describe('check-kb-records', () => {
  it('passes a tree whose records and command outputs hold their schemas, and says what it held', async () => {
    const r = await sb.run(spec);
    expectPass(r);
    expect(pages()).toBeGreaterThan(9);
    expect(r.out).toBe(
      `[kb-record-schema] ${String(pages())} pages: record, get, related, backlinks, refs and resolve hold kb-record/1 and kb-cli/1; ls, validate, graph and 3 queries too`,
    );
    expect(r.err).toBe('');
  });

  it('writes nothing into the tree it reads', async () => {
    const before = sb.snapshot();
    expectPass(await sb.run(spec));
    expect(sb.snapshot()).toEqual(before);
  });

  it('names the page, the command and the pointer when a record breaks its schema', async () => {
    editSchema('kb-record-1', (schema) => {
      member(schema, 'properties')['title'] = { type: 'string', pattern: '^Z' };
    });
    const r = await sb.run(spec);
    expectFail(r, `[kb-record-schema] FAIL ${BREAKER}: record /title: must match pattern "^Z" (pattern)`);
    // One finding for each page, and none for any other command.
    expect(findings(r.err)).toHaveLength(pages());
    for (const line of findings(r.err)) expect(line).toMatch(/^\[kb-record-schema\] FAIL docs\/[a-z/-]+\.md: record \/title: /);
  });

  it('names a pointer deep in the record, an index of an array included', async () => {
    editSchema('kb-record-1', (schema) => {
      definition(schema, 'areaRef')['properties'] = { id: { type: 'string' }, label: { type: 'string', pattern: '^Z' } };
    });
    const r = await sb.run(spec);
    expectFail(r, `${BREAKER}: record /areaChain/0/label: must match pattern "^Z" (pattern)`);
  });

  it('names a command whose output breaks its schema, and a query that does, by the command and the pointer', async () => {
    editSchema('kb-cli-1', (schema) => {
      member(definition(schema, 'relationRow'), 'properties')['label'] = { type: 'string', pattern: '^Z' };
    });
    const r = await sb.run(spec);
    expectFail(r);
    const lines = findings(r.err);
    expect(lines).toContain(`[kb-record-schema] FAIL ${BREAKER}: related /0/label: must match pattern "^Z" (pattern)`);
    expect(lines).toContain(`[kb-record-schema] FAIL ${BREAKER}: get /relations/0/label: must match pattern "^Z" (pattern)`);
    // A query is named by what it asked and the finding sits in the file that lists it.
    expect(lines).toContain(`[kb-record-schema] FAIL ${ORACLE}: brief "breaker" /related/breaker/0/label: must match pattern "^Z" (pattern)`);
    expect(lines.some((l) => l.includes(': record '))).toBe(false);
  });

  it('names a command of the whole tree by the command alone, with no file', async () => {
    editSchema('kb-graph-1', (schema) => {
      member(schema, 'properties')['contract'] = { type: 'string', const: 'kb-graph/2' };
    });
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual(['[kb-record-schema] FAIL: graph /contract: must be equal to constant (const)']);
  });

  it('names an object whose keys are in another order than the schema lists them', async () => {
    editSchema('kb-record-1', (schema) => {
      definition(schema, 'source')['properties'] = {
        sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        path: { type: 'string' },
      };
    });
    const r = await sb.run(spec);
    expectFail(r, `${BREAKER}: record /source: from key 1 printed path, sha256 where the schema lists sha256, path (key order)`);
    expect(findings(r.err)).toHaveLength(pages());
  });

  it('names at most five findings of a page, then counts the rest', async () => {
    editSchema('kb-record-1', (schema) => {
      definition(schema, 'id')['pattern'] = '^zzz$';
    });
    const r = await sb.run(spec);
    expectFail(r);
    const own = findings(r.err).filter((l) => l.includes(` ${BREAKER}: `));
    expect(own).toHaveLength(SHOWN + 1);
    expect(own.slice(0, SHOWN).every((l) => /: record \/[^ ]*id: must match pattern "\^zzz\$" \(pattern\)$/.test(l))).toBe(true);
    expect(own[SHOWN]).toMatch(new RegExp(`^\\[kb-record-schema\\] FAIL ${BREAKER}: … and [1-9]\\d* more$`));
  });

  it('names a page the record cannot hold by the exit of the command and what it said, and goes on to the other commands of the page', async () => {
    sb.write(BREAKER, sb.read(BREAKER).replace('<!-- relationships:end -->\n', ''));
    const r = await sb.run(spec);
    expectFail(r);
    const own = findings(r.err).filter((l) => l.includes(` ${BREAKER}: `));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/: record: exits 1, not 0 — stderr says "breaker: .*relationships.*"$/);
  });

  describe('a schema it cannot judge with', () => {
    it('is named when it is missing, before any page is read: with the pages and the oracle gone, only the schema is named', async () => {
      sb.rm(`${SCHEMA_DIR}/kb-graph-1.json`);
      sb.rm('docs');
      sb.rm(ORACLE);
      const r = await sb.run(spec);
      expectFail(r);
      expect(findings(r.err)).toEqual([`[kb-record-schema] FAIL ${SCHEMA_DIR}/kb-graph-1.json: is missing — the commands of kb.mjs are held to it`]);
    });

    it('is named once for each of the three when the whole folder is missing', async () => {
      sb.rm(SCHEMA_DIR);
      const r = await sb.run(spec);
      expectFail(r);
      expect(findings(r.err)).toEqual(
        ['kb-cli-1', 'kb-record-1', 'kb-graph-1'].map((base) => `[kb-record-schema] FAIL ${SCHEMA_DIR}/${base}.json: is missing — the commands of kb.mjs are held to it`),
      );
    });

    it('is named when it is not JSON, with the file and what the parser said, and not by its full path', async () => {
      sb.write(`${SCHEMA_DIR}/kb-record-1.json`, '{');
      const r = await sb.run(spec);
      expectFail(r);
      expect(findings(r.err)).toHaveLength(1);
      expect(r.err).toMatch(new RegExp(`^\\[kb-record-schema\\] FAIL ${SCHEMA_DIR}: kb-record-1.json: is not valid JSON — .+$`));
      expect(r.err).not.toContain(sb.dir);
    });

    it('is named when it has no $id, which no command could be held to', async () => {
      editSchema('kb-record-1', (schema) => {
        delete schema['$id'];
      });
      const r = await sb.run(spec);
      expectFail(r);
      expect(findings(r.err)).toHaveLength(1);
      expect(r.err).toMatch(new RegExp(`^\\[kb-record-schema\\] FAIL ${SCHEMA_DIR}: schema \\d+ has no "\\$id"$`));
    });

    it('is named once when it does not compile, though nine commands are held to it, and says why', async () => {
      editSchema('kb-cli-1', (schema) => {
        member(definition(schema, 'catalogRow'), 'properties')['id'] = { type: 'string', format: 'date' };
      });
      const r = await sb.run(spec);
      expectFail(r);
      expect(findings(r.err)).toHaveLength(1);
      expect(r.err).toMatch(new RegExp(`^\\[kb-record-schema\\] FAIL ${SCHEMA_DIR}/kb-cli-1.json: does not compile — unknown format "date" ignored in schema at path "[^"]+"$`));
    });
  });

  describe('the queries of the search oracle', () => {
    it('are named when the file is missing, is not JSON or lists no query, before any page is read', async () => {
      sb.rm(ORACLE);
      expect(findings((await sb.run(spec)).err)).toEqual([`[kb-record-schema] FAIL ${ORACLE}: is missing — it lists the queries \`find\` and \`brief\` are held to their schemas with`]);
      sb.write(ORACLE, '{');
      expect(findings((await sb.run(spec)).err)).toEqual([`[kb-record-schema] FAIL ${ORACLE}: is not valid JSON`]);
      for (const text of ['null', '{}', '{"cases": "none"}', '{"cases": []}', '{"cases": [null, 3, {"q": 4}, {"top": ["breaker"]}]}']) {
        sb.write(ORACLE, text);
        expect(findings((await sb.run(spec)).err), text).toEqual([`[kb-record-schema] FAIL ${ORACLE}: lists no query: no case has a string "q"`]);
      }
    });

    it('are every case with a `q`, so a case the oracle gate would refuse for another fault is still asked', async () => {
      oracle([{ q: 'breaker' }, { q: 'queue', top: [] }, 'not a case', { q: 'retry', wat: 1 }]);
      const r = await sb.run(spec);
      expectPass(r);
      expect(r.out).toContain('and 3 queries too');
    });
  });

  it('names a tree whose pages cannot be listed, with the paths as the tree names them', async () => {
    sb.rm('docs/data/content-model.json');
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toHaveLength(1);
    expect(r.err).toMatch(/^\[kb-record-schema\] FAIL: the pages cannot be listed: cannot read docs\/data\/content-model\.json: ENOENT: no such file or directory, open 'docs\/data\/content-model\.json'$/);
  });

  it('lets a crash of the reader through, since a gate that crashed did not pass', async () => {
    const structure = JSON.parse(sb.read('docs/data/site-structure.json')) as { areas: { pages: Record<string, unknown>[] }[] };
    delete structure.areas.flatMap((a) => a.pages)[0]?.['route'];
    sb.write('docs/data/site-structure.json', JSON.stringify(structure));
    await expect(sb.run(spec)).rejects.toThrow(TypeError);
  });

  it('takes no arguments', async () => {
    expectMisuse(await sb.run(spec, ['--nope']));
    expectMisuse(await sb.run(spec, ['breaker']));
  });

  it('never reads a clock, a random number or the environment', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('./check-kb-records.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/Date\.now|new Date|Math\.random|localeCompare|Intl\.|randomUUID|process\.env/);
  });

  it(
    'holds the real tree (real tree)',
    async () => {
      const r = await capture(spec, [], REPO_ROOT);
      expectPass(r);
      expect(r.out.trim()).toMatch(
        /^\[kb-record-schema\] [1-9]\d* pages: record, get, related, backlinks, refs and resolve hold kb-record\/1 and kb-cli\/1; ls, validate, graph and [1-9]\d* queries too$/,
      );
    },
    REAL_TREE_TIMEOUT,
  );
});

describe('answerOf', () => {
  const printed = (value: unknown): string => serialize(value).slice(0, -1);
  const ran = (code: number, out: string, err = ''): { code: number; out: string; err: string } => ({ code, out, err });

  it('gives the value of a call that ended as the contract says: an allowed exit, no stderr, the two-space JSON of its value', () => {
    expect(answerOf('get', ran(0, printed({ id: 'a', blocks: [] })), [0])).toEqual({ value: { id: 'a', blocks: [] } });
    expect(answerOf('validate', ran(1, printed({ pages: 1 })), [0, 1])).toEqual({ value: { pages: 1 } });
    expect(answerOf('ls', ran(0, printed([])), [0])).toEqual({ value: [] });
  });

  it('names an exit that is not allowed, with the first line stderr said', () => {
    expect(answerOf('get', ran(1, '', 'unknown id: x\ndid you mean: y'), [0])).toEqual({ problem: 'get: exits 1, not 0 — stderr says "unknown id: x"' });
    expect(answerOf('validate', ran(2, ''), [0, 1])).toEqual({ problem: 'validate: exits 2, not 0 or 1' });
  });

  it('names stderr on a call that ended well: the contract is one document on stdout and nothing else', () => {
    expect(answerOf('get', ran(0, printed({}), 'warning: x\nmore'), [0])).toEqual({ problem: 'get: writes to stderr: "warning: x"' });
  });

  it('names output that is no JSON, on one line, with the parser’s reason', () => {
    const problem = (answerOf('find', ran(0, 'no match for "x"'), [0]) as { problem: string }).problem;
    expect(problem).toMatch(/^find: does not print JSON — .+$/);
    expect(problem).not.toContain('\n');
    expect(answerOf('find', ran(0, ''), [0])).toEqual({ problem: expect.stringMatching(/^find: does not print JSON — /) });
  });

  it('names JSON that is not the two-space form with one newline: compact, tabbed, or with the newline left off', () => {
    const value = { a: [1, 2] };
    for (const out of [JSON.stringify(value), JSON.stringify(value, null, '\t'), `${printed(value)}\n`, printed(value).replace(/\n/g, '\r\n')]) {
      expect(answerOf('ls', ran(0, out), [0]), JSON.stringify(out)).toEqual({ problem: 'ls: is not two-space JSON with one newline at the end' });
    }
  });
});

describe('refOf', () => {
  const record = (anchors: Record<string, string>, extra: Record<string, unknown> = {}): unknown => ({
    id: 'breaker',
    intro: [{ type: 'paragraph', id: 'description-p-1', fp: 'aaaaaaaa' }],
    blocks: [
      { id: 'description', name: 'description', content: [{ type: 'paragraph', id: 'description-p-1', fp: 'bbbbbbbb' }] },
      { id: 'tradeoffs', name: 'tradeoffs', content: [{ type: 'list', id: null, fp: null, items: [{ id: 'tradeoffs-con-1', fp: 'cccccccc' }] }] },
    ],
    anchors,
    ...extra,
  });

  it('cites the first element of a record that has a fingerprint, passing a block, which has none', () => {
    const anchors = { description: '/blocks/0', 'description-p-1': '/blocks/0/content/0', 'tradeoffs-con-1': '/blocks/1/content/0/items/0' };
    expect(refOf(record(anchors))).toBe('breaker#description-p-1@bbbbbbbb');
    expect(refOf(record({ description: '/blocks/0', 'tradeoffs-con-1': '/blocks/1/content/0/items/0' }))).toBe('breaker#tradeoffs-con-1@cccccccc');
  });

  it('reads an anchor in the intro, and a pointer whose steps are written with ~0 and ~1', () => {
    expect(refOf(record({ 'description-p-1': '/intro/0' }))).toBe('breaker#description-p-1@aaaaaaaa');
    expect(refOf({ id: 'x', anchors: { 'a-1': '/a~1b/c~0d' }, 'a/b': { 'c~d': { fp: 'dddddddd' } } })).toBe('x#a-1@dddddddd');
  });

  it('passes an anchor whose element has a null fingerprint or whose pointer leads nowhere', () => {
    expect(refOf(record({ list: '/blocks/1/content/0', gone: '/blocks/9/content/0', odd: '/blocks/0/id/0/x' }))).toBeNull();
    expect(refOf(record({ list: '/blocks/1/content/0', gone: '/blocks/9/content/0', 'tradeoffs-con-1': '/blocks/1/content/0/items/0' }))).toBe('breaker#tradeoffs-con-1@cccccccc');
  });

  it('has nothing to cite in what is no record, or a record with no anchor with a fingerprint', () => {
    for (const value of [undefined, null, 'record', 3, [], {}, { id: 3, anchors: {} }, { id: 'x' }, { id: 'x', anchors: null }, { id: 'x', anchors: 'none' }, record({})]) {
      expect(refOf(value), JSON.stringify(value)).toBeNull();
    }
  });
});
