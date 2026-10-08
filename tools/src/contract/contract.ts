/**
 * The retrieval contract's names, in one place: where it is published, the id
 * of each contract, the file each schema lives in, and the folder those files
 * are in. A module that writes a `$schema` or a `contract` field, copies a
 * schema into the site or validates against one reads the name here, so a name
 * is edited once and a test can hold the rest to it.
 *
 *   PUBLISHED_ROOT      the URL the site, and so every schema's `$id`, lives under
 *   CONTRACTS           the four contract ids, each with its major version
 *   SCHEMA_BASES        each contract's schema file name, without `.json`
 *   schemaUrl           a schema's `$id`, from its file's base name
 *   CLI_OUTPUT_SCHEMAS  what each kb.mjs read command's `--json` output is checked against
 *   SCHEMA_DIR          the folder the schema files are in, from the repo root
 *   schemaDir           that folder under a given root
 *   contractSchemas     the schemas in that folder, as a set to validate against
 *
 * The schemas sit here and not in `docs/data/`: the json-sanity gate asks every
 * file under `docs/data/` to open with `version`, `updated` and `note`, a
 * header a schema document cannot carry.
 *
 * Nothing here reads the environment. A record's bytes name the schema by URL,
 * so they must not change with where a build is deployed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readSchemaDir, schemaSet, type SchemaSet } from '../lib/json-schema.js';

/**
 * Where the site is published, ending in `/`. A fixed value on purpose, never
 * read from `SITE_URL`: a fork that deploys elsewhere still writes records and
 * schemas that name the published contract, and every build writes the same
 * bytes.
 */
export const PUBLISHED_ROOT = 'https://odere-pro.github.io/patterns-kb/';

/**
 * The contract ids, the value of a record's `contract` field among them. The
 * number is the major version: adding a key stays inside it, while a rename, a
 * removal, a changed type or a changed order makes the next number and
 * publishes its schema beside the old one.
 */
export const CONTRACTS = {
  record: 'kb-record/1',
  graph: 'kb-graph/1',
  index: 'kb-index/1',
  cli: 'kb-cli/1',
} as const;

/** The schema file of each contract in CONTRACTS, without `.json`: the id with `/` written `-`. */
export const SCHEMA_BASES = {
  record: 'kb-record-1',
  graph: 'kb-graph-1',
  index: 'kb-index-1',
  cli: 'kb-cli-1',
} as const;

/** The `$id` of the schema stored as `<base>.json`, and the URL it is served at. */
export function schemaUrl(base: string): string {
  return `${PUBLISHED_ROOT}schema/${base}.json`;
}

/** The id of the kb-cli schema's definition `name`: the schema's `$id` and the pointer to it, as `SchemaSet.validate` takes it. */
function cliDefinition(name: string): string {
  return `${schemaUrl(SCHEMA_BASES.cli)}#/$defs/${name}`;
}

/**
 * What each kb.mjs read command's `--json` output is checked against, by
 * command name: a definition of kb-cli-1.json for the commands that print a
 * list or a small report, and the root of the schema of its own for `record`
 * and `graph`, which each print one whole document. A test holds that every
 * read command of the CLI has an entry and that each entry resolves, so a read
 * command cannot ship without a schema for what it prints.
 */
export const CLI_OUTPUT_SCHEMAS: Readonly<Record<string, string>> = {
  find: cliDefinition('find'),
  ls: cliDefinition('ls'),
  get: cliDefinition('get'),
  brief: cliDefinition('brief'),
  related: cliDefinition('related'),
  backlinks: cliDefinition('backlinks'),
  refs: cliDefinition('refs'),
  validate: cliDefinition('validate'),
  record: schemaUrl(SCHEMA_BASES.record),
  graph: schemaUrl(SCHEMA_BASES.graph),
  resolve: cliDefinition('resolve'),
};

/** The folder the schema files are in, relative to the repo root and written with `/`, as a finding names a file. */
export const SCHEMA_DIR = 'tools/src/contract/schema';

/** The schema folder of the repo at `root`. */
export function schemaDir(root: string): string {
  return path.join(root, SCHEMA_DIR);
}

/**
 * Every schema file under `root` as one set, so a `$ref` from one file to
 * another resolves. A tree with no schema folder gives an empty set; asking
 * it for a schema then throws, naming the id.
 *
 * `closed` is the form the repo's gates check: every object closed to keys
 * the schema does not list. Without it the set is the schemas as published.
 */
export function contractSchemas(root: string, options: { readonly closed: boolean }): SchemaSet {
  const dir = schemaDir(root);
  return schemaSet(fs.existsSync(dir) ? readSchemaDir(dir) : [], options);
}
