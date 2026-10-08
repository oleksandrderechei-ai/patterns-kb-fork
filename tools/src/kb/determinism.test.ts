/**
 * The read commands of kb.mjs answer the same bytes every time, on a copy of the
 * real docs/. What it defends: an agent that cites a record, a golden file that
 * pins one and a build that writes one all rely on a command's answer being a
 * function of the pages and nothing else, so the same call twice in one corpus,
 * on a cold start and on a warm one, beside a cache file that is stale, broken
 * or another tree's, and on two different days, answers the same exit code,
 * stdout and stderr, byte for byte. A spawned run writes LF only and one
 * newline at the end, and every list the contract orders is in the order it
 * says.
 *
 * The calls are a fixed list worked out from the tree: `record` and `get` for
 * every page, `related` and `refs` for every page, `resolve` for the first
 * element of every page that has a fingerprint, `backlinks` for every eighth
 * page in listing order (every page with KB_DETERMINISM=full: it reads every
 * other page, so a call costs the most), `find` and `brief` for every query of
 * the search oracle, and `ls`, `validate` and `graph`.
 *
 * The copy has a `node_modules` of its own, empty, so that the disk cache
 * (tools/src/kb/disk-cache.ts) is on and writes inside the copy. Never link the
 * real one: the cache sits under it, and a test that wrote it would change what
 * the next `kb.mjs` run of the checkout reads.
 */

import { spawnSync } from 'node:child_process';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { refOf } from '../gates/check-kb-records.js';
import { REAL_TREE_TIMEOUT } from '../lib/fixtures.js';
import { frontmatterMany } from '../lib/frontmatter.js';
import { serialize } from '../lib/kb-record.js';
import { makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';

import { run } from './cli.js';
import { Corpus } from './corpus.js';
import { CACHE_FILE, CACHE_VERSION } from './disk-cache.js';
import { recordOf } from './record.js';

/** What one call printed. */
interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** The answers of a list of calls, keyed by the call as typed. */
type Answers = ReadonlyMap<string, Ran>;

let sb: Sandbox;
let list: string[][];
let queries: string[];
let ids: string[];
let corpus: Corpus;
let cold: Answers;
let cache: string;
let afterCold: string;

/** Run one call in-process over `over` and take down what it wrote, as the program's own `main` would print it. */
async function ask(over: Corpus, argv: readonly string[]): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, over);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Every call of `calls` over `over`, in order. */
async function answers(over: Corpus, calls: readonly (readonly string[])[]): Promise<Map<string, Ran>> {
  const all = new Map<string, Ran>();
  for (const argv of calls) all.set(argv.join(' '), await ask(over, argv));
  return all;
}

/** The calls whose answer is not the same in both, or is in only one: what a test expects to be none. */
function differences(a: Answers, b: Answers): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => {
    const x = a.get(key);
    const y = b.get(key);
    return x === undefined || y === undefined || x.code !== y.code || x.out !== y.out || x.err !== y.err;
  });
}

/** Which pages `backlinks` is asked for: every page when KB_DETERMINISM=full, else every eighth in listing order. */
const EVERY = process.env['KB_DETERMINISM'] === 'full' ? 1 : 8;

/**
 * The calls, worked out from the tree: page by page, then the queries of the
 * oracle, each once, then the three that answer for the whole tree. The citation
 * `resolve` is asked for is the one the gate asks for: the first element of the
 * page's record that has a fingerprint, when it has one.
 */
function callsOf(over: Corpus, oracle: readonly string[]): string[][] {
  const slugs = over.listing.map((p) => p.slug);
  return [
    ...slugs.flatMap((id) => [['record', id], ['get', id, '--json'], ['related', id, '--json'], ['refs', id, '--json']]),
    ...slugs.flatMap((id) => {
      const ref = refOf(recordOf(over, id));
      return ref === null ? [] : [['resolve', ref, '--json']];
    }),
    ...slugs.filter((_, i) => i % EVERY === 0).map((id) => ['backlinks', id, '--json']),
    ...[...new Set(oracle)].flatMap((q) => [['find', q, '--json'], ['brief', q, '--json']]),
    ['ls', '--json'],
    ['validate', '--json'],
    ['graph'],
  ];
}

/**
 * The calls of `calls` that read the disk cache: what a cache file can change.
 * `find` and `brief` read a page's prose from it, `backlinks`, `record` and
 * `graph` the links it makes (`mentions`); `get`, `related`, `refs`, `ls` and
 * `validate` never ask it for anything.
 */
function cached(calls: readonly (readonly string[])[]): string[][] {
  const slugs = new Set(corpus.listing.filter((_, i) => i % EVERY === 0).map((p) => p.slug));
  return calls.filter(([command, id]) => ['find', 'brief', 'backlinks', 'graph'].includes(command as string) || (command === 'record' && slugs.has(id as string))).map((argv) => [...argv]);
}

/** The text a call printed, parsed. */
const printed = (key: string): unknown => JSON.parse((cold.get(key) as Ran).out) as unknown;

beforeAll(async () => {
  sb = makeSandbox();
  sb.copyRepo('docs');
  sb.mkdir('node_modules');
  cache = path.join(sb.dir, CACHE_FILE);
  corpus = new Corpus(sb.dir);
  ids = corpus.listing.map((p) => p.slug);
  queries = [...new Set((JSON.parse(sb.read('docs/data/search-oracle.json')) as { cases: { q: string }[] }).cases.map((c) => c.q))];
  list = callsOf(corpus, queries);
  // The first run of a tree that has never been read: no cache file, then the file the run saved.
  expect(fs.existsSync(cache)).toBe(false);
  cold = await answers(corpus, list);
  afterCold = fs.readFileSync(cache, 'utf8');
}, REAL_TREE_TIMEOUT);
afterAll(() => sb.cleanup());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe('the list of calls', () => {
  it('has four calls for each page, a citation for nearly each, backlinks for every eighth page, two calls for each query of the oracle and three for the tree', () => {
    const citations = list.filter(([command]) => command === 'resolve').length;
    expect(ids.length).toBeGreaterThan(400);
    expect(queries.length).toBeGreaterThan(20);
    expect(citations).toBeGreaterThan(ids.length * 0.9);
    expect(list).toHaveLength(ids.length * 4 + citations + Math.ceil(ids.length / EVERY) + queries.length * 2 + 3);
    expect(new Set(list.map((argv) => argv.join(' '))).size).toBe(list.length);
  });

  it('ends every call well on the copy: exit 0 with nothing on stderr, and exit 1 for `validate` when it has problems to print', () => {
    const bad = [...cold].filter(([key, ran]) => !(ran.code === 0 || (key.startsWith('validate') && ran.code === 1)) || ran.err !== '');
    expect(bad.map(([key, ran]) => `${key}: exit ${String(ran.code)} ${ran.err}`)).toEqual([]);
  });

  it('can be told apart by `differences`, which names a call whose exit, stdout or stderr changed, and one that only one run made', () => {
    const base = new Map<string, Ran>([['a', { code: 0, out: 'x', err: '' }], ['b', { code: 0, out: 'y', err: '' }]]);
    expect(differences(base, new Map(base))).toEqual([]);
    expect(differences(base, new Map([...base, ['a', { code: 1, out: 'x', err: '' }]]))).toEqual(['a']);
    expect(differences(base, new Map([...base, ['a', { code: 0, out: 'x!', err: '' }]]))).toEqual(['a']);
    expect(differences(base, new Map([...base, ['b', { code: 0, out: 'y', err: 'w' }]]))).toEqual(['b']);
    expect(differences(base, new Map([['a', { code: 0, out: 'x', err: '' }]]))).toEqual(['b']);
    expect(differences(new Map([['a', { code: 0, out: 'x', err: '' }]]), base)).toEqual(['b']);
  });
});

describe('the answers', () => {
  it('answers every read command byte for byte the same twice in one corpus', async () => {
    // The corpus the first run read has every page parsed already: the second call of each is served from memory.
    const again = await answers(corpus, list);
    expect(differences(cold, again)).toEqual([]);
  }, REAL_TREE_TIMEOUT);

  it('answers the same from a cold run with no cache file and a warm run reading the file the cold run saved', async () => {
    const parsed = JSON.parse(afterCold) as { version: number; entries: Record<string, unknown> };
    expect(parsed.version).toBe(CACHE_VERSION);
    expect(Object.keys(parsed.entries).length).toBeGreaterThan(ids.length);
    const before = fs.statSync(cache).mtimeMs;
    const warm = await answers(new Corpus(sb.dir), list);
    expect(differences(cold, warm)).toEqual([]);
    // A run that finds every value in the file adds none and writes nothing.
    expect(fs.readFileSync(cache, 'utf8')).toBe(afterCold);
    expect(fs.statSync(cache).mtimeMs).toBe(before);
  }, REAL_TREE_TIMEOUT);

  describe('beside a cache file', () => {
    /**
     * Answer the calls that read the cache over a corpus that finds `file` as
     * it, and say which answers are not the ones of the cold run and what the
     * cache holds when the run is done.
     */
    async function beside(file: string): Promise<{ same: string[]; saved: { version: number; entries: Record<string, unknown> } }> {
      fs.writeFileSync(cache, file);
      const calls = cached(list);
      expect(calls.length).toBeGreaterThan(queries.length * 2);
      const same = differences(new Map(calls.map((argv) => [argv.join(' '), cold.get(argv.join(' ')) as Ran])), await answers(new Corpus(sb.dir), calls));
      return { same, saved: JSON.parse(fs.readFileSync(cache, 'utf8')) as { version: number; entries: Record<string, unknown> } };
    }

    it('answers the same beside a cache file of another version, one that does not parse, and one filled from another tree', async () => {
      const real = JSON.parse(afterCold) as { version: number; entries: Record<string, unknown> };
      const entries = Object.keys(real.entries);

      // Another version: every value in it is wrong, and none may be read.
      const poisoned = JSON.stringify({ version: CACHE_VERSION + 1, entries: Object.fromEntries(entries.map((k) => [k, 'poison'])) });
      const other = await beside(poisoned);
      expect(other.same).toEqual([]);
      expect(other.saved.version).toBe(CACHE_VERSION);
      expect(Object.values(other.saved.entries)).not.toContain('poison');

      // One that does not parse: read as empty, then replaced by a file that does.
      const broken = await beside(afterCold.slice(0, afterCold.length >> 1));
      expect(broken.same).toEqual([]);
      expect(broken.saved.entries).toEqual(real.entries);

      // One filled from another tree: the same pages but for a few edited, so some of its values are the right ones and the others are of text this tree does not have.
      const second = makeSandbox();
      try {
        second.copyRepo('docs');
        second.mkdir('node_modules');
        for (const id of ids.slice(0, 40)) {
          const source = (JSON.parse((cold.get(`record ${id}`) as Ran).out) as { source: { path: string } }).source.path;
          second.write(source, `${second.read(source)}\nA sentence only the other tree has.\n`);
        }
        const elsewhere = new Corpus(second.dir);
        await ask(elsewhere, ['find', 'retry']);
        await ask(elsewhere, ['backlinks', ids[0] as string, '--json']);
        const theirs = fs.readFileSync(path.join(second.dir, CACHE_FILE), 'utf8');
        const theirEntries = Object.keys((JSON.parse(theirs) as { entries: Record<string, unknown> }).entries);
        expect(theirEntries.filter((k) => !entries.includes(k)).length).toBeGreaterThan(0);
        expect(theirEntries.filter((k) => entries.includes(k)).length).toBeGreaterThan(0);
        const filled = await beside(theirs);
        expect(filled.same).toEqual([]);
        // What it holds now is this tree's values and the other tree's, and the values of this tree are the ones it had.
        for (const key of entries) expect(filled.saved.entries[key], key).toEqual(real.entries[key]);
      } finally {
        second.cleanup();
      }
    }, REAL_TREE_TIMEOUT);
  });

  it('answers the same on two different days and never asks the clock or the dice', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const random = vi.spyOn(Math, 'random');
    const now = vi.spyOn(Date, 'now');
    const uuid = vi.spyOn(crypto, 'randomUUID');
    // The named export of node:crypto follows the spy once the builtin's exports are synced.
    syncBuiltinESMExports();

    vi.setSystemTime(new Date('2020-02-02T02:02:02Z'));
    const earlier = await answers(new Corpus(sb.dir), list);
    vi.setSystemTime(new Date('2031-03-03T13:03:03Z'));
    const later = await answers(new Corpus(sb.dir), list);

    expect(differences(earlier, later)).toEqual([]);
    expect(differences(cold, earlier)).toEqual([]);
    expect([random.mock.calls.length, now.mock.calls.length, uuid.mock.calls.length]).toEqual([0, 0, 0]);

    // The spies see a call each, however it is made: a zero above is not a spy that was never wired.
    Math.random();
    Date.now();
    randomUUID();
    expect([random.mock.calls.length, now.mock.calls.length, uuid.mock.calls.length]).toEqual([1, 1, 1]);
  }, REAL_TREE_TIMEOUT);

  it('writes LF only and one trailing newline', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, KB_ROOT: sb.dir };
    // Both set is a warning on stderr from node, and neither belongs to what the program prints.
    delete env['FORCE_COLOR'];
    delete env['NO_COLOR'];
    const id = ids[0] as string;
    const spawned = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/kb.mjs'), 'record', id], { cwd: sb.dir, env, maxBuffer: 256 * 1024 * 1024 });
    expect(spawned.stderr.toString('utf8')).toBe('');
    expect(spawned.status).toBe(0);
    const bytes = spawned.stdout;
    expect(bytes.includes(0x0d), 'a carriage return').toBe(false);
    expect(bytes.at(-1)).toBe(0x0a);
    expect(bytes.at(-2)).not.toBe(0x0a);
    const text = bytes.toString('utf8');
    // The bytes are the two-space JSON of the record and that newline, and the ones the in-process run printed.
    expect(text).toBe(serialize(JSON.parse(text)));
    expect(text).toBe(`${(cold.get(`record ${id}`) as Ran).out}\n`);
  }, REAL_TREE_TIMEOUT);
});

describe('document order', () => {
  /** A record's pointer as its steps: an index is a number. */
  const stepsOf = (pointer: string): (string | number)[] => pointer.split('/').slice(1).map((s) => (/^\d+$/.test(s) ? Number(s) : s));

  /** The two halves of a record, in the order a page has them. */
  const HALVES: readonly (string | number)[] = ['intro', 'blocks'];

  /**
   * Whether the element at pointer `a` comes before the one at `b` in the page:
   * the intro before the blocks, an index before a later index, and an element
   * before the elements it holds, whose pointers it is a prefix of.
   */
  function comesBefore(a: string, b: string): boolean {
    const [x, y] = [stepsOf(a), stepsOf(b)];
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
      const [p, q] = [x[i] as string | number, y[i] as string | number];
      if (p === q) continue;
      if (typeof p === 'number' && typeof q === 'number') return p < q;
      return HALVES.indexOf(p) < HALVES.indexOf(q);
    }
    return x.length < y.length;
  }

  it('reads a pointer in page order: the intro first, a lower index first, a container before its contents', () => {
    expect(comesBefore('/intro/3', '/blocks/0')).toBe(true);
    expect(comesBefore('/blocks/0', '/intro/3')).toBe(false);
    expect(comesBefore('/blocks/1/content/0', '/blocks/1/content/1')).toBe(true);
    expect(comesBefore('/blocks/1/content/9', '/blocks/2')).toBe(true);
    expect(comesBefore('/blocks/1', '/blocks/1/content/0')).toBe(true);
    expect(comesBefore('/blocks/1/content/0', '/blocks/1')).toBe(false);
    expect(comesBefore('/blocks/1', '/blocks/1')).toBe(false);
    expect(comesBefore('/blocks/10', '/blocks/9')).toBe(false);
    expect(comesBefore('/blocks/1/items/0', '/blocks/1/cells/0')).toBe(false);
  });

  it('orders every array as the contract states', async () => {
    type RecordJson = {
      id: string;
      source: { path: string };
      route: string;
      tags: string[];
      aliases: string[];
      solves: string[];
      blocks: { name: string }[];
      links: { block: string | null; href: string }[];
      relations: { group: string; to: string }[];
      themes: { id: string }[];
      tour: { id: string }[];
      mentions: string[];
      anchors: Record<string, string>;
    };
    const records = new Map(ids.map((id) => [id, printed(`record ${id}`) as RecordJson]));
    const problems: string[] = [];

    // The anchors, in page order: each pointer comes after the one before it.
    for (const [id, r] of records) {
      const pointers = Object.values(r.anchors);
      const out = pointers.findIndex((p, i) => i > 0 && !comesBefore(pointers[i - 1] as string, p));
      if (out > 0) problems.push(`${id}: anchors ${pointers[out - 1] as string} then ${pointers[out] as string}`);
    }

    // The links, in page order: the intro's, then each block's in the order of the blocks, each one after the one before in the markdown.
    let links = 0;
    for (const [id, r] of records) {
      const source = sb.read(r.source.path);
      const names = r.blocks.map((b) => b.name);
      let block = -1;
      let at = 0;
      for (const link of r.links) {
        links += 1;
        const rank = link.block === null ? -1 : names.indexOf(link.block);
        const found = source.indexOf(link.href, at);
        if (rank < block || found < 0) {
          problems.push(`${id}: link ${link.href} in ${String(link.block)} comes out of page order`);
          break;
        }
        [block, at] = [rank, found];
      }
    }

    // The relations, in the order the page's own relationships block shows them: its group headings and the page each bullet links to.
    let rows = 0;
    for (const [id, r] of records) {
      const region = /<!-- relationships:start -->([\s\S]*?)<!-- relationships:end -->/.exec(sb.read(r.source.path));
      const shown: string[] = [];
      let group = '';
      for (const line of (region?.[1] ?? '').split('\n')) {
        group = /^\*\*(.+)\*\*\s*$/.exec(line)?.[1] ?? group;
        const target = /^- \[[^\]]*\]\(([^)]+)\)/.exec(line)?.[1];
        if (target !== undefined) shown.push(`${group} | ${(target.split('/').at(-1) as string).replace(/\.md(#.*)?$/, '')}`);
      }
      const got = r.relations.map((x) => `${x.group} | ${x.to}`);
      rows += got.length;
      if (got.join('\n') !== shown.join('\n')) problems.push(`${id}: relations ${got.join(', ')} where the page shows ${shown.join(', ')}`);
    }

    // Tags, aliases and solves, in the order the frontmatter lists them.
    const front = frontmatterMany(sb.dir, [...records.values()].map((r) => r.source.path), { lists: true });
    let unsorted = 0;
    for (const [id, r] of records) {
      const fields = front.get(r.source.path) ?? {};
      for (const key of ['tags', 'aliases', 'solves'] as const) {
        const value = fields[key];
        const listed = Array.isArray(value) ? [...value] : typeof value === 'string' && value !== '' ? [value] : [];
        if (listed.join('\n') !== r[key].join('\n')) problems.push(`${id}: ${key} ${r[key].join(', ')} where the frontmatter lists ${listed.join(', ')}`);
        if ([...listed].sort().join('\n') !== listed.join('\n')) unsorted += 1;
      }
    }

    // Themes, in the order of the profiles of learning-paths.json; a theme's own tour in the order of its stages.
    const { profiles } = JSON.parse(sb.read('docs/data/learning-paths.json')) as { profiles: { id: string; stages: string[] }[] };
    const byRoute = new Map([...records.values()].map((r) => [r.route, r.id]));
    let memberships = 0;
    for (const [id, r] of records) {
      const want = profiles.filter((p) => p.stages.includes(r.route)).map((p) => p.id);
      memberships += want.length;
      if (want.join() !== r.themes.map((t) => t.id).join()) problems.push(`${id}: themes ${r.themes.map((t) => t.id).join(', ')} where the profiles list ${want.join(', ')}`);
    }
    for (const p of profiles) {
      const tour = (records.get(p.id)?.tour ?? []).map((t) => t.id);
      const want = p.stages.flatMap((route) => byRoute.get(route) ?? []);
      if (records.has(p.id) && tour.join() !== want.join()) problems.push(`${p.id}: tour ${tour.join(', ')} where its stages list ${want.join(', ')}`);
    }

    expect(problems).toEqual([]);
    // The checks above have something to hold: pages that carry lists, links, relations and a tour.
    expect(links).toBeGreaterThan(1000);
    expect(rows).toBeGreaterThan(1000);
    expect(unsorted).toBeGreaterThan(100);
    expect(memberships).toBeGreaterThan(100);

    // The graph: its nodes in the order of `ls`, its edges in the order of docs/data/relations.json, its tours in profile order, its mentions page by page.
    const graph = printed('graph') as {
      nodes: { id: string }[];
      edges: { a: string; verb: string; b: string }[];
      tours: { theme: string }[];
      mentions: { from: string; to: string }[];
    };
    expect(graph.nodes.map((n) => n.id)).toEqual((printed('ls --json') as { id: string }[]).map((n) => n.id));
    const { relations } = JSON.parse(sb.read('docs/data/relations.json')) as { relations: { a: string; verb: string; b: string }[] };
    expect(graph.edges.map((e) => `${e.a} ${e.verb} ${e.b}`)).toEqual(relations.map((e) => `${e.a} ${e.verb} ${e.b}`));
    expect(graph.tours.map((t) => t.theme)).toEqual(profiles.filter((p) => records.has(p.id)).map((p) => p.id));
    expect(graph.mentions.map((m) => `${m.from} ${m.to}`)).toEqual(ids.flatMap((id) => (records.get(id) as RecordJson).mentions.map((to) => `${id} ${to}`)));
  }, REAL_TREE_TIMEOUT);
});
