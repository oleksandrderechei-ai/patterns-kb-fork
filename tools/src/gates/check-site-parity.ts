/**
 * The built site, its page records and its markdown say the same thing (spec
 * kb.pagedata.two-layers; the retrieval contract, docs/concepts/retrieval-contract.md).
 *
 * A page of the knowledge base reaches a reader three ways: as HTML, as the
 * record `<route>.json` beside it and as the markdown `<route>.md`. The record
 * is the page as typed data, and this gate holds the other two, and the files
 * that list pages, to it. The portability gate holds each record byte for byte
 * to what `kb.mjs record` prints, so a disagreement found here is one of the
 * readers of the page seeing something else, never a stale copy. Over every page
 * `site/dist/index.json` lists with a record, never a sample:
 *
 *   html     the page read by the layer rule (tools/src/site/page-record-read.ts)
 *            against the record: the article's route, area, tags, kind, band
 *            and group; the blocks, in the record's order; the words of the
 *            intro; every id on both sides and no other, each with the same
 *            element, block, group and words, in the same order; the relations
 *            the items of the relationships block state, in order; the
 *            prerequisite card's two lists.
 *            An id on a heading the record gave none is Starlight's slug for a
 *            link to it, and an `<a id>` is a reference page's own anchor:
 *            neither is a node of the record, so neither is a finding.
 *   md       the `.md` sibling, read as `kb.mjs` reads it (`parsePage`,
 *            `deriveElements`), against the record's elements and its intro:
 *            the same ids in the same order with the same words, and the
 *            record's `source.sha256` is the hash of that file. A reader holding
 *            only the markdown addresses the elements a record reader does.
 *   index    each entry of index.json says what the record says of the page:
 *            the head facts the post-build pass copied, the place, and the
 *            addresses of the record and of the markdown.
 *   graph    graph.json against the records: every edge is a row of the record
 *            of each page it joins, as written from `a` and as read from `b`,
 *            with the same note, heading and pinned row, and no row lacks its
 *            edge; every page is a node with the place and title its record
 *            gives; every tour and every mention is what the records list.
 *
 * Whether the record is right is not asked: the schema gate and the
 * portability gate hold it to the repo. What is asked is that nothing a reader
 * takes from a page says something else. PROJECTIONS states which surfaces
 * carry each key of a record, COMPARED what this gate reads on each, and a test
 * holds the two to each other and to the published schema.
 *
 * A finding names its file and what differs with both readings (`— html "…"
 * record "…"`), and spells a no-break space `\u00a0`, which looks like a space
 * and is not one. A page shows five findings and then how many more there are,
 * as do index.json and graph.json. A record, `graph.json` or `index.json` that
 * breaks its published schema is one finding and is not read further: the schema
 * gate says how. With a record unread, graph.json is not compared either, since
 * it would be held to a set of records that lacks a page.
 *
 * A tree with no content model holds no knowledge base, and no page has a record
 * to compare: the gate says so and passes, as check 8 of the portability gate
 * does. A tree that has one and a built site that lists no record is a finding.
 *
 * Usage: check-site-parity   (takes no arguments; reads site/dist and the published schemas)
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { contractSchemas, SCHEMA_BASES, SCHEMA_DIR, schemaUrl } from '../contract/contract.js';
import { DATA } from '../kb/corpus.js';
import { parsePage } from '../kb/page.js';
import type { GraphNode, PageGraph, PageRecord, RelationRow } from '../kb/record.js';
import { main, type GateContext, type GateSpec } from '../lib/gate.js';
import { formatFinding, type SchemaSet } from '../lib/json-schema.js';
import { deriveElements, plainText } from '../lib/kb-attrs.js';
import { flatten, type BodyNode, type Content, type FlatElement } from '../lib/kb-record.js';
import { readPageRecord, type ArticleFacts, type PageRecordRead, type ReadElement } from '../site/page-record-read.js';
import { DIST } from '../site/site-output.js';
import { recordAddress } from '../site/site-records.js';

// ---------------------------------------------------------------------------
// What each surface carries
// ---------------------------------------------------------------------------

/** A file that states what the record states, besides the record itself. */
export type Surface = 'html' | 'md' | 'index' | 'graph';

/** Which surfaces carry one top-level key of a record, and what this gate holds equal across them. */
export interface Projection {
  /** The surfaces that state it again, or `'record-only'` when none does. */
  readonly on: readonly Surface[] | 'record-only';
  /** What is compared on each surface; for a key only the record states, why no other file does. */
  readonly note: string;
}

/**
 * Every top-level key of kb-record-1.json, and where else the page says it. A
 * key the schema gains is a test failure until it is classified here, so that
 * a fact the record carries is never one no other surface can be held to
 * without somebody having said so.
 */
export const PROJECTIONS: Readonly<Record<string, Projection>> = {
  $schema: { on: 'record-only', note: 'names the schema the record is held to; the site publishes that schema beside the record' },
  contract: { on: 'record-only', note: "the record's own version tag" },
  scope: { on: 'record-only', note: 'null on every record the site serves; only `kb.mjs record --block` sets it' },
  id: { on: ['index', 'graph'], note: 'the entry and the node name the page by it; the record and the markdown share its file name' },
  title: { on: ['index', 'graph'], note: "the entry's title, copied from the head, and the node's title equal the record's" },
  description: { on: ['index'], note: "the entry's description, copied from the head, equals the record's" },
  kind: { on: ['html', 'index', 'graph'], note: "the article's data-kind, the entry and the node equal the record's" },
  band: { on: ['html', 'index', 'graph'], note: "the article's data-band, the entry and the node equal the record's" },
  group: { on: ['html', 'index', 'graph'], note: "the article's data-group, the entry and the node equal the record's" },
  area: { on: ['html', 'index'], note: "the article's data-area and the entry equal the record's" },
  areaChain: { on: 'record-only', note: 'built from the structure file; the page shows it as breadcrumbs, which are skip-marked paint' },
  status: { on: ['index'], note: "the entry's status, copied from the head, equals the record's" },
  owner: { on: ['index'], note: "the entry's owner, copied from the head, equals the record's" },
  tags: { on: ['html', 'index'], note: "the article's data-tags, joined by commas, and the entry equal the record's" },
  aliases: { on: ['index'], note: "the entry's aliases, copied from the head, equal the record's" },
  solves: { on: ['index'], note: "the entry's solves, copied from the head, equal the record's" },
  favourite: { on: 'record-only', note: 'a frontmatter flag the page shows as the state of a classed button, which is paint; the index does not list it' },
  route: { on: ['html', 'index', 'graph'], note: "the article's data-page, the entry and the node equal the record's" },
  markdown: { on: ['index'], note: "the entry's markdown address equals the record's" },
  source: { on: ['md'], note: "source.sha256 is the hash of the page's .md sibling" },
  intro: { on: ['html', 'md'], note: 'each paragraph above the first block shows the same words in the page and in the markdown' },
  blocks: {
    on: ['html', 'md'],
    note: "the blocks in the record's order in the page; each id with its element, block, group and words in the page, and its words in the markdown; diagram source, code and the markdown of each node stay in the record and the markdown",
  },
  relations: { on: ['html', 'graph'], note: "the verb and target each relationship item states, in order, and each edge of graph.json as a row of both its pages' records" },
  themes: { on: ['graph'], note: 'the tours of graph.json that list the page, in order, with the part it plays' },
  tour: { on: ['graph'], note: 'the tour of graph.json the page owns, stop by stop' },
  prerequisites: { on: ['html'], note: "the card's data-requires and data-related, as lists" },
  links: { on: 'record-only', note: 'only the record resolves the markdown links to page ids; the link gate holds the built links themselves' },
  mentions: { on: ['graph'], note: 'the mentions of graph.json that start at the page, in order' },
  anchors: { on: ['html', 'md'], note: 'the ids of the record are the ids of the page and of the markdown, and no others' },
};

/** The article facts held to the record: the fact's name, the record key it states, and the record's reading of it. */
const FACTS: readonly (readonly [keyof ArticleFacts, string, (r: PageRecord) => string])[] = [
  ['page', 'route', (r) => r.route],
  ['area', 'area', (r) => r.area],
  ['tags', 'tags', (r) => r.tags.join(',')],
  ['kind', 'kind', (r) => r.kind],
  ['band', 'band', (r) => r.band],
  ['group', 'group', (r) => r.group],
];

/** The keys of an index entry that say what the record says, and the record's reading of each. */
const INDEX_FIELDS: readonly (readonly [string, (r: PageRecord) => unknown])[] = [
  ['route', (r) => r.route],
  ['title', (r) => r.title],
  ['description', (r) => r.description],
  ['area', (r) => r.area],
  ['owner', (r) => r.owner],
  ['status', (r) => r.status],
  ['tags', (r) => r.tags],
  ['aliases', (r) => r.aliases],
  ['solves', (r) => r.solves],
  ['id', (r) => r.id],
  ['kind', (r) => r.kind],
  ['band', (r) => r.band],
  ['group', (r) => r.group],
  ['markdown', (r) => r.markdown],
];

/** The keys of a graph node that say what the record says, and the record's reading of each. */
const NODE_FIELDS: readonly (readonly [keyof GraphNode, (r: PageRecord) => string])[] = [
  ['kind', (r) => r.kind],
  ['band', (r) => r.band],
  ['group', (r) => r.group],
  ['title', (r) => r.title],
  ['route', (r) => r.route],
  ['record', (r) => recordAddress(r.route)],
];

/**
 * The keys of a record this gate reads on each surface, which PROJECTIONS must
 * agree with. A fact the index and the graph name the same way a record does is
 * listed by the record's key; an address (`record`) is derived from the route
 * and is no key of the record.
 */
export const COMPARED: Readonly<Record<Surface, readonly string[]>> = {
  html: [...FACTS.map(([, key]) => key), 'intro', 'blocks', 'anchors', 'relations', 'prerequisites'],
  md: ['source', 'intro', 'blocks', 'anchors'],
  index: INDEX_FIELDS.map(([key]) => key),
  graph: ['id', ...NODE_FIELDS.map(([key]) => key).filter((key) => key !== 'record'), 'relations', 'themes', 'tour', 'mentions'],
};

/** How many findings a page, or one of the two files that list pages, shows before it counts the rest. */
export const SHOWN = 5;

// ---------------------------------------------------------------------------
// Saying what differs
// ---------------------------------------------------------------------------

/** U+00A0, written by its code so that no editor can turn it into a plain space. */
const NBSP = String.fromCodePoint(0xa0);

/** A reading as a finding shows it: quoted, a no-break space spelled out, or `none` when the file does not say it. */
const quote = (reading: string | undefined): string => (reading === undefined ? 'none' : `"${reading.replaceAll(NBSP, '\\u00a0')}"`);

/** What one surface says, named: `html "…"`. */
type Reading = readonly [surface: string, said: string | undefined];

/** One finding: what differs, then the two readings. */
const differs = (what: string, a: Reading, b: Reading): string => `${what} — ${a[0]} ${quote(a[1])} ${b[0]} ${quote(b[1])}`;

/** How much of two long texts a finding shows, and how much of it comes before the first difference. */
const WINDOW = 80;
const LEAD = 24;

/** Two texts cut to the stretch that holds their first difference, with `…` where they were cut. */
function windows(a: string, b: string): [string, string] {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  const from = Math.max(0, at - LEAD);
  const cut = (s: string): string => `${from > 0 ? '…' : ''}${s.slice(from, from + WINDOW)}${s.length > from + WINDOW ? '…' : ''}`;
  return [cut(a), cut(b)];
}

/** Two lists of words compared position by position: one finding for each place they differ. */
function sequence(what: string, a: string, got: readonly string[], b: string, want: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(got.length, want.length); i += 1) {
    const g = got[i];
    const w = want[i];
    if (g === w) continue;
    const [shownG, shownW] = windows(g ?? '', w ?? '');
    out.push(differs(`${what} ${i + 1} differs`, [a, g === undefined ? undefined : shownG], [b, w === undefined ? undefined : shownW]));
  }
  return out;
}

const listed = (ids: readonly string[]): string => ids.join(',');

/** A fact the page may not state, as a reading: nothing said is `undefined`. */
const orNone = (fact: string | null): string | undefined => fact ?? undefined;

/** The words of an element as a finding shows one that has none. */
const wordsOrNone = (text: string): string => (text === '' ? 'no words' : text);

/** The words of each paragraph that opens a record, above its first block. */
export const introWords = (content: Content): string[] => content.intro.flatMap((n) => (n.type === 'paragraph' ? [n.text] : []));

// ---------------------------------------------------------------------------
// The record's own list of elements
// ---------------------------------------------------------------------------

/** An element of the record, as the page shows it. */
export interface Expected {
  readonly id: string;
  readonly tag: string;
  readonly block: string | null;
  readonly group: string | null;
  readonly text: string;
}

/**
 * Every id of a record with the element it sits on, the block and the group it
 * is in and the words that element shows, in page order. A caption and a summary
 * are the words the page shows; `flatten` has them as the fence wrote them.
 */
export function expectedElements(content: Content): Expected[] {
  const out: Expected[] = [];
  const add = (id: string | null, tag: string, block: string | null, group: string | null, text: string): void => {
    if (id !== null) out.push({ id, tag, block, group, text });
  };
  const visit = (n: BodyNode, block: string | null, group: string | null): void => {
    switch (n.type) {
      case 'paragraph':
        add(n.id, 'p', block, group, n.text);
        return;
      case 'heading':
        add(n.id, `h${n.depth}`, block, group, n.text);
        return;
      case 'group':
        add(n.heading.id, 'h3', block, n.value, n.heading.text);
        n.content.forEach((c) => visit(c, block, n.value));
        return;
      case 'list':
        add(n.id, n.ordered ? 'ol' : 'ul', block, group, '');
        for (const item of n.items) {
          add(item.id, 'li', block, group, item.text);
          item.content.forEach((c) => visit(c, block, group));
        }
        return;
      case 'table':
        add(n.id, 'table', block, group, '');
        for (const row of n.rows) add(row.id, 'tr', block, group, row.cells.map((c) => c.text).join(' | '));
        return;
      case 'figure':
        add(n.id, n.lang === 'mermaid' ? 'div' : 'figure', block, group, n.caption?.text ?? '');
        return;
      case 'sketch':
        add(n.id, 'details', block, group, n.summary?.text ?? '');
        n.content.forEach((c) => visit(c, block, group));
        return;
      case 'code':
        add(n.id, 'div', block, group, '');
        return;
      case 'quote':
        add(n.id, 'details', block, group, '');
        n.content.forEach((c) => visit(c, block, group));
        return;
      case 'html':
        return;
    }
  };
  content.intro.forEach((n) => visit(n, null, null));
  for (const b of content.blocks) {
    add(b.id, 'h2', b.name, null, b.heading.text);
    b.content.forEach((n) => visit(n, b.name, null));
  }
  return out;
}

/** One side of a comparison of two lists of elements by id. */
interface Side<T> {
  readonly surface: string;
  readonly list: readonly T[];
  /** What a finding calls one of them. */
  readonly show: (t: T) => string;
}

/**
 * Two lists of things with ids laid side by side: an id twice on one side, an
 * id one side lacks, an id the other lacks, whatever `both` finds wrong with a
 * pair that shares one and, when the same ids are there, the first place the
 * order differs.
 */
function matchIds<G extends { id: string }, W extends { id: string }>(got: Side<G>, want: Side<W>, both: (g: G, w: W) => string[]): string[] {
  const out: string[] = [];
  const gotBy = new Map<string, G>();
  for (const g of got.list) {
    if (gotBy.has(g.id)) out.push(differs(`#${g.id}: the id is on a second element`, [got.surface, got.show(g)], [want.surface, 'one element']));
    else gotBy.set(g.id, g);
  }
  const wantBy = new Map(want.list.map((w) => [w.id, w]));
  let same = true;
  for (const w of want.list) {
    const g = gotBy.get(w.id);
    if (g === undefined) {
      same = false;
      out.push(differs(`#${w.id}: the ${got.surface} has no element with this id`, [got.surface, undefined], [want.surface, want.show(w)]));
    } else {
      out.push(...both(g, w));
    }
  }
  for (const [id, g] of gotBy) {
    if (wantBy.has(id)) continue;
    same = false;
    out.push(differs(`#${id}: the record has no element with this id`, [got.surface, got.show(g)], [want.surface, undefined]));
  }
  if (same) {
    const kept = [...gotBy.values()];
    const at = kept.findIndex((g, i) => g.id !== (want.list[i] as W).id);
    if (at >= 0) {
      out.push(
        differs(`the elements are in another order, first at position ${at + 1}`, [got.surface, `#${(kept[at] as G).id}`], [want.surface, `#${(want.list[at] as W).id}`]),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The page, against its record
// ---------------------------------------------------------------------------

/** An id on a heading or an anchor that the record holds no element for: Starlight's slug, or a reference page's own anchor. */
const unheld = (e: ReadElement): boolean => /^h[1-6]$/.test(e.tag) || e.tag === 'a';

/** Everything the built page says that its record does not, or says differently. */
export function pageDiffs(record: PageRecord, read: PageRecordRead): string[] {
  const out: string[] = [];
  for (const [fact, , say] of FACTS) {
    const got = read.facts[fact];
    const want = say(record);
    if (got !== want) out.push(differs(`the article's data-${fact} differs`, ['html', orNone(got)], ['record', want]));
  }

  const blocks = record.blocks.map((b) => b.name);
  if (listed(read.blocks) !== listed(blocks)) out.push(differs('the blocks differ', ['html', read.blocks.join(', ')], ['record', blocks.join(', ')]));

  out.push(...sequence('intro paragraph', 'html', read.intro, 'record', introWords(record)));

  const want = expectedElements(record);
  const held = new Set(want.map((e) => e.id));
  out.push(
    ...matchIds<ReadElement, Expected>(
      { surface: 'html', list: read.elements.filter((e) => held.has(e.id) || !unheld(e)), show: (e) => `<${e.tag}>` },
      { surface: 'record', list: want, show: (e) => `<${e.tag}>` },
      (g, w) => {
        const found: string[] = [];
        if (g.tag !== w.tag) found.push(differs(`#${w.id}: the element differs`, ['html', `<${g.tag}>`], ['record', `<${w.tag}>`]));
        if (g.block !== w.block) found.push(differs(`#${w.id}: the block differs`, ['html', orNone(g.block)], ['record', orNone(w.block)]));
        if (g.group !== w.group) found.push(differs(`#${w.id}: the group differs`, ['html', orNone(g.group)], ['record', orNone(w.group)]));
        if (g.text !== w.text) {
          const [a, b] = windows(g.text, w.text);
          found.push(differs(`#${w.id}: the words differ`, ['html', a], ['record', b]));
        }
        return found;
      },
    ),
  );

  const row = (r: { readonly verb: string; readonly to: string }): string => `${r.verb} ${r.to}`;
  out.push(...sequence('relation', 'html', read.relations.map(row), 'record', record.relations.map(row)));

  for (const key of ['requires', 'related'] as const) {
    if (listed(read.prerequisites[key]) !== listed(record.prerequisites[key])) {
      out.push(differs(`the card's data-${key} differs`, ['html', listed(read.prerequisites[key])], ['record', listed(record.prerequisites[key])]));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The markdown, against the record
// ---------------------------------------------------------------------------

/** Everything the `.md` sibling says that the record does not, or says differently. */
export function markdownDiffs(record: PageRecord, bytes: Buffer): string[] {
  const out: string[] = [];
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== record.source.sha256) {
    out.push(differs("the markdown is not the file the record's source.sha256 names", ['md', hash.slice(0, 12)], ['record', record.source.sha256.slice(0, 12)]));
  }
  const doc = parsePage(bytes.toString('utf8'));
  const got = deriveElements(doc.tree).flatMap((e) => (e.id === undefined ? [] : [{ id: e.id, text: e.text }]));
  out.push(
    ...matchIds<FlatElement, FlatElement>(
      { surface: 'md', list: got, show: (e) => wordsOrNone(e.text) },
      { surface: 'record', list: flatten(record), show: (e) => wordsOrNone(e.text) },
      (g, w) => {
        if (g.text === w.text) return [];
        const [a, b] = windows(g.text, w.text);
        return [differs(`#${w.id}: the words differ`, ['md', a], ['record', b])];
      },
    ),
  );
  const intro = doc.intro.flatMap((n) => (n.type === 'paragraph' ? [plainText(n)] : []));
  out.push(...sequence('intro paragraph', 'md', intro, 'record', introWords(record)));
  return out;
}

// ---------------------------------------------------------------------------
// index.json and graph.json, against the records
// ---------------------------------------------------------------------------

/** A value of an index entry or a node as a finding shows it. */
const said = (v: unknown): string | undefined => (v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v));

/** What an index entry says of a page that its record does not, or says differently. */
export function indexDiffs(entry: Readonly<Record<string, unknown>>, record: PageRecord): string[] {
  const out: string[] = [];
  for (const [key, say] of INDEX_FIELDS) {
    const got = said(entry[key]);
    const want = said(say(record));
    if (got !== want) out.push(differs(`${record.route}: ${key} differs`, ['index', got], ['record', want]));
  }
  if (entry['record'] !== recordAddress(record.route)) {
    out.push(differs(`${record.route}: record differs`, ['index', said(entry['record'])], ['record', recordAddress(record.route)]));
  }
  return out;
}

type Edge = PageGraph['edges'][number];

/** What one side of a graph edge says: the note, the heading it sits under and the row it pins. */
const sideOf = (edge: Edge, side: 'A' | 'B'): string =>
  JSON.stringify(side === 'A' ? [edge.noteA, edge.groupA, edge.mapsA] : [edge.noteB, edge.groupB, edge.mapsB]);

/** The same three, as the record's row words them. */
const rowSide = (row: RelationRow): string => JSON.stringify([row.note, row.group, row.maps]);

/** The stops of a tour as text: `id: role`, one per stop. */
const stopKeys = (stops: readonly { readonly id: string; readonly role: { readonly md: string } }[]): string[] => stops.map((s) => `${s.id}: ${s.role.md}`);

/** Everything graph.json says that the records do not, or says differently. */
export function graphDiffs(graph: PageGraph, records: ReadonlyMap<string, PageRecord>): string[] {
  const out: string[] = [];

  const nodes = new Set(graph.nodes.map((n) => n.id));
  for (const n of graph.nodes) {
    const r = records.get(n.id);
    if (r === undefined) {
      out.push(differs(`node ${n.id}: no page of the index has this id`, ['graph', n.route], ['record', undefined]));
      continue;
    }
    for (const [key, say] of NODE_FIELDS) {
      if (n[key] !== say(r)) out.push(differs(`node ${n.id}: ${key} differs`, ['graph', n[key]], ['record', say(r)]));
    }
  }
  for (const id of records.keys()) {
    if (!nodes.has(id)) out.push(differs(`the page ${id} has no node`, ['graph', undefined], ['record', id]));
  }

  // Each edge is a row of the record of every page it joins; a row left over has no edge.
  const unmatched = new Set<RelationRow>([...records.values()].flatMap((r) => r.relations));
  for (const e of graph.edges) {
    const ends = [
      { page: e.a, verb: e.verb, to: e.b, side: 'A' as const },
      { page: e.b, verb: e.inverse, to: e.a, side: 'B' as const },
    ];
    for (const end of ends) {
      const rows = records.get(end.page)?.relations ?? [];
      const row = rows.find((r) => r.verb === end.verb && r.to === end.to && r.edge.a === e.a && r.edge.verb === e.verb && r.edge.b === e.b);
      if (row === undefined) {
        out.push(differs(`the edge ${e.a} ${e.verb} ${e.b} is not among the relations of ${end.page}`, ['graph', `${end.verb} ${end.to}`], ['record', undefined]));
        continue;
      }
      unmatched.delete(row);
      if (sideOf(e, end.side) !== rowSide(row)) {
        out.push(differs(`the edge ${e.a} ${e.verb} ${e.b}: ${end.page} words it differently`, ['graph', sideOf(e, end.side)], ['record', rowSide(row)]));
      }
    }
  }
  for (const r of records.values()) {
    for (const row of r.relations.filter((x) => unmatched.has(x))) {
      out.push(differs(`${r.id} lists a relation no edge of graph.json states`, ['graph', undefined], ['record', `${row.verb} ${row.to}`]));
    }
  }

  // A theme's own stops, and for each page the themes whose tour holds it.
  const tours = new Map(graph.tours.map((t) => [t.theme, stopKeys(t.stages).join('; ')]));
  for (const r of records.values()) {
    const got = tours.get(r.id) ?? '';
    const want = stopKeys(r.tour).join('; ');
    if (got !== want) out.push(differs(`${r.id}: its tour differs`, ['graph', got], ['record', want]));
    const themes = stopKeys(graph.tours.flatMap((t) => t.stages.filter((s) => s.id === r.id).map((s) => ({ id: t.theme, role: s.role })))).join('; ');
    const held = stopKeys(r.themes).join('; ');
    if (themes !== held) out.push(differs(`${r.id}: its themes differ`, ['graph', themes], ['record', held]));
  }

  // The pages a page links to, in order of first mention.
  const mentions = new Map<string, string[]>();
  for (const m of graph.mentions) mentions.set(m.from, [...(mentions.get(m.from) ?? []), m.to]);
  for (const r of records.values()) {
    const got = listed(mentions.get(r.id) ?? []);
    if (got !== listed(r.mentions)) out.push(differs(`${r.id}: its mentions differ`, ['graph', got], ['record', listed(r.mentions)]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** One finding of a file: the file it names, and what is wrong. */
type Found = readonly [file: string, what: string];

/** Show the first findings, then how many more there are, against the file of the first. */
function report(ctx: GateContext, found: readonly Found[]): void {
  for (const [file, what] of found.slice(0, SHOWN)) ctx.fail(file, what);
  if (found.length > SHOWN) ctx.fail((found[0] as Found)[0], `and ${found.length - SHOWN} more`);
}

/** A JSON file that holds its schema, or what is wrong with it. */
type Loaded<T> = { readonly value: T } | { readonly problem: string };

function load<T>(schemas: SchemaSet, base: string, file: string): Loaded<T> {
  if (!fs.existsSync(file)) return { problem: 'is missing — build it first: make site-build' };
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { problem: `is not valid JSON — ${(e as Error).message.replace(/\s+/g, ' ')}` };
  }
  const broken = schemas.validate(schemaUrl(base), value);
  if (broken.length === 0) return { value: value as T };
  const more = broken.length > 1 ? `, and ${broken.length - 1} more` : '';
  return { problem: `breaks ${base}: ${formatFinding(broken[0] as (typeof broken)[number])}${more}` };
}

/** The index entries that are pages of the knowledge base: the ones that name a record. */
const kbPages = (pages: readonly Record<string, unknown>[]): Record<string, unknown>[] => pages.filter((p) => typeof p['record'] === 'string');

/** The whole run over one built site. */
export function parity(ctx: GateContext, dist: string): string {
  const abs = path.resolve(ctx.root, dist);
  const shown = (file: string): string => path.relative(ctx.root, file).split(path.sep).join('/');
  const indexFile = path.join(abs, 'index.json');
  if (!fs.existsSync(indexFile)) {
    ctx.failLine(`no built site at ${dist} — build it first: make site-build`);
    return '';
  }
  // A tree with no content model holds no knowledge base, as in the portability gate: no page has a record to compare.
  if (!fs.existsSync(path.join(ctx.root, DATA.model))) {
    return `[site-parity] this tree holds no knowledge base (${DATA.model} is not there): no page has a record to compare`;
  }
  const schemas = contractSchemas(ctx.root, { closed: false });
  const absent = [SCHEMA_BASES.record, SCHEMA_BASES.graph, SCHEMA_BASES.index].filter((base) => !schemas.ids.includes(schemaUrl(base)));
  for (const base of absent) ctx.fail(`${SCHEMA_DIR}/${base}.json`, 'is missing — the records, the graph and the index are held to it');
  if (absent.length > 0) return '';

  const index = load<{ pages: Record<string, unknown>[] }>(schemas, SCHEMA_BASES.index, indexFile);
  if ('problem' in index) {
    ctx.fail(shown(indexFile), index.problem);
    return '';
  }
  const pages = kbPages(index.value.pages);
  if (pages.length === 0) {
    ctx.fail(shown(indexFile), 'lists no page with a record — build it first: make site-build');
    return '';
  }

  const records = new Map<string, PageRecord>();
  const listing: Found[] = [];
  let elements = 0;
  let relations = 0;
  let unread = 0;
  for (const entry of pages) {
    const route = entry['route'] as string;
    const htmlFile = path.join(abs, route.slice(1));
    const mdFile = path.join(abs, route.slice(1).replace(/\.html$/, '.md'));
    const recordFile = path.join(abs, (entry['record'] as string).slice(1));
    const loaded = load<PageRecord>(schemas, SCHEMA_BASES.record, recordFile);
    if ('problem' in loaded) {
      unread += 1;
      ctx.fail(shown(recordFile), loaded.problem);
      continue;
    }
    const record = loaded.value;
    records.set(record.id, record);
    elements += Object.keys(record.anchors).length;
    relations += record.relations.length;

    const found: Found[] = [];
    if (!fs.existsSync(htmlFile)) {
      found.push([shown(htmlFile), 'is missing — build it first: make site-build']);
    } else {
      const read = readPageRecord(fs.readFileSync(htmlFile, 'utf8'));
      if (read === null) found.push([shown(htmlFile), 'has no knowledge region to read — build it first: make site-build']);
      else found.push(...pageDiffs(record, read).map((what): Found => [shown(htmlFile), what]));
    }
    if (!fs.existsSync(mdFile)) found.push([shown(mdFile), 'is missing — the markdown of every page of the knowledge base ships beside it']);
    else found.push(...markdownDiffs(record, fs.readFileSync(mdFile)).map((what): Found => [shown(mdFile), what]));
    report(ctx, found);
    listing.push(...indexDiffs(entry, record).map((what): Found => [shown(indexFile), what]));
  }
  report(ctx, listing);
  // With a record missing, graph.json would be held to a set that lacks a page: every edge of it would be a finding.
  if (unread > 0) return '';

  const graphFile = path.join(abs, 'graph.json');
  const graph = load<PageGraph>(schemas, SCHEMA_BASES.graph, graphFile);
  if ('problem' in graph) {
    ctx.fail(shown(graphFile), graph.problem);
    return '';
  }
  report(ctx, graphDiffs(graph.value, records).map((what): Found => [shown(graphFile), what]));

  return `[site-parity] ${pages.length} pages, ${elements} elements, ${relations} relations and ${graph.value.edges.length} graph edges: the HTML, the record and the markdown say the same thing`;
}

export const spec: GateSpec = {
  name: 'site-parity',
  usage: 'usage: check-site-parity   (takes no arguments: the scan is always whole)',
  run(ctx: GateContext): string {
    return parity(ctx, DIST);
  },
};

main(spec, import.meta.url);
