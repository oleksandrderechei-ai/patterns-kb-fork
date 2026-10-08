/**
 * Ranking for `kb.mjs find` and `brief`, behind ONE function: `rank`. It is a
 * wrapper over the site lane's shared scorer, `rankItems` in
 * tools/src/lib/search-score.ts, the one ranking the repository has (the
 * search box runs it too). `rank` says where a catalog row's facts are and
 * maps each hit back to `{ n, score, why }`; it passes no headings. The stopwords, the
 * query split, the weights, the stemmer and the prose index are the shared
 * scorer's, re-exported under this module's v1 names. What stays here is the
 * CLI's own: the catalog row, the prose lines read from the markdown, and the
 * synonym loader.
 *
 * The synonym bridge is `loadSynonyms`: docs/data/search-synonyms.json, its
 * curated map over its authored expansions, curated winning.
 */

import { readKb, type Nodes, type Paragraph, type RootContent } from '../lib/kb-attrs.js';
import { indexProse, rankItems, type Prose, type Synonyms, type TagLabels } from '../lib/search-score.js';
import { readSynonymTable, SYNONYMS_FILE } from '../lib/search-tree.js';

import { inline, inlineOf, type PageDoc } from './page.js';

export { own, queryTerms, STOP, stemVariant, termVariants, type Synonyms } from '../lib/search-score.js';

export { SYNONYMS_FILE };

/** A catalog row, as scripts/kb.mjs listed it and `find --json` prints it. */
export interface CatalogNode {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly band: string;
  readonly essence: string;
  readonly path: string;
  readonly favourite?: true;
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
  readonly solves?: readonly string[];
  readonly hasExample?: true;
  readonly hasExplain?: true;
}

/** A page's prose, indexed: per word the lines holding it and the first of them, plus its length. */
export type Body = Prose;

/** Index a page's prose lines the way search.mjs `proseIndexer` indexed its text. */
export const indexBody: (lines: readonly string[]) => Body = indexProse;

export interface Scored {
  readonly n: CatalogNode;
  readonly score: number;
  readonly why: string | null;
}

export interface RankInput {
  readonly nodes: readonly CatalogNode[];
  readonly q: string;
  readonly syn: Synonyms;
  /** A page's prose; omit it and only the catalog fields score (the hub's algorithm). */
  readonly bodyOf?: (n: CatalogNode) => Body;
  /** A row's categories (its area chain's labels, then its kind's word); none when omitted. */
  readonly categoriesOf?: (n: CatalogNode) => readonly string[];
  /** Tag id → label: a row's tags are read as ids and as labels. */
  readonly tagLabels?: TagLabels;
  readonly limit?: number;
}

/** Score `q` against `nodes`, best first: the shared scorer over the catalog's facts. */
export function rank({ nodes, q, syn, bodyOf, categoriesOf, tagLabels = {}, limit }: RankInput): Scored[] {
  // No limit, 0 or NaN keeps every hit. kb.mjs never passes 0 or NaN: its `--n` must be a whole number of 1 or more
  // (`limitOf` in tools/src/kb/cli.ts), so only another caller of `rank` reaches this branch.
  const keepAll = limit === undefined || limit === 0 || Number.isNaN(limit);
  return rankItems(nodes, {
    q,
    syn,
    ...(bodyOf === undefined ? {} : { bodyOf }),
    ...(keepAll ? {} : { limit }),
    factsOf: (n) => ({
      id: n.id,
      title: n.name,
      description: n.essence,
      aliases: n.aliases ?? [],
      tags: (n.tags ?? []).flatMap((t) => (Object.prototype.hasOwnProperty.call(tagLabels, t) ? [t, tagLabels[t] as string] : [t])),
      categories: categoriesOf?.(n) ?? [],
      solves: n.solves ?? [],
    }),
  }).map((s) => ({ n: s.item, score: s.score, why: s.why }));
}

// ---------------------------------------------------------------------------
// The prose index
// ---------------------------------------------------------------------------

/**
 * Where a list's rows name another page, `[Title](…) — note`: the generated
 * relationships and fluency regions, and a theme's siblings list — the typed
 * carriers `proseLinks` keeps out of a page's prose links.
 */
const ROW_REGIONS: ReadonlySet<string> = new Set(['relationships', 'fluency']);
const rowsOf = (doc: PageDoc, block: string, node: RootContent): boolean =>
  ROW_REGIONS.has(doc.regionOf.get(node) ?? '') || (block === 'siblings' && node.type === 'list');

/**
 * A generated row's words without the page it names: the link text dropped
 * and the ` — ` that led the note. The title is the neighbour's, not words
 * this page wrote, and indexing it would score the page for every query that
 * names a neighbour (the reason search.mjs kept `.mentions` out of its index).
 */
export function rowNote(node: Paragraph): string {
  return inlineOf(node.children.filter((c) => c.type !== 'link')).replace(/^—\s*/, '');
}

/**
 * A page's prose as lines: the title, the intro, and per block its
 * heading and every element — text, list items, table rows, code — as
 * the HTML reader indexed the page's `main` (mermaid figures left out, as it
 * removed `figure.diagram`). Header chrome the dialect drops (kickers, badges)
 * is not here to index. A row that names another page (`rowsOf`) gives its
 * note only (`rowNote`); a tour step's heading is its own line, as the HTML's
 * `<h3>` was.
 */
export function proseLines(doc: PageDoc): string[] {
  const lines: string[] = [];
  if (doc.h1 !== null) lines.push(doc.h1);
  const visit = (node: Nodes, rows: boolean): void => {
    switch (node.type) {
      case 'paragraph':
        lines.push(rows ? rowNote(node) : inline(node));
        return;
      case 'heading':
      case 'tableCell':
        lines.push(inline(node));
        return;
      case 'code':
        if (node.lang === 'mermaid') return;
        if (readKb(node)?.summary !== undefined) lines.push(readKb(node)?.summary as string);
        lines.push(...node.value.split('\n'));
        return;
      case 'html':
        return;
      default:
        if ('children' in node) for (const c of node.children as Nodes[]) visit(c, rows);
    }
  };
  for (const n of doc.intro) visit(n, false);
  for (const b of doc.blocks) {
    lines.push(b.heading);
    for (const n of b.nodes) visit(n as RootContent, rowsOf(doc, b.name, n));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Synonyms
// ---------------------------------------------------------------------------

/** The synonym bridge `find` scores with: the authored expansions under the curated map; none when the file is absent. */
export async function loadSynonyms(root: string): Promise<Synonyms> {
  return readSynonymTable(root);
}
