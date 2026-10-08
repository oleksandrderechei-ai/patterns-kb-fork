/**
 * The absence gate: every built page keeps its facts apart from its paint, and
 * carries nothing a machine reader has to wade through (spec
 * kb.pagedata.two-layers; kb.noise.absence-gate). Two halves, one run:
 *
 *   - the data layer, in this file: the properties "Knowledge region",
 *     "Article block", "Facts on data blocks" and "Title block";
 *   - the noise, in tools/src/lib/site-noise.ts: the formatter's fixed point
 *     (asked through tools/src/site/site-format.ts on the raw bytes), one
 *     classic kb.js, no inline module, named scripts and stylesheets, no style
 *     element, the noscript style, no presentational style, no inline handler,
 *     every landmark outside the knowledge region skip-marked, and — over the
 *     whole site — no script file that nothing loads. One page, 404.html, is held
 *     to its own rule in place of the bundle, stylesheet and style-element ones:
 *     it loads no file of the site and carries one small style of its own. Anything its allowlists
 *     do not name fails, and so does an entry that matched nothing.
 *
 * THE LAYER RULE, which .claude/rules and this header restate (two-layers-C9).
 * A machine reader holds only the bytes and reads them in four steps:
 *
 *   1. drop every subtree carrying the skip marker `data-kb-skip`;
 *   2. an element with a `class` is decoration: read through it, never from it;
 *   3. a class-free element with a bare `data-*` that is neither a hook
 *      (`data-kb`, `data-kb-<name>`) nor on the vendor list below is a data
 *      block, and its attributes are facts about everything inside it;
 *   4. everything else is content.
 *
 * So the gate fails, naming the page:
 *   - a fact on a classed element, naming the attribute and the element
 *     (two-layers-C1);
 *   - a data block carrying anything but `data-*` and an `id`, naming the
 *     attribute (two-layers-C2);
 *   - a missing knowledge region (the element carrying the hook
 *     `data-kb-region`), a second one, or a skip marker inside it
 *     (two-layers-C3, blocks-C9);
 *   - a knowledge region with no class: it is the classed wrapper — paint —
 *     around the article block, never a data block itself (two-layers-C5);
 *   - a knowledge region that is not exactly one article block carrying
 *     `data-page`, `data-area` and `data-tags`, in that order and
 *     nothing else, or those three followed by `data-kind`, `data-band` and
 *     `data-group` (spec interfaces/built-page.md, the article block). The
 *     three that follow say where a page of the knowledge base sits, and a
 *     block carries all of them or none: a page's facts are never partly there;
 *   - on every page but the home page, no class-free `data-page-head` block
 *     holding the H1.
 *
 * THE FACTS OF A LIST ITEM. An item of a page's relationships block carries
 * `data-verb` and `data-to`, the relation of the page's record that it shows.
 * Like any bare `data-*` on a class-free element they are facts about the
 * item, and the layer rule is all this gate holds them to: the item stays
 * class-free, and carries nothing but data-* and an id. What the pair says is
 * the post-build pass's to prove (`stampRelations` in
 * tools/src/site/site-portable.ts refuses a block that shows other relations
 * than its record holds), not this gate's, which reads no name of a fact.
 *
 * A BLOCK FACT AND ITS HEADING'S ID. A section data block's `data-block`
 * names its block, and the block's heading carries the same name as its id,
 * so `#tradeoffs` links from before the migration still land (dialect D-72).
 * That is the one place a data block restates a heading's id, a recorded
 * exception to two-layers-C6 (decided in the migration): authors
 * write only the fact, and the markdown plugin gives the heading its id from
 * it (tools/src/lib/site-markdown.ts). No other fact restates a heading.
 *
 * It reads tags, never text: comments, script and style bodies, `<noscript>`,
 * code blocks and every vector graphic's insides are not markup here, and a
 * skip marker named in prose or in an attribute value shields nothing. The
 * code and script elements themselves are elements like any other — a class
 * and a fact on a `<pre>` is a finding — only what is inside them is not read.
 * A vector graphic is read not at all, its own attributes included: they are
 * the drawing's, not the page's.
 *
 * Usage: check-site-absence [--dist <dir>]   (default site/dist)
 */

import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'parse5';

import { REGION } from '../lib/built-page.js';
import { main, type GateContext, type GateSpec } from '../lib/gate.js';
import { LISTS, NOISE, NOT_FOUND_FILE, noiseFindings, siteFiles, Tally, unreachableScripts, unusedEntries, type NoiseLists } from '../lib/site-noise.js';
import { formatHtml, OFF_FIXED_POINT } from '../site/site-format.js';
import { DIST } from '../site/site-output.js';

/** The one project prefix (two-layers-C8): the skip marker and the hook form. */
export const SKIP = 'data-kb-skip';
export const HOOK = /^data-kb(?:-[a-z0-9-]+)?$/;

/** The article block's facts, in order: every page has these. */
export const ARTICLE_FACTS = ['data-page', 'data-area', 'data-tags'] as const;

/** Where a page of the knowledge base sits, after `ARTICLE_FACTS`: the block carries all three or none of them. */
export const PLACE_FACTS = ['data-kind', 'data-band', 'data-group'] as const;

/** The attribute names an article block may carry, in order: the three facts of any page, or those and the place. */
export const ARTICLE_SHAPES: readonly (readonly string[])[] = [ARTICLE_FACTS, [...ARTICLE_FACTS, ...PLACE_FACTS]];

/**
 * Bare `data-*` names the generator writes as its own state, never facts
 * (two-layers-C4). An unlisted bare `data-*` on a classed element fails until
 * it is listed here with the reason.
 */
export const VENDOR: readonly { readonly id: string; readonly reason: string; readonly match: RegExp }[] = [
  {
    id: 'starlight-frame-state',
    reason: "Starlight writes the theme and which rails the page has on <html>, and its own CSS lays the frame out by them",
    match: /^data-(?:theme|has-toc|has-sidebar|has-hero)$/,
  },
  {
    id: 'pagefind-hints',
    reason: 'Starlight marks what Pagefind should index; Pagefind is off here and nothing reads them',
    match: /^data-pagefind-(?:body|ignore|weight|meta|filter|sort)$/,
  },
  {
    id: 'expressive-code-copy',
    reason: "Expressive Code's copy button carries the code and its confirmation text for its own script",
    match: /^data-(?:code|copied)$/,
  },
  {
    id: 'expressive-code-language',
    reason: "Expressive Code marks each code frame's <pre> with the sample's language, which its own styles read; the fence's language is the markdown's fact, not this attribute",
    match: /^data-language$/,
  },
];

/** Elements whose insides are not markup to this gate: code, not knowledge. */
const OPAQUE = new Set(['script', 'style', 'noscript', 'template', 'pre', 'code', 'math']);

const SVG_NS = 'http://www.w3.org/2000/svg';

export const isVendor = (name: string): boolean => VENDOR.some((v) => v.match.test(name));

/** A bare `data-*` that is neither a hook nor a vendor name: a fact. */
export const isFact = (name: string): boolean => name.startsWith('data-') && !HOOK.test(name) && !isVendor(name);

/**
 * The parse5 node shape this gate reads, described locally. An element always
 * carries `attrs` and `childNodes`; a text or comment node has neither.
 */
interface El {
  nodeName: string;
  tagName?: string;
  namespaceURI?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: El[];
}

const isEl = (n: El): boolean => n.tagName !== undefined;

/** `<div class="x y">`, for a finding. */
function describe(el: El): string {
  const cls = el.attrs?.find((a) => a.name === 'class')?.value;
  return `<${el.tagName as string}${cls === undefined ? '' : ` class="${cls}"`}>`;
}

/** Does any element under `el` (itself included) have this tag? */
function holds(el: El, tag: string): boolean {
  return el.tagName === tag || (el.childNodes ?? []).some((c) => holds(c, tag));
}

/**
 * Every finding one page earns, as `what` strings. parse5 reads the page the
 * way a browser does, so a `<` inside a quoted attribute value — a code sample
 * Expressive Code keeps in `data-code` — is text, not a tag.
 */
export function pageFindings(html: string, isHome: boolean): string[] {
  const out: string[] = [];
  let regions = 0;
  let titled = false;

  const visit = (el: El, inRegion: boolean): void => {
    const tag = el.tagName as string;
    if (el.namespaceURI === SVG_NS) return;
    const attrs = el.attrs as { name: string; value: string }[];
    const names = attrs.map((a) => a.name);
    if (names.includes(SKIP)) {
      if (inRegion) out.push(`a skip marker on ${describe(el)} inside the knowledge region — nothing there may be dropped`);
      return;
    }
    const classed = names.includes('class');
    const facts = names.filter(isFact);
    if (facts.length > 0) {
      if (classed) {
        for (const f of facts) out.push(`fact ${f} on the classed element ${describe(el)} — a fact sits on a class-free element`);
      } else {
        for (const n of names) {
          if (!n.startsWith('data-') && n !== 'id') out.push(`data block <${tag}> carries ${n} — a data block holds only data-* and an id`);
        }
      }
    }
    // Code and scripts: the element is read, what it holds is not.
    if (OPAQUE.has(tag)) return;
    if (!classed && names.includes('data-page-head') && holds(el, 'h1')) titled = true;

    let region = inRegion;
    if (names.includes(REGION)) {
      regions += 1;
      region = true;
      if (!classed) out.push(`the knowledge region <${tag}> carries no class — it is the classed wrapper around the article block, never a data block`);
      const kids = (el.childNodes as El[]).filter(isEl);
      const article = kids[0];
      const order = (article?.attrs ?? []).map((a) => a.name).join(' ');
      if (kids.length !== 1 || article?.tagName !== 'article' || !ARTICLE_SHAPES.some((shape) => order === shape.join(' '))) {
        out.push(
          `the knowledge region is not one <article> carrying exactly ${ARTICLE_FACTS.join(', ')}, then all of ${PLACE_FACTS.join(', ')} or none of them — run the post-build pass`,
        );
      }
    }
    for (const child of el.childNodes as El[]) if (isEl(child)) visit(child, region);
  };
  visit((parse(html) as unknown as { childNodes: El[] }).childNodes.find(isEl) as El, false);

  if (regions === 0) out.push(`no knowledge region (no element carries ${REGION})`);
  if (regions > 1) out.push(`${regions} knowledge regions (${regions} elements carry ${REGION}) — a page has one`);
  if (!isHome && !titled) out.push('no class-free data-page-head block holds the H1');
  return out;
}

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The fixed-point property: the formatter would leave the raw bytes as they
 * are. A page it refuses carries the refusal's reason.
 */
export function fixedPoint(raw: string): string | null {
  try {
    return formatHtml(raw) === raw ? null : OFF_FIXED_POINT;
  } catch (err) {
    return (err as Error).message;
  }
}

/** The whole run over one built site, with the lists it reads passed in. */
export function absence(ctx: GateContext, dist: string, lists: NoiseLists): string {
  const abs = path.resolve(ctx.root, dist);
  if (dist === '' || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    ctx.failLine(`no built site at ${dist || "''"} — build it first: make site-build`);
    return '';
  }
  const pages = htmlFiles(abs);
  if (pages.length === 0) {
    ctx.failLine(`no .html files under ${dist} — build it first: make site-build`);
    return '';
  }
  const tally = new Tally();
  const rel = (file: string): string => path.relative(ctx.root, file).split(path.sep).join('/');
  for (const file of pages) {
    const raw = fs.readFileSync(file, 'utf8');
    const isHome = path.relative(abs, file) === 'index.html';
    const off = fixedPoint(raw);
    if (off !== null) ctx.fail(rel(file), off);
    for (const what of pageFindings(raw, isHome)) ctx.fail(rel(file), what);
    for (const what of noiseFindings(raw, lists, tally, path.relative(abs, file) === NOT_FOUND_FILE)) ctx.fail(rel(file), what);
  }
  for (const f of unreachableScripts(abs, pages)) ctx.fail(rel(path.join(abs, f)), NOISE.unreachable.fail);
  for (const entry of unusedEntries(lists, tally, siteFiles(abs))) ctx.failLine(NOISE.unusedEntry.fail(entry.id));
  return `[site-absence] ${pages.length} pages: ${SUMMARY}`;
}

/** Every property the run checks, as the summary says each one holds. */
export const SUMMARY = [
  "at the formatter's fixed point",
  NOISE.bundle.holds,
  NOISE.inlineModule.holds,
  NOISE.namedScripts.holds,
  NOISE.mainStylesheet.holds,
  NOISE.styleElement.holds,
  NOISE.noscriptStyle.holds,
  NOISE.presentational.holds,
  NOISE.handlers.holds,
  NOISE.chrome.holds,
  NOISE.unreachable.holds,
  NOISE.notFound.holds,
  'facts on class-free data blocks only',
  'one article block per knowledge region, its place all there or not at all',
  'no skip marker inside it',
  'every title in a title block',
].join(', ');

export const spec: GateSpec = {
  name: 'site-absence',
  usage: 'usage: check-site-absence [--dist <dir>]',
  options: ['--dist'],
  run(ctx: GateContext): string {
    return absence(ctx, ctx.options.get('--dist') ?? DIST, LISTS);
  },
};

main(spec, import.meta.url);
