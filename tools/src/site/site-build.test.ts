/**
 * The build command's scenarios (oracle site-O1, site-O2, site-O3,
 * build-command-O1, and kb.noise's post-build-O1 and noise-O1): the real
 * `make site-build` in a throwaway checkout with
 * both workspaces installed — the real build file, lint and format settings,
 * steps, components and site gates over a three-page tree
 * (site-sandbox.ts, commandSandbox). One checkout is built once and read by
 * three scenarios, the last of which cleans it and builds it again, so the
 * order of the tests below is part of the fixture. site-O2 has a checkout of
 * its own. A whole build here takes 15 to 30 seconds on an idle machine.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attrValue, knowledgeRegion, parseAttrs, tags } from '../lib/built-page.js';
import { makeSandbox, rmTree, Sandbox } from '../lib/sandbox.js';
import { BUNDLE_FILE, BUNDLE_SRC, PAYLOAD_FILE_NAME } from '../lib/asset-names.js';
import { LISTS, noiseFindings, Tally } from '../lib/site-noise.js';
import type { Structure } from '../lib/site-routes.js';
import { commandSandbox, runMake, SITE_STRUCTURE, sitePage } from './site-sandbox.js';

const BUILD = { timeout: 600_000 };

/** Every file under a folder, relative to it, sorted. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out.sort();
}

/**
 * Playwright's browser folder, where `make site-deps` keeps Chromium, as a
 * listing of its entries with their change times; empty when there is none
 * (a CI job with no browser). Clean and rebuild must leave it as it was.
 */
function browserCache(): string[] {
  const dir =
    process.env['PLAYWRIGHT_BROWSERS_PATH'] ||
    (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright'));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map((e) => `${e} ${fs.statSync(path.join(dir, e)).mtimeMs}`);
}

/** The site gates' summary lines, as the driver prints them. */
const GATE_LINE = /^\s*✓ .*\[(site-portable|site-links|site-absence|site-accessibility|site-axe|site-budget)\] /;

/** The sandbox's structure file, each hub with a paragraph of intro. */
const TALL_HUBS: Structure = {
  areas: SITE_STRUCTURE.areas.map((a) => ({
    ...a,
    hub: {
      ...a.hub,
      intro:
        `${a.hub.intro} Each page under this hub answers one question a reader brings, and the pages are listed in the order ` +
        'a reader new to the area meets them: the problem each one solves first, then how it works, then what it costs and ' +
        'when to reach for something else. Start at the top and read down, or jump straight to the page whose question is yours. ' +
        'Every page ends by pointing at the page to read next, so a reader who starts anywhere can find the way back to the rest.',
    },
  })),
};

/**
 * The page tree: the two default pages, each ending in a next-steps section —
 * Alpha's item opens with its link, Gamma's with prose (post-build-O1).
 */
const PAGES = {
  'docs/patterns/caching/alpha.md': `${sitePage('Alpha', { tags: '[caching, performance]' })}\n## Next steps\n\nWhere to go from here.\n\n- [Gamma](../../hazards/gamma.md) — where it goes wrong.\n`,
  'docs/hazards/gamma.md': `${sitePage('Gamma', { area: 'hazards', tags: '[resilience, caching]' })}\n## Next steps\n\n- Read [Alpha](../patterns/caching/alpha.md) first.\n`,
};

let sb: Sandbox;
let copy: string;
let build: { status: number; output: string };

beforeAll(() => {
  sb = makeSandbox();
  commandSandbox(sb, PAGES);
  // Hubs with an intro a reader would write, so a hub is not mostly chrome
  // (the static accessibility gate's cap); the fixture's one-line intros are.
  sb.write('docs/data/site-structure.json', `${JSON.stringify(TALL_HUBS, null, 2)}\n`);
  sb.commit('hubs with a full intro');
  // A copy while nothing is built, for the build step alone (build-command-O1).
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-build-copy-'));
  fs.cpSync(sb.dir, copy, { recursive: true, verbatimSymlinks: true });
  build = runMake(sb, 'site-build');
}, BUILD.timeout);

afterAll(() => {
  sb.cleanup();
  rmTree(copy);
});

describe('the build command', () => {
  it('build-command-O1: from nothing built, lint, unit tests, pre-build, the typecheck and the generator, post-build, then the site-gate lines; the build step alone, in a copy, leaves the same site', BUILD, () => {
    if (build.status !== 0) throw new Error(`the build command failed (exit ${build.status}):\n${build.output}`);
    const lines = build.output.split('\n');
    // Each step's first line, each found after the one before it: the order is the proof.
    const markers: (string | RegExp)[] = [
      '> kb-site@0.0.0 lint',
      '> kb-site@0.0.0 test',
      /Test Files\s+1 passed/,
      '> kb-site@0.0.0 prebuild',
      '[gen-site-docs] wrote',
      '> kb-site@0.0.0 build',
      /0 errors/,
      '[build] Complete!',
      '> kb-site@0.0.0 postbuild',
      '[site-pass]',
      '[site-diagram-styles]',
      '[gen-search-index]',
      '[site-format] formatted',
      '[site-assets]',
      '[site-build] 6 gate(s)',
    ];
    let last = -1;
    for (const marker of markers) {
      const i = lines.findIndex((l, k) => k > last && (typeof marker === 'string' ? l.includes(marker) : marker.test(l)));
      expect(i, `no line after line ${last + 1} says ${String(marker)}`).toBeGreaterThan(last);
      last = i;
    }
    // The six site gates, each once, all after the post-build passes.
    const gates = lines.map((l, i) => [l, i] as const).filter(([l]) => GATE_LINE.test(l));
    expect(gates.map(([l]) => (GATE_LINE.exec(l) as RegExpExecArray)[1]).sort()).toEqual([
      'site-absence',
      'site-accessibility',
      'site-axe',
      'site-budget',
      'site-links',
      'site-portable',
    ]);
    for (const [, i] of gates) expect(i).toBeGreaterThan(last);

    // The build script alone, in the copy: prebuild, the build, postbuild.
    // The copy is built where the sandbox stands, the two swapped for the
    // step: Astro names a component's scoped styles after its file's path,
    // and the packages here are links read at the checkout's own path.
    const full = `${sb.dir}.full`;
    fs.renameSync(sb.dir, full);
    fs.renameSync(copy, sb.dir);
    let alone: ReturnType<typeof spawnSync>;
    try {
      alone = spawnSync('npm', ['run', 'build'], {
        cwd: path.join(sb.dir, 'site'),
        env: { ...process.env, NODE_OPTIONS: '--preserve-symlinks', ASTRO_TELEMETRY_DISABLED: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
        encoding: 'utf8',
      });
    } finally {
      fs.renameSync(sb.dir, copy);
      fs.renameSync(full, sb.dir);
    }
    if (alone.status !== 0) throw new Error(`npm run build failed in the copy:\n${String(alone.stdout)}${String(alone.stderr)}`);
    const here = path.join(sb.dir, 'site/dist');
    const there = path.join(copy, 'site/dist');
    const files = filesUnder(here);
    expect(filesUnder(there)).toEqual(files);
    expect(files).toContain('index.json');
    expect(files.some((f) => /^search-index\.[0-9a-f]{8}\.js$/.test(f))).toBe(true);
    expect(files.some((f) => /^kb\.[0-9a-f]{8}\.js$/.test(f))).toBe(true);
    expect(files).not.toContain('kb.js');
    for (const f of files) expect(fs.readFileSync(path.join(there, f)).equals(fs.readFileSync(path.join(here, f))), f).toBe(true);
  });

  it('post-build-O1: Alpha’s next step is one card inside the article block, Gamma’s list stays as written; nothing in either article is skip-marked, every landmark outside is', BUILD, () => {
    expect(build.status).toBe(0);
    const read = (route: string): { html: string; article: string } => {
      const html = sb.read(`site/dist/${route}`);
      const region = knowledgeRegion(html) as [number, number];
      return { html, article: html.slice(region[0], region[1]) };
    };
    const alpha = read('patterns/caching/alpha.html');
    const block = alpha.article.slice(alpha.article.indexOf('<div class="kb-next-steps-block">'));
    expect(block.startsWith('<div class="kb-next-steps-block">')).toBe(true);
    const nav = /<nav class="kb-next-steps kb-card-grid" aria-labelledby="next-steps">([\s\S]*?)<\/nav>/.exec(block);
    expect(nav, 'the next-steps nav').not.toBeNull();
    const cards = [...((nav as RegExpExecArray)[1] as string).matchAll(/<a class="kb-card" href="([^"]+)">/g)].map((m) => m[1]);
    expect(cards).toEqual(['../../hazards/gamma.html']);
    expect(block).not.toMatch(/<ul>/);
    expect(block).not.toContain('data-kb-skip');

    const gamma = read('hazards/gamma.html');
    expect(gamma.article).not.toContain('kb-next-steps-block');
    expect(gamma.article).toMatch(/<li>\s*Read\s*<a href="\.\.\/patterns\/caching\/alpha\.html">/);

    for (const page of [alpha, gamma]) {
      expect(page.article).not.toContain('data-kb-skip');
      expect(noiseFindings(page.html, LISTS, new Tally()).filter((f) => f.startsWith('unmarked chrome'))).toEqual([]);
    }
  });

  it('noise-O1: after one build, a second run of the passes and the formatter changes no byte, and the fixed-point check, the absence gate and the static accessibility gate exit 0', BUILD, () => {
    expect(build.status).toBe(0);
    const dist = path.join(sb.dir, 'site/dist');
    const before = new Map(filesUnder(dist).map((f) => [f, fs.readFileSync(path.join(dist, f))]));
    const env = { ...process.env, NODE_OPTIONS: '--preserve-symlinks', NO_COLOR: '1', FORCE_COLOR: '0' };
    const again = spawnSync('npm', ['run', 'postbuild'], { cwd: path.join(sb.dir, 'site'), env, encoding: 'utf8' });
    expect(again.status, `${again.stdout}${again.stderr}`).toBe(0);
    expect(filesUnder(dist)).toEqual([...before.keys()]);
    for (const [f, bytes] of before) expect(fs.readFileSync(path.join(dist, f)).equals(bytes), f).toBe(true);

    const tsx = path.join(sb.dir, 'node_modules/.bin/tsx');
    for (const program of ['tools/src/site/site-format.ts --check', 'tools/src/gates/check-site-absence.ts', 'tools/src/gates/check-site-a11y.ts']) {
      const [file, ...args] = program.split(' ');
      const r = spawnSync(tsx, [file as string, ...args], { cwd: sb.dir, env, encoding: 'utf8' });
      expect(r.status, `${program}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout.trim().split('\n'), program).toHaveLength(1);
    }
  });

  it('site-O1: each route is one HTML file, no link or source starts with a single slash, and kb.js loads once, classic, with no search payload until the box asks for it', BUILD, () => {
    expect(build.status).toBe(0);
    const dist = path.join(sb.dir, 'site/dist');
    const html = filesUnder(dist).filter((f) => f.endsWith('.html'));
    expect(html).toEqual([
      '404.html',
      'hazards.html',
      'hazards/gamma.html',
      'index.html',
      'marks.html',
      'patterns.html',
      'patterns/caching.html',
      'patterns/caching/alpha.html',
    ]);
    const manifest = JSON.parse(sb.read('site/dist/index.json')) as { pages: Record<string, unknown>[] };
    expect(manifest.pages.map((p) => (p['route'] as string).slice(1)).sort()).toEqual(html);
    // The manifest names its schema and carries the five fields of the contract on every entry, null here:
    // the sandbox tree has no content model, so it holds no knowledge base and ships no record, graph or llms file.
    expect(Object.keys(manifest)).toEqual(['$schema', 'contract', 'generator', 'pages']);
    for (const p of manifest.pages) expect(p, String(p['route'])).toMatchObject({ id: null, kind: null, band: null, group: null, record: null });
    for (const none of ['graph.json', 'llms.txt', 'llms-full.txt', 'schema']) expect(filesUnder(dist).some((f) => f === none || f.startsWith(`${none}/`)), none).toBe(false);

    for (const file of html) {
      const page = fs.readFileSync(path.join(dist, file), 'utf8');
      const scripts: { src: string; type: string | undefined }[] = [];
      const alternates: { type: string | undefined; href: string | undefined }[] = [];
      for (const t of tags(page)) {
        if (t.closing) continue;
        const attrs = parseAttrs(t.source);
        for (const name of ['href', 'src', 'xlink:href']) {
          const v = attrValue(attrs, name);
          if (v !== undefined) expect(/^\/(?!\/)/.test(v), `${file}: ${name}="${v}"`).toBe(false);
        }
        const src = attrValue(attrs, 'src');
        if (t.name === 'script' && src !== undefined) scripts.push({ src, type: attrValue(attrs, 'type') });
        if (t.name === 'link' && (attrValue(attrs, 'rel') ?? '').split(/\s+/).includes('alternate')) alternates.push({ type: attrValue(attrs, 'type'), href: attrValue(attrs, 'href') });
      }
      // A page of the page tree links its markdown, relative to itself, and it is there; no other page links
      // a file, and no page links a record, since there is none.
      const own = file === 'patterns/caching/alpha.html' || file === 'hazards/gamma.html';
      expect(alternates.map((a) => a.type), file).toEqual(own ? ['text/markdown'] : []);
      if (own) {
        expect(path.posix.normalize(path.posix.join(path.posix.dirname(file), alternates[0]?.href as string)), file).toBe(file.replace(/\.html$/, '.md'));
        expect(fs.existsSync(path.join(dist, file.replace(/\.html$/, '.md'))), file).toBe(true);
      }
      const bundle = scripts.filter((s) => BUNDLE_SRC.test(s.src));
      // The not-found page loads no file of the site, so it loads no bundle (site-not-found.ts).
      expect(bundle, file).toHaveLength(file === '404.html' ? 0 : 1);
      expect(bundle[0]?.type, file).toBeUndefined();
      // The search payload loads when the box first opens, from the bundle.
      expect(scripts.some((s) => /search-index/.test(s.src)), file).toBe(false);
      // No module script is left: every one a browser would refuse from a folder is classic.
      expect(scripts.filter((s) => s.type !== undefined && s.type !== 'application/ld+json'), file).toEqual([]);
    }
    const names = filesUnder(dist);
    const bundleFile = names.find((f) => BUNDLE_FILE.test(f)) as string;
    const payloadFile = names.find((f) => PAYLOAD_FILE_NAME.test(f)) as string;
    expect(sb.read(`site/dist/${bundleFile}`)).toContain(`"${payloadFile}"`);
  });

  it('site-O3: clean deletes ignored output only, keeps every installed package and the browser, and the next build downloads nothing', BUILD, () => {
    expect(build.status).toBe(0);
    const stamp = path.join(sb.dir, 'node_modules/.kb-chromium-stamp');
    const stampTime = fs.statSync(stamp).mtimeMs;
    const packages = fs.readdirSync(path.join(sb.dir, 'node_modules')).sort();
    const browser = browserCache();
    expect(sb.git('status', '--porcelain').stdout).toBe('');

    const clean = runMake(sb, 'site-clean');
    expect(clean.status, clean.output).toBe(0);
    for (const gone of ['site/dist', 'site/.astro', 'site/node_modules/.astro', 'site/public/kb.js']) expect(sb.exists(gone), gone).toBe(false);
    // The input folder and the public folder hold their committed files only.
    for (const dir of ['site/src/content/docs', 'site/public']) {
      const committed = sb.git('ls-files', '--', dir).stdout.split('\n').filter(Boolean).map((f) => f.slice(dir.length + 1)).sort();
      expect(filesUnder(path.join(sb.dir, dir)), dir).toEqual(committed);
    }
    expect(sb.git('status', '--porcelain').stdout).toBe('');
    expect(fs.readdirSync(path.join(sb.dir, 'node_modules')).sort()).toEqual(packages);
    expect(fs.statSync(stamp).mtimeMs).toBe(stampTime);

    const again = runMake(sb, 'site-build');
    expect(again.status, again.output).toBe(0);
    expect(again.output).not.toMatch(/Downloading|playwright install/i);
    expect(fs.statSync(stamp).mtimeMs).toBe(stampTime);
    // The browser itself is kept: its folder is as it was. The sandbox pages
    // hold no diagram (CI's validate job has no Chromium), so the rebuild
    // does not launch it; that it draws with the kept browser is proven by
    // `make site-build` on the real tree, whose pages hold diagrams.
    expect(browserCache()).toEqual(browser);
    expect(sb.exists('site/dist/patterns/caching/alpha.html')).toBe(true);
  });
});

describe('site-O2', () => {
  it('site-O2: a page naming an area outside the closed list stops the build at the page-facts check, naming the file under docs/ and the key, and no site gate prints', BUILD, () => {
    const bad = makeSandbox();
    try {
      commandSandbox(bad, {
        'docs/patterns/caching/alpha.md': sitePage('Alpha', { tags: '[caching, performance]' }),
        'docs/hazards/gamma.md': sitePage('Gamma', { area: 'nowhere', tags: '[resilience, caching]' }),
      });
      const r = runMake(bad, 'site-build');
      expect(r.status).not.toBe(0);
      // The page facts are typechecked first by the mirror, against the same
      // closed lists the content schema holds, so the finding names the page
      // an author edits, at the key's line — never the ignored mirrored copy.
      const line = bad.read('docs/hazards/gamma.md').split('\n').findIndex((l) => l.startsWith('area:')) + 1;
      expect(r.output).toContain(
        `[gen-site-docs] FAIL docs/hazards/gamma.md:${line}: area 'nowhere' is not in the closed list — use an area id docs/data/site-structure.json holds`,
      );
      expect(r.output).not.toContain('site/src/content/docs/hazards/gamma.md');
      expect(r.output).not.toContain('Test Files');
      expect(r.output.split('\n').some((l) => /\[site-(portable|links|absence)\]/.test(l))).toBe(false);
      expect(bad.exists('site/dist')).toBe(false);
    } finally {
      bad.cleanup();
    }
  });
});
