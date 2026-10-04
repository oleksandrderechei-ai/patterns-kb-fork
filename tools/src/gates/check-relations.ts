/**
 * Hold `docs/data/relations.json` to the typed graph it is (a KB extension of
 * spec kb.data: the one source for every edge between two pages).
 *
 * The file holds one record per EDGE, not per side: a verb written on one page
 * and its inverse on the other are one record,
 *
 *   { a, verb, b, note_a, note_b, group_a?, group_b?, maps_a?, maps_b?, maps_label_a?, maps_label_b? }
 *
 * so the two-sided rule the HTML build enforced — every edge declared on both
 * pages, the same way round — is structural here: a record cannot say one side
 * without the other. What is left to hold, each a finding at the record's line:
 *
 *   closed      a record has exactly the keys above; `verb` is one of the
 *               closed verbs `content-model.json` lists (relations.verbs), and
 *               it is the pair's first verb there, so `x has-variant y` is
 *               always written `y variant-of x` and an edge has one spelling
 *   both sides  `note_a` and `note_b` are both present (`""` for a side with
 *               no note); a missing one is the one-way edge of the HTML era
 *   resolved    `a` and `b` are published pages — rows of site-structure.json
 *               — and differ
 *   one edge    one pair of pages carries a verb family (a verb and its
 *               inverse) once: the same edge twice is a duplicate, and
 *               `x variant-of y` beside `y variant-of x` a contradiction.
 *               Different families on one pair (`combines-with` and
 *               `often-confused-with`) are two true things and stay.
 *   groups      a `group_*` heading is present only when it is not the side's
 *               verb label, and `group_order` pins, for a published page, only
 *               groups that page's sides sit under, each once
 *   exposed     `exposed-to` runs from a pattern or a design to a hazard, so
 *               its written side sits on a page under docs/patterns/ or
 *               docs/designs/ and its other side under docs/hazards/
 *   maps        a `maps_*` sits only on a side that reads `implements`, and
 *               names a table row of that side's own page — its `mapping`
 *               (capability) or `matrix` (comparison) block
 *   pinned      a `maps_*` carries its `maps_label_*`, the plain text of the
 *               row's first cell, and that row still reads it: row ids are
 *               positional, so a row inserted above a pin moves it onto
 *               another row, and the label is what notices. The finding names
 *               the row the label sits on now. A label with no map is a finding.
 *
 * The verbs and the pages come from the two other data files, so a missing or
 * unreadable one is a finding against it, never a crash or a silent pass.
 *
 * Usage: check-relations   (takes no arguments: the file is always read whole)
 */

import fs from 'node:fs';
import path from 'node:path';

import { jsonLines, pointer, readDataJson } from '../lib/data-json.js';
import { main, type GateContext, type GateSpec } from '../lib/gate.js';
import { mapRows } from '../lib/map-rows.js';

export { MAPS_BLOCKS, mapRows } from '../lib/map-rows.js';

export const RELATIONS = 'docs/data/relations.json';
export const CONTENT_MODEL = 'docs/data/content-model.json';
export const STRUCTURE = 'docs/data/site-structure.json';

/** The keys of the file itself, and of one record. */
export const FILE_KEYS = ['version', 'updated', 'note', 'relations', 'group_order'];
export const RECORD_KEYS = ['a', 'verb', 'b', 'note_a', 'note_b', 'group_a', 'group_b', 'maps_a', 'maps_b', 'maps_label_a', 'maps_label_b'];
/** The verb a side must read for it to map to a table row. */
export const MAPS_VERB = 'implements';

/** The verb that says a page is exposed to a hazard, and the folders of the pages it may join. */
export const EXPOSED_VERB = 'exposed-to';
export const EXPOSED_FROM: readonly string[] = ['docs/patterns/', 'docs/designs/'];
export const EXPOSED_TO: readonly string[] = ['docs/hazards/'];

export interface Verb {
  readonly id: string;
  readonly label: string;
  readonly inverse: string;
}

/** The closed verbs by id, and which one of each pair is the one written. */
export interface VerbTable {
  readonly byId: ReadonlyMap<string, Verb>;
  readonly written: ReadonlySet<string>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * The verb table `content-model.json` carries, or the reason it cannot be
 * used. A pair is written by the verb listed first; a symmetric verb is its
 * own inverse, so it is always the one written.
 */
export function verbTable(model: unknown): VerbTable | string {
  const verbs = isObj(model) && isObj(model['relations']) ? model['relations']['verbs'] : undefined;
  if (!Array.isArray(verbs) || verbs.length === 0) return 'has no relations.verbs list';
  const byId = new Map<string, Verb>();
  const order: string[] = [];
  for (const v of verbs as unknown[]) {
    if (!isObj(v) || !isText(v['id']) || !isText(v['label']) || !isText(v['inverse'])) {
      return 'relations.verbs holds an entry without id, label and inverse';
    }
    byId.set(v['id'], { id: v['id'], label: v['label'], inverse: v['inverse'] });
    order.push(v['id']);
  }
  const written = new Set<string>();
  for (const v of byId.values()) {
    if (byId.get(v.inverse)?.inverse !== v.id) {
      return `relations.verbs pairs "${v.id}" with "${v.inverse}", which does not pair back`;
    }
    if (order.indexOf(v.id) <= order.indexOf(v.inverse)) written.add(v.id);
  }
  return { byId, written };
}

/** Every published page's source, by slug: the rows of the structure file. */
export function publishedPages(structure: unknown): Map<string, string> | null {
  const areas = isObj(structure) ? structure['areas'] : undefined;
  if (!Array.isArray(areas)) return null;
  const out = new Map<string, string>();
  for (const area of areas as unknown[]) {
    const rows = isObj(area) && Array.isArray(area['pages']) ? (area['pages'] as unknown[]) : [];
    for (const row of rows) {
      if (isObj(row) && isText(row['slug'])) out.set(row['slug'], typeof row['source'] === 'string' ? row['source'] : '');
    }
  }
  return out;
}

/** Load a data file the gate cannot do without; a missing one is a finding against it. */
function needed(ctx: GateContext, rel: string, why: string): { value: unknown; text: string } | null {
  const read = readDataJson(ctx, rel);
  if (read === 'missing') ctx.fail(rel, `is missing — ${why}`);
  return typeof read === 'string' ? null : read;
}

interface Edge {
  readonly from: string;
  readonly to: string;
  readonly verb: Verb;
  readonly line: number | undefined;
}

export const spec: GateSpec = {
  name: 'relations',
  usage: 'usage: check-relations   (takes no arguments: the file is always read whole)',
  run(ctx: GateContext): string {
    const rel = needed(ctx, RELATIONS, "every page's relationships block is rendered from it");
    const model = needed(ctx, CONTENT_MODEL, 'the relations gate reads the closed verbs from it');
    const structure = needed(ctx, STRUCTURE, 'the relations gate reads the published pages from it');
    if (rel === null || model === null || structure === null) return '';

    const verbs = verbTable(model.value);
    if (typeof verbs === 'string') ctx.fail(CONTENT_MODEL, verbs);
    const pages = publishedPages(structure.value);
    if (pages === null) ctx.fail(STRUCTURE, 'has no areas list, so no page is published');
    if (!isObj(rel.value)) ctx.fail(RELATIONS, 'is not a JSON object');
    if (typeof verbs === 'string' || pages === null || !isObj(rel.value)) return '';

    const file = rel.value;
    const lines = jsonLines(rel.text);
    const at = (...seg: (string | number)[]): number | undefined => lines.get(pointer(...seg));
    for (const k of Object.keys(file)) {
      if (!FILE_KEYS.includes(k)) ctx.fail(RELATIONS, `unknown key "${k}" — the file holds ${FILE_KEYS.join(', ')}`, at(k));
    }
    const records = file['relations'];
    if (!Array.isArray(records)) {
      ctx.fail(RELATIONS, 'has no relations list', at('relations'));
      return '';
    }

    const seen = new Map<string, Edge>();
    /** The group labels each page's sides sit under, for group_order. */
    const labels = new Map<string, Set<string>>();
    const maps: { slug: string; id: string; key: string; label: unknown; name: string; line: number | undefined }[] = [];
    let sides = 0;

    (records as unknown[]).forEach((r, n) => {
      const line = at('relations', n);
      if (!isObj(r)) {
        ctx.fail(RELATIONS, `relations[${n}] is not an object`, line);
        return;
      }
      const name = [r['a'], r['verb'], r['b']].map((x) => (isText(x) ? x : '?')).join(' ');
      const fail = (what: string): void => ctx.fail(RELATIONS, `${name}: ${what}`, line);
      for (const k of Object.keys(r)) {
        if (!RECORD_KEYS.includes(k)) fail(`unknown key "${k}" — a record holds ${RECORD_KEYS.join(', ')}`);
      }
      const missing = ['a', 'verb', 'b'].filter((k) => !isText(r[k]));
      for (const k of missing) fail(`has no ${k}`);
      for (const s of ['a', 'b']) {
        if (typeof r[`note_${s}`] !== 'string') {
          fail(`has no note_${s} — ${s}'s side of the edge is missing; write its note, "" for none`);
        }
      }
      if (missing.length > 0) return;
      const [a, b] = [r['a'] as string, r['b'] as string];
      const verb = verbs.byId.get(r['verb'] as string);
      if (verb === undefined) {
        fail(`"${String(r['verb'])}" is not one of the ${verbs.byId.size} verbs ${CONTENT_MODEL} lists`);
        return;
      }
      const inverse = verbs.byId.get(verb.inverse) as Verb;
      if (!verbs.written.has(verb.id)) {
        fail(`writes "${verb.id}", the second verb of its pair — write it as ${b} ${inverse.id} ${a}, notes swapped`);
      }
      if (a === b) fail('relates a page to itself');
      if (verb.id === EXPOSED_VERB || inverse.id === EXPOSED_VERB) {
        // The page that reads "exposed-to" is `a` when the record writes it, `b` when it writes the inverse.
        const [exposed, threat] = verb.id === EXPOSED_VERB ? [a, b] : [b, a];
        const under = (slug: string, dirs: readonly string[]): boolean => dirs.some((d) => (pages.get(slug) as string).startsWith(d));
        if (pages.has(exposed) && !under(exposed, EXPOSED_FROM)) {
          fail(`${exposed} is exposed to a hazard, so it must be a pattern or a design — ${EXPOSED_VERB} runs from a pattern or design to a hazard`);
        }
        if (pages.has(threat) && !under(threat, EXPOSED_TO)) {
          fail(`${threat} threatens ${exposed}, so it must be a hazard — ${EXPOSED_VERB} runs from a pattern or design to a hazard`);
        }
      }
      for (const slug of new Set([a, b])) {
        if (!pages.has(slug)) fail(`${slug} is no published page — ${STRUCTURE} has no row with that slug`);
      }

      // One edge per pair and verb family, compared in the written direction.
      const edge: Edge = verbs.written.has(verb.id)
        ? { from: a, to: b, verb, line }
        : { from: b, to: a, verb: inverse, line };
      const key = `${[a, b].sort().join(' ')} ${[verb.id, verb.inverse].sort().join(' ')}`;
      const prior = seen.get(key);
      if (prior === undefined) seen.set(key, edge);
      else if (prior.from === edge.from || verb.id === verb.inverse) fail(`repeats the edge at line ${String(prior.line)}`);
      else {
        fail(
          `contradicts line ${String(prior.line)}, which says ${prior.from} ${prior.verb.id} ${prior.to} — ` +
            'a directed edge points one way',
        );
      }

      // Each side: the heading it sits under, and the row it maps to.
      for (const [s, slug, v] of [
        ['a', a, verb],
        ['b', b, inverse],
      ] as const) {
        sides += 1;
        const group = r[`group_${s}`];
        let label = v.label;
        if (group !== undefined) {
          if (!isText(group)) fail(`group_${s} is not a heading — drop the key, or write the heading`);
          else if (group === v.label) fail(`group_${s} "${group}" is the verb's own label — drop the key`);
          else label = group;
        }
        const set = labels.get(slug) ?? new Set<string>();
        set.add(label);
        labels.set(slug, set);

        const id = r[`maps_${s}`];
        if (id === undefined) {
          if (r[`maps_label_${s}`] !== undefined) fail(`maps_label_${s} sits on a side that maps to no row — drop it, or write maps_${s}`);
          continue;
        }
        if (!isText(id)) fail(`maps_${s} is not an element id`);
        else if (v.id !== MAPS_VERB) {
          fail(`maps_${s} sits on ${slug}'s side, which reads "${v.id}" — only a side that reads "${MAPS_VERB}" maps to a table row`);
        } else maps.push({ slug, id, key: `maps_${s}`, label: r[`maps_label_${s}`], name, line });
      }
    });

    // Each mapped page is parsed once, whatever number of edges map into it.
    const rowsOf = new Map<string, Map<string, string>>();
    for (const m of maps) {
      const source = pages.get(m.slug) ?? '';
      let rows = rowsOf.get(m.slug);
      if (rows === undefined) {
        const abs = path.join(ctx.root, source);
        rows = source !== '' && fs.existsSync(abs) ? mapRows(fs.readFileSync(abs, 'utf8')) : new Map<string, string>();
        rowsOf.set(m.slug, rows);
      }
      const row = rows.get(m.id);
      const labelKey = m.key.replace('maps_', 'maps_label_');
      if (row === undefined) {
        ctx.fail(
          RELATIONS,
          `${m.name}: ${m.key} "${m.id}" names no row of ${m.slug}'s mapping or matrix table${source === '' ? '' : ` (${source})`}`,
          m.line,
        );
      } else if (m.label === undefined) {
        ctx.fail(RELATIONS, `${m.name}: ${m.key} "${m.id}" has no ${labelKey} — write the row's label, "${row}"`, m.line);
      } else if (m.label !== row) {
        const now = [...rows].find(([, l]) => l === m.label)?.[0];
        ctx.fail(
          RELATIONS,
          `${m.name}: ${m.key} "${m.id}" reads "${row}", not its ${labelKey} "${String(m.label)}" — ` +
            (now === undefined ? 'that row is gone from the table; re-pin the edge or drop it' : `that row is ${now} now; re-pin ${m.key} to it`),
          m.line,
        );
      }
    }

    const order = file['group_order'];
    if (order !== undefined && !isObj(order)) ctx.fail(RELATIONS, 'group_order is not an object of page slugs', at('group_order'));
    for (const [slug, pinned] of Object.entries(isObj(order) ? order : {})) {
      const line = at('group_order', slug);
      if (!pages.has(slug)) ctx.fail(RELATIONS, `group_order names ${slug}, which is no published page`, line);
      if (!Array.isArray(pinned) || !pinned.every((l) => typeof l === 'string')) {
        ctx.fail(RELATIONS, `group_order.${slug} is not a list of group headings`, line);
        continue;
      }
      const has = labels.get(slug) ?? new Set<string>();
      (pinned as string[]).forEach((l, i) => {
        if (pinned.indexOf(l) !== i) ctx.fail(RELATIONS, `group_order.${slug} pins "${l}" twice`, line);
        else if (!has.has(l)) ctx.fail(RELATIONS, `group_order.${slug} pins "${l}", a group none of its edges sit under`, line);
      });
    }

    return (
      `[relations] ${records.length} edges (${sides} sides) on ${labels.size} pages, ${maps.length} mapped to a table row: ` +
      `every edge resolved and closed over ${verbs.byId.size} verbs`
    );
  },
};

main(spec, import.meta.url);
