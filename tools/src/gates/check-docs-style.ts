/**
 * Every published page has the one shape the numbered rules PAGE-001 to
 * PAGE-008 on docs/reference/page-rules.md give it (spec: kb.content.page-shape):
 * an intro paragraph before the first H2, headings no deeper than H3, one H1,
 * a description that fits a search result, no raw URL in prose, and at most one
 * "Next steps" footer — last, one sentence, one link. PAGE-007 (banned
 * phrasing) is not read here; its deciding gate is the glossary's.
 *
 * The footer is optional and single-linked because it names the next page to
 * read. A page at the end of its reading order recommends the closest related
 * page, and a page with nothing to recommend ends without one.
 *
 * The measured set is computed, never listed: every page the structure file
 * lists from the page tree, an unpublished (`nav: none`) area's rows included
 * since they are read raw, plus the hand-written site pages (`*.mdx` under
 * site/src/content/docs/ that carry no generator stamp). Exercises and hubs
 * are never measured. Named files narrow it and never widen it: a named file
 * outside the set (a layer, a refused file, an exercise, a working file such
 * as the trap inbox, a stamped hub) is skipped, so a run over the files a
 * change touched finds nothing the whole run would not. Naming the structure
 * file widens it back to the whole set, which that file decides.
 *
 * Findings print in the rule-id shape, `PAGE-00N <file>:<line> <message>`, with
 * the rule's anchor appended; a structure file that cannot be read is PAGE-000.
 * Code is invisible to every rule, fenced or indented, read the one way
 * `lib/md-lines.ts` reads it; so are inline code spans and HTML comments to
 * the raw-URL rule.
 *
 * Usage: check-docs-style [file …]   (0 pass · 1 findings · 2 misuse)
 */

import fs from 'node:fs';
import path from 'node:path';

import { frontmatterMany } from '../lib/frontmatter.js';
import { main, UsageError, type GateContext, type GateSpec } from '../lib/gate.js';
import { STAMP_PREFIX } from '../lib/generated.js';
import { blankInline, H1, keyLine, mdLines } from '../lib/md-lines.js';
import { descriptionProblem } from '../lib/page-block.js';
import { regimeOf, STRUCTURE } from './check-doc-frontmatter.js';

export const NAME = 'docs-style';

/** The page holding the numbered rules; every finding cites its anchor there. */
export const RULES_PAGE = 'docs/reference/page-rules.md';

/** Hand-written pages of the site's own, beside the mirror of docs/. */
export const MDX_DIR = 'site/src/content/docs';

export interface Finding {
  readonly id: string;
  readonly line: number;
  readonly message: string;
}

/**
 * Heading patterns allow up to three leading spaces, because CommonMark does;
 * four is an indented code block, which is no heading and no prose. A run of
 * hashes is a heading only when a space or the line's end follows it.
 */
const H4 = /^ {0,3}#{4,6}(?:[ \t]|$)/;
const H2 = /^ {0,3}## /;
const NEXT_STEPS = /^ {0,3}##[ \t]+Next steps[ \t]*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+][ \t]|\d+[.)][ \t])/;
const INDENTED_CODE = /^( {4}|\t)/;
const REF_LINK_DEF = /^ {0,3}\[[^\]]+\]:[ \t]/;

/** Markup, imports, lists, tables, images, blockquotes and asides are not prose. */
const NOT_PROSE = [/^[ \t]*$/, /^import /, /^[ \t]*</, /^ {0,3}#/, /^[ \t]*>/, LIST_ITEM, /^[ \t]*\|/, /^!\[/, /^\{/, /^:::/, INDENTED_CODE];

/**
 * The findings for one page. `descRaw` is the description exactly as written,
 * read through the one parser (`fm-json.sh --raw`): the scan here only locates
 * the line the key sits on and interprets nothing after the colon.
 */
export function pageFindings(text: string, type: 'md' | 'mdx', descRaw: string | undefined): Finding[] {
  const out: Finding[] = [];
  const add = (id: string, line: number, message: string): void => {
    out.push({ id, line, message });
  };

  const lines = mdLines(text);
  // The body with its code spans and comments blanked, line for line: what the raw-URL rule reads.
  const inline = blankInline(lines.map((l) => (l.zone === 'body' ? l.text : '')).join('\n')).split('\n');
  const fmClose = lines.filter((l) => l.zone === 'frontmatter').at(-1)?.no ?? 0;
  const descLine = keyLine(lines, 'description');
  let h1 = 0;
  let h1Line = 0;
  let extraH1 = 0;
  let firstH2 = 0;
  let lastH2 = 0;
  let nsHeading = 0;
  let nsLinks = 0;
  let inItem = false;
  let intro = 0;
  // The shape of the last section's body, one entry per paragraph or list
  // item. PAGE-008 reads it at the end, where the last section is the footer.
  const nsShape: { kind: 'prose' | 'item'; line: number }[] = [];
  let nsBlank = true;

  for (const { no, text: line, zone } of lines) {
    if (zone !== 'body') continue;
    if (H1.test(line)) {
      h1 += 1;
      if (h1 > 1) extraH1 = extraH1 === 0 ? no : extraH1;
      else h1Line = no;
      continue;
    }
    if (H4.test(line)) {
      add('PAGE-002', no, 'heading deeper than H3 — a page that needs H4 is two pages');
      continue;
    }
    if (H2.test(line)) {
      if (firstH2 === 0) firstH2 = no;
      lastH2 = no;
      if (NEXT_STEPS.test(line)) nsHeading = no;
      nsLinks = 0;
      inItem = false;
      nsShape.length = 0;
      nsBlank = true;
      continue;
    }

    // Links in the footer's list items, which become the card. A link in the
    // sentence above is prose; an item runs until a line that starts something
    // else, so a wrapped item still counts once.
    if (nsHeading > 0 && nsHeading === lastH2) {
      if (LIST_ITEM.test(line)) inItem = true;
      else if (line.trim() !== '' && !/^[ \t]/.test(line)) inItem = false;
      if (inItem) nsLinks += (line.match(/\]\(/g) ?? []).length;
    }
    // What each line of the last section starts. A blank line starts nothing,
    // an indented one continues what came before it, and a line straight
    // under a prose line is that paragraph, wrapped.
    if (lastH2 > 0 && line.trim() === '') nsBlank = true;
    else if (lastH2 > 0) {
      const last = nsShape.at(-1);
      if (LIST_ITEM.test(line)) nsShape.push({ kind: 'item', line: no });
      else if (!/^[ \t]/.test(line) && (nsBlank || last?.kind !== 'prose')) nsShape.push({ kind: 'prose', line: no });
      nsBlank = false;
    }

    if (firstH2 === 0 && intro === 0 && !NOT_PROSE.some((re) => re.test(line))) intro = no;

    // Raw URLs: what survives once inline code and link targets are removed,
    // except in indented code or a reference-link definition — the standard
    // way to keep a URL out of prose must not be punished as prose.
    if (!INDENTED_CODE.test(line) && !REF_LINK_DEF.test(line)) {
      const stripped = (inline[no - 1] as string).replace(/\]\([^)]*\)/g, ']()');
      if (/https?:\/\//.test(stripped)) add('PAGE-006', no, 'raw URL in prose — write [link text](url)');
    }
  }

  if (type === 'md' && h1 !== 1) add('PAGE-004', h1 > 1 ? extraH1 : fmClose + 1, `${String(h1)} H1 headings — a page has exactly one`);
  if (type === 'mdx' && h1 > 0) add('PAGE-004', h1Line, 'H1 in an .mdx body — the site renders title: as the H1');
  if (intro === 0) add('PAGE-001', fmClose + 1, 'no intro paragraph before the first H2 — open with what this is and who it is for');

  if (nsHeading > 0 && nsHeading !== lastH2) {
    add('PAGE-003', lastH2, 'a section follows "Next steps" — the footer is the last thing on the page');
  } else if (nsHeading > 0 && nsLinks !== 1) {
    add(
      'PAGE-003',
      nsHeading,
      nsLinks === 0 ? 'the "Next steps" section has no link — a footer that goes nowhere' : `the "Next steps" section offers ${String(nsLinks)} links — name the one next page to read`,
    );
  }
  if (nsHeading > 0 && nsHeading === lastH2 && nsLinks > 0) {
    // One sentence, then the list, then nothing: only the list becomes a card.
    // A link is only ever counted in an item, so the section holds one.
    const firstItem = nsShape.findIndex((s) => s.kind === 'item');
    if (firstItem === 0) add('PAGE-008', lastH2, 'the "Next steps" section opens with its list — one sentence saying where this leads comes first');
    if (firstItem > 1) {
      add('PAGE-008', (nsShape[1] as { line: number }).line, `the "Next steps" section opens with ${String(firstItem)} paragraphs — one sentence saying where this leads, then the list`);
    }
    const trailing = nsShape.slice(firstItem + 1).find((s) => s.kind === 'prose');
    if (trailing !== undefined) add('PAGE-008', trailing.line, 'prose after the "Next steps" list — the section ends with its link');
  }

  // The one description check, shared with the frontmatter gate.
  const descProblem = descRaw === undefined ? null : descriptionProblem(descRaw);
  if (descRaw === undefined || descLine === 0) add('PAGE-005', 1, 'no description: in the frontmatter');
  else if (descProblem !== null) add('PAGE-005', descLine, descProblem);

  return out.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

/** The pages the structure file publishes from the page tree, in its order; null when it cannot be read. */
export function publishedSources(root: string): string[] | null {
  let data: { areas?: { pages?: { source?: unknown }[] }[] };
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, STRUCTURE), 'utf8')) as typeof data;
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const a of data.areas ?? []) for (const p of a.pages ?? []) if (typeof p.source === 'string' && p.source.startsWith('docs/')) out.push(p.source);
  return [...new Set(out)];
}

/** A page this gate measures: a markdown page of the page regime, or a hand-written site page. */
export function shaped(file: string): boolean {
  if (file.startsWith(`${MDX_DIR}/`)) return file.endsWith('.mdx');
  return file.startsWith('docs/') && file.endsWith('.md') && regimeOf(file) === 'page';
}

/** The default measured set: the published pages, plus the hand-written site pages; null without a readable structure file. */
export function measuredSet(root: string): string[] | null {
  const published = publishedSources(root);
  if (published === null) return null;
  const mdx: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      // A generated page (a hub) carries its generator's stamp and is skipped:
      // it is built from pages this gate already measures.
      else if (e.name.endsWith('.mdx') && !fs.readFileSync(path.join(root, child), 'utf8').includes(STAMP_PREFIX)) mdx.push(child);
    }
  };
  walk(MDX_DIR);
  return [...published.filter(shaped), ...mdx];
}

export const spec: GateSpec = {
  name: NAME,
  usage: 'usage: check-docs-style [file ...]   (no files: every published page)',
  positional: true,
  run(ctx: GateContext): string {
    // A named file that does not exist is a wrong invocation, not a finding.
    for (const f of ctx.args) {
      if (!fs.existsSync(path.join(ctx.root, f))) throw new UsageError(`no such file: ${f}`);
    }
    const named = ctx.args.map((f) => f.replace(/^\.\//, ''));
    const set = measuredSet(ctx.root);
    if (set === null) {
      ctx.failRaw(`PAGE-000 ${STRUCTURE}:1 is missing or is not JSON — the measured set is the pages it publishes (${RULES_PAGE}#PAGE-000)`);
      return '';
    }
    // Named files narrow the set, never widen it; naming the structure file
    // asks for the whole set it decides. A published page gone from disk has
    // no shape to measure; the kb-shape gate reports the row that names it
    // (KB-001).
    const wanted = named.length === 0 || named.includes(STRUCTURE) ? null : new Set(named);
    const files = set.filter((x) => {
      if (wanted !== null && !wanted.has(x)) return false;
      const there = fs.existsSync(path.join(ctx.root, x));
      if (!there) ctx.note(`skipped ${x}: ${STRUCTURE} publishes it, and it is not on disk`);
      return there;
    });

    const raws = frontmatterMany(ctx.root, files, { raw: true });
    for (const f of files) {
      const type = f.endsWith('.mdx') ? 'mdx' : 'md';
      const descRaw = (raws.get(f) as Record<string, string>)['description'];
      for (const finding of pageFindings(fs.readFileSync(path.join(ctx.root, f), 'utf8'), type, descRaw)) {
        ctx.failRaw(`${finding.id} ${f}:${String(finding.line)} ${finding.message} (${RULES_PAGE}#${finding.id})`);
      }
    }
    return `[${NAME}] OK — ${String(files.length)} page(s) keep the shape of ${RULES_PAGE}`;
  },
};

main(spec, import.meta.url);
