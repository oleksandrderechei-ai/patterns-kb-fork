/**
 * The retrieval contract held to its published schemas, over every page of the
 * tree. The schemas in tools/src/contract/schema/ say what `kb.mjs` prints
 * (`kb-record/1` for a page, `kb-graph/1` for the link graph, `kb-cli/1` for
 * the `--json` of every other read command), and the unit tests show each one
 * on a fixture tree. This gate shows them on the pages the tree really has, so a
 * page that makes the record builder print a shape the schema forbids, or an
 * edit of the code that changes what a command prints, is a finding on the
 * commit that did it and not a surprise to a reader that parsed the old shape.
 *
 * Every call is made in-process through `run` in tools/src/kb/cli.ts, over one
 * corpus read once, and what it printed is parsed, held to the closed form of
 * its schema (every object closed to a key the schema does not list), and
 * checked against the order the schema lists each object's keys in. Per page:
 *
 *   record <id>                          kb-record-1.json
 *   get, related, backlinks, refs <id>   a definition of kb-cli-1.json
 *   resolve, for the first element       a definition of kb-cli-1.json; the
 *     of the page that has a fingerprint   citation must come back ok (exit 0)
 *
 * Once for the tree: `ls`, `validate` and `graph`; and for every query of
 * docs/data/search-oracle.json: `find` and `brief`.
 *
 * A call also has to end the way the contract says: exit 0 (1 for `validate`,
 * whose findings are its answer, and still printed), nothing on stderr, and
 * stdout the two-space JSON of its own value with one newline at the end, which
 * is the form the bytes of a record are fixed in.
 *
 * The schema files are read first. One that is missing, is not JSON or does not
 * compile in strict mode is a finding, and no page is read after it: a schema
 * that cannot judge would pass every page.
 *
 * A finding names the page, then the call and where in what it printed the fault
 * is: `record /blocks/3/id: must match pattern … (pattern)`, or `record /source:
 * from key 1 printed path, sha256 where the schema lists sha256, path (key
 * order)`. At most SHOWN findings are named for one page, one query or one
 * whole-tree command, and the rest are counted in one more, since a fault in a
 * shared definition repeats over a whole page.
 *
 * Like every kb.mjs run, a call may refresh the page cache kb.mjs keeps under
 * node_modules/.cache/kb/ (tools/src/kb/disk-cache.ts), and nothing else is
 * written. Nothing here reads a clock, a random number or the environment.
 *
 * The gate needs the schemas and a whole knowledge base, so its registry row
 * lists the data files the records are built from and not `docs/data/**`.
 * tools/src/gen/gen-taxonomy.test.ts (data-O2) edits one data file in a bare
 * tree and runs every registered gate whose `scans` reach it; a gate that needs
 * the full tree keeps its `scans` off the data files that scenario edits.
 *
 * Usage: check-kb-records   (no arguments)
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLI_OUTPUT_SCHEMAS, CONTRACTS, SCHEMA_DIR, schemaDir } from '../contract/contract.js';
import { run } from '../kb/cli.js';
import { Corpus, KbError, type Page } from '../kb/corpus.js';
import { main, type GateContext, type GateSpec } from '../lib/gate.js';
import { formatFinding, readSchemaDir, schemaSet, type JsonSchema, type SchemaSet } from '../lib/json-schema.js';
import { serialize } from '../lib/kb-record.js';
import { keyOrderProblemsOf } from '../lib/schema-order.js';

import { SRC as ORACLE } from './check-search-oracle.js';

/** How many findings one page, one query or one whole-tree command names before the rest are counted in a line. */
export const SHOWN = 5;

/** What one run of a kb.mjs command wrote: its exit code, and each stream's lines joined by newlines. */
export interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** What a command printed as a value, or the one thing wrong with how it ended. */
export type Answer = { readonly value: unknown } | { readonly problem: string };

/** The schemas the gate holds the tree to: the set that judges a value, and the files as written, for the order of keys. */
interface Held {
  readonly schemas: SchemaSet;
  readonly files: readonly JsonSchema[];
}

/** What probing a command gave: the lines of everything wrong with it, and the value it printed, when it printed one. */
interface Probed {
  readonly lines: readonly string[];
  readonly value: unknown;
}

/** The first line of a stream, or '' when there is none. */
const firstLine = (text: string): string => text.split('\n')[0] as string;

/** A message on one line: V8 quotes the text it choked on, newlines and all. */
const oneLine = (message: string): string => message.replace(/\s+/g, ' ');

/** `message` with `dir`, a folder the tree is read from, left out of every path it names. */
const without = (message: string, dir: string): string => message.split(`${dir}${path.sep}`).join('');

/** The base name of the schema file an id lives in: `kb-cli-1` for `https://…/schema/kb-cli-1.json#/$defs/find`. */
const baseOf = (id: string): string => path.posix.basename(id.split('#')[0] as string, '.json');

/**
 * What `command` printed, as a value, or what is wrong with how it ended. The
 * exit code must be one of `exits`, stderr empty, stdout JSON, and stdout the
 * two-space serialisation of that JSON with one newline after it (`io.out` adds
 * the newline, so `ran.out` has none).
 */
export function answerOf(command: string, ran: Ran, exits: readonly number[]): Answer {
  if (!exits.includes(ran.code)) {
    const said = firstLine(ran.err);
    return { problem: `${command}: exits ${String(ran.code)}, not ${exits.join(' or ')}${said === '' ? '' : ` — stderr says "${said}"`}` };
  }
  if (ran.err !== '') return { problem: `${command}: writes to stderr: "${firstLine(ran.err)}"` };
  let value: unknown;
  try {
    value = JSON.parse(ran.out);
  } catch (e) {
    return { problem: `${command}: does not print JSON — ${oneLine((e as Error).message)}` };
  }
  if (`${ran.out}\n` !== serialize(value)) return { problem: `${command}: is not two-space JSON with one newline at the end` };
  return { value };
}

/** What `pointer` (RFC 6901) reaches in `root`; undefined when a step leads nowhere. */
function reach(root: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((node, step) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[step.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), root);
}

/**
 * The citation of the first element of a record that has a fingerprint,
 * `<page id>#<element id>@<fp>`, the fingerprint read where the record's own
 * `anchors` say the element is. Null when `record` is no record, or none of
 * its elements has a fingerprint (a block has none, and a page of blocks
 * alone has no element to cite).
 */
export function refOf(record: unknown): string | null {
  const { id, anchors } = (record ?? {}) as { id?: unknown; anchors?: unknown };
  if (typeof id !== 'string' || typeof anchors !== 'object' || anchors === null) return null;
  for (const [element, pointer] of Object.entries(anchors)) {
    const fp = (reach(record, String(pointer)) as { fp?: unknown } | undefined)?.fp;
    if (typeof fp === 'string') return `${id}#${element}@${fp}`;
  }
  return null;
}

/**
 * Every way `value`, what `command` printed, breaks the schema that command's
 * output is held to, as lines that open with `label`: the findings of the
 * closed schema, then the objects whose keys are out of the schema's order.
 */
function breaches(held: Held, label: string, command: string, value: unknown): string[] {
  const id = CLI_OUTPUT_SCHEMAS[command] as string;
  return [
    ...held.schemas.validate(id, value).map((f) => `${label} ${formatFinding(f)}`),
    ...keyOrderProblemsOf(held.files, id, value).map((p) => `${label} ${p} (key order)`),
  ];
}

/** Run one kb.mjs command over `corpus`, in-process, and take down what it wrote. */
async function ask(corpus: Corpus, argv: readonly string[]): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, corpus);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/**
 * Run `argv` and hold what it printed to the schema of its command. `label` is
 * how the lines name the call; `exits` the codes it may end with.
 */
async function probe(held: Held, corpus: Corpus, label: string, argv: readonly string[], exits: readonly number[] = [0]): Promise<Probed> {
  const answer = answerOf(label, await ask(corpus, argv), exits);
  if ('problem' in answer) return { lines: [answer.problem], value: undefined };
  return { lines: breaches(held, label, argv[0] as string, answer.value), value: answer.value };
}

/**
 * Name what is wrong, at `file`, or in no file when it is null: the first
 * SHOWN lines, each a finding, and one more that counts the rest.
 */
function report(ctx: GateContext, file: string | null, lines: readonly string[]): void {
  const say = (what: string): void => (file === null ? ctx.failLine(what) : ctx.fail(file, what));
  for (const line of lines.slice(0, SHOWN)) say(line);
  if (lines.length > SHOWN) say(`… and ${String(lines.length - SHOWN)} more`);
}

/**
 * The schemas of the tree at `ctx.root`, closed, and as written; or null when
 * one the gate needs is missing, is not JSON or does not compile, after naming
 * what is wrong. A schema compiles the first time it is asked for, so each one
 * the commands are held to is asked for here, once.
 */
function heldOf(ctx: GateContext): Held | null {
  const dir = schemaDir(ctx.root);
  let files: JsonSchema[];
  let schemas: SchemaSet;
  try {
    files = fs.existsSync(dir) ? readSchemaDir(dir) : [];
    schemas = schemaSet(files, { closed: true });
  } catch (e) {
    ctx.fail(SCHEMA_DIR, oneLine(without((e as Error).message, dir)));
    return null;
  }
  const named = new Set<string>();
  for (const id of Object.values(CLI_OUTPUT_SCHEMAS)) {
    const base = baseOf(id);
    const file = `${SCHEMA_DIR}/${base}.json`;
    if (!schemas.ids.includes(id.split('#')[0] as string)) {
      if (!named.has(file)) ctx.fail(file, 'is missing — the commands of kb.mjs are held to it');
      named.add(file);
      continue;
    }
    try {
      schemas.validate(id, null);
    } catch (e) {
      // A definition of a file that does not compile fails for every command that names it, with the one message.
      if (!named.has(file)) ctx.fail(file, `does not compile — ${oneLine((e as Error).message)}`);
      named.add(file);
    }
  }
  return ctx.findings === 0 ? { schemas, files } : null;
}

/**
 * The queries of the search oracle, in file order: what `find` and `brief` are
 * asked for. Null, after naming it, when the file is missing, is not JSON or
 * holds no query: the gate would otherwise pass having asked neither.
 */
function queriesOf(ctx: GateContext): string[] | null {
  const file = path.join(ctx.root, ORACLE);
  if (!fs.existsSync(file)) {
    ctx.fail(ORACLE, 'is missing — it lists the queries `find` and `brief` are held to their schemas with');
    return null;
  }
  let cases: unknown;
  try {
    cases = (JSON.parse(fs.readFileSync(file, 'utf8')) as { cases?: unknown } | null)?.cases;
  } catch {
    ctx.fail(ORACLE, 'is not valid JSON');
    return null;
  }
  const queries = (Array.isArray(cases) ? cases : []).flatMap((c: { q?: unknown } | null) => (typeof c?.q === 'string' ? [c.q] : []));
  if (queries.length === 0) {
    ctx.fail(ORACLE, 'lists no query: no case has a string "q"');
    return null;
  }
  return queries;
}

/** Every page, in the order `ls` lists them; null, after naming why, when the tree cannot be listed. */
function pagesOf(ctx: GateContext, corpus: Corpus): readonly Page[] | null {
  try {
    return corpus.listing;
  } catch (e) {
    if (!(e instanceof KbError)) throw e;
    ctx.failLine(`the pages cannot be listed: ${oneLine(without(e.message, ctx.root))}`);
    return null;
  }
}

/** The commands that print a page's own facts, run for every page. */
const PER_PAGE = ['get', 'related', 'backlinks', 'refs'] as const;

/** The commands of a whole tree, and the exit codes each may end with. */
const WHOLE_TREE: readonly (readonly [readonly string[], readonly number[]])[] = [
  [['ls', '--json'], [0]],
  // The findings of `validate` are its answer: it prints them and exits 1.
  [['validate', '--json'], [0, 1]],
  [['graph'], [0]],
];

/** One page through every command it is held to; the lines of everything wrong, in the order the commands run. */
async function pageLines(held: Held, corpus: Corpus, page: Page): Promise<string[]> {
  const record = await probe(held, corpus, 'record', ['record', page.slug]);
  const lines = [...record.lines];
  for (const command of PER_PAGE) lines.push(...(await probe(held, corpus, command, [command, page.slug, '--json'])).lines);
  const ref = refOf(record.value);
  // A record's own citation is ok by construction; one that is not exits 1, which is the finding.
  if (ref !== null) lines.push(...(await probe(held, corpus, `resolve ${ref}`, ['resolve', ref, '--json'])).lines);
  return lines;
}

export const spec: GateSpec = {
  name: 'kb-record-schema',
  usage: 'usage: check-kb-records   (no arguments)',
  async run(ctx: GateContext): Promise<string> {
    const held = heldOf(ctx);
    if (held === null) return '';
    const queries = queriesOf(ctx);
    if (queries === null) return '';
    const corpus = new Corpus(ctx.root);
    const pages = pagesOf(ctx, corpus);
    if (pages === null) return '';

    for (const page of pages) report(ctx, page.source, await pageLines(held, corpus, page));
    for (const [argv, exits] of WHOLE_TREE) {
      const command = argv[0] as string;
      report(ctx, null, (await probe(held, corpus, command, argv, exits)).lines);
    }
    for (const q of queries) {
      for (const command of ['find', 'brief']) {
        report(ctx, ORACLE, (await probe(held, corpus, `${command} ${JSON.stringify(q)}`, [command, q, '--json'])).lines);
      }
    }
    if (ctx.findings > 0) return '';
    return `[kb-record-schema] ${String(pages.length)} pages: record, get, related, backlinks, refs and resolve hold ${CONTRACTS.record} and ${CONTRACTS.cli}; ls, validate, graph and ${String(queries.length)} queries too`;
  },
};

main(spec, import.meta.url);
