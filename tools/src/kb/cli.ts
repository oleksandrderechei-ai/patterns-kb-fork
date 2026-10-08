/**
 * kb.mjs — the reader and writer over docs/, launched by scripts/kb.mjs
 * (tools/src/kb/spec.ts is its command surface): the argument rules and
 * output shapes the HTML-era reader set, read from the markdown and the data
 * files. tools/src/kb/relevance.test.ts holds `find` to its fixture.
 *
 * The writers are tools/src/kb/write.ts: frontmatter, blocks, suffixes and
 * the data files, each write worked out whole before a byte is written;
 * tools/src/kb/write.test.ts and write-tree.test.ts hold them in sandbox trees.
 * A page or data file a generator owns (a stamp, or a note that says
 * GENERATED) is refused.
 *
 * The exit code says which kind of failure it was, the same split as every
 * gate (tools/src/lib/gate.ts): 0 done, an empty result included; 1 a call
 * that is well formed and that the knowledge base refuses, so fix the content:
 * an unknown id or block, a check that found problems, a writer that refused
 * the content; 2 a call that is malformed, so fix the command: an unknown
 * command or flag, a flag with no value, a missing id, query or required flag,
 * a value of the wrong form. A failed call says why on stderr and writes
 * nothing to stdout, with or without `--json`. `validate` and `resolve` are
 * the answers that exit 1 and still print, since their findings are the answer.
 *
 * `record`, `graph` and `resolve` are the retrieval contract's commands
 * (tools/src/kb/record.ts): the first two print its two documents, `kb-record/1`
 * for a page and `kb-graph/1` for the whole base, as the bytes
 * `serialize` gives, and `resolve` checks citations of what they print.
 *
 * `run` is the whole program and writes only through `io`, so a test drives
 * it in-process; `main` is the process wrapper.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { serialize } from '../lib/kb-record.js';
import { relationGroups } from '../lib/render-relations.js';
import { readTagLabels } from '../lib/search-tree.js';

import { parseArgs, type Args } from './args.js';
import { Corpus, KbError, KbUsageError, rootFrom, type Page } from './corpus.js';
import { today } from './data.js';
import {
  clickTargets,
  explainItems,
  mdPlain,
  productionItems,
  proseLinks,
  wildItems,
  type PageDoc,
} from './page.js';
import { indexBody, loadSynonyms, proseLines, rank, type Body, type CatalogNode, type Scored } from './rank.js';
import { graphOf, recordOf, resolveLine, resolveRefs } from './record.js';
import { blockText } from './render.js';
import { quickFacts } from './scan.js';
import { CLI_COMMANDS, flagsOf, RETIRED, USAGE_HEADER, usageLine, usageText } from './spec.js';
import { findingText, validateFindings } from './validate.js';
import { WRITE } from './write.js';

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/**
 * A relation side as scripts/kb.mjs printed it. `verb` is the relation's id
 * and the name to read in every command's `--json`; `type` repeats it as a
 * deprecated alias, so a consumer that reads `type` keeps working.
 */
export interface Relation {
  readonly type: string;
  readonly verb: string;
  readonly to: string;
  readonly label: string;
  readonly note: string;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

/**
 * What one invocation reads: the corpus and the parsed flags.
 * Exported so the relevance fixture scores through exactly the path `find`
 * takes.
 */
export class Session {
  readonly corpus: Corpus;
  readonly args: Args;

  constructor(corpus: Corpus, args: Args) {
    this.corpus = corpus;
    this.args = args;
  }

  doc(slug: string): PageDoc {
    return this.corpus.doc(slug);
  }

  /** Every block of a page, as text. */
  blocks(page: Page): Record<string, string> {
    const doc = this.doc(page.slug);
    const out: Record<string, string> = {};
    for (const b of doc.blocks) {
      const text = blockText(doc, b, {
        diagrams: this.args.flag('diagrams'),
        slugOf: (url) => this.corpus.linkTarget(page.source, url)?.slug ?? null,
      });
      out[b.name] = text;
    }
    return out;
  }

  /** A page's relation sides in the order its relationships block renders them. */
  relations(slug: string): Relation[] {
    const { verbs, relOrder } = this.corpus.model;
    return this.corpus.cached(`relations:${slug}`, () =>
      relationGroups(slug, this.corpus.relations, verbs, relOrder).flatMap((g) =>
        // relationGroups has already refused a verb the content model does not label.
        g.sides.map((s) => ({ type: s.verb, verb: s.verb, to: s.to, label: (verbs[s.verb] as { label: string }).label, note: mdPlain(s.note) })),
      ),
    );
  }

  catalogNode(page: Page): CatalogNode {
    const m = this.corpus.meta(page.slug);
    const facts = quickFacts(this.corpus.text(page.slug));
    return {
      id: page.slug,
      name: m.title,
      kind: page.kind,
      band: page.band,
      essence: m.essence,
      path: page.path,
      ...(m.favourite ? { favourite: true as const } : {}),
      ...(m.aliases.length > 0 ? { aliases: m.aliases } : {}),
      ...(m.tags.length > 0 ? { tags: m.tags } : {}),
      ...(m.solves.length > 0 ? { solves: m.solves } : {}),
      ...(facts.hasExample ? { hasExample: true as const } : {}),
      ...(facts.hasExplain ? { hasExplain: true as const } : {}),
    };
  }

  /** The listing, filtered by --tag, --band, --kind. */
  candidates(): CatalogNode[] {
    const tag = this.args.opt('tag');
    const band = this.args.opt('band');
    const kind = this.args.opt('kind');
    return this.corpus.listing
      .map((p) => this.catalogNode(p))
      .filter((n) => (tag === null || (n.tags ?? []).includes(tag)) && (band === null || n.band === band) && (kind === null || n.kind === kind));
  }

  body(n: CatalogNode): Body {
    return this.corpus.cached(`body:${n.id}`, () =>
      indexBody(this.corpus.derived(n.id, 'lines', () => proseLines(this.doc(n.id)))),
    );
  }

  async search(q: string, nodes: readonly CatalogNode[], limit: number): Promise<Scored[]> {
    const syn = await this.corpus.cached('synonyms', () => loadSynonyms(this.corpus.root));
    const tagLabels = this.corpus.cached('tagLabels', () => readTagLabels(this.corpus.root));
    return rank({ nodes, q, syn, bodyOf: (n) => this.body(n), categoriesOf: (n) => this.corpus.need(n.id).categories, tagLabels, limit });
  }

  /** A page's prose mentions: the ones `backlinks` lists, which the corpus works out (tools/src/kb/corpus.ts). */
  mentions(page: Page): string[] {
    return this.corpus.mentions(page.slug);
  }
}

function printRelations(io: Io, rels: readonly Relation[]): void {
  const byType = new Map<string, Relation[]>();
  for (const r of rels) byType.set(r.label, [...(byType.get(r.label) ?? []), r]);
  for (const [label, list] of byType) {
    io.out(`${label}:`);
    for (const r of list) io.out(`  ${r.to}${r.note === '' ? '' : ` — ${r.note}`}`);
  }
}

function printMatches(io: Io, scored: readonly Scored[]): void {
  for (const { n, why } of scored) {
    io.out(`${n.id}  (${n.kind}/${n.band})  — ${n.essence}`);
    if (why !== null) io.out(`    ↳ ${why.length > 150 ? `${why.slice(0, 150)}…` : why}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdGet(s: Session, io: Io): number {
  const page = s.corpus.need(s.args.positional[1]);
  const meta = s.corpus.meta(page.slug);
  const blocks = s.blocks(page);
  const only = s.args.opt('block');
  // Own keys only: `--block constructor` names no block, whatever Object.prototype holds.
  if (only !== null && !Object.hasOwn(blocks, only)) {
    io.err(`no block "${only}" on ${page.slug}. has: ${Object.keys(blocks).join(', ')}`);
    return 1;
  }
  const picked = only !== null ? { [only]: blocks[only] as string } : blocks;
  const doc = s.doc(page.slug);
  const items = {
    ...('wild' in picked ? { wild: wildItems(doc) } : {}),
    ...('production' in picked ? { production: productionItems(doc) } : {}),
    ...('explain' in picked ? { explain: explainItems(doc) } : {}),
  };
  if (s.args.flag('json')) {
    // The route is the path under a leading slash, and the markdown is the same route with .md.
    const route = `/${page.path}`;
    io.out(
      json({
        id: page.slug,
        name: meta.title,
        kind: page.kind,
        band: page.band,
        group: page.group,
        essence: meta.essence,
        path: page.path,
        source: page.source,
        area: meta.area,
        status: meta.status,
        owner: meta.owner,
        tags: meta.tags,
        aliases: meta.aliases,
        solves: meta.solves,
        favourite: meta.favourite,
        route,
        markdown: route.replace(/\.html$/, '.md'),
        blocks: picked,
        ...(Object.keys(items).length > 0 ? { items } : {}),
        relations: s.relations(page.slug),
        themes: s.corpus.themesOf(page.slug),
      }),
    );
    return 0;
  }
  if (only === null) {
    io.out(`# ${meta.title}  [${page.slug}]`);
    io.out(`${page.kind} · ${page.band}${page.group !== page.band ? ` · ${page.group}` : ''}`);
    io.out(`essence: ${meta.essence}`);
    io.out(`path: ${page.path}`);
    io.out(`source: ${page.source}`);
  }
  for (const [name, text] of Object.entries(picked)) {
    io.out(`\n## ${name}\n`);
    io.out(text);
  }
  return 0;
}

function cmdRelated(s: Session, io: Io): number {
  const page = s.corpus.need(s.args.positional[1]);
  const rels = s.relations(page.slug);
  if (s.args.flag('json')) {
    io.out(json(rels));
    return 0;
  }
  io.out(`# ${s.corpus.meta(page.slug).title} — ${rels.length} relations\n`);
  printRelations(io, rels);
  const themes = s.corpus.themesOf(page.slug);
  if (themes.length > 0) {
    io.out('\nIn themes:');
    for (const t of themes) io.out(`  ${t.id} — ${t.role}`);
  }
  return 0;
}

/**
 * `--n`: how many matches to print, a whole number of 1 or more, or `fallback`
 * when the flag is absent. Anything else is a misuse: a limit that reads as no
 * limit would hide the typo.
 */
function limitOf(s: Session, fallback: number): number {
  const raw = s.args.opt('n');
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new KbUsageError(`--n takes a whole number of 1 or more, not "${raw}"`);
  return Number(raw);
}

async function cmdFind(s: Session, io: Io): Promise<number> {
  const q = s.args.positional.slice(1).join(' ').toLowerCase();
  const limit = limitOf(s, 8);
  const candidates = s.candidates();
  if (q === '') {
    if (s.args.opt('tag') === null && s.args.opt('band') === null && s.args.opt('kind') === null) {
      throw new KbUsageError(`usage: ${usageLine('find')}`);
    }
    listing(io, s, candidates);
    return 0;
  }
  const scored = await s.search(q, candidates, limit);
  if (s.args.flag('json')) io.out(json(scored.map((x) => ({ ...x.n, why: x.why }))));
  else if (scored.length === 0) io.out(`no match for "${q}"`);
  else {
    printMatches(io, scored);
    io.out(`\n${scored.length} match(es). Next: kb.mjs get <id> [--block usage]`);
  }
  return 0;
}

async function cmdBrief(s: Session, io: Io): Promise<number> {
  const q = s.args.positional.slice(1).join(' ').toLowerCase();
  const limit = limitOf(s, 5);
  if (q === '') throw new KbUsageError(`usage: ${usageLine('brief')}`);
  const scored = await s.search(q, s.candidates(), limit);
  // Text says so in one line. JSON keeps its shape with an empty match list, so a parser has no second case
  // to handle, and an explicit --theme is still resolved as it is for a hit.
  if (scored.length === 0 && !s.args.flag('json')) {
    io.out(`no match for "${q}"`);
    return 0;
  }
  let themeId = s.args.opt('theme');
  if (themeId !== null && s.corpus.page(themeId)?.kind !== 'theme') {
    io.err(`not a theme id: ${themeId}`);
    return 1;
  }
  if (themeId === null) {
    themeId = scored.find((x) => x.n.kind === 'theme')?.n.id ?? null;
    if (themeId === null) {
      const counts = new Map<string, number>();
      for (const { n } of scored) for (const t of s.corpus.themesOf(n.id)) counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
      themeId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
  }
  const decide = themeId === null ? null : (s.blocks(s.corpus.need(themeId))['decide'] ?? null);
  const related: Record<string, Relation[]> = {};
  for (const { n } of scored.slice(0, 3)) if (n.kind !== 'theme') related[n.id] = s.relations(n.id);

  if (s.args.flag('json')) {
    io.out(json({ query: q, matches: scored.map((x) => ({ ...x.n, why: x.why })), theme: themeId === null ? null : { id: themeId, decide }, related }));
    return 0;
  }
  io.out(`# brief: ${q}\n\n## matches\n`);
  printMatches(io, scored);
  if (themeId !== null) {
    io.out(`\n## theme: ${themeId} — decide\n`);
    io.out(decide ?? '(no decide block on this theme)');
  }
  for (const [id, rels] of Object.entries(related)) {
    io.out(`\n## related: ${id}\n`);
    printRelations(io, rels);
  }
  io.out('\nNext: kb.mjs get <id> --block usage|tradeoffs');
  return 0;
}

function listing(io: Io, s: Session, rows: readonly CatalogNode[]): void {
  if (s.args.flag('json')) {
    io.out(json(rows));
    return;
  }
  for (const n of rows) io.out(`${n.id.padEnd(28)} ${n.essence}`);
  io.out(`\n${rows.length} entries.`);
}

function cmdLs(s: Session, io: Io): number {
  const band = s.args.opt('band');
  const kind = s.args.opt('kind');
  listing(
    io,
    s,
    s.corpus.listing.filter((p) => (band === null || p.band === band) && (kind === null || p.kind === kind)).map((p) => s.catalogNode(p)),
  );
  return 0;
}

/**
 * `--file`: a markdown page under docs/. A page the structure file lists in
 * an area of no kind (the reference pages) is named as such: kb.mjs reads the
 * seven kinds only.
 */
function pageOfFile(s: Session, file: string): Page {
  const abs = path.resolve(file);
  const rel = path.relative(s.corpus.root, abs).split(path.sep).join('/');
  if (!fs.existsSync(abs)) throw new KbError(`no such file: ${file}`);
  if (!rel.startsWith('docs/')) throw new KbError(`not under docs/: ${file}`);
  const page = s.corpus.pages.find((p) => p.source === rel);
  if (page !== undefined) return page;
  const other = s.corpus.otherRows.find((r) => r.source === rel);
  if (other !== undefined) throw new KbError(`${rel}: the structure file lists it in area "${other.area}", which holds no knowledge-base kind — kb.mjs reads the seven kinds only`);
  throw new KbError(`${rel}: no row in docs/data/site-structure.json lists this page`);
}

function cmdValidate(s: Session, io: Io): number {
  const file = s.args.opt('file');
  const id = s.args.positional[1];
  const targets = file !== null ? [pageOfFile(s, file)] : id !== undefined ? [s.corpus.need(id)] : [...s.corpus.pages];
  const findings = validateFindings(s.corpus, targets, (p) => s.doc(p.slug));
  const problems = findings.map(findingText);
  if (s.args.flag('json')) io.out(json({ pages: targets.length, problems, findings }));
  else if (problems.length > 0) {
    io.err(`${problems.length} problem(s) across ${targets.length} page(s):`);
    for (const p of problems) io.err(`  ${p}`);
  } else io.out(`OK — ${targets.length} page(s) structurally valid.`);
  return problems.length > 0 ? 1 : 0;
}

function cmdBacklinks(s: Session, io: Io): number {
  const page = s.corpus.need(s.args.positional[1]);
  const inbound: { from: string; type: string; verb: string; label: string; note: string }[] = [];
  const mentionedBy: string[] = [];
  for (const other of s.corpus.listing) {
    if (other.slug === page.slug) continue;
    for (const r of s.relations(other.slug)) if (r.to === page.slug) inbound.push({ from: other.slug, type: r.type, verb: r.verb, label: r.label, note: r.note });
    if (s.mentions(other).includes(page.slug)) mentionedBy.push(other.slug);
  }
  const out = { id: page.slug, inbound, mentionedBy, mentions: s.mentions(page) };
  if (s.args.flag('json')) {
    io.out(json(out));
    return 0;
  }
  io.out(`# ${s.corpus.meta(page.slug).title} — ${inbound.length} inbound relation(s)\n`);
  for (const r of inbound) io.out(`  ${r.from}  [${r.verb}]${r.note === '' ? '' : ` — ${r.note}`}`);
  if (mentionedBy.length > 0) io.out(`\nMentioned in prose by: ${mentionedBy.join(', ')}`);
  if (out.mentions.length > 0) io.out(`Mentions in its own prose: ${out.mentions.join(', ')}`);
  return 0;
}

function cmdRefs(s: Session, io: Io): number {
  const file = s.args.opt('file');
  const page = file !== null ? pageOfFile(s, file) : s.corpus.need(s.args.positional[1]);
  const doc = s.doc(page.slug);
  const relations = s.relations(page.slug).map((r) => ({ rel: r.type, verb: r.verb, to: r.to }));
  const members = s.corpus.membersOf(page.slug).map((m) => ({ to: m.id, role: m.role }));
  const fluency = fluencyOf(s, page);
  const uniq = (urls: readonly string[]): string[] => {
    const out: string[] = [];
    for (const u of urls) {
      const t = s.corpus.linkTarget(page.source, u)?.slug;
      if (t !== undefined && t !== page.slug && !out.includes(t)) out.push(t);
    }
    return out;
  };
  const prose = uniq(proseLinks(doc));
  const clicks = uniq(clickTargets(doc));
  const typed = new Set([...relations.map((r) => r.to), ...members.map((m) => m.to), ...fluency]);
  const untyped = [...new Set([...prose, ...clicks])].filter((t) => !typed.has(t));
  if (s.args.flag('json')) {
    io.out(json({ id: page.slug, path: page.path, source: page.source, relations, members, fluency, proseLinks: prose, clicks, untyped }));
    return 0;
  }
  io.out(`# ${s.corpus.meta(page.slug).title}  [${page.slug}]\n`);
  const byVerb = new Map<string, string[]>();
  for (const r of relations) byVerb.set(r.verb, [...(byVerb.get(r.verb) ?? []), r.to]);
  io.out(`relations (${relations.length})`);
  for (const [verb, list] of byVerb) io.out(`  ${verb}: ${list.join(', ')}`);
  if (members.length > 0) io.out(`\ntheme members (${members.length})\n  ${members.map((m) => `${m.to}${m.role === '' ? '' : ` [${m.role}]`}`).join(', ')}`);
  if (fluency.length > 0) io.out(`\nfluency tie-ins (${fluency.length})\n  ${fluency.join(', ')}`);
  const section = (label: string, list: readonly string[]): void => io.out(`\n${label} (${list.length})${list.length > 0 ? `\n  ${list.join(', ')}` : ''}`);
  section('prose links', prose);
  section('mermaid clicks', clicks);
  section('untyped — linked in prose, no typed relation', untyped);
  return 0;
}

/** The themes a page's fluency block names, in its order (tools/src/lib/render-tours.ts). */
function fluencyOf(s: Session, page: Page): string[] {
  const touring = s.corpus.paths.profiles.filter((p) => p.stages.includes(page.route)).map((p) => p.id);
  const named = Object.keys(s.corpus.paths.notes[page.route] ?? {}).filter((t) => touring.includes(t));
  return [...named, ...touring.filter((t) => !named.includes(t))];
}

/**
 * The block names `--block` lists, comma-separated. An empty name, from a
 * trailing or a doubled comma, is a call made badly and not a block that is
 * missing.
 */
function blockNames(raw: string): string[] {
  const names = raw.split(',').map((n) => n.trim());
  if (names.includes('')) throw new KbUsageError(`--block takes block names separated by commas, not "${raw}"`);
  return names;
}

/**
 * A JSON document as the line `Io.out` takes: `serialize` ends its document
 * with the newline `Io.out` adds, so the bytes written are `serialize`'s.
 */
const document = (value: unknown): string => serialize(value).slice(0, -1);

function cmdRecord(s: Session, io: Io): number {
  const id = s.args.positional[1];
  const only = s.args.opt('block');
  if (s.args.flag('all')) {
    if (id !== undefined || only !== null) throw new KbUsageError(`--all takes no id and no --block. usage: ${usageLine('record')}`);
    // JSON Lines: one compact record to a line. All are built before the first
    // is printed, so a page the record cannot hold stops the call with nothing on stdout.
    const lines = s.corpus.listing.map((p) => JSON.stringify(recordOf(s.corpus, p.slug)));
    for (const line of lines) io.out(line);
    return 0;
  }
  if (id === undefined) throw new KbUsageError(`usage: ${usageLine('record')}`);
  io.out(document(recordOf(s.corpus, id, only === null ? {} : { blocks: blockNames(only) })));
  return 0;
}

function cmdGraph(s: Session, io: Io): number {
  io.out(document(graphOf(s.corpus)));
  return 0;
}

function cmdResolve(s: Session, io: Io): number {
  const refs = s.args.positional.slice(1);
  if (refs.length === 0) throw new KbUsageError(`usage: ${usageLine('resolve')}`);
  const results = resolveRefs(s.corpus, refs);
  if (s.args.flag('json')) io.out(document(results));
  else for (const r of results) io.out(resolveLine(r));
  return results.every((r) => r.status === 'ok') ? 0 : 1;
}

const READ: Readonly<Record<string, (s: Session, io: Io) => number | Promise<number>>> = {
  get: cmdGet,
  related: cmdRelated,
  find: cmdFind,
  brief: cmdBrief,
  ls: cmdLs,
  validate: cmdValidate,
  backlinks: cmdBacklinks,
  refs: cmdRefs,
  record: cmdRecord,
  graph: cmdGraph,
  resolve: cmdResolve,
};

/** What a run may be told beyond its arguments. */
export interface RunOptions {
  /** The day a writer dates a data file with (`updated`); today by default. */
  readonly today?: string;
}

/** A table's own entry for `key`: `constructor` and `toString` name no command. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * One run, up to the point it returns an exit code or throws. A KbError ends
 * the run at its message: a KbUsageError with exit 2, any other with exit 1.
 */
async function dispatch(argv: readonly string[], io: Io, root: string | Corpus, opts: RunOptions): Promise<number> {
  // Read once with no flags known, only to find the command, which says which flags there are.
  const first = parseArgs(argv);
  if (first.flag('level')) throw new KbUsageError('--level is gone: reading levels were retired, a page reads at one depth');
  const cmd = first.positional[0];
  if (cmd === undefined) {
    io.out(usageText(USAGE_HEADER));
    return 0;
  }
  const retired = own(RETIRED, cmd);
  if (retired !== undefined) throw new KbUsageError(retired);
  const reader = own(READ, cmd);
  const writer = own(WRITE, cmd);
  if (reader === undefined && writer === undefined) {
    throw new KbUsageError(`unknown command: ${cmd}. The commands are ${CLI_COMMANDS.map((c) => c.name).join(', ')}; kb.mjs with no command prints the usage`);
  }
  const session = new Session(typeof root === 'string' ? new Corpus(root) : root, parseArgs(argv, flagsOf(cmd)));
  if (writer !== undefined) return writer(session, io, { today: opts.today ?? today() });
  const code = await (reader as NonNullable<typeof reader>)(session, io);
  session.corpus.saveDerived();
  return code;
}

/**
 * The whole program: the exit code is 0 when done, 1 when a well-made call
 * failed or a check found problems, 2 when the call was made badly. What is
 * not a KbError is a crash and is thrown.
 */
export async function run(argv: readonly string[], io: Io, root: string | Corpus, opts: RunOptions = {}): Promise<number> {
  try {
    return await dispatch(argv, io, root, opts);
  } catch (e) {
    if (!(e instanceof KbError)) throw e;
    io.err(e.message);
    return e instanceof KbUsageError ? 2 : 1;
  }
}

/**
 * Stop writing quietly when the reader goes away (`kb.mjs ls | head`), as
 * console.log does for scripts/kb.mjs; any other stream error still throws.
 */
export function quietOnClose(stream: NodeJS.WritableStream): void {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e;
  });
}

/** Run as a program when this file is the entry point. */
export function main(moduleUrl: string, argv: readonly string[] = process.argv): void {
  const entry = argv[1];
  if (entry === undefined || pathToFileURL(path.resolve(entry)).href !== moduleUrl) return;
  quietOnClose(process.stdout);
  const io: Io = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };
  run(argv.slice(2), io, rootFrom(process.env)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`kb.mjs: ${String(err)}\n`);
      process.exitCode = 2;
    },
  );
}

main(import.meta.url);
