// The structured view of a page, in one place.
//
// Two components render it and they must never disagree: Head.astro emits it
// as <meta> tags plus a JSON-LD block (what a crawler or a machine reader
// reads), and PageMeta.astro shows the same object to a person behind the
// header button. tools/src/site/site-portable.ts then reads those tags back out
// of the built HTML into the manifest — so this module is the authored source
// and the manifest is its machine-readable echo (spec kb.pagedata.head).
//
// The files beside a page, which Head.astro links as alternates, are answered
// here too, from the structure file the build is made from: a page of the page
// tree has its markdown beside it, and a page of the knowledge base has its
// record as well (tools/src/site/site-records.ts writes both, and the
// portability gate holds the head to them).
import fs from 'node:fs';
import path from 'node:path';

import structureFile from '../../../docs/data/site-structure.json';
import { placeOf, type PlaceKind } from '../../../tools/src/lib/kb-place';
import { fromPageTree, placedPages, type Structure } from '../../../tools/src/lib/site-routes';
import { lastModified } from './git-date';
import { repoRoot } from './repo-root';
import { routeOf } from './routes';
import type { Status } from './site-types';

/** What `pageMeta` reads off an entry. Astro types the real thing wider. */
export interface MetaEntry {
  filePath?: string | undefined;
  data: {
    title: string;
    description: string;
    area: string;
    owner: string;
    tags?: string[] | undefined;
    status?: Status | undefined;
    aliases?: string[] | undefined;
    solves?: string[] | undefined;
  };
}

export interface PageMetaValues {
  title: string;
  description: string;
  area: string;
  status: Status;
  owner: string;
  tags: string[];
  /** Other names the page answers to, and the symptoms it answers: what search ranks by. */
  aliases: string[];
  solves: string[];
  modified: string | null;
}

/** Everything downstream keys off, read from one entry's frontmatter. */
export function pageMeta(entry: MetaEntry): PageMetaValues {
  const data = entry.data;
  return {
    title: data.title,
    description: data.description,
    area: data.area,
    status: data.status ?? 'stable',
    owner: data.owner,
    tags: Array.isArray(data.tags) ? data.tags : [],
    aliases: Array.isArray(data.aliases) ? data.aliases : [],
    solves: Array.isArray(data.solves) ? data.solves : [],
    modified: lastModified(entry.filePath),
  };
}

/** The schema.org TechArticle for a page (spec interfaces/built-page.md, the JSON-LD block). */
export function jsonLd(meta: PageMetaValues): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: meta.title,
    description: meta.description,
    ...(meta.tags.length > 0 ? { keywords: meta.tags.join(', ') } : {}),
    isPartOf: { '@type': 'Collection', name: meta.area },
    ...(meta.owner ? { author: { '@type': 'Person', name: meta.owner } } : {}),
    ...(meta.modified ? { dateModified: meta.modified } : {}),
  };
}

/** The JSON-LD block's text: no `<`, so a closing tag in a value cannot end the block. */
export function jsonLdText(meta: PageMetaValues): string {
  return JSON.stringify(jsonLd(meta)).replace(/</g, '\\u003c');
}

const structure = structureFile as Structure;

/** The content model, repo-relative: the file whose presence means the tree holds a knowledge base. */
export const CONTENT_MODEL = 'docs/data/content-model.json';

/**
 * The kinds of the content model of the tree at `root`: a page whose markdown
 * sits in one of their folders is a page of the knowledge base. A tree with no
 * content model has none, so none of its pages is one, which is the answer
 * tools/src/site/site-records.ts gives for the same tree: it writes no record.
 */
export function readKinds(root: string): PlaceKind[] {
  const file = path.join(root, CONTENT_MODEL);
  return fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { kinds: PlaceKind[] }).kinds
    : [];
}

/** The kinds of the tree the build runs in, read once. */
let treeKinds: readonly PlaceKind[] | undefined;
const kindsHere = (): readonly PlaceKind[] => (treeKinds ??= readKinds(repoRoot()));

/** The files a built page has beside it, as addresses from the site root. */
export interface Alternates {
  /** The page's markdown source, `/a/b.md`; null on a page the page tree does not own: the home page, a hub, a generated page. */
  markdown: string | null;
  /** The page's record, `/a/b.json`; null on a page that is not a page of the knowledge base. */
  record: string | null;
}

/**
 * The files beside the page built from the content file `filePath`. Both are
 * its route with `.md` or `.json` in place of `.html`, and the answer is the
 * structure file's, never a guess from the route: only a row of the page tree
 * has a markdown source, and only one whose markdown sits in a kind's folder
 * under docs/ (`placeOf`) has a record. A path that names no page of the
 * structure has neither.
 */
export function alternatesOf(
  filePath: string | undefined | null,
  from: Structure = structure,
  kinds: readonly PlaceKind[] = kindsHere(),
): Alternates {
  const route = routeOf(filePath);
  const row = placedPages(from).find((p) => p.route === route);
  if (row === undefined) return { markdown: null, record: null };
  const sibling = (ext: string): string => row.route.replace(/\.html$/, ext);
  return {
    markdown: fromPageTree(row) ? sibling('.md') : null,
    record: placeOf(from, kinds, row) === null ? null : sibling('.json'),
  };
}

/** The `<link rel="alternate">` tags for those files, as type and address pairs: markdown first, then the record. */
export function alternateLinks(alternates: Alternates): [type: string, href: string][] {
  const links: [string, string][] = [];
  if (alternates.markdown !== null) links.push(['text/markdown', alternates.markdown]);
  if (alternates.record !== null) links.push(['application/json', alternates.record]);
  return links;
}

/**
 * The kb:* meta tags, as name/content pairs — emitted and displayed alike.
 * One element per alias and per `solves` phrase, never a joined list: a
 * phrase may hold a comma, and a tag never does. The search payload ranks by
 * both (tools/src/lib/search-score.ts), through the manifest.
 */
export function metaTags(meta: PageMetaValues): [string, string][] {
  return [
    ['kb:area', meta.area],
    ['kb:status', meta.status],
    ['kb:owner', meta.owner],
    ['kb:tags', meta.tags.join(',')],
    ...meta.aliases.map((a): [string, string] => ['kb:alias', a]),
    ...meta.solves.map((s): [string, string] => ['kb:solves', s]),
  ];
}
