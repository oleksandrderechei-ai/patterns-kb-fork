/**
 * Every page is tagged from one closed, faceted vocabulary, and that
 * vocabulary is sound (spec: kb.data.tags).
 *
 * The tags are not decoration. They become page facts in the built site's
 * head and manifest, a field in the search index, and the topic tag decides
 * which group a page joins on its area's hub. All of that reads whatever the
 * frontmatter says, so an open vocabulary does not fail — it quietly ranks
 * near-synonyms apart and splits one hub group in two.
 *
 * In one run: the tag list's own shape first (a structural fault stops the
 * run before any page is measured against it); the flat TAGS tuple in
 * site/src/lib/types.ts against the list, both ways; then every page's
 * `tags` — an inline list, 2-5 values on a page (3-5 on an exercise), each a
 * term whose `applies` names the page's class, in facet order, with exactly
 * one topic on a page (at least one on an exercise); then, on a whole-tree
 * run only, every term some page uses. Named pages narrow the run; naming one
 * of the gate's own data files makes it whole again.
 *
 * Tags are written inline (`tags: [a, b]`), and that is checked rather than
 * assumed. The frontmatter door returns a block list as the empty string, so
 * a page written the other way loses every tag it has with nothing to say so —
 * the one failure here that is invisible in the rendered page.
 *
 * docs/data/allow/tags.json may excuse a page's facet findings (order and
 * topic count) while a retag is in flight, and nothing else; an entry that
 * excuses nothing is a finding, so the list empties as the retag lands.
 *
 * Not fixable. Which tags a page carries is a decision, and a page tagged with
 * a guess is worse than a page the gate is still complaining about: the
 * complaint is a finding, and the guess is green.
 *
 * Usage: check-tags [file…]   (0 clean, 1 finding, 2 misuse)
 */

import fs from 'node:fs';
import path from 'node:path';

import { Allowlist, readAllowlist } from '../lib/allowlist.js';
import { gitFiles } from '../lib/exec.js';
import { frontmatterMany, listOf, type FmValue } from '../lib/frontmatter.js';
import { main, UsageError, type GateContext, type GateSpec } from '../lib/gate.js';
import { tupleLiteral, TYPES_FILE } from '../lib/published.js';
import {
  CLASSES,
  COUNTS,
  EXERCISES,
  facetRank,
  FACETS,
  parseTagList,
  TAG_LIST,
  termsOf,
  type PageClass,
  type TagList,
  type Term,
} from '../lib/tags.js';

export const NAME = 'tags';
export const ALLOWLIST = 'docs/data/allow/tags.json';

/**
 * Trees no page may sit in (docs/records/: dated records are not kept). The
 * frontmatter gate fails any file there; this gate skips them rather than
 * report the same file twice.
 */
export const FRONTMATTER_FREE = ['docs/records/'] as const;

const REQUIRED_KEYS = ['id', 'facet', 'definition', 'applies', 'owner'] as const;

/**
 * A tag id has to survive the inline form it is written in. A comma splits one
 * value into two and a bracket ends the list early, so the shape is checked
 * here rather than discovered as a page that silently carries a tag nobody
 * wrote.
 */
export const ID_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// 1. The tag list has to be sound before anything is measured against it.
//    A term with no facet cannot order a list, and a topic with no label
//    renders its own id as a heading on a hub page.
// ---------------------------------------------------------------------------
export function structuralFindings(data: TagList): string[] {
  const out: string[] = [];

  const facetsOk = typeof data.facets === 'object' && data.facets !== null && !Array.isArray(data.facets);
  if (!facetsOk) return ['`facets` is missing or is not an object'];
  if (!Array.isArray(data.terms)) return ['`terms` is missing or is not an array'];

  const facets = Object.keys(data.facets as Record<string, unknown>);
  const expected = FACETS as readonly string[];
  if (facets.length !== expected.length || facets.some((f, i) => f !== expected[i])) {
    out.push(`\`facets\` holds ${facets.join(', ') || 'nothing'} — it maps exactly ${expected.join(', ')}, in that order`);
  }
  const terms = termsOf(data);
  const seen = new Map<string, number>();
  const labels = new Map<string, string[]>();

  terms.forEach((t, i) => {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      out.push(`term #${String(i + 1)} is not an object`);
      return;
    }
    // `id` is narrowed rather than interpolated: a term whose id is an object
    // has no id to name, and `[object Object]` in the finding would hide that.
    const id = typeof t.id === 'string' ? t.id : `#${String(i + 1)}`;

    for (const k of REQUIRED_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(t, k)) out.push(`term ${id}: missing key "${k}"`);
    }
    if (typeof t.id === 'string') {
      seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
      if (!ID_SHAPE.test(t.id)) out.push(`term ${id}: id is not kebab-case — it has to survive "tags: [a, b]"`);
    }
    if (t.facet !== undefined && (typeof t.facet !== 'string' || !expected.includes(t.facet))) {
      out.push(`term ${id}: unknown facet ${JSON.stringify(t.facet)} (expected one of: ${expected.join(', ')})`);
    }

    const applies = Array.isArray(t.applies) ? (t.applies as unknown[]) : [];
    if (t.applies !== undefined && applies.length === 0) out.push(`term ${id}: applies is empty — a term no page may use`);
    for (const c of applies) {
      if (!(CLASSES as readonly unknown[]).includes(c)) {
        out.push(`term ${id}: applies has ${JSON.stringify(c)} (expected one of: ${CLASSES.join(', ')})`);
      }
    }

    // Only a topic is ever rendered as a heading, so only a topic carries one.
    if (t.facet === 'topic') {
      if (typeof t.label !== 'string' || t.label.trim() === '') {
        out.push(`term ${id}: a topic needs a label — it is the heading a hub groups its pages under`);
      } else {
        labels.set(t.label, [...(labels.get(t.label) ?? []), id]);
      }
    } else if (t.label !== undefined) {
      out.push(`term ${id}: only a topic carries a label, and nothing renders this one`);
    }
  });

  for (const [id, n] of sorted(seen)) if (n > 1) out.push(`duplicate id: ${id}`);
  for (const [label, owners] of sorted(labels)) {
    if (owners.length > 1) out.push(`two topics share the heading "${label}": ${owners.join(', ')}`);
  }

  return out;
}

/** A map's entries by key; keys are unique, so no two compare equal. */
function sorted<V>(m: Map<string, V>): [string, V][] {
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

// ---------------------------------------------------------------------------
// 2. One page's tags, against the list.
// ---------------------------------------------------------------------------
export interface Lookup {
  facet: Map<string, string>;
  applies: Map<string, string[]>;
}

/** The two lookups every page check needs, built once. */
export function lookupOf(terms: readonly Term[]): Lookup {
  const facet = new Map<string, string>();
  const applies = new Map<string, string[]>();
  for (const t of terms) {
    if (typeof t.id !== 'string') continue;
    if (typeof t.facet === 'string') facet.set(t.id, t.facet);
    applies.set(t.id, (Array.isArray(t.applies) ? t.applies : []).map(String));
  }
  return { facet, applies };
}

/** One finding about a page's tags; `facet` marks the two a retag allowlist may excuse. */
export interface TagFinding {
  readonly what: string;
  readonly facet: boolean;
}

/**
 * Everything wrong with one tags value, as sentences.
 *
 * `value` is what the frontmatter door returned with `lists`: an array for an
 * inline list, a string for anything else — the empty string a block list
 * arrives as is the finding that matters most here, because it is the only
 * one the page still renders cleanly through — and undefined for no key.
 */
export function tagFindings(value: FmValue | undefined, cls: PageClass, lookup: Lookup): TagFinding[] {
  const plain = (what: string): TagFinding => ({ what, facet: false });
  if (value === undefined) return [plain(`missing required key: tags — ${cls === 'page' ? 'a page' : 'an exercise'} carries them`)];

  const tags = listOf(value);
  if (tags === null) {
    return [
      plain(
        'tags is not an inline list — write `tags: [a, b]`. The frontmatter door returns a block list as an empty string, so every tag on this page is dropped',
      ),
    ];
  }

  const out: TagFinding[] = [];
  const { min, max } = COUNTS[cls];
  if (tags.length < min || tags.length > max) out.push(plain(`${String(tags.length)} tags — ${cls === 'page' ? 'a page' : 'an exercise'} carries ${String(min)}-${String(max)}`));

  const dupes = tags.filter((t, i) => tags.indexOf(t) !== i);
  for (const t of new Set(dupes)) out.push(plain(`tag "${t}" is written twice`));

  for (const t of tags) {
    if (!lookup.facet.has(t)) {
      out.push(plain(`unknown tag "${t}" — every value is a term in ${TAG_LIST}`));
      continue;
    }
    if (!(lookup.applies.get(t) ?? []).includes(cls)) {
      out.push(plain(`tag "${t}" does not apply to ${cls === 'page' ? 'a page' : 'an exercise'} — widen its applies or pick another`));
    }
  }

  // Order is checked on the tags the list knows: an unknown one has no facet,
  // and reporting it as misplaced too would be the same fault twice.
  const known = tags.filter((t) => lookup.facet.has(t));
  const ranks = known.map((t) => facetRank(lookup.facet.get(t)));
  for (let i = 1; i < ranks.length; i += 1) {
    if ((ranks[i] as number) < (ranks[i - 1] as number)) {
      out.push({ what: `tags are out of facet order at "${known[i] as string}" — topics first, then skills, then languages`, facet: true });
      break;
    }
  }

  const topics = known.filter((t) => lookup.facet.get(t) === 'topic');
  if (topics.length === 0) {
    out.push({ what: 'no topic tag — what the page is about is the one tag it must carry, written first', facet: true });
  } else if (cls === 'page' && topics.length > 1) {
    out.push({
      what: `${String(topics.length)} topic tags (${topics.join(', ')}) — a page has one, and it decides which hub group the page joins`,
      facet: true,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 3. The scan set, worked out from the tree: every markdown file under docs/
//    but the context layers and the refused trees.
// ---------------------------------------------------------------------------
export function scanSet(root: string): string[] {
  return gitFiles(root, ['docs/*.md', 'docs/**/*.md']).filter(
    (f) => path.basename(f) !== 'CLAUDE.md' && !FRONTMATTER_FREE.some((r) => f.startsWith(r)),
  );
}

/**
 * The flat TAGS tuple the site's schema enums against, held to the list both
 * ways (tags-C5). A term missing from the tuple is a tag this gate accepts and
 * the site build then refuses; a tuple member no term declares has no facet,
 * so it can never be ordered or grouped.
 *
 * The tuple is held to its own format too: each id once, so it counts as many
 * members as the list counts terms, and in facet order, the order a page
 * writes its tags in. Only the first order break is reported, as on a page.
 */
export function checkTuple(ctx: GateContext, terms: readonly Term[]): void {
  const abs = path.join(ctx.root, TYPES_FILE);
  if (!fs.existsSync(abs)) {
    ctx.fail(TYPES_FILE, 'missing — TAGS here is the flat tuple the site\'s content schema (site/src/content.config.ts) builds its tag enum from');
    return;
  }
  const declared = tupleLiteral(fs.readFileSync(abs, 'utf8'), 'TAGS');
  if (declared === null) {
    ctx.fail(
      TYPES_FILE,
      'no `const TAGS = [...]` holding only quoted ids — the declaration this gate reads has been reshaped, so the tuple is no longer being checked at all',
    );
    return;
  }
  const { facet } = lookupOf(terms);
  const ids = terms.filter((t) => typeof t.id === 'string').map((t) => t.id as string);
  for (const id of ids) if (!declared.includes(id)) ctx.fail(TYPES_FILE, `TAGS is missing "${id}", a term in ${TAG_LIST}`);
  for (const value of declared) {
    if (!ids.includes(value)) ctx.fail(TYPES_FILE, `TAGS lists "${value}", which is not a term in ${TAG_LIST}`);
  }
  for (const v of new Set(declared.filter((d, i) => declared.indexOf(d) !== i))) {
    ctx.fail(TYPES_FILE, `TAGS lists "${v}" more than once — it holds each id once, as many members as ${TAG_LIST} has terms (${String(ids.length)})`);
  }
  const known = declared.filter((v) => facet.has(v));
  for (let i = 1; i < known.length; i += 1) {
    if (facetRank(facet.get(known[i] as string)) < facetRank(facet.get(known[i - 1] as string))) {
      ctx.fail(TYPES_FILE, `TAGS runs out of facet order at "${known[i] as string}" — topics first, then skills, then languages, as ${TAG_LIST} files them`);
      break;
    }
  }
}

export const spec: GateSpec = {
  name: NAME,
  usage: 'usage: check-tags [file…]   (no files: every page under docs/. --fix is exit 2 — a tag is a decision)',
  positional: true,
  run(ctx: GateContext): string {
    const src = path.join(ctx.root, TAG_LIST);
    if (!fs.existsSync(src)) {
      ctx.fail(TAG_LIST, 'is missing — it is the one list of tags every page is held to');
      return '';
    }
    const data = parseTagList(fs.readFileSync(src, 'utf8'));
    if (data === null) {
      ctx.fail(TAG_LIST, 'is not a JSON object');
      return '';
    }

    // The list is checked whatever the scope: it is the thing every other pass
    // compares against, and narrowing to changed files must never mean
    // measuring pages against a vocabulary nobody looked at (tags-C8).
    const structural = structuralFindings(data);
    for (const finding of structural) ctx.fail(TAG_LIST, finding);
    if (structural.length > 0) return '';

    const terms = termsOf(data);
    const lookup = lookupOf(terms);
    checkTuple(ctx, terms);

    const all = scanSet(ctx.root);
    if (all.length === 0) {
      ctx.fail(TAG_LIST, 'no page under docs/ is tagged from it — the scan set is wrong');
      return '';
    }

    // Named pages narrow the run. `make validate-changed` hands over every
    // changed file the row's scans match, so the files this gate skips by
    // design — a context layer, a refused file, a page deleted in the
    // change — are taken and dropped. A named data file is different: a changed
    // tag list, tuple or allowlist can strand a page nobody named (a term
    // retired while a page still carries it, an entry deleted while its pages
    // still need it), so it makes the run whole. Any other path it does not
    // govern is misuse rather than a silent no-op: a mismatch there is a wrong
    // `scans` glob somebody needs to hear about.
    const named = ctx.args.map((f) => f.replace(/^\.\//, ''));
    const dataFiles = new Set([TAG_LIST, TYPES_FILE, ALLOWLIST]);
    const known = new Set(all);
    const dropped = (f: string): boolean =>
      dataFiles.has(f) ||
      (f.startsWith('docs/') && f.endsWith('.md') && !known.has(f) && (path.basename(f) === 'CLAUDE.md' || FRONTMATTER_FREE.some((r) => f.startsWith(r)) || !fs.existsSync(path.join(ctx.root, f))));
    const namedPages = named.filter((f) => !dropped(f));
    const strays = namedPages.filter((f) => !known.has(f));
    if (strays.length > 0) throw new UsageError(`not a page this gate governs: ${strays.join(', ')}`);
    const whole = named.length === 0 || named.some((f) => dataFiles.has(f));
    const files = whole ? all : namedPages;

    const allowed = readAllowlist(ctx, ALLOWLIST, {
      missing: 'it excuses the facet findings of the pages a retag has not reached yet, and ships empty',
      emptyReason: 'has an empty reason — say which retag is pending and who lands it',
    });
    const allow = new Allowlist(allowed ?? []);

    const fm = frontmatterMany(ctx.root, files, { lists: true });
    const used = new Set<string>();
    let pages = 0;
    let exercises = 0;
    let excused = 0;

    for (const f of files) {
      // frontmatterMany keys every path it was handed, a file with no block as {}.
      const meta = fm.get(f) as Record<string, FmValue>;
      const exercise = f.startsWith(EXERCISES);
      // An exercise index navigates the tree and is not itself an exercise;
      // the frontmatter gate is what refuses tags on one.
      if (exercise && meta['type'] !== 'exercise') continue;
      const cls: PageClass = exercise ? 'exercise' : 'page';
      if (exercise) exercises += 1;
      else pages += 1;

      for (const finding of tagFindings(meta['tags'], cls, lookup)) {
        if (finding.facet && allow.excuses(f)) {
          excused += 1;
          continue;
        }
        ctx.fail(f, finding.what);
      }
      for (const t of listOf(meta['tags']) ?? []) used.add(t);
    }

    if (whole) {
      // A term nothing uses is a dead member — the shape a half-landed rename
      // leaves behind. Only meaningful over the whole tree: a narrowed run has
      // no way to know whether a page it was not handed uses the term.
      for (const t of terms) {
        if (typeof t.id === 'string' && !used.has(t.id)) ctx.fail(TAG_LIST, `term "${t.id}" is used by no page — a dead member`);
      }
      // An exception must not outlive its cause.
      if (allowed !== null) {
        for (const e of allow.unused()) ctx.fail(ALLOWLIST, `entry "${e.name}" excuses nothing — its pages carry one topic in facet order now; delete it`);
      }
    }

    const pending = excused > 0 ? `, ${String(excused)} facet findings excused by ${ALLOWLIST}` : '';
    return `[${NAME}] OK — ${String(pages)} pages, ${String(exercises)} exercises, ${String(terms.length)} terms${pending}`;
  },
};

main(spec, import.meta.url);
