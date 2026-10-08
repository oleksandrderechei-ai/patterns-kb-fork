/**
 * The contract's names (tools/src/contract/contract.ts). What they defend: one
 * published root and one spelling of each id, so a record, the site and a
 * schema file cannot drift apart; the schema folder sits where the module says;
 * and every schema file that lands there is named for its `$id`, declares the
 * dialect, is written in the allowed vocabulary and compiles in strict mode,
 * open and closed, each of its definitions included, one that nothing refers
 * to as well. The folder check is written once, proven on fixture folders that
 * break each rule, and then run on the repo's own folder. Last, every kb.mjs
 * read command has an entry in CLI_OUTPUT_SCHEMAS that resolves to the
 * definition its `--json` output is held to, so a command cannot be added
 * without one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLI_COMMANDS } from '../kb/spec.js';
import { DIALECT, formatFinding, keywordProblems } from '../lib/json-schema.js';
import { makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';
import { PUBLIC_ROOT } from '../site/site-output.js';
import {
  CLI_OUTPUT_SCHEMAS,
  CONTRACTS,
  contractSchemas,
  PUBLISHED_ROOT,
  SCHEMA_BASES,
  SCHEMA_DIR,
  schemaDir,
  schemaUrl,
} from './contract.js';

/**
 * What is wrong with the schema files of the tree at `root`, one line each: a
 * file by file pass in file-name order, then the two ways the set is compiled,
 * every schema and every definition in it. Nothing when they are sound, which
 * includes a tree with no schema folder.
 */
function folderProblems(root: string): string[] {
  const dir = schemaDir(root);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const known: readonly string[] = Object.values(SCHEMA_BASES);
  const problems: string[] = [];
  const definitions: string[] = [];
  for (const file of files) {
    const at = `${SCHEMA_DIR}/${file}`;
    const base = file.slice(0, -'.json'.length);
    const schema = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
    if (!known.includes(base)) problems.push(`${at}: is not one of the contract schemas`);
    if (schema['$id'] !== schemaUrl(base)) {
      problems.push(`${at}: $id is ${JSON.stringify(schema['$id'])}, not "${schemaUrl(base)}"`);
    }
    if (schema['$schema'] !== DIALECT) problems.push(`${at}: $schema is not ${DIALECT}`);
    for (const problem of keywordProblems(schema)) problems.push(`${at}: ${problem}`);
    for (const name of Object.keys((schema['$defs'] ?? {}) as object)) definitions.push(`${String(schema['$id'])}#/$defs/${name}`);
  }
  for (const closed of [false, true]) {
    const form = closed ? 'closed' : 'open';
    try {
      const set = contractSchemas(root, { closed });
      // Asking for a schema is what compiles it.
      for (const id of set.ids) set.validate(id, null);
      // A schema compiles only the definitions it refers to, so a definition no
      // other one uses is asked for too, and named when it fails: ajv words the
      // error as if the schema's own root were at fault.
      for (const id of definitions) {
        try {
          set.validate(id, null);
        } catch (e) {
          problems.push(`${form} set: ${id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      problems.push(`${form} set: ${(e as Error).message}`);
    }
  }
  return problems;
}

describe('the contract names', () => {
  it('names the four contracts, and a schema file for each that spells the id with a hyphen', () => {
    expect(CONTRACTS).toEqual({ record: 'kb-record/1', graph: 'kb-graph/1', index: 'kb-index/1', cli: 'kb-cli/1' });
    expect(SCHEMA_BASES).toEqual({
      record: 'kb-record-1',
      graph: 'kb-graph-1',
      index: 'kb-index-1',
      cli: 'kb-cli-1',
    });
    for (const key of Object.keys(CONTRACTS) as (keyof typeof CONTRACTS)[]) {
      expect(SCHEMA_BASES[key], key).toBe(CONTRACTS[key].replace('/', '-'));
    }
  });

  it('publishes under one fixed root, which is the root the site is published at by default', () => {
    expect(PUBLISHED_ROOT).toBe('https://odere-pro.github.io/software-design-atlas/');
    expect(PUBLISHED_ROOT.endsWith('/')).toBe(true);
    // A schema's `$id` is a URL people pin. Moving the site is then a decision
    // about the contract too, so the two roots are made to disagree loudly.
    expect(PUBLISHED_ROOT).toBe(PUBLIC_ROOT);
  });

  it('writes a schema id from a file base name, under schema/ at the published root', () => {
    expect(schemaUrl('kb-record-1')).toBe('https://odere-pro.github.io/software-design-atlas/schema/kb-record-1.json');
    expect(schemaUrl(SCHEMA_BASES.cli)).toBe(`${PUBLISHED_ROOT}schema/kb-cli-1.json`);
  });

  it('keeps the schema files in the folder beside this module', () => {
    expect(SCHEMA_DIR).toBe('tools/src/contract/schema');
    expect(schemaDir('/some/root')).toBe(path.join('/some/root', 'tools', 'src', 'contract', 'schema'));
    expect(schemaDir(REPO_ROOT)).toBe(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema'));
  });
});

describe('contractSchemas', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => sb.cleanup());

  const record = (): Record<string, unknown> => ({
    $schema: DIALECT,
    $id: schemaUrl(SCHEMA_BASES.record),
    type: 'object',
    properties: {
      id: { $ref: '#/$defs/id' },
      contract: { const: CONTRACTS.record },
    },
    required: ['id', 'contract'],
    $defs: { id: { type: 'string', pattern: '^[a-z0-9-]+$' } },
  });

  it('is an empty set over a tree with no schema folder, and asking it for a schema names the id', () => {
    const set = contractSchemas(sb.dir, { closed: false });
    expect(set.ids).toEqual([]);
    expect(() => set.validate(schemaUrl(SCHEMA_BASES.record), {})).toThrow(schemaUrl(SCHEMA_BASES.record));
  });

  it('validates against a schema file of the tree', () => {
    sb.write(`${SCHEMA_DIR}/kb-record-1.json`, JSON.stringify(record()));
    const set = contractSchemas(sb.dir, { closed: false });
    const url = schemaUrl('kb-record-1');
    expect(set.ids).toEqual([url]);
    expect(set.validate(url, { id: 'circuit-breaker', contract: 'kb-record/1' })).toEqual([]);
    expect(set.validate(url, { id: 'Circuit Breaker', contract: 'kb-record/2' }).map(formatFinding)).toEqual([
      '/id: must match pattern "^[a-z0-9-]+$" (pattern)',
      '/contract: must be equal to constant (const)',
    ]);
  });

  it('resolves a relative $ref from one schema file to another, and lists the files in name order', () => {
    const graph = {
      $schema: DIALECT,
      $id: schemaUrl(SCHEMA_BASES.graph),
      type: 'object',
      properties: { nodes: { type: 'array', items: { $ref: 'kb-record-1.json#/$defs/id' } } },
    };
    sb.write(`${SCHEMA_DIR}/kb-record-1.json`, JSON.stringify(record()));
    sb.write(`${SCHEMA_DIR}/kb-graph-1.json`, JSON.stringify(graph));
    const set = contractSchemas(sb.dir, { closed: false });
    expect(set.ids).toEqual([schemaUrl('kb-graph-1'), schemaUrl('kb-record-1')]);
    expect(set.validate(schemaUrl('kb-graph-1'), { nodes: ['circuit-breaker'] })).toEqual([]);
    expect(set.validate(schemaUrl('kb-graph-1'), { nodes: ['circuit-breaker', 'No'] }).map(formatFinding)).toEqual([
      '/nodes/1: must match pattern "^[a-z0-9-]+$" (pattern)',
    ]);
  });

  it('checks the closed form when asked, and the files as published when not', () => {
    sb.write(`${SCHEMA_DIR}/kb-record-1.json`, JSON.stringify(record()));
    const value = { id: 'a', contract: 'kb-record/1', addedLater: true };
    const url = schemaUrl('kb-record-1');
    expect(contractSchemas(sb.dir, { closed: false }).validate(url, value)).toEqual([]);
    expect(contractSchemas(sb.dir, { closed: true }).validate(url, value).map(formatFinding)).toEqual([
      '/: must NOT have additional property "addedLater" (additionalProperties)',
    ]);
  });
});

describe('the schema files', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => sb.cleanup());

  /** Write `<base>.json` into the sandbox's schema folder: sound unless `over` says otherwise. */
  function put(base: string, over: Record<string, unknown> = {}): void {
    const schema = {
      $schema: DIALECT,
      $id: schemaUrl(base),
      type: 'object',
      properties: { a: { type: 'string' } },
      ...over,
    };
    sb.write(`${SCHEMA_DIR}/${base}.json`, JSON.stringify(schema));
  }

  it('in the repo are named for their $id, use the allowed keywords and compile open and closed', () => {
    expect(folderProblems(REPO_ROOT)).toEqual([]);
  });

  it('pass the check when each is named for its $id, declares the dialect and compiles', () => {
    expect(folderProblems(sb.dir)).toEqual([]);
    put('kb-record-1');
    put('kb-cli-1', { $defs: { row: { type: 'object', properties: { id: { type: 'string' } } } } });
    expect(folderProblems(sb.dir)).toEqual([]);
  });

  it('fail it when the $id does not match the file name', () => {
    put('kb-graph-1', { $id: 'https://elsewhere.test/graph.json' });
    expect(folderProblems(sb.dir)).toEqual([
      `${SCHEMA_DIR}/kb-graph-1.json: $id is "https://elsewhere.test/graph.json", not "${schemaUrl('kb-graph-1')}"`,
    ]);
  });

  it('fail it when a file is not one of the four contract schemas', () => {
    put('kb-extra-1');
    expect(folderProblems(sb.dir)).toEqual([`${SCHEMA_DIR}/kb-extra-1.json: is not one of the contract schemas`]);
  });

  it('fail it when a schema uses a keyword outside the allowlist, even one ajv accepts', () => {
    put('kb-index-1', { examples: [{ a: 'x' }] });
    expect(folderProblems(sb.dir)).toEqual([
      `${SCHEMA_DIR}/kb-index-1.json: /examples: keyword "examples" is not allowed`,
    ]);
  });

  it('fail it, with the compile error from the open and the closed set, when a schema does not compile', () => {
    put('kb-cli-1', { properties: { a: { type: 'string', format: 'date' } } });
    expect(folderProblems(sb.dir)).toEqual([
      `${SCHEMA_DIR}/kb-cli-1.json: /properties/a/format: keyword "format" is not allowed`,
      'open set: unknown format "date" ignored in schema at path "#/properties/a"',
      'closed set: unknown format "date" ignored in schema at path "#/properties/a"',
    ]);
  });

  it('fail it when a schema is written for another draft', () => {
    put('kb-record-1', { $schema: 'http://json-schema.org/draft-07/schema#' });
    expect(folderProblems(sb.dir)).toEqual([
      `${SCHEMA_DIR}/kb-record-1.json: $schema is not ${DIALECT}`,
      'open set: no schema with key or ref "http://json-schema.org/draft-07/schema#"',
      'closed set: no schema with key or ref "http://json-schema.org/draft-07/schema#"',
    ]);
  });

  it('fail it, naming the definition, when one that no other refers to does not compile, which the schema alone never shows', () => {
    put('kb-cli-1', { $defs: { loose: { properties: { a: { type: 'string' } } } } });
    const loose = `${schemaUrl('kb-cli-1')}#/$defs/loose`;
    const root = `at "${schemaUrl('kb-cli-1')}#" (strictTypes)`;
    expect(folderProblems(sb.dir)).toEqual([
      `open set: ${loose}: strict mode: missing type "object" for keyword "properties" ${root}`,
      `closed set: ${loose}: strict mode: missing type "object" for keyword "additionalProperties" ${root}`,
    ]);
  });
});

describe('CLI_OUTPUT_SCHEMAS', () => {
  const reads = CLI_COMMANDS.filter((c) => c.group === 'read').map((c) => c.name);

  it('has an entry for every read command of kb.mjs and for no other name', () => {
    expect(reads.length).toBeGreaterThan(0);
    expect(Object.keys(CLI_OUTPUT_SCHEMAS).sort()).toEqual([...reads].sort());
  });

  it('names, for each command kb-cli/1 was published with, the definition of the same name in that schema, with the pointer that finds it', () => {
    const published = ['find', 'ls', 'get', 'brief', 'related', 'backlinks', 'refs', 'validate'];
    for (const command of published) {
      expect(CLI_OUTPUT_SCHEMAS[command], command).toBe(`${schemaUrl(SCHEMA_BASES.cli)}#/$defs/${command}`);
    }
  });

  it('names a definition of kb-cli/1 for the citation check, and the root of its own schema for the two commands that print a whole document', () => {
    expect(CLI_OUTPUT_SCHEMAS['resolve']).toBe(`${schemaUrl(SCHEMA_BASES.cli)}#/$defs/resolve`);
    expect(CLI_OUTPUT_SCHEMAS['record']).toBe(schemaUrl(SCHEMA_BASES.record));
    expect(CLI_OUTPUT_SCHEMAS['graph']).toBe(schemaUrl(SCHEMA_BASES.graph));
  });

  it('resolves every entry in the schema files of the repo, open and as the repo checks them', () => {
    for (const closed of [false, true]) {
      const set = contractSchemas(REPO_ROOT, { closed });
      for (const [command, id] of Object.entries(CLI_OUTPUT_SCHEMAS)) {
        // Asking for a definition that is not there throws, naming the id.
        expect(() => set.validate(id, null), `${command} (${closed ? 'closed' : 'open'})`).not.toThrow();
        expect(set.validate(id, null).length, command).toBeGreaterThan(0);
      }
    }
  });

  it('throws, naming the id, for a definition the schema does not have', () => {
    const set = contractSchemas(REPO_ROOT, { closed: false });
    const missing = `${schemaUrl(SCHEMA_BASES.cli)}#/$defs/nothing-here`;
    expect(() => set.validate(missing, null)).toThrow(missing);
  });
});
