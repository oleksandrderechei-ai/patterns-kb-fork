/**
 * The built site opens from a local folder, and this gate is what stops that
 * quietly ceasing to be true (spec kb.site.offline, portability-gate).
 *
 * Over site/dist it checks what no build setting can promise:
 *
 *   1. no `href`, `src` or `xlink:href` starts with a single `/` — a page
 *      opened from disk has no root (offline-C3); a `//` start is external.
 *      Attributes are read from the page's start tags, whatever the quoting,
 *      by the one page reader (lib/built-page.ts), never by a spelling;
 *   2. no project-added script is a module — a module never runs from
 *      `file://`; ours are the tags carrying `data-kb` (offline-C5);
 *   3. every page carries its `kb:area` fact in the head (offline-C4);
 *   4. keyboard reach survives the build: no positive tabindex, and every page
 *      keeps a skip link whose `href` is a fragment (offline-C7);
 *   5. the manifest and the search payload exist and are not empty;
 *   6. the payload covers the site: every built page but the hubs is in it,
 *      every route in it is on disk, and every heading id it offers is an
 *      anchor in its page — an `id` or `name` outside code, the anchor set the
 *      link gate reads (`readLinks`), so a mermaid edge's `data-id` is none
 *      (offline-C6). Which routes are hubs is `isHubRoute`, the predicate the
 *      payload pass shares.
 *
 *   7. every page-tree page has its markdown source beside it: `<route>.md`,
 *      byte for byte the file under docs/ the structure names, and no other
 *      `.md` ships — the "View source" link opens it from disk. A built row
 *      with no source file is a finding too.
 *
 *   8. in a tree that holds the knowledge base (it has a content model), the
 *      files of the retrieval contract are the ones the repo builds: each page
 *      of the knowledge base has its record, `<route minus .html>.json`, byte
 *      for byte the text `kb.mjs record <id>` prints, and no other `.json`
 *      ships but `index.json`, `graph.json`, the schemas and the records the
 *      index lists; `graph.json` is what `kb.mjs graph` prints; `schema/` holds
 *      a byte copy of each file under tools/src/contract/schema/ and nothing
 *      more; `index.json` holds the closed form of kb-index-1 and its `id`,
 *      `kind`, `band`, `group` and `record` say what the records say; `llms.txt`
 *      is what the build writes from the pages and every link in it opens a
 *      file; `llms-full.txt` is the markdown of every page after its marker
 *      line; and each page's head links, by `<link rel="alternate">`, the
 *      markdown and the record beside it, and no other file of either kind.
 *      Every expected file is built from the repo root by site-records.ts, the
 *      builder the post-build pass writes with, so what is judged is what a
 *      reader of the built site is told.
 *
 * Every finding names its file from the repository root, whatever form
 * `--dist` was given in (contract-C5).
 *
 * (6) is here and not in the link gate because nothing links to a search
 * result: the rows are built in the browser, so a link checker walking the
 * built pages sees none of them.
 *
 * Usage: check-site-portable [--dist <dir>]   (default site/dist)
 */

import fs from 'node:fs';
import path from 'node:path';

import { contractSchemas, SCHEMA_BASES, SCHEMA_DIR, schemaUrl } from '../contract/contract.js';
import { attrValue, metaContent, parseAttrs, tags } from '../lib/built-page.js';
import { main, type GateContext, type GateSpec } from '../lib/gate.js';
import { formatFinding } from '../lib/json-schema.js';
import { decodeHeadings, type WireHeading } from '../lib/search-score.js';
import { findInDir, PAYLOAD_FILE_NAME } from '../lib/asset-names.js';
import { fromPageTree, isHubRoute, placedPages } from '../lib/site-routes.js';
import { markdownRoute } from '../site/site-portable.js';
import { DIST, readStructure } from '../site/site-output.js';
import { indexFieldsOf, readContract, recordAddress, type Contract } from '../site/site-records.js';
import { readLinks } from './check-site-links.js';

/** The two files the post-build passes write beside the pages; the payload's name may carry a hash. */
export const INDEX_FILES = ['index.json', 'search-index.js'] as const;

/** One page of the search payload, as far as this gate reads it. */
export interface PayloadPage {
  route: string;
  headings: { id: string; text: string }[];
}

/**
 * `window.kb = {…};` read back as data. A pattern, never an evaluator: this
 * gate must not run the file it checks, and the shape it asserts — one
 * assignment, one object holding a pages list — is exactly what the pattern
 * says.
 */
export function parsePayload(js: string): { pages: PayloadPage[] } | null {
  const m = /^window\.kb = (\{[\s\S]*\});\s*$/.exec(js);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1] as string) as { pages?: unknown };
    if (!Array.isArray(parsed.pages)) return null;
    return {
      pages: (parsed.pages as { route: string; headings: WireHeading[] }[]).map((p) => ({ route: p.route, headings: decodeHeadings(p.headings) })),
    };
  } catch {
    return null;
  }
}

/** Attributes that point at something. */
export const LINK_ATTRS = ['href', 'src', 'xlink:href'] as const;

/** A root-absolute target: one `/`, never `//`, which is another host. */
export const ROOT_ABSOLUTE = /^\/(?!\/)/;

/** One finding a page's tags earn, at its line. */
export interface TagHit {
  readonly line: number;
  readonly what: string;
}

/** 1-based line of each offset, by binary search over the line starts. */
export function lineIndex(html: string): (offset: number) => number {
  const starts = [0];
  for (let i = html.indexOf('\n'); i >= 0; i = html.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** A `<link rel="alternate">` of a page's head: the kind of file it says it is, and where it points as written. */
export interface Alternate {
  readonly type: string;
  readonly href: string;
}

/** What one page's start tags say about portability and keyboard reach, read once. */
export interface TagRead {
  readonly rootAbsolute: TagHit[];
  readonly positiveTabindex: TagHit[];
  /** A `<script type="module">` carrying `data-kb`: one of ours. */
  readonly injectedModule: boolean;
  /** Starlight's skip link, its href a fragment. */
  readonly skipLink: boolean;
  /** Every `<link rel="alternate">`, in page order. */
  readonly alternates: Alternate[];
}

/**
 * Walk a page's start tags once. Attribute values are read as the page reader
 * reads them, so single quotes, no quotes and any order are all one answer.
 */
export function readTags(html: string): TagRead {
  const lineAt = lineIndex(html);
  const out = { rootAbsolute: [] as TagHit[], positiveTabindex: [] as TagHit[], injectedModule: false, skipLink: false, alternates: [] as Alternate[] };
  for (const t of tags(html)) {
    if (t.closing) continue;
    const attrs = parseAttrs(t.source);
    if (t.name === 'link' && (attrValue(attrs, 'rel') ?? '').toLowerCase().split(/\s+/).includes('alternate')) {
      out.alternates.push({ type: attrValue(attrs, 'type') ?? '', href: attrValue(attrs, 'href') ?? '' });
    }
    for (const name of LINK_ATTRS) {
      const v = attrValue(attrs, name);
      if (v !== undefined && ROOT_ABSOLUTE.test(v)) out.rootAbsolute.push({ line: lineAt(t.start), what: `${name}="${v}"` });
    }
    const tab = attrValue(attrs, 'tabindex');
    if (tab !== undefined && /^\s*[1-9]\d*\s*$/.test(tab)) out.positiveTabindex.push({ line: lineAt(t.start), what: `tabindex="${tab.trim()}"` });
    const has = (n: string): boolean => attrs.some((a) => a.name === n);
    if (t.name === 'script' && has('data-kb') && attrValue(attrs, 'type')?.trim().toLowerCase() === 'module') out.injectedModule = true;
    if (t.name === 'a' && (attrValue(attrs, 'class') ?? '').split(/\s+/).includes('sl-skip-link') && (attrValue(attrs, 'href') ?? '').startsWith('#')) {
      out.skipLink = true;
    }
  }
  return out satisfies TagRead;
}

function filesEnding(dir: string, ext: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const htmlFiles = (dir: string): string[] => filesEnding(dir, '.html');
const markdownFiles = (dir: string): string[] => filesEnding(dir, '.md');

/** How many ways one document may break its schema before the rest are counted in one finding. */
export const SCHEMA_FINDINGS_SHOWN = 5;

/** The two kinds of file a page's head links beside it. */
export const DISCOVERY_TYPES: readonly string[] = ['text/markdown', 'application/json'];

/** What check 8 reads of the built site besides the files themselves. */
export interface ContractView {
  /** The built site, absolute. */
  readonly dist: string;
  /** A path in the built site as a finding names it, from the repository root. */
  readonly shown: (file: string) => string;
  /** Each built page's `<link rel="alternate">`, by route. */
  readonly discovery: ReadonlyMap<string, readonly Alternate[]>;
  /** The markdown routes the page tree owns (check 7), `/a/b.md`. */
  readonly markdown: ReadonlySet<string>;
}

/** A JSON file's value, or what is wrong with it. */
function readJson(file: string): { readonly value: unknown } | { readonly problem: string } {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) as unknown };
  } catch (e) {
    return { problem: (e as Error).message };
  }
}

/**
 * Check 8: the files of the retrieval contract against what the repo builds
 * for them (the header lists what each must be). `contract` is that build.
 */
export function checkContract(ctx: GateContext, contract: Contract, view: ContractView): void {
  const { dist, shown } = view;
  const at = (rel: string): string => path.join(dist, rel);

  /** One file the pass writes, held to the bytes the repo builds for it. */
  const holds = (rel: string, want: string | Buffer, from: string): void => {
    if (!fs.existsSync(at(rel))) ctx.fail(shown(at(rel)), 'is missing — site-portable writes it; run make site-build');
    else if (!fs.readFileSync(at(rel)).equals(typeof want === 'string' ? Buffer.from(want) : want)) ctx.fail(shown(at(rel)), `differs from ${from} — run make site-build`);
  };

  // The index holds its schema, and says of each page what the page's record says.
  const indexAt = at('index.json');
  const index = readJson(indexAt);
  let entries: readonly Record<string, unknown>[] | null = null;
  if ('problem' in index) {
    ctx.fail(shown(indexAt), `is not valid JSON — ${index.problem}`);
  } else {
    const schemas = contractSchemas(ctx.root, { closed: true });
    const id = schemaUrl(SCHEMA_BASES.index);
    if (!schemas.ids.includes(id)) {
      ctx.fail(`${SCHEMA_DIR}/${SCHEMA_BASES.index}.json`, 'is missing — index.json is held to it');
    } else {
      const problems = schemas.validate(id, index.value).map(formatFinding);
      for (const problem of problems.slice(0, SCHEMA_FINDINGS_SHOWN)) ctx.fail(shown(indexAt), `breaks ${SCHEMA_BASES.index}: ${problem}`);
      if (problems.length > SCHEMA_FINDINGS_SHOWN) ctx.fail(shown(indexAt), `breaks ${SCHEMA_BASES.index} in ${problems.length - SCHEMA_FINDINGS_SHOWN} more place(s)`);
      // Only a document that holds its schema is read for its pages.
      if (problems.length === 0) entries = (index.value as { pages: Record<string, unknown>[] }).pages;
    }
  }
  const kb = new Set(contract.pages.map((p) => p.route));
  if (entries !== null) {
    const byRoute = new Map(entries.map((e) => [e['route'], e]));
    for (const page of contract.pages) {
      const entry = byRoute.get(page.route);
      if (entry === undefined) {
        ctx.fail(shown(indexAt), `has no entry for ${page.route}, a page of the knowledge base`);
        continue;
      }
      for (const [key, want] of Object.entries(indexFieldsOf(page))) {
        if (entry[key] !== want) ctx.fail(shown(indexAt), `${page.route}: ${key} is ${JSON.stringify(entry[key])}, the page's record says ${JSON.stringify(want)}`);
      }
    }
    for (const entry of entries) {
      const named = Object.keys(indexFieldsOf(undefined)).filter((key) => entry[key] !== null);
      if (!kb.has(entry['route'] as string) && named.length > 0) ctx.fail(shown(indexAt), `${entry['route'] as string}: names ${named.join(', ')}, but it is no page of the knowledge base`);
    }
  }

  // Every record, the graph and the schemas are what the repo builds, and no other file of their kinds ships.
  for (const page of contract.pages) holds(page.record.slice(1), page.json, `what \`kb.mjs record ${page.id}\` prints`);
  holds('graph.json', contract.graph, 'what `kb.mjs graph` prints');
  for (const schema of contract.schemas) holds(`schema/${schema.name}`, schema.bytes, `${SCHEMA_DIR}/${schema.name}`);
  if (entries !== null) {
    const listed = new Set(entries.flatMap((e) => (typeof e['record'] === 'string' ? [e['record']] : [])));
    for (const file of filesEnding(dist, '.json')) {
      const rel = `/${path.relative(dist, file).split(path.sep).join('/')}`;
      if (rel === '/index.json' || rel === '/graph.json' || rel.startsWith('/schema/') || listed.has(rel)) continue;
      ctx.fail(shown(file), 'is a JSON file no entry of index.json lists as its record — only a page of the knowledge base ships one');
    }
  }
  const published = new Set(contract.schemas.map((s) => s.name));
  for (const name of fs.existsSync(at('schema')) ? fs.readdirSync(at('schema')).sort() : []) {
    if (!published.has(name)) ctx.fail(shown(at(`schema/${name}`)), `is no file of ${SCHEMA_DIR} — only those are published`);
  }

  // The text files: llms.txt as built, with every link in it opening a file, and llms-full.txt as built.
  holds('llms.txt', contract.llms, 'what site-records.ts builds from the pages');
  holds('llms-full.txt', contract.llmsFull, 'the markdown of every page, each after its marker line');
  if (fs.existsSync(at('llms.txt'))) {
    const seen = new Set<string>();
    for (const m of fs.readFileSync(at('llms.txt'), 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1] as string;
      if (seen.has(target)) continue;
      seen.add(target);
      if (!fs.existsSync(at(target))) ctx.fail(shown(at('llms.txt')), `links ${target}, and no such file was built`);
    }
  }

  // Each page's head links the files beside it, and only those.
  const want = (route: string): (readonly [string, string])[] => [
    ...(view.markdown.has(markdownRoute(route)) ? [['text/markdown', markdownRoute(route)] as const] : []),
    ...(kb.has(route) ? [['application/json', recordAddress(route)] as const] : []),
  ];
  const key = (link: readonly [string, string]): string => `${link[0]} ${link[1]}`;
  for (const [route, alternates] of view.discovery) {
    const wanted = want(route);
    const found = alternates
      .filter((a) => DISCOVERY_TYPES.includes(a.type))
      .map((a) => [a.type, path.posix.join(path.posix.dirname(route), a.href)] as const);
    const wantedKeys = new Set(wanted.map(key));
    const foundKeys = new Set(found.map(key));
    for (const link of wanted) {
      if (!foundKeys.has(key(link))) ctx.fail(shown(at(route.slice(1))), `its head has no <link rel="alternate" type="${link[0]}"> to ${link[1]} — site/src/components/Head/Head.astro writes it`);
    }
    for (const link of found) {
      if (!wantedKeys.has(key(link))) ctx.fail(shown(at(route.slice(1))), `its head links ${link[1]} as ${link[0]}, and that is no file of this page`);
    }
  }
}

export const spec: GateSpec = {
  name: 'site-portable',
  usage: 'usage: check-site-portable [--dist <dir>]',
  options: ['--dist'],
  run(ctx: GateContext): string {
    const dist = ctx.options.get('--dist') ?? DIST;
    const abs = path.resolve(ctx.root, dist);
    // `--dist ''` must fail like any other missing folder: path.resolve reads
    // '' as the repository itself, which exists.
    if (dist === '' || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      ctx.failLine(`no built site at ${dist || "''"} — build it first: make site-build`);
      return '';
    }
    const pages = htmlFiles(abs);
    if (pages.length === 0) {
      ctx.failLine(`no .html files under ${dist} — build it first: make site-build`);
      return '';
    }
    // Every finding path is from the repository root, however --dist was
    // written: absolute, `./`-led or with a trailing slash (contract-C5).
    const shown = (p: string): string => path.relative(ctx.root, p).split(path.sep).join('/');
    const payloadPath = findInDir(abs, PAYLOAD_FILE_NAME) ?? path.join(abs, 'search-index.js');
    const payloadAt = shown(payloadPath);

    // What each page's head links beside it, kept for check 8.
    const discovery = new Map<string, readonly Alternate[]>();
    for (const file of pages) {
      const rel = shown(file);
      const html = fs.readFileSync(file, 'utf8');
      const read = readTags(html);
      discovery.set(`/${path.relative(abs, file).split(path.sep).join('/')}`, read.alternates);
      for (const hit of read.rootAbsolute) {
        ctx.fail(rel, `root-absolute reference ${hit.what} — the post-build pass makes links relative; run make site-build`, hit.line);
      }
      for (const hit of read.positiveTabindex) {
        ctx.fail(rel, `positive tabindex ${hit.what} reorders the keyboard walk`, hit.line);
      }
      if (read.injectedModule) ctx.fail(rel, 'a <script type="module"> carrying data-kb — a module never runs from file://');
      // By the attributes the element has, never a quoted spelling (head-C9).
      if (!metaContent(html, 'kb:area')) ctx.fail(rel, 'no <meta name="kb:area" content="…"> — site/src/components/Head/Head.astro emits it');
      if (!read.skipLink) {
        ctx.fail(rel, 'no skip link — every page keeps <a class="sl-skip-link" href="#…">; a build pass lost it');
      }
    }

    let missing = false;
    for (const want of INDEX_FILES) {
      const p = want === 'search-index.js' ? payloadPath : path.join(abs, want);
      if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
        missing = true;
        ctx.fail(shown(p), 'is missing or empty — the post-build passes write it (site/package.json postbuild)');
      }
    }
    if (missing) return '';

    const payload = parsePayload(fs.readFileSync(payloadPath, 'utf8'));
    if (payload === null) {
      ctx.fail(payloadAt, 'is not one `window.kb = {…};` assignment with a pages list — tools/src/site/gen-search-index.ts writes that shape');
      return '';
    }
    const structure = readStructure(ctx.root);
    const indexed = new Set(payload.pages.map((p) => p.route));
    const built = new Set(pages.map((p) => `/${path.relative(abs, p).split(path.sep).join('/')}`));
    for (const route of built) {
      if (!isHubRoute(structure, route) && !indexed.has(route)) {
        ctx.fail(shown(path.join(abs, route)), 'is a built page search cannot find — it is not in search-index.js');
      }
    }
    for (const page of payload.pages) {
      if (!built.has(page.route)) {
        ctx.fail(payloadAt, `indexes ${page.route}, and no such page was built`);
        continue;
      }
      // The page's real anchors, built once: an id a code sample shows, or a
      // `data-id` a diagram carries, is no place a link can land.
      const { anchors } = readLinks(fs.readFileSync(path.join(abs, page.route), 'utf8'));
      for (const h of page.headings) {
        if (h.id !== '' && !anchors.has(h.id)) {
          ctx.fail(payloadAt, `offers ${page.route}#${h.id}, and that page has no element with that id`);
        }
      }
    }

    // Importing the pass for its route helper runs nothing: its `main` call
    // only fires when the file is the program being run.
    const expected = new Set<string>();
    for (const row of placedPages(structure)) {
      if (!fromPageTree(row) || !built.has(row.route)) continue;
      const md = markdownRoute(row.route);
      expected.add(md);
      const at = path.join(abs, md);
      const source = path.join(ctx.root, row.source);
      if (!fs.existsSync(source)) {
        ctx.fail(shown(path.join(abs, row.route)), `its source ${row.source} is not in the repository`);
      } else if (!fs.existsSync(at)) {
        ctx.fail(shown(at), `is missing — the page's "View source" link opens it; site-portable copies ${row.source} there`);
      } else if (!fs.readFileSync(at).equals(fs.readFileSync(source))) {
        ctx.fail(shown(at), `differs from ${row.source} — run make site-build`);
      }
    }
    for (const file of markdownFiles(abs)) {
      if (!expected.has(`/${path.relative(abs, file).split(path.sep).join('/')}`)) {
        ctx.fail(shown(file), 'is a markdown file no page-tree page owns — only a page-tree page ships its source');
      }
    }

    // A tree with no content model holds no knowledge base: check 8 has nothing to hold the files to.
    const { contract, findings: refused } = readContract(ctx.root);
    for (const f of refused) ctx.fail(f.file, f.what);
    if (contract !== null) checkContract(ctx, contract, { dist: abs, shown, discovery, markdown: expected });
    const machine =
      contract === null
        ? ''
        : `; ${contract.pages.length} records, graph.json, llms.txt, llms-full.txt and ${contract.schemas.length} schemas match the knowledge base`;

    return `[site-portable] ${pages.length} pages portable, indexed, anchored and keyboard-reachable; ${INDEX_FILES.join(' and ')} present; ${expected.size} markdown sources match docs/${machine}`;
  },
};

main(spec, import.meta.url);
