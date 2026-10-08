/**
 * What the built site ships for machine readers beside the pages themselves:
 * one `kb-record/1` record per page of the knowledge base, the link graph, the
 * schemas, `llms.txt` and `llms-full.txt`, and the five fields `index.json`
 * gains to point at them. The post-build pass (site-portable.ts) writes the
 * files, and the portability gate (gates/check-site-portable.ts) holds what was
 * written to the same builder, so a file on the site is the one `kb.mjs` prints
 * for the same page, byte for byte.
 *
 *   readContract    every file, built in memory from the repo at `root`
 *   writeContract   the files `readContract` built, written under dist
 *   readSchemas     the schema files of tools/src/contract/schema/
 *   indexFieldsOf   a page's five index fields; null on a page outside the knowledge base
 *   recordAddress   a page's route as the address of its record: `/a/b.html` is `/a/b.json`
 *   llmsText        llms.txt, from the pages
 *   llmsFullOf      llms-full.txt, from the pages and their markdown
 *
 * THE FILES. A page's record is `serialize(recordOf(corpus, id))`, written
 * beside the built page at its route with `.json` for `.html`. `graph.json` is
 * `serialize(graphOf(corpus))`, and each schema is a byte copy of the file in
 * tools/src/contract/schema/. `llms.txt` follows llmstxt.org with links relative
 * to the site root, since the site opens from a folder, and lists every page of
 * the knowledge base under the plural of its kind, in the order `kb.mjs ls`
 * gives. `llms-full.txt` is the markdown of every page in that order, each
 * after one `<!-- kb:page id=<id> route=<route> -->` line, so a reader can cut
 * it back into pages.
 *
 * ALL OR NOTHING. A page whose record cannot be built is a finding, and so is a
 * record that would take the name of another file; either way no file is built,
 * and the caller writes nothing. Whether a page has built HTML is the
 * caller's to check, since only it has read the built site.
 *
 * A TREE WITHOUT A KNOWLEDGE BASE. A tree with no content model holds no page
 * of the knowledge base, and `readContract` says so with a null contract:
 * there is nothing to build, and no file to write or to check.
 *
 * Nothing here reads a clock, a random number or the environment.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CONTRACTS, SCHEMA_BASES, schemaDir } from '../contract/contract.js';
import { Corpus, DATA, KbError } from '../kb/corpus.js';
import { graphOf, recordOf } from '../kb/record.js';
import { serialize } from '../lib/kb-record.js';

/** A kind of page as the content model names it: its id, and the folder it sits in, which is its plural. */
export interface KindName {
  readonly id: string;
  readonly folder: string;
}

/** One page of the knowledge base, with what the files that name it need. */
export interface KbPage {
  readonly id: string;
  readonly kind: string;
  readonly band: string;
  readonly group: string;
  readonly title: string;
  readonly description: string;
  /** The page's address on the site: `/a/b.html`. */
  readonly route: string;
  /** The page's markdown, repo-relative. */
  readonly source: string;
  /** Where its record is served: `/a/b.json`. */
  readonly record: string;
  /** The record's bytes: `serialize(recordOf(corpus, id))`. */
  readonly json: string;
}

/** One schema file of the contract. */
export interface SchemaFile {
  /** The file's name, such as `kb-record-1.json`. */
  readonly name: string;
  readonly bytes: Buffer;
}

/** Every file the site ships for the contract, built and not yet written. */
export interface Contract {
  /** In the order `kb.mjs ls` lists them: by kind, then in reading order. */
  readonly pages: readonly KbPage[];
  readonly kinds: readonly KindName[];
  /** The bytes of graph.json. */
  readonly graph: string;
  readonly schemas: readonly SchemaFile[];
  /** The text of llms.txt. */
  readonly llms: string;
  /** The bytes of llms-full.txt. */
  readonly llmsFull: Buffer;
}

/** One thing wrong with the knowledge base that stops the files from being built, against the file to edit. */
export interface ContractFinding {
  readonly file: string;
  readonly what: string;
}

/** What `readContract` found: every file, or why there are none. */
export interface ContractRead {
  /** Null when the tree holds no knowledge base, and when `findings` is not empty. */
  readonly contract: Contract | null;
  readonly findings: readonly ContractFinding[];
}

/** The index fields of a page outside the knowledge base: all five are null. */
const NOT_KB = { id: null, kind: null, band: null, group: null, record: null } as const;

/** The five fields `index.json` holds for every page. */
export interface IndexFields {
  readonly id: string | null;
  readonly kind: string | null;
  readonly band: string | null;
  readonly group: string | null;
  readonly record: string | null;
}

/** A page's index fields; null in all five on a page that is not a page of the knowledge base (`undefined`). */
export function indexFieldsOf(page: KbPage | undefined): IndexFields {
  return page === undefined ? NOT_KB : { id: page.id, kind: page.kind, band: page.band, group: page.group, record: page.record };
}

/** A route as the address of its record: `/a/b.html` is `/a/b.json`. */
export function recordAddress(route: string): string {
  return route.replace(/\.html$/, '.json');
}

/** Whether the site keeps this address for something other than a record: the index, the graph, the schema folder. */
export function isReserved(address: string): boolean {
  return address === '/index.json' || address === '/graph.json' || address.startsWith('/schema/');
}

// ---------------------------------------------------------------------------
// llms.txt and llms-full.txt
// ---------------------------------------------------------------------------

/**
 * The files that describe the whole site, under a heading of their own in
 * llms.txt, each with what it is: the two indexes, the schema of every file
 * the site serves, the schema of what `kb.mjs` prints for a reader that has
 * the repository too, and the markdown of every page in one file.
 */
const CONTRACT_LINKS: readonly (readonly [file: string, what: string])[] = [
  ['index.json', `every page with its kind and the address of its record (${CONTRACTS.index})`],
  ['graph.json', `every page and every typed link between pages (${CONTRACTS.graph})`],
  [`schema/${SCHEMA_BASES.record}.json`, 'what each key of a page record means'],
  [`schema/${SCHEMA_BASES.index}.json`, 'what each key of index.json means'],
  [`schema/${SCHEMA_BASES.graph}.json`, 'what each key of graph.json means'],
  [`schema/${SCHEMA_BASES.cli}.json`, `what the \`--json\` output of each \`kb.mjs\` read command means (${CONTRACTS.cli})`],
  ['llms-full.txt', 'the markdown of every page in one file, each page after a `<!-- kb:page id=… route=… -->` line'],
];

/** The words above the first list of llms.txt. */
const LLMS_OPENING = [
  '# Patterns KB',
  '',
  '> Software design patterns, hazards, themes, principles, case studies, capabilities and comparisons, as markdown for people and JSON for programs.',
  '',
  'Every page of the knowledge base has its markdown source and its JSON record beside its HTML: `<page>.html` has `<page>.md` and `<page>.json`. ' +
    'The record is the page as typed data, with its blocks, its links to other pages and an id for every element a citation can name. ' +
    'The files below cover the whole site, and each has a schema under `schema/` that says what its keys mean.',
];

/** A link's visible text with the characters that would end it written plainly. */
const linkText = (text: string): string => text.replace(/[\\[\]]/g, '\\$&');

/** A run of words as one line. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `/a/b.html` as the page's markdown, relative to the site root: `a/b.md`. */
const markdownFrom = (route: string): string => route.slice(1).replace(/\.html$/, '.md');

/**
 * llms.txt: the opening, a `Contract` section of the files that describe the
 * whole site, then one section per kind, headed with the kind's plural, one
 * line a page: its title as the link text, its markdown as the target and its
 * description after a colon. Every link is relative to the site root, which
 * is where the file sits. The pages come in the order of `kb.mjs ls`, grouped
 * by kind, and a section opens each time the kind changes.
 */
export function llmsText(pages: readonly KbPage[], kinds: readonly KindName[]): string {
  const plural = new Map(kinds.map((k) => [k.id, `${k.folder.charAt(0).toUpperCase()}${k.folder.slice(1)}`]));
  const lines = [...LLMS_OPENING, '', '## Contract', '', ...CONTRACT_LINKS.map(([file, what]) => `- [${file}](${file}): ${what}`)];
  let kind = '';
  for (const page of pages) {
    if (page.kind !== kind) {
      kind = page.kind;
      // A page's kind comes from the content model, which is where `kinds` is read.
      lines.push('', `## ${plural.get(kind) as string}`, '');
    }
    const description = oneLine(page.description);
    lines.push(`- [${linkText(oneLine(page.title))}](${markdownFrom(page.route)})${description === '' ? '' : `: ${description}`}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The line that opens a page in llms-full.txt. */
export function pageMarker(page: Pick<KbPage, 'id' | 'route'>): string {
  return `<!-- kb:page id=${page.id} route=${page.route} -->`;
}

/**
 * llms-full.txt: for each page in the order given, its marker line and then
 * its markdown, byte for byte. A page whose last byte is not a newline gets
 * one, so that the next marker always begins a line.
 */
export function llmsFullOf(entries: readonly { readonly page: Pick<KbPage, 'id' | 'route'>; readonly markdown: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const { page, markdown } of entries) {
    parts.push(Buffer.from(`${pageMarker(page)}\n`), markdown);
    if (markdown.at(-1) !== 0x0a) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// reading and writing
// ---------------------------------------------------------------------------

/** The schema files of the repo at `root`, in file-name order; none when the folder is not there. */
export function readSchemas(root: string): SchemaFile[] {
  const dir = schemaDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }));
}

/**
 * Every file the site ships for the contract, built from the repo at `root`.
 * A tree with no content model has no knowledge base and gets a null contract.
 * A page the record cannot hold (tools/src/kb/record.ts) is a finding naming its
 * markdown; any other error is a fault in the build itself and is thrown.
 */
export function readContract(root: string): ContractRead {
  if (!fs.existsSync(path.join(root, DATA.model))) return { contract: null, findings: [] };
  const corpus = new Corpus(root);
  const findings: ContractFinding[] = [];
  const pages: KbPage[] = [];
  for (const page of corpus.listing) {
    const record = recordAddress(page.route);
    if (isReserved(record)) {
      findings.push({ file: page.source, what: `its record would be written at ${record}, which the site keeps for another file` });
      continue;
    }
    try {
      const meta = corpus.meta(page.slug);
      pages.push({
        id: page.slug,
        kind: page.kind,
        band: page.band,
        group: page.group,
        title: meta.title,
        description: meta.essence,
        route: page.route,
        source: page.source,
        record,
        json: serialize(recordOf(corpus, page.slug)),
      });
    } catch (e) {
      if (!(e instanceof KbError)) throw e;
      findings.push({ file: page.source, what: `its record cannot be built: ${e.message}` });
    }
  }
  if (findings.length > 0) return { contract: null, findings };
  const kinds = corpus.model.kinds.map((k) => ({ id: k.id, folder: k.folder }));
  return {
    contract: {
      pages,
      kinds,
      graph: serialize(graphOf(corpus)),
      schemas: readSchemas(root),
      llms: llmsText(pages, kinds),
      llmsFull: llmsFullOf(pages.map((page) => ({ page, markdown: fs.readFileSync(path.join(root, page.source)) }))),
    },
    findings,
  };
}

/** Write the files of `contract` under `dist`: records beside their pages, then the rest at the root. */
export function writeContract(dist: string, contract: Contract): void {
  const put = (rel: string, data: string | Buffer): void => {
    const to = path.join(dist, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, data);
  };
  for (const page of contract.pages) put(page.record, page.json);
  put('graph.json', contract.graph);
  for (const schema of contract.schemas) put(`schema/${schema.name}`, schema.bytes);
  put('llms.txt', contract.llms);
  put('llms-full.txt', contract.llmsFull);
}
