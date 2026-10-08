/**
 * The rule that keeps a published schema published: inside one major version a
 * schema only grows. A reader written against `kb-record/1` has to keep
 * reading `kb-record/1` whatever is added to it, so a key, a type, a value or
 * a promise the schema made is never taken back. What would take one back is a
 * new major version, a new file beside the old one, which is then published
 * and frozen in turn.
 *
 * The baseline is a frozen copy of every published schema in
 * tools/src/contract/golden/, byte for byte the schema as it was when it was
 * last frozen. It is a file of the tree and not the git history, so it is
 * there in the pre-commit hook's extract, which has none. This module compares
 * a schema with its frozen copy, node by node, and names each place where the
 * schema lost or changed something, as a JSON Pointer into the frozen file.
 *
 *   evolutionViolations   what a schema lost or changed since its frozen copy
 *   evolutionProblems     the same for every schema of a tree, one line each,
 *                         and the three folder rules below
 *   freezeSchemas         write the frozen copies, for a change a person reviewed
 *   goldenDir             the folder the frozen copies are in, under a given root
 *
 * A SCHEMA MAY GAIN, AND NOTHING ELSE: a property, anywhere among the others;
 * an entry of `required`; a value of an `enum`; a definition; a branch after
 * the last one of a `oneOf` or `anyOf`; `null` beside a `type`; and words in a
 * `title`, `description` or `$comment`.
 *
 * It may not: drop a property, a definition or a branch of a union, at any
 * depth; narrow or change a `type`, where the one type that may be added is
 * `null`; drop a value of an `enum`, drop the `enum`, or put one where any
 * value passed; drop an entry of `required`; change what `$id`, `$schema`,
 * `$ref`, `const`, `pattern`, `minimum`, `minLength`, `minItems` or
 * `maxItems` say, or add or drop one; add or drop `items`,
 * `additionalProperties` or a whole union; or put the properties it lists in
 * another order, which a record's bytes follow.
 *
 * Three rules sit over the folder. A frozen copy with no schema file is a
 * published schema deleted. A schema file with no frozen copy was never
 * frozen: a new major version gets its copy from `freezeSchemas`, on purpose.
 * And a schema that differs from its copy and lost nothing is named `gained
 * only`: any edit of a schema fails until `freezeSchemas` refreshes its copy,
 * so that what the schema gained is held from then on. Without that, a key
 * added after the last freeze could be dropped later with no copy to say it
 * had been promised.
 *
 * What it cannot prove it does not allow: a pattern that got looser reads the
 * same as one that got tighter, so any change to one is named. A change a
 * person judges additive anyway deletes the frozen copy and freezes again, and
 * the diff then shows what was replaced. `freezeSchemas` refuses to freeze a
 * change this module names, so a break is never frozen by accident.
 *
 * Nothing here reads a clock, a random number or the environment.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SCHEMA_DIR, schemaDir } from './contract.js';

/** The folder the frozen copies are in, relative to the repo root and written with `/`, as a finding names a file. */
export const GOLDEN_DIR = 'tools/src/contract/golden';

/** The frozen copies of the repo at `root`. */
export function goldenDir(root: string): string {
  return path.join(root, GOLDEN_DIR);
}

/**
 * The keywords whose value is held as it was, present with the same value or
 * absent. The other keywords the contract allows are read piece by piece
 * (`type`, `enum`, `required`, `properties`, `$defs`, `items`,
 * `additionalProperties`, `oneOf`, `anyOf`) or describe a schema without
 * constraining a value (`title`, `description`, `$comment`).
 */
export const HELD_KEYWORDS: readonly string[] = ['$schema', '$id', '$ref', 'const', 'pattern', 'minimum', 'minLength', 'minItems', 'maxItems'];

/** One place where a schema lost or changed something its frozen copy had. */
export interface Violation {
  /** Where, as a JSON Pointer into the frozen schema file: the keyword, member or entry concerned. `''` is the document itself. */
  readonly pointer: string;
  /** What was lost or changed, in words. */
  readonly message: string;
}

type Node = Readonly<Record<string, unknown>>;

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One JSON Pointer segment with its leading slash: `~` is written `~0` and `/` is `~1`, `~` first (RFC 6901). */
const segment = (name: string): string => `/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** A value as JSON, the way a finding quotes it. */
const show = (value: unknown): string => JSON.stringify(value);

/** Whether two values are the same JSON; two absent values are. */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The members of a keyword that holds an object of schemas or values; none when it is not there. */
const members = (value: unknown): Node => (isNode(value) ? value : {});

/** The strings of a keyword that holds a list of them; none when it is not there. */
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** What a held keyword says about `before` and `after`, or nothing when they agree. */
function heldProblem(keyword: string, before: unknown, after: unknown): string | null {
  if (same(before, after)) return null;
  if (before === undefined) return `"${keyword}" was added (${show(after)}), so a value that passed may fail now`;
  if (after === undefined) return `"${keyword}" was removed; it was ${show(before)}`;
  return `"${keyword}" changed from ${show(before)} to ${show(after)}`;
}

/** The type names a `type` keyword lists, or undefined when it is not there. */
const typeNames = (type: unknown): string[] | undefined => (type === undefined ? undefined : Array.isArray(type) ? type.map(String) : [String(type)]);

/** What a `type` lost or changed, or nothing when it only gained `null` or stayed the same. */
function typeProblem(before: unknown, after: unknown): string | null {
  const was = typeNames(before);
  const is = typeNames(after);
  if (was === undefined && is === undefined) return null;
  if (was === undefined) return `type ${show(after)} was added where there was none`;
  if (is === undefined) return `type was removed; it was ${show(before)}`;
  if (is.some((t) => !was.includes(t) && t !== 'null')) {
    return `type changed from ${show(before)} to ${show(after)}; the only type that may be added is "null"`;
  }
  return was.some((t) => !is.includes(t)) ? `type narrowed from ${show(before)} to ${show(after)}` : null;
}

/**
 * Compare the schema node `was` with `is`, which sits at the same place in the
 * current schema, and add every violation under `at` to `out`. A node that is
 * not an object (`true`, `false`) may not change at all.
 */
function compare(was: unknown, is: unknown, at: string, out: Violation[]): void {
  if (!isNode(was) || !isNode(is)) {
    if (!same(was, is)) out.push({ pointer: at, message: `changed from ${show(was)} to ${show(is)}` });
    return;
  }
  const add = (pointer: string, message: string): void => {
    out.push({ pointer, message });
  };

  for (const keyword of HELD_KEYWORDS) {
    const message = heldProblem(keyword, was[keyword], is[keyword]);
    if (message !== null) add(`${at}${segment(keyword)}`, message);
  }

  const type = typeProblem(was['type'], is['type']);
  if (type !== null) add(`${at}/type`, type);

  if (Array.isArray(was['enum'])) {
    if (!Array.isArray(is['enum'])) {
      add(`${at}/enum`, `enum was removed; it listed ${show(was['enum'])}`);
    } else {
      const kept = is['enum'].map(show);
      was['enum'].forEach((value, i) => {
        if (!kept.includes(show(value))) add(`${at}/enum/${String(i)}`, `enum value ${show(value)} was removed`);
      });
    }
  } else if (Array.isArray(is['enum'])) {
    add(`${at}/enum`, 'enum was added where any value passed');
  }

  const needed = new Set(strings(is['required']));
  strings(was['required']).forEach((name, i) => {
    if (!needed.has(name)) add(`${at}/required/${String(i)}`, `"${name}" is no longer required`);
  });

  for (const [keyword, noun] of [['properties', 'property'], ['$defs', 'definition']] as const) {
    const before = members(was[keyword]);
    const after = members(is[keyword]);
    for (const name of Object.keys(before)) {
      const here = `${at}/${keyword}${segment(name)}`;
      if (Object.hasOwn(after, name)) compare(before[name], after[name], here, out);
      else add(here, `${noun} "${name}" was removed`);
    }
    if (keyword === 'properties') {
      // The keys a record prints follow this order, so the ones that stayed keep it.
      const kept = Object.keys(before).filter((name) => Object.hasOwn(after, name));
      const now = Object.keys(after);
      kept.forEach((name, i) => {
        const earlier = kept[i - 1];
        if (earlier !== undefined && now.indexOf(name) < now.indexOf(earlier)) {
          add(`${at}/properties${segment(name)}`, `property "${name}" now comes before "${earlier}", which it follows in the frozen schema`);
        }
      });
    }
  }

  for (const keyword of ['items', 'additionalProperties'] as const) {
    if (Object.hasOwn(was, keyword) && Object.hasOwn(is, keyword)) compare(was[keyword], is[keyword], `${at}/${keyword}`, out);
    else if (Object.hasOwn(was, keyword)) add(`${at}/${keyword}`, `"${keyword}" was removed`);
    else if (Object.hasOwn(is, keyword)) add(`${at}/${keyword}`, `"${keyword}" was added where there was none`);
  }

  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const before = was[keyword];
    const after = is[keyword];
    if (!Array.isArray(before) && !Array.isArray(after)) continue;
    if (!Array.isArray(before)) add(`${at}/${keyword}`, `"${keyword}" was added where there was none`);
    else if (!Array.isArray(after)) add(`${at}/${keyword}`, `"${keyword}" was removed`);
    else {
      // A branch added after the last one only widens what passes; one taken out or changed does not.
      before.forEach((branch, i) => {
        if (i < after.length) compare(branch, after[i], `${at}/${keyword}/${String(i)}`, out);
        else add(`${at}/${keyword}/${String(i)}`, `${keyword} branch ${String(i)} was removed`);
      });
    }
  }
}

/**
 * Everything the schema `current` lost or changed since `frozen`, in the order
 * the walk meets it: at each node the held keywords, then `type`, `enum`,
 * `required`, the properties, the definitions, `items`, `additionalProperties`
 * and the unions. Nothing when `current` only gained.
 */
export function evolutionViolations(frozen: unknown, current: unknown): Violation[] {
  const out: Violation[] = [];
  compare(frozen, current, '', out);
  return out;
}

/** One violation as one line: `<file> /properties/route: property "route" was removed`. The document itself is `/`. */
export function formatViolation(file: string, violation: Violation): string {
  return `${file} ${violation.pointer === '' ? '/' : violation.pointer}: ${violation.message}`;
}

/** The names of the `*.json` files of `dir`, in name order by code unit; none when the folder is not there. */
function jsonNames(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
}

/** A JSON file, parsed. A file that does not parse throws an `Error` that names it, in one line. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    // V8 quotes the offending text, raw newlines and all; the error is one line.
    throw new Error(`${file}: is not valid JSON — ${(e as Error).message.replace(/\s+/g, ' ')}`);
  }
}

/** The lines for one schema file against its frozen copy, each naming the schema file. */
function fileProblems(root: string, name: string): string[] {
  const file = `${SCHEMA_DIR}/${name}`;
  return evolutionViolations(readJson(path.join(goldenDir(root), name)), readJson(path.join(schemaDir(root), name))).map((v) => formatViolation(file, v));
}

/** Whether the frozen copy of the schema file `name` is that file, byte for byte. */
function isFrozen(root: string, name: string): boolean {
  return fs.readFileSync(path.join(goldenDir(root), name)).equals(fs.readFileSync(path.join(schemaDir(root), name)));
}

/**
 * What is wrong with the schemas of the tree at `root` against their frozen
 * copies, one line each, in file-name order: a frozen copy with no schema file,
 * a schema file with no frozen copy, every place a schema lost or changed
 * something its frozen copy had, and a schema that lost nothing yet is not its
 * copy byte for byte, which reads `gained only` and says how to refresh the
 * copy. A schema with breaks gets their lines and no `gained only` line.
 * Nothing when every schema is its frozen copy, which includes a tree with
 * neither folder.
 */
export function evolutionProblems(root: string): string[] {
  const frozen = jsonNames(goldenDir(root));
  const current = jsonNames(schemaDir(root));
  const problems: string[] = [];
  for (const name of [...new Set([...frozen, ...current])].sort()) {
    if (!current.includes(name)) {
      problems.push(`${GOLDEN_DIR}/${name}: has no schema file ${SCHEMA_DIR}/${name} any more; a published schema is never deleted, a break is a new major version beside it`);
    } else if (!frozen.includes(name)) {
      problems.push(`${SCHEMA_DIR}/${name}: has no frozen copy; a new schema is frozen on purpose, with KB_GOLDEN=update make tools-test T=evolution`);
    } else {
      const broken = fileProblems(root, name);
      if (broken.length > 0) problems.push(...broken);
      else if (!isFrozen(root, name)) problems.push(`${SCHEMA_DIR}/${name}: gained only — refresh the frozen copy with KB_GOLDEN=update make tools-test T=evolution`);
    }
  }
  return problems;
}

/** What `freezeSchemas` did. */
export interface Freeze {
  /** The names of the schema files whose frozen copy was written or replaced, in name order. */
  readonly written: readonly string[];
  /** The lines of `evolutionProblems` for the schemas it would not freeze, because they lost or changed something. */
  readonly refused: readonly string[];
}

/**
 * Write the frozen copy of every schema file of the tree at `root` that has none
 * or that gained since its copy, byte for byte, and leave the others as they
 * are. A schema that lost or changed something its copy had is refused, and its
 * copy is left alone: a break goes into a new major version, which is a new
 * file and gets its own copy. A frozen copy with no schema file is left alone
 * too; deleting one is a decision for a person.
 */
export function freezeSchemas(root: string): Freeze {
  const written: string[] = [];
  const refused: string[] = [];
  for (const name of jsonNames(schemaDir(root))) {
    const file = path.join(schemaDir(root), name);
    // A schema that does not parse is not frozen: its copy would be as unreadable.
    readJson(file);
    const copy = path.join(goldenDir(root), name);
    if (fs.existsSync(copy)) {
      if (isFrozen(root, name)) continue;
      const problems = fileProblems(root, name);
      if (problems.length > 0) {
        refused.push(...problems);
        continue;
      }
    }
    fs.mkdirSync(goldenDir(root), { recursive: true });
    fs.copyFileSync(file, copy);
    written.push(name);
  }
  return { written, refused };
}
