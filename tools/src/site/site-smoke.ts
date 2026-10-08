/**
 * The deployed-site smoke check: after a deploy, ask the live site the few
 * questions a machine reader's first requests depend on, and say which one it
 * answers wrong.
 *
 * The build's own gates judged every page before it shipped. This judges what
 * the host serves, which a build cannot see: a CDN still holding the previous
 * build, a schema that never reached the site, a missing path that answers 200
 * with a page. It never crawls: a handful of requests and one record, however
 * large the site grows.
 *
 *     node_modules/.bin/tsx tools/src/site/site-smoke.ts --url <published root> [--index-sha <sha256>]
 *
 * `--index-sha` is the sha256, in lower-case hex, of the `index.json` the build
 * wrote. With it, `index.json?build=<sha>` is asked for again, after 5, 10, 20
 * and then 30 seconds, until its bytes hash to that fingerprint, for at most 660
 * seconds of waiting (the last try falls at 635): a CDN serves the previous
 * deploy for a while, and judging that copy would blame this build for the last
 * one's faults. A dropped connection and a 5xx answer wait the same way.
 *
 * The window is 660 seconds because GitHub Pages sends `Cache-Control:
 * max-age=600` with `index.json` and leaves the query out of its cache key
 * (measured 2026-10-08): a copy cached just before a deploy can outlive it by a
 * full 600 seconds, and a shorter wait would turn a routine deploy red. The query
 * names the build and changes nothing on a static host, so it only documents
 * which build is expected, and it helps on a CDN that does key on it; on Pages
 * it is the wait, never the query, that makes the check read this build. Once the
 * index is the build's the host has taken the deploy up, and every other address
 * is asked once and read as it comes. Without `--index-sha` the index is asked
 * once too, which is what a scheduled or manual run wants.
 *
 * What it asks, in this order. A failed question is a finding and the run goes
 * on to the next one, with two exceptions that end it: a stale `index.json`,
 * since nothing else the host serves can be trusted to be this build's, and a
 * checkout that lacks a published schema, which is found before anything is
 * asked.
 *
 *   index.json        answers 200 as application/json and holds the published
 *                     (open) kb-index-1 schema
 *   schema/…          kb-index-1 and kb-record-1 are byte for byte the copies
 *                     under tools/src/contract/schema/ in this checkout
 *   llms.txt          answers 200 as plain text, not as a page, and is not empty
 *   one record        the first page of kind `pattern` in the index: its
 *                     `record` answers 200 as application/json, holds the
 *                     kb-record-1 schema, and carries the id the index gives
 *   a missing path    answers 404, not a fallback page
 *
 * It compares nothing date-like and reads no page: bytes of the two schemas, the
 * fingerprint of the index, and what two documents say about themselves.
 *
 * Exit statuses are the gate contract's (lib/gate.ts). Misuse is exit 2 with
 * nothing asked: no `--url`, an address that is not http or https, a
 * fingerprint that is not 64 lower-case hex digits, an unknown flag.
 *
 * `smokeSpec` takes the network and the clock, so a test runs the whole check
 * against a fake site without waiting.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CONTRACTS, contractSchemas, SCHEMA_BASES, SCHEMA_DIR, schemaUrl } from '../contract/contract.js';
import { main, UsageError, type GateContext, type GateSpec } from '../lib/gate.js';
import { formatFinding, type SchemaSet } from '../lib/json-schema.js';

/** How long one request may take before it counts as a dropped connection. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long the wait for the new build may last, counting the pauses between
 * tries and not the tries. It outlasts the 600 seconds a CDN may keep the
 * previous build's index (see the header).
 */
export const WINDOW_SECONDS = 660;

/** The pause before each retry, in seconds; the last one repeats. */
export const BACKOFF_SECONDS: readonly number[] = [5, 10, 20, 30];

/** How many findings of one document are written out; the rest are counted. */
export const FINDINGS_SHOWN = 5;

/** A path the site must not hold, asked for to see what the host answers to one it lacks. */
export const MISSING_ROUTE = '__kb_missing__.json';

/** The schemas the deployed site must serve exactly as the repo holds them. */
const PUBLISHED = [SCHEMA_BASES.index, SCHEMA_BASES.record] as const;

const USAGE = 'usage: site-smoke --url <published root> [--index-sha <sha256 of the built index.json>]';

/** The two things the check does that touch the world, so a test can stand in for both. */
export interface Net {
  /** One GET. Rejects when nothing answers: the connection is refused, reset or past its deadline. */
  readonly fetch: (url: string) => Promise<Response>;
  /** Wait `ms` milliseconds. */
  readonly sleep: (ms: number) => Promise<void>;
}

/** One GET with a deadline, so a host that takes the connection and never answers cannot hold the job. */
export function httpGet(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

/** Wait in real time. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The network and the clock as they are. */
const REAL: Net = { fetch: httpGet, sleep: pause };

/**
 * The pauses, in seconds, of a wait that may last `windowSeconds`: 5, 10, 20,
 * then 30 for as long as the next one still fits. A window of 660 gives 24
 * tries over 635 seconds, and a window too short for the first pause gives none.
 */
export function pauses(windowSeconds: number): number[] {
  const out: number[] = [];
  let spent = 0;
  let next = BACKOFF_SECONDS[0] as number;
  while (spent + next <= windowSeconds) {
    out.push(next);
    spent += next;
    next = BACKOFF_SECONDS[Math.min(out.length, BACKOFF_SECONDS.length - 1)] as number;
  }
  return out;
}

/** What one request came back with. */
interface Answer {
  readonly status: number;
  /** The Content-Type header as sent, or '' when the host sent none. */
  readonly type: string;
  readonly body: Buffer;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The media type of a Content-Type header, without parameters and in lower case. */
const mediaType = (type: string): string => (type.split(';')[0] as string).trim().toLowerCase();

/** The repo's path of a published schema, as a finding names it. */
const schemaFile = (base: string): string => `${SCHEMA_DIR}/${base}.json`;

/**
 * Why a request got no answer, in one line. undici reports every network
 * failure as `fetch failed` and keeps the reason in the cause (`read
 * ECONNRESET`), so the cause is what says which failure it was.
 */
function reason(e: unknown): string {
  const { message, cause } = e as Error;
  const why = (cause as Error | undefined)?.message;
  return why === undefined ? message : `${message} (${why})`;
}

/** One request: what the host answered, or why nothing did. */
async function attempt(net: Net, url: string): Promise<Answer | string> {
  try {
    const response = await net.fetch(url);
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: Buffer.from(await response.arrayBuffer()),
    };
  } catch (e) {
    return reason(e);
  }
}

/**
 * Ask for `url`, and again after each of `waits` (seconds) until `isFresh`
 * accepts the answer. A request with no answer and a 5xx answer are never
 * accepted, whatever `isFresh` says: they are the host catching up, not a
 * verdict. When the waits run out the last result comes back as it is, for the
 * caller to judge. No waits is one request.
 */
async function ask(
  net: Net,
  url: string,
  waits: readonly number[],
  isFresh: (answer: Answer) => boolean,
): Promise<Answer | string> {
  let last = await attempt(net, url);
  for (const wait of waits) {
    if (typeof last !== 'string' && last.status < 500 && isFresh(last)) break;
    await net.sleep(wait * 1000);
    last = await attempt(net, url);
  }
  return last;
}

/**
 * The fingerprint a 200 answer serves instead of the build's, or null when it
 * serves the build's. Only a 200 has a fingerprint to compare: any other
 * status is wrong in its own way, and waiting does not change it.
 */
function servedInstead(answer: Answer, fingerprint: string): string | null {
  if (answer.status !== 200) return null;
  const served = sha256(answer.body);
  return served === fingerprint ? null : served;
}

/**
 * The published root as a URL ending in `/`, from `--url`. Throws `UsageError`
 * for an absent value and for one that is not an http or https address.
 */
function rootOf(value: string | undefined): URL {
  if (value === undefined) {
    throw new UsageError('--url is required: the published root of the site, such as https://odere-pro.github.io/software-design-atlas/');
  }
  let root: URL;
  try {
    root = new URL(value);
  } catch {
    throw new UsageError(`--url ${JSON.stringify(value)} is not an address`);
  }
  if (root.protocol !== 'https:' && root.protocol !== 'http:') {
    throw new UsageError(`--url ${JSON.stringify(value)} is not an http or https address`);
  }
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  root.search = '';
  root.hash = '';
  return root;
}

/**
 * The fingerprint from `--index-sha`, or undefined when none was given. An
 * empty or mistyped one is misuse rather than a silent request to skip the
 * wait: a workflow whose output went missing must fail, not check the wrong
 * build.
 */
function fingerprintOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new UsageError(`--index-sha ${JSON.stringify(value)} is not a sha256: 64 lower-case hex digits`);
  }
  return value;
}

/** The answer when the request got a `status` answer; otherwise a finding says what it got, and the result is null. */
function answeredWith(ctx: GateContext, name: string, got: Answer | string, status: number): Answer | null {
  if (typeof got === 'string') {
    ctx.failLine(`${name} could not be fetched: ${got}`);
    return null;
  }
  if (got.status !== status) {
    ctx.failLine(`${name} answered HTTP ${String(got.status)}, not ${String(status)}`);
    return null;
  }
  return got;
}

/**
 * The document a 200 answer carries as application/json, or `undefined` after
 * a finding that says what is wrong with the answer: not a 200, not served as
 * JSON, or not JSON at all. A body is read as a document only when the host
 * says it is one, because a fallback page answers with a body that is not.
 */
function documentOf(ctx: GateContext, name: string, got: Answer | string): unknown {
  const answer = answeredWith(ctx, name, got, 200);
  if (answer === null) return undefined;
  if (mediaType(answer.type) !== 'application/json') {
    ctx.failLine(`${name} is served as "${answer.type}", not application/json`);
    return undefined;
  }
  try {
    return JSON.parse(answer.body.toString('utf8')) as unknown;
  } catch (e) {
    ctx.failLine(`${name} is not valid JSON: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * Whether `document` holds the published schema `base`. The first
 * FINDINGS_SHOWN ways it does not are findings, and the rest are counted in
 * one more: a malformed index repeats one fault over hundreds of pages.
 */
function holds(ctx: GateContext, schemas: SchemaSet, base: string, name: string, document: unknown): boolean {
  const findings = schemas.validate(schemaUrl(base), document);
  for (const finding of findings.slice(0, FINDINGS_SHOWN)) {
    ctx.failLine(`${name} breaks ${base}: ${formatFinding(finding)}`);
  }
  const more = findings.length - FINDINGS_SHOWN;
  if (more > 0) ctx.failLine(`${name} breaks ${base} in ${String(more)} more place(s)`);
  return findings.length === 0;
}

/** The pages of an index that holds its schema; an index with no `pages` list lists none. */
function pagesOf(index: unknown): readonly Record<string, unknown>[] {
  const pages = (index as { pages?: unknown }).pages;
  return Array.isArray(pages) ? (pages as Record<string, unknown>[]) : [];
}

/** What every check after the index shares. */
interface Probe {
  readonly ctx: GateContext;
  readonly schemas: SchemaSet;
  /** The address of a route, as a finding names it. */
  readonly named: (route: string) => string;
  /** One request for a route. */
  readonly request: (route: string) => Promise<Answer | string>;
}

/**
 * The deployed schemas against the repo's copies, byte for byte. A copy that
 * differs means the host serves another build's schema, or the file in this
 * checkout was edited after the build it is compared with.
 */
async function checkSchemas(probe: Probe, copies: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const base of PUBLISHED) {
    const route = `schema/${base}.json`;
    const deployed = answeredWith(probe.ctx, probe.named(route), await probe.request(route), 200);
    const mine = copies.get(base) as Buffer;
    if (deployed !== null && !deployed.body.equals(mine)) {
      probe.ctx.fail(
        schemaFile(base),
        `differs from the deployed copy at ${probe.named(route)}: the site serves ${String(deployed.body.length)} bytes ` +
          `(sha256 ${sha256(deployed.body)}), this file ${String(mine.length)} (sha256 ${sha256(mine)}) — ` +
          'the deploy is an older build, or this file was edited after the build',
      );
    }
  }
}

/**
 * `llms.txt` answers 200 as text and holds something. A page is not text for
 * this purpose: a host that answers a file it lacks with its home page serves
 * `text/html`, and a reader fetching `llms.txt` would parse a page as the index.
 */
async function checkLlms(probe: Probe): Promise<void> {
  const name = probe.named('llms.txt');
  const answer = answeredWith(probe.ctx, name, await probe.request('llms.txt'), 200);
  if (answer === null) return;
  const type = mediaType(answer.type);
  if (!type.startsWith('text/') || type === 'text/html') {
    probe.ctx.failLine(`${name} is served as "${answer.type}", not as plain text`);
  }
  if (answer.body.toString('utf8').trim() === '') probe.ctx.failLine(`${name} is empty`);
}

/**
 * The first page of kind `pattern` in the index has a record that answers as
 * application/json, holds the kb-record-1 schema and names the id the index
 * gives the page. An entry names its page by `id`; one with none is named by
 * the file name of its record.
 */
async function checkRecord(probe: Probe, pages: readonly Record<string, unknown>[]): Promise<void> {
  const index = probe.named('index.json');
  const entry = pages.find((page) => page['kind'] === 'pattern');
  if (entry === undefined) {
    probe.ctx.failLine(`${index} lists no page of kind "pattern", so no record was checked`);
    return;
  }
  const record = entry['record'];
  if (typeof record !== 'string') {
    probe.ctx.failLine(`${index}: its first page of kind "pattern" names no record`);
    return;
  }
  const route = record.replace(/^\/+/, '');
  const name = probe.named(route);
  const id = typeof entry['id'] === 'string' ? entry['id'] : path.posix.basename(route, '.json');
  const document = documentOf(probe.ctx, name, await probe.request(route));
  if (document === undefined || !holds(probe.ctx, probe.schemas, SCHEMA_BASES.record, name, document)) return;
  const served = (document as { id?: unknown }).id;
  if (served !== id) {
    probe.ctx.failLine(`${name} has id ${JSON.stringify(served)}, but ${index} lists the page as ${JSON.stringify(id)}`);
  }
}

/** A path the site lacks answers 404: a host that falls back to a page answers 200 to everything. */
async function checkMissing(probe: Probe): Promise<void> {
  const name = probe.named(MISSING_ROUTE);
  const got = await probe.request(MISSING_ROUTE);
  if (typeof got === 'string') {
    probe.ctx.failLine(`${name} could not be fetched: ${got}`);
  } else if (got.status !== 404) {
    probe.ctx.failLine(`${name} answered HTTP ${String(got.status)}, not 404 — a path the site lacks must not fall back to a page`);
  }
}

/** The check, over the given network and clock. `spec` is the one that runs for real. */
export function smokeSpec(net: Net): GateSpec {
  return {
    name: 'site-smoke',
    usage: USAGE,
    options: ['--url', '--index-sha'],
    async run(ctx: GateContext): Promise<string> {
      const root = rootOf(ctx.options.get('--url'));
      const fingerprint = fingerprintOf(ctx.options.get('--index-sha'));

      // The repo's copies come first: with none to compare, nothing deployed can be judged.
      const copies = new Map<string, Buffer>();
      for (const base of PUBLISHED) {
        const file = path.join(ctx.root, schemaFile(base));
        if (fs.existsSync(file)) copies.set(base, fs.readFileSync(file));
        else ctx.fail(schemaFile(base), 'is missing — the deployed schema is compared with this copy');
      }
      if (ctx.findings > 0) return '';

      const probe: Probe = {
        ctx,
        schemas: contractSchemas(ctx.root, { closed: false }),
        named: (route) => `${root.href}${route}`,
        request: (route) => attempt(net, `${root.href}${route}`),
      };

      // The index, once the deploy has reached the host.
      const query = fingerprint === undefined ? '' : `?build=${fingerprint}`;
      const waits = fingerprint === undefined ? [] : pauses(WINDOW_SECONDS);
      const fresh = (answer: Answer): boolean => fingerprint === undefined || servedInstead(answer, fingerprint) === null;
      const name = probe.named('index.json');
      const got = await ask(net, `${name}${query}`, waits, fresh);
      if (fingerprint !== undefined && typeof got !== 'string') {
        const served = servedInstead(got, fingerprint);
        if (served !== null) {
          ctx.failLine(
            `${name} still serves sha256 ${served}, not the sha256 ${fingerprint} the build wrote, after ` +
              `${String(waits.length + 1)} tries over ${String(waits.reduce((a, b) => a + b, 0))} s — ` +
              'the host serves another build: this deploy has not reached it, or a later one replaced it',
          );
          return '';
        }
      }
      const index = documentOf(ctx, name, got);
      const sound = index !== undefined && holds(ctx, probe.schemas, SCHEMA_BASES.index, name, index);
      const pages = sound ? pagesOf(index) : [];

      await checkSchemas(probe, copies);
      await checkLlms(probe);
      if (sound) await checkRecord(probe, pages);
      await checkMissing(probe);

      return (
        `[${ctx.name}] ${root.href} answers: index (${CONTRACTS.index}, ${String(pages.length)} pages), ` +
        'llms.txt, 1 record, schemas match, 404 holds'
      );
    },
  };
}

/** The check over the real network and clock: what the program runs. */
export const spec: GateSpec = smokeSpec(REAL);

main(spec, import.meta.url);
