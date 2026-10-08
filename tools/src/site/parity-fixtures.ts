/**
 * A built site small enough to read at a glance and whole enough for the parity
 * gate: the knowledge base fixture of the page record (`writeRecordFixture`), each
 * page as the files the site ships for it, in the shape the post-build passes
 * leave. Built from the repo's own code, so a clean copy agrees with itself by
 * construction and a test breaks one file to see the gate say which.
 *
 *   html     the page's markdown through the site's markdown plugins and the
 *            section pass (the part Astro runs, less the diagram renderer),
 *            Starlight's heading wrapper and slug put back, the article block
 *            with its facts, the prerequisite card, and every item of the
 *            relationships block stating the relation it shows
 *   json     the record `kb.mjs record` prints, beside the page
 *   md       the page's markdown, byte for byte
 *   index    `index.json` with an entry for each page, its head facts as the
 *            record has them
 *   graph    `graph.json` as `kb.mjs graph` prints it
 *
 * `writeParitySite` also writes the published schemas under tools/src/contract
 * and the content model, which the gate reads from the root it runs in: a tree
 * with no content model holds no knowledge base, and the gate has nothing to read.
 *
 * Built once per process, in a sandbox of its own, and written from memory into
 * as many sandboxes as the tests ask for.
 */

import fs from 'node:fs';
import path from 'node:path';

import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import { SCHEMA_DIR } from '../contract/contract.js';
import { DATA } from '../kb/corpus.js';
import { stripFrontmatter } from '../kb/page.js';
import type { PageRecord } from '../kb/record.js';
import { writeRecordFixture } from '../lib/fixtures.js';
import { makeSandbox, type Sandbox } from '../lib/sandbox.js';
import { rehypeKbTables, remarkKbSite } from '../lib/site-markdown.js';
import { sectionMeta, type PageError } from './site-portable.js';
import { readContract } from './site-records.js';

/** The files of the fixture site by path under `dist`, and the files a gate reads from the repo root beside it. */
export interface ParitySite {
  readonly dist: ReadonlyMap<string, string>;
  /** The published schemas and the content model, by path from the repo root. */
  readonly repo: ReadonlyMap<string, string>;
  /** Each page's record, parsed, in the order of the index. */
  readonly records: readonly PageRecord[];
}

const renderer = unified().use(remarkParse).use(remarkGfm).use(remarkKbSite).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeKbTables).use(rehypeStringify, { allowDangerousHtml: true });

/** Starlight's wrapper and anchor around every heading, and the slug id it gives a heading that has none. */
function starlight(html: string): string {
  return html.replace(/<h([2-6])(?: id="([^"]*)")?>([\s\S]*?)<\/h\1>/g, (_all, level: string, id: string | undefined, inner: string) => {
    const words = inner.replace(/<[^>]*>/g, '');
    const slug = id ?? words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const anchor = `<a class="sl-anchor-link" href="#${slug}"><span aria-hidden="true" class="sl-anchor-icon"><svg width="16" height="16"><path d="M0 0"></path></svg></span><span class="sr-only" data-pagefind-ignore="">Section titled “${words}”</span></a>`;
    return `<div class="sl-heading-wrapper level-h${level}"><h${level} id="${slug}">${inner}</h${level}>${anchor}</div>`;
  });
}

/** Every item of the relationships block, in page order, stating the relation its row holds. */
function stateRelations(inner: string, relations: PageRecord['relations']): string {
  const at = inner.indexOf('<section data-block="relationships">');
  let n = 0;
  return `${inner.slice(0, at)}${inner.slice(at).replace(/<li>/g, () => {
    const row = relations[n] as PageRecord['relations'][number];
    n += 1;
    return `<li data-verb="${row.verb}" data-to="${row.to}">`;
  })}`;
}

const OPEN = '<div class="sl-markdown-content" data-kb-region>';

/** One page of the built site: the knowledge region as the post-build passes leave it, in the page's frame. */
function pageHtml(record: PageRecord, markdown: string): string {
  // A section the pass could not cut would leave its block out of the page, which every test over the fixture shows.
  const errors: PageError[] = [];
  const body = starlight(String(renderer.processSync(stripFrontmatter(markdown).replace(/^# .*\n/m, ''))));
  const region = sectionMeta(`${OPEN}${body}</div>`, record.route, errors);
  const inner = stateRelations(region.slice(OPEN.length, -'</div>'.length), record.relations);
  const { requires, related } = record.prerequisites;
  const card =
    requires.length + related.length === 0
      ? ''
      : `<div data-requires="${requires.join(',')}" data-related="${related.join(',')}"><aside class="kb-prereq not-content"><span class="kb-prereq-label">Read first</span></aside></div>`;
  const facts = [
    ['page', record.route],
    ['area', record.area],
    ['tags', record.tags.join(',')],
    ['kind', record.kind],
    ['band', record.band],
    ['group', record.group],
  ]
    .map(([key, value]) => `data-${key}="${value}"`)
    .join(' ');
  return [
    '<!doctype html>',
    '<html lang="en">',
    `<head><meta charset="utf-8"><title>${record.title}</title></head>`,
    '<body>',
    `<div data-page-head><h1 id="_top">${record.title}</h1></div>`,
    `${OPEN}<article ${facts}>${card}${inner}</article></div>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

let built: ParitySite | undefined;

/** The fixture site, built on first use. */
export function paritySite(): ParitySite {
  if (built !== undefined) return built;
  const sb = makeSandbox();
  try {
    writeRecordFixture(sb.dir);
    sb.copyRepo(SCHEMA_DIR);
    const { contract } = readContract(sb.dir);
    const files = contract as NonNullable<typeof contract>;
    const dist = new Map<string, string>();
    const records: PageRecord[] = [];
    const entries: Record<string, unknown>[] = [];
    for (const page of files.pages) {
      const record = JSON.parse(page.json) as PageRecord;
      const markdown = fs.readFileSync(path.join(sb.dir, page.source), 'utf8');
      records.push(record);
      dist.set(page.route.slice(1), pageHtml(record, markdown));
      dist.set(page.record.slice(1), page.json);
      dist.set(record.markdown.slice(1), markdown);
      entries.push({
        route: record.route,
        title: record.title,
        description: record.description,
        area: record.area,
        owner: record.owner,
        status: record.status,
        tags: record.tags,
        aliases: record.aliases,
        solves: record.solves,
        id: record.id,
        kind: record.kind,
        band: record.band,
        group: record.group,
        record: page.record,
        headings: [],
        markdown: record.markdown,
      });
    }
    dist.set('graph.json', files.graph);
    dist.set(
      'index.json',
      `${JSON.stringify({ $schema: 'https://odere-pro.github.io/patterns-kb/schema/kb-index-1.json', contract: 'kb-index/1', generator: 'tools/src/site/site-portable.ts', pages: entries }, null, 2)}\n`,
    );
    const repo = new Map<string, string>([[DATA.model, sb.read(DATA.model)]]);
    for (const s of files.schemas) repo.set(`${SCHEMA_DIR}/${s.name}`, s.bytes.toString('utf8'));
    built = { dist, repo, records };
    return built;
  } finally {
    sb.cleanup();
  }
}

/** Write the fixture site into a sandbox: the built files under `dist`, and the repo files a gate reads beside them. */
export function writeParitySite(sb: Sandbox, dist = 'site/dist'): void {
  const site = paritySite();
  for (const [file, text] of site.dist) sb.write(`${dist}/${file}`, text);
  for (const [file, text] of site.repo) sb.write(file, text);
}
