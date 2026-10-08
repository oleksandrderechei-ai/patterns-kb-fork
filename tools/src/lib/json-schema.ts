/**
 * JSON Schema behind one door: the only module in the repo that imports `ajv`.
 * Everything else — the contract's gates, the CLI tests, the site build — asks
 * a schema set for findings and reads plain data back, so the validator can be
 * upgraded or replaced here without another module learning its types or its
 * error shape. A test in the sibling suite holds that no other module imports
 * `ajv`.
 *
 *   schemaSet        schemas that refer to each other by `$id`, validated by id
 *   formatFinding    one finding as one line: `/items/0/id: must be string (type)`
 *   keywordProblems  every keyword a schema uses outside ALLOWED_KEYWORDS
 *   closeObjects     a copy of a schema with every object closed
 *   readSchemaDir    the schema files of a folder, in file-name order
 *
 * The dialect is draft 2020-12, compiled in ajv's strict mode with every error
 * reported. Strict mode asks more of a schema than the draft does, and a schema
 * that breaks one of these rules fails to compile, naming the keyword:
 *
 *   - an unknown keyword is an error, and so is `format`: none is registered;
 *   - a keyword that applies to one JSON type (`properties`, `required`,
 *     `additionalProperties`, `items`, `pattern`, `minLength`, `minimum`,
 *     `minItems`, `maxItems`) needs that `type` beside it;
 *   - every name in `required` is declared in the same schema's `properties`,
 *     so a `oneOf` branch that only lists `required` does not compile;
 *   - `type` is one name, or a name and `"null"` (`["string", "null"]`); any
 *     other union is written as `anyOf`.
 *
 * Nothing here reads a clock, a random number or the environment, so the same
 * schemas and the same value always give the same findings in the same order.
 */

import fs from 'node:fs';
import path from 'node:path';

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

/** The dialect every contract schema declares and every set validates in. */
export const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * The only keywords a contract schema may use. The list is small on purpose,
 * so that a reader can check a record with any validator for the draft and not
 * only ajv. A keyword outside it is a finding of `keywordProblems`, even where
 * ajv would accept it.
 */
export const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  '$comment',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'pattern',
  'minItems',
  'maxItems',
  'minLength',
  'minimum',
  'oneOf',
  'anyOf',
]);

/** A schema document: one JSON object. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** One way a value breaks a schema. */
export interface SchemaFinding {
  /** Where the value sits, as a JSON Pointer (RFC 6901); `''` is the document itself. */
  readonly pointer: string;
  /** The schema keyword that failed: `type`, `required`, `enum`, `additionalProperties` … */
  readonly keyword: string;
  /** What is wrong, in ajv's words; an additional property names its key. */
  readonly message: string;
}

/** Schemas that refer to each other by `$id`. */
export interface SchemaSet {
  /** The `$id` of every schema in the set, in the order the schemas were given. */
  readonly ids: readonly string[];
  /**
   * Every way `value` breaks the schema `id`, or `[]` when it holds. `id` is a
   * schema's `$id`, optionally with a pointer fragment to check against one
   * definition: `https://…/kb-cli-1.json#/$defs/find`. A schema compiles the
   * first time its id is asked for, so a broken schema fails there and not
   * when the set is made. An id the set does not hold throws a plain `Error`
   * naming it.
   *
   * The findings keep ajv's own order and are not re-sorted: within one value,
   * the schema's keywords in ajv's fixed rule order, an object's members in
   * the order the schema lists them (extra members in the value's own order),
   * and array items by index. The order depends on the schema and the value
   * alone, so two runs give the same lines.
   */
  validate(id: string, value: unknown): SchemaFinding[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One JSON Pointer segment with its leading slash: `~` is written `~0` and `/`
 * `~1`, `~` first. The same escape as `pointer()` in lib/data-json.ts, which is
 * not used here because that module imports a gate and this one stays clear of
 * the gate layer.
 */
function segment(name: string): string {
  return `/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/**
 * Visit every schema object under `node` in document order, with the pointer
 * of each. A schema nests through five keywords: `properties` and `$defs` (a
 * name to a schema), `items` and `additionalProperties` (one schema, or a
 * boolean, which has nothing to visit) and `oneOf` and `anyOf` (a list of
 * schemas). A value that is not a schema where one is expected is skipped;
 * compiling the schema is what reports it.
 *
 * Only these five are followed, so a property that happens to be named
 * `format`, and a `const` or `enum` value that looks like a schema, are never
 * read as schemas.
 */
function walk(node: unknown, at: string, visit: (schema: Record<string, unknown>, at: string) => void): void {
  if (!isObject(node)) return;
  visit(node, at);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' || key === '$defs') {
      if (isObject(value)) {
        for (const [name, child] of Object.entries(value)) walk(child, `${at}/${key}${segment(name)}`, visit);
      }
    } else if (key === 'items' || key === 'additionalProperties') {
      walk(value, `${at}/${key}`, visit);
    } else if ((key === 'oneOf' || key === 'anyOf') && Array.isArray(value)) {
      value.forEach((child, i) => walk(child, `${at}/${key}/${String(i)}`, visit));
    }
  }
}

/**
 * Every keyword of `schema` that is not in ALLOWED_KEYWORDS, one line each:
 * `/properties/a/format: keyword "format" is not allowed`, the pointer being
 * the keyword's own place in the schema. A schema's own keywords come before
 * those of the schemas under it, each in the order the file writes them.
 */
export function keywordProblems(schema: unknown): string[] {
  const problems: string[] = [];
  walk(schema, '', (node, at) => {
    for (const key of Object.keys(node)) {
      if (!ALLOWED_KEYWORDS.has(key)) problems.push(`${at}${segment(key)}: keyword "${key}" is not allowed`);
    }
  });
  return problems;
}

/** An object schema: one that lists `properties`, or whose `type` is, or includes, `"object"`. */
function isObjectSchema(node: Record<string, unknown>): boolean {
  const type = node['type'];
  return 'properties' in node || type === 'object' || (Array.isArray(type) && type.includes('object'));
}

/**
 * A deep copy of `schema` in which every object schema that does not say
 * `additionalProperties` gets `additionalProperties: false`, and `schema`
 * itself is left as it was.
 *
 * A published schema stays open so that it can gain a key later without
 * breaking a reader. The repo's own gates check the closed copy instead, so
 * that what the code writes never carries a key the schema does not document.
 * An explicit `additionalProperties` (a boolean or a schema) is the author's
 * word and stays; a schema under it is closed like any other.
 *
 * Declare an object's members in the schema that closes it. A `oneOf` branch
 * that adds a property to a parent's `properties` would be refused by the
 * parent's closure, because the parent does not list it.
 */
export function closeObjects(schema: JsonSchema): JsonSchema {
  const copy = structuredClone(schema) as Record<string, unknown>;
  walk(copy, '', (node) => {
    if (isObjectSchema(node) && !('additionalProperties' in node)) node['additionalProperties'] = false;
  });
  return copy;
}

/** One ajv error as a finding. */
function findingOf(error: ErrorObject): SchemaFinding {
  // `messages` is on unless an option turns it off, and this module sets none.
  let message = error.message as string;
  // ajv words an extra member as "must NOT have additional properties" and
  // names the member apart, one error per extra member; the finding says it.
  if (error.keyword === 'additionalProperties') {
    message = `must NOT have additional property ${JSON.stringify(error.params['additionalProperty'])}`;
  }
  return { pointer: error.instancePath, keyword: error.keyword, message };
}

/**
 * One finding as one line: `/items/0/id: must be string (type)`. The document
 * itself prints as `/`.
 */
export function formatFinding(finding: SchemaFinding): string {
  return `${finding.pointer === '' ? '/' : finding.pointer}: ${finding.message} (${finding.keyword})`;
}

/**
 * A set of schemas, each with a `$id`, that may refer to each other: a
 * relative `$ref` such as `kb-record-1.json#/$defs/id` resolves against the
 * `$id` of the schema it sits in, whichever order the schemas were given in.
 *
 * `closed` checks every schema through `closeObjects`: the form the repo's own
 * gates use. An open set is the schemas as they are published.
 *
 * A schema that is not valid JSON Schema, a schema with no `$id` and two
 * schemas with the same `$id` throw here. Everything else that strict mode
 * objects to throws when the schema is first used.
 */
export function schemaSet(schemas: readonly JsonSchema[], options: { readonly closed: boolean }): SchemaSet {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const ids: string[] = [];
  schemas.forEach((given, position) => {
    const schema = options.closed ? closeObjects(given) : given;
    const id = schema['$id'];
    if (typeof id !== 'string') throw new Error(`schema ${String(position)} has no "$id"`);
    ids.push(id);
    ajv.addSchema(schema);
  });
  return {
    ids,
    validate(id, value) {
      // A schema here is never `$async`, so the compiled check answers at once.
      const check = ajv.getSchema(id) as ValidateFunction | undefined;
      if (check === undefined) throw new Error(`no schema with id "${id}" in this set`);
      // ajv leaves `errors` set whenever a check fails.
      return check(value) ? [] : (check.errors as ErrorObject[]).map(findingOf);
    },
  };
}

/**
 * Every `*.json` file of `dir` as a parsed schema, in file-name order by code
 * unit, never by locale: `B.json` comes before `a.json`, the same on every
 * machine. Other files and folders are skipped. A file that does not parse, or
 * is not a JSON object, throws an `Error` that names it; a folder that is not
 * there throws too.
 */
export function readSchemaDir(dir: string): JsonSchema[] {
  // `sort()` with no comparator orders by UTF-16 code unit.
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json') && fs.statSync(path.join(dir, name)).isFile())
    .sort();
  return names.map((name) => {
    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // V8 quotes the offending text, raw newlines and all; the error is one line.
      throw new Error(`${file}: is not valid JSON — ${(e as Error).message.replace(/\s+/g, ' ')}`);
    }
    if (!isObject(parsed)) throw new Error(`${file}: is not a JSON object`);
    return parsed;
  });
}
