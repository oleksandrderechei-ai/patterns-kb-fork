/**
 * The mirror: every published page, copied into Astro's input folder on every
 * build (spec kb.generation.mirror-and-hubs, mirror).
 *
 * The pages stay in docs/; which of them the site publishes, and at what
 * route, is docs/data/site-structure.json. For each row whose `source` is a
 * page under docs/ (a `generated` area's rows are its generator's) the mirror
 * writes `site/src/content/docs/<route with .md for .html>`:
 *
 *   1. the frontmatter block, byte for byte — the page facts are authored once
 *      in docs/ and never restated here (mirror-and-hubs-C1);
 *   2. the body minus its first H1 (Starlight renders the title from `title`)
 *      and the blank lines before its first line;
 *   3. every link rewritten: a published page's source becomes its route,
 *      root-absolute with its fragment kept; any other repository path becomes
 *      its GitHub URL; external, fragment-only and root-absolute targets stay;
 *      code spans, fences and the text of an escaped `\](target)` are never
 *      touched (mirror-and-hubs-C2). The post-build portability pass makes
 *      every route relative to the page that links it, so the mirror need not
 *      know how deep a page sits.
 *
 * A page with no frontmatter, or one missing a required key, is a finding
 * naming the file and every missing key, before Astro runs
 * (mirror-and-hubs-C3). So is an `area` the structure file does not hold,
 * named at its line in the page under
 * docs/ (site-O2): Astro's schema would stop the build too, but it can only
 * name the mirrored copy, a file nobody edits. Nothing it writes is committed: the root .gitignore
 * owns the input folder, and before writing, the mirror deletes every page an
 * earlier build mirrored and every folder that leaves empty
 * (output-ownership-C8). A hand-written file at a page's path is noted and
 * left alone (output-ownership-C3, C7).
 *
 * Usage: gen-site-docs   (no arguments; `--check` is misuse — the output is
 * ignored and rebuilt, never checked)
 */

import fs from 'node:fs';
import path from 'node:path';

import { records } from '../lib/exec.js';
import { frontmatterMany } from '../lib/frontmatter.js';
import { main, type GateContext, type GateSpec } from '../lib/gate.js';
import { fromPageTree, placedPages } from '../lib/site-routes.js';
import {
  CONTENT,
  generatedFiles,
  readStructure,
  removeEmptyDirs,
  REPO_BLOB,
  REQUIRED_KEYS,
} from './site-output.js';

/**
 * 1-indexed line of the frontmatter's closing `---`, or 0 when there is none.
 * `\r` in the class because a CRLF-saved page still parses at the fm-json.sh
 * door, and this locator has to agree with the door about what has frontmatter.
 */
export function frontmatterEnd(text: string): number {
  const src = text.split('\n');
  if (!/^---[ \t\r]*$/.test(src[0] as string)) return 0;
  for (let i = 1; i < src.length; i += 1) {
    if (/^---[ \t\r]*$/.test(src[i] as string)) return i + 1;
  }
  return 0;
}

/**
 * Resolve `p` against the folder `reldir` into a repo-relative path. A `..`
 * that would climb out of the repository is swallowed, so the answer never
 * starts with `..`.
 */
export function normalizePath(reldir: string, p: string): string {
  const stack: string[] = [];
  for (const part of `${reldir}/${p}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/** A target the mirror leaves as written: a scheme, `//`, a fragment or a root-absolute path. */
const KEPT = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/**
 * What the mirror looks for on a line: a code span, consumed whole so the link
 * branch never sees inside one, or the `](target)` that ends a link. The
 * backslashes before the `]` are captured, because an odd number of them
 * escapes it: `\[a\](b.md)` is text, and its target is not a target.
 */
const LINK_END = /(`+)[^`]*?\1|(\\*)\]\(([^)\s]+)\)/g;

/** One link target, given the source → route map of the published pages. */
export function rewriteTarget(target: string, reldir: string, routes: ReadonlyMap<string, string>): string {
  if (target === '' || KEPT.test(target)) return target;
  const hash = target.indexOf('#');
  const frag = hash >= 0 ? target.slice(hash) : '';
  const repoPath = normalizePath(reldir, hash >= 0 ? target.slice(0, hash) : target);
  const route = routes.get(repoPath);
  return route !== undefined ? `${route}${frag}` : `${REPO_BLOB}/${repoPath}${frag}`;
}

/**
 * The body of a published page: the first H1 dropped, the blank lines before
 * the first remaining line dropped, links rewritten outside code.
 *
 * The H1 is the first line that is one outside a fence — the one rule that
 * picks the heading the mirror removes (mirror-and-hubs-C4).
 */
export function transformBody(body: string, reldir: string, routes: ReadonlyMap<string, string>): string {
  const out: string[] = [];
  let strippedH1 = false;
  let fence: { char: string; len: number } | null = null;

  for (const raw of records(body)) {
    // CommonMark's fence rule: a run of three or more of one character opens,
    // and a run of the same character at least as long closes.
    const run = /^[ \t]*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence !== null) {
      if (run !== undefined && run[0] === fence.char && run.length >= fence.len) fence = null;
      out.push(raw);
      continue;
    }
    if (run !== undefined) {
      fence = { char: run[0] as string, len: run.length };
      out.push(raw);
      continue;
    }
    if (!strippedH1 && /^# /.test(raw)) {
      strippedH1 = true;
      continue;
    }
    if (out.length === 0 && /^[ \t]*$/.test(raw)) continue;
    // A code span is quoted and an escaped `]` is text: neither is linked.
    out.push(
      raw.replace(LINK_END, (m: string, _tick: string | undefined, slashes: string | undefined, t: string | undefined) =>
        t === undefined || (slashes as string).length % 2 === 1 ? m : `${slashes as string}](${rewriteTarget(t, reldir, routes)})`,
      ),
    );
  }
  return out.join('\n');
}

export const spec: GateSpec = {
  name: 'gen-site-docs',
  usage: 'usage: gen-site-docs   (no arguments)',
  run(ctx: GateContext): string {
    // A row a generator writes (a `generated` area's) has no page to copy.
    const structure = readStructure(ctx.root);
    const pages = placedPages(structure).filter(fromPageTree);
    const areas = new Set(structure.areas.map((a) => a.id));
    const routes = new Map(pages.map((p) => [p.source, p.route]));
    const content = path.join(ctx.root, CONTENT);

    // Every problem is found before anything is written: a half-mirrored input
    // folder would build a site nobody asked for.
    const present = pages.filter((p) => {
      if (fs.existsSync(path.join(ctx.root, p.source))) return true;
      ctx.fail(p.source, `is listed in the structure file for ${p.route} and does not exist`);
      return false;
    });
    const facts = frontmatterMany(
      ctx.root,
      present.map((p) => p.source),
    );
    const texts = new Map<string, { head: string; body: string }>();
    for (const p of present) {
      const text = fs.readFileSync(path.join(ctx.root, p.source), 'utf8');
      const close = frontmatterEnd(text);
      // fm-json.sh --many answers every file it is handed.
      const declared = facts.get(p.source) as Record<string, string>;
      const missing = REQUIRED_KEYS.filter((k) => !Object.hasOwn(declared, k));
      if (close === 0 || missing.length > 0) {
        ctx.fail(
          p.source,
          close === 0
            ? `has no frontmatter — a published page needs: ${REQUIRED_KEYS.join(' ')}`
            : `is missing required frontmatter: ${missing.join(' ')}`,
        );
        continue;
      }
      const lines = text.split('\n');
      const area = declared['area'] as string;
      if (!areas.has(area)) {
        // `area` is a required key, so its line is in the block.
        const at = lines.slice(0, close).findIndex((l) => l.startsWith('area:')) + 1;
        ctx.fail(p.source, `area '${area}' is not in the closed list — use an area id docs/data/site-structure.json holds`, at);
        continue;
      }
      texts.set(p.source, { head: lines.slice(0, close).join('\n'), body: lines.slice(close).join('\n') });
    }
    if (ctx.findings > 0) return '';

    // The last build's pages go first, so a page that left the structure file
    // cannot linger as a page nothing links to but search still finds.
    for (const rel of generatedFiles(ctx.root, CONTENT)) {
      if (rel.endsWith('.md')) fs.rmSync(path.join(ctx.root, rel));
    }
    removeEmptyDirs(content);

    let wrote = 0;
    for (const p of present) {
      const out = path.join(content, p.contentPath);
      if (fs.existsSync(out)) {
        ctx.note(`note: ${CONTENT}/${p.contentPath} is hand-written — leaving it alone, so ${p.source} is not mirrored`);
        continue;
      }
      const { head, body } = texts.get(p.source) as { head: string; body: string };
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${head}\n\n${transformBody(body, path.dirname(p.source), routes)}\n`);
      wrote += 1;
    }
    return `[gen-site-docs] wrote ${wrote} pages to ${CONTENT}/`;
  },
};

main(spec, import.meta.url);
