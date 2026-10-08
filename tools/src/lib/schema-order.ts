/**
 * The order a document's keys are written in, held to the order its schema
 * lists them. A contract's bytes depend on it (a golden file, a diff and a
 * reader that streams a record all lean on it), and JSON Schema has no keyword
 * for it, so a key moved in the code or in the schema changes what is written
 * and breaks no validation. This module walks a value beside its schema and
 * names every object whose keys come in another order.
 *
 *   keyOrderProblems    the objects of a value whose keys are out of the order its schema lists
 *   keyOrderProblemsOf  the same against one schema of a set, by `$id`, or one of its definitions
 *
 * A schema is read as it is written, not compiled. Only the keywords that say
 * which schema holds for which part of a value are followed: `$ref` to a
 * definition of the same file, `anyOf`, `oneOf`, `items`, `properties` and an
 * `additionalProperties` that is itself a schema (the values of a map). A key
 * the schema does not list is no one's business here: the closed form of the
 * schema refuses it, and order is judged among the keys that are listed.
 *
 * Nothing here reads a clock, a random number or the environment.
 */

import type { JsonSchema } from './json-schema.js';

/** The part of a schema the walk reads. */
export interface OrderSchema {
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, OrderSchema>>;
  readonly anyOf?: readonly OrderSchema[];
  readonly oneOf?: readonly OrderSchema[];
  readonly items?: OrderSchema;
  readonly properties?: Readonly<Record<string, OrderSchema>>;
  readonly additionalProperties?: OrderSchema | boolean;
  readonly const?: unknown;
}

/** The definitions of one schema file, by name: what its local `$ref`s name. */
export type Definitions = Readonly<Record<string, OrderSchema>>;

/** What a `$ref` to a definition of the same file starts with. */
const LOCAL = '#/$defs/';

/** The place a problem is at, as it is printed: the document itself is `/`. */
const placeOf = (at: string): string => (at === '' ? '/' : at);

/** How many keys a problem line names from the one that differs. */
const KEYS_SHOWN = 4;

/** `keys` from index `from`, at most KEYS_SHOWN of them, and `…` when more follow. */
const keysFrom = (keys: readonly string[], from: number): string =>
  `${keys.slice(from, from + KEYS_SHOWN).join(', ')}${keys.length > from + KEYS_SHOWN ? ', …' : ''}`;

/** One JSON Pointer segment with its leading slash: `~` is written `~0` and `/` is `~1`, `~` first (RFC 6901). */
const segment = (name: string): string => `/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;

/**
 * Where an object's keys are written in another order than the schema lists its
 * properties, one line each, from the first key that differs: `/blocks/2: from key
 * 1 printed name, id where the schema lists id, name`. `defs` are the definitions
 * a `$ref` names, of the file the schema is in; `at` is where `value` sits in its
 * document, as a JSON Pointer.
 *
 * A value that fits none of an `anyOf`'s branches in order is reported against
 * the first branch. A value an `oneOf` tells apart by a `type` constant is read
 * against the branch that names its type, and one with no such branch against
 * the branch that is itself a `oneOf`, which is how a union is nested.
 */
export function keyOrderProblems(value: unknown, node: OrderSchema, defs: Definitions, at = ''): string[] {
  const named = (n: OrderSchema): OrderSchema | undefined => {
    if (n.$ref === undefined) return n;
    const name = n.$ref.slice(LOCAL.length);
    return n.$ref.startsWith(LOCAL) && Object.hasOwn(defs, name) ? defs[name] : undefined;
  };
  const schema = named(node);
  if (schema === undefined) return [`${placeOf(at)}: the schema refers to "${node.$ref as string}", which is no definition of its own file`];
  if (schema.oneOf !== undefined) {
    const type = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined;
    const branch = schema.oneOf.find((b) => named(b)?.properties?.['type']?.const === type) ?? schema.oneOf.find((b) => named(b)?.oneOf !== undefined);
    return branch === undefined ? [] : keyOrderProblems(value, branch, defs, at);
  }
  if (schema.anyOf !== undefined) {
    const tries = schema.anyOf.map((branch) => keyOrderProblems(value, branch, defs, at));
    return tries.some((t) => t.length === 0) ? [] : (tries[0] as string[]);
  }
  if (Array.isArray(value)) {
    const item = schema.items;
    return item === undefined ? [] : value.flatMap((v: unknown, i) => keyOrderProblems(v, item, defs, `${at}/${String(i)}`));
  }
  if (typeof value !== 'object' || value === null) return [];
  const properties = schema.properties ?? {};
  const listed = Object.keys(properties);
  const printed = Object.keys(value).filter((k) => listed.includes(k));
  const expected = listed.filter((k) => Object.hasOwn(value, k));
  // The two lists hold the same keys, so the first place they differ is where the order breaks.
  const first = printed.findIndex((key, i) => key !== expected[i]);
  const problems = first < 0 ? [] : [`${placeOf(at)}: from key ${String(first + 1)} printed ${keysFrom(printed, first)} where the schema lists ${keysFrom(expected, first)}`];
  const each = typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined;
  for (const [key, child] of Object.entries(value)) {
    const sub = Object.hasOwn(properties, key) ? properties[key] : each;
    if (sub !== undefined) problems.push(...keyOrderProblems(child, sub, defs, `${at}${segment(key)}`));
  }
  return problems;
}

/**
 * The key-order problems of `value` against the schema `id` of `schemas`, the
 * files of a schema folder as written. `id` is a schema's `$id`, optionally
 * with `#/$defs/<name>` to check against one definition of it, the way
 * `SchemaSet.validate` takes an id. An id no schema of the set has throws a
 * plain `Error` naming it.
 */
export function keyOrderProblemsOf(schemas: readonly JsonSchema[], id: string, value: unknown): string[] {
  const [url, definition] = id.split(LOCAL) as [string, string | undefined];
  const file = schemas.find((s) => s['$id'] === url) as OrderSchema | undefined;
  if (file === undefined) throw new Error(`no schema with id "${url}" in this set`);
  return keyOrderProblems(value, definition === undefined ? file : { $ref: `${LOCAL}${definition}` }, file.$defs ?? {});
}
