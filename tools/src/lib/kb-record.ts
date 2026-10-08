/**
 * The body of a `kb-record/1` record: a parsed page as a structured, lossless,
 * deterministic tree whose containers exist exactly where the built HTML has a
 * data block, so a gate can lay the record, the HTML and the `.md` sibling side
 * by side and compare them element by element. Pure: no clock, no randomness,
 * no I/O, and the tree it reads is never changed.
 *
 *   buildBody    a tree from `parseKb` and the text it was parsed from → the body
 *   anchorsOf    every id of a body → the JSON Pointer of the object carrying it
 *   flatten      every id-bearing node of a body, in document order, as
 *                `deriveElements` (kb-attrs.ts) lists the same page
 *   fingerprint  the short, stable hash a citation pins an element's words with
 *   serialize    the one way a record becomes bytes
 *   clicksIn     the `click <node> "<target>"` lines of a diagram's source
 *
 * WHAT BECOMES WHAT
 *
 *   H1                      consumed: the title lives in the record's header
 *   `##` + block fact       a Block; the nodes above the first are `intro`, and
 *                           a page with no block fact is all intro
 *   `###` + polarity or     a group, ending where the HTML section ends (the
 *   requirement fact        pass in site-portable.ts `groupEnd`, dialect X-06):
 *                           a polarity group closes after its last list when
 *                           prose follows it, and that prose is a node of the
 *                           block; a requirement group runs to the next heading
 *   any other heading       a flat heading node
 *   paragraph, list, table  paragraph, list (with items), table (with rows)
 *   mermaid fence           a figure
 *   fence with `summary=`   a code sketch (a `<details>` in the HTML)
 *   other captioned fence   a figure (a `<figure>` in the HTML)
 *   other fence             a code node
 *   blockquote              a prose sketch when it opens with a lone bold run or
 *                           a thematic break (a `<details>` with a summary or
 *                           without one), else a quote
 *   raw HTML, a rule, a     an html node holding the markup as written
 *   footnote definition
 *   `<!--meta-->`, region   consumed, like every other comment-only html node
 *   markers, stamps
 *
 * Every node carries every key it has, with `null`, `[]` or `false` where the
 * key does not apply, and keys in the order the interfaces below list them: that
 * order is the order the bytes come out in.
 *
 * TEXT AND MARKDOWN. `text` is `plainText` of the node: what the HTML element
 * shows, whitespace collapsed the way HTML collapses it, U+00A0 kept; a list
 * item's is its first paragraph's. `md` is the node's own slice of the source,
 * cut by position and never printed again, so code spans, links, bold and
 * escapes survive; a trailing `{#id}` suffix is removed, a task list's `[ ]` is
 * not part of the item, and the prefix a container puts before a continuation
 * line (`> `, a list's indent) is gone. A fence's caption and summary are fence
 * meta, not markdown nodes: their `md` is the value as the fence wrote it, code
 * spans in backticks, and their `text` is what the site's own `metaInline`
 * renders into the `<figcaption>` or `<summary>`.
 *
 * IDS. A node's id is the one `kb-attrs.ts` gave it, written or issued. `fp`
 * is `fingerprint` of the node's own `text`; when that is empty, of its
 * descendants' texts joined by a newline; when that is empty too, of its
 * `code`. `fp` is null exactly when `id` is. `anchors` is `anchorsOf` of the
 * body: the pointer reads from a record whose `intro` and `blocks` are top-level
 * keys, so a record that keeps only some blocks takes `anchorsOf` of what it
 * keeps. An id of digits only would sort first in any JSON object: the dialect
 * never issues one.
 *
 * LINKS. Every markdown link outside a marked region, and every `click` line of
 * a mermaid fence, in document order. `from` is the id of the nearest enclosing
 * element that has one, `to` what the caller's `linkTarget` makes of the href,
 * `fragment` the part after `#`, so `${to}#${fragment}` is a citation.
 *
 * A page the record cannot hold throws `RecordError`: a marked region that is
 * not closed inside one block or one stretch of intro, a region named other
 * than its block, a `##` with no block fact after the first block, an id on two
 * elements, a tree parsed without positions.
 */

import { createHash } from 'node:crypto';

import type { TableCell } from 'mdast';

import {
  MARKER_PATTERN,
  parseSuffix,
  plainText,
  readKb,
  splitTrailingSuffix,
  type Blockquote,
  type Code,
  type GroupFact,
  type Heading,
  type List,
  type ListItem,
  type Nodes,
  type Paragraph,
  type Root,
  type RootContent,
  type Table,
  type TableRow,
} from './kb-attrs.js';
import { splitTarget } from './links.js';
import { metaInline } from './site-markdown.js';

// ---------------------------------------------------------------------------
// The record's body, as types
// ---------------------------------------------------------------------------

/** A run of phrasing content: the words it shows and the markdown it is written in. */
export interface Inline {
  /** `plainText` of the node: exactly what its HTML element shows. */
  readonly text: string;
  /** The node's own source, a trailing `{#id}` removed. */
  readonly md: string;
}

/** A paragraph that is no item's text and no quote's summary. */
export interface ParagraphNode {
  readonly type: 'paragraph';
  readonly id: string | null;
  readonly fp: string | null;
  readonly text: string;
  readonly md: string;
}

/** A heading that is no group's: an H3 and deeper, or any heading on a page that has no blocks. */
export interface HeadingNode {
  readonly type: 'heading';
  readonly id: string | null;
  readonly fp: string | null;
  readonly depth: number;
  readonly text: string;
  readonly md: string;
}

/** The heading of a group: it has no node type of its own, and carries an id only when one was written. */
export interface GroupHeading {
  readonly id: string | null;
  readonly fp: string | null;
  readonly text: string;
  readonly md: string;
}

/** An H3 carrying a polarity or requirement fact, and what the HTML section under it holds. */
export interface GroupNode {
  readonly type: 'group';
  readonly fact: GroupFact;
  readonly value: string;
  readonly heading: GroupHeading;
  readonly content: readonly Flow[];
}

/**
 * A list item: its own text is its first paragraph (as `deriveElements` reads
 * it); a nested list, a fence, a quote and any later paragraph are `content`.
 */
export interface Item {
  readonly id: string | null;
  readonly fp: string | null;
  readonly text: string;
  readonly md: string;
  /** The plain text of a leading bold run, or null. */
  readonly lead: string | null;
  /** A task list item's state, or null on any other. */
  readonly checked: boolean | null;
  readonly content: readonly Flow[];
}

/** A bullet or numbered list; an id only when the list was given one. */
export interface ListNode {
  readonly type: 'list';
  readonly id: string | null;
  readonly fp: string | null;
  readonly ordered: boolean;
  /** The number the first item carries; null on a bullet list. */
  readonly start: number | null;
  readonly items: readonly Item[];
}

/** A body row of a table: its id is `<block>-row-N` or the one written after its last cell. */
export interface Row {
  readonly id: string | null;
  readonly fp: string | null;
  readonly cells: readonly Inline[];
}

/** A column's alignment, null where the table's delimiter row sets none. */
export type Align = 'left' | 'right' | 'center' | null;

/** A table: its header cells, one alignment per column, and its body rows. */
export interface TableNode {
  readonly type: 'table';
  readonly id: string | null;
  readonly fp: string | null;
  readonly align: readonly Align[];
  readonly header: readonly Inline[];
  readonly rows: readonly Row[];
}

/** A mermaid fence, or a captioned fence of another language: a `<figure>` in the HTML. */
export interface FigureNode {
  readonly type: 'figure';
  readonly id: string | null;
  readonly fp: string | null;
  readonly lang: string | null;
  readonly caption: Inline | null;
  readonly wide: boolean;
  readonly code: string;
}

/**
 * A `<details>` holding a sketch: a fence with a summary (`form: 'code'`) or a
 * blockquote that opens with its bold summary (`form: 'prose'`).
 */
export interface SketchNode {
  readonly type: 'sketch';
  readonly id: string | null;
  readonly fp: string | null;
  readonly form: 'code' | 'prose';
  readonly lang: string | null;
  readonly summary: Inline | null;
  readonly caption: Inline | null;
  readonly wide: boolean;
  readonly code: string | null;
  readonly content: readonly Flow[];
}

/** A fence with neither summary nor caption. */
export interface CodeNode {
  readonly type: 'code';
  readonly id: string | null;
  readonly fp: string | null;
  readonly lang: string | null;
  readonly code: string;
}

/** A blockquote that is no sketch: it has no summary of its own. */
export interface QuoteNode {
  readonly type: 'quote';
  readonly id: string | null;
  readonly fp: string | null;
  readonly content: readonly Flow[];
}

/** Markup that carries no fact: raw HTML, a thematic break, a footnote definition; as written. */
export interface HtmlNode {
  readonly type: 'html';
  readonly md: string;
}

/** What a group, an item, a quote or a sketch holds: everything but a group. */
export type Flow = ParagraphNode | HeadingNode | ListNode | TableNode | FigureNode | SketchNode | CodeNode | QuoteNode | HtmlNode;

/** What a block or the intro holds. */
export type BodyNode = Flow | GroupNode;

/** The blocks a marked region can generate. */
export type GeneratedBlock = 'relationships' | 'tour' | 'fluency';

/** One `##` of a page that carries a `block` fact. */
export interface Block {
  /** The block's name: the id of its heading. */
  readonly id: string;
  readonly name: string;
  readonly heading: Inline;
  /** The marked region the block holds, when a generator writes part of it. */
  readonly generated: GeneratedBlock | null;
  readonly content: readonly BodyNode[];
}

/** One link of the page: a markdown link, or a diagram node bound to a page by `click`. */
export interface LinkRef {
  /** The block the link sits in; null in the intro. */
  readonly block: string | null;
  /** The id of the nearest enclosing element that has one, or null. */
  readonly from: string | null;
  readonly via: 'text' | 'click';
  /** A link's words; for a click, the diagram node it is bound to. */
  readonly text: string;
  readonly href: string;
  /** The page the href names, as the caller's `linkTarget` says. */
  readonly to: string | null;
  /** The part of the href after `#`, or null. */
  readonly fragment: string | null;
}

/** The part of a record that is the page's own words. */
export interface Content {
  readonly intro: readonly BodyNode[];
  readonly blocks: readonly Block[];
}

/** What `buildBody` returns: the page's words, where each id is, and every link. */
export interface Body extends Content {
  /** Every element id → the JSON Pointer of the object that carries it, in document order. */
  readonly anchors: Readonly<Record<string, string>>;
  readonly links: readonly LinkRef[];
}

/** What the builder takes from its caller: the one thing it cannot know, which page an href names. */
export interface BuildOptions {
  /** An href on the page → the id of the page it names, or null when it names none. */
  readonly linkTarget: (href: string) => string | null;
}

/** A page the record cannot hold. The message names the line. */
export class RecordError extends Error {}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * The short hash a citation pins an element's words with: the first eight hex
 * digits of the SHA-256 of the basis in Unicode NFC, lower case, every run of
 * whitespace (U+00A0 included) one space, trimmed.
 */
export function fingerprint(basis: string): string {
  const normal = basis.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normal, 'utf8').digest('hex').slice(0, 8);
}

/** A record as the bytes everyone writes: two-space JSON, keys in builder order, one newline at the end. */
export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const CLICK = /\bclick\s+([A-Za-z0-9_]+)\s+"([^"]+)"/g;

/** Every `click <node> "<target>"` line of a diagram's source, in order: the node it binds and where it goes. */
export function clicksIn(source: string): { readonly node: string; readonly href: string }[] {
  return [...source.matchAll(CLICK)].map((m) => ({ node: m[1] as string, href: m[2] as string }));
}

const COMMENTS = /<!--[\s\S]*?-->/g;

/** Is this raw html nothing but comments: markup that shows nothing and says nothing? */
const onlyComments = (html: string): boolean => html.replace(COMMENTS, '').trim() === '';

const idOf = (n: Nodes): string | null => readKb(n)?.id ?? null;

/** The fingerprint of a node that has an id, from a basis read only then; null for one that has none. */
const fpOf = (id: string | null, basis: () => string): string | null => (id === null ? null : fingerprint(basis()));

/**
 * Every non-empty `text` held anywhere in a value of nodes, in document order:
 * the descendants a node with no words of its own is fingerprinted by.
 */
function textsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) textsIn(v, out);
  } else if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    if (typeof o['text'] === 'string' && o['text'] !== '') out.push(o['text']);
    for (const v of Object.values(o)) textsIn(v, out);
  }
  return out;
}

const joined = (value: unknown): string => textsIn(value).join('\n');

/** A fence's caption or summary as the site renders it: `metaInline` into a paragraph, read as `plainText` reads the HTML. */
function metaOf(raw: string): Inline {
  return { text: plainText({ type: 'paragraph', children: metaInline(raw) }), md: raw };
}

/** The line a node starts on, for a message. */
const where = (n: Nodes): string => `line ${String(n.position?.start.line)}`;

/** Where a node sits in the source; a tree parsed without positions cannot be sliced. */
function span(n: Nodes): { start: number; end: number; column: number } {
  const p = n.position;
  if (p?.start.offset === undefined || p.end.offset === undefined) {
    throw new RecordError(`a ${n.type} node has no source position — parse the page with parseKb`);
  }
  return { start: p.start.offset, end: p.end.offset, column: p.start.column };
}

/**
 * A multi-line slice without the prefix its container writes before each
 * continuation line: at most the node's own left margin, of spaces, tabs and
 * `>` marks. A line indented further keeps what is beyond the margin.
 */
function dedent(text: string, column: number): string {
  if (!text.includes('\n')) return text;
  const margin = new RegExp(`^[ \\t>]{0,${String(column - 1)}}`);
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.replace(margin, '')))
    .join('\n');
}

/** The source without its trailing `{#id}` suffix, when it ends in one the grammar accepts: a refused group stays text. */
function withoutSuffix(md: string): string {
  const cut = splitTrailingSuffix(md);
  if (cut === null) return md;
  try {
    parseSuffix(cut.suffix, 'inline');
  } catch {
    return md;
  }
  return cut.text;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** A root-level node, and the marked region it sits in. */
interface Entry {
  readonly node: RootContent;
  readonly region: string | null;
}

/** One block as the page's root holds it: its heading, then everything up to the next block. */
interface Segment {
  readonly name: string;
  readonly heading: Heading;
  readonly entries: Entry[];
}

interface Ctx {
  readonly source: string;
  readonly linkTarget: (href: string) => string | null;
  readonly links: LinkRef[];
  /** The ids of the elements being built, outermost first; null for one with no id. */
  readonly stack: (string | null)[];
  block: string | null;
  /** Whether the links of the root node being built count: not inside a marked region. */
  linked: boolean;
}

/** Note a link, unless it sits in a marked region: a generator's typed carriers are not the page's own links. */
function addLink(c: Ctx, via: LinkRef['via'], text: string, href: string): void {
  if (!c.linked) return;
  const fragment = splitTarget(href).fragment;
  c.links.push({
    block: c.block,
    from: c.stack.findLast((id): id is string => id !== null) ?? null,
    via,
    text,
    href,
    to: c.linkTarget(href),
    fragment: fragment === '' ? null : fragment,
  });
}

/** Every link under a node, in document order. */
function linksOf(c: Ctx, holder: Nodes): void {
  const walk = (n: Nodes): void => {
    if (n.type === 'link') addLink(c, 'text', plainText(n), n.url);
    else if ('children' in n) for (const k of n.children as Nodes[]) walk(k);
  };
  walk(holder);
}

/** A holder of phrasing content as its words and its markdown, its links noted. */
function inlineOf(c: Ctx, holder: Paragraph | Heading | TableCell, strip: boolean): Inline {
  linksOf(c, holder);
  const text = plainText(holder);
  const first = holder.children[0];
  const last = holder.children.at(-1);
  if (first === undefined || last === undefined) return { text, md: '' };
  const raw = c.source.slice(span(first).start, span(last).end);
  return { text, md: dedent(strip ? withoutSuffix(raw) : raw, span(holder).column) };
}

function paragraphNode(c: Ctx, p: Paragraph): ParagraphNode {
  const id = idOf(p);
  c.stack.push(id);
  const { text, md } = inlineOf(c, p, true);
  c.stack.pop();
  return { type: 'paragraph', id, fp: fpOf(id, () => text), text, md };
}

function headingNode(c: Ctx, h: Heading): HeadingNode {
  const id = idOf(h);
  c.stack.push(id);
  const { text, md } = inlineOf(c, h, true);
  c.stack.pop();
  return { type: 'heading', id, fp: fpOf(id, () => text), depth: h.depth, text, md };
}

function itemNode(c: Ctx, item: ListItem): Item {
  const id = idOf(item);
  c.stack.push(id);
  const first = item.children[0];
  const para = first?.type === 'paragraph' ? first : undefined;
  const { text, md } = para === undefined ? { text: '', md: '' } : inlineOf(c, para, true);
  const head = para?.children[0];
  const content = flow(c, para === undefined ? item.children : item.children.slice(1));
  c.stack.pop();
  return {
    id,
    fp: fpOf(id, () => text || joined(content)),
    text,
    md,
    lead: head?.type === 'strong' ? plainText(head) : null,
    checked: item.checked ?? null,
    content,
  };
}

function listNode(c: Ctx, l: List): ListNode {
  const id = idOf(l);
  c.stack.push(id);
  const items = l.children.map((item) => itemNode(c, item));
  c.stack.pop();
  return { type: 'list', id, fp: fpOf(id, () => joined(items)), ordered: l.ordered === true, start: l.start ?? null, items };
}

/** A row's cells; only the last one can end in the row's `{#id}` suffix. */
function cellsOf(c: Ctx, row: TableRow): Inline[] {
  return row.children.map((cell, i) => inlineOf(c, cell, i === row.children.length - 1));
}

function rowNode(c: Ctx, row: TableRow): Row {
  const id = idOf(row);
  c.stack.push(id);
  const cells = cellsOf(c, row);
  c.stack.pop();
  return { id, fp: fpOf(id, () => joined(cells)), cells };
}

function tableNode(c: Ctx, t: Table): TableNode {
  const id = idOf(t);
  c.stack.push(id);
  const [head, ...body] = t.children as [TableRow, ...TableRow[]];
  const header = cellsOf(c, head);
  const rows = body.map((row) => rowNode(c, row));
  c.stack.pop();
  return { type: 'table', id, fp: fpOf(id, () => joined([header, rows])), align: t.align as readonly Align[], header, rows };
}

/** A fence as the one node its HTML rendering is. */
function fenceNode(c: Ctx, code: Code): FigureNode | SketchNode | CodeNode {
  const d = readKb(code);
  const id = idOf(code);
  const lang = code.lang ?? null;
  const caption = d?.caption === undefined ? null : metaOf(d.caption);
  const wide = d?.wide === true;
  const figure = (): FigureNode => ({
    type: 'figure',
    id,
    fp: fpOf(id, () => caption?.text || code.value),
    lang,
    caption,
    wide,
    code: code.value,
  });
  if (lang === 'mermaid') {
    c.stack.push(id);
    for (const click of clicksIn(code.value)) addLink(c, 'click', click.node, click.href);
    c.stack.pop();
    return figure();
  }
  if (d?.summary !== undefined) {
    const summary = metaOf(d.summary);
    return {
      type: 'sketch',
      id,
      fp: fpOf(id, () => summary.text || code.value),
      form: 'code',
      lang,
      summary,
      caption,
      wide,
      code: code.value,
      content: [],
    };
  }
  if (caption !== null) return figure();
  return { type: 'code', id, fp: fpOf(id, () => code.value), lang, code: code.value };
}

/** Does a blockquote open with one bold run and nothing else: the summary of a prose sketch? */
const opensWithSummary = (first: Blockquote['children'][number] | undefined): first is Paragraph =>
  first?.type === 'paragraph' && first.children.length === 1 && first.children[0]?.type === 'strong';

function quoteNode(c: Ctx, q: Blockquote): SketchNode | QuoteNode {
  const id = idOf(q);
  c.stack.push(id);
  const first = q.children[0];
  const lead = opensWithSummary(first) ? first : null;
  let node: SketchNode | QuoteNode;
  if (lead !== null || first?.type === 'thematicBreak') {
    const summary = lead === null ? null : inlineOf(c, lead, true);
    const content = flow(c, q.children.slice(1));
    node = {
      type: 'sketch',
      id,
      fp: fpOf(id, () => summary?.text || joined(content)),
      form: 'prose',
      lang: null,
      summary,
      caption: null,
      wide: false,
      code: null,
      content,
    };
  } else {
    const content = flow(c, q.children);
    const words = content[0]?.type === 'paragraph' ? content[0].text : '';
    node = { type: 'quote', id, fp: fpOf(id, () => words || joined(content)), content };
  }
  c.stack.pop();
  return node;
}

function htmlNode(c: Ctx, node: RootContent): HtmlNode | null {
  if (node.type === 'html' && onlyComments(node.value)) return null;
  const at = span(node);
  return { type: 'html', md: dedent(c.source.slice(at.start, at.end), at.column) };
}

/** One node below the root as its record node; null for one that shows nothing. */
function convert(c: Ctx, node: RootContent): Flow | null {
  switch (node.type) {
    case 'paragraph':
      return paragraphNode(c, node);
    case 'heading':
      return headingNode(c, node);
    case 'list':
      return listNode(c, node);
    case 'table':
      return tableNode(c, node);
    case 'code':
      return fenceNode(c, node);
    case 'blockquote':
      return quoteNode(c, node);
    case 'definition':
      return null;
    default:
      return htmlNode(c, node);
  }
}

/** The nodes inside an item, a quote or a sketch, in order. */
function flow(c: Ctx, nodes: readonly RootContent[]): Flow[] {
  return nodes.flatMap((node) => convert(c, node) ?? []);
}

/** The root-level nodes of a group, in order, each under its own region. */
function flowEntries(c: Ctx, entries: readonly Entry[]): Flow[] {
  return entries.flatMap((e) => {
    c.linked = e.region === null;
    return convert(c, e.node) ?? [];
  });
}

// ---------------------------------------------------------------------------
// Groups: where a `###` section ends
// ---------------------------------------------------------------------------

/** The fact that makes an H3 a group, or null. A polarity wins over a requirement, as `mintIds` reads them. */
function groupOf(node: RootContent): { fact: GroupFact; value: string } | null {
  if (node.type !== 'heading' || node.depth !== 3) return null;
  const facts = readKb(node)?.facts;
  const polarity = facts?.['polarity'];
  if (polarity !== undefined) return { fact: 'polarity', value: polarity };
  const requirement = facts?.['requirement'];
  return requirement === undefined ? null : { fact: 'requirement', value: requirement };
}

/** A heading of depth three or less ends the group above it. */
const endsGroup = (e: Entry): boolean => e.node.type === 'heading' && e.node.depth <= 3;

/** Does the node show anything? A link reference definition and a comment do not. */
const visible = (e: Entry): boolean => e.node.type !== 'definition' && !(e.node.type === 'html' && onlyComments(e.node.value));

/**
 * How many of a polarity group's nodes stay inside it: all, unless a list is
 * followed by something that shows, in which case the group closes after its
 * last list and what follows belongs to the block (dialect X-06; the HTML
 * pass is `groupEnd` in site-portable.ts).
 */
function closesAfterList(body: readonly Entry[]): number {
  const last = body.findLastIndex((e) => e.node.type === 'list');
  return last >= 0 && body.slice(last + 1).some(visible) ? last + 1 : body.length;
}

function groupNode(c: Ctx, head: Entry, g: { fact: GroupFact; value: string }, content: readonly Entry[]): GroupNode {
  const h = head.node as Heading;
  const id = idOf(h);
  c.linked = head.region === null;
  c.stack.push(id);
  const { text, md } = inlineOf(c, h, true);
  c.stack.pop();
  return {
    type: 'group',
    fact: g.fact,
    value: g.value,
    heading: { id, fp: fpOf(id, () => text), text, md },
    content: flowEntries(c, content),
  };
}

/**
 * The nodes of a block or of the intro. A polarity or requirement `###` takes
 * the nodes up to the next heading of depth three or less, less what X-06
 * hands back to the block.
 */
function sequence(c: Ctx, entries: readonly Entry[]): BodyNode[] {
  const out: BodyNode[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i] as Entry;
    const g = groupOf(entry.node);
    if (g === null) {
      c.linked = entry.region === null;
      const converted = convert(c, entry.node);
      if (converted !== null) out.push(converted);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < entries.length && !endsGroup(entries[end] as Entry)) end += 1;
    const body = entries.slice(i + 1, end);
    const kept = g.fact === 'polarity' ? closesAfterList(body) : body.length;
    out.push(groupNode(c, entry, g, body.slice(0, kept)));
    i += 1 + kept;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The page: title, intro, blocks, regions
// ---------------------------------------------------------------------------

/** The region after a marker line, or the error that says the markers do not pair. */
function moved(region: string | null, name: string, edge: string, node: RootContent): string | null {
  if (edge === 'start') {
    if (region !== null) throw new RecordError(`${where(node)}: the region "${name}" starts inside the region "${region}"`);
    return name;
  }
  if (region !== name) throw new RecordError(`${where(node)}: the region "${name}" ends where none of that name is open`);
  return null;
}

/** Cut the root into the intro and the blocks, consuming the title and the region markers. */
function split(tree: Root): { intro: Entry[]; blocks: Segment[] } {
  const intro: Entry[] = [];
  const blocks: Segment[] = [];
  let region: string | null = null;
  let titled = false;
  for (const node of tree.children) {
    if (node.type === 'html') {
      const m = MARKER_PATTERN.exec(node.value.trim());
      if (m !== null) {
        region = moved(region, m[1] as string, m[2] as string, node);
        continue;
      }
    }
    if (node.type === 'heading' && node.depth <= 2) {
      const name = node.depth === 2 ? readKb(node)?.facts?.['block'] : undefined;
      if (name !== undefined) {
        if (region !== null) {
          throw new RecordError(`${where(node)}: the region "${region}" is still open at the "${name}" block — a region lies inside one block`);
        }
        blocks.push({ name, heading: node, entries: [] });
        continue;
      }
      if (node.depth === 1 && !titled && blocks.length === 0) {
        titled = true;
        continue;
      }
      if (blocks.length > 0) {
        throw new RecordError(`${where(node)}: a heading of depth ${String(node.depth)} with no block fact comes after the "${(blocks.at(-1) as Segment).name}" block`);
      }
    }
    (blocks.at(-1)?.entries ?? intro).push({ node, region });
  }
  if (region !== null) throw new RecordError(`the region "${region}" is never closed`);
  return { intro, blocks };
}

const GENERATED: ReadonlySet<string> = new Set<GeneratedBlock>(['relationships', 'tour', 'fluency']);

function blockNode(c: Ctx, segment: Segment): Block {
  const { name } = segment;
  c.block = name;
  c.linked = true;
  const heading = inlineOf(c, segment.heading, true);
  const content = sequence(c, segment.entries);
  const regions = [...new Set(segment.entries.flatMap((e) => (e.region === null ? [] : [e.region])))];
  if (regions.length > 0 && !(regions.length === 1 && regions[0] === name && GENERATED.has(name))) {
    throw new RecordError(`${where(segment.heading)}: the block "${name}" holds the region ${regions.map((r) => `"${r}"`).join(', ')}`);
  }
  return { id: name, name, heading, generated: regions.length === 0 ? null : (name as GeneratedBlock), content };
}

/**
 * The body of a page. `tree` is what `parseKb` returned for `source`, which is
 * the exact text it was parsed from (the page minus its frontmatter): the
 * markdown of every node is cut from it by position.
 */
export function buildBody(tree: Root, source: string, opts: BuildOptions): Body {
  const c: Ctx = { source, linkTarget: opts.linkTarget, links: [], stack: [], block: null, linked: true };
  const { intro, blocks } = split(tree);
  const content: Content = { intro: sequence(c, intro), blocks: blocks.map((segment) => blockNode(c, segment)) };
  return { ...content, anchors: anchorsOf(content), links: c.links };
}

// ---------------------------------------------------------------------------
// Where each id is, and the element list
// ---------------------------------------------------------------------------

/** An element as `deriveElements` lists it: its id and its own text. */
export interface FlatElement {
  readonly id: string;
  readonly text: string;
}

interface Located extends FlatElement {
  readonly pointer: string;
}

/**
 * Every id-bearing node of a body in document order, with where it sits and the
 * text `deriveElements` gives the same element of the same page. A list and a
 * table have no text; a row's is its cells joined by ` | `; a mermaid figure's
 * is its caption and a code sketch's its summary, both as the fence wrote them
 * (code spans in backticks); a captioned fence of another language and a plain
 * one have none; a quote's is its first paragraph's.
 */
function located(body: Content): Located[] {
  const out: Located[] = [];
  const add = (id: string | null, pointer: string, text: string): void => {
    if (id !== null) out.push({ id, pointer, text });
  };
  const each = (nodes: readonly BodyNode[], pointer: string): void => nodes.forEach((n, i) => visit(n, `${pointer}/${String(i)}`));
  const visit = (n: BodyNode, pointer: string): void => {
    switch (n.type) {
      case 'paragraph':
      case 'heading':
        add(n.id, pointer, n.text);
        return;
      case 'group':
        add(n.heading.id, `${pointer}/heading`, n.heading.text);
        each(n.content, `${pointer}/content`);
        return;
      case 'list':
        add(n.id, pointer, '');
        n.items.forEach((item, i) => {
          const at = `${pointer}/items/${String(i)}`;
          add(item.id, at, item.text);
          each(item.content, `${at}/content`);
        });
        return;
      case 'table':
        add(n.id, pointer, '');
        n.rows.forEach((row, i) => add(row.id, `${pointer}/rows/${String(i)}`, row.cells.map((cell) => cell.text).join(' | ')));
        return;
      case 'figure':
        add(n.id, pointer, n.lang === 'mermaid' && n.caption !== null ? n.caption.md : '');
        return;
      case 'sketch':
        add(n.id, pointer, n.summary === null ? '' : n.form === 'code' ? n.summary.md : n.summary.text);
        each(n.content, `${pointer}/content`);
        return;
      case 'code':
        add(n.id, pointer, '');
        return;
      case 'quote':
        add(n.id, pointer, n.content[0]?.type === 'paragraph' ? n.content[0].text : '');
        each(n.content, `${pointer}/content`);
        return;
      case 'html':
        return;
    }
  };
  each(body.intro, '/intro');
  body.blocks.forEach((b, i) => {
    const at = `/blocks/${String(i)}`;
    add(b.id, at, b.heading.text);
    each(b.content, `${at}/content`);
  });
  return out;
}

/**
 * Every id of a body → the JSON Pointer of the object that carries it, in
 * document order. The pointer reads from a record whose `intro` and `blocks`
 * are top-level keys, so a record that keeps only some of a page's blocks takes
 * the anchors of what it keeps. Throws `RecordError` for an id on two elements.
 */
export function anchorsOf(body: Content): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of located(body)) {
    if (Object.hasOwn(out, e.id)) throw new RecordError(`the id "${e.id}" is on two elements, ${out[e.id]} and ${e.pointer}`);
    out[e.id] = e.pointer;
  }
  return out;
}

/**
 * Every id-bearing node of a body, in document order, with the text
 * `deriveElements` (kb-attrs.ts) gives the same element of the same page: the
 * invariant that lets the `.md` sibling be compared with the record.
 */
export function flatten(body: Content): FlatElement[] {
  return located(body).map(({ id, text }) => ({ id, text }));
}
