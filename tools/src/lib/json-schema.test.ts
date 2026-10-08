/**
 * The JSON Schema door (tools/src/lib/json-schema.ts). What it defends: a
 * schema is compiled in strict mode, so a typo in a keyword fails loudly
 * rather than validating nothing; a violation comes back as one named line;
 * the closed copy the repo's own gates check is a faithful copy that leaves
 * the published schema alone; and no other module imports the validator, so it
 * stays replaceable in one place.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALLOWED_KEYWORDS,
  closeObjects,
  DIALECT,
  formatFinding,
  keywordProblems,
  readSchemaDir,
  schemaSet,
  type JsonSchema,
  type SchemaFinding,
} from './json-schema.js';
import { makeSandbox, REPO_ROOT, type Sandbox } from './sandbox.js';

const ROOT = 'https://schemas.test/';
const id = (name: string): string => `${ROOT}${name}.json`;

/** What `fn` throws, so a test can look at the error itself. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw');
}

/** Freeze a value and everything under it, so any write to it throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A value's findings as the lines a gate prints. */
function lines(findings: readonly SchemaFinding[]): string[] {
  return findings.map(formatFinding);
}

describe('schemaSet', () => {
  it('compiles a draft 2020-12 schema in strict mode and finds nothing wrong with a value that holds', () => {
    const page = {
      $schema: DIALECT,
      $id: id('page'),
      type: 'object',
      properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['id'],
    };
    const set = schemaSet([page], { closed: false });
    expect(set.ids).toEqual([id('page')]);
    expect(set.validate(id('page'), { id: 'a', tags: ['x', 'y'] })).toEqual([]);
  });

  it('refuses a schema with an unknown keyword, and keywordProblems names it with its pointer', () => {
    const typo = { $id: id('typo'), type: 'object', properties: { a: { type: 'string', unitLabel: 'x' } } };
    const set = schemaSet([typo], { closed: false });
    expect(() => set.validate(id('typo'), {})).toThrow('unknown keyword: "unitLabel"');
    expect(keywordProblems(typo)).toEqual(['/properties/a/unitLabel: keyword "unitLabel" is not allowed']);
  });

  const STRICT_REFUSALS: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ['a format, which no one registers', { type: 'string', format: 'date' }, 'unknown format "date"'],
    [
      'properties with no type beside them',
      { properties: { a: { type: 'string' } } },
      'missing type "object" for keyword "properties"',
    ],
    ['a pattern with no type beside it', { pattern: '^a' }, 'missing type "string" for keyword "pattern"'],
    [
      'a required name that is not declared',
      { type: 'object', required: ['a'] },
      'required property "a" is not defined',
    ],
    [
      'a branch of oneOf that only lists required',
      { type: 'object', properties: { a: { type: 'string' } }, oneOf: [{ required: ['a'] }] },
      'required property "a" is not defined',
    ],
    ['a union of two types', { type: ['string', 'number'] }, 'use allowUnionTypes'],
  ];

  it.each(STRICT_REFUSALS)('refuses %s', (_what, body, message) => {
    const set = schemaSet([{ $id: id('strict'), ...body }], { closed: false });
    expect(() => set.validate(id('strict'), null)).toThrow(message);
  });

  it('accepts a type that is nullable, and a union written as anyOf', () => {
    const set = schemaSet(
      [
        {
          $id: id('nullable'),
          type: 'object',
          properties: {
            a: { type: ['string', 'null'], pattern: '^a' },
            b: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
          },
        },
      ],
      { closed: false },
    );
    expect(set.validate(id('nullable'), { a: null, b: 3 })).toEqual([]);
    expect(lines(set.validate(id('nullable'), { a: 3, b: true }))).toEqual([
      '/a: must be string,null (type)',
      '/b: must be string (type)',
      '/b: must be integer (type)',
      '/b: must match a schema in anyOf (anyOf)',
    ]);
  });

  it('names each violation by pointer and keyword, one finding for each', () => {
    const list = {
      $id: id('list'),
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, kind: { enum: ['a', 'b'] }, tag: { const: 'x' } },
            required: ['id'],
          },
        },
        count: { type: 'integer', minimum: 1 },
        name: { type: 'string', minLength: 2 },
        rows: { type: 'array', minItems: 1, maxItems: 2 },
      },
      required: ['items'],
    };
    const set = schemaSet([list], { closed: false });
    const findings = set.validate(id('list'), {
      items: [{ id: 3, kind: 'z', tag: 'y' }, {}],
      count: 0,
      name: 'a',
      rows: [],
    });
    expect(findings[0]).toEqual({ pointer: '/items/0/id', keyword: 'type', message: 'must be string' });
    expect(lines(findings)).toEqual([
      '/items/0/id: must be string (type)',
      '/items/0/kind: must be equal to one of the allowed values (enum)',
      '/items/0/tag: must be equal to constant (const)',
      "/items/1: must have required property 'id' (required)",
      '/count: must be >= 1 (minimum)',
      '/name: must NOT have fewer than 2 characters (minLength)',
      '/rows: must NOT have fewer than 1 items (minItems)',
    ]);
    expect(lines(set.validate(id('list'), { items: [], rows: [1, 2, 3] }))).toEqual([
      '/rows: must NOT have more than 2 items (maxItems)',
    ]);
  });

  it('names the extra key of an additional property, at the object that holds it', () => {
    const shape = {
      $id: id('shape'),
      type: 'object',
      properties: { x: { type: 'object', properties: { a: { type: 'string' } } } },
    };
    const set = schemaSet([shape], { closed: true });
    expect(lines(set.validate(id('shape'), { x: { a: 'v', y: 1, 'two words': 2 }, top: true }))).toEqual([
      '/: must NOT have additional property "top" (additionalProperties)',
      '/x: must NOT have additional property "y" (additionalProperties)',
      '/x: must NOT have additional property "two words" (additionalProperties)',
    ]);
  });

  it('prints the document itself as /, and escapes ~ and / in a pointer', () => {
    const set = schemaSet(
      [
        { $id: id('doc'), type: 'object', properties: { 'a/b': { type: 'string' }, 'c~d': { type: 'string' } } },
      ],
      { closed: false },
    );
    const [root] = set.validate(id('doc'), []);
    expect(root).toEqual({ pointer: '', keyword: 'type', message: 'must be object' });
    expect(formatFinding(root as SchemaFinding)).toBe('/: must be object (type)');
    expect(lines(set.validate(id('doc'), { 'a/b': 1, 'c~d': 2 }))).toEqual([
      '/a~1b: must be string (type)',
      '/c~0d: must be string (type)',
    ]);
  });

  it('throws a plain error naming an id the set does not hold', () => {
    const set = schemaSet([{ $id: id('known'), type: 'object' }], { closed: false });
    const missing = thrown(() => set.validate(id('none'), {}));
    expect(Object.getPrototypeOf(missing)).toBe(Error.prototype);
    expect((missing as Error).message).toBe(`no schema with id "${id('none')}" in this set`);
    expect(() => set.validate(`${id('known')}#/$defs/none`, {})).toThrow(`${id('known')}#/$defs/none`);
    expect(() => schemaSet([], { closed: false }).validate(id('known'), {})).toThrow(id('known'));
  });

  it('checks a value against one definition through a pointer fragment, and a definition may use a sibling', () => {
    const cli = {
      $id: id('cli'),
      $defs: {
        row: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        find: { type: 'array', items: { $ref: '#/$defs/row' } },
      },
    };
    const set = schemaSet([cli], { closed: true });
    expect(set.validate(`${id('cli')}#/$defs/find`, [{ id: 'a' }])).toEqual([]);
    expect(lines(set.validate(`${id('cli')}#/$defs/find`, [{ id: 'a' }, { x: 1 }]))).toEqual([
      "/1: must have required property 'id' (required)",
      '/1: must NOT have additional property "x" (additionalProperties)',
    ]);
  });

  it('resolves a relative $ref between two schemas, whichever was given first', () => {
    const outer = {
      $id: id('outer'),
      type: 'object',
      properties: { inner: { $ref: 'inner.json' }, name: { $ref: 'inner.json#/$defs/name' } },
      required: ['inner'],
    };
    const inner = {
      $id: id('inner'),
      $defs: { name: { type: 'string', pattern: '^[a-z]+$' } },
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
    };
    for (const order of [[outer, inner], [inner, outer]]) {
      const set = schemaSet(order, { closed: false });
      expect(set.ids).toEqual(order.map((s) => s.$id));
      expect(set.validate(id('outer'), { inner: { n: 1 }, name: 'ok' })).toEqual([]);
      expect(lines(set.validate(id('outer'), { inner: { n: 'x' }, name: 'NO' }))).toEqual([
        '/inner/n: must be integer (type)',
        '/name: must match pattern "^[a-z]+$" (pattern)',
      ]);
    }
  });

  it('compiles a schema when its id is first asked for, so a broken one fails there and every time after', () => {
    const broken = { $id: id('broken'), type: 'string', mystery: 1 };
    const fine = { $id: id('fine'), type: 'string' };
    const set = schemaSet([broken, fine], { closed: false });
    expect(set.validate(id('fine'), 'x')).toEqual([]);
    expect(() => set.validate(id('broken'), 'x')).toThrow('unknown keyword: "mystery"');
    expect(() => set.validate(id('broken'), 'x')).toThrow('unknown keyword: "mystery"');
    expect(lines(set.validate(id('fine'), 3))).toEqual(['/: must be string (type)']);
  });

  it('refuses, when the set is made, a schema with no $id, a repeated $id, or a bad schema', () => {
    const ok = { $id: id('ok'), type: 'string' };
    expect(() => schemaSet([{ type: 'string' }], { closed: false })).toThrow('schema 0 has no "$id"');
    expect(() => schemaSet([ok, { $id: 7, type: 'string' }], { closed: true })).toThrow('schema 1 has no "$id"');
    expect(() => schemaSet([ok, ok], { closed: false })).toThrow('already exists');
    expect(() => schemaSet([{ $id: id('bad'), type: 'nope' }], { closed: false })).toThrow('schema is invalid');
  });

  it('reports a $ref it cannot resolve when the schema is first used', () => {
    const set = schemaSet([{ $id: id('dangling'), type: 'object', properties: { a: { $ref: 'nowhere.json' } } }], {
      closed: false,
    });
    expect(() => set.validate(id('dangling'), {})).toThrow("can't resolve reference nowhere.json");
  });

  it('checks the closed copy when asked, and the schemas as published when not', () => {
    const published = deepFreeze({
      $id: id('open'),
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    const value = { a: 'x', extra: 1 };
    expect(schemaSet([published], { closed: false }).validate(id('open'), value)).toEqual([]);
    expect(lines(schemaSet([published], { closed: true }).validate(id('open'), value))).toEqual([
      '/: must NOT have additional property "extra" (additionalProperties)',
    ]);
  });

  it('closes the objects of a schema another schema refers to', () => {
    const outer = { $id: id('outer'), type: 'object', properties: { part: { $ref: 'inner.json#/$defs/part' } } };
    const inner = { $id: id('inner'), $defs: { part: { type: 'object', properties: { a: { type: 'string' } } } } };
    const value = { part: { a: 'x', b: 1 } };
    expect(schemaSet([outer, inner], { closed: false }).validate(id('outer'), value)).toEqual([]);
    expect(lines(schemaSet([outer, inner], { closed: true }).validate(id('outer'), value))).toEqual([
      '/part: must NOT have additional property "b" (additionalProperties)',
    ]);
  });

  it('gives the same findings in the same order every time', () => {
    const schema = {
      $id: id('order'),
      type: 'object',
      properties: {
        b: { type: 'string' },
        a: { type: 'string' },
        list: { type: 'array', items: { type: 'string' } },
        z: { type: 'string' },
      },
      required: ['z'],
    };
    const value = { a: 1, b: 2, list: ['x', 1, 2], q: 1, p: 2 };
    const first = lines(schemaSet([schema], { closed: true }).validate(id('order'), value));
    // ajv checks `required`, then the extra members in the value's own order,
    // then the listed members in the order the schema lists them, items by index.
    expect(first).toEqual([
      "/: must have required property 'z' (required)",
      '/: must NOT have additional property "q" (additionalProperties)',
      '/: must NOT have additional property "p" (additionalProperties)',
      '/b: must be string (type)',
      '/a: must be string (type)',
      '/list/1: must be string (type)',
      '/list/2: must be string (type)',
    ]);
    const again = schemaSet([schema], { closed: true });
    expect(lines(again.validate(id('order'), value))).toEqual(first);
    expect(lines(again.validate(id('order'), value))).toEqual(first);
  });
});

describe('formatFinding', () => {
  it('writes the pointer, the message and the keyword on one line', () => {
    expect(formatFinding({ pointer: '/items/0/id', keyword: 'type', message: 'must be string' })).toBe(
      '/items/0/id: must be string (type)',
    );
    expect(formatFinding({ pointer: '', keyword: 'required', message: "must have required property 'id'" })).toBe(
      "/: must have required property 'id' (required)",
    );
  });
});

describe('keywordProblems', () => {
  it('names every keyword outside the allowlist with its pointer, through every nesting keyword', () => {
    const schema = {
      $id: id('wide'),
      type: 'object',
      title: 'A',
      examples: [1],
      properties: {
        a: { type: 'string', format: 'date' },
        b: { type: 'array', items: { type: 'object', maxLength: 3 } },
      },
      $defs: { d: { type: 'string', default: 'x' } },
      additionalProperties: { type: 'integer', exclusiveMinimum: 0 },
      oneOf: [{ type: 'string' }, { type: 'string', contentEncoding: 'base64' }],
      anyOf: [{ type: 'null', nullable: true }],
    };
    expect(keywordProblems(schema)).toEqual([
      '/examples: keyword "examples" is not allowed',
      '/properties/a/format: keyword "format" is not allowed',
      '/properties/b/items/maxLength: keyword "maxLength" is not allowed',
      '/$defs/d/default: keyword "default" is not allowed',
      '/additionalProperties/exclusiveMinimum: keyword "exclusiveMinimum" is not allowed',
      '/oneOf/1/contentEncoding: keyword "contentEncoding" is not allowed',
      '/anyOf/0/nullable: keyword "nullable" is not allowed',
    ]);
  });

  it('allows exactly the contract vocabulary, and a schema written in it has no problems', () => {
    expect([...ALLOWED_KEYWORDS].sort()).toEqual(
      [
        '$comment',
        '$defs',
        '$id',
        '$ref',
        '$schema',
        'additionalProperties',
        'anyOf',
        'const',
        'description',
        'enum',
        'items',
        'maxItems',
        'minItems',
        'minLength',
        'minimum',
        'oneOf',
        'pattern',
        'properties',
        'required',
        'title',
        'type',
      ].sort(),
    );
    const schema = {
      $schema: DIALECT,
      $id: id('vocabulary'),
      $comment: 'c',
      title: 't',
      description: 'd',
      type: 'object',
      properties: {
        s: { type: 'string', pattern: '^a', minLength: 1 },
        n: { type: 'integer', minimum: 0 },
        l: { type: 'array', items: { $ref: '#/$defs/x' }, minItems: 0, maxItems: 4 },
        e: { enum: ['a', 'b'] },
        c: { const: 'k' },
        o: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
        a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['s'],
      additionalProperties: false,
      $defs: { x: { type: 'string' } },
    };
    expect(keywordProblems(schema)).toEqual([]);
    expect(schemaSet([schema], { closed: false }).validate(id('vocabulary'), { s: 'ab', l: ['x'] })).toEqual([]);
  });

  it('does not read a property name, a definition name or a constant as a keyword', () => {
    const schema = {
      type: 'object',
      properties: {
        format: { type: 'string' },
        default: { const: { format: 'x', default: 1 } },
        'x-note': { enum: [{ format: 'y' }] },
      },
      $defs: { examples: { type: 'string' } },
    };
    expect(keywordProblems(schema)).toEqual([]);
  });

  it('escapes ~ and / in the pointer to a keyword', () => {
    const schema = { type: 'object', properties: { 'a/b': { format: 'x' }, 'c~d': { format: 'y' } } };
    expect(keywordProblems(schema)).toEqual([
      '/properties/a~1b/format: keyword "format" is not allowed',
      '/properties/c~0d/format: keyword "format" is not allowed',
    ]);
  });

  it('skips whatever is not a schema where a schema belongs', () => {
    const odd = {
      type: 'object',
      additionalProperties: false,
      items: true,
      properties: { a: 5, b: null, c: [] },
      $defs: [],
      oneOf: [true, null, 'x'],
      anyOf: {},
    };
    expect(keywordProblems(odd)).toEqual([]);
    expect(keywordProblems({ properties: null, oneOf: 'x', $defs: 3 })).toEqual([]);
    for (const notASchema of [null, [], 'x', 4, true, undefined]) expect(keywordProblems(notASchema)).toEqual([]);
  });
});

describe('closeObjects', () => {
  it('closes every object schema, inside properties, items, $defs, oneOf and anyOf', () => {
    const input = {
      $id: id('wide'),
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
        bare: { properties: { inner: { type: 'object' } } },
        choice: {
          oneOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'string' }],
        },
        maybe: { anyOf: [{ type: 'null' }, { type: 'object', properties: { b: { type: 'string' } } }] },
        nullable: { type: ['object', 'null'], properties: {} },
        word: { type: 'string' },
        kinds: { type: ['string', 'null'] },
      },
      $defs: { shape: { type: 'object', properties: { c: { type: 'string' } } } },
    };
    expect(closeObjects(input)).toEqual({
      $id: id('wide'),
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
        },
        bare: { properties: { inner: { type: 'object', additionalProperties: false } }, additionalProperties: false },
        choice: {
          oneOf: [
            { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
            { type: 'string' },
          ],
        },
        maybe: {
          anyOf: [
            { type: 'null' },
            { type: 'object', properties: { b: { type: 'string' } }, additionalProperties: false },
          ],
        },
        nullable: { type: ['object', 'null'], properties: {}, additionalProperties: false },
        word: { type: 'string' },
        kinds: { type: ['string', 'null'] },
      },
      $defs: { shape: { type: 'object', properties: { c: { type: 'string' } }, additionalProperties: false } },
      additionalProperties: false,
    });
  });

  it('leaves an explicit additionalProperties alone, and closes a schema that sits under one', () => {
    const input = {
      type: 'object',
      properties: {
        open: { type: 'object', properties: {}, additionalProperties: true },
        shut: { type: 'object', properties: {}, additionalProperties: false },
        map: {
          type: 'object',
          additionalProperties: { type: 'object', properties: { a: { type: 'string' } } },
        },
      },
      additionalProperties: true,
    };
    expect(closeObjects(input)).toEqual({
      type: 'object',
      properties: {
        open: { type: 'object', properties: {}, additionalProperties: true },
        shut: { type: 'object', properties: {}, additionalProperties: false },
        map: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: true,
    });
  });

  it('does not read a property called type, properties or additionalProperties as the keyword', () => {
    const input = {
      type: 'object',
      properties: {
        type: { type: 'string' },
        properties: { type: 'string' },
        additionalProperties: { type: 'string' },
      },
    };
    expect(closeObjects(input)).toEqual({ ...input, additionalProperties: false });
    const named = { properties: { additionalProperties: { type: 'string' } } };
    expect(closeObjects(named)).toEqual({ ...named, additionalProperties: false });
  });

  it('does not close a value that only looks like a schema, inside const or enum', () => {
    const input = {
      type: 'object',
      properties: {
        k: { const: { type: 'object', properties: {} } },
        e: { enum: [{ type: 'object' }] },
      },
    };
    expect(closeObjects(input)).toEqual({ ...input, additionalProperties: false });
  });

  it('does not change its input, and shares no part of it with the copy', () => {
    const input = deepFreeze({
      type: 'object',
      properties: {
        a: { type: 'object', properties: { b: { type: 'string' } } },
        list: { type: 'array', items: { type: 'object' } },
      },
      $defs: { d: { type: 'object', properties: {} } },
    });
    const before = JSON.stringify(input);
    const copy = closeObjects(input) as Record<string, unknown>;
    expect(JSON.stringify(input)).toBe(before);
    expect(copy).not.toBe(input);
    expect(copy['properties']).not.toBe(input.properties);
    expect((copy['properties'] as Record<string, unknown>)['a']).not.toBe(input.properties.a);
    expect(copy['additionalProperties']).toBe(false);
    expect(Object.isFrozen(copy)).toBe(false);
  });
});

describe('readSchemaDir', () => {
  let sb: Sandbox;
  let dir: string;
  beforeEach(() => {
    sb = makeSandbox();
    sb.mkdir('schemas');
    dir = path.join(sb.dir, 'schemas');
  });
  afterEach(() => sb.cleanup());

  it('reads every .json file in file-name order by code unit, so B comes before a', () => {
    for (const name of ['c', 'a', 'B', 'Z']) sb.write(`schemas/${name}.json`, `{ "$id": "${name}" }\n`);
    expect(readSchemaDir(dir).map((s) => s['$id'])).toEqual(['B', 'Z', 'a', 'c']);
  });

  it('skips a file that is not .json, and a folder, even one named like a schema', () => {
    sb.write('schemas/ok.json', '{ "$id": "ok" }\n');
    sb.write('schemas/README.md', '# not a schema\n');
    sb.write('schemas/notes.json.bak', '{ "$id": "bak" }\n');
    sb.mkdir('schemas/folder.json');
    expect(readSchemaDir(dir)).toEqual([{ $id: 'ok' }]);
  });

  it('names the file that does not parse, in one line', () => {
    sb.write('schemas/ok.json', '{ "$id": "ok" }\n');
    sb.write('schemas/broken.json', '{\n  "a": oops\n}\n');
    const error = thrown(() => readSchemaDir(dir)) as Error;
    expect(error.message).toContain(`${path.join(dir, 'broken.json')}: is not valid JSON — `);
    expect(error.message).not.toContain('\n');
  });

  it('names a file whose JSON is not an object', () => {
    sb.write('schemas/list.json', '[1]\n');
    expect(() => readSchemaDir(dir)).toThrow(`${path.join(dir, 'list.json')}: is not a JSON object`);
  });

  it('throws for a folder that is not there', () => {
    expect(() => readSchemaDir(path.join(sb.dir, 'none'))).toThrow('ENOENT');
  });

  it('returns what it read as schemas a set accepts', () => {
    sb.write('schemas/a.json', JSON.stringify({ $id: id('a'), type: 'string' }));
    const schemas: JsonSchema[] = readSchemaDir(dir);
    expect(schemaSet(schemas, { closed: true }).validate(id('a'), 'x')).toEqual([]);
  });
});

describe('the only module that imports ajv', () => {
  /** An import of `ajv` or anything under it, as `from`, `import(`, `import '…'` or `require(` writes it. */
  const IMPORT_AJV = /\b(?:from|import|require)\s*\(?\s*['"]ajv\b/;
  const SELF = 'tools/src/lib/json-schema.test.ts';

  /** Every `.ts` file under a repo folder, repo-relative and sorted. */
  function sources(folder: string): string[] {
    return fs
      .readdirSync(path.join(REPO_ROOT, folder), { recursive: true, encoding: 'utf8' })
      .map((f) => `${folder}/${f.split(path.sep).join('/')}`)
      .filter((f) => f.endsWith('.ts'))
      .sort();
  }

  it('is json-schema.ts, and no other file under tools/ or site/src imports it', () => {
    const files = ['tools/src', 'tools/e2e', 'site/src'].flatMap(sources).filter((f) => f !== SELF);
    const importers = files.filter((f) => IMPORT_AJV.test(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')));
    expect(importers).toEqual(['tools/src/lib/json-schema.ts']);
  });

  it('would see an import written any of the usual ways, and an add-on package, but not a longer name', () => {
    for (const line of [
      "import Ajv from 'ajv';",
      'import Ajv2020 from "ajv/dist/2020.js";',
      "import type { ErrorObject } from 'ajv/dist/2020.js';",
      "const { default: Ajv } = await import('ajv');",
      "const Ajv = require('ajv');",
      "import 'ajv';",
      "import addFormats from 'ajv-formats';",
    ]) {
      expect(IMPORT_AJV.test(line), line).toBe(true);
    }
    for (const line of [
      "import x from 'ajvx';",
      "import x from './ajv.js';",
      '// the ajv validator',
      "const s = 'ajv';",
    ]) {
      expect(IMPORT_AJV.test(line), line).toBe(false);
    }
  });
});
