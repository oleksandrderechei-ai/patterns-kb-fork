/**
 * The record of every page of the fixture tree, byte for byte against a file
 * kept beside this one: tools/src/kb/golden/record.<id>.json. A change to what
 * a record says, to the order of its keys or to the way it is written makes
 * these fail with the line that moved, which is the point: a reader of the
 * records is held to nothing else, and the change is then reviewed in the
 * diff of the goldens.
 *
 * The tree is `writeRecordFixture`: one page of each of the seven kinds and
 * the rest the record tells apart (every node type, both kinds of group, a
 * trailing paragraph after a list, written and numbered ids, a task list, an
 * aligned table, a wide captioned diagram, code and prose sketches, a link
 * with a fragment, generated blocks that say what the edges say, a theme with a
 * tour, prerequisites). There are no goldens over real pages: a page edit would
 * change one, and a gate that every content change must also rewrite is a gate
 * nobody reads.
 *
 *   KB_GOLDEN=update   write the goldens from what the code makes now, in place
 *                      of comparing: `KB_GOLDEN=update make tools-test T=record-golden`
 *
 * A missing golden is a failure, never a file written quietly: the update is a
 * decision.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { contractSchemas, schemaUrl } from '../contract/contract.js';
import { writeRecordFixture } from '../lib/fixtures.js';
import { formatFinding } from '../lib/json-schema.js';
import { serialize } from '../lib/kb-record.js';
import { makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';

import { Corpus } from './corpus.js';
import { recordOf } from './record.js';

const UPDATE = (process.env['KB_GOLDEN'] ?? '') === 'update';

/** The folder the goldens are kept in. */
const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');

/** Every page of the fixture tree, in the order the listing gives them. */
const IDS = ['breaker', 'retry', 'queue', 'storm', 'loop', 'steady', 'quick', 'boundary', 'shortener', 'queues', 'validators', 'brokers'];

const goldenFile = (dir: string, id: string): string => path.join(dir, `record.${id}.json`);

/**
 * Hold `text` to the golden of `id` in `dir`, line by line so that a failure
 * names the line, or write it when `update` is set. A golden that is not there
 * is a failure.
 */
function holdToGolden(dir: string, id: string, text: string, update: boolean): void {
  const file = goldenFile(dir, id);
  if (update) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  if (!fs.existsSync(file)) throw new Error(`no golden for ${id}: ${file} is missing; write it with KB_GOLDEN=update`);
  expect(text.split('\n')).toEqual(fs.readFileSync(file, 'utf8').split('\n'));
}

let sb: Sandbox;
let corpus: Corpus;
beforeAll(() => {
  sb = makeSandbox();
  writeRecordFixture(sb.dir);
  corpus = new Corpus(sb.dir);
});
afterAll(() => sb.cleanup());

describe('the golden records', () => {
  it('cover every page of the fixture tree, and the folder holds no other', () => {
    expect(corpus.listing.map((p) => p.slug).sort()).toEqual([...IDS].sort());
    if (!UPDATE) {
      expect(fs.readdirSync(GOLDEN_DIR).filter((f) => f.startsWith('record.')).sort()).toEqual(IDS.map((id) => `record.${id}.json`).sort());
    }
  });

  it.each(IDS)('serialises %s byte for byte as its golden', (id) => {
    holdToGolden(GOLDEN_DIR, id, serialize(recordOf(corpus, id)), UPDATE);
  });

  it('fails on a missing golden', () => {
    const empty = makeSandbox();
    try {
      expect(() => holdToGolden(empty.dir, 'breaker', serialize(recordOf(corpus, 'breaker')), false)).toThrow(/no golden for breaker: .*record\.breaker\.json is missing/);
      // Asked to update, it writes the file, and the file then holds.
      holdToGolden(empty.dir, 'breaker', serialize(recordOf(corpus, 'breaker')), true);
      expect(() => holdToGolden(empty.dir, 'breaker', serialize(recordOf(corpus, 'breaker')), false)).not.toThrow();
    } finally {
      empty.cleanup();
    }
  });

  it('fails on a golden that differs by one character, naming the line', () => {
    const odd = makeSandbox();
    try {
      const text = serialize(recordOf(corpus, 'retry'));
      holdToGolden(odd.dir, 'retry', text.replace('"id": "retry"', '"id": "retri"'), true);
      expect(() => holdToGolden(odd.dir, 'retry', text, false)).toThrow();
    } finally {
      odd.cleanup();
    }
  });

  it('write each golden as serialize does: two-space JSON, keys in order, one newline at the end', () => {
    for (const id of IDS) {
      const text = fs.readFileSync(goldenFile(GOLDEN_DIR, id), 'utf8');
      expect(serialize(JSON.parse(text) as unknown) === text, id).toBe(true);
      expect(text.endsWith('}\n') && !text.endsWith('\n\n'), id).toBe(true);
    }
  });

  it('every golden validates against kb-record-1 (closed)', () => {
    const schemas = contractSchemas(REPO_ROOT, { closed: true });
    for (const id of IDS) {
      const record = JSON.parse(fs.readFileSync(goldenFile(GOLDEN_DIR, id), 'utf8')) as unknown;
      expect(schemas.validate(schemaUrl('kb-record-1'), record).map(formatFinding), id).toEqual([]);
    }
  });
});
