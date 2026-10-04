/**
 * The ban gate (spec: kb.data.glossary, ban-gate): check the glossary, then
 * fail every markdown prose line that uses a phrasing a term bans.
 *
 * The data comes first. Every term holds its eight fields, a unique id, a
 * declared scope and `see` ids that resolve and list it back; no phrasing is
 * banned by two terms, and no alias is another term's banned phrasing
 * (glossary-C1..C3). Each fault is one finding against the data file, naming
 * the term. While the data has a fault the prose is not read: a phrasing two
 * terms ban has no one replacement to name.
 *
 * Then the prose. The scan set is every markdown file git lists, committed or
 * not, minus ignored files, the fixture trees and changelogs (glossary-C4): a
 * changelog entry is written in the words of its day, and a fixture tree is broken on purpose and asserted byte for
 * byte. Matching is literal and case-blind, whole-word by the ASCII rule — a
 * match starts and ends at a line edge or beside anything but a letter, digit
 * or underscore — and a trailing `s` or `es` still matches (glossary-C5).
 * Fenced code (a fence inside a blockquote or opened on a list item's first
 * line included), inline code, raw HTML `<code>` and `<pre>`, frontmatter
 * keys and the `solves` and `aliases` values (a searcher's words, and other
 * names for the thing), link targets, raw HTML tags, comments and a trailing
 * `{#id}` suffix are not prose; a line carrying `<!-- vocab-ok -->` opts out,
 * that line only (glossary-C6). A tracked file deleted but not yet staged has
 * nothing on disk to read and is left out. Where two banned phrasings
 * overlap, the longer one is the finding ("derived class" names subclass, not
 * computed). A finding quotes the phrasing and the banning term, verbatim, as
 * the replacement (glossary-C7).
 *
 * Exceptions come from the gate's own list, docs/data/allow/vocabulary.json
 * (spec: kb.data.exceptions): an entry excuses the hits in the files it
 * matches, whole path; a whole run fails an entry that excused no hit, so none
 * outlives its cause. A banned phrasing is a failure, never a category, so
 * every entry excuses a failure and owes an owner and a since date
 * (exceptions-C3). There is no `--fix`: a person chooses the word
 * (glossary-C9).
 *
 * Named files narrow the prose scan (the data is checked on every run), except
 * when the glossary or the allowlist is among them: either one changes what
 * every file owes, so the run is whole.
 *
 * Usage: check-vocabulary [file…]   (no files: every markdown file git lists)
 */

import fs from 'node:fs';
import path from 'node:path';

import { Allowlist, readAllowlist } from '../lib/allowlist.js';
import { gitFiles, records } from '../lib/exec.js';
import { main, UsageError, type GateContext, type GateSpec } from '../lib/gate.js';
import { splitTrailingSuffix } from '../lib/kb-attrs.js';

export const SRC = 'docs/data/glossary.json';
export const ALLOWLIST = 'docs/data/allow/vocabulary.json';
/** The opt-out marker (spec: interfaces/page-frontmatter.md): frees its own line, never the next. */
export const MARKER = '<!-- vocab-ok -->';

/** The eight fields every term holds (glossary-C1). */
export const FIELDS = ['id', 'term', 'definition', 'aliases', 'avoid', 'scope', 'owner', 'see'] as const;
const STRING_FIELDS = new Set(['id', 'term', 'definition', 'scope', 'owner']);

/** Trees broken on purpose, whose wording other tests pin byte for byte. */
export const FIXTURE_TREES: readonly string[] = ['scripts/test/fixture/', 'tests/fixtures/'];

/** A changelog: dated entries in the words of their release. */
export function isChangelog(file: string): boolean {
  return path.posix.basename(file) === 'CHANGELOG.md';
}

/** The one predicate the listed scan set and a named path both pass through. */
export function unscanned(file: string): boolean {
  return FIXTURE_TREES.some((t) => file.startsWith(t)) || isChangelog(file);
}

const isMarkdown = (file: string): boolean => file.endsWith('.md') || file.endsWith('.mdx');

/**
 * Frontmatter fields that record other people's words, not the house's: the
 * phrases a searcher types (`solves`) and the names a thing goes by elsewhere
 * (`aliases`). A searcher's own words must still find the page, even the
 * ones the house retires, so the ban does not reach them (glossary-C10).
 */
export const RECORDED_FIELDS: readonly string[] = ['solves', 'aliases'];

// ---------------------------------------------------------------------------
// 1. The data
// ---------------------------------------------------------------------------

interface RawTerm {
  readonly [key: string]: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A term's name in a finding: its id when it has one it can print. */
function label(t: RawTerm, i: number): string {
  return typeof t['id'] === 'string' && t['id'] !== '' ? t['id'] : `#${String(i + 1)}`;
}

/** The glossary's faults, one message each, in term order; empty when it is sound. */
export function dataFindings(data: unknown): string[] {
  if (!isObject(data)) return ['is not a JSON object'];
  if (!isObject(data['scopes'])) return ['`scopes` is missing or is not an object'];
  if (!Array.isArray(data['terms'])) return ['`terms` is missing or is not an array'];
  const scopes = Object.keys(data['scopes']);
  const out: string[] = [];
  const terms: RawTerm[] = [];

  // Shape first: a term with a missing or mistyped field says so once, and
  // the checks below read only the fields it has in good shape.
  (data['terms'] as unknown[]).forEach((raw, i) => {
    if (!isObject(raw)) {
      out.push(`term #${String(i + 1)}: is not an object`);
      terms.push({});
      return;
    }
    const missing = FIELDS.filter((f) => !Object.prototype.hasOwnProperty.call(raw, f));
    if (missing.length > 0) out.push(`term ${label(raw, i)}: missing ${missing.join(', ')}`);
    const bad = FIELDS.filter((f) => !missing.includes(f)).filter((f) =>
      STRING_FIELDS.has(f) ? typeof raw[f] !== 'string' || (raw[f] as string).trim() === '' : !stringList(raw[f]),
    );
    if (bad.length > 0) out.push(`term ${label(raw, i)}: ${bad.map((f) => (STRING_FIELDS.has(f) ? `${f} is not a non-empty string` : `${f} is not a list of strings`)).join('; ')}`);
    terms.push(Object.fromEntries(FIELDS.filter((f) => !missing.includes(f) && !bad.includes(f)).map((f) => [f, raw[f]])));
  });

  // Grouped, so an id three terms share is one finding, at its first use.
  const byId = new Map<string, RawTerm>();
  const counts = new Map<string, number>();
  for (const t of terms) {
    const id = t['id'];
    if (typeof id !== 'string') continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!byId.has(id)) byId.set(id, t);
  }
  for (const [id, n] of counts) if (n > 1) out.push(`duplicate id: ${id} (${String(n)} terms)`);

  terms.forEach((t, i) => {
    const id = label(t, i);
    if (typeof t['scope'] === 'string' && !scopes.includes(t['scope'])) {
      out.push(`term ${id}: unknown scope "${t['scope']}" (expected one of: ${scopes.join(', ')})`);
    }
    for (const ref of (t['see'] as string[] | undefined) ?? []) {
      const other = byId.get(ref);
      if (ref === t['id']) out.push(`term ${id}: see names the term itself`);
      else if (other === undefined) out.push(`term ${id}: see names "${ref}", which is no term`);
      else if (stringList(other['see']) && !other['see'].includes(id)) {
        out.push(`term ${id}: see names ${ref}, which does not list ${id} back`);
      }
    }
    for (const phrase of (t['avoid'] as string[] | undefined) ?? []) {
      if (phrase.trim() === '') out.push(`term ${id}: avoid holds an empty phrasing`);
    }
  });

  // One phrasing, one owner: a phrasing two terms ban has no one replacement.
  const owners = new Map<string, string[]>();
  terms.forEach((t, i) => {
    for (const phrase of new Set(((t['avoid'] as string[] | undefined) ?? []).map((p) => p.toLowerCase()))) {
      if (phrase.trim() === '') continue;
      owners.set(phrase, [...(owners.get(phrase) ?? []), label(t, i)]);
    }
  });
  for (const [phrase, who] of [...owners].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (who.length > 1) out.push(`banned phrasing "${phrase}" belongs to more than one term: ${who.join(', ')}`);
  }
  // An alias is a word to write, so no term may ban it — nor may a term ban its own word.
  terms.forEach((t, i) => {
    const words = [...(typeof t['term'] === 'string' ? [t['term']] : []), ...((t['aliases'] as string[] | undefined) ?? [])];
    for (const w of words) {
      const who = owners.get(w.toLowerCase());
      if (who === undefined) continue;
      out.push(
        who.includes(label(t, i))
          ? `term ${label(t, i)}: bans "${w}", which it also says to write`
          : `term ${label(t, i)}: "${w}" is a word to write here and a banned phrasing of ${who.join(', ')}`,
      );
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// 2. The prose
// ---------------------------------------------------------------------------

/**
 * Remove the inline code spans of one line: a run of N backticks up to the
 * next run of exactly N (CommonMark). An unmatched run is literal text.
 */
export function stripCodeSpans(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === '\\' && line[i + 1] === '`') {
      out += '\\`';
      i += 2;
      continue;
    }
    if (c !== '`') {
      out += c;
      i += 1;
      continue;
    }
    let n = 0;
    while (line[i + n] === '`') n += 1;
    let j = i + n;
    let close = -1;
    while (j < line.length) {
      if (line[j] !== '`') {
        j += 1;
        continue;
      }
      let m = 0;
      while (line[j + m] === '`') m += 1;
      if (m === n) {
        close = j;
        break;
      }
      j += m;
    }
    if (close === -1) {
      out += '`'.repeat(n);
      i += n;
    } else {
      out += ' ';
      i = close + n;
    }
  }
  return out;
}

/**
 * The prose of one line outside code: code spans, comments, raw HTML `<code>`
 * and `<pre>` spans with what they hold, raw HTML tags, link targets and a
 * trailing `{…}` suffix removed, each left as a space so no two words join.
 */
export function proseOf(line: string): string {
  return outsideCode(stripCodeSpans(line));
}

/** proseOf for a line whose code spans are already gone. */
function outsideCode(code: string): string {
  let text = code
    .replace(/<!--.*?-->/g, ' ')
    .replace(/<(code|pre)(?:\s[^<>]*)?>.*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?[A-Za-z][^<>]*>/g, ' ')
    .replace(/<(?:https?|mailto):[^<>\s]*>/g, ' ')
    .replace(/\]\([^()\s]*(?:\s+"[^"]*")?\)/g, '] ')
    .replace(/^(\s*\[[^\]]+\]:)\s+\S+.*$/, '$1');
  const suffix = splitTrailingSuffix(text.trimEnd());
  if (suffix !== null) text = suffix.text;
  return text;
}

/**
 * Up to `max` blockquote markers opening a line — each up to three spaces, a
 * `>` and one optional space (CommonMark) — counted, and the text after them.
 */
export function unquote(raw: string, max = Number.POSITIVE_INFINITY): { depth: number; text: string } {
  let depth = 0;
  let text = raw;
  for (let m = /^ {0,3}> ?/.exec(text); m !== null && depth < max; m = /^ {0,3}> ?/.exec(text)) {
    depth += 1;
    text = text.slice(m[0].length);
  }
  return { depth, text };
}

/** An open fence: what closes it, and the container whose end ends it too. */
export interface Fence {
  /** The opening run: a run of its character at least as long closes it. */
  readonly run: string;
  /** The blockquote depth it opened at: a line with fewer markers ends it. */
  readonly depth: number;
  /** The content column of the list item it opened in: a non-blank line indented less ends it. */
  readonly indent: number | null;
}

const indentOf = (text: string): number => (/^ */.exec(text) as RegExpExecArray)[0].length;

/**
 * The content columns of the list items open at a line (out of its
 * blockquotes), innermost last, given those open at the line before. A blank
 * line changes nothing; any other line closes every item whose content column
 * it does not reach, and a marker line then opens its own item, whose content
 * starts after the marker and its one to four spaces (CommonMark).
 */
export function openItems(items: readonly number[], text: string): number[] {
  if (text.trim() === '') return [...items];
  const indent = indentOf(text);
  const kept = items.filter((column) => column <= indent);
  const marker = /^ *(?:[-*+]|\d{1,9}[.)])(?= |$)/.exec(text);
  if (marker !== null) {
    const spaces = indentOf(text.slice(marker[0].length));
    kept.push(marker[0].length + (spaces === 0 || spaces > 4 ? 1 : spaces));
  }
  return kept;
}

/**
 * The fence a line opens, given the line out of its blockquotes, their depth
 * and the content column of the list item it sits in (0 outside a list), or
 * null. A list marker may open the line. An opener indented four or more
 * past that column is indented code, not a fence. A backtick fence's info
 * string holds no backtick (CommonMark), so a line that opens on an inline
 * triple-backtick span is prose, not a fence.
 */
export function fenceOpener(text: string, depth: number, column = 0): Fence | null {
  const item = /^ {0,3}(?:[-*+]|\d{1,9}[.)]) {1,4}(?=```|~~~)/.exec(text);
  if (item === null && indentOf(text) - column > 3) return null;
  const body = item === null ? text : text.slice(item[0].length);
  const m = /^ *(?:(`{3,})(?!.*`)|(~{3,}))/.exec(body);
  if (m === null) return null;
  return { run: (m[1] ?? m[2]) as string, depth, indent: column > 0 ? column : null };
}

/** Does this line, out of the fence's blockquotes, close the fence? */
function closes(fence: Fence, text: string): boolean {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(text);
  return m !== null && (m[1] as string)[0] === fence.run[0] && (m[1] as string).length >= fence.run.length;
}

/** One banned phrasing and the term that bans it. */
export interface Ban {
  readonly phrase: string;
  readonly term: string;
  readonly aliases: readonly string[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One case-blind pattern for every banned phrasing, longest first, so at any
 * position the longest phrasing wins. The boundary is spelled out, never
 * `\b`, which changes meaning under the `u` flag (glossary-C5).
 */
export function banPattern(bans: readonly Ban[]): RegExp {
  const alts = [...bans].map((b) => b.phrase).sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRe);
  return new RegExp(`(?<![A-Za-z0-9_])(${alts.join('|')})(?:s|es)?(?![A-Za-z0-9_])`, 'gi');
}

export interface Hit {
  readonly line: number;
  readonly ban: Ban;
}

/**
 * Every banned phrasing on every prose line of one markdown text, one hit per
 * phrasing per line. Frontmatter is read for its values, not its keys, and
 * not for the fields that record other people's words. Skipped
 * whole: a fence (``` or ~~~, closed by the same character at least as long,
 * or ended with the blockquote or list item it opened in), a raw HTML `<pre>`
 * block and a comment running over several lines. The line that closes a
 * `<pre>` block or a comment is read from the closing tag on: what follows it
 * is shown to the reader.
 */
export function hitsIn(text: string, bans: ReadonlyMap<string, Ban>, re: RegExp): Hit[] {
  const lines = records(text);
  const out: Hit[] = [];
  let fence: Fence | null = null;
  let comment = false;
  let pre = false;
  let front = lines[0]?.trim() === '---';
  let field = '';
  let items: number[] = [];
  lines.forEach((raw, i) => {
    let text = raw;
    if (front) {
      if (i === 0) return;
      if (raw.trim() === '---') {
        front = false;
        return;
      }
      // A top-level key starts a field; a list item or an indented line continues it.
      field = /^([A-Za-z0-9_-]+):/.exec(raw)?.[1] ?? field;
      if (RECORDED_FIELDS.includes(field)) return;
      text = raw.replace(/^\s*(?:-\s+|[A-Za-z0-9_-]+:\s*)/, '');
    } else {
      if (fence !== null) {
        const inside = unquote(raw, fence.depth);
        const left = inside.depth < fence.depth || (fence.indent !== null && inside.text.trim() !== '' && indentOf(inside.text) < fence.indent);
        if (!left) {
          if (closes(fence, inside.text)) fence = null;
          return;
        }
        fence = null; // its container ended, and the fence with it: the line is read as usual
      }
      if (comment || pre) {
        const close = comment ? /-->/.exec(raw) : /<\/pre\s*>/i.exec(raw);
        if (close === null) return;
        comment = false;
        pre = false;
        text = raw.slice(close.index + close[0].length);
      } else {
        const quoted = unquote(raw);
        items = openItems(items, quoted.text);
        const opened = fenceOpener(quoted.text, quoted.depth, items.at(-1));
        if (opened !== null) {
          fence = opened;
          return;
        }
        if (/^\s*<pre(?=[\s>]|$)/i.test(quoted.text) && !/<\/pre\s*>/i.test(quoted.text)) {
          pre = true;
          return;
        }
      }
    }
    let code = stripCodeSpans(text);
    if (code.includes(MARKER)) return;
    if (!front) {
      // A comment opener left once every closed comment is blanked, and
      // never one inside a code span: the rest of the line is the comment's.
      const open = code.replace(/<!--.*?-->/g, (c) => ' '.repeat(c.length)).indexOf('<!--');
      if (open !== -1) {
        comment = true;
        code = code.slice(0, open);
      }
    }
    const said = new Set<string>();
    for (const m of outsideCode(code).matchAll(re)) {
      const ban = bans.get((m[1] as string).toLowerCase()) as Ban;
      if (said.has(ban.phrase)) continue;
      said.add(ban.phrase);
      out.push({ line: i + 1, ban });
    }
  });
  return out;
}

/** The finding for one hit: the phrasing, then the replacement to paste (glossary-C7). */
export function message(ban: Ban): string {
  const also = ban.aliases.length > 0 ? ` — also fine: ${ban.aliases.join(', ')}` : '';
  return `use "${ban.term}" not "${ban.phrase}"${also}`;
}

/**
 * Every markdown file git lists that the gate reads (glossary-C4) and that is
 * on disk: git still lists a tracked file deleted but not yet staged, and
 * there is nothing of it left to read.
 */
export function scanSet(root: string): string[] {
  return gitFiles(root, ['*.md', '*.mdx']).filter(
    (f) => !unscanned(f) && fs.statSync(path.join(root, f), { throwIfNoEntry: false })?.isFile() === true,
  );
}

export const spec: GateSpec = {
  name: 'vocabulary',
  usage: 'usage: check-vocabulary [file…]   (no files: every markdown file git lists; there is no --fix, a person chooses the word)',
  positional: true,
  run(ctx: GateContext): string {
    const src = path.join(ctx.root, SRC);
    if (!fs.existsSync(src)) {
      ctx.fail(SRC, 'is missing — every banned phrasing is read from it (restore it from git)');
      return '';
    }
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(src, 'utf8'));
    } catch {
      ctx.fail(SRC, 'is not valid JSON');
      return '';
    }
    for (const what of dataFindings(data)) ctx.fail(SRC, what);

    // Named files narrow the prose scan only; the data is checked on every run.
    const named = ctx.args.map((f) => f.replace(/^\.\//, ''));
    for (const f of named) if (!fs.existsSync(path.join(ctx.root, f))) throw new UsageError(`no such file: ${f}`);
    const list = readAllowlist(ctx, ALLOWLIST, {
      missing: 'it holds the exceptions to the ban, and exists even when it holds none',
      emptyReason: 'has an empty reason — say why these files may use a banned phrasing',
      excusesFailures: true,
    });
    if (ctx.findings > 0 || list === null) return '';

    // A changed glossary or allowlist changes what every file owes, so naming
    // either one is a whole run: a new banned phrasing must reach untouched files.
    const whole = named.length === 0 || named.some((f) => f === SRC || f === ALLOWLIST);
    const files = whole ? scanSet(ctx.root) : named.filter((f) => isMarkdown(f) && !unscanned(f));
    if (files.length === 0) {
      if (!whole) return `[vocabulary] no markdown file among the ${String(named.length)} path(s) named`;
      ctx.failLine('no markdown file to scan — the scan set is wrong');
      return '';
    }

    const bans = new Map<string, Ban>();
    const terms = (data as { terms: Record<string, unknown>[] }).terms;
    for (const t of terms) {
      for (const phrase of t['avoid'] as string[]) {
        bans.set(phrase.toLowerCase(), { phrase, term: t['term'] as string, aliases: t['aliases'] as string[] });
      }
    }
    const allow = new Allowlist(list);
    let excused = 0;
    if (bans.size > 0) {
      const re = banPattern([...bans.values()]);
      for (const file of files) {
        const buf = fs.readFileSync(path.join(ctx.root, file));
        if (buf.includes(0)) continue; // not prose
        const hits = hitsIn(buf.toString('utf8'), bans, re);
        if (hits.length === 0) continue;
        if (allow.excuses(file)) {
          excused += hits.length;
          continue;
        }
        for (const h of hits) ctx.fail(file, message(h.ban), h.line);
      }
    }
    // An exception must not outlive its cause (exceptions-C5), judged on a whole run only.
    if (whole) {
      for (const e of allow.unused()) {
        ctx.fail(ALLOWLIST, `entry "${e.name}" excuses nothing — no file it matches uses a banned phrasing; delete it`);
      }
    }
    const applied = allow.applied;
    return (
      `[vocabulary] no banned phrasing in ${String(files.length)} markdown files ` +
      `(${String(bans.size)} phrasings from ${String(terms.length)} terms); ` +
      `${String(applied)} allowlist ${applied === 1 ? 'entry' : 'entries'} applied, excusing ${String(excused)} ${excused === 1 ? 'hit' : 'hits'}`
    );
  },
};

main(spec, import.meta.url);
