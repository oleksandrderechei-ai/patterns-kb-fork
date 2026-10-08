/**
 * The deployed-site smoke check (tools/src/site/site-smoke.ts) against a fake
 * site: what every answer must be for a pass, one failure for each thing a
 * host can get wrong, the wait for a deploy to reach the CDN with no real
 * waiting, and misuse. The schemas it compares with are written into the
 * sandbox, so the suite does not depend on the contract's own files. One group
 * runs the real network and clock against a local server.
 */

import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONTRACTS, SCHEMA_BASES, SCHEMA_DIR, schemaUrl } from '../contract/contract.js';
import { DIALECT, type JsonSchema } from '../lib/json-schema.js';
import { expectFail, expectMisuse, expectPass, makeSandbox, type Captured, type Sandbox } from '../lib/sandbox.js';
import {
  BACKOFF_SECONDS,
  FINDINGS_SHOWN,
  httpGet,
  MISSING_ROUTE,
  pause,
  pauses,
  smokeSpec,
  spec,
  WINDOW_SECONDS,
  type Net,
} from './site-smoke.js';

// ---------------------------------------------------------------------------
// the fake host
// ---------------------------------------------------------------------------

/** One answer of the fake host. A body that is an Error makes the request fail the way a dropped connection does. */
interface Reply {
  readonly status?: number;
  /** The Content-Type header; `null` sends none. Absent means JSON, as the host sends it. */
  readonly type?: string | null;
  readonly body: string | Error;
}

/**
 * What the fake host holds, by path. A list is the answers to successive
 * requests, the last one repeating. `*` answers every path not listed; without
 * it an unknown path is a 404.
 */
type Routes = Record<string, Reply | Reply[]>;

const JSON_TYPE = 'application/json; charset=utf-8';

const NOT_FOUND: Reply = { status: 404, type: 'text/html; charset=utf-8', body: '<!doctype html><h1>Page not found</h1>' };

/** The fake host as a `Net`, with the addresses it was asked for and the pauses it was asked to take. */
function fakeNet(routes: Routes): { net: Net; calls: string[]; sleeps: number[] } {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const asked = new Map<string, number>();
  const net: Net = {
    async fetch(url) {
      calls.push(url);
      const at = new URL(url).pathname;
      const held = routes[at] ?? routes['*'];
      const replies = held === undefined ? [NOT_FOUND] : Array.isArray(held) ? held : [held];
      const n = asked.get(at) ?? 0;
      asked.set(at, n + 1);
      const reply = replies[Math.min(n, replies.length - 1)] as Reply;
      if (reply.body instanceof Error) throw reply.body;
      const type = reply.type === undefined ? JSON_TYPE : reply.type;
      // A string body gets a Content-Type of its own unless one is given; bytes get none.
      return type === null
        ? new Response(Buffer.from(reply.body), { status: reply.status ?? 200 })
        : new Response(reply.body, { status: reply.status ?? 200, headers: { 'content-type': type } });
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
  };
  return { net, calls, sleeps };
}

// ---------------------------------------------------------------------------
// what the site holds when it is right
// ---------------------------------------------------------------------------

const ROOT = 'https://site.test/patterns-kb/';
/** The path the root is served under. */
const AT = '/patterns-kb/';

const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

const schemaOf = (base: string, properties: Record<string, unknown>, required: readonly string[]): JsonSchema => ({
  $schema: DIALECT,
  $id: schemaUrl(base),
  type: 'object',
  properties,
  required,
});

const ENTRY = (required: readonly string[]): Record<string, unknown> => ({
  type: 'object',
  properties: { id: { type: 'string' }, kind: { type: 'string' }, record: { type: 'string' } },
  required,
});

const indexSchema = (entryRequired: readonly string[] = ['id', 'kind', 'record']): JsonSchema =>
  schemaOf(
    SCHEMA_BASES.index,
    {
      contract: { type: 'string', const: CONTRACTS.index },
      pages: { type: 'array', items: ENTRY(entryRequired) },
    },
    ['contract', 'pages'],
  );

const INDEX_SCHEMA = indexSchema();
const RECORD_SCHEMA = schemaOf(
  SCHEMA_BASES.record,
  {
    contract: { type: 'string', const: CONTRACTS.record },
    id: { type: 'string' },
    title: { type: 'string' },
  },
  ['contract', 'id', 'title'],
);

const PATTERN_ROUTE = 'patterns/distributed/resilience/circuit-breaker.json';
const PAGES = [
  { id: 'cap-theorem', kind: 'theme', record: '/themes/cap-theorem.json' },
  { id: 'circuit-breaker', kind: 'pattern', record: `/${PATTERN_ROUTE}` },
  { id: 'retry', kind: 'pattern', record: '/patterns/distributed/resilience/retry.json' },
];
const INDEX = text({ contract: CONTRACTS.index, pages: PAGES });
const INDEX_SHA = digest(INDEX);
const RECORD = text({ contract: CONTRACTS.record, id: 'circuit-breaker', title: 'Circuit breaker' });

const route = (rel: string): string => `${AT}${rel}`;
const INDEX_ROUTE = route('index.json');
const RECORD_ROUTE = route(PATTERN_ROUTE);
const INDEX_SCHEMA_ROUTE = route(`schema/${SCHEMA_BASES.index}.json`);
const RECORD_SCHEMA_ROUTE = route(`schema/${SCHEMA_BASES.record}.json`);

/** The site as a correct deploy of the build leaves it, with `over` changing what a test is about. */
function liveSite(over: Routes = {}): Routes {
  return {
    [INDEX_ROUTE]: { body: INDEX },
    [route('llms.txt')]: { type: 'text/plain; charset=utf-8', body: '# patterns-kb\n\n- [Circuit breaker](patterns/distributed/resilience/circuit-breaker.html)\n' },
    [INDEX_SCHEMA_ROUTE]: { body: text(INDEX_SCHEMA) },
    [RECORD_SCHEMA_ROUTE]: { body: text(RECORD_SCHEMA) },
    [RECORD_ROUTE]: { body: RECORD },
    ...over,
  };
}

/** A refused or reset connection, as undici reports one. */
const reset = (): Reply => ({ body: new TypeError('fetch failed', { cause: new Error('read ECONNRESET') }) });

// ---------------------------------------------------------------------------
// the sandbox
// ---------------------------------------------------------------------------

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
  sb.write(`${SCHEMA_DIR}/${SCHEMA_BASES.index}.json`, text(INDEX_SCHEMA));
  sb.write(`${SCHEMA_DIR}/${SCHEMA_BASES.record}.json`, text(RECORD_SCHEMA));
});
afterEach(() => sb.cleanup());

/** The arguments of a deploy: the root and the build's fingerprint. */
const BUILD = ['--url', ROOT, '--index-sha', INDEX_SHA];

/** Run the check against `routes`, with what it asked and how long it paused. */
async function check(
  routes: Routes,
  argv: readonly string[] = BUILD,
): Promise<{ r: Captured; calls: string[]; sleeps: number[] }> {
  const site = fakeNet(routes);
  const r = await sb.run(smokeSpec(site.net), argv);
  return { r, calls: site.calls, sleeps: site.sleeps };
}

/** The findings of a failing run, one string each. */
const found = (r: Captured): string[] => r.err.trim().split('\n');

/** Give the sandbox and the deployed site this index schema in place of the standard one. */
function withIndexSchema(schema: JsonSchema): Routes {
  sb.write(`${SCHEMA_DIR}/${SCHEMA_BASES.index}.json`, text(schema));
  return { [INDEX_SCHEMA_ROUTE]: { body: text(schema) } };
}

/** The seconds of waiting a list of pauses adds up to. */
const total = (waits: readonly number[]): number => waits.reduce((a, b) => a + b, 0);

/** How long GitHub Pages lets a CDN keep a copy of a file: its `Cache-Control: max-age`, in seconds. */
const CACHE_LIFETIME = 600;

/** The pauses of the whole wait, in seconds: 5, 10, 20, then 30 while the window of 660 lasts. */
const FULL_WAIT = [5, 10, 20, ...Array.from({ length: 20 }, () => 30)];

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------

describe('site-smoke', () => {
  it('passes when the deployed manifest matches the build and every answer validates', async () => {
    const { r, calls, sleeps } = await check(liveSite());
    expectPass(r);
    expect(r.out).toBe(
      `[site-smoke] ${ROOT} answers: index (kb-index/1, 3 pages), llms.txt, 1 record, schemas match, 404 holds`,
    );
    expect(r.err).toBe('');
    expect(sleeps).toEqual([]);
    // The index is asked for by the build's fingerprint; every other address once, and only the first pattern's record.
    expect(calls).toEqual([
      `${ROOT}index.json?build=${INDEX_SHA}`,
      `${ROOT}schema/kb-index-1.json`,
      `${ROOT}schema/kb-record-1.json`,
      `${ROOT}llms.txt`,
      `${ROOT}${PATTERN_ROUTE}`,
      `${ROOT}${MISSING_ROUTE}`,
    ]);
  });

  it('waits out CDN lag: twice stale, then current, is a pass', async () => {
    const stale: Reply = { body: text({ contract: CONTRACTS.index, pages: [] }) };
    const { r, calls, sleeps } = await check(liveSite({ [INDEX_ROUTE]: [stale, stale, { body: INDEX }] }));
    expectPass(r);
    expect(r.out).toContain('index (kb-index/1, 3 pages)');
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(calls.filter((c) => c.startsWith(`${ROOT}index.json?`))).toHaveLength(3);
  });

  it('fails after the window, naming the expected and served fingerprints', async () => {
    const staleText = text({ contract: CONTRACTS.index, pages: [] });
    const { r, calls, sleeps } = await check(liveSite({ [INDEX_ROUTE]: { body: staleText } }));
    expectFail(r);
    expect(r.out).toBe('');
    expect(found(r)).toEqual([
      `[site-smoke] FAIL: ${ROOT}index.json still serves sha256 ${digest(staleText)}, not the sha256 ${INDEX_SHA} the build wrote, ` +
        'after 24 tries over 635 s — the host serves another build: this deploy has not reached it, or a later one replaced it',
    ]);
    expect(sleeps).toEqual(FULL_WAIT.map((s) => s * 1000));
    // The wait fits the window and outlasts the time a CDN may keep the copy it served before the deploy.
    expect(total(sleeps)).toBeLessThanOrEqual(WINDOW_SECONDS * 1000);
    expect(total(sleeps)).toBeGreaterThan(CACHE_LIFETIME * 1000);
    // A host that is not serving this build is asked nothing else.
    expect(calls).toHaveLength(24);
    expect(calls.every((c) => c.startsWith(`${ROOT}index.json?`))).toBe(true);
  });

  it('retries a 503 and a reset connection', async () => {
    const down: Reply = { status: 503, type: 'text/html; charset=utf-8', body: '<h1>Service unavailable</h1>' };
    const { r, sleeps } = await check(liveSite({ [INDEX_ROUTE]: [down, reset(), { body: INDEX }] }));
    expectPass(r);
    expect(sleeps).toEqual([5_000, 10_000]);
  });

  it('reports an index that never answers by what its last try got', async () => {
    const never = (reply: Reply): Routes => liveSite({ [INDEX_ROUTE]: reply });

    const connection = await check(never(reset()));
    expectFail(connection.r);
    expect(found(connection.r)).toEqual([`[site-smoke] FAIL: ${ROOT}index.json could not be fetched: fetch failed (read ECONNRESET)`]);
    expect(connection.sleeps).toHaveLength(FULL_WAIT.length);

    // An error with no cause is reported as its own message.
    const refused = await check(never({ body: new Error('connect ECONNREFUSED') }));
    expect(found(refused.r)).toEqual([`[site-smoke] FAIL: ${ROOT}index.json could not be fetched: connect ECONNREFUSED`]);

    const busy = await check(never({ status: 503, type: 'text/html', body: 'busy' }));
    expect(found(busy.r)).toEqual([`[site-smoke] FAIL: ${ROOT}index.json answered HTTP 503, not 200`]);
    expect(busy.sleeps).toHaveLength(FULL_WAIT.length);
  });

  it('stops waiting at an answer that is not a 200, since waiting will not change it', async () => {
    const { r, calls, sleeps } = await check(liveSite({ [INDEX_ROUTE]: { status: 404, type: 'text/html', body: 'no' } }));
    expectFail(r);
    expect(found(r)).toEqual([`[site-smoke] FAIL: ${ROOT}index.json answered HTTP 404, not 200`]);
    expect(sleeps).toEqual([]);
    expect(calls.filter((c) => c.startsWith(`${ROOT}index.json?`))).toHaveLength(1);
  });

  it('fails a record that breaks the published schema', async () => {
    const broken = text({ contract: CONTRACTS.record, id: 7 });
    const { r } = await check(liveSite({ [RECORD_ROUTE]: { body: broken } }));
    expectFail(r);
    const lines = found(r);
    expect(lines).toHaveLength(2);
    expect(lines).toContain(`[site-smoke] FAIL: ${ROOT}${PATTERN_ROUTE} breaks kb-record-1: /: must have required property 'title' (required)`);
    expect(lines).toContain(`[site-smoke] FAIL: ${ROOT}${PATTERN_ROUTE} breaks kb-record-1: /id: must be string (type)`);
  });

  it('fails a record whose id is not the one the index lists for the page', async () => {
    const other = text({ contract: CONTRACTS.record, id: 'retry', title: 'Retry' });
    const { r } = await check(liveSite({ [RECORD_ROUTE]: { body: other } }));
    expectFail(r);
    expect(found(r)).toEqual([
      `[site-smoke] FAIL: ${ROOT}${PATTERN_ROUTE} has id "retry", but ${ROOT}index.json lists the page as "circuit-breaker"`,
    ]);
  });

  it('names the page by its record route when the index entry carries no id', async () => {
    const loose = withIndexSchema(indexSchema(['kind', 'record']));
    const noIds = text({ contract: CONTRACTS.index, pages: PAGES.map(({ kind, record }) => ({ kind, record })) });
    const site = { ...liveSite(loose), [INDEX_ROUTE]: { body: noIds } };

    // The record's id is the file name of its route: `circuit-breaker`.
    expectPass((await check(site, ['--url', ROOT])).r);
    const wrong = text({ contract: CONTRACTS.record, id: 'retry', title: 'Retry' });
    const { r } = await check({ ...site, [RECORD_ROUTE]: { body: wrong } }, ['--url', ROOT]);
    expectFail(r, 'lists the page as "circuit-breaker"');
  });

  it('fails a record that is missing, is not JSON, or is not served as JSON', async () => {
    const missing = await check(liveSite({ [RECORD_ROUTE]: NOT_FOUND }));
    expect(found(missing.r)).toEqual([`[site-smoke] FAIL: ${ROOT}${PATTERN_ROUTE} answered HTTP 404, not 200`]);

    const garbled = await check(liveSite({ [RECORD_ROUTE]: { body: '{"id": ' } }));
    expectFail(garbled.r);
    expect(found(garbled.r)).toHaveLength(1);
    expect(found(garbled.r)[0]).toContain(`[site-smoke] FAIL: ${ROOT}${PATTERN_ROUTE} is not valid JSON: `);

    const typed = await check(liveSite({ [RECORD_ROUTE]: { type: 'text/plain; charset=utf-8', body: RECORD } }));
    expect(found(typed.r)).toEqual([`[site-smoke] FAIL: ${ROOT}${PATTERN_ROUTE} is served as "text/plain; charset=utf-8", not application/json`]);
  });

  it('fails an index with no page of kind pattern, or whose first pattern names no record', async () => {
    const themes = text({ contract: CONTRACTS.index, pages: [PAGES[0]] });
    const none = await check(liveSite({ [INDEX_ROUTE]: { body: themes } }), ['--url', ROOT]);
    expectFail(none.r);
    expect(found(none.r)).toEqual([`[site-smoke] FAIL: ${ROOT}index.json lists no page of kind "pattern", so no record was checked`]);

    const loose = withIndexSchema(indexSchema(['id', 'kind']));
    const bare = text({ contract: CONTRACTS.index, pages: [{ id: 'circuit-breaker', kind: 'pattern' }] });
    const unnamed = await check(liveSite({ ...loose, [INDEX_ROUTE]: { body: bare } }), ['--url', ROOT]);
    expect(found(unnamed.r)).toEqual([`[site-smoke] FAIL: ${ROOT}index.json: its first page of kind "pattern" names no record`]);
  });

  it('counts an index with no pages list as one with no pattern', async () => {
    // The schema does not require `pages`, so an index without it holds the schema and lists nothing.
    const optional = schemaOf(SCHEMA_BASES.index, { contract: { type: 'string', const: CONTRACTS.index } }, ['contract']);
    const loose = withIndexSchema(optional);
    const bare = text({ contract: CONTRACTS.index });
    const { r } = await check(liveSite({ ...loose, [INDEX_ROUTE]: { body: bare } }), ['--url', ROOT]);
    expect(found(r)).toEqual([`[site-smoke] FAIL: ${ROOT}index.json lists no page of kind "pattern", so no record was checked`]);
  });

  it('fails an index that breaks the schema, showing the first findings and counting the rest', async () => {
    const pages = Array.from({ length: FINDINGS_SHOWN + 3 }, () => ({ kind: 'pattern', record: '/x.json' }));
    const bad = text({ contract: CONTRACTS.index, pages });
    const { r, calls } = await check(liveSite({ [INDEX_ROUTE]: { body: bad } }), ['--url', ROOT]);
    expectFail(r);
    const lines = found(r);
    expect(lines).toHaveLength(FINDINGS_SHOWN + 1);
    for (let i = 0; i < FINDINGS_SHOWN; i += 1) {
      expect(lines[i]).toBe(`[site-smoke] FAIL: ${ROOT}index.json breaks kb-index-1: /pages/${String(i)}: must have required property 'id' (required)`);
    }
    expect(lines[FINDINGS_SHOWN]).toBe(`[site-smoke] FAIL: ${ROOT}index.json breaks kb-index-1 in 3 more place(s)`);
    // An index that breaks its schema names no record worth asking for.
    expect(calls.some((c) => c.includes(PATTERN_ROUTE))).toBe(false);
  });

  it('fails JSON served with a non-JSON content type', async () => {
    const html = await check(liveSite({ [INDEX_ROUTE]: { type: 'text/html; charset=utf-8', body: INDEX } }));
    expectFail(html.r);
    expect(found(html.r)).toEqual([`[site-smoke] FAIL: ${ROOT}index.json is served as "text/html; charset=utf-8", not application/json`]);

    // No Content-Type at all is the same finding, with nothing between the quotes.
    const bare = await check(liveSite({ [INDEX_ROUTE]: { type: null, body: INDEX } }));
    expect(found(bare.r)).toEqual([`[site-smoke] FAIL: ${ROOT}index.json is served as "", not application/json`]);
  });

  it('fails a published schema that differs from the repo', async () => {
    const edited = text({ ...RECORD_SCHEMA, title: 'edited since the build' });
    const repoCopy = text(RECORD_SCHEMA);
    const { r } = await check(liveSite({ [RECORD_SCHEMA_ROUTE]: { body: edited } }));
    expectFail(r);
    expect(found(r)).toEqual([
      `[site-smoke] FAIL tools/src/contract/schema/kb-record-1.json: differs from the deployed copy at ${ROOT}schema/kb-record-1.json: ` +
        `the site serves ${String(edited.length)} bytes (sha256 ${digest(edited)}), this file ${String(repoCopy.length)} (sha256 ${digest(repoCopy)}) — ` +
        'the deploy is an older build, or this file was edited after the build',
    ]);
  });

  it('fails a published schema the host does not serve', async () => {
    const { r } = await check(liveSite({ [INDEX_SCHEMA_ROUTE]: NOT_FOUND }));
    expectFail(r);
    expect(found(r)).toEqual([`[site-smoke] FAIL: ${ROOT}schema/kb-index-1.json answered HTTP 404, not 200`]);
  });

  it('fails when the repo has no copy of a published schema, before it asks the host anything', async () => {
    sb.rm(`${SCHEMA_DIR}/${SCHEMA_BASES.index}.json`);
    const { r, calls } = await check(liveSite());
    expectFail(r);
    expect(found(r)).toEqual([
      '[site-smoke] FAIL tools/src/contract/schema/kb-index-1.json: is missing — the deployed schema is compared with this copy',
    ]);
    expect(calls).toEqual([]);
  });

  it('fails an llms.txt that is missing, empty or not served as plain text', async () => {
    const missing = await check(liveSite({ [route('llms.txt')]: NOT_FOUND }));
    expect(found(missing.r)).toEqual([`[site-smoke] FAIL: ${ROOT}llms.txt answered HTTP 404, not 200`]);

    const empty = await check(liveSite({ [route('llms.txt')]: { type: 'text/plain; charset=utf-8', body: ' \n' } }));
    expect(found(empty.r)).toEqual([`[site-smoke] FAIL: ${ROOT}llms.txt is empty`]);

    // Markdown is text too; a page and JSON are not what a reader of llms.txt asked for.
    const markdown = await check(liveSite({ [route('llms.txt')]: { type: 'text/markdown', body: '# patterns-kb\n' } }));
    expectPass(markdown.r);
    const html = await check(liveSite({ [route('llms.txt')]: { type: 'text/html; charset=utf-8', body: '<h1>home</h1>' } }));
    expect(found(html.r)).toEqual([`[site-smoke] FAIL: ${ROOT}llms.txt is served as "text/html; charset=utf-8", not as plain text`]);
    const json = await check(liveSite({ [route('llms.txt')]: { body: '{}' } }));
    expect(found(json.r)).toEqual([`[site-smoke] FAIL: ${ROOT}llms.txt is served as "${JSON_TYPE}", not as plain text`]);
  });

  it('fails a missing path that answers 200', async () => {
    // A host that falls back to the home page answers 200 to every path it lacks.
    const fallback: Reply = { type: 'text/html; charset=utf-8', body: '<!doctype html><h1>patterns-kb</h1>' };
    const { r } = await check({ ...liveSite(), '*': fallback });
    expectFail(r);
    expect(found(r)).toEqual([
      `[site-smoke] FAIL: ${ROOT}${MISSING_ROUTE} answered HTTP 200, not 404 — a path the site lacks must not fall back to a page`,
    ]);
  });

  it('reports every question a host that cannot be reached fails, and asks the record of none', async () => {
    const { r, calls, sleeps } = await check({ '*': reset() });
    expectFail(r);
    const gone = 'could not be fetched: fetch failed (read ECONNRESET)';
    expect(found(r)).toEqual([
      `[site-smoke] FAIL: ${ROOT}index.json ${gone}`,
      `[site-smoke] FAIL: ${ROOT}schema/kb-index-1.json ${gone}`,
      `[site-smoke] FAIL: ${ROOT}schema/kb-record-1.json ${gone}`,
      `[site-smoke] FAIL: ${ROOT}llms.txt ${gone}`,
      `[site-smoke] FAIL: ${ROOT}${MISSING_ROUTE} ${gone}`,
    ]);
    // Only the index is waited for: every try of it, and one try of each of the other four addresses.
    expect(sleeps).toHaveLength(FULL_WAIT.length);
    expect(calls).toHaveLength(FULL_WAIT.length + 1 + 4);
  });

  it('skips the fingerprint wait without --index-sha', async () => {
    // The served index is not the one any build wrote, and nobody said which build to expect.
    const older = text({ contract: CONTRACTS.index, pages: PAGES.slice(0, 2) });
    const ok = await check(liveSite({ [INDEX_ROUTE]: { body: older } }), ['--url', ROOT]);
    expectPass(ok.r);
    expect(ok.r.out).toContain('index (kb-index/1, 2 pages)');
    expect(ok.sleeps).toEqual([]);
    expect(ok.calls.some((c) => c.includes('?'))).toBe(false);

    // One request: a 503 is a finding straight away, not a wait.
    const down: Reply = { status: 503, type: 'text/html', body: 'down' };
    const once = await check(liveSite({ [INDEX_ROUTE]: down }), ['--url', ROOT]);
    expectFail(once.r, `${ROOT}index.json answered HTTP 503, not 200`);
    expect(once.sleeps).toEqual([]);
    expect(once.calls.filter((c) => c.includes('index.json'))).toHaveLength(1);
  });

  it('reads a root without its trailing slash, and drops a query or fragment from it', async () => {
    const { r, calls } = await check(liveSite(), ['--url', 'https://site.test/patterns-kb?x=1#top', '--index-sha', INDEX_SHA]);
    expectPass(r);
    expect(r.out).toContain(`[site-smoke] ${ROOT} answers:`);
    expect(calls[0]).toBe(`${ROOT}index.json?build=${INDEX_SHA}`);
  });

  it('exits 2 without --url', async () => {
    const { r, calls } = await check(liveSite(), []);
    expectMisuse(r);
    expect(r.out).toBe('');
    expect(found(r)).toEqual([
      '[site-smoke] --url is required: the published root of the site, such as https://odere-pro.github.io/patterns-kb/',
      'usage: site-smoke --url <published root> [--index-sha <sha256 of the built index.json>]',
    ]);
    expect(calls).toEqual([]);
  });

  it('exits 2 for an address that is not http or https, a fingerprint that is not a sha256 and an unknown flag', async () => {
    const wrong: [readonly string[], string][] = [
      [['--url', 'patterns-kb'], '--url "patterns-kb" is not an address'],
      [['--url', 'ftp://site.test/'], '--url "ftp://site.test/" is not an http or https address'],
      [['--url', ROOT, '--index-sha', ''], '--index-sha "" is not a sha256: 64 lower-case hex digits'],
      [['--url', ROOT, '--index-sha', INDEX_SHA.toUpperCase()], 'is not a sha256: 64 lower-case hex digits'],
      [['--url', ROOT, '--index-sha', INDEX_SHA.slice(1)], 'is not a sha256: 64 lower-case hex digits'],
      [['--url', ROOT, '--wait'], '[site-smoke] unknown argument: --wait'],
      [['--url'], '[site-smoke] --url needs a value'],
    ];
    for (const [argv, said] of wrong) {
      const { r, calls } = await check(liveSite(), argv);
      expectMisuse(r);
      expect(r.err).toContain(said);
      expect(calls).toEqual([]);
    }
  });

  it('prints its usage for --help without asking the host anything', async () => {
    const r = await sb.run(spec, ['--help']);
    expectPass(r);
    expect(r.out).toBe('usage: site-smoke --url <published root> [--index-sha <sha256 of the built index.json>]');
  });
});

// ---------------------------------------------------------------------------
// the wait
// ---------------------------------------------------------------------------

describe('pauses', () => {
  it('backs off 5, 10, 20, then 30 seconds, and stays inside the window', () => {
    expect(pauses(WINDOW_SECONDS)).toEqual(FULL_WAIT);
    expect(total(pauses(WINDOW_SECONDS))).toBeLessThanOrEqual(WINDOW_SECONDS);
    // The window is what it is because it outlasts one cache lifetime of the file it waits for.
    expect(WINDOW_SECONDS).toBeGreaterThan(CACHE_LIFETIME);
    expect(total(pauses(WINDOW_SECONDS))).toBeGreaterThan(CACHE_LIFETIME);
    expect(BACKOFF_SECONDS).toEqual([5, 10, 20, 30]);
  });

  it('adds a pause only when it fits whole', () => {
    expect(pauses(0)).toEqual([]);
    expect(pauses(4)).toEqual([]);
    expect(pauses(5)).toEqual([5]);
    expect(pauses(34)).toEqual([5, 10]);
    expect(pauses(35)).toEqual([5, 10, 20]);
    expect(pauses(Number.NaN)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the real network and clock, against a local server
// ---------------------------------------------------------------------------

describe('over real HTTP', () => {
  const open: http.Server[] = [];
  afterEach(async () => {
    for (const server of open.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  /** A local host that answers `routes` and a 404 to anything else, with its published root. */
  async function serve(routes: Routes): Promise<string> {
    const server = http.createServer((req, res) => {
      const held = routes[new URL(req.url as string, 'http://local.test').pathname];
      const reply = (Array.isArray(held) ? held[0] : held) ?? NOT_FOUND;
      res.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? JSON_TYPE });
      res.end(reply.body instanceof Error ? reply.body.message : reply.body);
    });
    open.push(server);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${AT}`;
  }

  it('answers the same questions of a local server, query strings and content types included', async () => {
    const root = await serve(liveSite());
    const r = await sb.run(spec, ['--url', root, '--index-sha', INDEX_SHA]);
    expectPass(r);
    expect(r.out).toBe(`[site-smoke] ${root} answers: index (kb-index/1, 3 pages), llms.txt, 1 record, schemas match, 404 holds`);
  });

  it('names a path that a real server answers 200 with a page', async () => {
    const root = await serve({ ...liveSite(), [route(MISSING_ROUTE)]: { type: 'text/html; charset=utf-8', body: '<h1>home</h1>' } });
    const r = await sb.run(spec, ['--url', root, '--index-sha', INDEX_SHA]);
    expectFail(r, `${root}${MISSING_ROUTE} answered HTTP 200, not 404`);
  });

  it('gives up on a request that is never answered', async () => {
    const server = http.createServer(() => {
      // Takes the connection and says nothing.
    });
    open.push(server);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
    await expect(httpGet(url, 50)).rejects.toThrow();
  });

  it('pauses for the time it is given', async () => {
    await expect(pause(1)).resolves.toBeUndefined();
  });
});
