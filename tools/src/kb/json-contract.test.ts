/**
 * The `--json` contract of every kb.mjs read command, pinned to the key.
 *
 * Skills and agents parse this output, so a renamed, dropped or retyped key
 * must fail here rather than in a consumer. Each command runs against the
 * fixture tree the other cli tests use, and its result is compared as an exact
 * sorted key set with the type of every value. The fields a row only carries
 * when the page has them (a favourite flag, aliases, a sketch marker) are
 * pinned on the one fixture page that has them all, and every other row must
 * stay inside that set and keep the always-present core.
 *
 * An error is not JSON: a failed command writes one line to stderr and nothing
 * to stdout, with or without `--json`, and exits 1 when the call was well made
 * and failed (an unknown id or block) or 2 when it was made badly (an unknown
 * command or flag, a flag with no value, a missing argument, a crash). That
 * shape is pinned too.
 *
 * What the commands print is also published: tools/src/contract/schema/
 * kb-cli-1.json holds one definition per command, and `record` and `graph`,
 * which each print one whole document, have the schema of their own
 * (kb-record-1.json, kb-graph-1.json). Each describe below ends in a test that
 * holds the command's output to its schema in the form the repo checks (every
 * object closed, every key in the order the schema lists it), and the last
 * describes hold the schema files themselves to the facts a fixture tree cannot
 * show.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CLI_OUTPUT_SCHEMAS, CONTRACTS, contractSchemas, SCHEMA_BASES, schemaDir, schemaUrl } from '../contract/contract.js';
import { writeKbFixture, writeRecordFixture } from '../lib/fixtures.js';
import { formatFinding, type SchemaSet } from '../lib/json-schema.js';
import { fingerprint } from '../lib/kb-record.js';
import { makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';

import { main, run } from './cli.js';
import { Corpus, KIND_SEQ } from './corpus.js';
import { CLI_COMMANDS } from './spec.js';

let sb: Sandbox;
beforeAll(() => {
  sb = makeSandbox();
  writeKbFixture(sb.dir);
});
afterAll(() => sb.cleanup());

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function kb(...argv: string[]): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, sb.dir);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** The parsed `--json` output of a command that exits as expected. */
async function asJson(code: number, ...argv: string[]): Promise<unknown> {
  const r = await kb(...argv, '--json');
  expect(r.code, r.err).toBe(code);
  expect(r.err).toBe('');
  return JSON.parse(r.out) as unknown;
}

/** One value's type, with arrays and null told apart from objects. */
const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** An object as `{ key: type }` with its keys sorted, so a diff names the key that moved. */
function shape(v: unknown): Record<string, string> {
  const o = v as Record<string, unknown>;
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, typeOf(o[k])]));
}

/** Every key of the richest catalog row, with its type. */
const NODE: Record<string, string> = {
  aliases: 'array',
  band: 'string',
  essence: 'string',
  favourite: 'boolean',
  hasExample: 'boolean',
  hasExplain: 'boolean',
  id: 'string',
  kind: 'string',
  name: 'string',
  path: 'string',
  solves: 'array',
  tags: 'array',
};
/** The keys every catalog row has, whatever the page. */
const CORE = ['band', 'essence', 'id', 'kind', 'name', 'path'];

/** A catalog row: inside the full set, types as pinned, core present. */
function expectNode(row: unknown, extra: Record<string, string> = {}): void {
  const s = shape(row);
  for (const k of CORE) expect(s, `row lacks ${k}`).toHaveProperty(k);
  const allowed = { ...NODE, ...extra };
  for (const [k, t] of Object.entries(s)) expect(allowed[k], `unexpected key ${k}`).toBe(t);
}

/** A relation row: `verb` is the name to read, `type` its deprecated alias, and the two come right after each other, equal. */
const RELATION = { label: 'string', note: 'string', to: 'string', type: 'string', verb: 'string' };
const THEME_REF = { href: 'string', id: 'string', name: 'string', role: 'string' };

/** A relation row has its keys in this order, `verb` right after its alias (`type`, `rel` in refs), and equal to it. */
function expectRelationRow(row: unknown, keys: string[], alias = 'type'): void {
  const r = row as Record<string, unknown>;
  expect(Object.keys(r)).toEqual(keys);
  expect(keys.indexOf('verb')).toBe(keys.indexOf(alias) + 1);
  expect(typeof r['verb']).toBe('string');
  expect(r['verb']).toBe(r[alias]);
}

/** The part of a schema node the checks below read. */
interface SchemaNode {
  readonly $ref?: string;
  readonly $id?: string;
  readonly anyOf?: readonly SchemaNode[];
  readonly oneOf?: readonly SchemaNode[];
  readonly items?: SchemaNode;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly additionalProperties?: SchemaNode | boolean;
  readonly required?: readonly string[];
  readonly enum?: readonly (string | null)[];
  readonly const?: unknown;
  readonly pattern?: string;
  readonly description?: string;
  readonly $defs?: Readonly<Record<string, SchemaNode>>;
}

/** One schema file as written, for the checks that read what the file says rather than what it accepts. */
const files = new Map<string, SchemaNode>();
function schemaFile(base: string): SchemaNode {
  let file = files.get(base);
  if (file === undefined) {
    file = JSON.parse(fs.readFileSync(path.join(schemaDir(REPO_ROOT), `${base}.json`), 'utf8')) as SchemaNode;
    files.set(base, file);
  }
  return file;
}

/** The kb-cli schema file as written. */
const cliSchema = (): SchemaNode => schemaFile(SCHEMA_BASES.cli);

/** The definitions of a schema file, by name. */
const defsOf = (file: SchemaNode): Readonly<Record<string, SchemaNode>> => file.$defs as Readonly<Record<string, SchemaNode>>;

/** A definition of the kb-cli schema, by name. */
function definitionOf(name: string): SchemaNode {
  return defsOf(cliSchema())[name] as SchemaNode;
}

/**
 * The published schemas in the form the repo checks them, every object closed
 * to a key the schema does not list, so a key the code starts printing without
 * the schema saying so is a finding. Made on first use: a schema that does not
 * compile fails the tests that need it and not the file.
 */
let published: SchemaSet | undefined;
function schemas(): SchemaSet {
  published ??= contractSchemas(REPO_ROOT, { closed: true });
  return published;
}

/** Every way `value` breaks the schema `id`, in the form the repo checks, as the lines a gate would print. */
function findingsOfId(id: string, value: unknown): string[] {
  return schemas().validate(id, value).map(formatFinding);
}

/** Every way `value` breaks the schema `command`'s output is held to, as the lines a gate would print. */
function findingsOf(command: string, value: unknown): string[] {
  return findingsOfId(CLI_OUTPUT_SCHEMAS[command] as string, value);
}

/** A call run over a tree of its own, or over a corpus already read, as `kb` runs one over the shared fixture. */
async function runAt(dir: string | Corpus, ...argv: string[]): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, dir);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/**
 * Where an object's keys are printed in another order than the schema lists its
 * properties. The schema is written in the order each command prints, so a
 * reader of the file sees the output's order, and a key the code moves without
 * the schema moving is a finding. `defs` are the definitions a `$ref` names, of
 * the file the schema is in. A value no `anyOf` branch fits in order reports
 * the first branch; a node a `oneOf` discriminates by its `type` is read
 * against the branch that names its type.
 */
function keyOrderProblems(value: unknown, node: SchemaNode, at = '', defs: Readonly<Record<string, SchemaNode>> = defsOf(cliSchema())): string[] {
  const named = (n: SchemaNode): SchemaNode => (n.$ref === undefined ? n : (defs[n.$ref.slice('#/$defs/'.length)] as SchemaNode));
  const schema = named(node);
  if (schema.oneOf !== undefined) {
    const type = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined;
    const branch = schema.oneOf.find((b) => named(b).properties?.['type']?.const === type) ?? schema.oneOf.find((b) => named(b).oneOf !== undefined);
    return branch === undefined ? [] : keyOrderProblems(value, branch, at, defs);
  }
  if (schema.anyOf !== undefined) {
    const tries = schema.anyOf.map((branch) => keyOrderProblems(value, branch, at, defs));
    return tries.some((t) => t.length === 0) ? [] : (tries[0] as string[]);
  }
  if (Array.isArray(value)) {
    const item = schema.items;
    return item === undefined ? [] : value.flatMap((v: unknown, i) => keyOrderProblems(v, item, `${at}/${String(i)}`, defs));
  }
  if (typeof value !== 'object' || value === null) return [];
  const listed = Object.keys(schema.properties ?? {});
  const printed = Object.keys(value).filter((k) => listed.includes(k));
  const expected = listed.filter((k) => k in value);
  const problems = printed.join() === expected.join() ? [] : [`${at === '' ? '/' : at}: printed ${printed.join(', ')} where the schema lists ${expected.join(', ')}`];
  const each = typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined;
  for (const [key, child] of Object.entries(value)) {
    const sub = schema.properties?.[key] ?? each;
    if (sub !== undefined) problems.push(...keyOrderProblems(child, sub, `${at}/${key}`, defs));
  }
  return problems;
}

/**
 * The key-order problems of `output`, what `command` printed, against the
 * schema it is published in: a definition of kb-cli-1.json, or the whole of the
 * record's or the graph's own file.
 */
function orderProblemsOf(command: string, output: unknown): string[] {
  const id = CLI_OUTPUT_SCHEMAS[command] as string;
  const [url, definition] = id.split('#/$defs/');
  const file = schemaFile(path.posix.basename(url as string, '.json'));
  return keyOrderProblems(output, definition === undefined ? file : { $ref: `#/$defs/${definition}` }, '', defsOf(file));
}

/**
 * Hold `output`, what `call` printed, to the published schema for `command`:
 * no finding against the closed schema, and every key in the order the schema
 * lists it. The lines of whatever is wrong are the failure message.
 */
function expectConforms(command: string, output: unknown, call: string): void {
  expect(findingsOf(command, output), `${call} against ${CLI_OUTPUT_SCHEMAS[command] as string}`).toEqual([]);
  expect(orderProblemsOf(command, output), `${call}: key order`).toEqual([]);
}

/** The ids of every page of the fixture tree. */
async function pageIds(): Promise<string[]> {
  return ((await asJson(0, 'ls')) as { id: string }[]).map((r) => r.id);
}

describe('find --json', () => {
  it('is an array of catalog rows plus why, the richest row carrying every key', async () => {
    const rows = (await asJson(0, 'find', 'breaker')) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(shape(rows[0])).toEqual({ ...NODE, why: 'string' });
    for (const r of rows) expectNode(r, { why: 'string' });
  });

  it('validates against its published legacy schema', async () => {
    // A search, one that finds nothing, a limit, and a filter with no query words: the listing form, rows with no why.
    const calls = [
      ['find', 'breaker'],
      ['find', 'queue'],
      ['find', 'zzzzqqq'],
      ['find', 'breaker', '--n', '1'],
      ['find', 'breaker', '--tag', 'no-such-tag'],
      ['find', '--kind', 'hazard'],
      ['find', '--tag', 'messaging'],
    ];
    for (const argv of calls) expectConforms('find', await asJson(0, ...argv), argv.join(' '));
    const search = (await asJson(0, 'find', 'breaker')) as unknown[];
    const listing = (await asJson(0, 'find', '--kind', 'pattern')) as { why?: unknown }[];
    expect(search.length).toBeGreaterThan(0);
    expect(listing.length).toBeGreaterThan(0);
    expect(listing.every((r) => !('why' in r))).toBe(true);
  });
});

describe('ls --json', () => {
  it('is an array of catalog rows with no why', async () => {
    const rows = (await asJson(0, 'ls')) as unknown[];
    expect(shape(rows[0])).toEqual(NODE);
    for (const r of rows) expectNode(r);
    expect(rows.length).toBeGreaterThan(5);
  });

  it('validates against its published legacy schema', async () => {
    const calls = [['ls'], ['ls', '--kind', 'pattern'], ['ls', '--band', 'messaging'], ['ls', '--kind', 'hazard', '--band', 'messaging']];
    for (const argv of calls) expectConforms('ls', await asJson(0, ...argv), argv.join(' '));
    expect(await asJson(0, 'ls', '--kind', 'hazard', '--band', 'messaging')).toEqual([]);
  });
});

/** The page metadata `get` carries after `source`, in the order it is written, with the type of each value. */
const PAGE_META = {
  area: 'string',
  status: 'string',
  owner: 'string',
  tags: 'array',
  aliases: 'array',
  solves: 'array',
  favourite: 'boolean',
  route: 'string',
  markdown: 'string',
};

/** The header keys of every `get`, in the order they are written. */
const GET_HEADER = ['id', 'name', 'kind', 'band', 'group', 'essence', 'path', 'source', ...Object.keys(PAGE_META)];

describe('get --json', () => {
  it('has the page header and its metadata, every block, the relations and the themes', async () => {
    const page = (await asJson(0, 'get', 'breaker')) as Record<string, unknown>;
    expect(shape(page)).toEqual({
      ...PAGE_META,
      band: 'string',
      blocks: 'object',
      essence: 'string',
      group: 'string',
      id: 'string',
      items: 'object',
      kind: 'string',
      name: 'string',
      path: 'string',
      relations: 'array',
      source: 'string',
      themes: 'array',
    });
    expect(Object.keys(page).slice(0, GET_HEADER.length)).toEqual(GET_HEADER);
    expect(Object.keys(page['items'] as object).sort()).toEqual(['explain', 'production', 'wild']);
    for (const [name, text] of Object.entries(page['blocks'] as object)) expect(typeof text, name).toBe('string');
    expect(Object.keys(page['blocks'] as object)).toEqual(expect.arrayContaining(['description', 'usage', 'wild', 'production', 'explain']));
    for (const r of page['relations'] as unknown[]) {
      expect(shape(r)).toEqual(RELATION);
      expectRelationRow(r, ['type', 'verb', 'to', 'label', 'note']);
    }
    for (const t of page['themes'] as unknown[]) expect(shape(t)).toEqual(THEME_REF);
  });

  it('has its metadata whatever the page: the arrays always there, favourite always a boolean, the route and the markdown beside the path', async () => {
    for (const id of ['breaker', 'storm', 'quick', 'steady', 'queue', 'brokers']) {
      const page = (await asJson(0, 'get', id)) as Record<string, unknown>;
      expect(shape(Object.fromEntries(Object.entries(page).filter(([k]) => k in PAGE_META))), id).toEqual(PAGE_META);
      expect(page['route'], id).toBe(`/${page['path'] as string}`);
      expect(page['markdown'], id).toBe((page['route'] as string).replace(/\.html$/, '.md'));
      expect(page['markdown'], id).toMatch(/^\/.+\.md$/);
    }
  });

  it('with --block keeps the header keys, drops items, and holds only that block', async () => {
    const page = (await asJson(0, 'get', 'breaker', '--block', 'usage')) as Record<string, unknown>;
    expect(Object.keys(page)).toEqual([...GET_HEADER, 'blocks', 'relations', 'themes']);
    expect(Object.keys(page['blocks'] as object)).toEqual(['usage']);
  });

  it('adds items for the three blocks the writers read back: wild, production and explain', async () => {
    for (const block of ['wild', 'production', 'explain']) {
      const page = (await asJson(0, 'get', 'breaker', '--block', block)) as Record<string, unknown>;
      expect(Object.keys(page), block).toEqual([...GET_HEADER, 'blocks', 'items', 'relations', 'themes']);
      expect(Object.keys(page['items'] as object), block).toEqual([block]);
    }
    const explain = ((await asJson(0, 'get', 'breaker', '--block', 'explain')) as { items: { explain: Record<string, unknown> } }).items.explain;
    expect(shape(explain)).toMatchObject({ example: 'string', text: 'string' });
    const wild = ((await asJson(0, 'get', 'breaker', '--block', 'wild')) as { items: { wild: unknown[] } }).items.wild;
    expect(Array.isArray(wild)).toBe(true);
    expect(shape(wild[0])).toEqual({ id: 'string', name: 'string', note: 'string' });
    const production = ((await asJson(0, 'get', 'breaker', '--block', 'production')) as { items: { production: Record<string, unknown> } }).items.production;
    expect(Object.keys(production).sort()).toEqual(['checklist', 'failures', 'knobs', 'signals']);
    for (const v of Object.values(production)) expect(Array.isArray(v)).toBe(true);
  });

  it('validates against its published legacy schema', async () => {
    // Every page whole, then every block of it alone, and the diagrams kept.
    for (const id of await pageIds()) {
      const page = (await asJson(0, 'get', id)) as { blocks: Record<string, string> };
      expectConforms('get', page, `get ${id}`);
      for (const block of Object.keys(page.blocks)) expectConforms('get', await asJson(0, 'get', id, '--block', block), `get ${id} --block ${block}`);
    }
    expectConforms('get', await asJson(0, 'get', 'breaker', '--diagrams'), 'get breaker --diagrams');
  });
});

describe('brief --json', () => {
  it('has the query, the matches, the governing theme and the neighbours of the top hits', async () => {
    const brief = (await asJson(0, 'brief', 'breaker')) as Record<string, unknown>;
    expect(shape(brief)).toEqual({ matches: 'array', query: 'string', related: 'object', theme: 'object' });
    for (const m of brief['matches'] as unknown[]) expectNode(m, { why: 'string' });
    expect(shape(brief['theme'])).toEqual({ decide: 'string', id: 'string' });
    const related = brief['related'] as Record<string, unknown[]>;
    expect(Object.keys(related).length).toBeGreaterThan(0);
    for (const rels of Object.values(related)) {
      for (const r of rels) {
        expect(shape(r)).toEqual(RELATION);
        expectRelationRow(r, ['type', 'verb', 'to', 'label', 'note']);
      }
    }
  });

  it('keeps the same four keys when nothing matches: no matches, no theme, no neighbours', async () => {
    const none = (await asJson(0, 'brief', 'zzzzqqq')) as Record<string, unknown>;
    expect(Object.keys(none)).toEqual(['query', 'matches', 'theme', 'related']);
    expect(none).toEqual({ query: 'zzzzqqq', matches: [], theme: null, related: {} });
    // The same shape from a filter that leaves no candidate, and with --theme naming a theme: its table, still.
    expect(await asJson(0, 'brief', 'breaker', '--tag', 'no-such-tag')).toMatchObject({ matches: [], theme: null, related: {} });
    const named = (await asJson(0, 'brief', 'zzzzqqq', '--theme', 'steady')) as { matches: unknown[]; theme: Record<string, unknown>; related: object };
    expect(named.matches).toEqual([]);
    expect(shape(named.theme)).toEqual({ decide: 'string', id: 'string' });
    expect(named.related).toEqual({});
  });

  it('validates against its published legacy schema', async () => {
    // A hit, a hit with a limit, a filter that leaves nothing, no hit at all, and no hit under a named theme.
    const calls = [
      ['brief', 'breaker'],
      ['brief', 'queue'],
      ['brief', 'breaker', '--n', '1'],
      ['brief', 'breaker', '--tag', 'no-such-tag'],
      ['brief', 'zzzzqqq'],
      ['brief', 'zzzzqqq', '--theme', 'steady'],
      ['brief', 'breaker', '--theme', 'steady'],
    ];
    for (const argv of calls) expectConforms('brief', await asJson(0, ...argv), argv.join(' '));
  });
});

describe('related --json', () => {
  it('is an array of typed edges, each with its verb right after its type', async () => {
    const rels = (await asJson(0, 'related', 'breaker')) as unknown[];
    expect(rels.length).toBeGreaterThan(0);
    for (const r of rels) {
      expect(shape(r)).toEqual(RELATION);
      expectRelationRow(r, ['type', 'verb', 'to', 'label', 'note']);
    }
  });

  it('validates against its published legacy schema', async () => {
    for (const id of await pageIds()) expectConforms('related', await asJson(0, 'related', id), `related ${id}`);
  });
});

describe('backlinks --json', () => {
  it('has the id, the inbound edges, who mentions it and whom it mentions', async () => {
    const back = (await asJson(0, 'backlinks', 'breaker')) as Record<string, unknown>;
    expect(shape(back)).toEqual({ id: 'string', inbound: 'array', mentionedBy: 'array', mentions: 'array' });
    expect((back['inbound'] as unknown[]).length).toBeGreaterThan(0);
    for (const r of back['inbound'] as unknown[]) {
      expect(shape(r)).toEqual({ from: 'string', label: 'string', note: 'string', type: 'string', verb: 'string' });
      expectRelationRow(r, ['from', 'type', 'verb', 'label', 'note']);
    }
    for (const k of ['mentionedBy', 'mentions']) for (const id of back[k] as unknown[]) expect(typeof id).toBe('string');
  });

  it('validates against its published legacy schema', async () => {
    for (const id of await pageIds()) expectConforms('backlinks', await asJson(0, 'backlinks', id), `backlinks ${id}`);
  });
});

describe('refs --json', () => {
  it('has the page, its typed edges, its members, its fluency and the prose and click targets', async () => {
    const refs = (await asJson(0, 'refs', 'breaker')) as Record<string, unknown>;
    expect(shape(refs)).toEqual({
      clicks: 'array',
      fluency: 'array',
      id: 'string',
      members: 'array',
      path: 'string',
      proseLinks: 'array',
      relations: 'array',
      source: 'string',
      untyped: 'array',
    });
    expect((refs['relations'] as unknown[]).length).toBeGreaterThan(0);
    for (const r of refs['relations'] as unknown[]) {
      expect(shape(r)).toEqual({ rel: 'string', to: 'string', verb: 'string' });
      expectRelationRow(r, ['rel', 'verb', 'to'], 'rel');
    }
    const theme = (await asJson(0, 'refs', 'steady')) as { members: unknown[] };
    expect(theme.members.length).toBeGreaterThan(0);
    for (const m of theme.members) expect(shape(m)).toEqual({ role: 'string', to: 'string' });
  });

  it('validates against its published legacy schema', async () => {
    for (const id of await pageIds()) expectConforms('refs', await asJson(0, 'refs', id), `refs ${id}`);
    const file = path.join(sb.dir, 'docs/patterns/distributed/resilience/breaker.md');
    expectConforms('refs', await asJson(0, 'refs', '--file', file), `refs --file ${file}`);
  });
});

describe('validate --json', () => {
  it('is the page count, the problems and the findings, exit 0 when there are none', async () => {
    const ok = (await asJson(0, 'validate', 'breaker')) as Record<string, unknown>;
    expect(shape(ok)).toEqual({ findings: 'array', pages: 'number', problems: 'array' });
    expect(Object.keys(ok)).toEqual(['pages', 'problems', 'findings']);
    expect(ok).toEqual({ pages: 1, problems: [], findings: [] });
  });

  it('keeps the problems as strings, adds a finding for each, and exits 1 when a page has problems', async () => {
    const bad = (await asJson(1, 'validate')) as { pages: number; problems: unknown[]; findings: unknown[] };
    expect(shape(bad)).toEqual({ findings: 'array', pages: 'number', problems: 'array' });
    expect(bad.problems.length).toBeGreaterThan(0);
    for (const p of bad.problems) expect(typeof p).toBe('string');
    expect(bad.findings).toHaveLength(bad.problems.length);
    for (const f of bad.findings) {
      expect(Object.keys(f as object)).toEqual(['page', 'rule', 'line', 'message']);
      const { rule, line } = f as { rule: unknown; line: unknown };
      expect(rule === null || typeof rule === 'string').toBe(true);
      expect(line === null || typeof line === 'number').toBe(true);
    }
  });

  it('writes each problem string from its finding: the page, then the line, then the rule id, then the words', async () => {
    const bad = (await asJson(1, 'validate')) as { problems: string[]; findings: { page: string; rule: string | null; line: number | null; message: string }[] };
    bad.findings.forEach((f, i) => {
      const text = `${f.page}: ${f.line === null ? '' : `line ${String(f.line)}: `}${f.rule === null ? '' : `${f.rule} `}${f.message}`;
      expect(bad.problems[i]).toBe(text);
    });
  });

  it('validates against its published legacy schema', async () => {
    // No problem, a page and a file named, and the whole tree, which has problems and so exits 1.
    expectConforms('validate', await asJson(0, 'validate', 'breaker'), 'validate breaker');
    const file = path.join(sb.dir, 'docs/patterns/distributed/resilience/breaker.md');
    expectConforms('validate', await asJson(0, 'validate', '--file', file), `validate --file ${file}`);
    const bad = await asJson(1, 'validate');
    expectConforms('validate', bad, 'validate');
    expect((bad as { findings: unknown[] }).findings.length).toBeGreaterThan(0);
  });
});

/** The keys of a kb-record/1 record, in the order they are printed. */
const RECORD_KEYS = [
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

/** The type of each header key of a record. */
const RECORD_HEADER = {
  $schema: 'string',
  contract: 'string',
  scope: 'null',
  id: 'string',
  title: 'string',
  description: 'string',
  kind: 'string',
  band: 'string',
  group: 'string',
  area: 'string',
  areaChain: 'array',
  status: 'string',
  owner: 'string',
  tags: 'array',
  aliases: 'array',
  solves: 'array',
  favourite: 'boolean',
  route: 'string',
  markdown: 'string',
  source: 'object',
  intro: 'array',
  blocks: 'array',
  relations: 'array',
  themes: 'array',
  tour: 'array',
  prerequisites: 'object',
  links: 'array',
  mentions: 'array',
  anchors: 'object',
};

describe('record --json', () => {
  it('is one document: every key of kb-record/1, in the order the contract lists them, whatever the page', async () => {
    for (const id of await pageIds()) {
      const r = (await asJson(0, 'record', id)) as Record<string, unknown>;
      expect(Object.keys(r), id).toEqual(RECORD_KEYS);
      expect(shape(r), id).toEqual(RECORD_HEADER);
      expect(r['$schema']).toBe(schemaUrl(SCHEMA_BASES.record));
      expect(r['contract']).toBe(CONTRACTS.record);
      expect(r['id']).toBe(id);
    }
  });

  it('has a body of typed nodes: blocks with their ids, content and generated marker, every id anchored', async () => {
    const r = (await asJson(0, 'record', 'breaker')) as { blocks: Record<string, unknown>[]; anchors: Record<string, string> };
    expect(r.blocks.map((b) => b['name'])).toEqual(['description', 'explain', 'structure', 'variations', 'tradeoffs', 'usage', 'sketch', 'wild', 'production', 'fluency', 'relationships']);
    expect(Object.keys(r.blocks[0] as object)).toEqual(['id', 'name', 'heading', 'generated', 'content']);
    expect(r.blocks.map((b) => b['generated'])).toEqual([null, null, null, null, null, null, null, null, null, 'fluency', 'relationships']);
    expect(r.anchors['tradeoffs-con-1']).toBe('/blocks/4/content/1/content/0/items/0');
    expect(Object.keys(r.anchors)).toEqual(expect.arrayContaining(['description', 'tradeoffs-pro-1', 'usage-when-1', 'structure-fig-1']));
  });

  it('with --block keeps the header and only the blocks named: the scope says which, the intro goes', async () => {
    const r = (await asJson(0, 'record', 'breaker', '--block', 'usage,tradeoffs')) as Record<string, unknown>;
    expect(Object.keys(r)).toEqual(RECORD_KEYS);
    expect(r['scope']).toEqual(['tradeoffs', 'usage']);
    expect(r['intro']).toEqual([]);
    expect((r['blocks'] as { name: string }[]).map((b) => b.name)).toEqual(['tradeoffs', 'usage']);
    expect(Object.keys(r['anchors'] as object).every((id) => /^(tradeoffs|usage)/.test(id))).toBe(true);
  });

  it('with --all is JSON Lines: a whole record to a line, as many lines as ls has pages', async () => {
    const r = await kb('record', '--all');
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expect(lines).toHaveLength((await pageIds()).length);
    for (const line of lines) expect(Object.keys(JSON.parse(line) as object)).toEqual(RECORD_KEYS);
  });

  it('validates against its published schema', async () => {
    // Every page whole, then every block of it alone, and every line of --all.
    for (const id of await pageIds()) {
      const record = (await asJson(0, 'record', id)) as { blocks: { name: string }[] };
      expectConforms('record', record, `record ${id}`);
      for (const block of record.blocks) expectConforms('record', await asJson(0, 'record', id, '--block', block.name), `record ${id} --block ${block.name}`);
    }
    const lines = (await kb('record', '--all')).out.split('\n');
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expectConforms('record', JSON.parse(line) as unknown, 'record --all');
  });
});

describe('graph --json', () => {
  it('is one document: the contract, the verbs, every page, every edge, every tour and every mention', async () => {
    const g = (await asJson(0, 'graph')) as Record<string, unknown>;
    expect(Object.keys(g)).toEqual(['$schema', 'contract', 'verbs', 'nodes', 'edges', 'tours', 'mentions']);
    expect(shape(g)).toEqual({ $schema: 'string', contract: 'string', verbs: 'array', nodes: 'array', edges: 'array', tours: 'array', mentions: 'array' });
    expect(g['$schema']).toBe(schemaUrl(SCHEMA_BASES.graph));
    expect(g['contract']).toBe(CONTRACTS.graph);
    const nodes = g['nodes'] as Record<string, unknown>[];
    expect(nodes).toHaveLength((await pageIds()).length);
    expect(Object.keys(nodes[0] as object)).toEqual(['id', 'kind', 'band', 'group', 'title', 'route', 'record']);
    const edges = g['edges'] as Record<string, unknown>[];
    expect(edges.length).toBeGreaterThan(0);
    expect(Object.keys(edges[0] as object)).toEqual(['a', 'verb', 'b', 'inverse', 'noteA', 'noteB', 'groupA', 'groupB', 'mapsA', 'mapsB']);
    expect(Object.keys((g['verbs'] as object[])[0] as object)).toEqual(['id', 'label', 'inverse', 'symmetric']);
    expect(Object.keys((g['tours'] as object[])[0] as object)).toEqual(['theme', 'stages']);
  });

  it('validates against its published schema', async () => {
    expectConforms('graph', await asJson(0, 'graph'), 'graph');
  });
});

describe('resolve --json', () => {
  let rsb: Sandbox;
  beforeAll(() => {
    rsb = makeSandbox();
    writeRecordFixture(rsb.dir);
  });
  afterAll(() => rsb.cleanup());

  /** The rows `resolve` prints for `refs` over a tree, and its exit code. */
  async function resolved(dir: string, ...refs: string[]): Promise<{ code: number; rows: Record<string, unknown>[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['resolve', ...refs, '--json'], { out: (l) => out.push(l), err: (l) => err.push(l) }, dir);
    expect(err).toEqual([]);
    return { code, rows: JSON.parse(out.join('\n')) as Record<string, unknown>[] };
  }

  const said = fingerprint('Check each value once, at the edge.');

  it('is an array with a row for each citation, in the order given, each with its ten keys in order and exit 0 when all are ok', async () => {
    const { code, rows } = await resolved(rsb.dir, 'breaker#tradeoffs-pro-1', 'retry#usage-when-1');
    expect(code).toBe(0);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(['ref', 'page', 'id', 'fp', 'status', 'now', 'pointer', 'block', 'group', 'text']);
      expect(shape(row)).toEqual({ ref: 'string', page: 'string', id: 'string', fp: 'null', status: 'string', now: 'object', pointer: 'string', block: 'string', group: 'string', text: 'string' });
      expect(Object.keys(row['now'] as object)).toEqual(['id', 'fp']);
    }
  });

  it('keeps every key for a citation that is not ok, null where there is nothing to say, and exits 1 with the rows printed', async () => {
    const { code, rows } = await resolved(rsb.dir, 'nowhere#x', `boundary#description-p-9@${said}`);
    expect(code).toBe(1);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(['ref', 'page', 'id', 'fp', 'status', 'now', 'pointer', 'block', 'group', 'text']);
      expect([row['now'], row['pointer'], row['block'], row['group'], row['text']]).toEqual([null, null, null, null, null]);
    }
    expect(rows.map((row) => row['status'])).toEqual(['gone', 'ambiguous']);
  });

  it('validates against its published legacy schema', async () => {
    // Every status: ok with a pin and without, changed, ambiguous, gone for an unknown page and an unknown element, and a block, which has no pin.
    const own = makeSandbox();
    try {
      writeRecordFixture(own.dir);
      const page = 'docs/patterns/distributed/resilience/breaker.md';
      own.write(page, own.read(page).replace('- Fails fast.\n- Frees threads.', '- Frees threads.\n- Fails fast.'));
      const refs = [
        'breaker#tradeoffs-pro-1',
        `breaker#tradeoffs-pro-1@${fingerprint('Frees threads.')}`,
        `breaker#tradeoffs-pro-2@${fingerprint('Frees threads.')}`,
        'breaker#tradeoffs-pro-1@00000000',
        `boundary#description-p-9@${said}`,
        'nowhere#x',
        'breaker#nothing-here',
        'breaker#tradeoffs',
        'breaker#tradeoffs@00000000',
        'docs/principles/boundary.md#rationale-core',
      ];
      const { code, rows } = await resolved(own.dir, ...refs);
      expect(code).toBe(1);
      // The pin on the block is ignored: ok, and no fingerprint cited or found.
      expect(rows.map((row) => row['status'])).toEqual(['ok', 'ok', 'moved', 'changed', 'ambiguous', 'gone', 'gone', 'ok', 'ok', 'ok']);
      expect(rows[8]).toMatchObject({ ref: 'breaker#tradeoffs@00000000', id: 'tradeoffs', fp: null, status: 'ok', now: { id: 'tradeoffs', fp: null } });
      expectConforms('resolve', rows, 'resolve');
    } finally {
      own.cleanup();
    }
  });
});

describe('the error shape', () => {
  /** One line on stderr, nothing on stdout, and not JSON: what every failure looks like, with or without --json. */
  async function expectFailure(argv: string[], code: number): Promise<void> {
    for (const extra of [[], ['--json']]) {
      const r = await kb(...argv, ...extra);
      expect(r.code, `kb.mjs ${argv.join(' ')} ${extra.join(' ')}`).toBe(code);
      expect(r.out).toBe('');
      expect(r.err).not.toBe('');
      expect(r.err).not.toContain('\n');
      expect(() => JSON.parse(r.err)).toThrow();
    }
  }

  const lookups: [string, string[]][] = [
    ['get', ['get', 'no-such-id']],
    ['get --block', ['get', 'breaker', '--block', 'no-such-block']],
    ['related', ['related', 'no-such-id']],
    ['backlinks', ['backlinks', 'no-such-id']],
    ['refs', ['refs', 'no-such-id']],
    ['validate', ['validate', 'no-such-id']],
    ['brief with a theme that is no theme', ['brief', 'queue', '--theme', 'breaker']],
    ['record', ['record', 'no-such-id']],
    ['record --block', ['record', 'breaker', '--block', 'no-such-block']],
    ['record --block with one block that exists and one that does not', ['record', 'breaker', '--block', 'usage,no-such-block']],
  ];
  it.each(lookups)('%s: a well-made call that finds nothing exits 1', async (_name, argv) => {
    await expectFailure(argv, 1);
  });

  const misuse: [string, string[]][] = [
    ['find with nothing to match', ['find']],
    ['brief with no query', ['brief']],
    ['find with a flag it does not have', ['find', '--jsno', 'x']],
    ['get with a flag it does not have', ['get', 'breaker', '--tag', 'x']],
    ['find with a flag and no value', ['find', 'x', '--tag']],
    ['find with a flag followed by a flag', ['find', 'x', '--tag', '--band', 'y']],
    ['find with -n for --n', ['find', 'x', '-n', '3']],
    ['find with an --n that is no number', ['find', 'x', '--n', 'abc']],
    ['find with --n 0', ['find', 'x', '--n', '0']],
    ['brief with an --n that is no number', ['brief', 'x', '--n', 'abc']],
    ['get with no id', ['get']],
    ['related with no id', ['related']],
    ['backlinks with no id', ['backlinks']],
    ['refs with no id', ['refs']],
    ['record with no id', ['record']],
    ['record --all with an id', ['record', 'breaker', '--all']],
    ['record --all with --block', ['record', '--all', '--block', 'usage']],
    ['record --block with an empty name', ['record', 'breaker', '--block', 'usage,']],
    ['record with a flag it does not have', ['record', 'breaker', '--tag', 'x']],
    ['graph with a flag it does not have', ['graph', '--block', 'usage']],
    ['resolve with no refs', ['resolve']],
    ['resolve with a ref that has no #', ['resolve', 'breaker']],
    ['resolve with a pin that is no fingerprint', ['resolve', 'breaker#tradeoffs-pro-1@xyz']],
    ['--all on a command that does not take it', ['ls', '--all']],
    ['set with no id', ['set']],
    ['unlink with a page missing', ['unlink', 'breaker']],
    ['an unknown command', ['frobnicate']],
    ['a retired command', ['level', 'breaker', 'x', 'basic']],
    ['a retired flag', ['get', 'breaker', '--level', 'basic']],
  ];
  it.each(misuse)('%s: a call made badly exits 2', async (_name, argv) => {
    await expectFailure(argv, 2);
  });

  it('names the unknown id and, for a block, the blocks the page has', async () => {
    expect((await kb('get', 'no-such-id', '--json')).err).toBe('unknown id: no-such-id');
    expect((await kb('get', 'breaker', '--block', 'zzz', '--json')).err).toMatch(/^no block "zzz" on breaker\. has: description, /);
  });

  it('names the flag a typo left and the flags the command takes', async () => {
    const r = await kb('find', '--jsno', 'x');
    expect(r).toEqual({ code: 2, out: '', err: 'unknown flag --jsno. This command takes --tag, --band, --kind, --n, --json, --diagrams' });
  });

  it('prints nothing on stdout for an unknown command, with --json or without, and the usage only when there is no command', async () => {
    expect(await kb('frobnicate', '--json')).toMatchObject({ code: 2, out: '' });
    expect(await kb('frobnicate')).toMatchObject({ code: 2, out: '' });
    const bare = await kb();
    expect(bare.code).toBe(0);
    expect(bare.out).toContain('Reading:');
    expect(bare.err).toBe('');
  });

  it('exits 2 with one line on stderr and nothing on stdout when the program crashes, however it is asked', async () => {
    const broken = makeSandbox();
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts');
    const url = pathToFileURL(file).href;
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      err.push(String(s));
      return true;
    });
    const before = process.exitCode;
    const env = process.env['KB_ROOT'];
    try {
      writeKbFixture(broken.dir);
      // A content model with no verbs: the first read of it is a TypeError, which is no KbError.
      broken.write('docs/data/content-model.json', '{"kinds":[]}');
      process.env['KB_ROOT'] = broken.dir;
      for (const extra of [[], ['--json']]) {
        process.exitCode = undefined;
        err.length = 0;
        main(url, ['node', file, 'ls', ...extra]);
        await vi.waitFor(() => expect(process.exitCode).toBe(2));
        expect(err, extra.join(' ')).toHaveLength(1);
        expect(err[0]).toMatch(/^kb\.mjs: TypeError: .+\n$/);
        expect(err[0]?.slice(0, -1)).not.toContain('\n');
        expect(out).toEqual([]);
      }
    } finally {
      if (env === undefined) delete process.env['KB_ROOT'];
      else process.env['KB_ROOT'] = env;
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = before;
      broken.cleanup();
    }
  });
});

describe('the published kb-cli/1 schema', () => {
  /** A catalog row with only the keys every page has. */
  const ROW = { id: 'a', name: 'A', kind: 'pattern', band: 'gof', essence: 'e', path: 'patterns/a.html' };
  const RELATION_ROW = { type: 'combines-with', verb: 'combines-with', to: 'b', label: 'Combines with', note: '' };
  const BRIEF = { query: 'q', matches: [], theme: null, related: {} };
  /** A page with every key it always has and none it sometimes has. */
  const PAGE = {
    ...ROW,
    group: 'gof-creational',
    source: 'docs/patterns/a.md',
    area: 'gof-creational',
    status: 'stable',
    owner: 'o',
    tags: [],
    aliases: [],
    solves: [],
    favourite: false,
    route: '/patterns/a.html',
    markdown: '/patterns/a.md',
    blocks: { description: 'text' },
    relations: [],
    themes: [],
  };
  const withItems = (items: unknown): unknown => ({ ...PAGE, items });
  const FINDING = { page: 'a', rule: 'KB-014', line: 12, message: 'm' };
  /** A citation that holds, one that moved and one that is gone: a row of `resolve` in each state. */
  const RESOLVED = {
    ref: 'a#x-1',
    page: 'a',
    id: 'x-1',
    fp: null,
    status: 'ok',
    now: { id: 'x-1', fp: 'aaaaaaaa' },
    pointer: '/blocks/0/content/0',
    block: 'tradeoffs',
    group: 'pro',
    text: 'Words.',
  };
  const MOVED = { ...RESOLVED, ref: 'a#x-1@aaaaaaaa', fp: 'aaaaaaaa', status: 'moved', now: { id: 'x-2', fp: 'aaaaaaaa' } };
  const GONE = { ref: 'a#x-1@aaaaaaaa', page: 'a', id: 'x-1', fp: 'aaaaaaaa', status: 'gone', now: null, pointer: null, block: null, group: null, text: null };

  it('pins every read command in CLI_COMMANDS: a schema and a describe here', () => {
    const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const reads = CLI_COMMANDS.filter((c) => c.group === 'read').map((c) => c.name);
    expect(reads.length).toBeGreaterThan(0);
    for (const name of reads) {
      const id = CLI_OUTPUT_SCHEMAS[name];
      expect(id, `${name} has no entry in CLI_OUTPUT_SCHEMAS`).toBeDefined();
      expect(() => schemas().validate(id as string, null), `${name}: its definition does not resolve`).not.toThrow();
      expect(source, `${name} has no describe of its --json output in this file`).toContain(`describe('${name} --json'`);
    }
  });

  it('lets a key it does not list through as published and refuses it in the form the repo checks, at every depth', async () => {
    const page = (await asJson(0, 'get', 'breaker')) as Record<string, unknown>;
    const at = (...steps: (string | number)[]): Record<string, unknown> =>
      steps.reduce<unknown>((value, step) => (value as Record<string, unknown>)[step], page) as Record<string, unknown>;
    const places = [[], ['relations', 0], ['themes', 0], ['items', 'wild', 0], ['items', 'production', 'knobs', 0], ['items', 'explain']];
    for (const steps of places) at(...steps)['addedLater'] = 1;
    const published = contractSchemas(REPO_ROOT, { closed: false });
    expect(published.validate(CLI_OUTPUT_SCHEMAS['get'] as string, page)).toEqual([]);
    expect(findingsOf('get', page).sort()).toEqual(
      ['/', '/relations/0', '/themes/0', '/items/wild/0', '/items/production/knobs/0', '/items/explain']
        .map((where) => `${where}: must NOT have additional property "addedLater" (additionalProperties)`)
        .sort(),
    );
  });

  const holds: [string, string, unknown][] = [
    ['a catalog row with only the keys every page has', 'ls', [ROW]],
    ['a catalog row with every key a page may add', 'ls', [{ ...ROW, favourite: true, aliases: ['x'], tags: ['t'], solves: ['s'], hasExample: true, hasExplain: true }]],
    ['a search that finds nothing', 'find', []],
    ['a hit whose match is on no line of prose, why null', 'find', [{ ...ROW, why: null }]],
    ['a filter with no query words, which lists rows with no why', 'find', [ROW, { ...ROW, id: 'b' }]],
    ['a brief with no hit, no theme and no neighbours', 'brief', BRIEF],
    ['a brief whose theme has no decide block', 'brief', { ...BRIEF, theme: { id: 'steady', decide: null } }],
    ['a brief with a hit that has no relations', 'brief', { ...BRIEF, matches: [{ ...ROW, why: 'a line' }], related: { a: [] } }],
    ['a brief whose hit has a relation', 'brief', { ...BRIEF, related: { a: [RELATION_ROW] } }],
    ['a page that has none of the three blocks the writers read back: no items', 'get', PAGE],
    ['a wild entry whose name is a link', 'get', withItems({ wild: [{ id: 'x', name: 'N', note: 'n', href: 'https://example.com' }, { id: 'y', name: '', note: 'bare' }] })],
    ['an explain block whose example is a sketch', 'get', withItems({ explain: { text: 't', example: 'code', exampleLang: 'typescript', exampleCaption: 'c' } })],
    ['an explain block with costs and no example', 'get', withItems({ explain: { text: 't', costs: [{ lead: 'l', note: 'n' }], example: '' } })],
    ['a production block with an empty list and a bare bullet', 'get', withItems({ production: { knobs: [], signals: [{ label: '', note: 'n' }], failures: [], checklist: [{ text: 't' }] } })],
    ['a relation, a theme with no role and a tour stop', 'get', { ...PAGE, relations: [RELATION_ROW], themes: [{ id: 't', name: 'T', role: '', href: 'themes/t.html' }] }],
    ['a finding with a rule and a line, and one with neither', 'validate', { pages: 2, problems: ['p', 'q'], findings: [FINDING, { ...FINDING, rule: null, line: null }] }],
    ['a refs result with a tour, a click and a fluency theme', 'refs', { id: 'a', path: 'p.html', source: 's.md', relations: [{ rel: 'x', verb: 'x', to: 'b' }], members: [{ to: 'b', role: '' }], fluency: ['t'], proseLinks: [], clicks: ['b'], untyped: [] }],
    ['a backlinks result with an inbound relation', 'backlinks', { id: 'a', inbound: [{ from: 'b', type: 'x', verb: 'x', label: 'L', note: '' }], mentionedBy: [], mentions: ['c'] }],
    ['a citation that is ok, with no pin, and one that moved', 'resolve', [RESOLVED, MOVED]],
    ['a citation of a block, which has no fingerprint, and one that changed', 'resolve', [{ ...RESOLVED, id: 'tradeoffs', pointer: '/blocks/4', group: null, text: '', now: { id: 'tradeoffs', fp: null } }, { ...MOVED, status: 'changed' }]],
    ['a citation that is gone, with nothing but the citation', 'resolve', [GONE]],
    ['a citation of an element in the intro, which sits in no block', 'resolve', [{ ...RESOLVED, block: null, group: null, pointer: '/intro/0' }]],
    ['no citation at all', 'resolve', []],
  ];
  it.each(holds)('holds %s', (_name, command, value) => {
    expect(findingsOf(command, value)).toEqual([]);
  });

  const breaks: [string, string, unknown, string[]][] = [
    ['a flag that is false: it is there only when true', 'ls', [{ ...ROW, favourite: false }], ['/0/favourite: must be equal to constant (const)']],
    ['an empty list on a catalog row: it is there only when it has an item', 'ls', [{ ...ROW, tags: [] }], ['/0/tags: must NOT have fewer than 1 items (minItems)']],
    ['a kind the corpus does not read', 'ls', [{ ...ROW, kind: 'recipe' }], ['/0/kind: must be equal to one of the allowed values (enum)']],
    ['a why on an ls row', 'ls', [{ ...ROW, why: null }], ['/0: must NOT have additional property "why" (additionalProperties)']],
    ['an ls that is no list', 'ls', {}, ['/: must be array (type)']],
    ['a find with a number for a why', 'find', [{ ...ROW, why: 3 }], [
      '/0/why: must be string,null (type)',
      '/0: must NOT have additional property "why" (additionalProperties)',
      '/: must match a schema in anyOf (anyOf)',
    ]],
    ['a find that mixes rows with a why and rows without', 'find', [{ ...ROW, why: null }, ROW], [
      "/1: must have required property 'why' (required)",
      '/0: must NOT have additional property "why" (additionalProperties)',
      '/: must match a schema in anyOf (anyOf)',
    ]],
    ['a brief hit with no why', 'brief', { ...BRIEF, matches: [ROW] }, ["/matches/0: must have required property 'why' (required)"]],
    ['a brief with no theme key', 'brief', { query: 'q', matches: [], related: {} }, ["/: must have required property 'theme' (required)"]],
    ['a brief theme with no decide key', 'brief', { ...BRIEF, theme: { id: 'steady' } }, ["/theme: must have required property 'decide' (required)"]],
    ['a page with no favourite key', 'get', { ...PAGE, favourite: undefined }, ["/: must have required property 'favourite' (required)"]],
    ['a block that is not text', 'get', { ...PAGE, blocks: { description: 3 } }, ['/blocks/description: must be string (type)']],
    ['an explain block with no example', 'get', withItems({ explain: { text: 't' } }), ["/items/explain: must have required property 'example' (required)"]],
    ['a production block with a list missing', 'get', withItems({ production: { knobs: [], signals: [], failures: [] } }), ["/items/production: must have required property 'checklist' (required)"]],
    ['a relation row with no verb', 'related', [{ type: 'x', to: 'b', label: 'L', note: '' }], ["/0: must have required property 'verb' (required)"]],
    ['a relation that is no list', 'related', {}, ['/: must be array (type)']],
    ['a finding with no rule key', 'validate', { pages: 1, problems: [], findings: [{ page: 'a', line: 2, message: 'm' }] }, ["/findings/0: must have required property 'rule' (required)"]],
    ['a finding on line 0', 'validate', { pages: 1, problems: [], findings: [{ ...FINDING, line: 0 }] }, ['/findings/0/line: must be >= 1 (minimum)']],
    ['a page count that is no whole number', 'validate', { pages: 1.5, problems: [], findings: [] }, ['/pages: must be integer (type)']],
    ['a status that is none of the five', 'resolve', [{ ...RESOLVED, status: 'fine' }], ['/0/status: must be equal to one of the allowed values (enum)']],
    ['a citation with no now key', 'resolve', [{ ...GONE, now: undefined }], ["/0: must have required property 'now' (required)"]],
    ['a pin that is no fingerprint', 'resolve', [{ ...RESOLVED, fp: 'AAAAAAAA' }], ['/0/fp: must match pattern "^[0-9a-f]{8}$" (pattern)']],
    ['an element that is now no more than an id', 'resolve', [{ ...RESOLVED, now: { id: 'x-1' } }], ["/0/now: must have required property 'fp' (required)"]],
    ['a resolve that is no list', 'resolve', RESOLVED, ['/: must be array (type)']],
  ];
  it.each(breaks)('refuses %s', (_name, command, value, lines) => {
    expect(findingsOf(command, value)).toEqual(lines);
  });

  it('describes every definition and every property in one line, and names `verb` as the field to read on a relation row', () => {
    const undocumented: string[] = [];
    const document = (node: SchemaNode, at: string): void => {
      const text = node.description;
      if (typeof text !== 'string' || text.trim() === '' || text.includes('\n')) undocumented.push(at);
      for (const [name, child] of Object.entries(node.properties ?? {})) document(child, `${at}/properties/${name}`);
    };
    const defs = defsOf(cliSchema());
    // The commands whose output is a definition of this file; `record` and `graph` have a file of their own.
    const here = Object.entries(CLI_OUTPUT_SCHEMAS).filter(([, id]) => id.startsWith(`${schemaUrl(SCHEMA_BASES.cli)}#/$defs/`));
    expect(here.map(([name]) => name)).toEqual(['find', 'ls', 'get', 'brief', 'related', 'backlinks', 'refs', 'validate', 'resolve']);
    expect(Object.keys(defs)).toEqual(expect.arrayContaining(here.map(([name]) => name)));
    for (const [name, def] of Object.entries(defs)) document(def, `/$defs/${name}`);
    expect(undocumented).toEqual([]);
    for (const [def, alias] of [['relationRow', 'type'], ['inboundRow', 'type'], ['refsRelationRow', 'rel']] as const) {
      const props = defs[def]?.properties as Readonly<Record<string, SchemaNode>>;
      expect(props[alias]?.description, `${def}.${alias}`).toMatch(/^Deprecated alias of `verb`, equal to it; read `verb`\.$/);
      expect(Object.keys(props).indexOf('verb')).toBe(Object.keys(props).indexOf(alias) + 1);
    }
  });

  it('writes a search hit as a catalog row plus why, so the two cannot drift apart', () => {
    const catalog = definitionOf('catalogRow');
    const find = definitionOf('findRow');
    const { why, ...shared } = find.properties as Readonly<Record<string, SchemaNode>>;
    expect(why).toBeDefined();
    expect(shared).toEqual(catalog.properties);
    expect(Object.keys(find.properties as object).at(-1)).toBe('why');
    expect(find.required).toEqual([...(catalog.required as string[]), 'why']);
  });

  it('lists the seven kinds the corpus reads, in its order', () => {
    expect(definitionOf('pageKind').enum).toEqual([...KIND_SEQ]);
  });

  it('says what a citation check does and where its answer goes, in the one definition', () => {
    const resolve = definitionOf('resolve');
    expect(resolve.description).toContain('The exit code is 0 when every entry is ok and 1 when any is not, and this output is still printed.');
    expect(resolve.description).toContain('A block is cited as `<id>#<block name>` and takes no pin: its id is its name and does not renumber, so a pin on one is ignored and the entry is ok, with `fp` null.');
    expect(cliSchema().description).toContain('validate and resolve exit 1 when they find a problem and still print');
    const row = definitionOf('resolved');
    expect(Object.keys(row.properties as object)).toEqual(['ref', 'page', 'id', 'fp', 'status', 'now', 'pointer', 'block', 'group', 'text']);
    expect(row.required).toEqual(Object.keys(row.properties as object));
    expect((row.properties as Record<string, SchemaNode>)['status']?.enum).toEqual(['ok', 'moved', 'ambiguous', 'changed', 'gone']);
  });
});

// ---------------------------------------------------------------------------
// The record's and the graph's own schemas
// ---------------------------------------------------------------------------

/** Every schema node that is a definition or a property of a file, with where it is, so each can be held to a rule. */
function describedNodes(file: SchemaNode): { at: string; node: SchemaNode }[] {
  const out: { at: string; node: SchemaNode }[] = [];
  const visit = (node: SchemaNode, at: string): void => {
    out.push({ at, node });
    for (const [name, child] of Object.entries(node.properties ?? {})) visit(child, `${at}/properties/${name}`);
  };
  for (const [name, def] of Object.entries(defsOf(file))) visit(def, `/$defs/${name}`);
  for (const [name, prop] of Object.entries(file.properties ?? {})) visit(prop, `/properties/${name}`);
  return out;
}

/** The pointers a key is put at in a value, and the place that adds it: every object of the value is reached from them. */
function withKeyAt(value: unknown, pointers: readonly string[]): unknown {
  const copy = structuredClone(value);
  for (const pointer of pointers) {
    const holder = pointer
      .split('/')
      .slice(1)
      .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], copy) as Record<string, unknown>;
    holder['addedLater'] = 1;
  }
  return copy;
}

/** The line a closed schema reports for a key it does not list, at `where`. */
const extra = (where: string): string => `${where}: must NOT have additional property "addedLater" (additionalProperties)`;

describe('the published kb-record/1 schema', () => {
  const file = (): SchemaNode => schemaFile(SCHEMA_BASES.record);
  /** A whole record of a page that has most of what a record holds, as `kb.mjs record` prints it. */
  const breaker = async (): Promise<Record<string, unknown>> => (await asJson(0, 'record', 'breaker')) as Record<string, unknown>;
  const steady = async (): Promise<Record<string, unknown>> => (await asJson(0, 'record', 'steady')) as Record<string, unknown>;

  it('is named for its contract, lists every key of a record in the order it prints them, and requires every one', () => {
    expect(file().$id).toBe(schemaUrl(SCHEMA_BASES.record));
    expect(Object.keys(file().properties as object)).toEqual(RECORD_KEYS);
    expect(file().required).toEqual(RECORD_KEYS);
    const props = file().properties as Record<string, SchemaNode>;
    expect(props['$schema']?.const).toBe(schemaUrl(SCHEMA_BASES.record));
    expect(props['contract']?.const).toBe(CONTRACTS.record);
    expect(defsOf(file())['kind']?.enum).toEqual([...KIND_SEQ]);
  });

  it('describes every definition and every property in one line', () => {
    const undocumented = describedNodes(file())
      .filter(({ node }) => typeof node.description !== 'string' || node.description.trim() === '' || node.description.includes('\n'))
      .map(({ at }) => at);
    expect(undocumented).toEqual([]);
    expect(file().description).not.toContain('\n');
  });

  it('states the contract: how it changes, how it is ordered, what a fingerprint is and how an element is cited', () => {
    const text = file().description as string;
    for (const part of [
      'Adding a key stays in kb-record/1, so ignore keys you do not know',
      'would be kb-record/2, published beside this file',
      'Keys come in the order this file lists them',
      'two-space JSON with one newline at the end',
      'There is no date',
      'the first 8 hex digits of the SHA-256',
      'Unicode NFC',
      '`<page id>#<element id>@<fp>`',
      '`kb.mjs resolve`',
      'is stable for a given text and may move when something is put in above it',
      'blocks carry no fp: their id is their name and does not renumber',
      '`kb.mjs resolve` ignores a pin on one',
    ]) {
      expect(text, part).toContain(part);
    }
  });

  it('says exactly which pages `mentions` lists: the ones `backlinks` prints, less what the page’s own relations, themes and tour name', () => {
    const mentions = (file().properties as Record<string, SchemaNode>)['mentions']?.description as string;
    for (const part of [
      'markdown link to a .md file in its prose, outside the generated blocks and the siblings list',
      'in order of first mention',
      'leaving out the page itself and every page its own relations, themes and tour already name',
      'the same list `kb.mjs backlinks` prints as `mentions`',
    ]) {
      expect(mentions, part).toContain(part);
    }
  });

  it('gives every node of the body a type of its own and every key of it as required, so no key is optional', () => {
    const defs = defsOf(file());
    const flow = ['paragraph', 'heading', 'list', 'table', 'figure', 'sketch', 'code', 'quote', 'html'];
    const typed = (name: string): unknown => (defs[name]?.properties as Record<string, SchemaNode>)['type']?.const;
    expect(flow.map(typed)).toEqual(flow);
    expect(typed('group')).toBe('group');
    expect((defs['flow']?.oneOf ?? []).map((b) => b.$ref)).toEqual(flow.map((n) => `#/$defs/${n}`));
    expect((defs['node']?.oneOf ?? []).map((b) => b.$ref)).toEqual(['#/$defs/group', '#/$defs/flow']);
    for (const [name, def] of Object.entries(defs)) {
      if (def.properties !== undefined) expect(def.required, name).toEqual(Object.keys(def.properties));
    }
  });

  it('validates against its published schema, the whole record of every page of the record fixture', async () => {
    const own = makeSandbox();
    try {
      writeRecordFixture(own.dir);
      const ids = (JSON.parse((await runAt(own.dir, 'ls', '--json')).out) as { id: string }[]).map((r) => r.id);
      expect(ids).toHaveLength(12);
      for (const id of ids) {
        const r = await runAt(own.dir, 'record', id);
        expect(r.code, id).toBe(0);
        expectConforms('record', JSON.parse(r.out) as unknown, `record ${id}`);
      }
    } finally {
      own.cleanup();
    }
  });

  it('lets a key it does not list through as published and refuses it, wherever it is, in the form the repo checks', async () => {
    const r = await breaker();
    const at = r['anchors'] as Record<string, string>;
    const places = [
      '',
      '/areaChain/0',
      '/source',
      '/intro/0',
      '/blocks/0',
      '/blocks/0/heading',
      '/blocks/0/content/0',
      at['tradeoffs-pro-1'] as string,
      `${(at['tradeoffs-pro-1'] as string).replace(/\/items\/0$/, '')}`,
      '/blocks/4/content/0/heading',
      at['structure-fig-1'] as string,
      `${at['structure-fig-1'] as string}/caption`,
      at['sketch-variant-1'] as string,
      `${at['sketch-variant-1'] as string}/summary`,
      '/relations/0',
      '/relations/0/note',
      '/relations/0/edge',
      '/themes/0',
      '/themes/0/role',
      '/prerequisites',
      '/links/0',
    ];
    const bad = withKeyAt(r, places);
    expect(contractSchemas(REPO_ROOT, { closed: false }).validate(schemaUrl(SCHEMA_BASES.record), bad)).toEqual([]);
    const lines = findingsOfId(schemaUrl(SCHEMA_BASES.record), bad);
    for (const place of places) expect(lines, place).toContain(extra(place === '' ? '/' : place));
    // A table, its row and its cells, on a page that has one.
    const t = await steady();
    const table = (t['anchors'] as Record<string, string>)['decide-row-1'] as string;
    const tablePlaces = [table.replace(/\/rows\/0$/, ''), table, `${table}/cells/0`, `${table.replace(/\/rows\/0$/, '')}/header/0`];
    const badTable = withKeyAt(t, tablePlaces);
    for (const place of tablePlaces) expect(findingsOfId(schemaUrl(SCHEMA_BASES.record), badTable), place).toContain(extra(place));
  });

  const breaks: [string, (r: Record<string, unknown>) => void, string[]][] = [
    ['another contract', (r) => void (r['contract'] = 'kb-record/2'), ['/contract: must be equal to constant (const)']],
    ['another schema address', (r) => void (r['$schema'] = 'https://example.test/s.json'), ['/$schema: must be equal to constant (const)']],
    ['a kind the corpus does not read', (r) => void (r['kind'] = 'recipe'), ['/kind: must be equal to one of the allowed values (enum)']],
    ['a page id in capitals', (r) => void (r['id'] = 'Breaker'), ['/id: must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$" (pattern)']],
    ['a scope that is a word', (r) => void (r['scope'] = 'usage'), ['/scope: must be array,null (type)']],
    ['a route that is not a page', (r) => void (r['route'] = '/patterns/x.htm'), ['/route: must match pattern "^/.+\\.html$" (pattern)']],
    ['a hash that is too short', (r) => void ((r['source'] as Record<string, unknown>)['sha256'] = 'abc'), ['/source/sha256: must match pattern "^[0-9a-f]{64}$" (pattern)']],
    ['a favourite that is a word', (r) => void (r['favourite'] = 'yes'), ['/favourite: must be boolean (type)']],
    ['no anchors key', (r) => void delete r['anchors'], ["/: must have required property 'anchors' (required)"]],
    ['an anchor that is no pointer', (r) => void ((r['anchors'] as Record<string, unknown>)['description'] = 'blocks/0'), ['/anchors/description: must match pattern "^/(intro|blocks)/[0-9]+(/[a-z0-9]+)*$" (pattern)']],
    ['a link by a way there is none', (r) => void (((r['links'] as Record<string, unknown>[])[0] as Record<string, unknown>)['via'] = 'hover'), ['/links/0/via: must be equal to one of the allowed values (enum)']],
    ['a relation with no edge', (r) => void delete ((r['relations'] as Record<string, unknown>[])[0] as Record<string, unknown>)['edge'], ["/relations/0: must have required property 'edge' (required)"]],
    ['a group that is neither a polarity nor a requirement', (r) => void ((((r['blocks'] as Record<string, unknown>[])[4] as { content: Record<string, unknown>[] }).content[0] as Record<string, unknown>)['value'] = 'maybe'), ['/blocks/4/content/0/value: must be equal to one of the allowed values (enum)']],
  ];
  it.each(breaks)('refuses %s', async (_name, mutate, lines) => {
    const r = await breaker();
    mutate(r);
    const found = findingsOfId(schemaUrl(SCHEMA_BASES.record), r);
    for (const line of lines) expect(found).toContain(line);
  });

  it('refuses a node of no type it knows, and a fingerprint that is not eight hex digits, naming where', async () => {
    const r = await breaker();
    const first = ((r['blocks'] as { content: Record<string, unknown>[] }[])[0] as { content: Record<string, unknown>[] }).content[0] as Record<string, unknown>;
    first['type'] = 'video';
    expect(findingsOfId(schemaUrl(SCHEMA_BASES.record), r)).toContain('/blocks/0/content/0: must match exactly one schema in oneOf (oneOf)');
    first['type'] = 'paragraph';
    first['fp'] = 'ABCDEF12';
    expect(findingsOfId(schemaUrl(SCHEMA_BASES.record), r)).toContain('/blocks/0/content/0/fp: must match pattern "^[0-9a-f]{8}$" (pattern)');
  });
});

describe('the fingerprint the kb-record/1 schema describes', () => {
  /** Every non-empty `text` held anywhere in a value, in order: the words of everything inside a node. */
  function textsIn(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach((v) => textsIn(v, out));
    else if (typeof value === 'object' && value !== null) {
      const o = value as Record<string, unknown>;
      if (typeof o['text'] === 'string' && o['text'] !== '') out.push(o['text']);
      Object.values(o).forEach((v) => textsIn(v, out));
    }
    return out;
  }
  const lines = (value: unknown): string => textsIn(value).join('\n');

  /** Every node that carries an `fp`, with the basis the schema's description gives it, in the order of the page. */
  function bases(nodes: readonly Record<string, any>[], out: { node: Record<string, any>; basis: string; where: string }[], where: string): void {
    const add = (node: Record<string, any>, basis: string, at: string): void => void out.push({ node, basis, where: at });
    const flow = (list: readonly Record<string, any>[], at: string): void => bases(list, out, at);
    nodes.forEach((n, i) => {
      const at = `${where}/${String(i)}`;
      switch (n['type']) {
        case 'paragraph':
        case 'heading':
          add(n, n['text'], at);
          break;
        case 'group':
          add(n['heading'], n['heading']['text'], `${at}/heading`);
          flow(n['content'], `${at}/content`);
          break;
        case 'list':
          add(n, lines(n['items']), at);
          n['items'].forEach((item: Record<string, any>, j: number) => {
            add(item, item['text'] || lines(item['content']), `${at}/items/${String(j)}`);
            flow(item['content'], `${at}/items/${String(j)}/content`);
          });
          break;
        case 'table':
          add(n, lines([n['header'], n['rows']]), at);
          n['rows'].forEach((row: Record<string, any>, j: number) => add(row, lines(row['cells']), `${at}/rows/${String(j)}`));
          break;
        case 'figure':
          add(n, n['caption']?.['text'] || n['code'], at);
          break;
        case 'sketch':
          add(n, n['form'] === 'code' ? n['summary']['text'] || n['code'] : n['summary']?.['text'] || lines(n['content']), at);
          flow(n['content'], `${at}/content`);
          break;
        case 'code':
          add(n, n['code'], at);
          break;
        case 'quote':
          add(n, (n['content'][0]?.['type'] === 'paragraph' ? n['content'][0]['text'] : '') || lines(n['content']), at);
          flow(n['content'], `${at}/content`);
          break;
        default:
          break;
      }
    });
  }

  function expectDescribed(record: Record<string, any>, name: string): number {
    const found: { node: Record<string, any>; basis: string; where: string }[] = [];
    bases(record['intro'], found, `${name}/intro`);
    (record['blocks'] as Record<string, any>[]).forEach((b, i) => bases(b['content'], found, `${name}/blocks/${String(i)}`));
    for (const { node, basis, where } of found) {
      expect(node['fp'], where).toBe(node['id'] === null ? null : fingerprint(basis));
    }
    return found.length;
  }

  it('is, for every kind of node, the one a record carries: the basis the description gives, folded and hashed', async () => {
    const own = makeSandbox();
    try {
      writeRecordFixture(own.dir);
      let checked = 0;
      for (const id of ['breaker', 'shortener', 'steady', 'boundary', 'validators', 'queues', 'brokers', 'storm', 'quick']) {
        checked += expectDescribed(JSON.parse((await runAt(own.dir, 'record', id)).out) as Record<string, any>, id);
      }
      expect(checked).toBeGreaterThan(150);
    } finally {
      own.cleanup();
    }
  });

  it('is also the one the real tree’s records carry, for the first and the middle page of every kind', { timeout: 300_000 }, async () => {
    const real = new Corpus(REPO_ROOT);
    const rows = JSON.parse((await runAt(real, 'ls', '--json')).out) as { id: string; kind: string }[];
    const ids = KIND_SEQ.flatMap((kind) => {
      const ofKind = rows.filter((r) => r.kind === kind).map((r) => r.id);
      return [...new Set([ofKind[0], ofKind[Math.floor(ofKind.length / 2)]])] as string[];
    });
    expect(ids.length).toBeGreaterThanOrEqual(13);
    let checked = 0;
    for (const id of ids) {
      const r = await runAt(real, 'record', id);
      expect(r.code, id).toBe(0);
      checked += expectDescribed(JSON.parse(r.out) as Record<string, any>, id);
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe('the published kb-graph/1 schema', () => {
  const file = (): SchemaNode => schemaFile(SCHEMA_BASES.graph);
  const GRAPH_KEYS = ['$schema', 'contract', 'verbs', 'nodes', 'edges', 'tours', 'mentions'];

  it('is named for its contract, lists every key of a graph in the order it prints them, and requires every one', async () => {
    expect(file().$id).toBe(schemaUrl(SCHEMA_BASES.graph));
    expect(Object.keys(file().properties as object)).toEqual(GRAPH_KEYS);
    expect(file().required).toEqual(GRAPH_KEYS);
    const props = file().properties as Record<string, SchemaNode>;
    expect(props['$schema']?.const).toBe(schemaUrl(SCHEMA_BASES.graph));
    expect(props['contract']?.const).toBe(CONTRACTS.graph);
    const nodeKind = ((defsOf(file())['node'] as SchemaNode).properties as Record<string, SchemaNode>)['kind'];
    expect(nodeKind?.enum).toEqual([...KIND_SEQ]);
    for (const [name, def] of Object.entries(defsOf(file()))) {
      if (def.properties !== undefined) expect(def.required, name).toEqual(Object.keys(def.properties));
    }
  });

  it('describes every definition and every property in one line, and states how it changes and how it is ordered', () => {
    const undocumented = describedNodes(file())
      .filter(({ node }) => typeof node.description !== 'string' || node.description.trim() === '' || node.description.includes('\n'))
      .map(({ at }) => at);
    expect(undocumented).toEqual([]);
    const text = file().description as string;
    for (const part of ['Adding a key stays in kb-graph/1, so ignore keys you do not know', 'would be kb-graph/2, published beside this file', 'in the order of docs/data/relations.json', 'A symmetric verb']) {
      expect(text, part).toContain(part);
    }
  });

  it('lets a key it does not list through as published and refuses it, wherever it is, in the form the repo checks', async () => {
    const g = (await asJson(0, 'graph')) as Record<string, unknown>;
    const places = ['', '/verbs/0', '/nodes/0', '/edges/0', '/edges/0/noteA', '/edges/0/noteB', '/tours/0', '/tours/0/stages/0', '/tours/0/stages/0/role', '/mentions/0'];
    const bad = withKeyAt(g, places);
    expect(contractSchemas(REPO_ROOT, { closed: false }).validate(schemaUrl(SCHEMA_BASES.graph), bad)).toEqual([]);
    expect(findingsOfId(schemaUrl(SCHEMA_BASES.graph), bad).sort()).toEqual(places.map((p) => extra(p === '' ? '/' : p)).sort());
  });

  const breaks: [string, (g: Record<string, unknown>) => void, string[]][] = [
    ['another contract', (g) => void (g['contract'] = 'kb-graph/2'), ['/contract: must be equal to constant (const)']],
    ['a node with a record that is no .json', (g) => void (((g['nodes'] as Record<string, unknown>[])[0] as Record<string, unknown>)['record'] = '/x.html'), ['/nodes/0/record: must match pattern "^/.+\\.json$" (pattern)']],
    ['an edge with no inverse', (g) => void delete ((g['edges'] as Record<string, unknown>[])[0] as Record<string, unknown>)['inverse'], ["/edges/0: must have required property 'inverse' (required)"]],
    ['a verb whose symmetric flag is a word', (g) => void (((g['verbs'] as Record<string, unknown>[])[0] as Record<string, unknown>)['symmetric'] = 'yes'), ['/verbs/0/symmetric: must be boolean (type)']],
    ['a mention of a page by its title', (g) => void (((g['mentions'] as Record<string, unknown>[])[0] as Record<string, unknown>)['to'] = 'Queue'), ['/mentions/0/to: must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$" (pattern)']],
  ];
  it.each(breaks)('refuses %s', async (_name, mutate, lines) => {
    const g = (await asJson(0, 'graph')) as Record<string, unknown>;
    mutate(g);
    const found = findingsOfId(schemaUrl(SCHEMA_BASES.graph), g);
    for (const line of lines) expect(found).toContain(line);
  });

  it('validates the graph of the record fixture, whose edges have a pinned row, a custom group on each side and a tour', async () => {
    const own = makeSandbox();
    try {
      writeRecordFixture(own.dir);
      const r = await runAt(own.dir, 'graph');
      expect(r.code).toBe(0);
      const g = JSON.parse(r.out) as { edges: Record<string, unknown>[]; tours: unknown[] };
      expectConforms('graph', g, 'graph of the record fixture');
      expect(g.edges.some((e) => e['mapsA'] !== null)).toBe(true);
      expect(g.tours).toHaveLength(2);
    } finally {
      own.cleanup();
    }
  });
});
