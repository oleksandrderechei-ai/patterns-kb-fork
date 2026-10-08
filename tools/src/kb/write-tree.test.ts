/**
 * kb.mjs's writers on a copy of the real tree. Nothing here writes the real
 * docs/: these tests write only the copy.
 *
 *   round trip   every wild and production block, rewritten from its own
 *                `get --json` dump, is byte for byte the block that was there;
 *                every explain block rewritten from its own dump keeps its
 *                words (and its bytes, where it carries no inline markup the
 *                plain writer cannot), and one KB-014 rejects is refused and
 *                left as it was
 *   the           every `kb.mjs` command the instructions type — the skills,
 *   instructions  agents and rules under .claude/, every CLAUDE.md, the README
 *                 and the concept and reference pages — parses under the
 *                 argument rules v2 refuses a typo with, and one writer of each
 *                 kind runs on the tree and reads back
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gitFiles } from '../lib/exec.js';
import { REAL_TREE_TIMEOUT } from '../lib/fixtures.js';
import { deriveElements, parseKb, type Nodes, type Paragraph } from '../lib/kb-attrs.js';
import type { RelationsFile } from '../lib/render-relations.js';
import { makeSandbox, type Sandbox } from '../lib/sandbox.js';

import { parseArgs } from './args.js';
import { run } from './cli.js';
import { Corpus, REPO } from './corpus.js';
import { splitFrontmatter } from './edit.js';
import { blockNamed, parsePage } from './page.js';
import { CLI_COMMANDS, flagsOf, RETIRED } from './spec.js';

const TODAY = '2026-09-28';
let sb: Sandbox;
let root: string;

beforeAll(() => {
  sb = makeSandbox();
  root = sb.dir;
  sb.copyRepo('docs');
}, REAL_TREE_TIMEOUT);
afterAll(() => sb.cleanup());

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function kb(argv: readonly string[], corpus: Corpus = new Corpus(root)): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, corpus, { today: TODAY });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('the round trip through the block writers', () => {
  it(
    'rewrites every wild and production block from its own dump, byte for byte',
    async () => {
      const corpus = new Corpus(root);
      let blocks = 0;
      for (const p of corpus.pages) {
        const before = sb.read(p.source);
        const items = ((JSON.parse((await kb(['get', p.slug, '--json'], corpus)).out) as { items?: Record<string, unknown> }).items ?? {}) as {
          wild?: unknown[];
          production?: Record<string, unknown[]>;
        };
        const calls: string[][] = [];
        if (items.wild !== undefined) calls.push(['wild', p.slug, '--items', JSON.stringify(items.wild)]);
        if (items.production !== undefined) {
          calls.push(['production', p.slug, ...['knobs', 'signals', 'failures', 'checklist'].flatMap((k) => [`--${k}`, JSON.stringify(items.production?.[k])])]);
        }
        for (const c of calls) {
          const r = await kb(c);
          expect(r.err, `kb.mjs ${c.slice(0, 2).join(' ')}`).toBe('');
          expect(sb.read(p.source), `kb.mjs ${c.slice(0, 2).join(' ')}`).toBe(before);
          blocks += 1;
        }
      }
      expect(blocks).toBeGreaterThan(300);
    },
    REAL_TREE_TIMEOUT,
  );

  it(
    'rewrites every explain block from its own dump with its words kept, and refuses one KB-014 rejects',
    async () => {
      const corpus = new Corpus(root);
      let same = 0;
      let marked = 0;
      let refused = 0;
      for (const p of corpus.pages) {
        const before = sb.read(p.source);
        const block = blockNamed(parsePage(before), 'explain');
        if (block === undefined) continue;
        const dump = ((JSON.parse((await kb(['get', p.slug, '--json'], corpus)).out) as { items: { explain: { text: string; example: string; exampleLang?: string; exampleCaption?: string } } }).items.explain);
        const argv = ['explain', p.slug, '--text', dump.text, '--example', dump.example];
        if (dump.exampleLang !== undefined) argv.push('--example-lang', dump.exampleLang, '--example-caption', dump.exampleCaption ?? '');
        const r = await kb(argv);
        if (r.code !== 0) {
          // Refused before anything is written: a block that awaits its rewrite.
          expect(r.err, p.slug).toContain('KB-014');
          expect(sb.read(p.source), p.slug).toBe(before);
          refused += 1;
          continue;
        }
        const after = sb.read(p.source);
        const words = (t: string): unknown[] => deriveElements(parseKb(splitFrontmatter(t).body).tree).map((e) => [e.id, e.text]);
        expect(words(after), p.slug).toEqual(words(before));
        // The writer takes plain text and `[label](path)` links: a code span in a paragraph comes back as its words.
        const markup = block.nodes.filter((n): n is Paragraph => n.type === 'paragraph').some((n) => n.children.some((c: Nodes) => c.type !== 'text' && c.type !== 'strong' && !(c.type === 'link' && c.children.every((k: Nodes) => k.type === 'text'))));
        if (markup) marked += 1;
        else {
          expect(after, p.slug).toBe(before);
          same += 1;
        }
        sb.write(p.source, before);
      }
      expect(same + marked + refused).toBeGreaterThan(350);
      expect(marked).toBeLessThan(20);
    },
    REAL_TREE_TIMEOUT,
  );
});

describe('what the instructions type', () => {
  interface Call {
    readonly verb: string;
    /** The arguments after the command, as a shell would split them. */
    readonly argv: string[];
    /** Where it sits and what it says, for a failure to name. */
    readonly line: string;
  }

  /** Every command kb.mjs has or had: the retired ones are looked for to be refused. */
  const COMMANDS = [...CLI_COMMANDS.map((c) => c.name), ...Object.keys(RETIRED)];
  const INVOCATION = new RegExp(`kb\\.mjs (${COMMANDS.join('|')})\\b([^\`\\n|)]*)`, 'g');

  /**
   * The lines of a file as a reader runs them: a line that ends in `\` runs on
   * into the next, and the whole is placed at the line it starts on.
   */
  function logicalLines(text: string): { no: number; text: string }[] {
    const out: { no: number; text: string }[] = [];
    let start = 0;
    let acc = '';
    text.split('\n').forEach((l, i) => {
      if (acc === '') start = i + 1;
      if (l.endsWith('\\')) {
        acc += `${l.slice(0, -1)} `;
        return;
      }
      out.push({ no: start, text: acc + l });
      acc = '';
    });
    if (acc !== '') out.push({ no: start, text: acc });
    return out;
  }

  /**
   * A command's arguments as a shell splits them, as far as these files need:
   * a quote groups (one left open runs to the end), `#` at a word's start
   * begins a comment, and the brackets that mark an optional flag in a usage
   * line are dropped. A `<placeholder>` is a word like any other.
   */
  function words(text: string): string[] {
    const out: string[] = [];
    let cur: string | null = null;
    let quote: string | null = null;
    for (const ch of text) {
      if (quote !== null) {
        if (ch === quote) quote = null;
        else cur += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        cur ??= '';
      } else if (/\s/.test(ch)) {
        if (cur !== null) out.push(cur);
        cur = null;
      } else if (ch === '#' && cur === null) {
        break;
      } else if (ch !== '[' && ch !== ']') {
        cur = (cur ?? '') + ch;
      }
    }
    if (cur !== null) out.push(cur);
    return out;
  }

  /**
   * A line that ends on a flag that takes a value names the flag and leaves the
   * value out (`kb.mjs set <id> --solves`): it is read with a placeholder
   * value. A flag with no value anywhere else is still a flag with no value.
   */
  function withValue(argv: string[]): string[] {
    const last = argv[argv.length - 1];
    return last !== undefined && /^--\S+$/.test(last) && last !== '--json' && last !== '--diagrams' ? [...argv, '<value>'] : argv;
  }

  /** Every `kb.mjs <command> …` a file's text types. */
  function callsIn(file: string, text: string): Call[] {
    return logicalLines(text).flatMap(({ no, text: line }) =>
      [...line.matchAll(INVOCATION)].map((m) => ({
        verb: m[1] as string,
        argv: withValue(words(m[2] as string).filter((w) => w !== '\\')),
        line: `${file}:${String(no)}: ${m[0].trim()}`,
      })),
    );
  }

  /** The files that tell a reader what to run: all of .claude/, every CLAUDE.md, the README and the concept and reference pages. */
  function instructionFiles(): string[] {
    return gitFiles(REPO, ['*.md']).filter(
      (f) => f.startsWith('.claude/') || f.split('/').pop() === 'CLAUDE.md' || f === 'README.md' || /^docs\/(concepts|reference)\/[^/]+\.md$/.test(f),
    );
  }

  /** The refusal the strict parser gives a call, or null when it takes it. */
  function refusal(c: Call): string | null {
    try {
      parseArgs(c.argv, flagsOf(c.verb));
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  it('finds the invocations a file types, with their arguments as a shell splits them', () => {
    const text = [
      'Run `kb.mjs find "one slow dependency" --kind design --n 3` first.',
      'node scripts/kb.mjs explain <id> --text "a b" --example \'x "y"\' \\',
      '  --example-lang <lang> --example-caption "q?"',
      'kb.mjs brief "<symptom>" [--tag T --band B --kind K --n 5]   # a comment --jsno',
      'kb.mjs get <id> --block',
      'kb.mjs get <id> --block usage|tradeoffs',
      'kb.mjs get reads directly, and not for editing.',
    ].join('\n');
    expect(callsIn('f.md', text).map((c) => [c.verb, c.argv])).toEqual([
      ['find', ['one slow dependency', '--kind', 'design', '--n', '3']],
      ['explain', ['<id>', '--text', 'a b', '--example', 'x "y"', '--example-lang', '<lang>', '--example-caption', 'q?']],
      ['brief', ['<symptom>', '--tag', 'T', '--band', 'B', '--kind', 'K', '--n', '5']],
      ['get', ['<id>', '--block', '<value>']],
      ['get', ['<id>', '--block', 'usage']],
      ['get', ['reads', 'directly,', 'and', 'not', 'for', 'editing.']],
    ]);
    // A call that runs over lines is placed at the line it starts on.
    expect(callsIn('f.md', text)[1]?.line).toMatch(/^f\.md:2: kb\.mjs explain <id> --text "a b" /);
    expect(callsIn('f.md', text)[3]?.line).toMatch(/^f\.md:5: kb\.mjs get <id> --block$/);
  });

  it('refuses what the strict parser refuses: -n, an unknown flag, a flag with no value in the middle, and a retired command’s flags', () => {
    const calls = callsIn('f.md', ['kb.mjs find "x" -n 3', 'kb.mjs find --jsno x', 'kb.mjs get <id> --block --json', 'kb.mjs get <id> --block usage --json', 'kb.mjs set <id> --solves'].join('\n'));
    expect(calls.map(refusal)).toEqual([
      '-n is not a flag: flags start with two dashes, so write --n',
      'unknown flag --jsno. This command takes --tag, --band, --kind, --n, --json, --diagrams',
      '--block needs a value',
      null,
      null,
    ]);
  });

  it(
    'types only commands kb.mjs carries, never a retired one, and every call parses under the strict argument rules',
    () => {
      const files = instructionFiles();
      expect(files).toEqual(expect.arrayContaining(['CLAUDE.md', 'README.md', 'tools/CLAUDE.md', 'scripts/CLAUDE.md', '.claude/skills/sys-design/SKILL.md', 'docs/concepts/skill-routing.md']));
      const calls = files.flatMap((f) => callsIn(f, fs.readFileSync(path.join(REPO, f), 'utf8')));
      expect(calls.length).toBeGreaterThan(300);
      expect(calls.filter((c) => c.verb in RETIRED).map((c) => c.line)).toEqual([]);
      expect(calls.flatMap((c) => [refusal(c)].filter((r) => r !== null).map((r) => `${c.line}  →  ${r as string}`))).toEqual([]);
    },
    REAL_TREE_TIMEOUT,
  );

  it(
    'runs one of each on the tree, and each reads back through the reader',
    async () => {
      const corpus = new Corpus(root);
      const rel = (): RelationsFile => JSON.parse(sb.read('docs/data/relations.json')) as RelationsFile;
      const linked = (a: string, b: string): boolean => rel().relations.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
      const free = (from: string, kind: string): string => (corpus.pages.find((p) => p.kind === kind && p.slug !== from && !linked(from, p.slug)) as { slug: string }).slug;
      const ok = async (...argv: string[]): Promise<string> => {
        const r = await kb(argv);
        expect(r.err, `kb.mjs ${argv.join(' ')}`).toBe('');
        return r.out;
      };
      const get = async (...argv: string[]): Promise<Record<string, unknown>> => JSON.parse((await kb(['get', ...argv, '--json'])).out) as Record<string, unknown>;

      const tags = (await get('circuit-breaker'))['id'] === 'circuit-breaker' ? (corpus.frontmatter('circuit-breaker')['tags'] as string[]) : [];
      await ok('set', 'circuit-breaker', '--aliases', '["breaker","CB"]', '--tags', JSON.stringify(tags), '--solves', '["my calls hang on a dead service"]');
      await ok('set', 'circuit-breaker', '--favourite', 'true');
      expect(new Corpus(root).meta('circuit-breaker')).toMatchObject({ aliases: ['breaker', 'CB'], solves: ['my calls hang on a dead service'], favourite: true });

      for (const [from, verb, kind] of [
        ['circuit-breaker', 'combines-with', 'pattern'],
        ['bitly', 'demonstrates', 'pattern'],
        ['storage', 'implements', 'pattern'],
      ] as const) {
        const to = free(from, kind);
        await ok('link', from, verb, to, '--note', "why, from this page's view", '--note-back', `why, from ${to}'s view`);
        expect((JSON.parse((await kb(['related', from, '--json'])).out) as { to: string; note: string }[]).find((r) => r.to === to)?.note).toBe("why, from this page's view");
        await ok('unlink', from, to);
        expect(linked(from, to)).toBe(false);
      }
      const persona = await kb(['unlink', 'persona-identification', 'change-data-capture']);
      expect(persona.code === 0 || persona.err.includes('no relation to'), persona.err).toBe(true);

      await ok('wild', 'circuit-breaker', '--items', '[{"id":"envoy","name":"Envoy","note":"one sentence"}]');
      expect(((await get('circuit-breaker', '--block', 'wild')) as { items: { wild: unknown[] } }).items.wild).toEqual([{ id: 'envoy', name: 'Envoy', note: 'one sentence' }]);
      await ok('production', 'circuit-breaker', '--knobs', '[{"label":"Threshold","note":"When it opens."}]', '--signals', '[]', '--failures', '[]', '--checklist', '["Every call has a timeout"]');
      const text = `A gate in front of one dependency. ${'It counts recent failures and answers from a fallback once there are too many. '.repeat(8)}`.trim();
      const costs = '[{"lead":"Latency.","note":"One more hop."},{"lead":"Upkeep.","note":"Someone owns the thresholds."}]';
      await ok('explain', 'circuit-breaker', '--text', text, '--costs', costs, '--example', 'Checkout calls a fraud check that slows from 50 ms to 10 s.');
      expect(((await get('circuit-breaker', '--block', 'explain')) as { blocks: { explain: string } }).blocks.explain).toBe(
        `${text}\n- [explain-li-1] Latency. One more hop.\n- [explain-li-2] Upkeep. Someone owns the thresholds.\n\nEXAMPLE\n\nCheckout calls a fraud check that slows from 50 ms to 10 s.`,
      );

      await ok('new', 'test-pattern', '--kind', 'pattern', '--band', 'distributed', '--group', 'distributed-resilience', '--name', 'Test Pattern', '--order', '3');
      expect(await get('test-pattern')).toMatchObject({ kind: 'pattern', band: 'distributed', group: 'distributed-resilience', source: 'docs/patterns/distributed/resilience/test-pattern.md' });
      // A principle names its area: the kind is split into two.
      expect((await kb(['new', 'test-principle', '--kind', 'principle', '--name', 'Test', '--order', '1'])).err).toBe(
        '--group: principles is split into areas — name one of principles-craft, principles-systems',
      );
      expect((await kb(['register', 'circuit-breaker', 'tradeoffs-con-1', 'basic'])).err).toContain('retired');
      expect((await kb(['level', 'circuit-breaker', 'tradeoffs-con-1', 'expert'])).err).toBe('reading levels were retired: a page reads at one depth');
      expect(parsePage(sb.read('docs/patterns/distributed/resilience/test-pattern.md')).problems).toEqual([]);
    },
    REAL_TREE_TIMEOUT,
  );
});
