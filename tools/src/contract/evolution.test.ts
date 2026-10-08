/**
 * The evolution guard (tools/src/contract/evolution.ts). What it defends: a
 * published schema only grows inside its major version, so a reader written
 * against `kb-record/1` keeps reading `kb-record/1`. A key, a type, a value or
 * a promise a schema made is never taken back, and what would take one back is
 * a new major version, a new file beside the old one.
 *
 * The baseline is tools/src/contract/golden/<schema>.json, a byte copy of each
 * published schema as it was last frozen: a file of the tree, so that it is
 * there in the pre-commit hook's extract, which has no git history. The real
 * tree is held to it at the end of this file: each schema must be its copy byte
 * for byte, so any edit of a schema fails until the copy is refreshed. The
 * failure says which edit it is: a break is named with its JSON Pointer, and an
 * edit that lost nothing reads `gained only` with the command that refreshes
 * the copy. Before that, each rule is proven on a small pair of schemas, the
 * frozen one and the current one: what may be gained is passed by the
 * comparison, and each thing that may not be lost or changed is named. A meta
 * test then holds the rules to the keywords the contract allows, so that a
 * keyword added to the vocabulary cannot be added without a rule here.
 *
 *   KB_GOLDEN=update   freeze every schema that has no copy and every one that
 *                      only gained since its copy, in place of only comparing:
 *                      `KB_GOLDEN=update make tools-test T=evolution`. A schema
 *                      that lost or changed something is refused, so an update
 *                      never freezes a break; a break is a new major version.
 *
 * A frozen copy with no schema file fails the test, and update leaves it where
 * it is: deleting a frozen copy is a decision for a person, and so is freezing
 * a change this guard cannot prove additive (delete the copy, then update).
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ALLOWED_KEYWORDS, DIALECT } from '../lib/json-schema.js';
import { makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';

import { SCHEMA_BASES, SCHEMA_DIR, schemaDir } from './contract.js';
import { evolutionProblems, evolutionViolations, formatViolation, freezeSchemas, GOLDEN_DIR, goldenDir, HELD_KEYWORDS } from './evolution.js';

const UPDATE = (process.env['KB_GOLDEN'] ?? '') === 'update';

type Schema = Record<string, unknown>;

/** What the guard says of a pair of schemas, one `<pointer>: <message>` line each; the document itself is `/`. */
const said = (frozen: unknown, current: unknown): string[] => evolutionViolations(frozen, current).map((v) => `${v.pointer === '' ? '/' : v.pointer}: ${v.message}`);

const S: Schema = { type: 'string' };
const I: Schema = { type: 'integer' };
const N: Schema = { type: 'null' };

/** An object schema listing `properties` in that order. */
const object = (properties: Schema, extra: Schema = {}): Schema => ({ type: 'object', properties, ...extra });

describe('a schema may gain', () => {
  const cases: [name: string, frozen: unknown, current: unknown][] = [
    ['nothing: the same schema', object({ a: S, b: I }, { required: ['a'] }), object({ a: S, b: I }, { required: ['a'] })],
    ['a property, first, between two others and last', object({ a: S, b: S }), object({ x: S, a: S, y: S, b: S, z: S })],
    ['a property inside a property, a definition, an item and a branch', {
      type: 'object',
      properties: { a: object({ x: S }), list: { type: 'array', items: object({ x: S }) }, u: { anyOf: [S, object({ x: S })] } },
      $defs: { row: object({ x: S }) },
    }, {
      type: 'object',
      properties: { a: object({ x: S, y: S }), list: { type: 'array', items: object({ x: S, y: S }) }, u: { anyOf: [S, object({ x: S, y: S })] } },
      $defs: { row: object({ x: S, y: S }) },
    }],
    ['an entry of required', object({ a: S, b: S }, { required: ['a'] }), object({ a: S, b: S }, { required: ['a', 'b'] })],
    ['a required list where there was none', object({ a: S }), object({ a: S }, { required: ['a'] })],
    ['a value of an enum', { type: 'string', enum: ['x'] }, { type: 'string', enum: ['x', 'y'] }],
    ['a definition', { $defs: { a: S } }, { $defs: { a: S, b: S } }],
    ['a branch after the last one of an anyOf and of a oneOf', { anyOf: [S, I], oneOf: [S] }, { anyOf: [S, I, N], oneOf: [S, I] }],
    ['null beside a type', S, { type: ['string', 'null'] }],
    ['null beside several types', { type: ['string', 'integer'] }, { type: ['string', 'integer', 'null'] }],
    ['the same types in another order', { type: ['string', 'null'] }, { type: ['null', 'string'] }],
    ['words in a title, a description and a $comment, and the three where there were none', { type: 'string', title: 'a' }, { type: 'string', title: 'b', description: 'c', $comment: 'd' }],
    ['a boolean schema that stays as it was', { additionalProperties: false }, { additionalProperties: false }],
    ['a held keyword that stays as it was', { $ref: '#/$defs/a', const: 'x', pattern: '^a$', minimum: 1, minLength: 1, minItems: 1, maxItems: 2 }, { $ref: '#/$defs/a', const: 'x', pattern: '^a$', minimum: 1, minLength: 1, minItems: 1, maxItems: 2 }],
  ];

  it.each(cases)('%s', (_name, frozen, current) => {
    expect(said(frozen, current)).toEqual([]);
  });

  it('gains everything it may at once, in a schema written out whole', () => {
    const frozen = {
      $schema: DIALECT,
      $id: 'https://x.test/a-1.json',
      title: 'A',
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-z]+$' }, kind: { type: 'string', enum: ['x'] }, fp: { type: ['string', 'null'] } },
      required: ['id'],
      $defs: { row: object({ id: S }, { required: ['id'] }) },
    };
    const current = {
      $schema: DIALECT,
      $id: 'https://x.test/a-1.json',
      title: 'A, with more words',
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-z]+$' }, added: S, kind: { type: 'string', enum: ['x', 'y'] }, fp: { type: ['string', 'null'] }, later: { type: ['integer', 'null'] } },
      required: ['id', 'kind'],
      $defs: { row: object({ id: S, extra: S }, { required: ['id', 'extra'] }), more: S },
    };
    expect(said(frozen, current)).toEqual([]);
  });
});

/** One thing a schema may not do: the keyword its rule is about, and a pair of schemas that does it, with what the guard says. */
const breaks: [keyword: string, name: string, frozen: unknown, current: unknown, lines: string[]][] = [
  ['properties', 'drop a property', object({ a: S, b: S }), object({ a: S }), ['/properties/b: property "b" was removed']],
  ['properties', 'drop a property of a definition', { $defs: { row: object({ id: S, fp: S }) } }, { $defs: { row: object({ id: S }) } }, ['/$defs/row/properties/fp: property "fp" was removed']],
  [
    'properties',
    'drop a property of the items of a list',
    object({ list: { type: 'array', items: object({ x: S, y: S }) } }),
    object({ list: { type: 'array', items: object({ x: S }) } }),
    ['/properties/list/items/properties/y: property "y" was removed'],
  ],
  [
    'properties',
    'drop a property of the values of a map',
    { type: 'object', additionalProperties: object({ x: S, y: S }) },
    { type: 'object', additionalProperties: object({ x: S }) },
    ['/additionalProperties/properties/y: property "y" was removed'],
  ],
  ['properties', 'drop a property of a branch of an anyOf', { anyOf: [S, object({ x: S, y: S })] }, { anyOf: [S, object({ x: S })] }, ['/anyOf/1/properties/y: property "y" was removed']],
  ['properties', 'drop a property of a branch of a oneOf', { oneOf: [object({ x: S, y: S }), S] }, { oneOf: [object({ x: S }), S] }, ['/oneOf/0/properties/y: property "y" was removed']],
  ['properties', 'drop a property of a property', object({ a: object({ x: S, y: S }) }), object({ a: object({ x: S }) }), ['/properties/a/properties/y: property "y" was removed']],
  ['properties', 'drop a property whose name needs escaping in a pointer', object({ 'a/b~c': S }), object({}), ['/properties/a~1b~0c: property "a/b~c" was removed']],
  [
    'properties',
    'put the properties it lists in another order',
    object({ a: S, b: S, c: S }),
    object({ a: S, c: S, b: S }),
    ['/properties/c: property "c" now comes before "b", which it follows in the frozen schema'],
  ],
  [
    'properties',
    'put a property before the one it followed, whatever else was gained or lost around them',
    object({ a: S, b: S, c: S, d: S }),
    object({ x: S, d: S, a: S, y: S, b: S }),
    ['/properties/c: property "c" was removed', '/properties/d: property "d" now comes before "b", which it follows in the frozen schema'],
  ],
  ['$defs', 'drop a definition', { $defs: { a: S, b: S } }, { $defs: { a: S } }, ['/$defs/b: definition "b" was removed']],
  ['type', 'change a type', S, I, ['/type: type changed from "string" to "integer"; the only type that may be added is "null"']],
  ['type', 'change a type inside a property', object({ a: S }), object({ a: I }), ['/properties/a/type: type changed from "string" to "integer"; the only type that may be added is "null"']],
  ['type', 'narrow a type to drop null', { type: ['string', 'null'] }, S, ['/type: type narrowed from ["string","null"] to "string"']],
  ['type', 'narrow a list of types', { type: ['string', 'integer'] }, { type: 'string' }, ['/type: type narrowed from ["string","integer"] to "string"']],
  ['type', 'add a type that is not null', S, { type: ['string', 'integer'] }, ['/type: type changed from "string" to ["string","integer"]; the only type that may be added is "null"']],
  ['type', 'swap a type for null and another', { type: ['string', 'null'] }, { type: ['integer', 'null'] }, ['/type: type changed from ["string","null"] to ["integer","null"]; the only type that may be added is "null"']],
  ['type', 'drop a type', S, {}, ['/type: type was removed; it was "string"']],
  ['type', 'add a type where there was none', {}, S, ['/type: type "string" was added where there was none']],
  ['enum', 'drop a value of an enum', { type: 'string', enum: ['x', 'y', 'z'] }, { type: 'string', enum: ['x', 'z'] }, ['/enum/1: enum value "y" was removed']],
  ['enum', 'drop a value of an enum that holds null', { enum: ['left', null] }, { enum: ['left'] }, ['/enum/1: enum value null was removed']],
  ['enum', 'drop an enum', { type: 'string', enum: ['x', 'y'] }, S, ['/enum: enum was removed; it listed ["x","y"]']],
  ['enum', 'add an enum where any value passed', S, { type: 'string', enum: ['x'] }, ['/enum: enum was added where any value passed']],
  ['required', 'drop an entry of required', object({ a: S, b: S }, { required: ['a', 'b'] }), object({ a: S, b: S }, { required: ['a'] }), ['/required/1: "b" is no longer required']],
  ['required', 'drop required', object({ a: S, b: S }, { required: ['a', 'b'] }), object({ a: S, b: S }), ['/required/0: "a" is no longer required', '/required/1: "b" is no longer required']],
  ['items', 'drop items', { type: 'array', items: S }, { type: 'array' }, ['/items: "items" was removed']],
  ['items', 'add items where there was none', { type: 'array' }, { type: 'array', items: S }, ['/items: "items" was added where there was none']],
  ['items', 'change the type of the items', { type: 'array', items: S }, { type: 'array', items: I }, ['/items/type: type changed from "string" to "integer"; the only type that may be added is "null"']],
  ['additionalProperties', 'drop additionalProperties', { type: 'object', additionalProperties: S }, { type: 'object' }, ['/additionalProperties: "additionalProperties" was removed']],
  ['additionalProperties', 'add additionalProperties where there was none', { type: 'object' }, { type: 'object', additionalProperties: false }, ['/additionalProperties: "additionalProperties" was added where there was none']],
  ['additionalProperties', 'close an open object', { additionalProperties: true }, { additionalProperties: false }, ['/additionalProperties: changed from true to false']],
  ['additionalProperties', 'swap the schema of a map for a boolean', { additionalProperties: S }, { additionalProperties: false }, ['/additionalProperties: changed from {"type":"string"} to false']],
  ['oneOf', 'drop a oneOf', { oneOf: [S, I] }, {}, ['/oneOf: "oneOf" was removed']],
  ['oneOf', 'add a oneOf where there was none', {}, { oneOf: [S] }, ['/oneOf: "oneOf" was added where there was none']],
  ['anyOf', 'drop an anyOf', { anyOf: [S, I] }, {}, ['/anyOf: "anyOf" was removed']],
  ['anyOf', 'add an anyOf where there was none', {}, { anyOf: [S] }, ['/anyOf: "anyOf" was added where there was none']],
  ['anyOf', 'drop the last branch of an anyOf', { anyOf: [S, I, N] }, { anyOf: [S, I] }, ['/anyOf/2: anyOf branch 2 was removed']],
  ['oneOf', 'drop two branches of a oneOf', { oneOf: [S, I, N] }, { oneOf: [S] }, ['/oneOf/1: oneOf branch 1 was removed', '/oneOf/2: oneOf branch 2 was removed']],
  ['anyOf', 'swap the branches of an anyOf', { anyOf: [S, I] }, { anyOf: [I, S] }, [
    '/anyOf/0/type: type changed from "string" to "integer"; the only type that may be added is "null"',
    '/anyOf/1/type: type changed from "integer" to "string"; the only type that may be added is "null"',
  ]],
  ['anyOf', 'narrow a branch of an anyOf', { anyOf: [S, I] }, { anyOf: [S, N] }, ['/anyOf/1/type: type narrowed from "integer" to "null"']],
];

describe('a schema may not', () => {
  it.each(breaks)('(%s) %s', (_keyword, _name, frozen, current, lines) => {
    expect(said(frozen, current)).toEqual(lines);
  });

  it('change a boolean schema, and a schema for one, at the root of a document as well', () => {
    expect(said(true, false)).toEqual(['/: changed from true to false']);
    expect(said(true, true)).toEqual([]);
    expect(said(S, true)).toEqual(['/: changed from {"type":"string"} to true']);
  });

  it('change a held keyword, drop it or add it, whichever keyword it is', () => {
    for (const keyword of HELD_KEYWORDS) {
      expect(said({ [keyword]: 'a' }, { [keyword]: 'b' }), `${keyword} changed`).toEqual([`/${keyword}: "${keyword}" changed from "a" to "b"`]);
      expect(said({ [keyword]: 1 }, {}), `${keyword} dropped`).toEqual([`/${keyword}: "${keyword}" was removed; it was 1`]);
      expect(said({}, { [keyword]: 1 }), `${keyword} added`).toEqual([`/${keyword}: "${keyword}" was added (1), so a value that passed may fail now`]);
    }
  });

  it('change the $id, the constant a contract names itself with or a pattern, which a comparison cannot tell looser from tighter', () => {
    expect(said({ $id: 'https://x.test/a-1.json' }, { $id: 'https://x.test/a-2.json' })).toEqual(['/$id: "$id" changed from "https://x.test/a-1.json" to "https://x.test/a-2.json"']);
    expect(said(object({ contract: { const: 'kb-record/1' } }), object({ contract: { const: 'kb-record/2' } }))).toEqual([
      '/properties/contract/const: "const" changed from "kb-record/1" to "kb-record/2"',
    ]);
    expect(said({ pattern: '^[a-z]+$' }, { pattern: '^[a-z0-9]+$' })).toEqual(['/pattern: "pattern" changed from "^[a-z]+$" to "^[a-z0-9]+$"']);
  });

  it('are named in the order the walk meets them: held keywords, type, enum, required, properties, definitions, items, additionalProperties, then unions', () => {
    const frozen = {
      const: 'a',
      type: 'object',
      enum: ['x', 'y'],
      required: ['p'],
      properties: { p: S, q: S },
      $defs: { d: S },
      items: S,
      additionalProperties: S,
      oneOf: [S],
      anyOf: [S],
    };
    const current = { const: 'b', type: 'array', enum: ['x'], required: [], properties: { p: I }, $defs: {}, oneOf: [], anyOf: [], additionalProperties: I, items: I };
    expect(said(frozen, current)).toEqual([
      '/const: "const" changed from "a" to "b"',
      '/type: type changed from "object" to "array"; the only type that may be added is "null"',
      '/enum/1: enum value "y" was removed',
      '/required/0: "p" is no longer required',
      '/properties/p/type: type changed from "string" to "integer"; the only type that may be added is "null"',
      '/properties/q: property "q" was removed',
      '/$defs/d: definition "d" was removed',
      '/items/type: type changed from "string" to "integer"; the only type that may be added is "null"',
      '/additionalProperties/type: type changed from "string" to "integer"; the only type that may be added is "null"',
      '/oneOf/0: oneOf branch 0 was removed',
      '/anyOf/0: anyOf branch 0 was removed',
    ]);
  });

  it('is judged the same however the frozen schema was written: key order in the file does not matter, only the order of the properties it lists', () => {
    const a = { properties: { a: S, b: S }, type: 'object', required: ['a'] };
    const b = { required: ['a'], type: 'object', properties: { a: S, b: S } };
    expect(said(a, b)).toEqual([]);
    expect(said(b, a)).toEqual([]);
  });

  it('has a rule, or a reason it needs none, for every keyword the contract allows and for no other', () => {
    const free = ['title', 'description', '$comment'];
    const known = new Set([...free, ...HELD_KEYWORDS, ...breaks.map(([keyword]) => keyword)]);
    expect([...known].sort()).toEqual([...ALLOWED_KEYWORDS].sort());
  });
});

describe('formatViolation', () => {
  it('writes the file, the pointer and the words on one line, and the document itself as /', () => {
    const [violation] = evolutionViolations(object({ a: S, b: S }), object({ a: S }));
    expect(formatViolation('tools/src/contract/schema/kb-x-1.json', violation as NonNullable<typeof violation>)).toBe('tools/src/contract/schema/kb-x-1.json /properties/b: property "b" was removed');
    expect(formatViolation('f.json', { pointer: '', message: 'changed from true to false' })).toBe('f.json /: changed from true to false');
  });
});

describe('the real kb-record-1 schema', () => {
  const read = (): Schema => JSON.parse(fs.readFileSync(path.join(schemaDir(REPO_ROOT), 'kb-record-1.json'), 'utf8')) as Schema;
  /** A deep copy of the real schema, handed to `edit` to change. */
  const edited = (edit: (schema: Schema) => void): Schema => {
    const copy = structuredClone(read());
    edit(copy);
    return copy;
  };
  const at = (schema: Schema, ...keys: string[]): Schema => keys.reduce((node, key) => node[key] as Schema, schema);

  it('may gain a property in the middle, a required key, a definition, an enum value, a branch, null and words, all at once', () => {
    const grown = edited((s) => {
      const entries = Object.entries(at(s, 'properties'));
      const before = entries.findIndex(([name]) => name === 'anchors');
      s['properties'] = Object.fromEntries([...entries.slice(0, before), ['pins', { type: 'array', items: S }], ...entries.slice(before)]);
      (s['required'] as string[]).push('pins');
      at(s, '$defs')['pin'] = S;
      (at(s, '$defs', 'kind')['enum'] as string[]).push('recipe');
      (at(s, '$defs', 'flow')['oneOf'] as Schema[]).push({ $ref: '#/$defs/pin' });
      at(s, '$defs', 'inline', 'properties', 'md')['type'] = ['string', 'null'];
      s['description'] = `${String(s['description'])} More words.`;
    });
    expect(said(read(), grown)).toEqual([]);
  });

  it('may not drop a key, narrow null away, drop an enum value or a required key, change its constant or drop a definition', () => {
    const kinds = at(read(), '$defs', 'kind')['enum'] as string[];
    const blockRequired = at(read(), '$defs', 'block')['required'] as string[];
    expect(said(read(), edited((s) => delete at(s, 'properties')['source']))).toEqual(['/properties/source: property "source" was removed']);
    expect(said(read(), edited((s) => (at(s, '$defs', 'elementId')['type'] = 'string')))).toEqual(['/$defs/elementId/type: type narrowed from ["string","null"] to "string"']);
    expect(said(read(), edited((s) => (at(s, '$defs', 'kind')['enum'] = kinds.filter((k) => k !== 'design'))))).toEqual([
      `/$defs/kind/enum/${String(kinds.indexOf('design'))}: enum value "design" was removed`,
    ]);
    expect(said(read(), edited((s) => (at(s, '$defs', 'block')['required'] = blockRequired.filter((k) => k !== 'name'))))).toEqual([
      `/$defs/block/required/${String(blockRequired.indexOf('name'))}: "name" is no longer required`,
    ]);
    expect(said(read(), edited((s) => (at(s, 'properties', 'contract')['const'] = 'kb-record/2')))).toEqual([
      '/properties/contract/const: "const" changed from "kb-record/1" to "kb-record/2"',
    ]);
    expect(said(read(), edited((s) => delete at(s, '$defs')['html']))).toEqual(['/$defs/html: definition "html" was removed']);
  });
});

describe('the schemas of a tree', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => sb.cleanup());

  const json = (schema: unknown): string => `${JSON.stringify(schema, null, 2)}\n`;
  const frozen = (name: string, schema: unknown): string => sb.write(`${GOLDEN_DIR}/${name}`, json(schema));
  const current = (name: string, schema: unknown): string => sb.write(`${SCHEMA_DIR}/${name}`, json(schema));

  it('keeps the frozen copies beside the schemas, in the folder this module names', () => {
    expect(GOLDEN_DIR).toBe('tools/src/contract/golden');
    expect(goldenDir('/some/root')).toBe(path.join('/some/root', 'tools', 'src', 'contract', 'golden'));
    expect(goldenDir(REPO_ROOT)).toBe(path.join(path.dirname(schemaDir(REPO_ROOT)), 'golden'));
  });

  describe('evolutionProblems', () => {
    it('finds nothing in a tree with neither folder', () => {
      expect(evolutionProblems(sb.dir)).toEqual([]);
    });

    it('finds nothing when every schema is its frozen copy, and skips what is no JSON file', () => {
      frozen('kb-a-1.json', object({ a: S }));
      current('kb-a-1.json', object({ a: S }));
      frozen('kb-b-1.json', object({ x: S }, { required: ['x'] }));
      current('kb-b-1.json', object({ x: S }, { required: ['x'] }));
      sb.write(`${GOLDEN_DIR}/README.txt`, 'not a schema');
      sb.write(`${SCHEMA_DIR}/notes.txt`, 'not a schema');
      expect(evolutionProblems(sb.dir)).toEqual([]);
    });

    it('names a schema that gained since its copy, whatever it gained, and says how to refresh the copy', () => {
      frozen('kb-a-1.json', object({ a: S }));
      current('kb-a-1.json', object({ a: S, b: S }));
      frozen('kb-b-1.json', object({ x: S }));
      current('kb-b-1.json', { ...object({ x: S }), description: 'more words' });
      frozen('kb-c-1.json', object({ y: S }));
      current('kb-c-1.json', object({ y: S }));
      expect(evolutionProblems(sb.dir)).toEqual([
        `${SCHEMA_DIR}/kb-a-1.json: gained only — refresh the frozen copy with KB_GOLDEN=update make tools-test T=evolution`,
        `${SCHEMA_DIR}/kb-b-1.json: gained only — refresh the frozen copy with KB_GOLDEN=update make tools-test T=evolution`,
      ]);
    });

    it('tells a break from a gain in one run: a break by its pointers and no gained-only line, a gain by that line alone', () => {
      frozen('kb-a-1.json', object({ a: S, b: S }));
      current('kb-a-1.json', object({ a: S }));
      frozen('kb-b-1.json', object({ x: S }));
      current('kb-b-1.json', object({ x: S, y: S }));
      expect(evolutionProblems(sb.dir)).toEqual([
        `${SCHEMA_DIR}/kb-a-1.json /properties/b: property "b" was removed`,
        `${SCHEMA_DIR}/kb-b-1.json: gained only — refresh the frozen copy with KB_GOLDEN=update make tools-test T=evolution`,
      ]);
    });

    it('names a schema that has no frozen copy, and how to freeze it', () => {
      current('kb-a-2.json', object({ a: S }));
      expect(evolutionProblems(sb.dir)).toEqual([`${SCHEMA_DIR}/kb-a-2.json: has no frozen copy; a new schema is frozen on purpose, with KB_GOLDEN=update make tools-test T=evolution`]);
    });

    it('names a frozen copy that has no schema file: a published schema was deleted', () => {
      frozen('kb-a-1.json', object({ a: S }));
      expect(evolutionProblems(sb.dir)).toEqual([
        `${GOLDEN_DIR}/kb-a-1.json: has no schema file ${SCHEMA_DIR}/kb-a-1.json any more; a published schema is never deleted, a break is a new major version beside it`,
      ]);
    });

    it('names the schema file and the pointer of every break, one line each, in file-name order', () => {
      frozen('kb-b-1.json', object({ x: S }, { required: ['x'] }));
      current('kb-b-1.json', object({ x: I }));
      frozen('kb-a-1.json', object({ a: S, b: S }));
      current('kb-a-1.json', object({ a: S }));
      frozen('kb-c-1.json', true);
      current('kb-c-1.json', false);
      expect(evolutionProblems(sb.dir)).toEqual([
        `${SCHEMA_DIR}/kb-a-1.json /properties/b: property "b" was removed`,
        `${SCHEMA_DIR}/kb-b-1.json /required/0: "x" is no longer required`,
        `${SCHEMA_DIR}/kb-b-1.json /properties/x/type: type changed from "string" to "integer"; the only type that may be added is "null"`,
        `${SCHEMA_DIR}/kb-c-1.json /: changed from true to false`,
      ]);
    });

    it('lists a deleted schema, a new one and a break together, in file-name order', () => {
      frozen('kb-a-1.json', object({ a: S }));
      frozen('kb-b-1.json', object({ a: S }));
      current('kb-b-1.json', object({}));
      current('kb-c-1.json', object({ a: S }));
      expect(evolutionProblems(sb.dir).map((line) => line.split(':')[0])).toEqual([`${GOLDEN_DIR}/kb-a-1.json`, `${SCHEMA_DIR}/kb-b-1.json /properties/a`, `${SCHEMA_DIR}/kb-c-1.json`]);
    });

    it('throws, naming the file, when a schema or a frozen copy is not JSON', () => {
      frozen('kb-a-1.json', object({ a: S }));
      sb.write(`${SCHEMA_DIR}/kb-a-1.json`, '{ "type": ');
      expect(() => evolutionProblems(sb.dir)).toThrow(/kb-a-1\.json: is not valid JSON — /);
      current('kb-a-1.json', object({ a: S }));
      sb.write(`${GOLDEN_DIR}/kb-a-1.json`, 'nope');
      expect(() => evolutionProblems(sb.dir)).toThrow(/golden\/kb-a-1\.json: is not valid JSON — /);
    });
  });

  describe('freezeSchemas', () => {
    it('writes a frozen copy of every schema that has none, byte for byte, making the folder', () => {
      sb.write(`${SCHEMA_DIR}/kb-b-1.json`, '{"type":"object","properties":{"b":{"type":"string"}}}');
      sb.write(`${SCHEMA_DIR}/kb-a-1.json`, '{\n\t"type": "object"   \n}\n\n');
      expect(sb.exists(GOLDEN_DIR)).toBe(false);
      expect(freezeSchemas(sb.dir)).toEqual({ written: ['kb-a-1.json', 'kb-b-1.json'], refused: [] });
      for (const name of ['kb-a-1.json', 'kb-b-1.json']) expect(sb.read(`${GOLDEN_DIR}/${name}`)).toBe(sb.read(`${SCHEMA_DIR}/${name}`));
      expect(evolutionProblems(sb.dir)).toEqual([]);
    });

    it('writes nothing for a schema that is its frozen copy', () => {
      current('kb-a-1.json', object({ a: S }));
      freezeSchemas(sb.dir);
      expect(freezeSchemas(sb.dir)).toEqual({ written: [], refused: [] });
    });

    it('freezes a new major version beside the old one, whatever it drops, and leaves the old copy as it was', () => {
      current('kb-a-1.json', object({ a: S }));
      freezeSchemas(sb.dir);
      const old = sb.read(`${GOLDEN_DIR}/kb-a-1.json`);
      current('kb-a-2.json', object({ b: I }));
      expect(evolutionProblems(sb.dir)).toEqual([`${SCHEMA_DIR}/kb-a-2.json: has no frozen copy; a new schema is frozen on purpose, with KB_GOLDEN=update make tools-test T=evolution`]);
      expect(freezeSchemas(sb.dir)).toEqual({ written: ['kb-a-2.json'], refused: [] });
      expect(sb.read(`${GOLDEN_DIR}/kb-a-1.json`)).toBe(old);
      expect(evolutionProblems(sb.dir)).toEqual([]);
    });

    it('replaces a frozen copy after a change that only gained, which clears the gained-only line, and then holds the new one', () => {
      current('kb-a-1.json', object({ a: S }));
      freezeSchemas(sb.dir);
      current('kb-a-1.json', object({ a: S, b: S }));
      expect(evolutionProblems(sb.dir)).toEqual([`${SCHEMA_DIR}/kb-a-1.json: gained only — refresh the frozen copy with KB_GOLDEN=update make tools-test T=evolution`]);
      expect(freezeSchemas(sb.dir)).toEqual({ written: ['kb-a-1.json'], refused: [] });
      expect(sb.read(`${GOLDEN_DIR}/kb-a-1.json`)).toBe(sb.read(`${SCHEMA_DIR}/kb-a-1.json`));
      expect(evolutionProblems(sb.dir)).toEqual([]);
      current('kb-a-1.json', object({ a: S }));
      expect(evolutionProblems(sb.dir)).toEqual([`${SCHEMA_DIR}/kb-a-1.json /properties/b: property "b" was removed`]);
      expect(freezeSchemas(sb.dir).refused).toEqual([`${SCHEMA_DIR}/kb-a-1.json /properties/b: property "b" was removed`]);
    });

    it('refuses a schema that lost or changed something, says what, and leaves its frozen copy as it was', () => {
      frozen('kb-a-1.json', object({ a: S, b: S }));
      current('kb-a-1.json', object({ a: I }));
      current('kb-b-1.json', object({ x: S }));
      const before = sb.read(`${GOLDEN_DIR}/kb-a-1.json`);
      expect(freezeSchemas(sb.dir)).toEqual({
        written: ['kb-b-1.json'],
        refused: [
          `${SCHEMA_DIR}/kb-a-1.json /properties/a/type: type changed from "string" to "integer"; the only type that may be added is "null"`,
          `${SCHEMA_DIR}/kb-a-1.json /properties/b: property "b" was removed`,
        ],
      });
      expect(sb.read(`${GOLDEN_DIR}/kb-a-1.json`)).toBe(before);
    });

    it('leaves a frozen copy that has no schema file where it is, and still names it', () => {
      frozen('kb-gone-1.json', object({ a: S }));
      current('kb-a-1.json', object({ a: S }));
      expect(freezeSchemas(sb.dir)).toEqual({ written: ['kb-a-1.json'], refused: [] });
      expect(sb.exists(`${GOLDEN_DIR}/kb-gone-1.json`)).toBe(true);
      expect(evolutionProblems(sb.dir)).toHaveLength(1);
    });

    it('freezes nothing of a tree with no schemas, and does not freeze a schema that is not JSON', () => {
      expect(freezeSchemas(sb.dir)).toEqual({ written: [], refused: [] });
      sb.write(`${SCHEMA_DIR}/kb-a-1.json`, 'not json');
      expect(() => freezeSchemas(sb.dir)).toThrow(/kb-a-1\.json: is not valid JSON — /);
      expect(sb.exists(GOLDEN_DIR)).toBe(false);
    });
  });
});

describe('the published schemas of the repo', () => {
  it('are their frozen copies byte for byte: nothing is gone, narrowed or changed, and what they gained is frozen', () => {
    if (UPDATE) expect(freezeSchemas(REPO_ROOT).refused, 'a break is not frozen: publish it as a new major version beside the schema').toEqual([]);
    expect(
      evolutionProblems(REPO_ROOT),
      [
        'A published schema only gains inside its major version (docs/concepts/retrieval-contract.md#how-the-contract-changes), and its frozen copy follows every edit.',
        'A line that says "gained only" is an edit that lost nothing: refresh the copy with KB_GOLDEN=update make tools-test T=evolution.',
        'Any other line is a breaking change: put it in a new major version, a new file beside the old one, and leave this schema as it was.',
      ].join(' '),
    ).toEqual([]);
  });

  it('have a frozen copy each, for every contract the repo names, and the folder of copies holds nothing but JSON', () => {
    const names = fs.readdirSync(goldenDir(REPO_ROOT)).sort();
    expect(names).toEqual(expect.arrayContaining(Object.values(SCHEMA_BASES).map((base) => `${base}.json`)));
    expect(names.every((name) => name.endsWith('.json'))).toBe(true);
  });
});
