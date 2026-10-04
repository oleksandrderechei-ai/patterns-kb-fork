/**
 * Every page under docs/ opens with the block of facts its regime asks for
 * (spec: kb.content.frontmatter): the page block, the exercise block, or none.
 *
 * The title rule is the reason a gate exists at all: `title:` is what the site
 * shows and the `# H1` is what GitHub shows, so when they disagree the same
 * page has two names depending on where you read it, and nothing says so.
 *
 * Every markdown file git lists under docs/ falls under exactly one regime:
 *
 *   layer              a CLAUDE.md. Its shape and budget are the context-layers
 *                      gate's; it carries no block, and this gate does not hold it.
 *   refused            a file under one of REFUSED_ROOTS (where dated records
 *                      used to sit). None is kept: a check's findings go to the
 *                      chat or to its skill's issue, so any file there fails.
 *   exercise           a file under EXERCISES. Only the exercise keys; the
 *                      mirror computes the rest. The KB has none yet.
 *   page               everything else: the page block of `lib/page-block.ts`,
 *                      its closed lists, a title equal to the H1.
 *
 * What is inside `tags` belongs to the tags gate; this one asks only that the
 * key is there as a non-empty inline list, because the parser reads a block
 * list as empty and every tag in it would silently drop. The values of the
 * KB's own keys (`aliases`, `solves`, `favourite`) belong to the kb-shape
 * gate; this gate knows those keys exist, so the block stays closed. The
 * description is one plain line of at most 160 characters on every page and
 * exercise, published or not (frontmatter-C4), by the one check the
 * docs-style gate's PAGE-005 uses too.
 *
 * Every value is read through the one parser, `scripts/fm-json.sh`, in two
 * spawns for the whole tree (`lib/frontmatter.ts`); the H1 through the one H1
 * rule of `lib/md-lines.ts`. Where a YAML reader, such as the site's schema,
 * would read the block differently, the finding says why: a key declared
 * twice is a finding of its own, since the parser keeps the first and a YAML
 * reader the last or neither, and a closed-list value that ends in spaces or
 * a `# comment` is named as such, since the parser keeps both as part of the
 * value.
 *
 * `status` is this gate's alone (spec: kb.learning.maturity, maturity-C1): it
 * is required with no default, because a silent default is how a draft comes
 * to look finished. The rule that a draft sits on no learning path is the
 * learning-paths gate's (maturity-C4), and that no stable page requires a
 * draft one the prerequisites gate's (learning-C3).
 *
 * `--fix` adds a missing key: `title` from the H1, `owner` from git, and a
 * placeholder for every other, which is still a finding — a key filled in with
 * a guess would be green and wrong. For `status` that is the whole of the
 * repair: which of the three a page is, is a decision about the page
 * (maturity-C2). It writes nothing on an exercise or a refused file,
 * and leaves a key declared twice as it stands.
 *
 * The page list is what git lists under docs/ that is still on disk: a page
 * deleted or moved and not yet staged is no page to read.
 *
 * Usage: check-doc-frontmatter [--fix] [file…]   (0 clean, 1 finding, 2 misuse)
 */

import fs from 'node:fs';
import path from 'node:path';

import { gitFiles, records, run } from '../lib/exec.js';
import { frontmatter, frontmatterMany, listOf, type FmValue } from '../lib/frontmatter.js';
import { main, UsageError, type GateContext, type GateSpec } from '../lib/gate.js';
import { FM_DELIMITER, firstH1, hasFrontmatter } from '../lib/md-lines.js';
import { descriptionProblem, EXERCISE_KEYS, EXERCISE_TYPES, LEVELS, PAGE_KEYS, REQUIRED, STATUSES, type RequiredKey } from '../lib/page-block.js';

export const NAME = 'frontmatter';

/** The page tree. */
export const PAGE_TREE = 'docs/';

/** Roots no file may sit under: dated records are not kept. */
export const REFUSED_ROOTS: readonly string[] = ['docs/records/'];

/** The exercise tree, held to the exercise regime (frontmatter-C8). */
export const EXERCISES = 'docs/exercises/';

/** Where the area list lives: the structure file's area ids. */
export const STRUCTURE = 'docs/data/site-structure.json';

/** What `--fix` writes for a key only a person can answer. Assembled so this file carries none. */
export const MARKER = ['CHANGE', 'ME'].join('-');

export type Regime = 'layer' | 'refused' | 'exercise' | 'page';

/** Which regime holds a file under the page tree. */
export function regimeOf(file: string): Regime {
  if (path.posix.basename(file) === 'CLAUDE.md') return 'layer';
  if (REFUSED_ROOTS.some((r) => file.startsWith(r))) return 'refused';
  if (file.startsWith(EXERCISES)) return 'exercise';
  return 'page';
}

/**
 * `description: A thing: another thing` is not valid YAML, and a site schema
 * reading the block with a real YAML parser fails a long way from the page.
 * A quoted value is fine.
 */
export function descriptionColonUnquoted(raw: string): boolean {
  const quoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
  return !quoted && raw.includes(': ');
}

/** A field line as the one parser reads one: `key:` at the start of the line (scripts/lib-frontmatter.sh). */
const FIELD = /^([A-Za-z_][A-Za-z0-9_-]*):/;

/** A key the block declares more than once, with the 1-based line of each declaration. */
export interface Doubled {
  readonly key: string;
  readonly lines: readonly number[];
}

/**
 * Every key the block declares more than once, in the order each first
 * appears. The block is read as the parser reads it: from line 1's `---` to
 * the next, or to the end of a block that never closes.
 */
export function doubledKeys(text: string): Doubled[] {
  const src = records(text).map((l) => l.replace(/\r$/, ''));
  if (!FM_DELIMITER.test(src[0] ?? '')) return [];
  const at = new Map<string, number[]>();
  for (let i = 1; i < src.length && !FM_DELIMITER.test(src[i] as string); i += 1) {
    const key = FIELD.exec(src[i] as string)?.[1];
    if (key !== undefined) at.set(key, [...(at.get(key) ?? []), i + 1]);
  }
  return [...at].filter(([, lines]) => lines.length > 1).map(([key, lines]) => ({ key, lines }));
}

/** The finding for a key declared twice or more, located at its first line. */
function failDoubled(ctx: GateContext, f: string, d: Doubled): void {
  const lines = `${d.lines.slice(0, -1).join(', ')} and ${String(d.lines.at(-1))}`;
  ctx.fail(f, `declares ${d.key} ${String(d.lines.length)} times, at lines ${lines} — this repo's reader keeps the first, a YAML reader the last or none; keep one`, d.lines[0]);
}

/**
 * Why a value outside its closed list may look like one of it: a YAML reader
 * drops a trailing space and a trailing `# comment`, and this repo's one
 * parser keeps both, so the page reads one way here and another on the site.
 * A comment is named before a space; a plain value gets nothing.
 */
export function whyOutside(value: string): string {
  if (/\s#/.test(value)) return " — a # comment follows the value, and this repo's reader keeps it as part of the value; move the comment to its own line";
  if (/\s$/.test(value)) return " — it ends in spaces, which this repo's reader keeps as part of the value; delete them";
  return '';
}

/** How `--fix` writes a key's placeholder: a list stays an inline list. */
function placeholder(key: RequiredKey): string {
  return key === 'tags' ? `[${MARKER}]` : MARKER;
}

/**
 * Splice missing keys into a page's block, or open a block on a page with
 * none. A key the block declares empty is filled where it stands; any other
 * lands after the last declared key that `REQUIRED` puts before it, so a
 * repaired page keeps the order every page writes its keys in.
 */
export function withKeys(text: string, values: Readonly<Partial<Record<RequiredKey, string>>>): string {
  const additions = REQUIRED.filter((k) => values[k] !== undefined);
  const line = (k: RequiredKey): string => `${k}: ${values[k] as string}`;
  const src = records(text);
  if (!FM_DELIMITER.test((src[0] ?? '').replace(/\r$/, ''))) {
    return `---\n${additions.map(line).join('\n')}\n---\n\n${text}`;
  }
  const close = src.findIndex((l, i) => i > 0 && FM_DELIMITER.test(l.replace(/\r$/, '')));
  // An unclosed block runs to the end of the file, as the parser reads it.
  const end = close === -1 ? src.length : close;
  const block = src.slice(1, end);
  const rank = (key: string): number => (REQUIRED as readonly string[]).indexOf(key);
  for (const k of additions) {
    const declared = block.findIndex((l) => l.startsWith(`${k}:`));
    if (declared !== -1) {
      block[declared] = line(k);
      continue;
    }
    let at = 0;
    block.forEach((l, i) => {
      const declared = /^([A-Za-z0-9_-]+):/.exec(l)?.[1];
      if (declared !== undefined && rank(declared) !== -1 && rank(declared) < rank(k)) at = i + 1;
    });
    block.splice(at, 0, line(k));
  }
  return `${[src[0], ...block, ...src.slice(end)].join('\n')}\n`;
}

/**
 * Who to credit as `owner`: git's last author of the page, else the person
 * running the repair (a page with no owner is usually minutes old), else
 * nothing — and then the key is a decision like the others.
 */
export function owner(root: string, file: string): string {
  const logged = run('git', ['log', '-1', '--format=%an', '--', file], root);
  if (logged.status === 0 && logged.stdout.trim() !== '') return logged.stdout.trim();
  const configured = run('git', ['config', 'user.name'], root);
  return configured.status === 0 ? configured.stdout.trim() : '';
}

/** The area ids the structure file declares, or null when it cannot be read. */
export function areaIds(root: string): Set<string> | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, STRUCTURE), 'utf8')) as { areas?: unknown };
    if (!Array.isArray(data.areas)) return null;
    return new Set(data.areas.map((a) => (a as { id?: unknown }).id).filter((id): id is string => typeof id === 'string'));
  } catch {
    return null;
  }
}

/** A value as a finding quotes it: a list reads back as it was written. */
const str = (v: FmValue | undefined): string => (Array.isArray(v) ? `[${v.join(', ')}]` : ((v as string | undefined) ?? ''));
const isMarker = (v: FmValue | undefined): boolean => (Array.isArray(v) ? v.includes(MARKER) : v === MARKER);

/** The finding for a tags value that is not an inline list. */
const TAGS_NOT_INLINE = 'tags is not an inline list — write `tags: [a, b]`; the parser reads a block list as empty, so every tag on the page is dropped';

/** The description as written (frontmatter-C4): valid YAML, one plain line, 160 characters at most. */
function checkDescription(ctx: GateContext, f: string, raw: string): void {
  if (descriptionColonUnquoted(raw)) {
    ctx.fail(f, 'description contains ": " unquoted — invalid YAML; rephrase with a dash or quote the value');
  }
  const problem = descriptionProblem(raw);
  if (problem !== null) ctx.fail(f, problem);
}

/** The exercise regime (frontmatter-C8): only its keys, and what each must say. */
function checkExercise(ctx: GateContext, f: string, text: string, fm: Readonly<Record<string, FmValue>>, raw: string): void {
  for (const d of doubledKeys(text)) failDoubled(ctx, f, d);
  for (const k of Object.keys(fm)) {
    if (!(EXERCISE_KEYS as readonly string[]).includes(k)) {
      ctx.fail(f, `key "${k}" is not in the exercise block — an exercise carries only ${EXERCISE_KEYS.join(', ')}`);
    }
  }
  if (str(fm['description']) === '') ctx.fail(f, 'missing required key: description');
  const type = str(fm['type']);
  if (!(EXERCISE_TYPES as readonly string[]).includes(type)) ctx.fail(f, `type "${type}" — an exercise file is type: ${EXERCISE_TYPES.join(' | ')}`);
  const dir = path.posix.dirname(f.slice(EXERCISES.length));
  if (dir === '.') {
    if ('area' in fm) ctx.fail(f, 'the exercise tree root spans every area — omit area:');
  } else if (str(fm['area']) !== dir) {
    ctx.fail(f, `area "${str(fm['area'])}" must equal the folder: ${dir}`);
  }
  const levels = listOf(fm['level']);
  if (levels === null || levels.length === 0) {
    ctx.fail(f, 'level is not an inline list — write `level: [beginner]`; the parser reads a block list as empty');
  } else {
    for (const l of levels) if (!(LEVELS as readonly string[]).includes(l)) ctx.fail(f, `level "${l}" is not one of ${LEVELS.join(', ')}`);
  }
  if ('related' in fm && listOf(fm['related']) === null) ctx.fail(f, 'related is not an inline list — write `related: [peer-exercise]`');
  if (type === 'exercise' && (!('tags' in fm) || listOf(fm['tags'])?.length === 0)) ctx.fail(f, 'missing required key: tags');
  else if (type === 'exercise' && listOf(fm['tags']) === null) ctx.fail(f, TAGS_NOT_INLINE);
  if (type === 'index' && 'tags' in fm) ctx.fail(f, 'tags on an index — an index lists exercises, it is not one');
  if (firstH1(text) === null) ctx.fail(f, "no '# ' heading — an exercise's H1 is its title, there is no title: key");
  checkDescription(ctx, f, raw);
}

export const spec: GateSpec = {
  name: NAME,
  usage: 'usage: check-doc-frontmatter [--fix] [file…]   (no files: every page under docs/; --fix adds the keys it can)',
  positional: true,
  fixable: true,
  run(ctx: GateContext): string {
    const all = gitFiles(ctx.root, [PAGE_TREE]).filter((f) => f.endsWith('.md') && fs.existsSync(path.join(ctx.root, f)));

    // Named pages narrow the scan. The structure file widens it back to every
    // page, since each page's area is read against it. Any other file is
    // misuse: `make validate-changed` hands over what its glob matched, and a
    // mismatch there is a wrong `scans` glob someone needs to hear about. A
    // layer is inside the tree but held by another gate, so it is dropped.
    const named = ctx.args.map((f) => f.replace(/^\.\//, ''));
    const pages = named.filter((f) => f !== STRUCTURE);
    const strays = pages.filter((f) => !f.startsWith(PAGE_TREE) || !f.endsWith('.md') || !fs.existsSync(path.join(ctx.root, f)));
    if (strays.length > 0) throw new UsageError(`not a markdown file under ${PAGE_TREE}: ${strays.join(', ')}`);
    const whole = named.length === 0 || pages.length < named.length;
    let files = whole ? all : pages;
    files = files.filter((f) => regimeOf(f) !== 'layer');
    if (whole && files.length === 0) {
      ctx.failLine(`no pages found under ${PAGE_TREE} — the scan set is wrong`);
      return '';
    }

    const areas = areaIds(ctx.root);
    if (areas === null) ctx.fail(STRUCTURE, 'is missing or has no areas list — the area list is its area ids');

    const parsed = frontmatterMany(ctx.root, files, { lists: true });
    const raws = frontmatterMany(ctx.root, files, { raw: true });
    const counts: Record<Regime, number> = { layer: 0, refused: 0, exercise: 0, page: 0 };

    for (const f of files) {
      const regime = regimeOf(f);
      counts[regime] += 1;
      const text = fs.readFileSync(path.join(ctx.root, f), 'utf8');
      const hasFm = hasFrontmatter(text);
      const rawDesc = (raws.get(f) as Record<string, string>)['description'] ?? '';

      if (regime === 'refused') {
        ctx.fail(f, "dated records are not kept — report a check's findings in the chat or in the issue its skill opens, and delete this file");
        continue;
      }
      if (regime === 'exercise') {
        if (!hasFm) ctx.fail(f, 'no frontmatter — an exercise carries the exercise block');
        else checkExercise(ctx, f, text, parsed.get(f) as Record<string, FmValue>, rawDesc);
        continue;
      }

      if (!hasFm && !ctx.fixing) {
        ctx.fail(f, `no frontmatter — every page opens with the page block: ${REQUIRED.join(', ')}`);
        continue;
      }
      let fm = parsed.get(f) as Record<string, FmValue>;
      // A key declared twice is its own finding and no other: the parser read
      // its first line and a YAML reader would read another, so its value is
      // neither judged nor repaired until one line is left.
      const doubled = new Set(doubledKeys(text).map((d) => d.key));
      // tags is missing when the key is not there or holds `[]`. A block list
      // reads as "", and saying it is missing would hide what went wrong.
      const missing = REQUIRED.filter(
        (k) => !doubled.has(k) && (k === 'tags' ? !('tags' in fm) || listOf(fm['tags'])?.length === 0 : str(fm[k]).trim() === ''),
      );

      // The repair: missing keys in declared order, the two with a right answer
      // filled in, the rest marked. Then the page is re-read from disk, so
      // everything below measures it as it now stands.
      let current = text;
      const marked = new Set<string>();
      if (ctx.fixing && missing.length > 0) {
        const known: Partial<Record<RequiredKey, string>> = {};
        const h1 = firstH1(text);
        if (h1 !== null) known.title = h1.title;
        const who = owner(ctx.root, f);
        if (who !== '') known.owner = who;
        const values: Partial<Record<RequiredKey, string>> = {};
        for (const k of missing) values[k] = known[k] ?? placeholder(k);
        current = withKeys(text, values);
        fs.writeFileSync(path.join(ctx.root, f), current);
        fm = frontmatter(ctx.root, f, { lists: true });
        for (const k of missing) ctx.fixed(f, known[k] === undefined ? `added ${k}: ${placeholder(k)} — answer it` : `added ${k}`);
      } else {
        for (const k of missing) {
          ctx.fail(f, `missing required key: ${k}`);
          marked.add(k);
        }
      }
      // Read from the page as it now stands: a repair shifts the lines below it.
      for (const d of doubledKeys(current)) {
        failDoubled(ctx, f, d);
        marked.add(d.key);
      }

      for (const k of REQUIRED) {
        if (!marked.has(k) && isMarker(fm[k])) {
          ctx.fail(f, `${k} is ${MARKER} — only you can answer it`);
          marked.add(k);
        }
      }
      for (const k of Object.keys(fm)) {
        if (!PAGE_KEYS.includes(k)) ctx.fail(f, `key "${k}" is not in the page block — the keys are ${PAGE_KEYS.join(', ')}`);
      }

      const status = str(fm['status']);
      if (!marked.has('status') && !(STATUSES as readonly string[]).includes(status)) {
        ctx.fail(f, `status "${status}" is not one of ${STATUSES.join(', ')}${whyOutside(status)}`);
      }
      const area = str(fm['area']);
      if (!marked.has('area') && areas !== null && !areas.has(area)) {
        ctx.fail(f, `area "${area}" is no area of ${STRUCTURE}${whyOutside(area)}`);
      }
      if (!marked.has('tags') && listOf(fm['tags']) === null) ctx.fail(f, TAGS_NOT_INLINE);

      // One name in two places: `title:` is what the site shows, the H1 what
      // GitHub shows. The parser keeps a trailing space; the H1 rule does not.
      const title = str(fm['title']).trim();
      const h1 = firstH1(current);
      if (h1 === null) ctx.fail(f, "no '# ' heading — the H1 is the page's name wherever markdown renders");
      else if (title !== '' && !marked.has('title') && title !== h1.title) {
        ctx.fail(f, `title "${title}" and H1 "${h1.title}" disagree — the site shows one, GitHub the other`);
      }

      // A repaired page declares a description, placeholder or not.
      const desc = current === text ? rawDesc : (frontmatter(ctx.root, f, { fields: ['description'], raw: true })['description'] as string);
      checkDescription(ctx, f, desc);
    }

    const repaired = ctx.repairs > 0 ? `, ${String(ctx.repairs)} key(s) added` : '';
    return `[${NAME}] OK — ${String(counts.page)} pages, ${String(counts.exercise)} exercises${repaired}`;
  },
};

main(spec, import.meta.url);
