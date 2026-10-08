/**
 * The key-order check (tools/src/lib/schema-order.ts). What it defends: an
 * object whose keys come in another order than its schema lists them is named
 * with where it is and what was written against what the schema lists, however
 * deep it sits (in a list, in a map, behind a `$ref`, in one branch of a union),
 * keys the schema does not list are left out of the comparison, and a schema
 * that cannot be followed says so instead of passing a value.
 */

import { describe, expect, it } from 'vitest';

import { CLI_OUTPUT_SCHEMAS, schemaDir } from '../contract/contract.js';
import { readSchemaDir } from './json-schema.js';
import { keyOrderProblems, keyOrderProblemsOf, type Definitions, type OrderSchema } from './schema-order.js';
import { REPO_ROOT } from './sandbox.js';

/** An object schema listing `names` in that order. */
const listing = (...names: string[]): OrderSchema => ({ properties: Object.fromEntries(names.map((n) => [n, {}])) });

describe('keyOrderProblems', () => {
  const none: Definitions = {};

  it('finds nothing in an object whose keys come in the order the schema lists them', () => {
    expect(keyOrderProblems({ a: 1, b: 2, c: 3 }, listing('a', 'b', 'c'), none)).toEqual([]);
    expect(keyOrderProblems({}, listing('a', 'b'), none)).toEqual([]);
  });

  it('names an object whose keys come in another order, with where it is, what was written and what the schema lists', () => {
    expect(keyOrderProblems({ b: 1, a: 2 }, listing('a', 'b'), none)).toEqual(['/: from key 1 printed b, a where the schema lists a, b']);
    expect(keyOrderProblems({ b: 1, a: 2 }, listing('a', 'b'), none, '/page')).toEqual(['/page: from key 1 printed b, a where the schema lists a, b']);
  });

  it('names the keys from where the order breaks, four at most, and says when more follow', () => {
    const schema = listing('a', 'b', 'c', 'd', 'e', 'f');
    expect(keyOrderProblems({ b: 1, a: 2, c: 3, d: 4, e: 5, f: 6 }, schema, none)).toEqual(['/: from key 1 printed b, a, c, d, … where the schema lists a, b, c, d, …']);
    expect(keyOrderProblems({ a: 1, c: 2, b: 3, d: 4, e: 5, f: 6 }, schema, none)).toEqual(['/: from key 2 printed c, b, d, e, … where the schema lists b, c, d, e, …']);
    expect(keyOrderProblems({ a: 1, b: 2, c: 3, d: 4, f: 5, e: 6 }, schema, none)).toEqual(['/: from key 5 printed f, e where the schema lists e, f']);
    expect(keyOrderProblems({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, schema, none)).toEqual([]);
  });

  it('judges the order among the keys the schema lists and leaves out the ones it does not and the ones that are not there', () => {
    expect(keyOrderProblems({ x: 0, a: 1, y: 2, b: 3 }, listing('a', 'b'), none)).toEqual([]);
    expect(keyOrderProblems({ c: 1, a: 2 }, listing('a', 'b', 'c'), none)).toEqual(['/: from key 1 printed c, a where the schema lists a, c']);
    expect(keyOrderProblems({ a: 1 }, listing('a', 'b', 'c'), none)).toEqual([]);
  });

  it('reads a key that is a name on Object.prototype as any other key', () => {
    expect(keyOrderProblems({ constructor: 1, a: 2 }, listing('a', 'constructor'), none)).toEqual(['/: from key 1 printed constructor, a where the schema lists a, constructor']);
    expect(keyOrderProblems({ constructor: { b: 1, a: 2 }, a: 2 }, { properties: { a: {} } }, none)).toEqual([]);
  });

  it('goes into the members of an object, the items of a list and the values of a map, naming each place as a JSON Pointer', () => {
    const schema: OrderSchema = {
      properties: {
        one: listing('a', 'b'),
        many: { items: listing('a', 'b') },
        map: { additionalProperties: listing('a', 'b') },
      },
    };
    const value = { one: { b: 1, a: 2 }, many: [{ a: 1, b: 2 }, { b: 1, a: 2 }], map: { 'x/y': { b: 1, a: 2 }, 'p~q': { a: 1, b: 2 } } };
    expect(keyOrderProblems(value, schema, none)).toEqual([
      '/one: from key 1 printed b, a where the schema lists a, b',
      '/many/1: from key 1 printed b, a where the schema lists a, b',
      '/map/x~1y: from key 1 printed b, a where the schema lists a, b',
    ]);
  });

  it('is not troubled by a value that is no object where the schema says an object, nor by a list with no item schema', () => {
    expect(keyOrderProblems('text', listing('a'), none)).toEqual([]);
    expect(keyOrderProblems(null, listing('a'), none)).toEqual([]);
    expect(keyOrderProblems([{ b: 1, a: 2 }], {}, none)).toEqual([]);
    expect(keyOrderProblems({ a: 1 }, { properties: { a: listing('x') }, additionalProperties: false }, none)).toEqual([]);
  });

  it('follows a `$ref` to a definition of its own file, wherever the schema puts it', () => {
    const defs: Definitions = { pair: listing('a', 'b'), pairs: { items: { $ref: '#/$defs/pair' } } };
    expect(keyOrderProblems([{ a: 1, b: 2 }, { b: 1, a: 2 }], { $ref: '#/$defs/pairs' }, defs)).toEqual(['/1: from key 1 printed b, a where the schema lists a, b']);
  });

  it('says so when a `$ref` names no definition of the file it is in, rather than passing the value', () => {
    expect(keyOrderProblems({ b: 1, a: 2 }, { $ref: '#/$defs/missing' }, none)).toEqual(['/: the schema refers to "#/$defs/missing", which is no definition of its own file']);
    expect(keyOrderProblems({ b: 1, a: 2 }, { $ref: 'other.json#/$defs/pair' }, { pair: listing('a', 'b') }, '/x')).toEqual(['/x: the schema refers to "other.json#/$defs/pair", which is no definition of its own file']);
    expect(keyOrderProblems({}, { $ref: '#/$defs/constructor' }, none)).toEqual(['/: the schema refers to "#/$defs/constructor", which is no definition of its own file']);
  });

  it('holds a value to the branch of an `anyOf` it fits in order, and to the first branch when it fits none', () => {
    const either: OrderSchema = { anyOf: [listing('a', 'b'), listing('b', 'a')] };
    expect(keyOrderProblems({ a: 1, b: 2 }, either, none)).toEqual([]);
    expect(keyOrderProblems({ b: 1, a: 2 }, either, none)).toEqual([]);
    expect(keyOrderProblems({ c: 1, d: 2 }, { anyOf: [listing('c', 'd'), { type: 'null' } as OrderSchema] }, none)).toEqual([]);
    expect(keyOrderProblems({ b: 1, a: 2 }, { anyOf: [listing('a', 'b'), listing('a', 'b', 'c')] }, none)).toEqual(['/: from key 1 printed b, a where the schema lists a, b']);
    expect(keyOrderProblems(null, { anyOf: [{ $ref: '#/$defs/pair' }, { const: null } as OrderSchema] }, { pair: listing('a') })).toEqual([]);
  });

  describe('a `oneOf` told apart by a `type` constant', () => {
    const typed = (type: string, ...names: string[]): OrderSchema => ({ properties: { type: { const: type }, ...Object.fromEntries(names.map((n) => [n, {}])) } });
    const defs: Definitions = { dog: typed('dog', 'name', 'bark'), cat: typed('cat', 'name', 'purr') };
    const pet: OrderSchema = { oneOf: [{ $ref: '#/$defs/dog' }, { $ref: '#/$defs/cat' }] };

    it('reads a value against the branch that names its type', () => {
      expect(keyOrderProblems({ type: 'dog', name: 'a', bark: 1 }, pet, defs)).toEqual([]);
      expect(keyOrderProblems({ type: 'cat', purr: 1, name: 'a' }, pet, defs)).toEqual(['/: from key 2 printed purr, name where the schema lists name, purr']);
      expect(keyOrderProblems({ name: 'a', type: 'dog' }, pet, defs)).toEqual(['/: from key 1 printed name, type where the schema lists type, name']);
    });

    it('reads a value of a type no branch names against the branch that is a `oneOf` itself, which is how a union is nested', () => {
      const nested: OrderSchema = { oneOf: [{ $ref: '#/$defs/dog' }, { $ref: '#/$defs/pets' }] };
      const all: Definitions = { ...defs, pets: pet };
      expect(keyOrderProblems({ type: 'cat', purr: 1, name: 'a' }, nested, all)).toEqual(['/: from key 2 printed purr, name where the schema lists name, purr']);
      expect(keyOrderProblems({ type: 'cat', name: 'a', purr: 1 }, nested, all)).toEqual([]);
    });

    it('has nothing to say of a value no branch fits, and not of one that is not an object', () => {
      expect(keyOrderProblems({ type: 'bird', wing: 1 }, pet, defs)).toEqual([]);
      expect(keyOrderProblems('dog', pet, defs)).toEqual([]);
      expect(keyOrderProblems(null, pet, defs)).toEqual([]);
    });

    it('steps over a branch whose `$ref` is dangling and reads the others', () => {
      const broken: OrderSchema = { oneOf: [{ $ref: '#/$defs/gone' }, { $ref: '#/$defs/dog' }] };
      expect(keyOrderProblems({ type: 'dog', bark: 1, name: 'a' }, broken, defs)).toEqual(['/: from key 2 printed bark, name where the schema lists name, bark']);
    });
  });
});

describe('keyOrderProblemsOf', () => {
  const file = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({ $id: `https://schemas.test/${id}.json`, ...extra });
  const schemas = [
    file('page', { properties: { id: {}, title: {} }, $defs: { row: listing('a', 'b') } }),
    file('other', { properties: { z: {}, y: {} } }),
  ];

  it('holds a value to the whole schema of the id, or to one definition of it when the id names one', () => {
    expect(keyOrderProblemsOf(schemas, 'https://schemas.test/page.json', { id: 1, title: 2 })).toEqual([]);
    expect(keyOrderProblemsOf(schemas, 'https://schemas.test/page.json', { title: 2, id: 1 })).toEqual(['/: from key 1 printed title, id where the schema lists id, title']);
    expect(keyOrderProblemsOf(schemas, 'https://schemas.test/page.json#/$defs/row', { b: 1, a: 2 })).toEqual(['/: from key 1 printed b, a where the schema lists a, b']);
    expect(keyOrderProblemsOf(schemas, 'https://schemas.test/other.json', { z: 1, y: 2 })).toEqual([]);
  });

  it('says what is wrong with a definition the schema does not have, and throws on an id no schema has', () => {
    expect(keyOrderProblemsOf(schemas, 'https://schemas.test/other.json#/$defs/row', { a: 1 })).toEqual(['/: the schema refers to "#/$defs/row", which is no definition of its own file']);
    expect(() => keyOrderProblemsOf(schemas, 'https://schemas.test/nowhere.json', {})).toThrow('no schema with id "https://schemas.test/nowhere.json"');
  });
});

describe('the repo schemas', () => {
  it('have, for the output of every command of the CLI, an id the walk resolves to a schema of the folder', () => {
    const files = readSchemaDir(schemaDir(REPO_ROOT));
    expect(Object.keys(CLI_OUTPUT_SCHEMAS).length).toBeGreaterThan(0);
    for (const [command, id] of Object.entries(CLI_OUTPUT_SCHEMAS)) {
      expect(keyOrderProblemsOf(files, id, null), command).toEqual([]);
    }
  });
});
