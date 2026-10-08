/**
 * Does kb.mjs v2's `find` retrieve the right page? scripts/test/search-relevance.test.mjs
 * carried over whole — the same ground truth (every page's own `solves`), the
 * same phrasings, the same GATES — scored through the path `find` takes over
 * docs/: the catalog from the frontmatter, the prose index from the markdown,
 * the synonyms scripts/kb.mjs reads.
 *
 * It asserts RATES, never per-query expectations, and every number is a
 * ratchet: raise it when retrieval improves, treat a fall as a regression.
 *
 * Two more sets follow the first. The second asks the opposite question: not
 * "does a pattern's own symptom reach the pattern" but "does a case study's own
 * problem reach the patterns it demonstrates", and holds the recall of `find`
 * and the reach of `brief` over it. The third holds `brief` to what it says it
 * is, `find`'s first hits plus the typed neighbours of the best of them.
 *
 *   KB_RELEVANCE=full     every solves phrase, not just the first
 *   KB_RELEVANCE=report   print the metric tables, every gated query the CLI
 *                         misses at top-1 and every pattern a case study's
 *                         problem fails to reach or never lists, and skip the
 *                         assertions
 */

import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { REAL_TREE_TIMEOUT } from '../lib/fixtures.js';
import { deriveElements } from '../lib/kb-attrs.js';
import { readTagLabels } from '../lib/search-tree.js';

import { parseArgs } from './args.js';
import { run, Session } from './cli.js';
import { Corpus, REPO } from './corpus.js';
import { loadSynonyms, rank, STOP, type CatalogNode, type Synonyms } from './rank.js';

const MODE = process.env['KB_RELEVANCE'] ?? '';
const FULL = MODE === 'full';
const REPORT = MODE === 'report';

/**
 * Each floor is the measurement rounded down to the half point below it, and
 * each ceiling the measurement rounded up. Measured 2026-10-02 over 418 pages, 367 with
 * `solves`. With rankItems' tie-break (fewer facts, then id) the CLI's verbatim
 * top-1 measures 99.2% (364 of 367), its MRR 0.994 and the facts-only top-1
 * 99.7% (732 of 734). The inflected top-1 measures 98.6% (362 of 367), above
 * its floor of 98.5%: the report names its misses, and raising it waits on
 * fixing them. Design steals measure 0.0% and designs in the top five 0.0%:
 * a case study that only brushes a symptom's words is scored down
 * (DESIGN_COVER in search-score.ts), and every case study is scored down
 * (CASE_STUDY_DAMP) when the best hit is not one, so it crowds out no pattern.
 *
 * The two design floors measure a different set of queries: each case study's
 * own problem, the text of its non-functional requirements and its `solves`
 * phrases, against the patterns its `demonstrates` edges name. Measured
 * 2026-10-08 over 41 case studies and 444 edges, the macro recall of `find` (the
 * first five hits of every query that are not case studies, held together) is
 * 0.4009, and the macro reach of `brief` (its matches, the edges it lists and
 * the tour of its theme, held together) is 0.8274. Each floor sits about two
 * points below its measurement: one hit lost in one case study moves the recall by
 * about 0.0025, so a floor at the measurement turns red on ordinary prose edits,
 * while a ranking regression costs several points and still fails.
 */
const GATES = {
  cliTop1: { verbatim: 0.99, inflected: 0.985 },
  cliTop3: 0.995,
  cliMrr: 0.99,
  hubTop1: 0.995,
  maxDesignStealsTop1: 0.005,
  maxDesignInTop5: 0.005,
  designRecall: 0.38,
  designBriefReach: 0.8,
} as const;

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean);
/** A query worth running: at least two words that say something, as a typed phrase has. */
const asksSomething = (q: string): boolean => q.split(' ').filter((w) => w.length > 2 && !STOP.has(w)).length >= 2;
const keywords = (list: string[]): string[] => list.filter((w) => w.length >= 5 && !STOP.has(w));
const inflect = (list: string[]): string[] => list.map((w) => (w.length <= 4 ? w : w.endsWith('s') ? w.slice(0, -1) : `${w}s`));
const PHRASINGS: Readonly<Record<string, (l: string[]) => string[]>> = {
  verbatim: (l) => l,
  keyword: keywords,
  inflected: inflect,
  'inflected-keyword': (l) => inflect(keywords(l)),
};
const GATED = ['verbatim', 'inflected'];
const RUNNING = FULL || REPORT ? Object.keys(PHRASINGS) : GATED;

interface Query {
  readonly id: string;
  readonly kind: string;
  readonly phrasing: string;
  readonly q: string;
}
interface Tally {
  n: number;
  top1: number;
  top3: number;
  rr: number;
  steals: number;
  designTop5: number;
  nonDesign: number;
}
const blank = (): Tally => ({ n: 0, top1: 0, top3: 0, rr: 0, steals: 0, designTop5: 0, nonDesign: 0 });

function buildQueries(nodes: readonly CatalogNode[]): Query[] {
  const out: Query[] = [];
  for (const n of nodes) {
    const solves = n.solves ?? [];
    for (const phrase of FULL ? solves : solves.slice(0, 1)) {
      for (const phrasing of RUNNING) {
        const q = (PHRASINGS[phrasing] as (l: string[]) => string[])(words(phrase)).join(' ');
        if (!asksSomething(q)) continue;
        out.push({ id: n.id, kind: n.kind, phrasing, q });
      }
    }
  }
  return out;
}

/** A gated query whose page is not the top hit: the phrasing, the query, the page it wanted and the one it got. */
type Miss = string;

async function measure(queries: readonly Query[], score: (q: string) => Promise<CatalogNode[]>): Promise<{ byPhrasing: Record<string, Tally>; all: Tally; misses: Miss[] }> {
  const byPhrasing: Record<string, Tally> = {};
  const all = blank();
  const misses: Miss[] = [];
  for (const { id, kind, phrasing, q } of queries) {
    const hits = await score(q);
    const rank1 = hits.findIndex((h) => h.id === id) + 1;
    const tally = (byPhrasing[phrasing] ??= blank());
    if (rank1 !== 1 && GATED.includes(phrasing)) misses.push(`${phrasing}: "${q}" wants ${id}, got ${String(hits[0]?.id)}`);
    for (const t of GATED.includes(phrasing) ? [tally, all] : [tally]) {
      t.n += 1;
      if (rank1 === 1) t.top1 += 1;
      if (rank1 >= 1 && rank1 <= 3) t.top3 += 1;
      if (rank1 >= 1) t.rr += 1 / rank1;
      if (kind !== 'design') {
        t.nonDesign += 1;
        if (hits[0]?.kind === 'design') t.steals += 1;
        if (hits.slice(0, 5).some((h) => h.kind === 'design')) t.designTop5 += 1;
      }
    }
  }
  return { byPhrasing, all, misses };
}

const rates = (t: Tally): { top1: number; top3: number; mrr: number; steals: number; designTop5: number } => ({
  top1: t.top1 / t.n,
  top3: t.top3 / t.n,
  mrr: t.rr / t.n,
  steals: t.steals / t.nonDesign,
  designTop5: t.designTop5 / t.nonDesign,
});
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// A case study's problem, against the patterns it demonstrates
// ---------------------------------------------------------------------------

/** How many hits that are not case studies one query is credited with. */
const TOP = 5;

/**
 * Hits asked of the ranking before case studies are dropped: enough to leave
 * `TOP` of another kind, and the depth past which a page counts as not listed at all.
 */
const DEPTH = 50;

/** What `brief --json` prints, as far as this file reads it. */
interface Brief {
  readonly matches: readonly { readonly id: string; readonly kind: string }[];
  readonly theme: { readonly id: string; readonly decide: string | null } | null;
  readonly related: Readonly<Record<string, readonly { readonly to: string }[]>>;
}

/** One case study: what its `demonstrates` edges name, and how much of that its own problem reaches. */
interface DesignRow {
  readonly id: string;
  readonly truth: readonly string[];
  readonly queries: number;
  /** The truth that the first `TOP` hits of any of its queries hold, case studies dropped. */
  readonly found: readonly string[];
  /** The truth that `brief` lays out for any of them: its matches, its related edges, the tour of its theme. */
  readonly reached: readonly string[];
  /** The truth that none of its queries lists among its first `DEPTH` hits: the problem cannot reach it through `find` at all. */
  readonly absent: readonly string[];
}

let corpus: Corpus;
let session: Session;

/** Run one kb.mjs command in this process and read the JSON it prints. */
async function runJson<T>(argv: readonly string[]): Promise<T> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, corpus);
  if (code !== 0) throw new Error(`kb.mjs ${argv.join(' ')} exited ${String(code)}: ${err.join(' ')}`);
  return JSON.parse(out.join('\n')) as T;
}

/**
 * design id → the pages its `demonstrates` edges name, each once, in the order
 * the file lists them. A record is one edge read from `a`'s side, so one
 * written from the pattern's side (`demonstrated-by`) names the same edge.
 */
function demonstrated(c: Corpus): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (design: string, target: string): void => {
    const list = out.get(design) ?? [];
    if (!list.includes(target)) out.set(design, [...list, target]);
  };
  for (const r of c.relations.relations) {
    if (r.verb === 'demonstrates') add(r.a, r.b);
    else if (r.verb === 'demonstrated-by') add(r.b, r.a);
  }
  return out;
}

/**
 * What a case study's problem says, as typed queries: the text of each
 * non-functional requirement and each `solves` phrase, cleaned as a typed
 * phrase is and held to the bar every other query here meets. The
 * requirements come off the parsed page, the items under its `nfr` group.
 */
function problemQueries(node: CatalogNode): string[] {
  const nfr = deriveElements(session.doc(node.id).tree)
    .filter((e) => e.kind === 'item' && e.requirement === 'nfr')
    .map((e) => e.text);
  return [...new Set([...nfr, ...(node.solves ?? [])].map((text) => words(text).join(' ')))].filter(asksSomething);
}

/**
 * Every page `brief` lays out, less what the case studies hand over: its
 * matches, the targets of the edges it lists for them, and the tour of the
 * theme it governs by. A case study among the matches would list its own
 * `demonstrates` edges, which is the answer itself, so its list is not read.
 */
function reachOf(b: Brief): string[] {
  const out = new Set<string>();
  for (const m of b.matches) out.add(m.id);
  for (const [id, rows] of Object.entries(b.related)) if (corpus.page(id)?.kind !== 'design') for (const r of rows) out.add(r.to);
  if (b.theme !== null) for (const m of corpus.membersOf(b.theme.id)) out.add(m.id);
  return [...out];
}

async function measureDesigns(): Promise<DesignRow[]> {
  const truth = demonstrated(corpus);
  const rows: DesignRow[] = [];
  for (const node of nodes.filter((n) => n.kind === 'design')) {
    const want = truth.get(node.id) ?? [];
    const found = new Set<string>();
    const reached = new Set<string>();
    const listed = new Set<string>();
    const asked = problemQueries(node);
    for (const q of asked) {
      const ranked = (await session.search(q, nodes, DEPTH)).map((x) => x.n);
      for (const n of ranked) listed.add(n.id);
      for (const h of ranked.filter((n) => n.kind !== 'design').slice(0, TOP)) found.add(h.id);
      for (const id of reachOf(await runJson<Brief>(['brief', q, '--json']))) reached.add(id);
    }
    rows.push({
      id: node.id,
      truth: want,
      queries: asked.length,
      found: want.filter((t) => found.has(t)),
      reached: want.filter((t) => reached.has(t)),
      absent: want.filter((t) => !listed.has(t)),
    });
  }
  return rows;
}

/** The mean over case studies of the share of their truth `pick` holds. */
const macro = (rows: readonly DesignRow[], pick: (d: DesignRow) => readonly string[]): number => rows.reduce((sum, d) => sum + pick(d).length / d.truth.length, 0) / rows.length;

let nodes: CatalogNode[];
let queries: Query[];
let cli: Awaited<ReturnType<typeof measure>>;
let hub: Awaited<ReturnType<typeof measure>>;
let designs: DesignRow[];

beforeAll(async () => {
  corpus = new Corpus(REPO);
  session = new Session(corpus, parseArgs([]));
  const syn: Synonyms = await loadSynonyms(REPO);
  nodes = session.candidates();
  queries = buildQueries(nodes);
  cli = await measure(queries, async (q) => (await session.search(q, nodes, 10)).map((x) => x.n));
  // No prose: the hub's algorithm, number for number.
  const tagLabels = readTagLabels(REPO);
  hub = await measure(queries, async (q) => rank({ nodes, q, syn, tagLabels, categoriesOf: (n) => corpus.page(n.id)?.categories ?? [], limit: 10 }).map((x) => x.n));
  designs = await measureDesigns();
}, REAL_TREE_TIMEOUT);

it.runIf(REPORT)('prints the metric table', () => {
  const line = (label: string, t: Tally): void => {
    const r = rates(t);
    console.log(`${label.padEnd(22)} n=${String(t.n).padStart(5)}  top1=${pct(r.top1)}  top3=${pct(r.top3)}  mrr=${r.mrr.toFixed(3)}  steals=${pct(r.steals)}  d@5=${pct(r.designTop5)}`);
  };
  for (const [p, t] of Object.entries(cli.byPhrasing)) line(`CLI ${p}`, t);
  line('CLI all', cli.all);
  for (const [p, t] of Object.entries(hub.byPhrasing)) line(`HUB ${p}`, t);
  line('HUB all', hub.all);
  // The watch item: the inflected gate has no margin, so name every query it misses.
  for (const m of cli.misses) console.log(`CLI miss  ${m}`);
});

describe.skipIf(REPORT)('the relevance fixture, through kb.mjs v2', () => {
  it('covers the corpus it claims to', () => {
    const withSolves = nodes.filter((n) => (n.solves ?? []).length > 0).length;
    expect(withSolves).toBeGreaterThan(300);
    expect(queries.length).toBeGreaterThan(withSolves * 1.5);
  });

  it('retrieves the page its own symptom text describes', () => {
    for (const [phrasing, bar] of Object.entries(GATES.cliTop1)) {
      expect(rates(cli.byPhrasing[phrasing] as Tally).top1, `CLI top-1 (${phrasing})`).toBeGreaterThanOrEqual(bar);
    }
    expect(rates(cli.all).top3, 'CLI top-3').toBeGreaterThanOrEqual(GATES.cliTop3);
    expect(rates(cli.all).mrr, 'CLI MRR').toBeGreaterThanOrEqual(GATES.cliMrr);
  });

  it('retrieves it reading no prose at all, as the hub does', () => {
    expect(rates(hub.all).top1, 'HUB top-1').toBeGreaterThanOrEqual(GATES.hubTop1);
  });

  it('keeps case studies from crowding out the pattern that answers the question', () => {
    expect(rates(cli.all).steals, 'design steals top-1').toBeLessThanOrEqual(GATES.maxDesignStealsTop1);
    expect(rates(cli.all).designTop5, 'design in top-5').toBeLessThanOrEqual(GATES.maxDesignInTop5);
  });
});

it.runIf(REPORT)('prints the design-recall table', () => {
  const share = (d: DesignRow, held: readonly string[]): string => `${String(held.length).padStart(2)}/${String(d.truth.length).padEnd(2)} ${pct(held.length / d.truth.length).padStart(6)}`;
  for (const d of designs) console.log(`${d.id.padEnd(27)} queries=${String(d.queries).padStart(2)}  find ${share(d, d.found)}  brief ${share(d, d.reached)}`);
  console.log(`DESIGN ${String(designs.length)} case studies  macro recall=${macro(designs, (d) => d.found).toFixed(4)}  brief reach=${macro(designs, (d) => d.reached).toFixed(4)}`);
  // Every pattern a case study's own problem fails to put in front of the reader, and those it never lists at all.
  for (const d of designs) {
    const lost = d.truth.filter((t) => !d.found.includes(t));
    const unreached = d.truth.filter((t) => !d.reached.includes(t));
    if (lost.length > 0) console.log(`DESIGN miss  ${d.id} find: ${lost.join(', ')}`);
    if (unreached.length > 0) console.log(`DESIGN miss  ${d.id} brief: ${unreached.join(', ')}`);
    if (d.absent.length > 0) console.log(`DESIGN gap   ${d.id} not in the first ${String(DEPTH)} hits of any query: ${d.absent.join(', ')}`);
  }
});

describe.skipIf(REPORT)("a case study's problem retrieves the patterns it demonstrates", () => {
  it('covers the case studies and edges it claims to', () => {
    expect(designs.length).toBeGreaterThanOrEqual(40);
    expect(designs.reduce((sum, d) => sum + d.queries, 0)).toBeGreaterThan(300);
    for (const d of designs) {
      expect(d.truth.length, `${d.id} demonstrates nothing`).toBeGreaterThan(0);
      for (const t of d.truth) {
        expect(corpus.page(t), `${d.id} demonstrates ${t}, which is no page`).toBeDefined();
        expect(corpus.page(t)?.kind, `${d.id} demonstrates ${t}, which is a case study`).not.toBe('design');
      }
    }
  });

  it('finds the patterns a case study demonstrates among the first five hits of its own problem', () => {
    expect(macro(designs, (d) => d.found), 'macro recall of find').toBeGreaterThanOrEqual(GATES.designRecall);
  });

  it('puts them in front of the reader through brief: its matches, its related edges, the tour of its theme', () => {
    expect(macro(designs, (d) => d.reached), 'macro reach of brief').toBeGreaterThanOrEqual(GATES.designBriefReach);
  });
});

describe.skipIf(REPORT)('brief, through kb.mjs v2, on the real tree', () => {
  /** Every query of the oracle and the first symptom of twenty pages spread over the catalog, each with the bundle brief makes of it. */
  let briefs: { readonly q: string; readonly brief: Brief }[];

  beforeAll(async () => {
    const oracle = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/data/search-oracle.json'), 'utf8')) as { cases: { q: string }[] };
    const withSolves = nodes.filter((n) => (n.solves ?? []).length > 0);
    const stride = Math.floor(withSolves.length / 20);
    const symptoms = withSolves.filter((_, i) => i % stride === 0).slice(0, 20).map((n) => (n.solves as string[])[0] as string);
    briefs = [];
    for (const q of [...oracle.cases.map((c) => c.q), ...symptoms]) briefs.push({ q, brief: await runJson<Brief>(['brief', q, '--json']) });
  }, REAL_TREE_TIMEOUT);

  it('is run over every oracle query and twenty symptoms', () => {
    expect(briefs.length).toBeGreaterThanOrEqual(60);
    for (const { q, brief } of briefs) expect(brief.matches.length, q).toBeGreaterThan(0);
  });

  it('lists the first five hits of find, row for row, under the same filters', async () => {
    for (const { q, brief } of briefs) expect(brief.matches, q).toEqual(await runJson(['find', q, '--json', '--n', '5']));
    let compared = 0;
    for (const { q } of briefs.slice(0, 12)) {
      const found = await runJson<unknown[]>(['find', q, '--json', '--n', '5', '--kind', 'pattern']);
      // With nothing to list, brief says so in a sentence, not in JSON.
      if (found.length === 0) continue;
      expect((await runJson<Brief>(['brief', q, '--json', '--kind', 'pattern'])).matches, `${q} (--kind pattern)`).toEqual(found);
      compared += 1;
    }
    expect(compared).toBeGreaterThanOrEqual(8);
  });

  it('lists the typed neighbours of each of its first three matches that is not a theme, and of no other page', () => {
    // A theme among the three is skipped, not replaced by the fourth match: its decide table stands in for it.
    for (const { q, brief } of briefs) {
      expect(Object.keys(brief.related), q).toEqual(brief.matches.slice(0, 3).filter((m) => m.kind !== 'theme').map((m) => m.id));
    }
  });

  it('names only pages in the edges it lists', () => {
    for (const { q, brief } of briefs) {
      for (const [id, rows] of Object.entries(brief.related)) {
        expect(corpus.page(id), `${q}: ${id}`).toBeDefined();
        for (const r of rows) expect(corpus.page(r.to), `${q}: ${id} → ${r.to}`).toBeDefined();
      }
    }
  });

  it("governs by a theme page and carries that page's decide block, or none", async () => {
    let decided = 0;
    for (const { q, brief } of briefs) {
      if (brief.theme === null) continue;
      expect(corpus.page(brief.theme.id)?.kind, `${q}: ${brief.theme.id}`).toBe('theme');
      const theme = await runJson<{ blocks: Record<string, string> }>(['get', brief.theme.id, '--json']);
      expect(brief.theme.decide, q).toBe(theme.blocks['decide'] ?? null);
      if (brief.theme.decide !== null) decided += 1;
    }
    expect(decided).toBeGreaterThan(0);
  });
});
