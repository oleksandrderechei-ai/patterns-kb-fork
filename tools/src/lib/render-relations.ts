/**
 * The relationships block of a page, rendered from `docs/data/relations.json`
 * (dialect D-80). Pure: no file is read here. The generator that splices the
 * block into pages and answers --check, tools/src/gen/gen-relations.ts, wraps
 * these functions, and kb.mjs link and unlink call them too.
 *
 * THE DATA
 *
 *   relations.json holds one record per EDGE, not per side. A verb written on
 *   one page and its inverse on the other are one record:
 *
 *     { a, verb, b, note_a, note_b, group_a?, group_b?, maps_a?, maps_b?, maps_label_a?, maps_label_b? }
 *
 *   `verb` is read from `a`'s side; `b` reads its inverse (the content
 *   model's verbs pair them; a symmetric verb is its own inverse).
 *   `note_*` is that side's note as markdown inline text, its links relative to
 *   that side's own page. `group_*` is a custom group heading, present only
 *   when the side sits under a heading that is not its verb's label (the
 *   persona pair). `maps_*` names the element on that side's page the edge
 *   maps to (a capability's mapping row); it is carried, never rendered.
 *
 *   `group_order` (optional) maps a page slug to its group labels in display
 *   order. It is written for a page whose order is not the default: every
 *   verb label in REL_ORDER order, then custom labels in the order the records
 *   first name them.
 *
 * THE BLOCK
 *
 *   **<group label>**
 *
 *   - [<target title>](<relative .md>) — <note>
 *
 * Groups in the order above; inside a group, sides in record order (the file
 * is the order). The link text is the target's title, never the text a person
 * once typed beside the link.
 */

import { blockStamp } from './generated.js';
import { escapeMdText, guardTrailingBrace, relativeMd } from './md-text.js';

export const RELATIONS_SRC = 'docs/data/relations.json';
/** The name the block stamp carries: the P3c generator that will own the block. */
export const GENERATOR = 'gen-relations';
/** The marked block's name: `<!-- relationships:start -->`. */
export const BLOCK = 'relationships';

export interface RelationRecord {
  readonly a: string;
  readonly verb: string;
  readonly b: string;
  readonly note_a: string;
  readonly note_b: string;
  readonly group_a?: string;
  readonly group_b?: string;
  readonly maps_a?: string;
  readonly maps_b?: string;
  readonly maps_label_a?: string;
  readonly maps_label_b?: string;
}

export interface RelationsFile {
  readonly version: number;
  readonly updated: string;
  readonly note: string;
  readonly relations: readonly RelationRecord[];
  readonly group_order?: Readonly<Record<string, readonly string[]>>;
}

/** One entry of RELATION_TYPES. */
export interface VerbInfo {
  readonly label: string;
  readonly inverse?: string;
  readonly symmetric?: boolean;
}
export type Verbs = Readonly<Record<string, VerbInfo>>;

/** What a generator needs to know about a page it links to. */
export interface PageRef {
  readonly slug: string;
  /** Today's route: `/` + the site path, `.html` included (D-02). */
  readonly route: string;
  /** The markdown file, repo-relative: `docs/…/<slug>.md`. */
  readonly source: string;
  readonly title: string;
}

/** One side of an edge, read from the page that holds it. */
export interface RelationSide {
  readonly verb: string;
  readonly to: string;
  readonly note: string;
  readonly group?: string;
  readonly maps?: string;
}

// ---------------------------------------------------------------------------
// Reading the data
// ---------------------------------------------------------------------------

/** The verb `b` reads, given the verb `a` wrote. */
export function inverseOf(verb: string, verbs: Verbs): string {
  const v = verbs[verb];
  if (v === undefined) throw new Error(`relations: unknown verb "${verb}"`);
  return v.symmetric === true ? verb : (v.inverse ?? verb);
}

/** Every side `slug` holds, in record order. */
export function sidesOf(slug: string, file: RelationsFile, verbs: Verbs): RelationSide[] {
  const out: RelationSide[] = [];
  for (const r of file.relations) {
    if (r.a === slug) {
      out.push({
        verb: r.verb,
        to: r.b,
        note: r.note_a,
        ...(r.group_a === undefined ? {} : { group: r.group_a }),
        ...(r.maps_a === undefined ? {} : { maps: r.maps_a }),
      });
    }
    if (r.b === slug) {
      out.push({
        verb: inverseOf(r.verb, verbs),
        to: r.a,
        note: r.note_b,
        ...(r.group_b === undefined ? {} : { group: r.group_b }),
        ...(r.maps_b === undefined ? {} : { maps: r.maps_b }),
      });
    }
  }
  return out;
}

/** The heading a side sits under: its custom group, else its verb's label. */
export function labelOf(side: RelationSide, verbs: Verbs): string {
  if (side.group !== undefined) return side.group;
  const v = verbs[side.verb];
  if (v === undefined) throw new Error(`relations: unknown verb "${side.verb}"`);
  return v.label;
}

export interface RelationGroup {
  readonly label: string;
  readonly sides: readonly RelationSide[];
}

/** The default position of a label: REL_ORDER first, custom labels after. */
function defaultOrder(labels: readonly string[], relOrder: readonly string[]): string[] {
  const rank = (l: string): number => {
    const i = relOrder.indexOf(l);
    return i === -1 ? relOrder.length : i;
  };
  // Stable: custom labels keep their first-appearance order.
  return labels
    .map((l, i) => ({ l, i }))
    .sort((x, y) => rank(x.l) - rank(y.l) || x.i - y.i)
    .map((x) => x.l);
}

/** A page's groups in display order (see the header). */
export function relationGroups(
  slug: string,
  file: RelationsFile,
  verbs: Verbs,
  relOrder: readonly string[],
): RelationGroup[] {
  const byLabel = new Map<string, RelationSide[]>();
  for (const side of sidesOf(slug, file, verbs)) {
    const label = labelOf(side, verbs);
    const list = byLabel.get(label) ?? [];
    list.push(side);
    byLabel.set(label, list);
  }
  const seen = [...byLabel.keys()];
  const fallback = defaultOrder(seen, relOrder);
  const pinned = file.group_order?.[slug];
  const order =
    pinned === undefined
      ? fallback
      : [...pinned.filter((l) => byLabel.has(l)), ...fallback.filter((l) => !pinned.includes(l))];
  return order.map((label) => ({ label, sides: byLabel.get(label) ?? [] }));
}

/**
 * The labels in `groups`' order when it differs from the default — what
 * `group_order` records for a page. Null when the default already gives it.
 */
export function groupOrderToRecord(labels: readonly string[], relOrder: readonly string[]): string[] | null {
  const fallback = defaultOrder(labels, relOrder);
  const custom = labels.some((l) => !relOrder.includes(l));
  if (!custom && fallback.every((l, i) => l === labels[i])) return null;
  return [...labels];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderContext {
  readonly verbs: Verbs;
  readonly relOrder: readonly string[];
  /** Every page, by slug. */
  readonly pages: ReadonlyMap<string, PageRef>;
}

/**
 * The lines inside the page's `relationships` marked block: the stamp, a blank
 * line, then each group. Throws when an edge names a page `pages` lacks — a
 * dangling edge is the relations gate's finding, not something to draw.
 */
export function renderRelations(slug: string, file: RelationsFile, ctx: RenderContext): string[] {
  const self = ctx.pages.get(slug);
  if (self === undefined) throw new Error(`relations: no page "${slug}"`);
  const lines: string[] = [blockStamp(GENERATOR, RELATIONS_SRC, 'block')];
  for (const group of relationGroups(slug, file, ctx.verbs, ctx.relOrder)) {
    lines.push('', `**${escapeMdText(group.label)}**`, '');
    for (const side of group.sides) {
      const target = ctx.pages.get(side.to);
      if (target === undefined) throw new Error(`relations: ${slug} → ${side.to}: no such page`);
      const link = `[${escapeMdText(target.title)}](${relativeMd(self.source, target.source)})`;
      lines.push(guardTrailingBrace(`- ${link}${side.note === '' ? '' : ` — ${side.note}`}`));
    }
  }
  return lines;
}
