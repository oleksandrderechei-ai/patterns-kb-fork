/**
 * The post-build pass that makes site/dist open from a local folder, and writes
 * the page-data layer every machine reader works from (spec kb.site.offline,
 * link-pass; kb.pagedata.blocks; kb.pagedata.manifest).
 *
 * Runs as `postbuild` in site/package.json, so `npm run build` never produces a
 * site that only works from a server. Runnable on its own:
 *
 *     node_modules/.bin/tsx tools/src/site/site-portable.ts --dist site/dist
 *
 * What it does to each built page, in order:
 *   * code out of the page text: Starlight's inline classic scripts become
 *     shared files;
 *   * links: every root-absolute `href` and `src` becomes relative to the
 *     page's depth, and an extensionless last segment gets `.html` back, since a
 *     browser reading from disk resolves no directory index (offline-C2);
 *   * section facts: each `<!--meta k=v-->` under a heading becomes a class-free
 *     `<section data-k="v">` spanning that heading to the next of equal or
 *     higher rank, and no comment survives (spec kb.pagedata.blocks);
 *   * the article block: the knowledge region's only child, carrying the
 *     page's route, area and tags — read from the `kb:*` meta Head.astro
 *     emitted — and nothing else; the body carries none of them;
 *   * chrome shielded: Starlight's skip link, header, sidebar, rails and footer
 *     get the skip marker `data-kb-skip`;
 *   * the next-steps list, when every item is one link and its reason, becomes
 *     one labelled nav of cards inside the article;
 *   * the not-found page (`404.html`) reduced to a document that links no file of
 *     the site, with its own small style (site-not-found.ts);
 *   * absolute URLs under the published root: the canonical link and `og:url`
 *     name the page where it is served, project path included (publicRoot).
 * Then it copies each page-tree page's markdown source beside the built page
 * (`/a/b.html` gets `/a/b.md`, the file its "View source" link opens, and its
 * manifest entry names it), deletes any other `.md`, writes the manifest,
 * `index.json`, moves the sitemap's URLs under the published root too, and
 * deletes the script chunks no page loads. The markdown adds roughly the size
 * of docs/ to dist.
 *
 * The machine files of the retrieval contract come with it (site-records.ts):
 * for each page of the knowledge base a record beside the built page
 * (`/a/b.html` gets `/a/b.json`), `graph.json`, the schemas under `schema/`,
 * `llms.txt` and `llms-full.txt`, and the manifest entry of every page gains
 * `id`, `kind`, `band`, `group` and `record`, null on a page outside the
 * knowledge base. They are the bytes `kb.mjs` prints for the same page. A tree
 * with no content model holds no knowledge base, so none of those files is
 * written there.
 *
 * It reads every page and checks its `kb:area` and `kb:owner` meta, builds every
 * record and checks that every page of the knowledge base has built HTML,
 * before it writes anything (offline-C4): a half-transformed site is worse than
 * none. A second run changes no byte.
 *
 * No dependencies: the edits are attribute-level and a scan does them honestly.
 * The site tree carries HTML parsers as Astro's dependencies, and reaching into
 * another package's dependencies breaks on someone else's upgrade.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  attrValue,
  comments,
  elements,
  jsonLdBlocks,
  knowledgeRegion,
  metaContent,
  metaContents,
  parseAttrs,
  REGION,
  regions,
  stripTags,
  tags,
  VOID,
  type Span,
} from '../lib/built-page.js';
import { CONTRACTS, SCHEMA_BASES, schemaUrl } from '../contract/contract.js';
import { main, type GateContext, type GateSpec } from '../lib/gate.js';
import { fromPageTree, placedPages, type Structure } from '../lib/site-routes.js';
import { publicRoot, readStructure, toPublic } from './site-output.js';
import { NOT_FOUND_ROUTE, standaloneNotFound } from './site-not-found.js';
import { indexFieldsOf, readContract, writeContract } from './site-records.js';

/** The page facts every built page must carry in its head (offline-C4). */
export const REQUIRED_META = ['kb:area', 'kb:owner'];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Run `fn` over the markup, skipping the *contents* of script and style
 * elements — JavaScript that happens to contain the text `href=` is not a link.
 * Their opening tags are not skipped: `<script src="/_astro/…">` is exactly the
 * kind of reference that has to become relative.
 */
export function outsideCode(html: string, fn: (chunk: string) => string): string {
  const re = /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi;
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    parts.push(fn(html.slice(last, m.index)), fn(m[1] as string), m[3] as string, m[4] as string);
    last = m.index + m[0].length;
  }
  parts.push(fn(html.slice(last)));
  return parts.join('');
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** One link, made openable from disk. `prefix` is the page's way back to dist. */
export function portableUrl(value: string, prefix: string): string {
  if (!value || EXTERNAL.test(value)) return value;

  let url = value;
  if (url.startsWith('/')) url = prefix + url.slice(1);

  // Always matches: every part is optional, and the fragment runs to the end.
  const m = /^([^?#]*)(\?[^#]*)?(#[^]*)?$/.exec(url) as RegExpExecArray;
  let pathPart = m[1] as string;
  const query = m[2] ?? '';
  const frag = m[3] ?? '';
  if (pathPart === '') return url;

  // A directory URL resolves to index.html over HTTP and to nothing on disk.
  const trailingSlash = pathPart.endsWith('/');
  const bare = trailingSlash ? pathPart.slice(0, -1) : pathPart;
  const last = bare.split('/').pop() as string;

  if (last === '' || last === '.' || last === '..') {
    pathPart = `${bare}/index.html`;
  } else if (!last.includes('.')) {
    pathPart = `${bare}.html`;
  }
  return pathPart + query + frag;
}

// ---------------------------------------------------------------------------
// 1 + 2. depth-relative links, and .html back on the extensionless ones
// ---------------------------------------------------------------------------
/** One attribute of a start tag, bare or with a value, so a scan never starts inside a value. */
const TAG_ATTR = /(\s)([^\s"'>/=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/** An attribute naming a link: `href`, `src`, or a namespaced `xlink:href`. */
const isLinkAttr = (name: string): boolean => /^(?:href|src)$/i.test(name) || /:href$/i.test(name);

/**
 * Every link attribute of every start tag, made portable. Only real attributes
 * are touched: a code sample's copy button holds its source in a data-code
 * value, and an `href="/…"` written there is the sample's text, which must
 * reach the clipboard as written.
 */
export function rewriteLinks(html: string, prefix: string): string {
  const out: string[] = [];
  let last = 0;
  for (const t of tags(html)) {
    if (t.closing || !/(?:href|src)\s*=/i.test(t.source)) continue;
    const text = html.slice(t.start, t.end);
    const rewritten = text.replace(TAG_ATTR, (all: string, space: string, name: string, eq: string | undefined, value: string | undefined) => {
      if (eq === undefined || value === undefined || !isLinkAttr(name)) return all;
      const quoted = value.startsWith('"') || value.startsWith("'");
      const inner = quoted ? value.slice(1, -1) : value;
      const q = quoted ? (value[0] as string) : '';
      return `${space}${name}${eq}${q}${portableUrl(inner, prefix)}${q}`;
    });
    if (rewritten === text) continue;
    out.push(html.slice(last, t.start), rewritten);
    last = t.end;
  }
  out.push(html.slice(last));
  return out.join('');
}

// ---------------------------------------------------------------------------
// 2b. absolute URLs under the published root
// ---------------------------------------------------------------------------
/**
 * The canonical link and `og:url` of a page, moved under the published root
 * (site-output.ts, toPublic). Found by the attributes the element has; any
 * other absolute URL is a link out and is left alone.
 */
export function publicUrls(html: string, root: URL): string {
  let out = '';
  let last = 0;
  for (const t of tags(html)) {
    if (t.closing || (t.name !== 'link' && t.name !== 'meta')) continue;
    const attrs = parseAttrs(t.source);
    const key =
      t.name === 'link' && attrValue(attrs, 'rel') === 'canonical'
        ? 'href'
        : t.name === 'meta' && attrValue(attrs, 'property') === 'og:url'
          ? 'content'
          : null;
    const value = key === null ? undefined : attrValue(attrs, key);
    if (key === null || value === undefined || toPublic(value, root) === value) continue;
    const tag = html.slice(t.start, t.end);
    out += html.slice(last, t.start) + tag.replace(value, toPublic(value, root));
    last = t.end;
  }
  return out + html.slice(last);
}

/**
 * A sitemap's `<loc>` URLs, moved under the published root and named as the
 * files they are. The sitemap integration writes each page's path without its
 * extension (`…/capabilities/compute`), but every route here is a file
 * (build.format 'file'), so a URL on this origin whose last part has no
 * extension gains `.html`; the root and a folder (a trailing `/`) stay.
 */
export function publicSitemap(xml: string, root: URL): string {
  const origin = `${root.origin}/`;
  const asFile = (url: string): string => {
    if (!url.startsWith(origin) || url.endsWith('/')) return url;
    const last = url.slice(url.lastIndexOf('/') + 1);
    return last.includes('.') ? url : `${url}.html`;
  };
  return xml.replace(/<loc>([^<]*)<\/loc>/g, (_all: string, url: string) => `<loc>${toPublic(asFile(url), root)}</loc>`);
}

// ---------------------------------------------------------------------------
// 3. section metadata: <!--meta k=v--> after a heading → data-k on a wrapper
// ---------------------------------------------------------------------------
/**
 * Starlight wraps every heading in <div class="sl-heading-wrapper"> together
 * with its anchor link. A section boundary has to fall outside that wrapper —
 * slicing between the div and the h2 leaves the div opened in one section and
 * closed in the next, which is the sort of malformed nesting a browser will
 * "fix" into something nobody meant.
 */
const HEADING_WRAPPER = /<div\b[^>]*class="[^"]*\bsl-heading-wrapper\b[^"]*"[^>]*>\s*$/;

function wrapperStart(html: string, headingIndex: number): number {
  const before = html.slice(Math.max(0, headingIndex - 400), headingIndex);
  const m = HEADING_WRAPPER.exec(before);
  return m === null ? headingIndex : headingIndex - (before.length - m.index);
}

const attrEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export function dataAttrs(spec: string): string[] {
  const re = /([A-Za-z_][A-Za-z0-9_:-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(spec)) !== null) {
    const key = (m[1] as string).replace(/^data-/i, '').toLowerCase();
    const value = (m[2] ?? m[3] ?? m[4]) as string;
    out.push(`data-${key}="${attrEscape(value)}"`);
  }
  return out;
}

/** A section fact's comment body: `meta` then its pairs. */
const META_BODY = /^\s*meta\s+([\s\S]*?)\s*$/;

/** A section fact comment the scan found: where it is, and its pairs. */
interface MetaComment {
  readonly index: number;
  readonly length: number;
  readonly pairs: string;
}

/**
 * The first REAL meta comment inside [rs, re_) — one in the markup, never one
 * inside a tag. Expressive Code's copy button carries a sample's raw code in a
 * data-code="…" attribute, so a sample DEMONSTRATING the comment puts a
 * literal <!--meta …--> inside an attribute value; the page scan
 * (lib/built-page.ts) reads that value as part of its tag, so it is no
 * comment here.
 */
export function findMetaComment(html: string, rs: number, re_: number): MetaComment | null {
  for (const c of comments(html.slice(rs, re_))) {
    const m = META_BODY.exec(c.text);
    if (m !== null && /-->$/.test(html.slice(rs + c.start, rs + c.end))) {
      return { index: rs + c.start, length: c.end - c.start, pairs: m[1] as string };
    }
  }
  return null;
}

/** The headings among a stretch's tags: start and end tags, with their offsets. */
function headingTags(html: string, from: number, to: number): { level: number; closing: boolean; index: number }[] {
  const out: { level: number; closing: boolean; index: number }[] = [];
  for (const t of tags(html.slice(from, to))) {
    const m = /^h([1-6])$/.exec(t.name);
    if (m !== null) out.push({ level: Number(m[1]), closing: t.closing, index: from + t.start });
  }
  return out;
}

/** One problem the passes met on one page, reported as `<file>: <what>`. */
export interface PageError {
  readonly route: string;
  readonly what: string;
}

/**
 * Where a group of a sided block ends: just after its last list, when
 * something that is no list follows it (dialect X-06). In the markdown a
 * trailing paragraph under a block's last group — the smell note after "Avoid
 * when" — sits inside that group's section, but only list items are a group's
 * members, and the paragraph is about the whole block. So the group's section
 * closes after its list, and the paragraph stands after both columns, inside
 * the block. Returns `end` unchanged when the group ends in its list, holds no
 * list at the top of its own content, or is followed by comments alone.
 */
export function groupEnd(html: string, from: number, end: number): number {
  let depth = 0;
  let lastList = -1;
  for (const t of tags(html.slice(from, end))) {
    if (VOID.has(t.name) || t.selfClosing) continue;
    if (!t.closing) {
      depth += 1;
      continue;
    }
    // A close with nothing open here is the end of the heading's own wrapper.
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0 && (t.name === 'ul' || t.name === 'ol')) lastList = from + t.end;
  }
  if (lastList < 0) return end;
  const rest = html.slice(lastList, end).replace(/<!--[\s\S]*?-->/g, '');
  return rest.trim() === '' ? end : lastList;
}

/**
 * Each `<!--meta k=v-->` in the knowledge region, turned into the section
 * data block it states (blocks-C4 to C8). The section starts at the heading
 * above the comment, wrapper included, and ends before the next heading of
 * equal or higher rank, or at the region end — or, for a group of a sided
 * block (a `polarity` fact), after its last list when prose follows it
 * (`groupEnd`, dialect X-06). A comment with no heading above it, or one
 * sitting inside that heading (before the heading has closed), has no section
 * to govern: it is a finding, it is dropped, and nothing is wrapped — the pass
 * never guesses a scope.
 */
export function sectionMeta(html: string, route: string, errors: PageError[]): string {
  for (let guard = 0; guard < 200; guard += 1) {
    const region = knowledgeRegion(html);
    if (!region) return html;
    const [rs, re_] = region;
    const found = findMetaComment(html, rs, re_);
    if (!found) return html;

    const at = found.index;
    const drop = (what: string): string => {
      errors.push({ route, what });
      return html.slice(0, at) + html.slice(at + found.length);
    };

    // The heading it annotates is the last one opened before it — a real
    // heading tag, never one a code sample's copy button holds in a value.
    const before = headingTags(html, rs, at);
    const opens = before.filter((h) => !h.closing);
    const head = opens[opens.length - 1];
    if (head === undefined) {
      html = drop('a <!--meta--> section fact with no heading above it — it goes on the line after a heading; dropped');
      continue;
    }
    if (!before.some((h) => h.closing && h.level === head.level && h.index > head.index)) {
      html = drop(`a <!--meta--> section fact inside its heading, whose section would start after it — it goes on the line after the heading; dropped`);
      continue;
    }
    const attrs = dataAttrs(found.pairs);
    // The heading sits before the comment and its wrapper before the heading,
    // so the section always opens before the comment it replaces.
    const start = wrapperStart(html, head.index);

    // The section runs to the next heading of the same rank or higher.
    const next = headingTags(html, at + found.length, re_).find((h) => !h.closing && h.level <= head.level);
    const headingEnd = next === undefined ? re_ : wrapperStart(html, next.index);
    const end = /\bpolarity\s*=/.test(found.pairs) ? groupEnd(html, at + found.length, headingEnd) : headingEnd;

    // Excise the comment by position, not by pattern — a pattern replace on
    // `inner` could hit a data-code attribute copy sitting earlier in it.
    const inner = html.slice(start, at) + html.slice(at + found.length, end);
    html = `${html.slice(0, start)}<section ${attrs.join(' ')}>${inner}</section>${html.slice(end)}`;
  }
  errors.push({ route, what: 'more than 200 <!--meta--> comments — giving up' });
  return html;
}

// ---------------------------------------------------------------------------
// 3b. the article data block: the page's facts on the knowledge they govern
// ---------------------------------------------------------------------------
/**
 * Wraps the rendered markdown body in `<article data-page …
 * data-area … data-tags …>` — the page's outermost data block. The wrapper
 * carries only bare data-* attributes and no class, which is how a machine
 * reader tells a data block from decoration (.claude/rules/page-schema.md):
 * the classed div around it is paint, the article is facts. The values come
 * from the kb:* meta tags, so `site/src/lib/page-meta.ts` stays the single
 * source and nothing here can drift from `index.json`.
 *
 * MUST run after sectionMeta: a <!--meta--> section can close at the region
 * end, and wrapping first would leave its </section> outside </article> —
 * interleaved tags a browser "fixes" into something nobody meant. Safe to run
 * twice: a previous stamp is unwrapped before re-stamping.
 */
export function wrapArticle(
  html: string,
  route: string,
  facts: { area: string; tags: string },
  errors: PageError[],
): string {
  const region = knowledgeRegion(html);
  if (!region) {
    errors.push({ route, what: `no knowledge region: no one element carries ${REGION} to wrap in the article block` });
    return html;
  }
  const [rs, re_] = region;
  let inner = html.slice(rs, re_);
  if (/^\s*<article\b[^>]*\bdata-page=/.test(inner)) {
    inner = inner.replace(/^\s*<article\b[^>]*>/, '').replace(/<\/article>\s*$/, '');
  }
  const attrs =
    `data-page="${attrEscape(route)}" data-area="${attrEscape(facts.area)}" data-tags="${attrEscape(facts.tags)}"`;
  return `${html.slice(0, rs)}<article ${attrs}>${inner}</article>${html.slice(re_)}`;
}

// ---------------------------------------------------------------------------
// 4b. code out of the page text: the inline classics become files
// ---------------------------------------------------------------------------
/**
 * Starlight spells one classic script into the markup of every page: the
 * theme pre-paint snippet in <head>. (Its sidebar state and scroll-restore
 * pair belong to the state persister, which the Sidebar override does not
 * render.) It cannot be a module (a module never runs from `file://`, and it
 * must run before paint), but nothing says it has to be *inline*: a classic
 * external script executes synchronously at the same position, on both
 * protocols — only modules are CORS-blocked on disk. It is byte-identical
 * across every page and uses no `document.currentScript`, so it becomes one
 * shared, cached file and the page text stops carrying code
 * (.claude/rules/page-schema.md). The only inline script left after this
 * pass is the JSON-LD, which is data.
 *
 * Matched on the normalised body's opening tokens, like the gate's
 * fingerprints: an unrecognised snippet — a Starlight upgrade's new one — is
 * left inline for `check-site-absence` to report, never externalised blind.
 */
export interface Externalizable {
  readonly id: string;
  /** Basename of the emitted chunk; the content hash is appended. */
  readonly file: string;
  readonly match: RegExp;
}

export const EXTERNALIZABLE_SCRIPTS: readonly Externalizable[] = [
  {
    // This site's, not upstream's: site/src/components/ThemeProvider overrides
    // Starlight's to drop the dead <template id="theme-icons">, and with the
    // template goes window.StarlightThemeProvider, whose only caller is the
    // ThemeSelect this site also overrides. The storage read is
    // this site's too, so the match is the opening that no other script has.
    id: 'starlight theme pre-paint',
    file: 'sl-theme',
    match: /^\(\(\) => \{ const storedTheme = /,
  },
];

const normalizeScript = (body: string): string => body.trim().replace(/\s+/g, ' ');

/**
 * Replace each recognised inline classic with `<script src="/_astro/…">`,
 * asking `alloc` for the filename. Runs before the link rewrite, so the
 * root-absolute src it writes becomes depth-relative like every other asset.
 * Attributes on the original tag (`aria-hidden`) are kept.
 */
export function externalizeInlineScripts(
  html: string,
  alloc: (spec: Externalizable, body: string) => string,
): string {
  return html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
    (all: string, attrs: string, body: string) => {
      if (/\b(?:src|type)=/i.test(attrs)) return all;
      const known = EXTERNALIZABLE_SCRIPTS.find((s) => s.match.test(normalizeScript(body)));
      if (!known) return all;
      return `<script${attrs} src="/_astro/${alloc(known, body)}"></script>`;
    },
  );
}

// ---------------------------------------------------------------------------
// 5. shield the chrome Starlight owns
// ---------------------------------------------------------------------------
/**
 * `data-kb-skip` marks a subtree that carries no knowledge — navigation, the
 * header, the reading-position rails. A machine reader drops it in one pass
 * (.claude/rules/page-schema.md).
 *
 * Components authored here carry the attribute in their own markup. These four are
 * Starlight's, and overriding a whole page frame to add one attribute would be
 * a fork; stamping the built HTML is the smaller, honest move.
 *
 * Matched on the opening tag by the class Starlight gives it. Those classes are
 * upstream's to change, which is exactly why `check-site-absence` asserts every
 * one of these landed: a Starlight upgrade that renames one turns into a red
 * gate, not into chrome quietly leaking back into what a reader reads.
 */
export interface Shield {
  readonly id: string;
  readonly why: string;
  readonly match: RegExp;
}

export const STARLIGHT_CHROME: readonly Shield[] = [
  {
    id: 'skip link',
    why: 'a jump affordance for keyboard users; says nothing about the page',
    match: /<a\b(?=[^>]*\bclass="[^"]*\bsl-skip-link\b)/i,
  },
  {
    id: 'site header',
    why: 'title, social links, theme control — the same on all 18 pages',
    match: /<header\b(?=[^>]*\bclass="header[\s"])/i,
  },
  {
    id: 'main sidebar',
    why: 'the site nav: every route already reachable from index.json',
    match: /<nav\b(?=[^>]*\bclass="sidebar[\s"])/i,
  },
  {
    id: 'reading rails',
    why: 'both tables of contents — a second copy of the headings below them',
    match: /<aside\b(?=[^>]*\bclass="right-sidebar-container[\s"])/i,
  },
  {
    id: 'page footer',
    why: 'the journey links; where to go next is not what this page knows',
    match: /<footer\b(?=[^>]*\bclass="sl-flex[\s"])/i,
  },
];

/**
 * Stamps every landmark above that this page has, recording which ones matched.
 *
 * A landmark missing from a page is normal — the splash and the 404 have no
 * sidebar and no table of contents — so nothing is asserted here. Drift is
 * caught downstream and better: `check-site-absence` reports any `<nav>`,
 * `<header>`, `<footer>` or `<aside>` outside the article that no
 * `data-kb-skip` covers, whatever upstream decided to call it. A renamed class
 * turns into a red gate; so does a landmark nobody predicted.
 *
 * Idempotent: the attribute is only added where it is not already there, so the
 * pass is safe to run twice over the same dist.
 */
export function shieldChrome(html: string): string {
  let out = html;
  for (const chrome of STARLIGHT_CHROME) {
    const at = chrome.match.exec(out);
    if (!at) continue;
    const end = out.indexOf('>', at.index);
    if (out.slice(at.index, end).includes('data-kb-skip')) continue;
    out = `${out.slice(0, at.index + at[0].length)} data-kb-skip${out.slice(at.index + at[0].length)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5a. one next-steps card per page
// ---------------------------------------------------------------------------
/**
 * A page's `## Next steps` section is a sentence and a list of one link and
 * its reason each, which markdown renders as a bullet list: the same shape as
 * every list above it, so the one thing on the page that points elsewhere reads
 * as more of the argument. This pass turns the list into cards, one link per
 * item with its text and trailing reason, in one `<nav>` labelled by the
 * heading, and wraps heading, sentence and cards in `.kb-next-steps-block`,
 * which layout.css pushes to the foot of a short page (spec
 * kb.noise.post-build, next-steps-card; post-build-C8).
 *
 * The nav stays inside the article, classes only, with no fact and no skip
 * marker: the link is the author's, and a reader that dropped it would drop
 * what the page came to point at.
 *
 * The list is left as written unless every item is exactly one link plus
 * trailing text: an item opening with prose, holding a second link or a nested
 * list is prose with links in it. A page with no next-steps heading, or one
 * already merged, is unchanged, so a second run changes nothing.
 */
export function mergeNextSteps(html: string): string {
  const region = knowledgeRegion(html);
  if (!region || html.slice(region[0], region[1]).includes('<div class="kb-next-steps-block">')) return html;
  const heading = html.indexOf('<h2 id="next-steps"', region[0]);
  if (heading < 0 || heading > region[1]) return html;
  const listOpen = html.indexOf('<ul>', heading);
  const listClose = html.indexOf('</ul>', listOpen);
  if (listOpen < 0 || listClose < 0 || listClose > region[1]) return html;
  // The list must belong to this section: no heading between the two.
  if (/<h[1-6]\b/.test(html.slice(heading + 3, listOpen))) return html;

  const items = html
    .slice(listOpen + 4, listClose)
    .split('</li>')
    .slice(0, -1);
  const cards: string[] = [];
  for (const item of items) {
    const m = /^\s*<li>\s*<a\b([^>]*)>([\s\S]*?)<\/a>([\s\S]*)$/.exec(item);
    if (!m || /<(?:a|ul|ol)\b/.test(m[3] as string)) return html;
    // The trailing text crosses whole, its dash included, and a space keeps
    // the two apart: the card says every word the list item said.
    const title = (m[2] as string).trim();
    const desc = (m[3] as string).trim();
    const tail = desc === '' ? '' : ` <span class="kb-card-desc">${desc}</span>`;
    cards.push(`<a class="kb-card"${m[1] as string}><span class="kb-card-title">${title}</span>${tail}</a>`);
  }
  if (cards.length === 0) return html;

  const start = wrapperStart(html, heading);
  return (
    `${html.slice(0, start)}<div class="kb-next-steps-block">${html.slice(start, listOpen)}` +
    `<nav class="kb-next-steps kb-card-grid" aria-labelledby="next-steps">${cards.join('')}</nav></div>${html.slice(listClose + 5)}`
  );
}

// ---------------------------------------------------------------------------
// 5b. drop style attributes that declare nothing
// ---------------------------------------------------------------------------
/**
 * `style=""` and `style=";"` — attributes that bind no property and paint no
 * pixel. Mermaid emits 125 of them across the three diagram pages, on `<rect>`,
 * `<path>` and `<g>`.
 *
 * They are noise by the plainest reading of page-schema.md: a byte that is
 * neither knowledge nor picture. `check-site-absence` does not catch them —
 * `presentationalStyles` blanks `<svg>` subtrees on purpose, because a diagram's
 * inline attributes *are* the drawing — but "the picture, not the page" is an
 * argument for keeping declarations that draw something, and these draw nothing.
 * They also make every CSS-aware editor report the file as broken, since `;`
 * alone is not a declaration.
 *
 * Removing one cannot change rendering: an empty style attribute contributes no
 * declarations, and nothing in the site's CSS selects on a bare `[style]` —
 * expressive-code's selectors are all `[style^='--']`, which these never matched.
 *
 * Scanned tag by tag rather than over the whole page, so a doc page that writes
 * `style=""` in its prose keeps its words.
 */
export function dropEmptyStyles(html: string): string {
  return outsideCode(html, (chunk) =>
    chunk.replace(/<[a-zA-Z][\w:-]*(?:"[^"]*"|'[^']*'|[^>])*>/g, (tag) =>
      tag.replace(/\s+style=("[^"]*"|'[^']*')/gi, (all, quoted: string) =>
        quoted
          .slice(1, -1)
          .split(';')
          .some((d) => d.trim() !== '')
          ? all
          : '',
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// 5c. make what upstream renders reachable from a keyboard, and honest to ARIA
// ---------------------------------------------------------------------------
/**
 * A `<pre>` that scrolls sideways is a scroll container, and a scroll container
 * a keyboard reader cannot put focus on is content they cannot reach: arrow
 * keys scroll whatever has focus, and nothing inside a code block ever does.
 * `tabindex="0"` is the fix WCAG 2.1.1 asks for and the one axe names
 * (`scrollable-region-focusable`, serious, on twelve pages).
 *
 * Here rather than in a component, because the markup is expressive-code's:
 * every code block on the site comes out of Starlight's renderer, which this
 * repo does not own and cannot pass an attribute to. `data-language` is the
 * discriminator — it is on every `<pre>` expressive-code emits and on no
 * `<pre>` anything else writes — so a code sample that happens to *show* a
 * `<pre>` in its text is untouched, since that text is escaped by the time this
 * pass reads it.
 *
 * Idempotent: a tag that already has a `tabindex` is left alone.
 */
export function focusScrollableCode(html: string): string {
  return html.replace(/<pre(?=[\s>])((?:"[^"]*"|'[^']*'|[^>])*)>/g, (all, attrs: string) =>
    /\bdata-language=/.test(attrs) && !/\btabindex=/.test(attrs)
      ? `<pre${attrs} tabindex="0">`
      : all,
  );
}

/** The open tag of a scroll wrapper that ends where a table begins. */
const WRAPPER_OPEN = /<div\b((?:"[^"]*"|'[^']*'|[^>"'])*)>\s*$/;

/**
 * Every table in the knowledge region sits in one scroll wrapper, and the
 * wrapper, not the table, is the focusable scroll region. A table wider than
 * the column then scrolls inside a box with an edge fade the stylesheet draws
 * (`.kb-wide` in primitives.css), and a keyboard reader can scroll it
 * (axe `scrollable-region-focusable`, WCAG 2.1.1).
 *
 * A bare table is wrapped in `<div class="kb-wide" role="region" tabindex="0"
 * aria-label="<nearest heading> table">`. The label names the heading above the
 * table and counts a repeat (`… table 2`), so no two regions on a page share a
 * name. A table a component already wrapped in `.kb-wide` keeps its wrapper and
 * gains the same three attributes. A table keeps every attribute it has,
 * including a fact: the wrapper is a classed element, which a machine reader
 * reads through. A table outside the region is left alone. Idempotent.
 */
export function wrapScrollableTables(html: string): string {
  const region = knowledgeRegion(html);
  if (region === null) return html;
  const headingSpans = elements(html, (name) => /^h[2-4]$/.test(name));
  const found = elements(html, (name) => name === 'table')
    .filter((t) => t.start >= region[0] && t.end <= region[1])
    .sort((a, b) => a.start - b.start);
  // The name of each table, in document order: the heading above it, counted
  // when two tables share one.
  const used = new Map<string, number>();
  const labels = new Map<number, string>();
  for (const t of found) {
    const above = [...headingSpans].reverse().find((h) => h.end <= t.start);
    const base = above === undefined ? 'Table' : `${stripTags(html.slice(above.innerStart, above.innerEnd))} table`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    labels.set(t.start, n === 1 ? base : `${base} ${n}`);
  }
  let out = html;
  // Last table first, so an edit never moves the offsets of one still to do.
  for (const t of found.reverse()) {
    const before = out.slice(Math.max(region[0], t.start - 600), t.start);
    const open = WRAPPER_OPEN.exec(before);
    const name = attrEscape(labels.get(t.start) as string);
    const regionAttrs = ` role="region" tabindex="0" aria-label="${name}"`;
    const wrapper = open !== null && /\bclass="[^"]*\bkb-wide\b/.test(open[1] as string);
    if (!wrapper) {
      out = `${out.slice(0, t.start)}<div class="kb-wide"${regionAttrs}>${out.slice(t.start, t.end)}</div>${out.slice(t.end)}`;
    } else if (!/\btabindex=/.test((open as RegExpExecArray)[1] as string)) {
      const at = t.start - before.length + (open as RegExpExecArray).index + (open as RegExpExecArray)[0].lastIndexOf('>');
      out = `${out.slice(0, at)}${regionAttrs}${out.slice(at)}`;
    }
  }
  return out;
}

/**
 * The checkbox a markdown task list renders (`- [ ] …`) has no label, no name
 * and — being `disabled` — no way to be operated. axe reports it as a critical
 * `label` violation, and it is right: a form control with no accessible name is
 * a control a screen reader announces as "checkbox" and nothing else.
 *
 * Neither ARIA nor a `<label>` is the answer, because the control is not a
 * control. It is a printed tick box: the list item's own text says what it is
 * about, and the input contributes one bit — done, or not done.
 *
 *   * unchecked → `aria-hidden="true"`. It says nothing the text does not, and
 *     hiding it is safe because a disabled input is not focusable, so no
 *     keyboard position is lost.
 *   * checked → `role="img" aria-label="done"`. The bit is real there, and a
 *     labelled image is how a glyph that carries meaning is spelled.
 *
 * Idempotent, and scoped to the disabled inputs GFM writes: an interactive
 * checkbox on some future page is not this pass's business.
 */
export function labelTaskCheckboxes(html: string): string {
  return html.replace(/<input(?=[\s>])((?:"[^"]*"|'[^']*'|[^>])*)>/g, (all, attrs: string) => {
    if (!/\btype="checkbox"/.test(attrs) || !/\bdisabled\b/.test(attrs)) return all;
    if (/\baria-hidden=|\brole=/.test(attrs)) return all;
    return /\bchecked\b/.test(attrs)
      ? `<input${attrs} role="img" aria-label="done">`
      : `<input${attrs} aria-hidden="true">`;
  });
}

// ---------------------------------------------------------------------------
// 6. delete the chunks nothing loads
// ---------------------------------------------------------------------------
/**
 * Astro hoists a component's script from the **import graph**, not from what
 * renders, so a component that never appears on a page still gets a chunk in
 * `_astro/`. That is tens of kilobytes reachable from nothing. An override that
 * renders nothing can be removed at the source; a component that is not an
 * overridable slot cannot.
 *
 * So: keep what some page loads, plus whatever those chunks import, to a fixed
 * point. Deleting by reachability rather than by name means the next unused
 * upstream component needs no maintenance here, and `check-site-absence`
 * asserts the result independently.
 */
export function pruneOrphanChunks(dist: string, pages: string[]): string[] {
  const assets = path.join(dist, '_astro');
  let all: string[];
  try {
    all = readdirSync(assets).filter((f) => f.endsWith('.js'));
  } catch {
    return [];
  }

  const keep = new Set<string>();
  const queue: string[] = [];
  const push = (name: string): void => {
    if (all.includes(name) && !keep.has(name)) {
      keep.add(name);
      queue.push(name);
    }
  };

  for (const file of pages) {
    for (const m of readFileSync(file, 'utf8').matchAll(/_astro\/([A-Za-z0-9._-]+\.js)/g)) {
      push(m[1] as string);
    }
  }
  // A chunk's own imports count as referenced — both static and dynamic, since
  // a lazily imported chunk is loaded by a page just the same.
  while (queue.length > 0) {
    const body = readFileSync(path.join(assets, queue.pop() as string), 'utf8');
    for (const m of body.matchAll(/["'`][^"'`]*?\/([A-Za-z0-9._-]+\.js)["'`]/g))
      push(m[1] as string);
  }

  const orphans = all.filter((f) => !keep.has(f)).sort();
  for (const f of orphans) rmSync(path.join(assets, f));
  return orphans;
}

// ---------------------------------------------------------------------------
// headings, for index.json
// ---------------------------------------------------------------------------
export interface Heading {
  depth: number;
  id: string;
  text: string;
}

/** Each H2 to H4 in the region, in document order; one with no text is skipped (manifest-C1). */
export function headings(html: string, region: [number, number] | null): Heading[] {
  if (!region) return [];
  const body = html.slice(region[0], region[1]);
  const out: Heading[] = [];
  for (const h of elements(body, (name) => /^h[2-4]$/.test(name))) {
    const open = /^<h([2-4])((?:"[^"]*"|'[^']*'|[^>"'])*)>/i.exec(body.slice(h.start, h.innerStart)) as RegExpExecArray;
    const text = stripTags(body.slice(h.innerStart, h.innerEnd));
    if (text) out.push({ depth: Number(open[1]), id: attrValue(parseAttrs(open[2] as string), 'id') ?? '', text });
  }
  return out;
}

/** One page of the manifest (spec interfaces/manifest-and-search.md). */
export interface IndexEntry {
  route: string;
  title: string;
  description: string;
  area: string;
  owner: string;
  status: string;
  tags: string[];
  /** Added after the spec's field list (fields are added, never renamed): what search ranks by. */
  aliases: string[];
  solves: string[];
  /**
   * Added after the spec's field list, with `kind`, `band`, `group` and `record`: the page's id when it is a
   * page of the knowledge base, null on any other page. The five are always there (kb-index-1.json).
   */
  id: string | null;
  kind: string | null;
  band: string | null;
  group: string | null;
  /** The address of the page's record, `/a/b.json`; null on a page outside the knowledge base. */
  record: string | null;
  headings: Heading[];
  /** Added after the spec's field list: the route's markdown source, `/a/b.md`; absent on a page with none. */
  markdown?: string;
}

/** Home first, then by area in the structure file's order, then by route. */
export function manifestOrder(areaRank: (area: string) => number): (a: IndexEntry, b: IndexEntry) => number {
  const homeFirst = (p: IndexEntry): number => (p.route === '/index.html' ? 0 : 1);
  return (a, b) =>
    homeFirst(a) - homeFirst(b) || areaRank(a.area) - areaRank(b.area) || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0);
}

/** The markdown route beside a built page: `/a/b.html` → `/a/b.md`. */
export function markdownRoute(route: string): string {
  return `${route.slice(0, -'.html'.length)}.md`;
}

/** What `copySources` did. */
export interface SourcesCopied {
  /** The markdown routes written, one per page-tree page that is built. */
  readonly copied: string[];
  /** Built rows whose source file is not in the repository. */
  readonly missing: { route: string; source: string }[];
  /** Other `.md` files found under dist and deleted, as routes. */
  readonly pruned: string[];
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Copy each built page-tree page's source to `<route minus .html>.md` under
 * `dist`, byte for byte, so a page's "View source" link opens from a folder as
 * well as from a server. A row whose page a generator writes, or that the site
 * commits itself, has no file under docs/ and gets none. Any other `.md` under
 * `dist` is deleted, so the set of shipped sources is exactly the set the
 * structure names. Running it twice leaves the same tree.
 */
export function copySources(root: string, dist: string, structure: Structure): SourcesCopied {
  const copied: string[] = [];
  const missing: { route: string; source: string }[] = [];
  for (const row of placedPages(structure)) {
    if (!fromPageTree(row) || !existsSync(path.join(dist, row.route))) continue;
    const from = path.join(root, row.source);
    if (!existsSync(from)) {
      missing.push({ route: row.route, source: row.source });
      continue;
    }
    const md = markdownRoute(row.route);
    const to = path.join(dist, md);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
    copied.push(md);
  }
  const keep = new Set(copied);
  const pruned: string[] = [];
  for (const file of markdownFiles(dist)) {
    const route = `/${path.relative(dist, file).split(path.sep).join('/')}`;
    if (keep.has(route)) continue;
    rmSync(file);
    pruned.push(route);
  }
  return { copied, missing, pruned };
}

/** A page's facts, read from its head before any pass touches it (blocks-C2). */
interface PageRead {
  readonly file: string;
  readonly route: string;
  readonly html: string;
  readonly area: string;
  readonly owner: string;
  readonly status: string;
  readonly tags: string[];
  readonly aliases: string[];
  readonly solves: string[];
  readonly title: string;
  readonly description: string;
}

/**
 * Read one built page's head and check what the passes need from it: one
 * knowledge region, the required page facts, and at most one JSON-LD block
 * that parses. Every problem is a finding; the page is returned only when it
 * has none.
 */
export function readPage(file: string, route: string, html: string, report: (what: string) => void): PageRead | null {
  let ok = true;
  const problem = (what: string): void => {
    ok = false;
    report(what);
  };
  const found = regions(html);
  if (found.length === 0) {
    problem(`no knowledge region — no element carries ${REGION}; site/src/components/MarkdownContent writes it on the rendered body`);
  } else if (found.length > 1) {
    problem(`${found.length} elements carry ${REGION} — a page has one knowledge region`);
  } else if (!(found[0] as Span).closed) {
    problem(`the knowledge region (${REGION}) never closes`);
  }
  const missing = REQUIRED_META.filter((name) => !metaContent(html, name));
  if (missing.length > 0) {
    problem(`missing page facts: ${missing.join(', ')} — site/src/components/Head/Head.astro emits them from frontmatter`);
  }
  const blocks = jsonLdBlocks(html);
  let title = '';
  if (blocks.length > 1) problem(`${blocks.length} JSON-LD blocks — a page carries one`);
  else if (blocks.length === 1) {
    try {
      const headline = (JSON.parse(blocks[0] as string) as { headline?: unknown }).headline;
      title = typeof headline === 'string' ? headline : '';
    } catch {
      problem('the JSON-LD block is not valid JSON');
    }
  }
  if (!ok) return null;
  if (!title) {
    const t = elements(html, (name) => name === 'title')[0];
    title = t === undefined ? '' : stripTags(html.slice(t.innerStart, t.innerEnd));
  }
  return {
    file,
    route,
    html,
    area: metaContent(html, 'kb:area') as string,
    owner: metaContent(html, 'kb:owner') as string,
    status: metaContent(html, 'kb:status') || 'stable',
    tags: (metaContent(html, 'kb:tags') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    aliases: metaContents(html, 'kb:alias'),
    solves: metaContents(html, 'kb:solves'),
    title,
    description: metaContent(html, 'description') ?? '',
  };
}

export const spec: GateSpec = {
  name: 'site-pass',
  usage: 'usage: site-portable [--dist <dir>] [--quiet]',
  flags: ['--quiet'],
  options: ['--dist'],
  run(ctx: GateContext): string {
    // Against ctx.root, not the working folder, like the site gates: a relative
    // --dist means the same folder to all of them.
    const DIST = path.resolve(ctx.root, ctx.options.get('--dist') ?? path.join('site', 'dist'));
    const shown = path.relative(ctx.root, DIST) || '.';

    // ---- pass 1 — read everything, verify the page facts, refuse before
    //      writing anything. A half-transformed site is worse than none.
    let files: string[];
    try {
      files = htmlFiles(DIST);
    } catch {
      ctx.failLine(`no built site at ${shown} — build it first: make site-build`);
      return '';
    }
    if (files.length === 0) {
      ctx.failLine(`no .html files under ${shown} — build it first: make site-build`);
      return '';
    }

    const pages: PageRead[] = [];
    const built = new Set<string>();
    for (const file of files) {
      const route = `/${path.relative(DIST, file).split(path.sep).join('/')}`;
      built.add(route);
      const read = readPage(file, route, readFileSync(file, 'utf8'), (what) => ctx.fail(`${shown}${route}`, what));
      if (read !== null) pages.push(read);
    }

    // The retrieval contract's files are built here, in memory: a page of the
    // knowledge base that has no record, or no HTML to sit beside, refuses the
    // pass like a page with no facts does.
    const { contract, findings: refused } = readContract(ctx.root);
    for (const f of refused) ctx.fail(f.file, f.what);
    for (const page of contract?.pages ?? []) {
      if (!built.has(page.route)) {
        ctx.fail(`${shown}${page.route}`, `no HTML was built for this page of the knowledge base (${page.source}) — its record would sit beside nothing`);
      }
    }
    if (ctx.findings > 0) return '';

    // ---- pass 2 — transform, write, and index -----------------------------
    const errors: PageError[] = [];
    const index: IndexEntry[] = [];

    // One file per distinct externalised body, shared across every page that
    // carries it, content-hashed like Astro's own chunks.
    const assetsDir = path.join(DIST, '_astro');
    const chunkNames = new Map<string, string>();
    const allocChunk = (entry: Externalizable, body: string): string => {
      const norm = normalizeScript(body);
      let name = chunkNames.get(norm);
      if (!name) {
        name = `${entry.file}.${createHash('sha256').update(norm).digest('hex').slice(0, 8)}.js`;
        mkdirSync(assetsDir, { recursive: true });
        writeFileSync(path.join(assetsDir, name), `${body.trim()}\n`);
        chunkNames.set(norm, name);
      }
      return name;
    };

    const kbPages = new Map((contract?.pages ?? []).map((p) => [p.route, p]));
    const root = publicRoot();
    for (const page of pages) {
      const depth = page.route.split('/').length - 2;
      const prefix = depth === 0 ? './' : '../'.repeat(depth);

      // The not-found page is served at whatever address missed, so it links no
      // file of the site: it is reduced to a document with its own style first,
      // and the rest of the pass finds nothing relative left to rewrite in it.
      let source = page.html;
      if (page.route === NOT_FOUND_ROUTE) {
        try {
          source = standaloneNotFound(source, root);
        } catch (err) {
          errors.push({ route: page.route, what: (err as Error).message });
          continue;
        }
      }
      let html = externalizeInlineScripts(source, allocChunk);
      html = rewriteLinks(html, prefix);
      // Order is load-bearing: sectionMeta before wrapArticle, or a section
      // closing at the region end would interleave with </article>.
      html = sectionMeta(html, page.route, errors);
      html = wrapArticle(html, page.route, { area: page.area, tags: page.tags.join(',') }, errors);
      html = shieldChrome(html);
      html = mergeNextSteps(html);
      html = publicUrls(html, root);
      html = dropEmptyStyles(html);
      html = focusScrollableCode(html);
      html = wrapScrollableTables(html);
      html = labelTaskCheckboxes(html);
      // The facts live on the article block, never on <body>: body is classed,
      // which makes it decoration. Scrub any copy, so a re-run converges.
      html = html.replace(
        /<body\b([^>]*)>/i,
        (_all: string, rest: string) => `<body${rest.replace(/\s+data-(?:page|area|tags)(?:="[^"]*")?/gi, '')}>`,
      );
      writeFileSync(page.file, html);

      index.push({
        route: page.route,
        title: page.title,
        description: page.description,
        area: page.area,
        owner: page.owner,
        status: page.status,
        tags: page.tags,
        aliases: page.aliases,
        solves: page.solves,
        ...indexFieldsOf(kbPages.get(page.route)),
        headings: headings(html, knowledgeRegion(html)),
      });
    }

    if (errors.length > 0) {
      for (const e of errors) ctx.fail(`${shown}${e.route}`, e.what);
      return '';
    }

    const structure = readStructure(ctx.root);
    const sources = copySources(ctx.root, DIST, structure);
    for (const m of sources.missing) ctx.fail(`${shown}${m.route}`, `its source ${m.source} is not in the repository`);
    if (sources.missing.length > 0) return '';
    const shipped = new Set(sources.copied);
    for (const entry of index) {
      const md = markdownRoute(entry.route);
      if (shipped.has(md)) entry.markdown = md;
    }

    const areas = structure.areas.map((a) => a.id);
    const rank = (area: string): number => {
      const i = areas.indexOf(area);
      return i < 0 ? areas.length : i;
    };
    index.sort(manifestOrder(rank));

    if (contract !== null) writeContract(DIST, contract);

    // The manifest: every built page's route, title and facts, and its
    // heading outline — never its text. The pages are the text, and a copy
    // here would be a second thing to keep true (two-layers-C6).
    writeFileSync(
      path.join(DIST, 'index.json'),
      `${JSON.stringify(
        { $schema: schemaUrl(SCHEMA_BASES.index), contract: CONTRACTS.index, generator: 'tools/src/site/site-portable.ts', pages: index },
        null,
        2,
      )}\n`,
    );

    for (const name of readdirSync(DIST)) {
      if (!/^sitemap.*\.xml$/.test(name)) continue;
      const file = path.join(DIST, name);
      const xml = readFileSync(file, 'utf8');
      const moved = publicSitemap(xml, root);
      if (moved !== xml) writeFileSync(file, moved);
    }

    const orphans = pruneOrphanChunks(DIST, files);
    if (ctx.flags.has('--quiet')) return '';
    const pruned = orphans.length > 0 ? `; pruned ${orphans.length} unreferenced chunk(s)` : '';
    const md = `; copied ${sources.copied.length} markdown source(s)`;
    const machine =
      contract === null ? '' : `, ${contract.pages.length} record(s), graph.json, llms.txt, llms-full.txt and ${contract.schemas.length} schema(s)`;
    return `[${ctx.name}] ${index.length} page(s) made portable${md}; wrote index.json${machine}${pruned}`;
  },
};

main(spec, import.meta.url);
