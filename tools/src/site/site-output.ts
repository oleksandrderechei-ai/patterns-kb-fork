/**
 * What the site build's steps share: where the structure file and the site's
 * input folder are, how a step learns which files in that folder a build wrote,
 * and the constants a generated page is stamped with.
 *
 * OWNERSHIP IS THE IGNORE RULES (spec output-ownership-C6). Inside
 * `site/src/content/docs/` a file is build output exactly when git ignores it:
 * the root `.gitignore` says so by extension and folder, and it negates each
 * hand-written file back in. `generatedFiles` asks git that question rather
 * than restating the rules here, so the mirror and the hub generator delete and
 * overwrite only what `git clean -X` would, and a hand-written page in the
 * input folder is never touched (output-ownership-C7).
 */

import fs from 'node:fs';
import path from 'node:path';

import { run } from '../lib/exec.js';
import type { Structure } from '../lib/site-routes.js';

/** The one structure source (spec kb.data.structure). */
export const STRUCTURE = 'docs/data/site-structure.json';

/** Astro's input folder: the mirror and the hubs write here, and nothing is committed but hand-written pages. */
export const CONTENT = 'site/src/content/docs';

/** The built site. */
export const DIST = 'site/dist';

/**
 * The GitHub account and repository the project lives in. Every repository
 * and site URL below is built from this pair, so a rename is this one edit.
 */
export const REPO_OWNER = 'odere-pro';
export const REPO_NAME = 'software-design-atlas';

/** The repository's page on GitHub: the link in the site header. */
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

/** The project's name: the site title, the heading of llms.txt, and the WebSite every page's JSON-LD belongs to. */
export const SITE_NAME = 'Software Design Atlas';

/** The owner's own site, at the root of the host the project is served from: the author's address. */
export const AUTHOR_URL = `https://${REPO_OWNER}.github.io/`;

/** The licence the pages are published under; the code is MIT (LICENSE). */
export const CONTENT_LICENSE = 'https://creativecommons.org/licenses/by/4.0/';

/** The picture a link preview shows for any page: a file in site/public/, and its size. */
export const SOCIAL_IMAGE = {
  path: 'og.png',
  width: 1200,
  height: 630,
  alt: `${SITE_NAME}: design patterns, system design case studies, anti-patterns and principles`,
} as const;

/**
 * Where a repo path lives on GitHub, for a link from a published page to a
 * file the site does not publish (spec mirror-and-hubs link-rewrite).
 */
export const REPO_BLOB = `${REPO_URL}/blob/main`;

/**
 * Where the published site lives: the root every absolute URL a built page
 * names starts with — its canonical link, its `og:url`, the sitemap. GitHub
 * Pages serves a project site under the repository's name, so the root is
 * more than an origin. `SITE_URL` overrides it: the Pages workflow sets it to
 * the address the deploy publishes to, and a fork deploys elsewhere.
 */
export const PUBLIC_ROOT = `https://${REPO_OWNER}.github.io/${REPO_NAME}/`;

/** The published root as a URL, ending in `/`. */
export function publicRoot(env: NodeJS.ProcessEnv = process.env): URL {
  const root = new URL(env['SITE_URL'] || PUBLIC_ROOT);
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  return root;
}

/**
 * An absolute URL on the site's origin, moved under the published root:
 * `https://odere-pro.github.io/patterns/x.html` becomes
 * `https://odere-pro.github.io/software-design-atlas/patterns/x.html`. The generator
 * builds these from the origin alone (it has no base path, so that every
 * route stays a file path); anything already under the root, or on another
 * origin, is left as it is, so a second run changes nothing.
 */
export function toPublic(url: string, root: URL): string {
  const origin = `${root.origin}/`;
  if (!url.startsWith(origin) || url.startsWith(root.href)) return url;
  return `${root.href}${url.slice(origin.length)}`;
}

/** The `owner` of a page the build assembles rather than a person writing it. */
export const SITE_OWNER = 'Oleksandr Derechei';

/** The keys a published page must declare (spec interfaces/page-frontmatter.md). */
export const REQUIRED_KEYS = ['title', 'description', 'area', 'owner', 'tags'] as const;

/** The parsed structure file. Malformed JSON throws: there is no fallback layout. */
export function readStructure(root: string): Structure {
  return JSON.parse(fs.readFileSync(path.join(root, STRUCTURE), 'utf8')) as Structure;
}

/**
 * Every file under `dir` (repo-relative) that git ignores, repo-relative and
 * sorted: the build output a step may delete or overwrite. Throws when git
 * cannot answer, because a step that guessed would be deleting on a guess.
 */
export function generatedFiles(root: string, dir: string): string[] {
  const r = run('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', dir], root);
  if (r.status !== 0) throw new Error(`git cannot say which files under ${dir} are build output: ${r.stderr.trim()}`);
  return r.stdout
    .split('\0')
    .filter((l) => l !== '')
    .sort();
}

/**
 * Remove every directory under `dir` (absolute) that holds nothing, deepest
 * first; `dir` itself stays. A folder whose area left the structure file is
 * empty once its mirrored pages are gone (output-ownership-C8).
 */
export function removeEmptyDirs(dir: string): number {
  let removed = 0;
  const walk = (d: string): boolean => {
    let empty = true;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && walk(p)) {
        fs.rmdirSync(p);
        removed += 1;
      } else {
        empty = false;
      }
    }
    return empty;
  };
  if (fs.existsSync(dir)) walk(dir);
  return removed;
}
