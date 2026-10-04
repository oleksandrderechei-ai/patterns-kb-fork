/**
 * The table rows an `implements` edge may pin: the body rows of a capability's
 * `mapping` block and a comparison's `matrix` block, each with its label. Read
 * by the relations gate, which holds every pin to its row, and by kb.mjs link
 * --maps, which writes a pin.
 */

import { deriveElements, parseKb } from './kb-attrs.js';

/** The blocks whose table rows an edge may map to: a capability's mapping, a comparison's matrix. */
export const MAPS_BLOCKS: ReadonlySet<string | null> = new Set(['mapping', 'matrix']);

/** The body table rows in a page's mapping or matrix block: each row's id, and its label (the first cell's plain text). */
export function mapRows(markdown: string): Map<string, string> {
  const body = markdown.replace(/^---\r?\n(?:[^]*?\r?\n)?---[ \t]*(?:\r?\n|$)/, '');
  const rows = new Map<string, string>();
  for (const e of deriveElements(parseKb(body).tree)) {
    // A header row, and a row outside every block, carries no id: neither can be the row an edge maps to.
    if (e.kind === 'row' && e.id !== undefined && MAPS_BLOCKS.has(e.block)) rows.set(e.id, e.text.split(' | ')[0] ?? '');
  }
  return rows;
}
