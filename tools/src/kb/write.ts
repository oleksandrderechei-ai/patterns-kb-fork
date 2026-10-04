/**
 * kb.mjs v2's writers: the write half of scripts/kb.mjs's surface
 * (tools/src/kb/spec.ts), each writing the markdown source and the data files
 * instead of the HTML.
 *
 *   set           the page's frontmatter (aliases, tags, solves, favourite,
 *                 description as --essence)
 *   link, unlink  docs/data/relations.json, then both pages' relationships
 *                 blocks re-rendered from it (tools/src/lib/render-relations.ts)
 *   wild, production, explain
 *                 that block's markdown, replaced whole, put in or taken out
 *   new           a scaffold from the content model, and its row in
 *                 docs/data/site-structure.json (a theme's profile too)
 *
 * Every write is worked out whole before anything is written: the files it
 * changes are collected, each changed page is parsed again and refused if the
 * write would leave a problem it did not have, and only then is each file
 * replaced (a temp file and a rename, as every generator writes).
 *
 * A page carrying a generator's whole-file stamp, and a data file whose note
 * says it is generated, belong to their generator: a writer refuses both.
 */

import fs from 'node:fs';
import path from 'node:path';

import { frontmatter, printFrontmatter } from '../lib/frontmatter.js';
import { markers, splice } from '../lib/generated.js';
import { mapRows } from '../lib/map-rows.js';
import { COSTS_KIND, explainProblems, wordCount } from '../lib/explain-shape.js';
import { ID_PATTERN, parseKb, printFacts } from '../lib/kb-attrs.js';
import { groupOrderToRecord, labelOf, relationGroups, renderRelations, sidesOf, type PageRef, type RelationRecord, type RelationsFile } from '../lib/render-relations.js';
import { renderTour, type LearningPaths } from '../lib/render-tours.js';

import { explainLines, productionLines, wildLines, type CostInput, type GateInput, type LabelledInput, type ProductionGroup, type WildInput } from './blocks.js';
import { DATA, KbError, readJsonFile, type Kind, type Page } from './corpus.js';
import { dataBytes, readData } from './data.js';
import { blockSpans, eolOf, fmShapeProblem, putBlock, refuseStamped, rewriteFrontmatter, splitFrontmatter, type FmChange } from './edit.js';
import { collapse, inlineMd, plainTokens } from './inline.js';
import { explainItems, parsePage } from './page.js';
import { quickFacts } from './scan.js';
import { scaffoldText } from './scaffold.js';
import { tagListProblems, tagRules } from './tags.js';
import { descriptionLengthProblem } from './validate.js';

import type { Io, Session } from './cli.js';

/** What a writer needs beyond the session: the day it writes on. */
export interface WriteOptions {
  readonly today: string;
}

// ---------------------------------------------------------------------------
// A write, worked out whole, then committed
// ---------------------------------------------------------------------------

/** The files one command changes: repo-relative path → new bytes, in the order they were put. */
export class Change {
  readonly root: string;
  readonly files = new Map<string, string>();

  constructor(root: string) {
    this.root = root;
  }

  put(rel: string, text: string): void {
    this.files.set(rel, text);
  }

  /**
   * Refuse a page this change would leave with a problem it did not have,
   * then write every file that differs from the disk, all or none: each new
   * text goes to a temp file beside its target first, and only when every
   * one is written are they renamed into place. A failure before the renames
   * leaves the tree as it was; one during them puts back what was replaced.
   * Returns how many files changed.
   */
  commit(): number {
    const writes: { abs: string; text: string; old: string | null; tmp: string }[] = [];
    for (const [rel, text] of this.files) {
      const abs = path.join(this.root, rel);
      const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      if (old === text) continue;
      if (rel.endsWith('.md')) {
        const had = new Set(old === null ? [] : parsePage(old).problems.map((p) => p.message));
        const fresh = parsePage(text).problems.find((p) => !had.has(p.message));
        if (fresh !== undefined) throw new KbError(`${rel}: the write would leave a problem on the page — ${fresh.message}`);
      }
      writes.push({ abs, text, old, tmp: `${abs}.tmp.${process.pid}` });
    }
    const made: string[] = [];
    try {
      for (const w of writes) {
        const dir = path.dirname(w.abs);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          made.push(dir);
        }
        fs.writeFileSync(w.tmp, w.text);
      }
    } catch (e) {
      // No debris: a stray temp file beside a page reads as a page.
      for (const w of writes) fs.rmSync(w.tmp, { force: true });
      for (const dir of made.reverse()) fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    const done: (typeof writes)[number][] = [];
    try {
      for (const w of writes) {
        fs.renameSync(w.tmp, w.abs);
        done.push(w);
      }
    } catch (e) {
      for (const w of writes) fs.rmSync(w.tmp, { force: true });
      for (const w of done) {
        if (w.old === null) fs.rmSync(w.abs, { force: true });
        else fs.writeFileSync(w.abs, w.old);
      }
      throw e;
    }
    return writes.length;
  }
}

/** A page's text for an edit, refused when a generator owns it. */
function pageText(s: Session, page: Page): string {
  const text = s.corpus.text(page.slug);
  refuseStamped(page.source, text);
  return text;
}

/** The kind a page is, from the content model. */
function kindOf(s: Session, page: Page): Kind {
  // readPages keeps only pages whose folder names a kind of the model.
  return s.corpus.model.kinds.find((k) => k.id === page.kind) as Kind;
}

/** Every page as the block renderers name it, by slug and by route; `extra` joins them. */
function pageRefs(s: Session, extra: readonly PageRef[] = []): { bySlug: Map<string, PageRef>; byRoute: Map<string, PageRef> } {
  const refs = [...s.corpus.pages.map((p) => ({ slug: p.slug, route: p.route, source: p.source, title: s.corpus.meta(p.slug).title })), ...extra];
  return { bySlug: new Map(refs.map((r) => [r.slug, r])), byRoute: new Map(refs.map((r) => [r.route, r])) };
}

/** The value seen most often, the first seen on a tie; null for none. */
function mostCommon(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  for (const [v, n] of counts) if (best === null || n > (counts.get(best) as number)) best = v;
  return best;
}

/**
 * The heading most pages of `kind` give a block (or, with `value`, a group of
 * it), the first seen on a tie; else the one most pages of any kind give it;
 * else its name, title-cased.
 */
export function commonHeading(s: Session, kind: string, block: string, value?: string): string {
  const headings = (pages: readonly Page[]): string[] =>
    pages.flatMap((p) =>
      quickFacts(s.corpus.text(p.slug))
        .headings.filter((h) => h.block === block)
        .flatMap((h) => (value === undefined ? [h.heading] : h.groups.filter((g) => g.value === value).map((g) => g.heading))),
    );
  const name = value ?? block;
  return mostCommon(headings(s.corpus.pages.filter((p) => p.kind === kind))) ?? mostCommon(headings(s.corpus.pages)) ?? `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** The page's own heading for a block (and group), else the corpus's. */
function headingFor(s: Session, page: Page, text: string, block: string, value?: string): string {
  const own = quickFacts(text).headings.filter((h) => h.block === block).pop();
  const mine = value === undefined ? own?.heading : own?.groups.find((g) => g.value === value)?.heading;
  return mine ?? commonHeading(s, page.kind, block, value);
}

// ---------------------------------------------------------------------------
// Argument helpers, in scripts/kb.mjs's words
// ---------------------------------------------------------------------------

/** A flag's JSON, validated, or null when the flag is absent. */
function jsonFlag<T>(s: Session, name: string, check: (v: unknown) => string | null): T | null {
  const raw = s.args.opt(name);
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new KbError(`--${name} is not valid JSON: ${(e as Error).message}`);
  }
  const err = check(v);
  if (err !== null) throw new KbError(`--${name}: ${err}`);
  return v as T;
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

const strings = (v: unknown): string | null =>
  !Array.isArray(v)
    ? 'must be a JSON array'
    : v.some((x) => typeof x !== 'string')
      ? 'every item must be a string'
      : (v as string[]).some((x) => x.trim() === '')
        ? 'no empty strings'
        : null;

/** Reading levels are retired: an item carrying a `level` key is refused, so a dump from before the retirement cannot slip one back in. */
const levels = (v: readonly unknown[]): string | null =>
  v.some((x) => isObj(x) && x['level'] !== undefined) ? '`level` is retired: a page reads at one depth; delete the key' : null;

const text = (x: unknown): boolean => typeof x === 'string' && x.trim() !== '';

/**
 * Tags a writer may put on a page: every one a term of docs/data/tags.json,
 * 2-5 of them, and the list the tags gate accepts (tools/src/kb/tags.ts).
 */
function checkTags(s: Session, tags: readonly string[], more: string): void {
  const rules = tagRules(readJsonFile(s.corpus.root, DATA.tags)['terms']);
  const terms = [...rules.terms.keys()];
  const unknown = tags.filter((t) => !rules.terms.has(t));
  if (unknown.length > 0) {
    throw new KbError(`--tags: not in the closed vocabulary: ${unknown.join(', ')}\n  legal tags: ${terms.join(' ')}${more}`);
  }
  if (tags.length < 2 || tags.length > 5) throw new KbError(`--tags: ${tags.length} given; a page needs 2-5 (one tag groups nothing, six filter nothing)`);
  const problems = tagListProblems(tags, rules);
  if (problems.length > 0) throw new KbError(`--tags: ${problems.join('; ')}`);
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

function cmdSet(s: Session, io: Io): number {
  const page = s.corpus.need(s.args.positional[1]);
  const source = pageText(s, page);
  const changes = new Map<string, FmChange>();
  const touched: string[] = [];
  for (const key of ['aliases', 'tags', 'solves'] as const) {
    const v = jsonFlag<string[]>(s, key, strings);
    if (v === null) continue;
    if (key === 'tags') checkTags(s, v, '\n  add one to docs/data/tags.json only if it will apply to 3+ pages');
    changes.set(key, v.length > 0 ? v : null);
    touched.push(`${key}=${v.length}`);
  }
  const fav = s.args.opt('favourite');
  if (fav !== null) {
    if (fav !== 'true' && fav !== 'false') throw new KbError('--favourite: must be true or false');
    changes.set('favourite', fav === 'true' ? true : null);
    touched.push(`favourite=${fav}`);
  }
  const essence = s.args.opt('essence');
  if (essence !== null) {
    if (essence.trim() === '') throw new KbError('--essence: cannot be empty');
    if (/[\n\r\t]/.test(essence.trim())) throw new KbError('--essence: one line, with no tab');
    const long = descriptionLengthProblem(essence.trim());
    if (long !== null) throw new KbError(`--essence: ${long}`);
    changes.set('description', essence.trim());
    touched.push('essence');
  }
  if (touched.length === 0) throw new KbError('nothing to set — pass --aliases / --tags / --solves / --favourite / --essence');
  const { fm, body } = splitFrontmatter(source);
  if (fm === '') throw new KbError(`${page.source} has no frontmatter to set`);
  const odd = fmShapeProblem(fm);
  if (odd !== null) throw new KbError(`${page.source}: the frontmatter holds a line that is not one \`key: value\` ("${odd}") — kb.mjs writes only the dialect's one-line keys`);
  const raw = frontmatter(s.corpus.root, page.source, { raw: true });
  const out = rewriteFrontmatter(raw, changes, eolOf(fm)) + body;
  const change = new Change(s.corpus.root);
  change.put(page.source, out);
  const wrote = change.commit();
  io.out(`${page.slug}: ${touched.join(' ')}${wrote === 0 ? ' (unchanged)' : ''}`);
  return 0;
}

// ---------------------------------------------------------------------------
// link, unlink
// ---------------------------------------------------------------------------

/** A page's text with its relationships block rendered from `file` (the block put in when it lacks one). */
function withRelations(s: Session, page: Page, text: string, file: RelationsFile, refs: ReadonlyMap<string, PageRef>): string {
  const { verbs, relOrder } = s.corpus.model;
  let lines: string[];
  try {
    lines = renderRelations(page.slug, file, { verbs, relOrder, pages: refs });
  } catch (e) {
    throw new KbError(`${page.slug}: ${(e as Error).message}`);
  }
  const spliced = splice(text, [{ name: 'relationships', lines }]);
  if ('text' in spliced) return spliced.text;
  const [open, close] = markers('relationships');
  if (spliced.missing.length === 1) throw new KbError(`${page.source}: the relationships block has one of its markers but not ${spliced.missing[0] as string} — mend it by hand first`);
  const region = [open, '', ...lines, '', close];
  const { fm, body } = splitFrontmatter(text);
  const at = blockSpans(body).filter((b) => b.name === 'relationships').pop();
  if (at !== undefined) {
    const rest = body.slice(at.end);
    return `${fm}${body.slice(0, at.end).replace(/\n*$/, '')}\n\n${region.join('\n')}\n${rest === '' ? '' : '\n'}${rest}`;
  }
  const kind = kindOf(s, page);
  const heading = headingFor(s, page, text, 'relationships');
  return fm + putBlock(body, 'relationships', [`## ${heading}`, printFacts({ block: 'relationships' }), '', ...region], kind.blocks);
}

/**
 * What to run after an edge changes: `make gen` rebuilds what is generated
 * from relations.json (the prerequisite graph), then `make validate` checks
 * the tree.
 */
const REBUILD = 'Now run: make gen && make validate';

/** The records that join two pages, whichever way round. */
function between(file: RelationsFile, a: string, b: string): RelationRecord[] {
  return file.relations.filter((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
}

function cmdLink(s: Session, io: Io, opts: WriteOptions): number {
  const [, fromId, verb, toId] = s.args.positional;
  const { verbs } = s.corpus.model;
  if (fromId === undefined || verb === undefined || toId === undefined || verbs[verb] === undefined) {
    throw new KbError(`usage: kb.mjs link <from> <verb> <to> [--note "…"] [--note-back "…"] [--group "…"] [--group-back "…"] [--maps <row-id>]\nverbs: ${Object.keys(verbs).join(', ')}`);
  }
  const from = s.corpus.need(fromId);
  const to = s.corpus.need(toId);
  if (from.slug === to.slug) throw new KbError('a page cannot relate to itself');
  const fromText = pageText(s, from);
  const toText = pageText(s, to);
  const data = readData<RelationsFile>(s.corpus.root, DATA.relations);
  const existing = between(data.value, from.slug, to.slug)[0];
  if (existing !== undefined) {
    const said = sidesOf(from.slug, { ...data.value, relations: [existing] }, verbs)[0]?.verb as string;
    throw new KbError(`${from.slug} already relates to ${to.slug} via "${said}" — edit that edge instead of adding a second one`);
  }
  const inverse = verbs[verb]?.symmetric === true ? verb : (verbs[verb]?.inverse as string);
  const note = inlineMd(plainTokens(s.args.opt('note') ?? ''), true);
  const noteBack = s.args.opt('note-back') === null ? note : inlineMd(plainTokens(s.args.opt('note-back') as string), true);
  const group = (flag: string, sideVerb: string): { group?: string } => {
    const g = s.args.opt(flag);
    if (g === null) return {};
    if (collapse(g) === '') throw new KbError(`--${flag}: cannot be empty`);
    return collapse(g) === verbs[sideVerb]?.label ? {} : { group: collapse(g) };
  };
  const fromSide = { note, ...group('group', verb) };
  const toSide = { note: noteBack, ...group('group-back', inverse) };
  // One spelling per edge: the pair's first verb in the content model, and a
  // symmetric verb read from the page first in site-path order.
  const order = Object.keys(verbs);
  const forward = verbs[verb]?.symmetric === true ? from.route < to.route : order.indexOf(verb) <= order.indexOf(inverse);
  const [a, b, v, sa, sb] = forward ? [from, to, verb, fromSide, toSide] : [to, from, inverse, toSide, fromSide];
  // A pin names a row of the implementing page's mapping or matrix table, and carries its label.
  const maps = s.args.opt('maps');
  let pin: { maps_a?: string; maps_label_a?: string } = {};
  if (maps !== null) {
    if (v !== 'implements') throw new KbError(`--maps: only an implements edge pins a table row, and this edge reads "${v}"`);
    const rows = mapRows(a.slug === from.slug ? fromText : toText);
    const label = rows.get(maps);
    if (label === undefined) {
      throw new KbError(`--maps: ${a.slug} has no row "${maps}" in its mapping or matrix table${rows.size === 0 ? '' : ` (rows: ${[...rows].map(([id, l]) => `${id} ${l}`).join('; ')})`}`);
    }
    pin = { maps_a: maps, maps_label_a: label };
  }
  const record: RelationRecord = {
    a: a.slug,
    verb: v,
    b: b.slug,
    note_a: sa.note,
    note_b: sb.note,
    ...(sa.group === undefined ? {} : { group_a: sa.group }),
    ...(sb.group === undefined ? {} : { group_b: sb.group }),
    ...pin,
  };
  const next: RelationsFile = { ...data.value, relations: [...data.value.relations, record] };
  const change = new Change(s.corpus.root);
  const { bySlug } = pageRefs(s);
  change.put(DATA.relations, dataBytes(data, next, opts.today));
  change.put(from.source, withRelations(s, from, fromText, next, bySlug));
  change.put(to.source, withRelations(s, to, toText, next, bySlug));
  change.commit();
  io.out(`${from.slug} —[${verb}]→ ${to.slug} written to ${DATA.relations}, and both pages' relationships blocks rendered from it. ${REBUILD}`);
  return 0;
}

function cmdUnlink(s: Session, io: Io, opts: WriteOptions): number {
  const [, aId, bId] = s.args.positional;
  if (aId === undefined || bId === undefined) throw new KbError('usage: kb.mjs unlink <a> <b>');
  const a = s.corpus.need(aId);
  const b = s.corpus.need(bId);
  if (a.slug === b.slug) throw new KbError('a page cannot relate to itself');
  const aText = pageText(s, a);
  const bText = pageText(s, b);
  const data = readData<RelationsFile>(s.corpus.root, DATA.relations);
  const gone = between(data.value, a.slug, b.slug);
  if (gone.length === 0) {
    io.err(`${a.slug}: no relation to ${b.slug}`);
    io.err(`${b.slug}: no relation to ${a.slug}`);
    return 1;
  }
  const { verbs, relOrder } = s.corpus.model;
  const kept: RelationsFile = { ...data.value, relations: data.value.relations.filter((r) => !gone.includes(r)) };
  // A pinned group order may pin only groups the page still has.
  const pins = { ...(kept.group_order ?? {}) };
  for (const p of [a, b]) {
    const pinned = pins[p.slug];
    if (pinned === undefined) continue;
    const labels = relationGroups(p.slug, kept, verbs, relOrder).map((g) => g.label);
    if (pinned.every((l) => labels.includes(l))) continue;
    const record = groupOrderToRecord(labels, relOrder);
    if (record === null) delete pins[p.slug];
    else pins[p.slug] = record;
  }
  const next: RelationsFile = { ...kept, group_order: pins };
  if (Object.keys(pins).length === 0) delete (next as { group_order?: unknown }).group_order;
  const change = new Change(s.corpus.root);
  const { bySlug } = pageRefs(s);
  change.put(DATA.relations, dataBytes(data, next, opts.today));
  change.put(a.source, withRelations(s, a, aText, next, bySlug));
  change.put(b.source, withRelations(s, b, bText, next, bySlug));
  change.commit();
  for (const [page, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const left = new Set(sidesOf(page.slug, next, verbs).map((x) => labelOf(x, verbs)));
    for (const side of sidesOf(page.slug, { ...data.value, relations: gone }, verbs)) {
      const lone = !left.has(labelOf(side, verbs));
      io.out(`${page.slug}: removed ${side.verb} → ${other.slug}${lone ? ' (with its now-empty group)' : ''}`);
    }
  }
  io.out(REBUILD);
  return 0;
}

// ---------------------------------------------------------------------------
// wild, production, explain
// ---------------------------------------------------------------------------

/** The page with block `name` set to `lines`, or taken out; refused on a kind without that block. */
function putPageBlock(s: Session, page: Page, text: string, name: string, lines: readonly string[] | null): string {
  const kind = kindOf(s, page);
  if (!kind.blocks.includes(name)) throw new KbError(`${page.slug}: a ${kind.id} page carries no ${name} block`);
  const { fm, body } = splitFrontmatter(text);
  return fm + putBlock(body, name, lines, kind.blocks);
}

function commitPage(s: Session, page: Page, text: string): number {
  const change = new Change(s.corpus.root);
  change.put(page.source, text);
  return change.commit();
}

function cmdWild(s: Session, io: Io): number {
  const page = s.corpus.need(s.args.positional[1]);
  const items = jsonFlag<WildInput[]>(s, 'items', (v) =>
    !Array.isArray(v)
      ? 'must be a JSON array'
      : v.some((x) => !isObj(x))
        ? 'every item must be an object'
        : (v as Record<string, unknown>[]).some((x) => !text(x['id']) || !text(x['name']) || !text(x['note']))
          ? 'every item needs id, name and note'
          : (v as Record<string, unknown>[]).some((x) => !ID_PATTERN.test(x['id'] as string))
            ? 'every id is lower-case letters, digits and hyphens (it becomes #wild-<id>)'
            : (v as Record<string, unknown>[]).some((x) => x['href'] !== undefined && (typeof x['href'] !== 'string' || !/^[^\s<>]+$/.test(x['href'])))
              ? 'an href is one URL, with no space or angle bracket'
              : levels(v),
  );
  if (items === null) throw new KbError('pass --items \'[{"id":…,"name":…,"note":…}]\' — kb.mjs get <id> --block wild --json dumps the current ones');
  const source = pageText(s, page);
  if (items.length === 0) {
    commitPage(s, page, putPageBlock(s, page, source, 'wild', null));
    io.out(`${page.slug}: wild removed`);
    return 0;
  }
  commitPage(s, page, putPageBlock(s, page, source, 'wild', wildLines(headingFor(s, page, source, 'wild'), items)));
  io.out(`${page.slug}: wild = ${items.length} example(s)`);
  return 0;
}

const PRODUCTION: readonly (readonly [key: 'knobs' | 'signals' | 'failures' | 'checklist', polarity: ProductionGroup['polarity']])[] = [
  ['knobs', 'knob'],
  ['signals', 'signal'],
  ['failures', 'failure'],
  ['checklist', 'check'],
];

function cmdProduction(s: Session, io: Io): number {
  const page = s.corpus.need(s.args.positional[1]);
  const labelled = (v: unknown): string | null =>
    !Array.isArray(v)
      ? 'must be a JSON array'
      : v.some((x) => !isObj(x))
        ? 'every item must be an object'
        : (v as Record<string, unknown>[]).some((x) => !text(x['label']) || !text(x['note']))
          ? 'every item needs label and note'
          : levels(v);
  // A checklist gate is bare text or an object with its text.
  const gates = (v: unknown): string | null =>
    !Array.isArray(v)
      ? 'must be a JSON array'
      : v.some((x) => (typeof x === 'string' ? x.trim() === '' : !isObj(x) || !text(x['text'])))
        ? 'every item must be a non-empty string, or an object with text'
        : levels(v);
  if (PRODUCTION.every(([key]) => s.args.opt(key) === null)) {
    throw new KbError('pass --knobs / --signals / --failures (\'[{"label":…,"note":…}]\') and/or --checklist (\'["…"]\') — kb.mjs get <id> --block production --json dumps the current ones');
  }
  const lists = PRODUCTION.map(([key]) =>
    key === 'checklist'
      ? (jsonFlag<(string | GateInput)[]>(s, key, gates) ?? []).map((x) => (typeof x === 'string' ? { text: x } : x))
      : (jsonFlag<LabelledInput[]>(s, key, labelled) ?? []),
  );
  const source = pageText(s, page);
  const total = lists.reduce((n, l) => n + l.length, 0);
  if (total === 0) {
    commitPage(s, page, putPageBlock(s, page, source, 'production', null));
    io.out(`${page.slug}: production removed`);
    return 0;
  }
  const groups: ProductionGroup[] = PRODUCTION.map(([, polarity], i) => ({
    polarity,
    heading: headingFor(s, page, source, 'production', polarity),
    items: lists[i] as readonly (LabelledInput | GateInput)[],
  }));
  commitPage(s, page, putPageBlock(s, page, source, 'production', productionLines(headingFor(s, page, source, 'production'), groups)));
  io.out(`${page.slug}: production = ${PRODUCTION.map(([key], i) => `${key}:${(lists[i] as unknown[]).length}`).join(' ')}`);
  return 0;
}

const costsCheck = (v: unknown): string | null =>
  !Array.isArray(v) ? 'must be a JSON array' : v.some((x) => !isObj(x) || !text(x['lead']) || !text(x['note'])) ? 'every item needs a lead and a note' : null;

/**
 * The explain block: `--text` and `--example`, both empty to remove the block.
 * `--costs '[{"lead":"…","note":"…"}]'` writes the costs list between them;
 * left out it keeps the page's own, and `[]` drops it.
 * With `--example-lang` the example is a fenced sketch in that language and
 * `--example-caption` names the question it answers. A shape KB-014 rejects
 * is refused before anything is written.
 */
function cmdExplain(s: Session, io: Io): number {
  const page = s.corpus.need(s.args.positional[1]);
  const text = s.args.opt('text');
  const example = s.args.opt('example');
  const lang = s.args.opt('example-lang');
  const caption = s.args.opt('example-caption');
  if (text === null || example === null) throw new KbError('pass --text "…" and --example "…" (both empty to remove)');
  const source = pageText(s, page);
  const given = jsonFlag<CostInput[]>(s, 'costs', costsCheck);
  if (text.trim() === '' && example.trim() === '') {
    commitPage(s, page, putPageBlock(s, page, source, 'explain', null));
    io.out(`${page.slug}: explain removed`);
    return 0;
  }
  if (lang === null && caption !== null) throw new KbError('--example-caption goes with --example-lang: a caption names a sketch');
  if (lang !== null && (caption === null || caption.trim() === '')) throw new KbError('--example-lang needs --example-caption "…": a sketch example names the question it answers');
  const body = collapse(text);
  // A sketch keeps its newlines; a prose example is one paragraph.
  const sample = lang === null ? collapse(example) : example;
  // `--costs` absent keeps the page's own list, so rewriting the paragraph never drops it; `[]` removes it.
  const costs = given ?? explainItems(parsePage(source))?.costs ?? [];
  const lines = explainLines(headingFor(s, page, source, 'explain'), {
    text: body,
    costs,
    example: sample,
    ...(lang === null ? {} : { exampleLang: lang, exampleCaption: collapse(caption as string) }),
  });
  const parsed = parseKb(lines.join('\n'));
  const problems = [...parsed.problems.map((p) => p.message), ...explainProblems(parsed.tree.children.slice(1), { costsRequired: page.kind === COSTS_KIND }).map((p) => p.message)];
  if (problems.length > 0) throw new KbError(`${page.slug}: the explain block breaks KB-014:\n  - ${problems.join('\n  - ')}`);
  commitPage(s, page, putPageBlock(s, page, source, 'explain', lines));
  io.out(`${page.slug}: explain = ${wordCount(body)}w, ${costs.length} cost(s), then ${lang === null ? `an example of ${wordCount(sample)}w` : `a ${lang} sketch of ${sample.split('\n').length} lines`}`);
  return 0;
}

// ---------------------------------------------------------------------------
// new
// ---------------------------------------------------------------------------

interface StructArea {
  readonly id: string;
  readonly label: string;
  readonly nestUnder?: string;
  readonly hub?: Readonly<Record<string, unknown>>;
  pages: { slug: string; label: string; source: string; route: string }[];
}

interface Structure {
  readonly version: number;
  readonly updated: string;
  readonly note: string;
  readonly areas: StructArea[];
}

/** Where a new page of `kind` goes: its leaf area and its folder under docs/. */
export function placeNew(areas: readonly StructArea[], kind: Kind, band: string | null, group: string | null): { area: StructArea; folder: string } {
  const byId = new Map(areas.map((a) => [a.id, a]));
  const chain = (id: string): string[] => {
    const out: string[] = [];
    for (let cur: string | undefined = id; cur !== undefined && !out.includes(cur); cur = byId.get(cur)?.nestUnder) out.push(cur);
    return out;
  };
  const leaf = (id: string): boolean => !areas.some((a) => a.nestUnder === id);
  const holdsKind = (a: StructArea): boolean => a.pages.some((p) => p.source.split('/')[1] === kind.folder);
  const top = kind.id === 'pattern' ? (band as string) : kind.folder;
  if (kind.id === 'pattern' && byId.get(top)?.nestUnder !== 'patterns') throw new KbError(`unknown band: ${top}`);
  const allowed = areas.filter((a) => leaf(a.id) && (chain(a.id).includes(top) || (kind.id !== 'pattern' && holdsKind(a)))).map((a) => a.id);
  const id = group ?? top;
  if (group === null && !leaf(top)) throw new KbError(`--group: ${top} is split into areas — name one of ${allowed.join(', ')}`);
  if (!allowed.includes(id)) throw new KbError(`--group: ${id} is not an area a ${kind.id} page can sit in — one of ${allowed.join(', ')}`);
  const area = byId.get(id) as StructArea;
  const sibling = area.pages.find((p) => p.source.split('/')[1] === kind.folder);
  if (sibling !== undefined) return { area, folder: path.posix.dirname(sibling.source) };
  if (kind.id !== 'pattern') return { area, folder: `docs/${kind.folder}` };
  // docs/patterns/<band>[/<group without its band prefix>], as the folders are laid out.
  const below = chain(id).reverse().slice(1);
  const parts = below.map((a, i) => (i > 0 && a.startsWith(`${below[i - 1] as string}-`) ? a.slice((below[i - 1] as string).length + 1) : a));
  return { area, folder: ['docs/patterns', ...parts].join('/') };
}

/** The owner most pages in `area` name, else most pages at all. */
function ownerFor(s: Session, area: string): string {
  const owners = (pages: readonly Page[]): string[] => pages.map((p) => s.corpus.frontmatter(p.slug)['owner']).filter((o): o is string => typeof o === 'string' && o !== '');
  return mostCommon(owners(s.corpus.pages.filter((p) => p.area === area))) ?? mostCommon(owners(s.corpus.pages)) ?? 'TODO';
}

/** `profiles` with the new theme's profile after the nearest earlier theme's, else before the next one's. */
export function withProfile(lp: LearningPaths, structureOrder: readonly string[], id: string, profile: LearningPaths['profiles'][number]): LearningPaths {
  const at = structureOrder.indexOf(id);
  const ids = lp.profiles.map((p) => p.id);
  const prev = structureOrder.slice(0, at).reverse().find((x) => ids.includes(x));
  const next = structureOrder.slice(at + 1).find((x) => ids.includes(x));
  const index = prev !== undefined ? ids.indexOf(prev) + 1 : next !== undefined ? ids.indexOf(next) : ids.length;
  return { ...lp, profiles: [...lp.profiles.slice(0, index), profile, ...lp.profiles.slice(index)] };
}

function cmdNew(s: Session, io: Io, opts: WriteOptions): number {
  const id = s.args.positional[1];
  const kindId = s.args.opt('kind');
  const band = s.args.opt('band');
  const name = s.args.opt('name');
  if (id === undefined || kindId === null || name === null || name.trim() === '' || (kindId === 'pattern' && band === null)) {
    throw new KbError(
      'usage: kb.mjs new <id> --kind pattern|hazard|theme|principle|design|capability|comparison --band <b> [--group <g>] --name "…" [--order <n>] [--tags \'["a","b"]\']\n  (--band is required only for --kind pattern; --group names the area when the band or kind is split into several; --order is the place in that area, 1 first, the end when left out)',
    );
  }
  if (!ID_PATTERN.test(id)) throw new KbError(`"${id}" is not a page id — lower-case letters, digits and hyphens`);
  const tags = jsonFlag<string[]>(s, 'tags', (v) => (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || t.trim() === '') ? 'must be a JSON array of non-empty strings' : null));
  if (tags !== null) checkTags(s, tags, '');
  const rawOrder = s.args.opt('order');
  if (rawOrder !== null && !/^[1-9]\d*$/.test(rawOrder)) throw new KbError('--order: a place in the area, 1 or more');
  const kind = s.corpus.model.kinds.find((k) => k.id === kindId);
  if (kind === undefined) throw new KbError(`unknown kind: ${kindId} (one of ${s.corpus.model.kinds.map((k) => k.id).join(', ')})`);
  const structure = readData<Structure>(s.corpus.root, DATA.structure);
  const { area, folder } = placeNew(structure.value.areas, kind, band, s.args.opt('group'));
  const source = `${folder}/${id}.md`;
  if (s.corpus.page(id) !== undefined || structure.value.areas.some((a) => a.pages.some((p) => p.slug === id)) || fs.existsSync(path.join(s.corpus.root, source))) {
    throw new KbError(`already exists: ${s.corpus.page(id)?.source ?? source}`);
  }
  const title = collapse(name);
  const route = `/${source.slice('docs/'.length).replace(/\.md$/, '.html')}`;
  const row = { slug: id, label: title, source, route };
  const at = rawOrder === null ? area.pages.length : Math.min(Number(rawOrder) - 1, area.pages.length);
  const areas = structure.value.areas.map((a) => (a.id === area.id ? { ...a, pages: [...a.pages.slice(0, at), row, ...a.pages.slice(at)] } : a));
  const change = new Change(s.corpus.root);
  change.put(DATA.structure, dataBytes(structure, { ...structure.value, areas }, opts.today));

  const self: PageRef = { slug: id, route, source, title };
  const { bySlug, byRoute } = pageRefs(s, [self]);
  let lp: LearningPaths | null = null;
  if (kind.id === 'theme') {
    const paths = readData<LearningPaths>(s.corpus.root, DATA.paths);
    const order = areas.flatMap((a) => a.pages).filter((p) => p.source.split('/')[1] === kind.folder).map((p) => p.slug);
    lp = withProfile(paths.value, order, id, { id, label: title, stages: [] });
    change.put(DATA.paths, dataBytes(paths, lp, opts.today));
  }
  const relations = s.corpus.relations;
  const fm = printFrontmatter([
    ['title', title],
    ['description', 'TODO — the terse one-liner'],
    ['area', area.id],
    ['owner', ownerFor(s, area.id)],
    ['tags', tags ?? []],
    ['status', 'draft'],
  ]);
  const groups = s.corpus.model.groups;
  change.put(
    source,
    scaffoldText({
      frontmatter: fm,
      title,
      blocks: kind.blocks.filter((b) => !kind.optional.includes(b)),
      heading: (block) => commonHeading(s, kind.id, block),
      groups,
      groupHeading: (block, value) => commonHeading(s, kind.id, block, value),
      sketchLang: s.corpus.model.sketchLangs[0] as string,
      costs: kind.id === COSTS_KIND,
      generated: (block) =>
        block === 'relationships'
          ? renderRelations(id, relations, { verbs: s.corpus.model.verbs, relOrder: s.corpus.model.relOrder, pages: bySlug })
          : renderTour(id, lp as LearningPaths, { pages: byRoute }),
    }),
  );
  change.commit();
  io.out(`${source} written, with its row in ${DATA.structure}${kind.id === 'theme' ? ` and its profile in ${DATA.paths}` : ''}. Next:`);
  io.out('  1. replace the TODOs (description, prose, diagram, sketch)');
  io.out(`  2. node scripts/kb.mjs set ${id} --essence "…" --aliases … ${tags === null ? '--tags … ' : ''}--solves …`);
  io.out(`  3. node scripts/kb.mjs link ${id} <verb> <other-id> --note "…"`);
  io.out('  4. make validate');
  return 0;
}

/** The writers, by command. */
export const WRITE: Readonly<Record<string, (s: Session, io: Io, opts: WriteOptions) => number>> = {
  set: cmdSet,
  link: cmdLink,
  unlink: cmdUnlink,
  wild: cmdWild,
  production: cmdProduction,
  explain: cmdExplain,
  new: cmdNew,
};

