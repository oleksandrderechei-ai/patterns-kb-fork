/**
 * What one built page states of its page record, read the way a machine reader
 * holds the HTML, so that a gate can lay the page beside the record
 * (tools/src/gates/check-site-parity.ts) and say where the two stop agreeing.
 *
 * THE LAYER RULE is the one check-site-absence.ts states: a subtree carrying
 * the skip marker is dropped whole; an element with a class is decoration, read
 * through and never read from; a fact is a bare `data-*` on a class-free
 * element. So every fact below is taken from a class-free element, and a
 * classed `section` or `li` that carries one states nothing. What a reader
 * takes from a page that is not a fact is its words, and those are read as
 * `plainText` (tools/src/lib/kb-attrs.ts) reads the markdown: runs of ASCII
 * whitespace one space, the ends trimmed, a no-break space kept as the word
 * character it is.
 *
 *   facts           the article block's `data-page`, `data-area`, `data-tags`,
 *                   `data-kind`, `data-band` and `data-group`; null where the
 *                   page does not state one
 *   blocks          the `data-block` of each block section, in page order
 *   intro           the words of each paragraph that opens the article, above
 *                   the first block
 *   elements        every element carrying an `id` inside the knowledge
 *                   region, in page order, with the block and the group
 *                   section it sits in and the words it shows
 *   relations       the `data-verb` and `data-to` of each list item of the
 *                   relationships block that states them, in page order; an
 *                   element of a vector graphic that carries a `data-to` of its
 *                   own is never read, and nor is an item of another block
 *   prerequisites   the card's `data-requires` and `data-related`, as lists
 *
 * THE WORDS OF AN ELEMENT are what the record keeps as its `text`: a paragraph
 * and a heading show their own; a list item, its first paragraph, or the
 * inline words before its first block; a table row, its cells joined by
 * ` | `; a `<details>`, its own `<summary>`; a `<div>` or `<figure>` that
 * wraps a fence, its class-free `<figcaption>`; a list and a table have none.
 * Inline words include the `<code>` and `<a>` inside them and not the
 * vector graphics, scripts and styles, and a line break shows no space of its
 * own: the text around it does, as the markdown's hard break is followed by a
 * newline.
 *
 * It reads markup and never renders it, and writes nothing. A page with no
 * knowledge region reads as null.
 */

import { parse } from 'parse5';

import { SKIP } from '../gates/check-site-absence.js';
import { REGION } from '../lib/built-page.js';
import { isCardWrapper } from '../lib/site-prerequisites.js';

interface Attr {
  readonly name: string;
  readonly value: string;
}

/** A parse5 element, described locally: it always has its attributes and its children. */
interface El {
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI: string;
  readonly attrs: readonly Attr[];
  readonly childNodes: readonly Node[];
}

interface Text {
  readonly nodeName: '#text';
  readonly value: string;
}

/** A comment or a doctype: neither is markup the reader reads. */
interface Other {
  readonly nodeName: '#comment' | '#documentType';
}

type Node = El | Text | Other;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The block whose list items state the relations of the page's record. */
const RELATIONSHIPS = 'relationships';

/** Elements whose insides are not words and not structure: code the browser runs or draws. */
const NO_WORDS: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript']);

/** Elements the walk does not enter: code and scripts, as the layer rule reads them. */
const OPAQUE: ReadonlySet<string> = new Set([...NO_WORDS, 'pre', 'code', 'math']);

/** Elements that end a list item's own words: what a nested block or a fence is made of. */
const BLOCKS: ReadonlySet<string> = new Set(['ul', 'ol', 'details', 'div', 'figure', 'table', 'p', 'pre', 'blockquote', 'section', 'hr']);

const ASCII_WS = /[ \t\n\r\f]+/g;

/** The facts an article block states, each null when the page does not state it. */
export interface ArticleFacts {
  readonly page: string | null;
  readonly area: string | null;
  readonly tags: string | null;
  readonly kind: string | null;
  readonly band: string | null;
  readonly group: string | null;
}

/** One element of the page that carries an id. */
export interface ReadElement {
  readonly id: string;
  readonly tag: string;
  /** The `data-block` of the section it sits in; null above the first block. */
  readonly block: string | null;
  /** The `data-polarity` or `data-requirement` of the group section it sits in; null outside one. */
  readonly group: string | null;
  readonly text: string;
}

/** One list item that states the relation it shows; a fact the item does not state reads as ''. */
export interface ReadRelation {
  readonly verb: string;
  readonly to: string;
}

/** The prerequisite card's two lists of page ids. */
export interface ReadPrerequisites {
  readonly requires: readonly string[];
  readonly related: readonly string[];
}

/** Everything a page states of its record. */
export interface PageRecordRead {
  readonly facts: ArticleFacts;
  readonly blocks: readonly string[];
  readonly intro: readonly string[];
  readonly elements: readonly ReadElement[];
  readonly relations: readonly ReadRelation[];
  readonly prerequisites: ReadPrerequisites;
}

const NO_FACTS: ArticleFacts = { page: null, area: null, tags: null, kind: null, band: null, group: null };

const isEl = (n: Node): n is El => 'tagName' in n;

const isText = (n: Node): n is Text => n.nodeName === '#text';

const childEls = (el: El): El[] => el.childNodes.filter(isEl);

const attr = (el: El, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;

const classed = (el: El): boolean => el.attrs.some((a) => a.name === 'class');

/** A fact: a value taken from a class-free element, never from a classed one. */
const fact = (el: El, name: string): string | undefined => (classed(el) ? undefined : attr(el, name));

/** A subtree the reader leaves out: marked to skip, or a vector graphic. */
const dropped = (el: El): boolean => el.namespaceURI === SVG_NS || el.attrs.some((a) => a.name === SKIP);

/** The text nodes under a node in order, less every subtree that shows no words. */
function rawText(n: Node): string {
  if (isText(n)) return n.value;
  if (!isEl(n) || dropped(n) || NO_WORDS.has(n.tagName)) return '';
  return n.childNodes.map(rawText).join('');
}

/** Words as HTML shows them, `plainText`'s reading of the same words in the markdown: ASCII whitespace only. */
const normalise = (words: string): string => words.replace(ASCII_WS, ' ').replace(/^ | $/g, '');

const shown = (n: Node): string => normalise(rawText(n));

/** Does a text node hold anything but ASCII whitespace? */
const hasWords = (n: Node): boolean => isText(n) && /[^ \t\n\r\f]/.test(n.value);

/**
 * A list item's own words: its first paragraph when it opens with one, else the
 * inline content before its first block. What follows is an element of its own.
 */
function ownWords(li: El): string {
  const first = li.childNodes.find((n) => isEl(n) || hasWords(n));
  if (first !== undefined && isEl(first) && first.tagName === 'p') return shown(first);
  const before: Node[] = [];
  for (const n of li.childNodes) {
    if (isEl(n) && BLOCKS.has(n.tagName)) break;
    before.push(n);
  }
  return normalise(before.map(rawText).join(''));
}

/** The first class-free element of a tag among an element's children, or among all its descendants. */
function part(el: El, tag: string, deep: boolean): El | undefined {
  for (const c of childEls(el)) {
    if (dropped(c)) continue;
    if (c.tagName === tag && !classed(c)) return c;
    const inside = deep ? part(c, tag, true) : undefined;
    if (inside !== undefined) return inside;
  }
  return undefined;
}

/** The words of a part of an element, or none when it has no such part. */
function partWords(el: El, tag: string, deep: boolean): string {
  const found = part(el, tag, deep);
  return found === undefined ? '' : shown(found);
}

/** The words an element with an id shows: what the record keeps as that element's `text`. */
function wordsOf(el: El): string {
  switch (el.tagName) {
    case 'li':
      return ownWords(el);
    case 'tr':
      return childEls(el)
        .filter((c) => c.tagName === 'th' || c.tagName === 'td')
        .map(shown)
        .join(' | ');
    case 'details':
      return partWords(el, 'summary', false);
    case 'div':
    case 'figure':
      return partWords(el, 'figcaption', true);
    case 'ul':
    case 'ol':
    case 'table':
      return '';
    default:
      return shown(el);
  }
}

/** The block and the group an element sits in. */
interface Scope {
  readonly block: string | null;
  readonly group: string | null;
}

/** The first element carrying the region hook, searched in page order. */
function findRegion(nodes: readonly Node[]): El | null {
  for (const n of nodes) {
    if (!isEl(n)) continue;
    if (n.attrs.some((a) => a.name === REGION)) return n;
    const inside = findRegion(n.childNodes);
    if (inside !== null) return inside;
  }
  return null;
}

/** A card fact's ids: the comma-joined value as a list; none when the card does not state it. */
const idsOf = (el: El, name: string): string[] => (attr(el, name) ?? '').split(',').filter((id) => id !== '');

/** The article block's facts, read from the class-free `<article>` the region holds. */
function factsOf(article: El | undefined): ArticleFacts {
  if (article === undefined) return NO_FACTS;
  const read = (name: string): string | null => fact(article, name) ?? null;
  return {
    page: read('data-page'),
    area: read('data-area'),
    tags: read('data-tags'),
    kind: read('data-kind'),
    band: read('data-band'),
    group: read('data-group'),
  };
}

/** The block a section opens, if any: a class-free `data-block`. */
const blockOf = (el: El): string | undefined => (el.tagName === 'section' ? fact(el, 'data-block') : undefined);

/** The paragraphs that open the article: its `<p>` children above the first block section. */
function introOf(article: El | undefined): string[] {
  if (article === undefined) return [];
  const out: string[] = [];
  for (const c of childEls(article)) {
    if (dropped(c)) continue;
    if (blockOf(c) !== undefined) break;
    if (c.tagName === 'p') out.push(shown(c));
  }
  return out;
}

/** Read one built page; null when it has no knowledge region. */
export function readPageRecord(html: string): PageRecordRead | null {
  const region = findRegion((parse(html) as unknown as { childNodes: Node[] }).childNodes);
  if (region === null) return null;
  const article = childEls(region).find((c) => c.tagName === 'article' && !dropped(c));

  const blocks: string[] = [];
  const elements: ReadElement[] = [];
  const relations: ReadRelation[] = [];
  let prerequisites: ReadPrerequisites = { requires: [], related: [] };

  const visit = (el: El, outer: Scope): void => {
    for (const child of childEls(el)) {
      if (dropped(child)) continue;
      let scope = outer;
      if (child.tagName === 'section') {
        const block = blockOf(child);
        const group = fact(child, 'data-polarity') ?? fact(child, 'data-requirement');
        if (block !== undefined) blocks.push(block);
        // A block starts a scope of its own; a group narrows the one it sits in.
        scope = block === undefined ? { block: outer.block, group: group ?? outer.group } : { block, group: group ?? null };
      }
      const id = attr(child, 'id');
      if (id !== undefined) elements.push({ id, tag: child.tagName, block: scope.block, group: scope.group, text: wordsOf(child) });
      if (child.tagName === 'li' && scope.block === RELATIONSHIPS) {
        const verb = fact(child, 'data-verb');
        const to = fact(child, 'data-to');
        if (verb !== undefined || to !== undefined) relations.push({ verb: verb ?? '', to: to ?? '' });
      }
      if (child.tagName === 'div' && isCardWrapper(child.attrs)) {
        prerequisites = { requires: idsOf(child, 'data-requires'), related: idsOf(child, 'data-related') };
      }
      if (!OPAQUE.has(child.tagName)) visit(child, scope);
    }
  };
  visit(region, { block: null, group: null });

  return { facts: factsOf(article), blocks, intro: introOf(article), elements, relations, prerequisites };
}
