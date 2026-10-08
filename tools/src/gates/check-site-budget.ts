/**
 * The site's size budget: a built page, and the files it and the search box
 * load, stay inside the numbers the site was measured at (a site gate, like
 * the others over site/dist: it runs after `make site-build` and in CI's `site`
 * job, never in `make validate`, which has no built site to read).
 *
 * Each number below is a measured value plus room, written beside it. A build
 * that goes over names the file, its size, the budget and the part of it that
 * grew most, so the fix starts at the right place. Raise a budget only with a
 * new measurement, and write the measurement beside the number. A page that
 * outgrows its budget is a reason to trim what it carries; a hosting setup that
 * does not compress (docs/concepts/hosting-the-site.md) is no reason to raise
 * one, since the gzip budgets are what a host's compression reaches.
 *
 * WHAT IS MEASURED
 *   - A page's HTML, raw and gzipped (level 9, as a host's compressor reaches
 *     it): any page, then a tighter raw bound on every page that is not a case
 *     study under /designs/, then a tighter one still on a hub.
 *   - The files every page loads: the bundle (`kb.<hash>.js`), the search
 *     payload (`search-index.<hash>.js`) and the machine manifest
 *     (`index.json`, which the site never fetches), raw and gzipped.
 *   - The files of the retrieval contract, in a site whose manifest names a
 *     record for some page: every record, `graph.json`, `llms.txt` and
 *     `llms-full.txt`, raw and gzipped. None is loaded by a page; a reader
 *     fetches each whole, so a budget is what a reader may be made to download.
 *     A record the manifest names that is not there is a finding.
 *   - Per page: the stylesheets that block its first paint, summed; the bytes
 *     before its first render (its HTML, its blocking stylesheets and its
 *     synchronous scripts, gzipped) on every page that is not a case study; and
 *     the files it asks for.
 *
 * Usage: check-site-budget [--dist <dir>]   (default site/dist)
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { attrValue, parseAttrs, tags } from '../lib/built-page.js';
import { main, UsageError, type GateContext, type GateSpec } from '../lib/gate.js';
import { BUNDLE_FILE, findInDir, PAYLOAD_FILE_NAME } from '../lib/asset-names.js';
import { isHubRoute } from '../lib/site-routes.js';
import { DIST, readStructure } from '../site/site-output.js';

/**
 * The budgets, in bytes unless a name says otherwise. The comment on each is
 * the value it was set from, measured over the built site.
 */
export const BUDGETS = {
  /** Any page's HTML. Measured: the largest, designs/persona-identification-v2.html, 882,067 raw; designs/persona-identification.html, 146,388 gzipped. Set at about 1.25 times each. */
  pageHtml: { raw: 1_100_000, gzip: 180_000 },
  /** Any page that is not a case study under /designs/. Measured: the largest, patterns/gof/behavioral/chain-of-responsibility.html, 258,534 raw; set at about 1.18 times. */
  contentPageRaw: 305_000,
  /** Any hub. Measured: the largest, hazards.html, 139,078 raw (45 rows; the two toggles' inline icons are 57,000 of it); set at about 1.07 times. */
  hubRaw: 149_000,
  /** The bundle, kb.<hash>.js. Measured: 34,887 raw, 12,633 gzipped; set at the measure plus 15 percent. */
  bundle: { raw: 40_100, gzip: 14_500 },
  /** The stylesheets that block a page's first paint, summed. Measured: the largest, designs/persona-identification.html, 111,059 (the main stylesheet, the code frames' and four shared diagram styles); set at about 1.13 times. */
  cssPerPage: 125_000,
  /** The search payload, search-index.<hash>.js. Measured: 695,143 raw, 135,323 gzipped; set at the measure plus 15 percent. */
  payload: { raw: 800_000, gzip: 155_600 },
  /** The manifest, index.json, which the site never fetches. Measured: 1,301,441 raw, 131,024 gzipped (491 pages; the five fields each entry holds for its record are 79,133 and 6,247 of it); set at the measure plus 15 percent. */
  manifest: { raw: 1_500_000, gzip: 151_000 },
  /** Any page's record, `<route>.json`. Measured: the largest, designs/persona-identification.json, 399,154 raw, 65,059 gzipped; set at the measure plus 15 percent. */
  record: { raw: 460_000, gzip: 75_000 },
  /** The link graph, graph.json. Measured: 1,698,573 raw, 218,347 gzipped; set at the measure plus 15 percent. */
  graph: { raw: 1_955_000, gzip: 252_000 },
  /** llms.txt, a line for each page of the knowledge base. Measured: 60,177 raw, 21,413 gzipped; set at the measure plus 15 percent. */
  llms: { raw: 69_500, gzip: 24_700 },
  /** llms-full.txt, the markdown of every page of the knowledge base. Measured: 6,580,506 raw, 2,042,790 gzipped; set at the measure plus 15 percent. */
  llmsFull: { raw: 7_570_000, gzip: 2_350_000 },
  /** HTML, blocking stylesheets and synchronous scripts of a page that is not a case study, gzipped. Measured: the largest, patterns/gof/behavioral/chain-of-responsibility.html, 77,462 (59,461 of it the page); set at about 1.1 times. */
  firstRenderGzip: 85_000,
  /** The files a page asks for: itself, its scripts, stylesheets and icon. Measured: the most any page asks for is 12 (designs/persona-identification.html, with four shared diagram styles). */
  requests: 13,
} as const;

/** The route prefix of a case study, which carries inline diagrams and has its own HTML budgets. */
export const DESIGN_PREFIX = '/designs/';

const gzipSize = (b: Uint8Array | string): number => zlib.gzipSync(b, { level: 9 }).length;
const n = (v: number): string => v.toLocaleString('en-US');

/** The part of a page's HTML that is the biggest, as a phrase with its bytes. */
export function biggestPart(html: string): string {
  const sum = (re: RegExp): [number, number] => {
    let bytes = 0;
    let count = 0;
    for (const m of html.matchAll(re)) {
      bytes += Buffer.byteLength(m[0]);
      count += 1;
    }
    return [bytes, count];
  };
  const [svg, svgs] = sum(/<svg\b[\s\S]*?<\/svg\s*>/gi);
  const [style, styles] = sum(/<style\b[\s\S]*?<\/style\s*>/gi);
  const [script, scripts] = sum(/<script\b(?![^>]*\bsrc=)[\s\S]*?<\/script\s*>/gi);
  const [nav, navs] = sum(/<nav\b[\s\S]*?<\/nav\s*>/gi);
  const [table, tables] = sum(/<table\b[\s\S]*?<\/table\s*>/gi);
  const parts: [number, string][] = [
    [svg, `inline diagrams and icons, ${n(svg)} bytes in ${n(svgs)} svg element(s), ${n(style)} of them in ${n(styles)} style block(s)`],
    [script, `inline scripts, ${n(script)} bytes in ${n(scripts)} element(s)`],
    [nav, `navigation, ${n(nav)} bytes in ${n(navs)} nav element(s)`],
    [table, `tables, ${n(table)} bytes in ${n(tables)} table(s)`],
  ];
  parts.sort((a, b) => b[0] - a[0]);
  const top = parts[0] as [number, string];
  // A part under a tenth of the page is not what made it big.
  return top[0] * 10 < Buffer.byteLength(html) ? 'the page text itself' : top[1];
}

/** The biggest top-level field of each page in a manifest or payload, by serialized size. */
export function biggestField(pages: readonly Record<string, unknown>[]): string {
  const bytes = new Map<string, number>();
  for (const p of pages) for (const [k, v] of Object.entries(p)) bytes.set(k, (bytes.get(k) ?? 0) + Buffer.byteLength(JSON.stringify(v)));
  const top = [...bytes.entries()].sort((a, b) => b[1] - a[1])[0];
  return top === undefined ? 'nothing' : `the "${top[0]}" field, ${n(top[1])} bytes over ${n(pages.length)} page(s)`;
}

/** The top-level key of one JSON document that holds most of it, by serialized size, as a phrase with its bytes. */
export function biggestKey(text: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return 'nothing';
  }
  const fields = typeof doc === 'object' && doc !== null ? Object.entries(doc) : [];
  const top = fields.map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v))] as const).sort((a, b) => b[1] - a[1])[0];
  return top === undefined ? 'nothing' : `the "${top[0]}" key, ${n(top[1])} bytes`;
}

/** Two or more names as a phrase: `a and b`, `a, b and c`. */
const phrase = (names: readonly string[]): string => `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`;

/** What a page loads, as its tags name it, with `./` and `../` steps cut off. */
export interface Loads {
  /** Stylesheets without media="print": they block the first paint. */
  blockingCss: string[];
  /** Stylesheets for print. */
  printCss: string[];
  /** Scripts that block parsing: no `defer`, no `async`, no `type="module"`. */
  syncScripts: string[];
  /** Every other script. */
  otherScripts: string[];
  /** The icon, when the page names one. */
  icons: string[];
}

export function loadsOf(html: string): Loads {
  const out: Loads = { blockingCss: [], printCss: [], syncScripts: [], otherScripts: [], icons: [] };
  const local = (u: string | undefined): string | null => (u === undefined || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u) ? null : u.replace(/[?#].*$/, ''));
  for (const t of tags(html)) {
    if (t.closing) continue;
    const attrs = parseAttrs(t.source);
    if (t.name === 'script') {
      const src = local(attrValue(attrs, 'src'));
      if (src === null) continue;
      const sync = attrs.every((a) => !['defer', 'async'].includes(a.name)) && (attrValue(attrs, 'type') ?? '').trim().toLowerCase() !== 'module';
      (sync ? out.syncScripts : out.otherScripts).push(src);
    } else if (t.name === 'link') {
      const rel = (attrValue(attrs, 'rel') ?? '').toLowerCase().split(/\s+/);
      const href = local(attrValue(attrs, 'href'));
      if (href === null) continue;
      if (rel.includes('stylesheet')) {
        if ((attrValue(attrs, 'media') ?? '').trim().toLowerCase() === 'print') out.printCss.push(href);
        else out.blockingCss.push(href);
      } else if (rel.includes('icon')) {
        out.icons.push(href);
      }
    }
  }
  return out;
}

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export const spec: GateSpec = {
  name: 'site-budget',
  usage: 'usage: check-site-budget [--dist <dir>]',
  options: ['--dist'],
  run(ctx: GateContext): string {
    const abs = path.resolve(ctx.root, ctx.options.get('--dist') ?? DIST);
    if (!fs.existsSync(abs)) throw new UsageError(`no built site at ${path.relative(ctx.root, abs) || '.'} — build it first: make site-build`);
    const pages = htmlFiles(abs);
    if (pages.length === 0) throw new UsageError(`no .html files under ${path.relative(ctx.root, abs) || '.'} — build it first: make site-build`);
    const shown = (p: string): string => path.relative(ctx.root, p).split(path.sep).join('/');
    const structure = readStructure(ctx.root);

    // A file the passes of the build write: its absence is a finding, not a skipped check.
    const fileBudget = (file: string | null, name: string, limit: { raw: number; gzip: number }, contributor: (text: string) => string): void => {
      if (file === null) {
        ctx.fail(shown(path.join(abs, name)), 'is missing — the build writes it (make site-build)');
        return;
      }
      const buf = fs.readFileSync(file);
      const raw = buf.length;
      const gz = gzipSize(buf);
      if (raw > limit.raw) ctx.fail(shown(file), `is ${n(raw)} bytes, over its budget of ${n(limit.raw)}; biggest part: ${contributor(buf.toString('utf8'))}`);
      if (gz > limit.gzip) ctx.fail(shown(file), `is ${n(gz)} bytes gzipped, over its budget of ${n(limit.gzip)}; biggest part: ${contributor(buf.toString('utf8'))}`);
    };
    const jsonPages = (text: string): Record<string, unknown>[] => {
      try {
        const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
        return ((JSON.parse(body) as { pages?: Record<string, unknown>[] }).pages ?? []) as Record<string, unknown>[];
      } catch {
        return [];
      }
    };
    fileBudget(findInDir(abs, BUNDLE_FILE) ?? null, 'kb.js', BUDGETS.bundle, () => 'one bundled script, whose parts are in site/src/client and the components it names');
    fileBudget(findInDir(abs, PAYLOAD_FILE_NAME) ?? null, 'search-index.js', BUDGETS.payload, (t) => biggestField(jsonPages(t)));
    const manifest = path.join(abs, 'index.json');
    fileBudget(fs.existsSync(manifest) ? manifest : null, 'index.json', BUDGETS.manifest, (t) => biggestField(jsonPages(t)));

    // The retrieval contract's files, in a site whose manifest names a record for some page.
    const present = (rel: string): string | null => (fs.existsSync(path.join(abs, rel)) ? path.join(abs, rel) : null);
    const records = (fs.existsSync(manifest) ? jsonPages(fs.readFileSync(manifest, 'utf8')) : []).flatMap((p) => (typeof p['record'] === 'string' ? [p['record'].replace(/^\//, '')] : []));
    if (records.length > 0) {
      fileBudget(present('graph.json'), 'graph.json', BUDGETS.graph, biggestKey);
      fileBudget(present('llms.txt'), 'llms.txt', BUDGETS.llms, () => 'one line for each page of the knowledge base');
      fileBudget(present('llms-full.txt'), 'llms-full.txt', BUDGETS.llmsFull, () => 'the markdown of every page, copied whole');
      for (const record of records) fileBudget(present(record), record, BUDGETS.record, biggestKey);
    }

    const sizeOf = new Map<string, { raw: number; gz: number }>();
    const asset = (page: string, ref: string): { raw: number; gz: number } | null => {
      const file = path.normalize(path.join(path.dirname(page), ref));
      const hit = sizeOf.get(file);
      if (hit !== undefined) return hit;
      if (!fs.existsSync(file)) return null;
      const buf = fs.readFileSync(file);
      const sized = { raw: buf.length, gz: gzipSize(buf) };
      sizeOf.set(file, sized);
      return sized;
    };

    for (const file of pages) {
      const rel = shown(file);
      const route = `/${path.relative(abs, file).split(path.sep).join('/')}`;
      const buf = fs.readFileSync(file);
      const html = buf.toString('utf8');
      const raw = buf.length;
      const gz = gzipSize(buf);
      const design = route.startsWith(DESIGN_PREFIX);
      const hub = isHubRoute(structure, route);

      if (raw > BUDGETS.pageHtml.raw) ctx.fail(rel, `is ${n(raw)} bytes, over the page budget of ${n(BUDGETS.pageHtml.raw)}; biggest part: ${biggestPart(html)}`);
      if (gz > BUDGETS.pageHtml.gzip) ctx.fail(rel, `is ${n(gz)} bytes gzipped, over the page budget of ${n(BUDGETS.pageHtml.gzip)}; biggest part: ${biggestPart(html)}`);
      if (!design && raw > BUDGETS.contentPageRaw) ctx.fail(rel, `is ${n(raw)} bytes, over the budget of ${n(BUDGETS.contentPageRaw)} for a page that is not a case study; biggest part: ${biggestPart(html)}`);
      if (hub && raw > BUDGETS.hubRaw) ctx.fail(rel, `is ${n(raw)} bytes, over the hub budget of ${n(BUDGETS.hubRaw)}; biggest part: ${biggestPart(html)}`);

      const loads = loadsOf(html);
      let css = 0;
      let blocking = gz;
      const parts: [string, number][] = [['its HTML', gz]];
      for (const ref of loads.blockingCss) {
        const a = asset(file, ref);
        if (a === null) continue;
        css += a.raw;
        blocking += a.gz;
        parts.push([ref, a.gz]);
      }
      for (const ref of loads.syncScripts) {
        const a = asset(file, ref);
        if (a === null) continue;
        blocking += a.gz;
        parts.push([ref, a.gz]);
      }
      if (css > BUDGETS.cssPerPage) {
        ctx.fail(rel, `loads ${n(css)} bytes of blocking stylesheets, over the budget of ${n(BUDGETS.cssPerPage)}; biggest: ${loads.blockingCss.slice().sort((a, b) => (asset(file, b)?.raw ?? 0) - (asset(file, a)?.raw ?? 0))[0] ?? 'none'}`);
      }
      if (!design && blocking > BUDGETS.firstRenderGzip) {
        const top = parts.sort((a, b) => b[1] - a[1])[0] as [string, number];
        ctx.fail(rel, `needs ${n(blocking)} bytes gzipped before its first render, over the budget of ${n(BUDGETS.firstRenderGzip)}; biggest: ${top[0]}, ${n(top[1])}`);
      }
      const requested = new Set([...loads.blockingCss, ...loads.printCss, ...loads.syncScripts, ...loads.otherScripts, ...loads.icons].map((r) => path.normalize(path.join(path.dirname(file), r))));
      const requests = requested.size + 1;
      if (requests > BUDGETS.requests) {
        ctx.fail(rel, `asks for ${n(requests)} files (itself, ${n(loads.blockingCss.length + loads.printCss.length)} stylesheet(s), ${n(loads.syncScripts.length + loads.otherScripts.length)} script(s), ${n(loads.icons.length)} icon), over the budget of ${n(BUDGETS.requests)}`);
      }
    }
    const measured = ['the bundle', 'the search payload', 'the manifest', ...(records.length === 0 ? [] : [`${n(records.length)} records`, 'the graph', 'the llms files'])];
    return `[site-budget] ${n(pages.length)} pages, ${phrase(measured)} are inside their budgets`;
  },
};

main(spec, import.meta.url);
