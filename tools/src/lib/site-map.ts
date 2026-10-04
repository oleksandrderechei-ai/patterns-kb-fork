/**
 * What the map page draws, worked out from the data files and the pages
 * (the `map` area of docs/data/site-structure.json):
 *
 *   stackData   the pattern-to-product index: every pattern, in reading order,
 *               against the cloud product that sells it — today's
 *               scripts/build-stack-page.mjs, read from docs/ instead of site/.
 *               A pattern a capability `implements` with a pinned mapping row
 *               shows that row's four service cells, copied; one with no pin
 *               links the capability's whole table; the rest are dashes. A dash
 *               is a verdict only where docs/data/stack.json gives one: a band
 *               note, or a pattern's own reason, says no cloud sells it by
 *               nature (state `none`); every other dash records a gap in the
 *               index, never a verdict on the market. A comparison that
 *               implements the pattern rides along as a chip.
 *
 * It reads `root` and writes nothing: the site component that draws it
 * (site/src/components/StackIndex) calls it at build time.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { PhrasingContent, Root, TableRow } from 'mdast';
import rehypeStringify from 'rehype-stringify';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import { parseKb, readKb } from './kb-attrs.js';
import { resolveTarget } from './links.js';
import { areaChain, fromPageTree, placedPages, type PlacedPage, type Structure, type StructureArea } from './site-routes.js';

export const STRUCTURE = 'docs/data/site-structure.json';
export const RELATIONS = 'docs/data/relations.json';
/** Which dashes are verdicts: the bands, and the single patterns, no cloud sells by nature. */
export const STACK = 'docs/data/stack.json';
/** The product registry: provider → the name a mapping cell says → its documentation URL. */
export const PRODUCTS = 'docs/data/products.json';

/** The top area the patterns sit under; its children are the bands of the stack index. */
export const PATTERNS = 'patterns';
export const CAPABILITIES = 'capabilities';
export const COMPARISONS = 'comparisons';

/** A relation record, as far as the maps read one. */
export interface Relation {
  readonly a: string;
  readonly verb: string;
  readonly b: string;
  readonly maps_a?: string;
}

/** The published pages of the page tree, each with its kind. */
function treePages(structure: Structure): (PlacedPage & { kind: StructureArea })[] {
  return placedPages(structure)
    .filter(fromPageTree)
    .map((p) => ({ ...p, kind: areaChain(structure, p.area)[0] as StructureArea }));
}

const readJson = <T>(root: string, rel: string): T => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as T;

// ---------------------------------------------------------------------------
// The stack index
// ---------------------------------------------------------------------------

/** The four service columns a mapping row carries after its label, and their headings. */
export const SERVICE_COLUMNS: readonly { readonly provider: string; readonly label: string }[] = [
  { provider: 'aws', label: 'AWS' },
  { provider: 'azure', label: 'Azure' },
  { provider: 'google', label: 'Google Cloud' },
  { provider: 'oss', label: 'Open source' },
];

export const DASH = '—';

/**
 * The dashes that are verdicts (docs/data/stack.json): `bands` maps a band's
 * area id to the note that says why no row in it is for sale, and `patterns`
 * maps one pattern's slug to the reason no cloud sells it. A claim leaves the
 * file the moment a capability implements the pattern: `buildStack` refuses
 * it rather than print it wrong.
 */
export interface StackNotes {
  readonly bands: Readonly<Record<string, string>>;
  readonly patterns: Readonly<Record<string, string>>;
}

export const NO_NOTES: StackNotes = { bands: {}, patterns: {} };

/** A link to a page: its title and route (a fragment kept). */
export interface StackLink {
  readonly title: string;
  readonly href: string;
}

export interface StackRow {
  /** The row's anchor: `stack-<pattern>`, then `-2`, `-3` for a pattern's later rows. */
  readonly id: string;
  readonly pattern: StackLink;
  /**
   * `mapped`: a pinned mapping row's cells. `linked`: a capability implements
   * the pattern with no row pinned, so every cell links its whole table.
   * `none`: no capability does, and stack.json says none sells it by nature.
   * `gap`: no capability does, and nothing says why.
   */
  readonly state: 'mapped' | 'linked' | 'none' | 'gap';
  /** Why no cloud sells the pattern, on a `none` row whose band carries no note of its own. */
  readonly reason?: string;
  /** Where the cells come from: the mapping row's own label, or the capability's name. */
  readonly source?: StackLink & { readonly html: string };
  /** Four cells of inner HTML, one per service column. */
  readonly cells: readonly string[];
  /** The comparisons arguing the product choice, on the pattern's first row only. */
  readonly compare: readonly (StackLink & { readonly criterion?: string })[];
}

export interface StackGroup {
  /** A band's group label; absent when the band is not subdivided. */
  readonly label?: string;
  readonly rows: readonly StackRow[];
}

export interface StackBand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly unbuyable?: string;
  readonly groups: readonly StackGroup[];
}

export interface StackData {
  readonly bands: readonly StackBand[];
  /** Patterns listed, and how many of them a capability or a comparison implements. */
  readonly patterns: number;
  readonly covered: number;
  /** Patterns a capability sells, those no cloud sells by nature, and the rest: not mapped yet. */
  readonly sold: number;
  readonly byNature: number;
  readonly open: number;
  readonly rows: number;
}

const childAreas = (structure: Structure, id: string): StructureArea[] => structure.areas.filter((a) => a.nestUnder === id);

/**
 * The bands of the stack index, in the structure file's order: the areas
 * directly under `patterns` that hold a page themselves or through the areas
 * nested under them. The map page generator writes one heading per band.
 */
export function patternBands(structure: Structure): StructureArea[] {
  const holds = (a: StructureArea): boolean => a.pages.length > 0 || childAreas(structure, a.id).some(holds);
  return childAreas(structure, PATTERNS).filter(holds);
}

/** Link every registered product in one cell for one provider's column. */
export type Linkify = (html: string, provider: string) => string;

/** The phrasing content of one table cell as inner HTML, its links made routes. */
export function cellHtml(children: readonly PhrasingContent[], fromSource: string, routes: ReadonlyMap<string, string>): string {
  const clone = structuredClone(children) as PhrasingContent[];
  const walk = (nodes: readonly PhrasingContent[]): void => {
    for (const n of nodes) {
      if (n.type === 'link') {
        const resolved = resolveTarget(fromSource, n.url);
        const route = resolved === null ? undefined : routes.get(resolved);
        if (route !== undefined) n.url = `${route}${n.url.includes('#') ? n.url.slice(n.url.indexOf('#')) : ''}`;
      }
      if ('children' in n) walk(n.children as PhrasingContent[]);
    }
  };
  walk(clone);
  const root: Root = { type: 'root', children: [{ type: 'paragraph', children: clone }] };
  const processor = unified().use(remarkRehype).use(rehypeStringify);
  const html = processor.stringify(processor.runSync(root));
  return html.replace(/^<p>/, '').replace(/<\/p>$/, '');
}

/** Every table row of one page's markdown, by its id: the row's cells as phrasing content. */
export function tableRows(markdown: string): Map<string, PhrasingContent[][]> {
  const { tree } = parseKb(markdown);
  const out = new Map<string, PhrasingContent[][]>();
  const walk = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === 'tableRow') {
      const id = readKb(node as TableRow)?.id;
      if (id !== undefined) out.set(id, (node as TableRow).children.map((c) => c.children));
      return;
    }
    for (const c of (node.children ?? []) as { type: string; children?: unknown[] }[]) walk(c);
  };
  walk(tree);
  return out;
}

/** Text with its HTML characters escaped, for a cell built here rather than copied. */
export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The stack index. `read` answers a page source's markdown; `linkify` links the
 * products in one cell for its column; `notes` says which dashes are verdicts.
 * Throws when a note claims no cloud sells a pattern some capability sells (the
 * note would be a lie), or names a band or pattern the index does not hold.
 */
export function buildStack(
  structure: Structure,
  relations: readonly Relation[],
  read: (source: string) => string,
  linkify: Linkify,
  notes: StackNotes = NO_NOTES,
): StackData {
  const pages = treePages(structure);
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const routes = new Map(pages.map((p) => [p.source, p.route]));
  const rows = new Map<string, Map<string, PhrasingContent[][]>>();
  const rowsOf = (source: string): Map<string, PhrasingContent[][]> => {
    let hit = rows.get(source);
    if (hit === undefined) {
      hit = tableRows(read(source));
      rows.set(source, hit);
    }
    return hit;
  };

  // pattern → every page that implements it, capabilities then comparisons, each in reading order.
  const sources = new Map<string, { page: (typeof pages)[number]; maps?: string }[]>();
  for (const r of relations) {
    const src = bySlug.get(r.a);
    if (r.verb !== 'implements' || src === undefined || !bySlug.has(r.b)) continue;
    if (src.kind.id !== CAPABILITIES && src.kind.id !== COMPARISONS) continue;
    sources.set(r.b, [...(sources.get(r.b) ?? []), { page: src, ...(r.maps_a === undefined ? {} : { maps: r.maps_a }) }]);
  }
  const weight = (p: (typeof pages)[number]): number => (p.kind.id === CAPABILITIES ? 0 : 1) * pages.length + p.rank;
  for (const list of sources.values()) list.sort((x, y) => weight(x.page) - weight(y.page));

  const link = (p: (typeof pages)[number], fragment = ''): StackLink => ({ title: p.label, href: `${p.route}${fragment}` });
  let covered = 0;
  let sold = 0;
  let byNature = 0;
  let rowCount = 0;

  const rowsFor = (p: (typeof pages)[number], bandNote: boolean): StackRow[] => {
    const list = sources.get(p.slug) ?? [];
    const compare = list
      .filter((s) => s.page.kind.id === COMPARISONS)
      .map((s) => {
        const cells = s.maps === undefined ? undefined : rowsOf(s.page.source).get(s.maps);
        const criterion = cells?.[0] === undefined ? '' : cellHtml(cells[0], s.page.source, routes).replace(/<[^>]*>/g, '').trim();
        return criterion === '' ? link(s.page) : { ...link(s.page, `#${s.maps as string}`), criterion };
      });
    const caps = list.filter((s) => s.page.kind.id === CAPABILITIES);
    if (list.length > 0) covered += 1;
    const id = (i: number): string => `stack-${p.slug}${i === 0 ? '' : `-${i + 1}`}`;
    const reason = notes.patterns[p.slug];
    if (caps.length === 0) {
      rowCount += 1;
      const none = bandNote || reason !== undefined;
      if (none) byNature += 1;
      return [
        {
          id: id(0),
          pattern: link(p),
          state: none ? 'none' : 'gap',
          ...(reason === undefined ? {} : { reason }),
          cells: SERVICE_COLUMNS.map(() => DASH),
          compare,
        },
      ];
    }
    sold += 1;
    if (reason !== undefined) {
      throw new Error(
        `${STACK} says no cloud sells ${p.slug}, but ${caps.map((c) => c.page.slug).join(', ')} implements it — drop it from patterns there or retype that relation`,
      );
    }
    return caps.map((s, i) => {
      rowCount += 1;
      const cells = s.maps === undefined ? undefined : rowsOf(s.page.source).get(s.maps);
      const whole = link(s.page, '#mapping');
      if (cells === undefined || cells.length === 0) {
        return {
          id: id(i),
          pattern: link(p),
          state: 'linked',
          source: { ...whole, html: `all of ${escapeHtml(s.page.label)}` },
          cells: SERVICE_COLUMNS.map(() => `<a href="${whole.href}">${DASH}</a>`),
          compare: i === 0 ? compare : [],
        };
      }
      // Called for the label and for each column the row has: never past its end.
      const html = (at: number): string => cellHtml(cells[at] as PhrasingContent[], s.page.source, routes);
      return {
        id: id(i),
        pattern: link(p),
        state: 'mapped',
        source: { ...link(s.page, `#${s.maps as string}`), html: html(0) },
        cells: SERVICE_COLUMNS.map((c, at) => (cells[at + 1] === undefined ? DASH : linkify(html(at + 1), c.provider))),
        compare: i === 0 ? compare : [],
      };
    });
  };

  const bands: StackBand[] = [];
  let patterns = 0;
  const listed = new Set<string>();
  const bandIds = new Set<string>();
  for (const band of patternBands(structure)) {
    bandIds.add(band.id);
    const note = notes.bands[band.id];
    const groupAreas = [band, ...childAreas(structure, band.id)];
    const subdivided = groupAreas.length > 1;
    const groups: StackGroup[] = [];
    for (const g of groupAreas) {
      const members = pages.filter((p) => p.area === g.id);
      if (members.length === 0) continue;
      patterns += members.length;
      for (const m of members) {
        listed.add(m.slug);
        if (note !== undefined && notes.patterns[m.slug] !== undefined) {
          throw new Error(`${STACK} gives ${m.slug} a reason of its own, but its band "${band.id}" already says none of its patterns is for sale — drop the pattern's entry`);
        }
      }
      const forSale = members.filter((m) => (sources.get(m.slug) ?? []).some((s) => s.page.kind.id === CAPABILITIES)).map((m) => m.slug);
      if (note !== undefined && forSale.length > 0) {
        throw new Error(`the stack index calls band "${band.id}" unbuyable, but a capability implements ${forSale.join(', ')} — drop the band from ${STACK} or retype that relation`);
      }
      const groupRows = members.flatMap((m) => rowsFor(m, note !== undefined));
      groups.push({ ...(subdivided && g !== band ? { label: g.label } : {}), rows: groupRows });
    }
    bands.push({
      id: band.id,
      label: band.label,
      description: band.hub.description,
      ...(note === undefined ? {} : { unbuyable: note }),
      groups,
    });
  }
  const strays = [
    ...Object.keys(notes.bands).filter((b) => !bandIds.has(b)).map((b) => `band "${b}"`),
    ...Object.keys(notes.patterns).filter((p) => !listed.has(p)).map((p) => `pattern "${p}"`),
  ];
  if (strays.length > 0) throw new Error(`${STACK} names ${strays.join(', ')}, which the stack index does not hold`);
  return { bands, patterns, covered, sold, byNature, open: patterns - sold - byNature, rows: rowCount };
}

/**
 * Regions of a cell the linker must not touch, matched whole so the scan skips
 * them: an existing `<a>` (a cell's own link to a comparison page wins for that
 * name), a `<code>` identifier, and any lone tag, so a name is never put into
 * an attribute value.
 */
const PROTECTED = /<a\b[^>]*>[\s\S]*?<\/a>|<code\b[^>]*>[\s\S]*?<\/code>|<[^>]+>/gi;

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Link every registered product name in one mapping cell, for one provider's
 * column. One alternation per provider, longest name first: JS alternation is
 * leftmost-first, so the sort is what makes "Amazon SQS" win over "SQS". The
 * lookarounds keep a name from matching inside a longer word ("Batch" in
 * "Batching"); they test for letters and digits rather than `\b` because some
 * names end in a character that is no word character.
 */
export function linkerOf(products: Readonly<Record<string, Readonly<Record<string, string>>>>): Linkify {
  const matchers = new Map<string, RegExp | null>();
  const matcherFor = (provider: string): RegExp | null => {
    if (!matchers.has(provider)) {
      const names = Object.keys(products[provider] ?? {}).sort((a, b) => b.length - a.length);
      matchers.set(provider, names.length > 0 ? new RegExp(`(?<![A-Za-z0-9])(${names.map(reEscape).join('|')})(?![A-Za-z0-9])`, 'g') : null);
    }
    return matchers.get(provider) as RegExp | null;
  };
  return (html, provider) => {
    const re = matcherFor(provider);
    if (re === null || html === '') return html;
    const table = products[provider] as Readonly<Record<string, string>>;
    const link = (text: string): string =>
      text.replace(re, (name) => `<a class="kb-product" href="${table[name] as string}" target="_blank" rel="noopener noreferrer">${name}</a>`);
    let out = '';
    let last = 0;
    for (const m of html.matchAll(PROTECTED)) {
      out += link(html.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + link(html.slice(last));
  };
}

/** The product registry's linker, read from `root`'s products.json. */
export async function productLinker(root: string): Promise<Linkify> {
  const data = JSON.parse(await fs.promises.readFile(path.join(root, PRODUCTS), 'utf8')) as { products?: Record<string, Record<string, string>> };
  return linkerOf(data.products ?? {});
}

/** The stack notes, read from `root`'s stack.json; a tree without one has no verdicts. */
export function readStackNotes(root: string): StackNotes {
  const file = path.join(root, STACK);
  if (!fs.existsSync(file)) return NO_NOTES;
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StackNotes>;
  return { bands: data.bands ?? {}, patterns: data.patterns ?? {} };
}

/** The stack index, read from `root`. */
export async function stackData(root: string): Promise<StackData> {
  return buildStack(
    readJson<Structure>(root, STRUCTURE),
    readJson<{ relations: Relation[] }>(root, RELATIONS).relations,
    (source) => fs.readFileSync(path.join(root, source), 'utf8'),
    await productLinker(root),
    readStackNotes(root),
  );
}
