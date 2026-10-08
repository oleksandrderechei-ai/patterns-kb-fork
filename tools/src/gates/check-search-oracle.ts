/**
 * The search oracle: docs/data/search-oracle.json lists queries and what a
 * reader must see for each, and this gate runs every one through BOTH paths
 * that rank pages, the search box (`searchWithRetry` over the page tree's
 * payload pages, tools/src/lib/search-tree.ts) and kb.mjs `find` (`Session.search`
 * over the markdown), so a query one path answers and the other misses is a
 * finding, unless the case says `via` (below). The rates over every page's own
 * symptom text are the relevance fixtures'; this file holds the named queries
 * a person typed and saw go wrong.
 *
 * A case is an object with a query `q` and one or more expectations:
 *
 *   top     [ids]   the first hit is one of these
 *   kind    kind    each of the first `n` hits is a page of this kind (design, pattern, …)
 *   band    band    each of the first `n` hits is in this band (`ml`, `distributed`, …)
 *   n       number  how many hits `kind` and `band` look at; 3 when absent
 *   within  {id: n} the page is among the first n hits
 *   covers  {ids, n, min}
 *                   at least `min` of the `ids` are among the first `n` hits
 *
 * and one option:
 *
 *   via     "cli"   only kb.mjs `find` must answer the case; the search box is not asked
 *
 * `covers` is for a problem that several pages answer together, such as a
 * case study's problem in a person's words and the patterns it demonstrates:
 * no single page is "the" answer, so the case asks for enough of them.
 * `via` is for the same long descriptions: the search box scores each page's
 * declared facts only, where `find` reads the prose too, so a whole problem
 * reaches fewer pages there, and a case only `find` is expected to answer says so.
 *
 * The data file also holds `version`, `updated` and `note`. Every id a case
 * names must be a page; a misspelt id is a finding, not a case that can never
 * pass, and so is a `covers` whose `min` is more than its ids or its `n`. A
 * missed query is recorded here first: add the case, watch this gate go red,
 * then fix the ranking or the synonym table until it is green.
 *
 * Usage: check-search-oracle   (no arguments)
 */

import fs from 'node:fs';
import path from 'node:path';

import { main, type GateContext, type GateSpec } from '../lib/gate.js';
import { searchWithRetry } from '../lib/search-score.js';
import { searchTree, type PageMeta } from '../lib/search-tree.js';
import { parseArgs } from '../kb/args.js';
import { Session } from '../kb/cli.js';
import { Corpus } from '../kb/corpus.js';

export const SRC = 'docs/data/search-oracle.json';

/** How many first hits `kind` and `band` look at when a case gives no `n`. */
export const DEFAULT_N = 3;

/** How many hits each path is asked for: enough for any `n` or `within` a case names. */
const DEPTH = 50;

/** What a case's `covers` asks: at least `min` of `ids` among the first `n` hits. */
export interface OracleCovers {
  readonly ids: readonly string[];
  readonly n: number;
  readonly min: number;
}

/** The paths a case may be limited to: `cli` is kb.mjs `find`. */
export const VIAS = ['cli'] as const;

/** One case of the oracle. */
export interface OracleCase {
  readonly q: string;
  readonly top?: readonly string[];
  readonly kind?: string;
  readonly band?: string;
  readonly n?: number;
  readonly within?: Readonly<Record<string, number>>;
  readonly covers?: OracleCovers;
  readonly via?: (typeof VIAS)[number];
}

/** A hit as a path reports it: the page's id, kind and band. */
export type Hit = PageMeta;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
const KEYS = new Set(['q', 'top', 'kind', 'band', 'n', 'within', 'covers', 'via']);
const COVERS_KEYS = new Set(['ids', 'n', 'min']);

/** Every way a case's `covers` is wrong, one message each, in the order its keys are read; empty when it holds. */
function coversFindings(covers: unknown, name: string, known: ReadonlySet<string>): string[] {
  if (!isObject(covers)) return [`${name}: \`covers\` is not an object of ids, n and min`];
  const out = Object.keys(covers)
    .filter((k) => !COVERS_KEYS.has(k))
    .map((k) => `${name}: \`covers\` has an unknown key \`${k}\``);
  const list = covers['ids'];
  const distinct = new Set<string>();
  if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === 'string')) out.push(`${name}: \`covers.ids\` is not a list of ids`);
  else {
    for (const id of list as string[]) {
      if (distinct.has(id)) out.push(`${name}: \`covers.ids\` names "${id}" twice`);
      else if (!known.has(id)) out.push(`${name}: \`covers.ids\` names "${id}", which is no page`);
      distinct.add(id);
    }
  }
  const { n, min } = covers;
  if (!isCount(n)) out.push(`${name}: \`covers.n\` is not a whole number from 1`);
  if (!isCount(min)) out.push(`${name}: \`covers.min\` is not a whole number from 1`);
  else {
    if (distinct.size > 0 && min > distinct.size) out.push(`${name}: \`covers.min\` is ${String(min)}, more than its ${String(distinct.size)} ids`);
    if (isCount(n) && min > n) out.push(`${name}: \`covers.min\` is ${String(min)}, more than the ${String(n)} hits \`covers.n\` looks at`);
  }
  return out;
}

/** Every way the data file's shape is wrong, one message each, in file order; empty when it holds. */
export function shapeFindings(data: unknown, known: ReadonlySet<string>): string[] {
  if (!isObject(data)) return ['is not a JSON object'];
  const out: string[] = [];
  for (const key of ['version', 'updated', 'note']) if (data[key] === undefined) out.push(`lacks \`${key}\``);
  const cases = data['cases'];
  if (!Array.isArray(cases)) return [...out, '`cases` is missing or is not a list'];
  cases.forEach((c: unknown, i: number) => {
    const at = `case ${String(i + 1)}`;
    if (!isObject(c)) {
      out.push(`${at}: is not an object`);
      return;
    }
    const name = typeof c['q'] === 'string' ? `${at} "${c['q']}"` : at;
    if (typeof c['q'] !== 'string' || c['q'].trim() === '') out.push(`${name}: \`q\` is not a query`);
    for (const k of Object.keys(c)) if (!KEYS.has(k)) out.push(`${name}: unknown key \`${k}\``);
    const ids = (list: unknown, what: string): void => {
      if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === 'string')) out.push(`${name}: \`${what}\` is not a list of ids`);
      else for (const id of list as string[]) if (!known.has(id)) out.push(`${name}: \`${what}\` names "${id}", which is no page`);
    };
    if (c['top'] !== undefined) ids(c['top'], 'top');
    if (c['within'] !== undefined) {
      const within = c['within'];
      if (!isObject(within) || Object.keys(within).length === 0) out.push(`${name}: \`within\` is not an object of id → rank`);
      else {
        ids(Object.keys(within), 'within');
        for (const [id, n] of Object.entries(within)) if (!Number.isInteger(n) || (n as number) < 1) out.push(`${name}: \`within\` gives "${id}" the rank ${String(n)}, not a whole number from 1`);
      }
    }
    if (c['covers'] !== undefined) out.push(...coversFindings(c['covers'], name, known));
    for (const k of ['kind', 'band']) if (c[k] !== undefined && (typeof c[k] !== 'string' || c[k] === '')) out.push(`${name}: \`${k}\` is not a word`);
    if (c['n'] !== undefined && (!Number.isInteger(c['n']) || (c['n'] as number) < 1)) out.push(`${name}: \`n\` is not a whole number from 1`);
    if (c['n'] !== undefined && c['kind'] === undefined && c['band'] === undefined) out.push(`${name}: \`n\` means something only beside \`kind\` or \`band\``);
    if (c['via'] !== undefined && !(VIAS as readonly unknown[]).includes(c['via'])) out.push(`${name}: \`via\` is not one of ${VIAS.join(', ')}`);
    if (c['top'] === undefined && c['kind'] === undefined && c['band'] === undefined && c['within'] === undefined && c['covers'] === undefined) {
      out.push(`${name}: expects nothing — give \`top\`, \`kind\`, \`band\`, \`within\` or \`covers\``);
    }
  });
  return out;
}

const show = (hits: readonly Hit[], n: number): string => (hits.length === 0 ? 'nothing' : hits.slice(0, n).map((h) => h.id).join(', '));

/** What a path got that breaks a case, one line each, in the order the expectations are listed; empty when it holds. */
export function judge(c: OracleCase, hits: readonly Hit[]): string[] {
  const out: string[] = [];
  const n = c.n ?? DEFAULT_N;
  if (c.top !== undefined && !c.top.includes(hits[0]?.id ?? '')) out.push(`got ${show(hits, 1)}, wanted ${c.top.join(' or ')}`);
  for (const key of ['kind', 'band'] as const) {
    const want = c[key];
    if (want === undefined) continue;
    const first = hits.slice(0, n);
    const wrong = first.filter((h) => h[key] !== want);
    if (first.length < n) out.push(`got ${String(first.length)} hits (${show(hits, n)}), wanted ${String(n)} of ${key} ${want}`);
    else if (wrong.length > 0) out.push(`got ${first.map((h) => `${h.id} (${h[key]})`).join(', ')}, wanted the first ${String(n)} of ${key} ${want}`);
  }
  for (const [id, rank] of Object.entries(c.within ?? {})) {
    const at = hits.findIndex((h) => h.id === id) + 1;
    if (at === 0 || at > rank) out.push(`got ${id} ${at === 0 ? 'absent' : `at ${String(at)}`} (${show(hits, rank)}), wanted it within the first ${String(rank)}`);
  }
  if (c.covers !== undefined) {
    const { ids, n: window, min } = c.covers;
    const first = hits.slice(0, window).map((h) => h.id);
    const missing = ids.filter((id) => !first.includes(id));
    const found = ids.length - missing.length;
    if (found < min) out.push(`got ${String(found)} of ${String(ids.length)} in the first ${String(window)} (${show(hits, window)}), wanted ${String(min)}; missing ${missing.join(', ')}`);
  }
  return out;
}

export const spec: GateSpec = {
  name: 'search-oracle',
  usage: 'usage: check-search-oracle   (no arguments)',
  async run(ctx: GateContext): Promise<string> {
    const src = path.join(ctx.root, SRC);
    if (!fs.existsSync(src)) {
      ctx.fail(SRC, 'is missing — it lists the queries the search must answer (restore it from git)');
      return '';
    }
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(src, 'utf8'));
    } catch {
      ctx.fail(SRC, 'is not valid JSON');
      return '';
    }
    const tree = searchTree(ctx.root);
    const metaOf = new Map([...tree.meta.values()].map((m) => [m.id, m]));
    for (const what of shapeFindings(data, new Set(metaOf.keys()))) ctx.fail(SRC, what);
    if (ctx.findings > 0) return '';

    const cases = (data as { cases: OracleCase[] }).cases;
    const session = new Session(new Corpus(ctx.root), parseArgs([]));
    const nodes = session.candidates();
    for (const c of cases) {
      const cli = (await session.search(c.q, nodes, DEPTH)).map((s): Hit => ({ id: s.n.id, kind: s.n.kind, band: s.n.band }));
      const paths: (readonly [string, readonly Hit[]])[] = [['cli', cli]];
      if (c.via !== 'cli') {
        const site = searchWithRetry(c.q, tree.pages, { syn: tree.synonyms, tagLabels: tree.tagLabels }).hits.map((h) => tree.meta.get(h.page.route) as PageMeta);
        paths.unshift(['site', site]);
      }
      for (const [path_, hits] of paths) {
        for (const what of judge(c, hits)) ctx.fail(SRC, `${c.q} → ${what} (${path_})`);
      }
    }
    if (ctx.findings > 0) return '';
    const onSite = cases.filter((c) => c.via !== 'cli').length;
    if (onSite === cases.length) return `[search-oracle] ${String(cases.length)} queries hold on the site path and the kb.mjs path`;
    return `[search-oracle] ${String(cases.length)} queries hold on the kb.mjs path, ${String(onSite)} of them on the site path too`;
  },
};

main(spec, import.meta.url);
