/**
 * One page read the way kb.mjs v2 reads it: the body parsed through
 * tools/src/lib/kb-attrs.ts (the one reading of the dialect — suffixes,
 * section facts, positional ids), split into its blocks by the `block` fact
 * on each `##`, with the generated marked regions (`relationships`, `tour`,
 * `fluency`) told apart from hand-written prose.
 *
 * Rendering the text a reader sees is tools/src/kb/render.ts; this module
 * owns the structure and the few facts other commands read off it: the prose
 * links a mention is taken from, the mermaid `click` targets, and the
 * writer-owned blocks dumped in the writers' shape.
 */

import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import {
  MARKER_PATTERN,
  parseKb,
  plainText,
  readKb,
  type KbProblem,
  type ListItem,
  type Nodes,
  type Paragraph,
  type PhrasingContent,
  type Root,
  type RootContent,
} from '../lib/kb-attrs.js';
import { clicksIn } from '../lib/kb-record.js';

export interface Block {
  readonly name: string;
  /** The `##` heading's text. */
  readonly heading: string;
  /** The nodes after the block's `##`, up to the next `#` or `##`. */
  readonly nodes: readonly RootContent[];
}

export interface PageDoc {
  readonly tree: Root;
  /**
   * The markdown the tree was parsed from: the page less its frontmatter. Every
   * node's source position is an offset into this text, so a node's own words
   * are `source.slice(start, end)`.
   */
  readonly source: string;
  readonly problems: readonly KbProblem[];
  /** The page's `#` title, or null. */
  readonly h1: string | null;
  /** What sits between the title and the first block. */
  readonly intro: readonly RootContent[];
  readonly blocks: readonly Block[];
  /** The marked region a root node sits in. */
  readonly regionOf: ReadonlyMap<RootContent, string>;
}

/**
 * A leading frontmatter block, fences included, as scripts/lib-frontmatter.sh
 * reads one: a `---` line (trailing blanks allowed) up to the next, LF or CRLF.
 */
export const FRONTMATTER = /^---[ \t]*\r?\n(?:[^]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** The markdown after a leading frontmatter block: the frontmatter door reads that part. */
export function stripFrontmatter(text: string): string {
  const m = FRONTMATTER.exec(text);
  return m === null ? text : text.slice(m[0].length);
}

/** Parse a page (frontmatter and all) into its blocks. */
export function parsePage(text: string): PageDoc {
  const source = stripFrontmatter(text);
  const { tree, problems } = parseKb(source);
  const regionOf = new Map<RootContent, string>();
  const blocks: { name: string; heading: string; nodes: RootContent[] }[] = [];
  const intro: RootContent[] = [];
  let h1: string | null = null;
  let current: { name: string; heading: string; nodes: RootContent[] } | null = null;
  let region: string | null = null;
  for (const node of tree.children) {
    if (node.type === 'html') {
      const m = MARKER_PATTERN.exec(node.value.trim());
      if (m !== null) {
        if (m[2] === 'start' && region === null) region = m[1] as string;
        else if (m[2] === 'end' && region === m[1]) region = null;
        continue;
      }
    }
    if (node.type === 'heading' && node.depth <= 2) {
      if (node.depth === 1 && h1 === null && current === null) {
        h1 = inline(node);
        continue;
      }
      const name = node.depth === 2 ? readKb(node)?.facts?.['block'] : undefined;
      current = name === undefined ? null : { name, heading: inline(node), nodes: [] };
      if (current !== null) blocks.push(current);
      continue;
    }
    if (region !== null) regionOf.set(node, region);
    if (current !== null) current.nodes.push(node);
    else if (blocks.length === 0) intro.push(node);
  }
  return { tree, source, problems, h1, intro, blocks, regionOf };
}

/** A node's plain text as scripts/kb.mjs printed it: every whitespace run one space, trimmed. */
export function inline(node: Nodes): string {
  return plainText(node).replace(/\s+/g, ' ').trim();
}

/** The text of phrasing nodes, as `inline` reads a whole node. */
export function inlineOf(children: readonly PhrasingContent[]): string {
  return inline({ type: 'paragraph', children: [...children] } as Paragraph);
}

/**
 * Markdown inline text (a relation note, a tour role as a data file holds it)
 * as the plain words a reader sees. Parsed as the tail of a paragraph, so a
 * note that starts with `1.` or `#` is not read as a list or a heading.
 */
export function mdPlain(md: string): string {
  if (md === '') return '';
  const first = unified().use(remarkParse).use(remarkGfm).parse(`x ${md}`).children[0] as Nodes;
  return inline(first).slice(1).trim();
}

/** Every link url in a node, in document order. */
export function linksIn(node: Nodes, out: string[] = []): string[] {
  if (node.type === 'link') out.push(node.url);
  if ('children' in node) for (const c of node.children as Nodes[]) linksIn(c, out);
  return out;
}

/**
 * The hand-written links a reader follows in prose, in document order: every
 * link outside the marked regions and the siblings rows (typed carriers, as
 * scripts/lib/model.mjs PROSE_LINK_EXCLUDE kept `[data-kb-rel]`,
 * `[data-kb-member]` and `.fluency-item` out).
 */
export function proseLinks(doc: PageDoc): string[] {
  const out: string[] = [];
  const skip = new Set<RootContent>();
  for (const b of doc.blocks) if (b.name === 'siblings') for (const n of b.nodes) if (n.type === 'list') skip.add(n);
  for (const node of doc.tree.children) {
    if (doc.regionOf.has(node) || skip.has(node)) continue;
    linksIn(node, out);
  }
  return out;
}

/** Every mermaid `click` target on the page, in document order. */
export function clickTargets(doc: PageDoc): string[] {
  const out: string[] = [];
  const walk = (n: Nodes): void => {
    if (n.type === 'code' && n.lang === 'mermaid') for (const click of clicksIn(n.value)) out.push(click.href);
    if ('children' in n) for (const c of n.children as Nodes[]) walk(c);
  };
  walk(doc.tree);
  return out;
}

/** The explain block in the writer's own shape, or null when the page has none. */
export interface ExplainItems {
  readonly text: string;
  /** The costs list, when the block has one: each bullet's bold lead and the rest, a link in it kept as `[label](target)`. */
  readonly costs?: readonly { readonly lead: string; readonly note: string }[];
  readonly example: string;
  /** Set when the example is a fenced sketch: its language and caption. */
  readonly exampleLang?: string;
  readonly exampleCaption?: string;
}

/**
 * Phrasing as the explain writer takes it back, whitespace collapsed, a link
 * kept as `[label](target)`: the form `--text` and a costs note are written
 * from, so a dump handed to the writer reads back as it was.
 */
function linkedOf(children: readonly PhrasingContent[]): string {
  const walk = (n: Nodes): string => {
    if (n.type === 'link') return `[${n.children.map(walk).join('')}](${n.url})`;
    if (n.type === 'text' || n.type === 'inlineCode') return n.value;
    if (n.type === 'break') return ' ';
    return 'children' in n ? (n.children as Nodes[]).map(walk).join('') : plainText(n);
  };
  return children.map(walk).join('').replace(/\s+/g, ' ').trim();
}

/** The explain block's paragraph, costs and example, as `kb.mjs explain --text … --costs … --example …` takes them. */
export function explainItems(doc: PageDoc): ExplainItems | null {
  const block = blockNamed(doc, 'explain');
  if (block === undefined) return null;
  const content = block.nodes.filter((n) => n.type !== 'html');
  const [text, ...afterText] = content;
  const list = afterText[0]?.type === 'list' ? afterText[0] : undefined;
  const example = list === undefined ? afterText[0] : afterText[1];
  const body = text?.type === 'paragraph' ? linkedOf(text.children) : '';
  const costs =
    list === undefined
      ? {}
      : {
          costs: list.children.map((item) => {
            const para = item.children[0];
            const kids = para?.type === 'paragraph' ? para.children : [];
            const bold = kids[0]?.type === 'strong';
            return { lead: bold ? inlineOf(kids.slice(0, 1)) : '', note: linkedOf(bold ? kids.slice(1) : kids) };
          }),
        };
  if (example?.type === 'code') {
    const caption = readKb(example)?.caption;
    return { text: body, ...costs, example: example.value, exampleLang: example.lang ?? '', ...(caption === undefined ? {} : { exampleCaption: caption }) };
  }
  return { text: body, ...costs, example: example?.type === 'paragraph' ? inline(example).replace(/^Example\.\s*/, '') : '' };
}

/** The block by name (the last of that name, as scripts/kb.mjs kept it). */
export function blockNamed(doc: PageDoc, name: string): Block | undefined {
  return [...doc.blocks].reverse().find((b) => b.name === name);
}

// ---------------------------------------------------------------------------
// Writer-owned blocks, dumped in the writers' own --items shape
// ---------------------------------------------------------------------------

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Inline markdown as the rich text the writers take: text escaped, a code
 * span as `<code>`, whitespace collapsed. The one inline tag the writers let
 * through is `<code>`; anything else (a link, bold, raw html) keeps its
 * markup so a round trip shows it rather than losing it.
 */
export function rich(children: readonly PhrasingContent[]): string {
  const walk = (n: Nodes): string => {
    switch (n.type) {
      case 'text':
        return escapeHtml(n.value);
      case 'inlineCode':
        return `<code>${escapeHtml(n.value)}</code>`;
      case 'strong':
        return `<strong>${n.children.map(walk).join('')}</strong>`;
      case 'link':
        return `<a href="${n.url}">${n.children.map(walk).join('')}</a>`;
      case 'break':
        return '<br>';
      case 'html':
        return n.value;
      default:
        return 'children' in n ? (n.children as Nodes[]).map(walk).join('') : '';
    }
  };
  return children.map(walk).join('').replace(/\s+/g, ' ').trim();
}

/** The phrasing after a leading bold label, its ` — ` lead dropped. */
function afterLead(children: readonly PhrasingContent[]): PhrasingContent[] {
  const rest = children.slice(1).map((c) => ({ ...c }));
  const first = rest[0];
  if (first?.type === 'text') first.value = first.value.replace(/^\s*—\s*/, '');
  return rest;
}

function firstParagraph(item: ListItem): Paragraph | undefined {
  const first = item.children[0];
  return first?.type === 'paragraph' ? first : undefined;
}

export interface WildItem {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly href?: string;
}

/** The wild block's examples, or null when the page has none. */
export function wildItems(doc: PageDoc): WildItem[] | null {
  const block = blockNamed(doc, 'wild');
  if (block === undefined) return null;
  const out: WildItem[] = [];
  for (const list of block.nodes) {
    if (list.type !== 'list') continue;
    for (const item of list.children) {
      const p = firstParagraph(item);
      const kids = p?.children ?? [];
      const head = kids[0]?.type === 'strong' ? kids[0] : undefined;
      const link = head?.children.length === 1 && head.children[0]?.type === 'link' ? head.children[0] : undefined;
      out.push({
        id: (readKb(item)?.id ?? '').replace(/^wild-/, ''),
        name: rich(link?.children ?? head?.children ?? []),
        note: rich(head === undefined ? kids : afterLead(kids)),
        ...(link === undefined ? {} : { href: link.url }),
      });
    }
  }
  return out;
}

export interface LabelledItem {
  readonly label: string;
  readonly note: string;
}
export interface GateItem {
  readonly text: string;
}
export interface ProductionItems {
  readonly knobs: LabelledItem[];
  readonly signals: LabelledItem[];
  readonly failures: LabelledItem[];
  readonly checklist: GateItem[];
}

const PROD_GROUPS: Readonly<Record<string, keyof ProductionItems>> = {
  knob: 'knobs',
  signal: 'signals',
  failure: 'failures',
  check: 'checklist',
};

/** The production block's four lists, or null when the page has none. */
export function productionItems(doc: PageDoc): ProductionItems | null {
  const block = blockNamed(doc, 'production');
  if (block === undefined) return null;
  const out: ProductionItems = { knobs: [], signals: [], failures: [], checklist: [] };
  let key: keyof ProductionItems | null = null;
  for (const node of block.nodes) {
    if (node.type === 'heading') {
      key = PROD_GROUPS[readKb(node)?.facts?.['polarity'] ?? ''] ?? null;
      continue;
    }
    if (node.type !== 'list' || key === null) continue;
    for (const item of node.children) {
      const kids = firstParagraph(item)?.children ?? [];
      if (key === 'checklist') {
        out.checklist.push({ text: rich(kids) });
        continue;
      }
      const head = kids[0]?.type === 'strong' ? kids[0] : undefined;
      out[key].push({
        label: rich(head?.children ?? []),
        note: rich(head === undefined ? kids : afterLead(kids)),
      });
    }
  }
  return out;
}
