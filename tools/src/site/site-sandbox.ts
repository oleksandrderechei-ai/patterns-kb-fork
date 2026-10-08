/**
 * A throwaway checkout that builds a real site: the Astro + Starlight
 * workspace, the site build's steps under tools/src, and a small page tree,
 * so a scenario can run the build and read what it wrote (spec
 * kb.site.build-command; oracle pagedata-O1, head-O1).
 *
 * What is borrowed and what is copied. `node_modules` is the real one, linked:
 * nothing here installs. The workspace (`site/`, minus its input folder's
 * pages), the steps (`tools/src`), the frontmatter parser and the ignore rules
 * are copied, because the build writes beside them and resolves its own paths
 * from where they sit: a linked `tools/` would put the steps' own files outside
 * the checkout, and they would not know they were the program being run.
 *
 * Why Astro runs through a second config file. Node and Vite both follow a
 * link to its real path, and Astro then treats every package under the linked
 * `node_modules` as a file outside the project whenever the checkout and the
 * repository share no folder above them (a temporary folder never does), and
 * the build fails reading its own components. `astro.sandbox.mjs` imports the
 * real `astro.config.mjs` whole and adds only `vite.resolve.preserveSymlinks`,
 * and Node runs with `--preserve-symlinks`, so paths stay inside the checkout.
 * Nothing else differs from `make site-build`'s build.
 *
 * The steps `buildSite` runs are the build script's, in its order: `npm run
 * prebuild` (the mirror, the hubs, the bundle), `astro build`, `npm run
 * postbuild` (the post-build passes, the search payload).
 *
 * The whole build command — lint, unit tests, typecheck, the site gates, the
 * real build file — runs in a `commandSandbox` through `runMake`
 * (site-build.test.ts, oracle site-O1 to O3 and build-command-O1). That
 * checkout links each package on its own into a folder of its own, since the
 * build file would reinstall through one link to the real folder, and it
 * brings its own one-test unit suite, since the site's real suite reads the
 * real tree.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { exitStatus } from '../lib/exec.js';
import { REPO_ROOT, type Sandbox } from '../lib/sandbox.js';
import type { Structure } from '../lib/site-routes.js';
import { frontmatter, GLOSSARY_JSON, TAGS_JSON } from './site-fixtures.js';

/** What the sandbox copies from the repository, beside the linked `node_modules`. */
export const COPIED = [
  'package.json',
  '.gitignore',
  'scripts/fm-json.sh',
  'scripts/lib-frontmatter.sh',
  'tools/package.json',
  'tools/tsconfig.json',
  'tools/src',
  'site/package.json',
  'site/astro.config.mjs',
  'site/tsconfig.json',
  'site/src/components',
  'site/src/styles',
  'site/src/lib',
  'site/src/client',
  'site/src/pages',
  'site/src/route-middleware.ts',
  'site/src/content.config.ts',
  'site/public/favicon.svg',
  'site/public/apple-touch-icon.png',
  'site/public/og.png',
] as const;

/** The config Astro runs with here: the real one, with links kept as they are. */
export const SANDBOX_CONFIG = [
  "import config from './astro.config.mjs';",
  '',
  '// See tools/src/site/site-sandbox.ts: the only difference from the real build.',
  'export default { ...config, vite: { ...config.vite, resolve: { ...config.vite?.resolve, preserveSymlinks: true } } };',
  '',
].join('\n');

/** One area with a nested one, and a second top-level area: two pages, three hubs. */
export const SITE_STRUCTURE: Structure = {
  areas: [
    {
      id: 'patterns',
      label: 'Patterns',
      hub: { description: 'Reusable answers', intro: 'Reusable answers.', tags: ['caching', 'performance'] },
      pages: [],
    },
    {
      id: 'caching',
      label: 'Caching',
      nestUnder: 'patterns',
      hub: { description: 'Keeping answers close', intro: 'Keeping answers close.', tags: ['caching', 'performance'] },
      pages: [{ slug: 'alpha', label: 'Alpha', source: 'docs/patterns/caching/alpha.md', route: '/patterns/caching/alpha.html' }],
    },
    {
      id: 'hazards',
      label: 'Hazards',
      hub: { description: 'What goes wrong', intro: 'What goes wrong.', tags: ['resilience', 'caching'] },
      pages: [{ slug: 'gamma', label: 'Gamma', source: 'docs/hazards/gamma.md' }],
    },
  ],
};

/**
 * The hand-written home page, as the site's own is: a splash with the page
 * keys and the site map, whose cards are what links each top-level hub.
 */
export const HOME = [
  '---',
  'title: KB',
  'description: The fixture home.',
  'template: splash',
  'area: patterns',
  'owner: Oleksandr Derechei',
  'tags: [caching]',
  'status: stable',
  '---',
  '',
  "import SiteMap from '../../components/SiteMap/SiteMap.astro';",
  '',
  'Start at the hubs. Each one lists every page in its area, in the order a newcomer should read them, with a line on what the page is for.',
  '',
  'A reader who wants one answer goes to the page itself; a reader who wants to compare goes to the hub of the area and reads the lines beside each title before opening anything, so the choice of page costs one screen and no more than that. Every page ends by pointing at the page to read next, so a reader who starts anywhere can find the way back to the rest.',
  '',
  '<SiteMap />',
  '',
  'Pages you starred or practiced are kept in this browser: [My marks](/marks.html).',
  '',
].join('\n');

/**
 * The hand-written not-found page, as the site's own is: a splash with the page
 * keys, one sentence and two root links. Starlight's 404 route renders this
 * entry, so the sandbox build writes `404.html`, which the link and payload
 * gates expect, and the post-build pass reduces it to a page of its own.
 */
export const NOT_FOUND = [
  '---',
  'title: Page not found',
  'description: The fixture not-found page.',
  'template: splash',
  'area: patterns',
  'owner: Oleksandr Derechei',
  'tags: [caching]',
  'status: stable',
  '---',
  '',
  'That address is not a page here. Go to the [home page](/index.html), or [search](/index.html#search) for what you were after.',
  '',
].join('\n');

/** A page with an H1, one block heading and its section fact. */
export function sitePage(title: string, extra: Record<string, string> = {}): string {
  return (
    `${frontmatter(title, extra)}\n# ${title}\n\n${title} keeps answers.\n\n` +
    `## What it is\n<!--meta block=description-->\n\n${title} in one paragraph.\n`
  );
}

/**
 * Lay the workspace, the steps and the page tree into `sb`, and commit them,
 * so the build starts from a clean checkout. `pages` maps a repo path to its
 * text and replaces the two default pages.
 */
export function siteSandbox(sb: Sandbox, pages?: Readonly<Record<string, string>>): void {
  sb.linkRepo('node_modules');
  for (const p of COPIED) sb.copyRepo(p);
  sb.write('site/astro.sandbox.mjs', SANDBOX_CONFIG);
  sb.write('site/src/content/docs/index.mdx', HOME);
  sb.write('site/src/content/docs/404.mdx', NOT_FOUND);
  sb.write('docs/data/site-structure.json', `${JSON.stringify(SITE_STRUCTURE, null, 2)}\n`);
  sb.write('docs/data/tags.json', TAGS_JSON);
  sb.write('docs/data/glossary.json', GLOSSARY_JSON);
  const tree = pages ?? {
    'docs/patterns/caching/alpha.md': sitePage('Alpha', { tags: '[caching, performance]' }),
    'docs/hazards/gamma.md': sitePage('Gamma', { area: 'hazards', tags: '[resilience, caching]' }),
  };
  for (const [rel, text] of Object.entries(tree)) sb.write(rel, text);
  sb.commit('the site sandbox');
}

/** One step of a build: what it ran and what it said. */
export interface BuildStep {
  readonly name: string;
  readonly status: number;
  readonly output: string;
}

export interface SiteBuild {
  /** 0 when every step passed; otherwise the failing step's status. */
  readonly status: number;
  readonly steps: readonly BuildStep[];
  /** Every step's output, in order, for a failure message. */
  readonly output: string;
}

export interface BuildOptions {
  /**
   * Run the static-site generator with no `git` on its PATH: the step that
   * reads each page's commit date then has no version control to ask. The
   * other steps keep it, since they find the repository root through git.
   */
  readonly noVersionControl?: boolean;
}

/** A PATH holding only `node`: no git, no anything else. */
function nodeOnlyPath(): { dir: string; env: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-nogit-'));
  fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  return { dir, env: dir };
}

/** Run the build script's steps in the sandbox, stopping at the first that fails. */
export function buildSite(sb: Sandbox, options: BuildOptions = {}): SiteBuild {
  const site = path.join(sb.dir, 'site');
  const base = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  const noGit = options.noVersionControl === true ? nodeOnlyPath() : null;
  const astro = path.join(sb.dir, 'node_modules', 'astro', 'bin', 'astro.mjs');
  const plan: { name: string; cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [
    { name: 'prebuild', cmd: 'npm', args: ['run', '--silent', 'prebuild'] },
    {
      name: 'astro build',
      cmd: process.execPath,
      args: ['--preserve-symlinks', '--preserve-symlinks-main', astro, 'build', '--config', 'astro.sandbox.mjs'],
      ...(noGit === null ? {} : { env: { ...base, PATH: noGit.env } }),
    },
    { name: 'postbuild', cmd: 'npm', args: ['run', '--silent', 'postbuild'] },
  ];
  const steps: BuildStep[] = [];
  try {
    for (const step of plan) {
      const r = spawnSync(step.cmd, step.args, { cwd: site, env: step.env ?? base, encoding: 'utf8' });
      const done: BuildStep = { name: step.name, status: exitStatus(r.status, r.signal), output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
      steps.push(done);
      if (done.status !== 0) break;
    }
  } finally {
    if (noGit !== null) fs.rmSync(noGit.dir, { recursive: true, force: true });
  }
  const failed = steps.find((s) => s.status !== 0);
  return {
    status: failed === undefined ? 0 : failed.status,
    steps,
    output: steps.map((s) => `--- ${s.name} (exit ${s.status})\n${s.output}`).join('\n'),
  };
}

/** Commit what is staged-or-not in the sandbox with a fixed committer date. */
export function commitAt(sb: Sandbox, message: string, date: string): void {
  const env = { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
  for (const args of [['add', '-A'], ['commit', '-q', '-m', message]]) {
    const r = spawnSync('git', args, { cwd: sb.dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in the sandbox: ${r.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// The whole build command
// ---------------------------------------------------------------------------

/**
 * What a checkout for the whole build command (`make site-build`) copies
 * beyond COPIED: the build file, the gate registry and the accessibility allowance its last step reads,
 * the lockfile the install stamp is judged against, and the lint, format and
 * unit-test settings of the site workspace.
 */
export const COMMAND_COPIED = [
  'Makefile',
  'package-lock.json',
  'docs/data/gates.json',
  'docs/data/allow/site-a11y.json',
  'site/eslint.config.js',
  'site/.prettierrc.json',
  'site/.prettierignore',
  'site/vitest.config.ts',
] as const;

/**
 * The checkout's own unit suite. The site's real suite reads the real tree
 * (its structure file, relations, git history), so it stays behind; the unit
 * test step runs this one instead, with the real settings less their floors.
 */
export const COMMAND_SUITE = [
  "// The sandbox's own suite: the site's real suite reads the real tree.",
  "import { expect, it } from 'vitest';",
  '',
  "import { AREAS } from './site-types';",
  '',
  "it('runs in the sandbox', () => {",
  '  expect(AREAS.length).toBeGreaterThan(0);',
  '});',
  '',
].join('\n');

/** The installed packages, each a link of its own, and the two workspaces linked as npm links them. */
function linkPackages(sb: Sandbox): void {
  const real = path.join(REPO_ROOT, 'node_modules');
  const own = path.join(sb.dir, 'node_modules');
  fs.mkdirSync(own);
  for (const name of fs.readdirSync(real)) {
    // Dot folders are caches and stamps, which a build writes: this checkout
    // keeps its own. Only `.bin` is an installed thing.
    if (name === 'kb-site' || name === 'kb-tools' || (name.startsWith('.') && name !== '.bin')) continue;
    fs.symlinkSync(path.join(real, name), path.join(own, name));
  }
  fs.symlinkSync('../site', path.join(own, 'kb-site'));
  fs.symlinkSync('../tools', path.join(own, 'kb-tools'));
}

/** Every file under `dir`, repo-relative, that ends in `.test.ts`. */
function testFiles(sb: Sandbox, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(sb.dir, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.test.ts')) out.push(child);
    }
  };
  walk(dir);
  return out;
}

/**
 * A checkout the whole build command runs in: `siteSandbox`'s tree plus the
 * build file, the registry and the workspace settings, with its own unit
 * suite. The packages are linked one by one into a folder of the checkout's
 * own, never as one link to the real folder, and the install stamps are
 * written fresh after the lockfile: so the build file never installs, and if
 * it ever did, it would empty this folder of links, not the real one. Node
 * then runs with --preserve-symlinks, which the site config reads to keep
 * Vite on the linked paths too.
 */
export function commandSandbox(sb: Sandbox, pages?: Readonly<Record<string, string>>): void {
  for (const p of [...COPIED, ...COMMAND_COPIED]) sb.copyRepo(p);
  for (const f of testFiles(sb, 'site/src')) sb.rm(f);
  sb.write('site/src/lib/sandbox.test.ts', COMMAND_SUITE);
  sb.write('site/vitest.config.ts', sb.read('site/vitest.config.ts').replace(/thresholds: \{[^}]*\}/, 'thresholds: {}'));
  linkPackages(sb);
  for (const stamp of ['.kb-install-stamp', '.kb-chromium-stamp']) sb.write(`node_modules/${stamp}`, '');
  sb.write('site/src/content/docs/index.mdx', HOME);
  sb.write('site/src/content/docs/404.mdx', NOT_FOUND);
  sb.write('docs/data/site-structure.json', `${JSON.stringify(SITE_STRUCTURE, null, 2)}\n`);
  sb.write('docs/data/tags.json', TAGS_JSON);
  sb.write('docs/data/glossary.json', GLOSSARY_JSON);
  const tree = pages ?? {
    'docs/patterns/caching/alpha.md': sitePage('Alpha', { tags: '[caching, performance]' }),
    'docs/hazards/gamma.md': sitePage('Gamma', { area: 'hazards', tags: '[resilience, caching]' }),
  };
  for (const [rel, text] of Object.entries(tree)) sb.write(rel, text);
  sb.commit('the build command sandbox');
}

/**
 * Run one make target in a command sandbox, links kept as they are. Its two
 * output streams are joined where they are written (`2>&1` in the shell that
 * runs make), so `output` is the order things happened in — build-command-O1
 * reads that order as its proof, which two streams pasted end to end could
 * never disprove.
 */
export function runMake(sb: Sandbox, target: string, env: NodeJS.ProcessEnv = {}): { status: number; output: string } {
  const r = spawnSync('sh', ['-c', 'exec make --no-print-directory "$0" 2>&1', target], {
    cwd: sb.dir,
    env: { ...process.env, NODE_OPTIONS: '--preserve-symlinks', ASTRO_TELEMETRY_DISABLED: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...env },
    encoding: 'utf8',
  });
  return { status: exitStatus(r.status, r.signal), output: r.stdout ?? '' };
}
