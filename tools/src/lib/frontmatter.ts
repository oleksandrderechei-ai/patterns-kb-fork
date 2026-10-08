/**
 * The TypeScript door into page frontmatter, and the one printer that writes it.
 *
 * READING goes through `scripts/fm-json.sh` — never a parser here. The repo has
 * exactly one YAML reader, the awk in `scripts/lib-frontmatter.sh`, and every
 * tool reaches it as a subprocess (spec: kb.content.frontmatter, "the only
 * frontmatter parser"). The script is resolved from THIS package, not from the
 * tree a gate is pointed at: a gate run against a sandbox checkout still reads
 * frontmatter the one real way (frontmatter-C5, "tools locate the parser
 * beside themselves").
 *
 *   frontmatter(root, file)             one file, values as strings
 *   frontmatter(root, file, {lists})    inline lists as string[]
 *   frontmatterMany(root, files, …)     a whole batch in ONE spawn (`--many`)
 *
 * A key is present exactly when the file declares it; its value may be "".
 * A block list (`tags:` then indented `- a` lines) reads as "" — so `listOf`
 * answers null, "not a list", never "no items".
 *
 * WRITING is `printFrontmatter`: the dialect's frontmatter shape (inline
 * lists, double quotes where a plain YAML scalar would change meaning), so a
 * converter, `kb.mjs set` and a test all emit the same bytes. Its tests prove
 * every value it prints reads back unchanged through the parser.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './exec.js';

/** scripts/fm-json.sh, beside this package: tools/src/lib → repo root. */
export const FM_JSON = path.resolve(fileURLToPath(import.meta.url), '../../../../scripts/fm-json.sh');

/** A frontmatter value: a string, or with `lists` an inline list's items. */
export type FmValue = string | readonly string[];

export interface FmOptions {
  /** Only these fields, and only the ones present. */
  readonly fields?: readonly string[];
  /** Values exactly as written, quotes and all. Excludes `lists`. */
  readonly raw?: boolean;
  /** Inline lists as arrays; everything else stays a string. */
  readonly lists?: boolean;
}

/** More paths than this go in several spawns, to stay far below ARG_MAX. */
export const MANY_CHUNK = 2000;

function flags(opts: FmOptions): string[] {
  if (opts.raw === true && opts.lists === true) throw new Error('frontmatter: raw and lists are exclusive');
  return [...(opts.raw === true ? ['--raw'] : []), ...(opts.lists === true ? ['--lists'] : [])];
}

function call(root: string, args: readonly string[], what: string): unknown {
  const r = run('bash', [FM_JSON, ...args], root);
  if (r.status !== 0) throw new Error(`fm-json.sh ${what}: ${r.stderr.trim() || `exit ${r.status}`}`);
  return JSON.parse(r.stdout) as unknown;
}

/**
 * One file's frontmatter. `file` is relative to `root` (or absolute). Throws
 * when the script refuses — an unreadable path is misuse, not an empty answer.
 */
export function frontmatter(root: string, file: string, opts?: FmOptions & { lists?: false }): Record<string, string>;
export function frontmatter(root: string, file: string, opts: FmOptions & { lists: true }): Record<string, FmValue>;
export function frontmatter(root: string, file: string, opts: FmOptions = {}): Record<string, FmValue> {
  return call(root, [...flags(opts), file, ...(opts.fields ?? [])], file) as Record<string, FmValue>;
}

/**
 * Many files' frontmatter, keyed by each path exactly as given, in argument
 * order. One spawn per `MANY_CHUNK` paths — one for any realistic page tree.
 * Field filtering is not offered here: the script prints every field, and a
 * caller wanting three keys reads three keys.
 */
export function frontmatterMany(
  root: string,
  files: readonly string[],
  opts?: Omit<FmOptions, 'fields'> & { lists?: false },
): Map<string, Record<string, string>>;
export function frontmatterMany(
  root: string,
  files: readonly string[],
  opts: Omit<FmOptions, 'fields'> & { lists: true },
): Map<string, Record<string, FmValue>>;
export function frontmatterMany(
  root: string,
  files: readonly string[],
  opts: Omit<FmOptions, 'fields'> = {},
): Map<string, Record<string, FmValue>> {
  const out = new Map<string, Record<string, FmValue>>();
  for (let i = 0; i < files.length; i += MANY_CHUNK) {
    const chunk = files.slice(i, i + MANY_CHUNK);
    const got = call(root, [...flags(opts), '--many', ...chunk], `--many (${chunk.length} files)`) as Record<
      string,
      Record<string, FmValue>
    >;
    // fm-json.sh --many answers every file it is handed, {} for one with no
    // frontmatter, and fails the call on a file it cannot read.
    for (const f of chunk) out.set(f, got[f] as Record<string, FmValue>);
  }
  return out;
}

/**
 * An inline list's items, or null when the value is not one. A narrowing, not
 * a parser: the splitting already happened in the shell.
 */
export function listOf(value: FmValue | undefined): readonly string[] | null {
  return Array.isArray(value) ? (value as readonly string[]) : null;
}

// ---------------------------------------------------------------------------
// The printer
// ---------------------------------------------------------------------------

/**
 * The most words one `solves` phrase holds (KB-013). A phrase is one problem
 * in one short sentence: the search box prints it as the result's snippet,
 * and a small model reading the list has to take each in at a glance. The
 * shape gate and `kb.mjs validate` hold a phrase to it; the writer, `kb.mjs
 * set --solves`, does not, so run `kb.mjs validate` after setting one.
 */
export const SOLVES_MAX_WORDS = 20;

/** The words of one `solves` phrase, split on white space. */
export const solvesWords = (phrase: string): number => phrase.trim().split(/\s+/).filter((w) => w !== '').length;

/**
 * A scalar as the dialect writes it: plain when YAML would read the plain
 * text back as the same string, else double-quoted with `\\` and `\"` — the
 * only two escapes the parser honours. Quoted when it holds a comma or a
 * colon (the owner's rule: a comma splits an inline list, a colon starts a
 * mapping), or any other flow indicator, a `#`, a quote or a backslash; when
 * it starts with a YAML indicator or a space; when it ends with a space; when
 * it is empty; and when a YAML reader would take it for a boolean, a null or
 * a number (the site's schema reads these files too, with a real YAML parser).
 * A value holding a line break or a tab is refused: every value is one line.
 */
export function yamlScalar(s: string): string {
  if (/[\n\r\t]/.test(s)) throw new Error(`frontmatter values are one line: ${JSON.stringify(s)}`);
  const needs =
    s === '' ||
    /[,:#[\]{}"\\]/.test(s) ||
    /^[-?&*!|>'%@`\s]/.test(s) ||
    /\s$/.test(s) ||
    /^(?:true|false|yes|no|on|off|null|~)$/i.test(s) ||
    /^[-+]?(?:\d|\.\d)/.test(s);
  return needs ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
}

/** `[a, "b, c"]` — each item by `yamlScalar`'s rule. */
export function yamlInlineList(items: readonly string[]): string {
  return `[${items.map(yamlScalar).join(', ')}]`;
}

/** One frontmatter entry: a string, a list, or `true` for a flag like `favourite`. */
export type FmEntry = readonly [key: string, value: string | readonly string[] | true];

/**
 * The whole block, fences included, trailing newline included:
 * `---\ntitle: …\n---\n`. Entries print in the order given; a key must be a
 * plain YAML key.
 */
export function printFrontmatter(entries: readonly FmEntry[]): string {
  const lines = entries.map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) throw new Error(`not a frontmatter key: ${key}`);
    if (value === true) return `${key}: true`;
    return `${key}: ${typeof value === 'string' ? yamlScalar(value) : yamlInlineList(value)}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}
