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
//
// A page of the knowledge base also says where it sits, in three more tags:
// its kind, its band and its group. The same structure row that gives it a
// record gives it those, so a page states its place exactly when it links its
// record, and the post-build pass copies them onto the article block, where a
// reader of the body alone finds them.
import fs from 'node:fs';
import path from 'node:path';

import structureFile from '../../../docs/data/site-structure.json';
import { placeOf, type PlaceKind } from '../../../tools/src/lib/kb-place';
import {
  fromPageTree,
  placedPages,
  type PlacedPage,
  type Structure,
} from '../../../tools/src/lib/site-routes';
import {
  AUTHOR_URL,
  CONTENT_LICENSE,
  SITE_NAME,
  SITE_OWNER,
  SOCIAL_IMAGE,
} from '../../../tools/src/site/site-output';
import { lastModified } from './git-date';
import { repoRoot } from './repo-root';
import { routeOf, type TrailStep } from './routes';
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

/** Where a page is published: what the JSON-LD's addresses are built from. */
export interface PageAt {
  /** The published root, ending in `/` (publicRoot() in tools/src/site/site-output.ts). */
  readonly root: string;
  /** The page's route, or null for an entry outside the collection. */
  readonly route: string | null;
  /** The page's language, as the html element declares it. */
  readonly lang: string;
  /** The trail the breadcrumbs show (crumbsOf in ./routes.ts), the page last. */
  readonly crumbs: readonly TrailStep[];
}

/** A route's address under the root. The home page is the root itself, as its canonical link is. */
export function pageUrl(root: string, route: string): string {
  return route === '/index.html' ? root : `${root}${route.slice(1)}`;
}

/** The person a page names as its owner, with the owner's own site when the owner is the project's. */
function person(owner: string): Record<string, unknown> {
  return { '@type': 'Person', name: owner, ...(owner === SITE_OWNER ? { url: AUTHOR_URL } : {}) };
}

/**
 * The page as a WebPage: the site it belongs to, and its trail as a
 * BreadcrumbList whose last item is the page itself.
 */
function webPage(url: string, at: PageAt): Record<string, unknown> {
  const items = at.crumbs.map((c, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: c.label,
    item: c.href === null ? url : pageUrl(at.root, c.href),
  }));
  return {
    '@type': 'WebPage',
    '@id': url,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: at.root },
    ...(items.length > 0
      ? { breadcrumb: { '@type': 'BreadcrumbList', itemListElement: items } }
      : {}),
  };
}

/**
 * The schema.org TechArticle for a page (spec interfaces/built-page.md, the
 * JSON-LD block). One block with the article on top: the page's facts first,
 * then, given where the page is published, its address, picture and licence,
 * and the WebPage that carries the site and the breadcrumb. Readers depend on
 * the top-level `headline`, `isPartOf` and `dateModified`, so those stay where
 * they are. Pure: the caller passes the root, so nothing here reads the env.
 */
export function jsonLd(meta: PageMetaValues, at?: PageAt): Record<string, unknown> {
  const url = at?.route ? pageUrl(at.root, at.route) : undefined;
  const owner = meta.owner ? person(meta.owner) : undefined;
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: meta.title,
    description: meta.description,
    ...(meta.aliases.length > 0 ? { alternateName: meta.aliases } : {}),
    ...(meta.tags.length > 0 ? { keywords: meta.tags.join(', ') } : {}),
    isPartOf: { '@type': 'Collection', name: meta.area },
    ...(owner ? { author: owner, publisher: owner } : {}),
    ...(meta.modified ? { dateModified: meta.modified } : {}),
    ...(at
      ? {
          inLanguage: at.lang,
          image: new URL(SOCIAL_IMAGE.path, at.root).href,
          license: CONTENT_LICENSE,
        }
      : {}),
    ...(at && url ? { url, mainEntityOfPage: webPage(url, at) } : {}),
  };
}

/** The JSON-LD block's text: no `<`, so a closing tag in a value cannot end the block. */
export function jsonLdText(meta: PageMetaValues, at?: PageAt): string {
  return JSON.stringify(jsonLd(meta, at)).replace(/</g, '\\u003c');
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

/** The row of the structure for the page built from the content file `filePath`; none for a path that names no page. */
function rowOf(filePath: string | undefined | null, from: Structure): PlacedPage | undefined {
  const route = routeOf(filePath);
  return placedPages(from).find((p) => p.route === route);
}

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
  const row = rowOf(filePath, from);
  if (row === undefined) return { markdown: null, record: null };
  const sibling = (ext: string): string => row.route.replace(/\.html$/, ext);
  return {
    markdown: fromPageTree(row) ? sibling('.md') : null,
    record: placeOf(from, kinds, row) === null ? null : sibling('.json'),
  };
}

/** Where a page of the knowledge base sits: the three facts its head states and its article block carries. */
export interface PagePlace {
  /** The page's kind, such as `pattern`: the folder its markdown sits in, under docs/. */
  kind: string;
  /** For a pattern, the area directly under the patterns root; for every other kind, the kind. */
  band: string;
  /** For a pattern, the area that lists it; for every other kind, the kind. */
  group: string;
}

/**
 * Where the page built from the content file `filePath` sits; null on a page
 * that is not a page of the knowledge base. It is `alternatesOf`'s question,
 * asked of the same row the same way, so a page states its place exactly when
 * it links its record, and says what the record says (`placeOf`, the one
 * reading of the structure that `kb.mjs` and the record builder share).
 */
export function placeOfFile(
  filePath: string | undefined | null,
  from: Structure = structure,
  kinds: readonly PlaceKind[] = kindsHere(),
): PagePlace | null {
  const row = rowOf(filePath, from);
  const place = row === undefined ? null : placeOf(from, kinds, row);
  return place === null ? null : { kind: place.kind, band: place.band, group: place.group };
}

/** The `<link rel="alternate">` tags for those files, as type and address pairs: markdown first, then the record. */
export function alternateLinks(alternates: Alternates): [type: string, href: string][] {
  const links: [string, string][] = [];
  if (alternates.markdown !== null) links.push(['text/markdown', alternates.markdown]);
  if (alternates.record !== null) links.push(['application/json', alternates.record]);
  return links;
}

/** A page's place as its three meta tags: kind, band, group. */
const placeTags = (place: PagePlace): [string, string][] => [
  ['kb:kind', place.kind],
  ['kb:band', place.band],
  ['kb:group', place.group],
];

/**
 * The kb:* meta tags, as name/content pairs — emitted and displayed alike.
 * One element per alias and per `solves` phrase, never a joined list: a
 * phrase may hold a comma, and a tag never does. The search payload ranks by
 * both (tools/src/lib/search-score.ts), through the manifest.
 *
 * A page of the knowledge base (`place` is its `placeOfFile`) adds its kind,
 * band and group after its tags, all three or none: the post-build pass copies
 * them onto the article block, and refuses a head that states some of them.
 */
export function metaTags(meta: PageMetaValues, place: PagePlace | null = null): [string, string][] {
  return [
    ['kb:area', meta.area],
    ['kb:status', meta.status],
    ['kb:owner', meta.owner],
    ['kb:tags', meta.tags.join(',')],
    ...(place === null ? [] : placeTags(place)),
    ...meta.aliases.map((a): [string, string] => ['kb:alias', a]),
    ...meta.solves.map((s): [string, string] => ['kb:solves', s]),
  ];
}
