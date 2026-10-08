/**
 * Where a page sits in the knowledge base: its kind, its band and group, the
 * area that lists it and the areas above that one. One reading of the
 * structure file, so that kb.mjs and the site build place a page the same way.
 * Pure: it is handed the structure and the content model's kinds and reads no
 * file.
 *
 *   placeOf   a structure row → its place, or null for a page of no kind
 *
 * A page's KIND is the top folder of its markdown under docs/ (dialect X-03),
 * which the content model maps to a kind id: three theme pages filed in a
 * designs tier are still themes. Its BAND and GROUP are what scripts/kb.mjs
 * printed: for a pattern, the area directly under the `patterns` root and the
 * area that lists the page; for every other kind, the kind itself, twice.
 *
 * A structure the gate would refuse still places every page, so that a reader
 * of one page is never stopped by another's row: a `nestUnder` the file does
 * not hold becomes the root of the chain, labelled by its id; a chain that
 * loops back on itself ends where it would repeat; an area with no label is
 * labelled by its id.
 */

/** The part of one area of the structure file that placement reads. */
export interface PlaceArea {
  readonly id: string;
  readonly label?: string;
  readonly nestUnder?: string;
}

/** The structure file as placement reads it: its areas. */
export interface PlaceStructure {
  readonly areas: readonly PlaceArea[];
}

/** A kind as the content model lists it: its id and the folder under docs/ its pages sit in. */
export interface PlaceKind {
  readonly id: string;
  readonly folder: string;
}

/** A row of the structure file and the area that lists it. */
export interface PlaceRow {
  readonly area: string;
  /** The page's markdown, repo-relative: `docs/<folder>/…/<slug>.md`. */
  readonly source: string;
}

/** One area of a chain: its id and the label the site shows. */
export interface AreaRef {
  readonly id: string;
  readonly label: string;
}

/** Where a page sits. */
export interface Place {
  readonly kind: string;
  readonly band: string;
  readonly group: string;
  /** The id of the area that lists the page. */
  readonly area: string;
  /** The listing area and every area it nests under, outermost first. */
  readonly areaChain: readonly AreaRef[];
}

/**
 * The place of the page a structure row lists, or null when its markdown is
 * not under `docs/<a kind's folder>/`: a reference page or a concept, which
 * kb.mjs does not read.
 */
export function placeOf(structure: PlaceStructure, kinds: readonly PlaceKind[], row: PlaceRow): Place | null {
  const kind = kinds.find((k) => k.folder === row.source.split('/')[1])?.id;
  if (kind === undefined || !row.source.startsWith('docs/')) return null;
  const byId = new Map(structure.areas.map((a) => [a.id, a]));
  // Innermost first: the listing area, then the area it nests under, up to the root.
  const chain: string[] = [];
  for (let cur: string | undefined = row.area; cur !== undefined && !chain.includes(cur); cur = byId.get(cur)?.nestUnder) chain.push(cur);
  return {
    kind,
    band: kind === 'pattern' ? (chain[chain.length - 2] ?? row.area) : kind,
    group: kind === 'pattern' ? row.area : kind,
    area: row.area,
    areaChain: [...chain].reverse().map((id) => ({ id, label: byId.get(id)?.label ?? id })),
  };
}
