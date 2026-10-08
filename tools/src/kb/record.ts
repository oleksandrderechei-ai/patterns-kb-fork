/**
 * The page record of the retrieval contract, `kb-record/1`, and the checks that
 * hang on it: one JSON document per page that holds everything a machine reader
 * needs to know about it, built from the markdown and the data files and from
 * nothing else, so that any program that writes a record, this CLI or a build,
 * writes the same bytes. The shape is published as tools/src/contract/schema/
 * kb-record-1.json, which says what each key means; this module is the one
 * place that builds it.
 *
 *   recordOf      a page's record: header, body, relations, tours and links
 *   graphOf       the whole link graph, `kb-graph/1`: every page, edge and tour
 *   resolveRefs   citations, `<id>#<element>@<fp>`, checked against the pages
 *   resolveLine   one resolved citation as the line `kb.mjs resolve` prints
 *
 * THE RECORD. Every key is always there, with `null`, `[]` or `false` where it
 * does not apply, and the keys come in the order of the `PageRecord`
 * interface: that order is the order of the bytes. Where a value comes from:
 *
 *   header      the page's frontmatter (title, description, status, owner,
 *               tags, aliases, solves, favourite) and its place in the
 *               structure file (kind, band, group, area, areaChain,
 *               tools/src/lib/kb-place.ts)
 *   source      the repo path of the markdown and the SHA-256 of its bytes,
 *               which is how a reader tells the record is current
 *   body        `buildBody` over the parsed page (tools/src/lib/kb-record.ts):
 *               intro, blocks, anchors and links
 *   relations   one row per side of an edge the page's relationships block
 *               shows, in the block's own order (`relationGroups`), with the
 *               edge's identity so that the two sides of one edge can be told
 *               to be one
 *   themes      the themes whose tour holds the page, in learning-path order
 *   tour        a theme's own stops, in stage order; empty on any other page
 *   prerequisites  what to read first and what sits beside it, from
 *               docs/data/prerequisites.json, as page ids
 *   mentions    the pages this one links to in prose where no relation, theme
 *               or tour of its own already names them: what `backlinks` lists
 *               (`Corpus.mentions`)
 *
 * A tour stop that names a route no page has is left out of `themes`, `tour`
 * and the graph's tours: the learning-path gate owns that failure, and a record
 * has no title or route to give the stop. A relation that names a page the
 * corpus lacks is refused, since a row without its target is not a row.
 *
 * `recordOf(corpus, id, { blocks })` keeps only the named blocks: `scope` lists
 * them in page order, `intro` is empty, `links` and `anchors` cover only what
 * is kept, and the anchors' pointers read from the record that keeps them.
 *
 * THE CITATION CHECK. `resolveRefs` answers, for each `<id>#<element>@<fp>`:
 *
 *   ok          the page and the element are there, and the words are the
 *               ones cited (or none were cited)
 *   moved       the element's id changed, since ids are positional, and the
 *               cited words are on exactly one element now
 *   ambiguous   the cited words are on several elements and not on the cited id
 *   changed     the element is there and says something else now
 *   gone        the page is unknown, or neither the element nor the words are
 *               on the page
 *
 * A block is cited by its name alone, `<id>#<block>`: it carries no fingerprint,
 * since its id is its name and does not renumber, so a pin on one is ignored and
 * the citation is ok whenever the block is there.
 *
 * Nothing here reads a clock, a random number or the environment.
 */

import { CONTRACTS, SCHEMA_BASES, schemaUrl } from '../contract/contract.js';
import type { AreaRef } from '../lib/kb-place.js';
import { anchorsOf, buildBody, flatten, RecordError, type Block, type Body, type BodyNode, type Inline, type LinkRef } from '../lib/kb-record.js';
import { inverseOf, labelOf, relationGroups, type RelationRecord, type Verbs } from '../lib/render-relations.js';
import { loadCards } from '../lib/site-prerequisites.js';

import { KbError, KbUsageError, type Corpus, type Page } from './corpus.js';
import { mdPlain } from './page.js';

// ---------------------------------------------------------------------------
// The record, as types
// ---------------------------------------------------------------------------

/** The part of a relations record an edge is known by: the two pages and the verb as the first one reads it. */
export interface EdgeRef {
  readonly a: string;
  readonly verb: string;
  readonly b: string;
}

/** The element of a capability or comparison page an edge pins, and the words of its first cell. */
export interface Maps {
  readonly id: string;
  readonly label: string;
}

/** One side of an edge, as the page that holds it reads it. */
export interface RelationRow {
  /** The relation as this page reads it: `prevents-hazard` on the pattern, `mitigated-by` on the hazard. */
  readonly verb: string;
  readonly label: string;
  /** The verb the page at the other end reads. */
  readonly inverse: string;
  readonly to: string;
  readonly title: string;
  readonly kind: string;
  readonly route: string;
  readonly note: Inline;
  /** The heading the row sits under in the relationships block: a custom group, else `label`. */
  readonly group: string;
  readonly maps: Maps | null;
  readonly edge: EdgeRef;
}

/** A page in a list of pages that each play a part: a theme the page belongs to, a stop of a theme's tour. */
export interface Stop {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly role: Inline;
}

/** What to read first, and what sits beside it. */
export interface Prerequisites {
  readonly requires: readonly string[];
  readonly related: readonly string[];
}

/** The markdown a record was built from. */
export interface SourceRef {
  readonly path: string;
  readonly sha256: string;
}

/** A page as one JSON document: the keys are in the order the bytes carry them. */
export interface PageRecord {
  readonly $schema: string;
  readonly contract: string;
  /** The names of the blocks the record keeps, in page order; null when it keeps every block. */
  readonly scope: readonly string[] | null;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly kind: string;
  readonly band: string;
  readonly group: string;
  readonly area: string;
  readonly areaChain: readonly AreaRef[];
  readonly status: string;
  readonly owner: string;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly solves: readonly string[];
  readonly favourite: boolean;
  readonly route: string;
  readonly markdown: string;
  readonly source: SourceRef;
  readonly intro: readonly BodyNode[];
  readonly blocks: readonly Block[];
  readonly relations: readonly RelationRow[];
  readonly themes: readonly Stop[];
  readonly tour: readonly Stop[];
  readonly prerequisites: Prerequisites;
  readonly links: readonly LinkRef[];
  readonly mentions: readonly string[];
  readonly anchors: Readonly<Record<string, string>>;
}

/** What `recordOf` may be asked for beyond the page. */
export interface RecordOptions {
  /** Keep only these blocks, by name; every block when omitted. */
  readonly blocks?: readonly string[];
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** Markdown inline text as the words a reader sees and as written. */
const noteOf = (md: string): Inline => ({ text: mdPlain(md), md });

/** A page's route as the address of its sibling file: `/a/b.html` is `/a/b.md` and `/a/b.json`. */
const siblingOf = (route: string, ext: string): string => route.replace(/\.html$/, ext);

/**
 * The body of a page, built once per corpus. A page the record cannot hold
 * (tools/src/lib/kb-record.ts names the cases) is the knowledge base refusing
 * the content, so it is a KbError and exits 1, not a crash.
 */
function bodyOf(corpus: Corpus, page: Page): Body {
  return corpus.cached(`record-body:${page.slug}`, () => {
    const doc = corpus.doc(page.slug);
    try {
      return buildBody(doc.tree, doc.source, { linkTarget: (href) => corpus.linkTarget(page.source, href)?.slug ?? null });
    } catch (e) {
      if (e instanceof RecordError) throw new KbError(`${page.slug}: ${e.message}`);
      throw e;
    }
  });
}

/** The part of a record that is the page's own words: the whole body, or the blocks asked for. */
interface Part {
  readonly scope: readonly string[] | null;
  readonly intro: readonly BodyNode[];
  readonly blocks: readonly Block[];
  readonly links: readonly LinkRef[];
  readonly anchors: Readonly<Record<string, string>>;
}

/**
 * The page's body, or only the blocks `names` lists. An unknown name is a
 * lookup that failed, said as `get` says it, with the blocks the page has.
 */
function partOf(corpus: Corpus, page: Page, names: readonly string[] | undefined): Part {
  const body = bodyOf(corpus, page);
  if (names === undefined) return { scope: null, intro: body.intro, blocks: body.blocks, links: body.links, anchors: body.anchors };
  const has = body.blocks.map((b) => b.name);
  const unknown = names.find((n) => !has.includes(n));
  if (unknown !== undefined) throw new KbError(`no block "${unknown}" on ${page.slug}. has: ${has.join(', ')}`);
  const kept = body.blocks.filter((b) => names.includes(b.name));
  return {
    scope: kept.map((b) => b.name),
    intro: [],
    blocks: kept,
    links: body.links.filter((l) => l.block !== null && names.includes(l.block)),
    anchors: anchorsOf({ intro: [], blocks: kept }),
  };
}

/** The element an edge pins on one side, with the words of its first cell; a pin with no words has an empty label. */
const mapsOf = (id: string | undefined, label: string | undefined): Maps | null => (id === undefined ? null : { id, label: label ?? '' });

/** One side of an edge: `end` says which page's row it is, the one written first (`a`) or the other. */
function rowOf(corpus: Corpus, r: RelationRecord, end: 'a' | 'b'): RelationRow {
  const { verbs } = corpus.model;
  const own = end === 'a';
  const verb = own ? r.verb : inverseOf(r.verb, verbs);
  const to = own ? r.b : r.a;
  const note = own ? r.note_a : r.note_b;
  const target = corpus.page(to);
  if (target === undefined) throw new KbError(`${own ? r.a : r.b}: the relation ${r.a} ${r.verb} ${r.b} names "${to}", which is no page`);
  const label = labelOf({ verb, to, note }, verbs);
  return {
    verb,
    label,
    inverse: own ? inverseOf(r.verb, verbs) : r.verb,
    to,
    title: corpus.meta(to).title,
    kind: target.kind,
    route: target.route,
    note: noteOf(note),
    group: (own ? r.group_a : r.group_b) ?? label,
    maps: own ? mapsOf(r.maps_a, r.maps_label_a) : mapsOf(r.maps_b, r.maps_label_b),
    edge: { a: r.a, verb: r.verb, b: r.b },
  };
}

/** Every side of an edge a page holds, in the order its relationships block shows them. */
function relationRows(corpus: Corpus, slug: string): RelationRow[] {
  const { verbs, relOrder } = corpus.model;
  const file = corpus.relations;
  // `relationGroups` refuses a verb the content model does not know, before a row is read.
  const order = relationGroups(slug, file, verbs, relOrder).map((g) => g.label);
  const rows: RelationRow[] = [];
  for (const r of file.relations) {
    if (r.a === slug) rows.push(rowOf(corpus, r, 'a'));
    if (r.b === slug) rows.push(rowOf(corpus, r, 'b'));
  }
  // A group's rows keep the order of the file, which is the order the block gives them in.
  return order.flatMap((label) => rows.filter((row) => row.group === label));
}

/** A page in a list of pages that each play a part. */
const stopOf = (corpus: Corpus, page: Page, role: string): Stop => ({ id: page.slug, title: corpus.meta(page.slug).title, route: page.route, role: noteOf(role) });

/** The stops of a theme's tour, in stage order, less a stage that names no page. */
function stopsOf(corpus: Corpus, theme: string): Stop[] {
  return corpus.membersOf(theme).flatMap((m) => {
    const page = corpus.page(m.id);
    return page === undefined ? [] : [stopOf(corpus, page, m.role)];
  });
}

/**
 * The record of one page. `id` is a page's id; an id that names no page is a
 * KbError, as in every kb.mjs command.
 */
export function recordOf(corpus: Corpus, id: string, opts: RecordOptions = {}): PageRecord {
  const page = corpus.need(id);
  const meta = corpus.meta(page.slug);
  const part = partOf(corpus, page, opts.blocks);
  const card = loadCards(corpus.root).get(page.route);
  return {
    $schema: schemaUrl(SCHEMA_BASES.record),
    contract: CONTRACTS.record,
    scope: part.scope,
    id: page.slug,
    title: meta.title,
    description: meta.essence,
    kind: page.kind,
    band: page.band,
    group: page.group,
    area: page.area,
    areaChain: page.areaChain,
    status: meta.status,
    owner: meta.owner,
    tags: meta.tags,
    aliases: meta.aliases,
    solves: meta.solves,
    favourite: meta.favourite,
    route: page.route,
    markdown: siblingOf(page.route, '.md'),
    source: { path: page.source, sha256: corpus.digest(page.slug) },
    intro: part.intro,
    blocks: part.blocks,
    relations: relationRows(corpus, page.slug),
    themes: corpus.themesOf(page.slug).map((t) => stopOf(corpus, corpus.need(t.id), t.role)),
    tour: stopsOf(corpus, page.slug),
    prerequisites: { requires: card?.requires.map((l) => l.id) ?? [], related: card?.related.map((l) => l.id) ?? [] },
    links: part.links,
    mentions: corpus.mentions(page.slug),
    anchors: part.anchors,
  };
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/** A verb of the content model. */
export interface GraphVerb {
  readonly id: string;
  readonly label: string;
  readonly inverse: string;
  readonly symmetric: boolean;
}

/** A page of the graph: what is needed to place it and to fetch its record. */
export interface GraphNode {
  readonly id: string;
  readonly kind: string;
  readonly band: string;
  readonly group: string;
  readonly title: string;
  readonly route: string;
  /** The address of the page's record: its route with `.json` for `.html`. */
  readonly record: string;
}

/** One edge, with both sides' words: the record of docs/data/relations.json, as the pages read it. */
export interface GraphEdge {
  readonly a: string;
  readonly verb: string;
  readonly b: string;
  readonly inverse: string;
  readonly noteA: Inline;
  readonly noteB: Inline;
  readonly groupA: string;
  readonly groupB: string;
  readonly mapsA: Maps | null;
  readonly mapsB: Maps | null;
}

/** A theme's tour: its stops in stage order, each with the part the page plays. */
export interface GraphTour {
  readonly theme: string;
  readonly stages: readonly { readonly id: string; readonly role: Inline }[];
}

/** A page that links to another in its prose where no relation, theme or tour already names it. */
export interface GraphMention {
  readonly from: string;
  readonly to: string;
}

/** The whole link graph as one document. */
export interface PageGraph {
  readonly $schema: string;
  readonly contract: string;
  readonly verbs: readonly GraphVerb[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly tours: readonly GraphTour[];
  readonly mentions: readonly GraphMention[];
}

function edgeOf(verbs: Verbs, r: RelationRecord): GraphEdge {
  const inverse = inverseOf(r.verb, verbs);
  return {
    a: r.a,
    verb: r.verb,
    b: r.b,
    inverse,
    noteA: noteOf(r.note_a),
    noteB: noteOf(r.note_b),
    groupA: r.group_a ?? labelOf({ verb: r.verb, to: r.b, note: r.note_a }, verbs),
    groupB: r.group_b ?? labelOf({ verb: inverse, to: r.a, note: r.note_b }, verbs),
    mapsA: mapsOf(r.maps_a, r.maps_label_a),
    mapsB: mapsOf(r.maps_b, r.maps_label_b),
  };
}

/**
 * The graph of the whole knowledge base: the verbs, every page in listing
 * order, every edge in the order of docs/data/relations.json, every theme's
 * tour and every prose mention. Each edge is written once, with both sides, so
 * a reader that wants one page's rows takes that page's record instead.
 */
export function graphOf(corpus: Corpus): PageGraph {
  const { verbs } = corpus.model;
  return {
    $schema: schemaUrl(SCHEMA_BASES.graph),
    contract: CONTRACTS.graph,
    verbs: Object.entries(verbs).map(([id, v]) => ({ id, label: v.label, inverse: inverseOf(id, verbs), symmetric: v.symmetric === true })),
    nodes: corpus.listing.map((p) => ({
      id: p.slug,
      kind: p.kind,
      band: p.band,
      group: p.group,
      title: corpus.meta(p.slug).title,
      route: p.route,
      record: siblingOf(p.route, '.json'),
    })),
    edges: corpus.relations.relations.map((r) => edgeOf(verbs, r)),
    tours: corpus.paths.profiles.flatMap((prof) =>
      corpus.page(prof.id) === undefined ? [] : [{ theme: prof.id, stages: stopsOf(corpus, prof.id).map((s) => ({ id: s.id, role: s.role })) }],
    ),
    mentions: corpus.listing.flatMap((p) => corpus.mentions(p.slug).map((to) => ({ from: p.slug, to }))),
  };
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** How a citation stands against the pages. */
export type RefStatus = 'ok' | 'moved' | 'ambiguous' | 'changed' | 'gone';

/** An element as it is now: its id and its fingerprint, which is null on an element that has none (a block). */
export interface Pin {
  readonly id: string;
  readonly fp: string | null;
}

/** One citation, checked. */
export interface Resolved {
  /** The citation as it was given. */
  readonly ref: string;
  /** The id of the page the citation names. */
  readonly page: string;
  /** The element id cited. */
  readonly id: string;
  /** The fingerprint cited, or null when the citation pins none or cites a block, which takes no pin. */
  readonly fp: string | null;
  readonly status: RefStatus;
  /** The element the citation stands for now; null when it stands for none (`ambiguous`, `gone`). */
  readonly now: Pin | null;
  /** Where that element is in the page's record: its anchor; null with `now`. */
  readonly pointer: string | null;
  /** The block it sits in; null in the intro, and with `now`. */
  readonly block: string | null;
  /** The polarity or requirement of the group it sits in; null outside a group, and with `now`. */
  readonly group: string | null;
  /** The element's own words, as `deriveElements` reads them; null with `now`. */
  readonly text: string | null;
}

/** An element of a page's record, with what a citation check needs to know of it. */
interface Element {
  readonly id: string;
  readonly fp: string | null;
  readonly pointer: string;
  readonly text: string;
  readonly block: string | null;
  readonly group: string | null;
}

/** Every element of a page that has an id, in document order, found once per corpus. */
function elementsOf(corpus: Corpus, page: Page): readonly Element[] {
  return corpus.cached(`record-elements:${page.slug}`, () => {
    const body = bodyOf(corpus, page);
    const texts = new Map(flatten(body).map((e) => [e.id, e.text]));
    return Object.entries(body.anchors).map(([id, pointer]): Element => {
      let at: unknown = { intro: body.intro, blocks: body.blocks };
      let group: string | null = null;
      for (const step of pointer.split('/').slice(1)) {
        at = (at as Record<string, unknown>)[step];
        const node = at as { type?: unknown; value?: unknown };
        if (node.type === 'group') group = node.value as string;
      }
      const inBlock = /^\/blocks\/(\d+)/.exec(pointer);
      return {
        id,
        fp: (at as { fp?: string | null }).fp ?? null,
        pointer,
        text: texts.get(id) as string,
        block: inBlock === null ? null : (body.blocks[Number(inBlock[1])] as Block).name,
        group,
      };
    });
  });
}

const FINGERPRINT = /^[0-9a-f]{8}$/;

/** A citation taken apart. */
interface Citation {
  readonly ref: string;
  readonly page: string;
  readonly id: string;
  readonly fp: string | null;
}

/** A citation taken apart; a malformed one is a KbUsageError, one line. */
function parseRef(ref: string): Citation {
  const hash = ref.indexOf('#');
  if (hash < 0) throw new KbUsageError(`${ref}: not a citation — write <id>#<element>, and @<fp> after it to pin its words`);
  // The page is the last path segment before the #, less its .md or .html: an id, a path in docs/, a site path or a site URL.
  const segments = (ref.slice(0, hash).split('?')[0] as string).split('/');
  const page = (segments.at(-1) as string).replace(/\.(?:md|html)$/, '');
  const tail = ref.slice(hash + 1);
  const at = tail.indexOf('@');
  const id = at < 0 ? tail : tail.slice(0, at);
  const fp = at < 0 ? null : tail.slice(at + 1);
  if (page === '') throw new KbUsageError(`${ref}: names no page before the #`);
  if (id === '') throw new KbUsageError(`${ref}: names no element after the #`);
  if (fp !== null && !FINGERPRINT.test(fp)) throw new KbUsageError(`${ref}: the fingerprint after @ is 8 lower-case hex digits`);
  return { ref, page, id, fp };
}

function resolveOne(corpus: Corpus, cited: Citation): Resolved {
  const page = corpus.page(cited.page);
  const elements = page === undefined ? [] : elementsOf(corpus, page);
  const same = elements.find((e) => e.id === cited.id);
  // A block carries no fingerprint: its id is its name, which does not renumber, so
  // a pin on one holds nothing and is ignored. It is never moved, ambiguous or changed.
  const fp = same?.fp === null ? null : cited.fp;
  const wording = fp === null ? [] : elements.filter((e) => e.fp === fp);
  let status: RefStatus;
  let now: Element | null;
  if (same !== undefined && (fp === null || same.fp === fp)) {
    status = 'ok';
    now = same;
  } else if (wording.length === 1) {
    status = 'moved';
    now = wording[0] as Element;
  } else if (wording.length > 1) {
    status = 'ambiguous';
    now = null;
  } else if (same !== undefined) {
    status = 'changed';
    now = same;
  } else {
    status = 'gone';
    now = null;
  }
  return {
    ref: cited.ref,
    page: cited.page,
    id: cited.id,
    fp,
    status,
    now: now === null ? null : { id: now.id, fp: now.fp },
    pointer: now === null ? null : now.pointer,
    block: now === null ? null : now.block,
    group: now === null ? null : now.group,
    text: now === null ? null : now.text,
  };
}

/**
 * Check citations against the pages. Every citation is read before any is
 * looked up, so a malformed one stops the whole call, and the results come in
 * the order the citations were given. A citation of an unknown page is `gone`,
 * not an error: the call was well made and found nothing.
 */
export function resolveRefs(corpus: Corpus, refs: readonly string[]): Resolved[] {
  return refs.map(parseRef).map((cited) => resolveOne(corpus, cited));
}

/** The width of the status column: the longest status, and a space. */
const STATUS_WIDTH = 10;

/**
 * One resolved citation as a line: its status, the citation, and where it went
 * when it moved or what it says now when it changed. A citation that changed
 * pinned an element with a fingerprint, since a block takes no pin and so
 * cannot change.
 */
export function resolveLine(r: Resolved): string {
  const { now } = r;
  const tail = now === null ? '' : r.status === 'moved' ? ` → ${now.id}` : r.status === 'changed' ? ` → now @${now.fp as string}` : '';
  return `${r.status.padEnd(STATUS_WIDTH)}${r.ref}${tail}`;
}
