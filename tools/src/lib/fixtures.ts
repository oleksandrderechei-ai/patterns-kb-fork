/**
 * The fixtures more than one suite needs, typed against what the code reads
 * (spec: kb.gates.testing, shared-fixtures).
 *
 * A second hand-written copy of a fixture drifts from the first in silence —
 * both suites stay green while the two copies disagree about what the file
 * looks like, and the day the real shape changes, only one of them notices.
 * So: one base per shape, and a test states its divergence as an edit to that
 * base rather than as a copy of it. The typing is the other half: a fixture
 * passed through `as never` is a typecheck switched off exactly where a stale
 * fixture would show.
 *
 * A fixture belongs here when a second file needs it; one only a single suite
 * reads stays in that suite, next to the assertions that explain it.
 *
 * Excluded from the coverage denominator in `vitest.config.ts`, for the reason
 * `sandbox.ts` is: it is the suite's own scaffolding, and measuring it measures
 * the tests rather than the code.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ALLOWLIST as LAYER_ALLOWLIST } from '../gates/check-claude-md.js';
import { ALLOWLIST as HARNESS_ALLOWLIST, SETTINGS as HARNESS_SETTINGS_FILE } from '../gates/check-harness.js';
import { CONTRACT, FILE as INBOX } from '../gates/check-inbox.js';
import type { Verb } from '../gates/check-relations.js';
import { ALLOWLIST, type Entry } from '../gates/check-test-colocation.js';
import { COUNT_BLOCK, renderGateCount, type Gate, type Registry } from '../gen/gen-gates.js';
import type { PrereqRecord } from '../gen/gen-prerequisites.js';
import { splice } from './generated.js';
import type { PageRow } from './page-refs.js';
import type { RelationRecord, RelationsFile } from './render-relations.js';
import type { LearningPaths, Profile, TourNote } from './render-tours.js';
import { REPO_ROOT, type Sandbox } from './sandbox.js';

/**
 * The filler an explain paragraph carries so it lands inside the 60 to 180 word
 * bounds of KB-014: fixtures name their own opening sentence and share the rest.
 */
const EXPLAIN_FILLER =
  'It costs a little on every call, so measure it against a real workload, keep the counters where every copy of the service can read them, and decide in advance what the caller gets back while the gate is shut. Without it each caller waits out its full timeout, the waiting piles up behind the slow part, and the healthy parts starve for connections that never come back. Teams that skip this step usually find out during the first real outage, at the worst hour.';

/** The costs list KB-014 asks of a pattern: two bullets, each a bold lead and a short clause. */
export const COSTS_LIST = '- **Latency.** Every call pays for one extra hop.\n- **Upkeep.** Someone owns the counters and the thresholds.';

/** An explain block in the shape KB-014 holds: one paragraph opening with `first`, a costs list, then one example. */
export function explainBlock(first: string, heading = 'Explained'): string {
  return `## ${heading}\n<!--meta block=explain-->\n\n${first} ${EXPLAIN_FILLER}\n\n${COSTS_LIST}\n\n**Example.** Checkout calls a fraud check that answers in 50 ms, then one day in 10 s, and the breaker opens after 20 failures.`;
}

/** One row of `docs/data/site-structure.json`: a page, its label, its markdown and its route. */
export interface Row {
  readonly slug: string;
  readonly label: string;
  readonly source: string;
  readonly route: string;
}

/** What an area's hub page says about itself. */
export interface Hub {
  readonly description: string;
  readonly intro: string;
  readonly tags: readonly string[];
}

/** One area of the structure file: a hub, its parent, and its rows in reading order. */
export interface Area {
  readonly id: string;
  readonly label: string;
  readonly nestUnder?: string;
  /** The program that writes this area's pages and hub at build time. */
  readonly generated?: string;
  readonly hub: Hub;
  readonly pages: readonly Row[];
}

/** The structure file, whole. */
export interface Structure {
  readonly version: number;
  readonly updated: string;
  readonly note: string;
  readonly areas: readonly Area[];
}

/** One term of `docs/data/tags.json`. */
export interface Term {
  readonly id: string;
  readonly facet: string;
  /** A topic's hub heading; no other facet carries one. */
  readonly label?: string;
  readonly definition: string;
  readonly applies: readonly string[];
  readonly owner: string;
}

/**
 * A copy of `o` without `keys` — for the fixture that has to say "this field is
 * absent".
 *
 * Absent is not the same as `undefined`: `exactOptionalPropertyTypes` rejects
 * the second, and the code under test reads the first.
 */
export function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...o };
  for (const k of keys) delete copy[k];
  return copy;
}

// ---------------------------------------------------------------------------
// The CI problem matcher
// ---------------------------------------------------------------------------

/** Where CI's problem matcher lives; the contract's finding shapes, as regexps. */
export const MATCHER_FILE = '.github/problem-matchers/kb-gates.json';

export interface MatcherPattern {
  regexp: string;
  code?: number;
  file?: number;
  line?: number;
  message?: number;
}

export interface Matcher {
  owner: string;
  pattern: MatcherPattern[];
}

/** The matchers CI registers, read from the real file every time. */
export function problemMatchers(): Matcher[] {
  const text = fs.readFileSync(path.join(REPO_ROOT, MATCHER_FILE), 'utf8');
  return (JSON.parse(text) as { problemMatcher: Matcher[] }).problemMatcher;
}

/** The owners whose single-line pattern matches `line` — one, for a finding. */
export function matcherOwners(line: string): string[] {
  return problemMatchers()
    .filter((m) => new RegExp((m.pattern[0] as MatcherPattern).regexp).test(line))
    .map((m) => m.owner);
}

// ---------------------------------------------------------------------------
// The colocation allowlist
// ---------------------------------------------------------------------------

/**
 * The bytes `docs/data/allow/test-colocation.json` holds: the source header,
 * then `entries`. Empty by default, the way an excusing list ships.
 */
export function allowlistJson(entries: readonly Entry[] = []): string {
  return `${JSON.stringify({ version: 1, updated: '2026-09-23', note: 'fixture', entries }, null, 2)}\n`;
}

/**
 * A tree the colocation gate passes: one module with its sibling test, and the
 * empty allowlist. A test adds the thing it is about on top.
 */
export function colocationTree(sb: Sandbox): void {
  sb.write(ALLOWLIST, allowlistJson());
  sb.write('tools/src/lib/widget.ts', 'export const widget = 1;\n');
  sb.write('tools/src/lib/widget.test.ts', "import { widget } from './widget.js';\n");
}

// ---------------------------------------------------------------------------
// Context layers
// ---------------------------------------------------------------------------

/** A root layer the context-layers gate passes, routing to `docs/`. */
export const ROOT_LAYER = '# Fixture root\n\nWhat is true everywhere, and links out for the rest.\n\nSee [docs](docs/CLAUDE.md).\n';

/**
 * A directory layer the gate passes — a title, one line on what the directory
 * is, a link back to the root and a `Don't` heading — or one missing the part
 * `omit` names.
 */
export function layerText(dir: string, omit?: 'dont' | 'link'): string {
  return (
    `# Working in ${dir}/\n\nWhat this directory is for.\n` +
    (omit === 'link' ? '' : '\nAuthority: [the root](../CLAUDE.md).\n') +
    (omit === 'dont' ? '' : "\n## Don't\n\n- Don't guess.\n")
  );
}

/**
 * A tree the context-layers gate passes: the root layer, one layer per
 * directory in `dirs`, and the empty placement allowlist.
 */
export function layersTree(sb: Sandbox, dirs: readonly string[] = ['docs', 'scripts']): void {
  sb.write('CLAUDE.md', ROOT_LAYER);
  for (const d of dirs) sb.write(`${d}/CLAUDE.md`, layerText(d));
  sb.write(LAYER_ALLOWLIST, allowlistJson());
}

// ---------------------------------------------------------------------------
// Command claims
// ---------------------------------------------------------------------------

/** A Makefile defining `build` and the single-gate target, and nothing else. */
export const CLAIMS_MAKEFILE = 'build:\n\t@true\n\ngate:\n\t@true\n';

/**
 * A tree the claim gate passes: the Makefile above, and a README whose shell
 * fence runs `commands`, one per line.
 */
export function claimsTree(sb: Sandbox, commands: readonly string[] = ['make build']): void {
  sb.write('Makefile', CLAIMS_MAKEFILE);
  sb.write('README.md', `# Fixture\n\n\`\`\`bash\n${commands.join('\n')}\n\`\`\`\n`);
}

// ---------------------------------------------------------------------------
// The harness files under .claude/
// ---------------------------------------------------------------------------

/** A skill both harness gates pass: a trigger and a boundary, the gap, two steps, "Done means". */
export function skillText(name: string, description = 'Does the widget job. Use when a widget needs it. Not for gadgets.'): string {
  return (
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n` +
    'What goes wrong without it, in one line.\n\n' +
    '1. **Decide the widget.** One decision.\n2. **Check it.** One command.\n\n' +
    '## Done means\n\n- The check passes.\n'
  );
}

/**
 * A verifier definition the shape gate passes: exactly Read, Glob and Grep,
 * a trigger and a boundary, and the reply shape the spec fixes for it.
 */
export function verifierText(name: 'claim-audit' | 'gate-triage'): string {
  const reply =
    name === 'claim-audit'
      ? '```text\n<page>:<line> — "<claim>" — <what the tree says, citing file:line> — wrong | incomplete | stale\n```\n\n' +
        'Then exactly two closing lines, and nothing after them:\n\n' +
        '```text\nchecked: <n> claims on <page>\nuntestable: <the claims it could not decide, or "none">\n```\n'
      : '- **Gate** — the id.\n- **Protects** — the sentence.\n- **Why it is red** — the cause.\n' +
        '- **Repro** — the command.\n- **Fix** — the fix.\n';
  return (
    `---\nname: ${name}\ndescription: "Reads, never writes. Use when a caller needs it. Not for fixing anything."\n` +
    `tools: ["Read", "Glob", "Grep"]\n---\n\n# ${name}\n\nWhat it reads.\n\n## Reply\n\n${reply}`
  );
}

/** A hook that reads its payload, says nothing and exits 0. */
export const QUIET_HOOK = '#!/usr/bin/env bash\ncat > /dev/null\nexit 0\n';

/**
 * `.claude/settings.json` wiring each hook in `hooks` (file names under
 * `.claude/hooks/`) to one event, and allowing `make` in any form.
 */
export function hookSettings(hooks: readonly string[] = ['quiet.sh']): string {
  const wired = hooks.map((h) => ({ type: 'command', command: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/${h}` }));
  const settings = { permissions: { allow: ['Bash(make:*)'] }, hooks: { PostToolUse: [{ matcher: 'Edit', hooks: wired }] } };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Write an executable hook. */
export function writeHook(sb: Sandbox, name: string, body = QUIET_HOOK): void {
  fs.chmodSync(sb.write(`.claude/hooks/${name}`, body), 0o755);
}

/**
 * A harness both harness gates pass: one skill in shape, the two verifiers,
 * one rule, one quiet hook wired in settings.json (which allows `make`), and
 * the shape gate's empty allowlist. A test adds the thing it is about on top.
 */
export function harnessTree(sb: Sandbox): void {
  sb.write('.claude/skills/widget/SKILL.md', skillText('widget'));
  sb.write('.claude/agents/claim-audit.md', verifierText('claim-audit'));
  sb.write('.claude/agents/gate-triage.md', verifierText('gate-triage'));
  sb.write('.claude/rules/widgets.md', '---\ndescription: "How a widget is written."\npaths: ["widgets/**"]\n---\n\n# Widgets\n');
  writeHook(sb, 'quiet.sh');
  sb.write(HARNESS_SETTINGS_FILE, hookSettings());
  sb.write(HARNESS_ALLOWLIST, allowlistJson());
}

// ---------------------------------------------------------------------------
// The bash suite
// ---------------------------------------------------------------------------

/**
 * A bash suite of one file, run by the real `tests/run.sh` and `tests/lib.sh`:
 * two passing assertions, or — `failing` — one of them failing at line 5.
 */
export function bashSuiteTree(sb: Sandbox, failing = false): void {
  sb.copyRepo('tests/run.sh', 'tests/lib.sh');
  sb.write(
    'tests/demo/sum.test.sh',
    [
      '#!/usr/bin/env bash',
      '. "$(dirname "$0")/../lib.sh"',
      'assert_equal 2 "$((1 + 1))" "one and one"',
      '# The line the failing case is on.',
      `assert_equal 3 "$((1 + ${failing ? '1' : '2'}))" "one and two"`,
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// The trap inbox
// ---------------------------------------------------------------------------

/**
 * An inbox page the cap gate passes: a title, the exit-ladder heading with one
 * tier under it, and the open-traps heading, followed by `body`.
 */
export function inboxPage(body = ''): string {
  return `# Trap inbox\n\nA place for traps with no home.\n\n${CONTRACT}\n\n1. **A gate or a test.** The first tier.\n\n## Open traps\n\n${body}`;
}

/** One two-line entry, blank line after, as the inbox holds it. */
export const inboxEntry = (n: number): string =>
  `- **Trap number ${n}.** One line saying what goes wrong,\n  and one saying what to do instead.\n\n`;

/** Write an inbox holding `entries` two-line entries into the sandbox. */
export function inboxTree(sb: Sandbox, entries = 0): void {
  sb.write(INBOX, inboxPage(Array.from({ length: entries }, (_, i) => inboxEntry(i + 1)).join('')));
}

// ---------------------------------------------------------------------------
// The tools workspace, in miniature
// ---------------------------------------------------------------------------

/**
 * A `tools/` the type-check gate compiles clean: strict, no installed types
 * (the sandbox has none to resolve), one source file. A test plants its error
 * on top.
 */
export function typesProject(sb: Sandbox): void {
  sb.write(
    'tools/tsconfig.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          types: [],
          strict: true,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  sb.write('tools/src/a.ts', 'export const answer: number = 42;\n');
}

/**
 * A `tools/` the suite gate runs green: one module, one passing test, and a
 * coverage config whose floors are `floors`. The real `node_modules` is linked
 * in so vitest and its coverage provider resolve; vitest keeps its cache in
 * the sandbox's own `tools/node_modules`, which the sandbox ignores.
 */
export function suiteProject(sb: Sandbox, floors: Record<string, number> = {}): void {
  sb.linkRepo('node_modules');
  sb.write('.gitignore', 'node_modules\ncoverage/\n');
  sb.write('tools/package.json', '{ "type": "module" }\n');
  sb.write(
    'tools/vitest.config.ts',
    [
      "import { defineConfig } from 'vitest/config';",
      '',
      'export default defineConfig({',
      '  test: {',
      "    include: ['src/**/*.test.ts'],",
      '    coverage: {',
      "      provider: 'v8',",
      "      include: ['src/**/*.ts'],",
      "      exclude: ['src/**/*.test.ts'],",
      "      reporter: ['text-summary'],",
      `      thresholds: ${JSON.stringify(floors)},`,
      '    },',
      '  },',
      '});',
      '',
    ].join('\n'),
  );
  sb.write(
    'tools/src/sign.ts',
    'export function sign(n: number): number {\n  if (n < 0) return -1;\n  return 1;\n}\n',
  );
  sb.write(
    'tools/src/sign.test.ts',
    [
      "import { describe, expect, it } from 'vitest';",
      '',
      "import { sign } from './sign.js';",
      '',
      "describe('sign', () => {",
      "  it('is 1 for a positive number', () => {",
      '    expect(sign(3)).toBe(1);',
      '  });',
      '});',
      '',
    ].join('\n'),
  );
}

/**
 * A built site of one page and a flow project the site-e2e gate runs green:
 * one Playwright project opening that page from disk, and one flow reading its
 * heading. With `failing`, the flow expects a heading the page does not have.
 * The real `node_modules` is linked in so the config resolves
 * `@playwright/test`; Playwright writes its results outside the sandbox.
 */
export function e2eProject(sb: Sandbox, failing = false): void {
  sb.linkRepo('node_modules');
  sb.write('.gitignore', 'node_modules\n');
  sb.write('site/dist/index.html', '<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1></main></body></html>');
  sb.write('docs/data/allow/site-e2e.json', JSON.stringify({ version: 1, entries: [] }));
  sb.write(
    'tools/e2e/playwright.config.ts',
    [
      "import os from 'node:os';",
      "import path from 'node:path';",
      "import { defineConfig } from '@playwright/test';",
      '',
      'export default defineConfig({',
      "  testDir: '.',",
      "  testMatch: '*.spec.ts',",
      "  outputDir: path.join(os.tmpdir(), 'kb-e2e-fixture-results'),",
      "  projects: [{ name: 'file-desktop', use: { browserName: 'chromium' } }],",
      '});',
      '',
    ].join('\n'),
  );
  sb.write(
    'tools/e2e/home.spec.ts',
    [
      "import path from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "import { expect, test } from '@playwright/test';",
      '',
      "test('home', async ({ page }) => {",
      "  await page.goto(pathToFileURL(path.resolve(test.info().project.testDir, '../../site/dist/index.html')).href);",
      `  await expect(page.getByRole('heading', { level: 1 })).toHaveText('${failing ? 'Away' : 'Home'}', { timeout: 2000 });`,
      '});',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// The gates registry, and the tree it is held to
// ---------------------------------------------------------------------------

/** The change workflow every registry fixture names for the `ci` run place. */
export const WORKFLOW_FILE = '.github/workflows/validate.yml';

/**
 * The one gate every registry fixture has: local and CI, wired to a real file,
 * with a triage anchor.
 *
 * `wired` is the full command rather than a bare filename because
 * `check-gates-sync` compares it against a workflow step literally, and a
 * fixture that cannot match proves nothing about a gate that does.
 */
export const WIDGET_GATE: Gate = {
  id: 'widget-check',
  name: 'Widget check',
  protects: 'Widgets stay widget-shaped.',
  command: 'make gate G=check-widget',
  wired: 'node_modules/.bin/tsx tools/src/gates/check-widget.ts',
  positional: false,
  fixable: false,
  runs: ['local', 'ci'],
  ci_job: 'validate',
  ci_step: 'Widget check',
  requires: ['node'],
  fix: 'Reshape the widget.',
  runbook: 'docs/reference/triage.md#widget-check',
};

/** A gate a person runs — the case with no CI job and no wiring to compare. */
export const HUMAN_GATE: Gate = {
  id: 'someone-reads-it',
  name: 'Someone reads it',
  protects: 'A person still looks at the thing.',
  command: 'Read it.',
  positional: false,
  fixable: false,
  runs: ['human'],
  requires: [],
  fix: 'Read it.',
  runbook: 'docs/reference/triage.md#someone-reads-it',
};

/**
 * A gate that only has an answer after the merge: CI-only, in a job of its own
 * that an ordinary change skips, and compared by eye rather than by text.
 */
export const AFTER_MERGE_GATE: Gate = {
  id: 'main-push-guard',
  name: 'Main push guard',
  protects: 'A commit that reached main without a merged pull request is loud.',
  command: 'gh api …',
  positional: false,
  fixable: false,
  runs: ['ci'],
  ci_job: 'guard-main',
  ci_step: 'Main push guard',
  requires: [],
  fix: 'Open a pull request containing the change.',
  runbook: 'docs/reference/triage.md#widget-check',
  wired_note: 'a shell body, compared by eye',
};

/**
 * A registry whose two optional maps are always present, so a test writes
 * `r.conditional_jobs['x'] = …` without a guard that could only be dead code.
 */
export type RegistryFixture = Registry & {
  reporting_jobs: Record<string, string>;
  conditional_jobs: Record<string, string>;
};

/**
 * A registry holding {@link WIDGET_GATE}, and `edit` for what a test needs on
 * top of it — a callback rather than a deep merge, so the line stating the
 * difference reads as the reason the test exists.
 */
export function gatesRegistry(edit?: (r: RegistryFixture) => void): RegistryFixture {
  const r: RegistryFixture = {
    version: 1,
    updated: '2026-09-23',
    note: 'fixture',
    runs_values: {
      local: { meaning: 'a make target' },
      ci: { meaning: 'a validate.yml step', workflow: WORKFLOW_FILE },
      human: { meaning: 'a person' },
    },
    setup_steps: {
      'Install repo tooling': 'a dependency step, not a check',
      'Annotate findings on the diff': 'registers the problem matcher',
    },
    reporting_jobs: {},
    required_contexts: { exclude: {} },
    conditional_jobs: {},
    gates: [structuredClone(WIDGET_GATE)],
    symptoms: [],
  };
  edit?.(r);
  return r;
}

/** The same, as the bytes `docs/data/gates.json` holds — trailing newline included. */
export function gatesRegistryJson(edit?: (r: RegistryFixture) => void): string {
  return `${JSON.stringify(gatesRegistry(edit), null, 2)}\n`;
}

/**
 * A change workflow running the widget gate: checkout, install, the matcher
 * (the setup step every gate step's `if:` reads), then one step per gate.
 */
export function workflowYaml(gates: readonly Gate[] = [WIDGET_GATE]): string {
  const steps = gates
    .filter((g) => g.runs.includes('ci') && g.ci_job === 'validate')
    .flatMap((g) => [
      `      - name: ${g.ci_step ?? g.name}`,
      "        if: ${{ !cancelled() && steps.setup.outcome == 'success' }}",
      `        run: ${g.wired ?? 'true'}`,
      '',
    ]);
  return [
    'name: validate',
    '',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main]',
    '',
    'jobs:',
    '  validate:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '',
    '      - name: Install repo tooling',
    '        run: make install',
    '',
    '      - name: Annotate findings on the diff',
    '        id: setup',
    '        run: echo "::add-matcher::.github/problem-matchers/kb-gates.json"',
    '',
    ...steps,
  ].join('\n');
}

/** A Makefile whose `validate` calls the collecting driver and names no gate. */
export const DRIVER_MAKEFILE = [
  'TSX := node_modules/.bin/tsx',
  'DRIVER := $(TSX) tools/src/run-gates.ts',
  '',
  'validate:',
  '\t@$(DRIVER)',
  '',
].join('\n');

/**
 * A triage page with both generated blocks and one hand-written section per
 * heading given. Both blocks are empty, unless a registry is given: then the
 * gate count is filled in from it, the way `make gates` leaves the page.
 */
export function triagePage(headings: readonly string[] = ['Widget check'], reg?: Registry): string {
  const page = [
    '# Triage a red gate',
    '',
    '<!-- gate-count:start -->',
    '<!-- gate-count:end -->',
    '',
    'Hand-written prose that must survive every regeneration.',
    '',
    '<!-- gates-symptoms:start -->',
    '<!-- gates-symptoms:end -->',
    '',
    ...headings.flatMap((h) => [`## ${h}`, '', `- **\`[x] FAIL\`** — what ${h} says, and the fix.`, '']),
  ].join('\n');
  if (reg === undefined) return page;
  const filled = splice(page, [{ name: COUNT_BLOCK, lines: renderGateCount(reg) }]);
  return 'text' in filled ? filled.text : page;
}

/**
 * A whole consistent tree around a registry: the registry, the change
 * workflow, a driver Makefile, the triage page and each gate's program on
 * disk. Every gate is driven locally through `local_command = wired`.
 */
export function gatesTree(sb: Sandbox, reg: RegistryFixture = gatesRegistry()): void {
  for (const g of reg.gates) {
    if (g.wired !== undefined && g.runs.includes('local') && g.local_command === undefined) g.local_command = g.wired;
  }
  sb.write('docs/data/gates.json', `${JSON.stringify(reg, null, 2)}\n`);
  sb.write(WORKFLOW_FILE, workflowYaml(reg.gates));
  sb.write('Makefile', DRIVER_MAKEFILE);
  sb.write('docs/reference/triage.md', triagePage(reg.gates.map((g) => g.name), reg));
  for (const g of reg.gates) {
    const program = /tools\/src\/(?:gates|gen)\/[\w-]+\.ts/.exec(g.wired ?? '')?.[0];
    if (program !== undefined) sb.write(program, '// a gate program the fixture registry claims\n');
  }
}

// ---------------------------------------------------------------------------
// The page tree the content gates read (frontmatter, docs-style, kb-shape)
// ---------------------------------------------------------------------------

/** One page's block, as `pageText` writes it: every key in declared order. */
export interface PageBlock {
  title: string;
  description: string;
  area: string;
  owner: string;
  tags: string;
  status: string;
  /** Lines written after the page keys, such as `solves: [a, b, c]`. */
  extra: string[];
}

export const PAGE_BLOCK: PageBlock = {
  title: 'Alpha',
  description: 'A page that declares itself properly',
  area: 'caching',
  owner: 'Tests',
  tags: '[caching, latency]',
  status: 'stable',
  extra: [],
};

/**
 * A page: its block (a key set to null is not declared), the H1 from the
 * title, an intro, then `body`. The default body is one plain section.
 */
export function pageText(edit: Partial<Record<keyof Omit<PageBlock, 'extra'>, string | null>> & { extra?: string[] } = {}, body = '## About\n\nMore.\n'): string {
  const b = { ...PAGE_BLOCK, ...edit };
  const keys = (['title', 'description', 'area', 'owner', 'tags', 'status'] as const).filter((k) => b[k] !== null);
  return [
    '---',
    ...keys.map((k) => `${k}: ${b[k] as string}`),
    ...(b.extra ?? []),
    '---',
    '',
    `# ${(edit.title ?? PAGE_BLOCK.title) as string}`,
    '',
    'What this page is, and who it is for.',
    '',
    body,
  ].join('\n');
}

/**
 * A pattern page's body that keeps every KB rule of the fixture content model:
 * description, explain, tradeoffs (two groups), sketch, relationships.
 */
export const KIND_BODY = [
  '## What it is',
  '<!--meta block=description-->',
  '',
  'It does one thing, and it does it well.',
  '',
  explainBlock('At a cost.'),
  '',
  '## Trade-offs',
  '<!--meta block=tradeoffs-->',
  '',
  '### Pros',
  '<!--meta polarity=pro-->',
  '',
  '- Fast.',
  '- Cheap.',
  '',
  '### Cons',
  '<!--meta polarity=con-->',
  '',
  '- Stale.',
  '',
  '## Sketch',
  '<!--meta block=sketch-->',
  '',
  '```typescript summary="TypeScript — the whole idea"',
  'const hit = cache.get(key);',
  '```',
  '',
  '## How it relates',
  '<!--meta block=relationships-->',
  '',
  'It pairs with its neighbours.',
  '',
].join('\n');

/** A theme page's body: description and explain only, and no `solves`. */
export const THEME_BODY = KIND_BODY.slice(0, KIND_BODY.indexOf('## Trade-offs'));

/** The content model the fixture pages keep: two kinds, the real grammar's lists. */
export function contentModelJson(): string {
  const model = {
    version: 1,
    updated: '2026-09-24',
    note: 'fixture',
    kinds: [
      { id: 'pattern', folder: 'patterns', blocks: ['description', 'explain', 'tradeoffs', 'usage', 'sketch', 'selfcheck', 'relationships'], optional: ['usage', 'selfcheck'] },
      { id: 'theme', folder: 'themes', blocks: ['description', 'explain', 'relationships'], optional: ['relationships'] },
    ],
    groups: { tradeoffs: { fact: 'polarity', values: ['pro', 'con'] }, usage: { fact: 'polarity', values: ['when', 'avoid'] } },
    facts: { block: ['description', 'explain', 'tradeoffs', 'usage', 'sketch', 'selfcheck', 'relationships', 'requirements'], polarity: ['pro', 'con', 'when', 'avoid'], requirement: ['fr', 'nfr'] },
    suffix: { idPattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', keys: [], fenceKeys: ['caption', 'summary', 'wide'] },
    sketchLangs: [
      { id: 'typescript', label: 'TypeScript', definition: 'fixture' },
      { id: 'text', label: 'Plain text', definition: 'fixture' },
      { id: 'go', label: 'Go', definition: 'fixture', only: { kind: 'pattern', area: 'concurrency' } },
    ],
  };
  return `${JSON.stringify(model, null, 2)}\n`;
}

/** One structure row, as the structure file holds it. */
export const structureRow = (source: string, label = 'Alpha'): Record<string, string> => ({
  slug: path.posix.basename(source, '.md'),
  label,
  source,
  route: `/${source.slice('docs/'.length).replace(/\.md$/, '.html')}`,
});

/** The structure file over `areas` (id → its rows' sources); `patterns` and `themes` are parents. */
export function structureJson(areas: Readonly<Record<string, readonly string[]>>): string {
  const hub = { description: 'fixture', intro: 'fixture', tags: ['caching', 'latency'] };
  const parents = ['patterns', 'themes'];
  const list = [
    ...parents.map((id) => ({ id, label: id, hub, pages: [] as Record<string, string>[] })),
    ...Object.entries(areas).map(([id, sources]) => ({
      id,
      label: id,
      ...(id === 'caching' ? { nestUnder: 'patterns' } : id === 'themes-data' ? { nestUnder: 'themes' } : {}),
      hub,
      pages: sources.map((s) => structureRow(s)),
    })),
  ];
  return `${JSON.stringify({ version: 1, updated: '2026-09-24', note: 'fixture', areas: list }, null, 2)}\n`;
}

/** The fixture pages' paths. */
export const PAGE_ALPHA = 'docs/patterns/caching/alpha.md';
export const PAGE_THEME = 'docs/themes/tour.md';
export const PAGE_GUIDE = 'docs/reference/guide.md';

/**
 * A page tree every content gate passes: a pattern page, a theme page and a
 * hand-written reference page, each in the structure file; a docs layer; the
 * fixture content model. A test states its divergence as an edit on top.
 */
export function pagesTree(sb: Sandbox): void {
  sb.write('docs/data/content-model.json', contentModelJson());
  sb.write('docs/data/site-structure.json', structureJson({ caching: [PAGE_ALPHA], 'themes-data': [PAGE_THEME], reference: [PAGE_GUIDE] }));
  sb.write(PAGE_ALPHA, pageText({ extra: ['aliases: [A]', 'solves: [one symptom, another symptom, a third symptom]'] }, KIND_BODY));
  sb.write(PAGE_THEME, pageText({ title: 'Tour', area: 'themes-data' }, THEME_BODY));
  sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', tags: '[testing, readability]' }));
  sb.write('docs/CLAUDE.md', '# Working in docs/\n\nA layer, not a page.\n');
}

/** The fixture docs map's path. */
export const MAP_PAGE = 'docs/README.md';

/**
 * A docs map with a full page block: one hand-written row per entry of
 * `links` (label → path from `docs/`), then the markers of the block gen-map
 * owns, around `block`.
 */
export function mapText(links: Readonly<Record<string, string>>, block: readonly string[] = []): string {
  const rows = Object.entries(links).map(([label, to]) => `| [${label}](${to}) | you need it |`);
  const body = ['## Pages', '', '| Page | Read it when |', '| --- | --- |', ...rows, '', '<!-- docs-map:start -->', '', ...block, ...(block.length > 0 ? [''] : []), '<!-- docs-map:end -->', ''];
  return pageText({ title: 'Docs map', area: 'reference', tags: '[testing, readability]' }, body.join('\n'));
}

/** `pagesTree` with a docs map whose rows link each of its three pages. */
export function mappedTree(sb: Sandbox): void {
  pagesTree(sb);
  sb.write(MAP_PAGE, mapText({ Alpha: 'patterns/caching/alpha.md', Tour: 'themes/tour.md', Guide: 'reference/guide.md' }));
}

// ---------------------------------------------------------------------------
// The vocabulary: glossary, ban allowlist, product registry
// ---------------------------------------------------------------------------

export const GLOSSARY_FILE = 'docs/data/glossary.json';
export const VOCABULARY_ALLOWLIST = 'docs/data/allow/vocabulary.json';

/**
 * A sound glossary banning "gizmo" in favour of "widget", its empty
 * allowlist, and one clean page. `plant` adds a page using the banned word.
 */
export function glossaryTree(sb: Sandbox, plant = false): void {
  const widget = { id: 'widget', term: 'widget', definition: 'A part.', aliases: [], avoid: ['gizmo'], scope: 'house', owner: 'O', see: [] };
  sb.write(GLOSSARY_FILE, `${JSON.stringify({ version: 1, updated: '2026-09-24', note: 'fixture', scopes: { house: 'The owner decides.' }, terms: [widget] }, null, 2)}\n`);
  sb.write(VOCABULARY_ALLOWLIST, allowlistJson());
  sb.write('docs/page.md', '# A page\n\nPlain words.\n');
  if (plant) sb.write('docs/planted.md', '# Planted\n\nA gizmo.\n');
}

export const PRODUCTS_FILE = 'docs/data/products.json';

/**
 * A product registry every entry of which a capability page's mapping table
 * uses; `dead` adds an entry no cell names.
 */
export function productsTree(sb: Sandbox, dead = false): void {
  const aws: Record<string, string> = { 'Amazon S3': 'https://docs.aws.amazon.com/s3/' };
  if (dead) aws['Amazon EFS'] = 'https://docs.aws.amazon.com/efs/';
  const products = { aws, azure: { 'Blob Storage': 'https://learn.microsoft.com/azure/storage/blobs/' }, google: {}, oss: {} };
  sb.write(PRODUCTS_FILE, `${JSON.stringify({ version: 1, updated: '2026-09-24', note: 'fixture', columns: ['aws', 'azure', 'google', 'oss'], products }, null, 2)}\n`);
  sb.write(
    'docs/capabilities/storage.md',
    [
      '# Storage', '', '## Across clouds', '', '<!--meta block=mapping-->', '',
      '| Capability | AWS | Azure | Google Cloud | Open source |', '| --- | --- | --- | --- | --- |',
      '| Object store | Amazon S3 | Blob Storage | Cloud Storage | MinIO |', '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// The relations and learning-path files, over a small structure
// ---------------------------------------------------------------------------
//
// A structure file with a handful of published pages, the verb table, one
// capability page with a mapping table, and the two data files over them.
// Each builder writes a tree the relations and learning-path gates pass; a
// test then breaks exactly one thing in it. Data files are written the way
// the converter writes them — two-space `JSON.stringify` plus a newline — so a
// line a test reads off the text is the line a finding names.

export const HEADER = { version: 1, updated: '2026-09-24', note: 'Fixture data file.' };

/** Five verb pairs: one symmetric, four directed, each listed written-first. */
export const VERBS: readonly Verb[] = [
  { id: 'combines-with', label: 'Combines with', inverse: 'combines-with' },
  { id: 'variant-of', label: 'Variant of', inverse: 'has-variant' },
  { id: 'has-variant', label: 'Has variant', inverse: 'variant-of' },
  { id: 'prevents-hazard', label: 'Prevents', inverse: 'mitigated-by' },
  { id: 'mitigated-by', label: 'Mitigated by', inverse: 'prevents-hazard' },
  { id: 'exposed-to', label: 'Exposed to', inverse: 'threatens' },
  { id: 'threatens', label: 'Threatens', inverse: 'exposed-to' },
  { id: 'implements', label: 'Implements', inverse: 'implemented-by' },
  { id: 'implemented-by', label: 'Implemented by', inverse: 'implements' },
];

/** A structure row as these trees write it: the part of a page row the file itself holds. */
export type FixtureRow = Pick<PageRow, 'slug' | 'source' | 'route'>;

/** A row under `docs/<folder>/<slug>.md`, routed at `/<folder>/<slug>.html` (dialect D-02). */
export const row = (folder: string, slug: string): FixtureRow => ({
  slug,
  source: `docs/${folder}/${slug}.md`,
  route: `/${folder}/${slug}.html`,
});

/** The published pages of the relations fixture, by area. */
export const AREAS: Readonly<Record<string, readonly FixtureRow[]>> = {
  patterns: [row('patterns', 'alpha'), row('patterns', 'beta'), row('patterns', 'gamma')],
  hazards: [row('hazards', 'delta')],
  capabilities: [row('capabilities', 'store')],
  themes: [row('themes', 'starting')],
};

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A structure file listing `areas`, each area's rows in order. */
export function structureFileJson(areas: Readonly<Record<string, readonly FixtureRow[]>> = AREAS): string {
  return json({
    ...HEADER,
    areas: Object.entries(areas).map(([id, rows]) => ({
      id,
      label: id,
      pages: rows.map((r) => ({ slug: r.slug, label: r.slug, source: r.source, route: r.route })),
    })),
  });
}

/** A capability page whose mapping table has two body rows: mapping-row-1 and mapping-row-2. */
export const STORE_PAGE = [
  '---',
  'title: Store',
  '---',
  '',
  '# Store',
  '',
  '## What each cloud calls it',
  '<!--meta block=mapping-->',
  '',
  '| Capability | AWS |',
  '| --- | --- |',
  '| Blobs | S3 |',
  '| Queues | SQS |',
  '',
].join('\n');

/** An edge a test plants: any record at all, the keys a relations record may hold typed as it types them. */
export interface RecordFixture {
  readonly a: string;
  readonly verb: string;
  readonly b: string;
  readonly note_a?: string;
  readonly note_b?: string;
  readonly [key: string]: unknown;
}

/** Today's shape of a clean file: every verb family, a custom group and a mapped row. */
export const RELATION_RECORDS: readonly RelationRecord[] = [
  { a: 'alpha', verb: 'combines-with', b: 'beta', note_a: 'Alpha uses beta.', note_b: 'Beta uses alpha.' },
  { a: 'gamma', verb: 'variant-of', b: 'alpha', note_a: 'A narrower alpha.', note_b: '' },
  { a: 'alpha', verb: 'prevents-hazard', b: 'delta', note_a: 'Keeps delta away.', note_b: 'Alpha keeps it away.', group_a: 'Guards' },
  { a: 'store', verb: 'implements', b: 'alpha', note_a: 'Sold ready-made.', note_b: 'Buy it.', maps_a: 'mapping-row-2', maps_label_a: 'Queues' },
];

export function relationsJson(records: readonly unknown[] = RELATION_RECORDS, extra: Readonly<Record<string, unknown>> = {}): string {
  return json({ ...HEADER, relations: records, ...extra });
}

/** The content model's verb table, and nothing else the relations gate reads. */
export function verbModelJson(verbs: unknown = VERBS): string {
  return json({ ...HEADER, relations: { verbs, order: VERBS.map((v) => v.id) } });
}

/** A tree the relations gate passes; `records` replaces the edges. */
export function relationsTree(sb: Sandbox, records: readonly unknown[] = RELATION_RECORDS, extra: Readonly<Record<string, unknown>> = {}): void {
  sb.write('docs/data/site-structure.json', structureFileJson());
  sb.write('docs/data/content-model.json', verbModelJson());
  sb.write('docs/data/relations.json', relationsJson(records, extra));
  sb.write('docs/capabilities/store.md', STORE_PAGE);
}

/** A profile a test plants: the keys it may leave out, and any it may add. */
export interface ProfileFixture {
  readonly id: string;
  readonly label?: string;
  readonly stages: readonly unknown[];
  readonly [key: string]: unknown;
}

/** The theme's tour: alpha then beta, each with its note. */
export const PROFILES: readonly Profile[] = [
  { id: 'starting', label: 'Starting out', stages: ['/patterns/alpha.html', '/patterns/beta.html'] },
];

export const note = (role: string): TourNote => ({ role, tour: `${role}.`, fluency: `${role}, briefly.` });

export const NOTES: Readonly<Record<string, Readonly<Record<string, TourNote>>>> = {
  '/patterns/alpha.html': { starting: note('Start here') },
  '/patterns/beta.html': { starting: note('Then this') },
};

/** `notes: null` leaves the key out, as the spec's own files do. */
export function learningPathsJson(profiles: readonly unknown[] = PROFILES, notes: unknown = NOTES): string {
  return json({ ...HEADER, profiles, ...(notes === null ? {} : { notes }) });
}

/** A tree the learning-path gate passes; `profiles` and `notes` replace the data (`null`: no notes key). */
export function learningTree(
  sb: Sandbox,
  profiles: readonly unknown[] = PROFILES,
  notes: unknown = NOTES,
  areas: Readonly<Record<string, readonly FixtureRow[]>> = AREAS,
): void {
  sb.write('docs/data/site-structure.json', structureFileJson(areas));
  sb.write('docs/data/learning-paths.json', learningPathsJson(profiles, notes));
}

/** The 1-based line of the `nth` line of `text` holding `needle`. */
export function lineOf(text: string, needle: string, nth = 1): number {
  const hits = text.split('\n').flatMap((l, i) => (l.includes(needle) ? [i + 1] : []));
  const at = hits[nth - 1];
  if (at === undefined) throw new Error(`no line ${nth} holds ${needle}`);
  return at;
}

// ---------------------------------------------------------------------------
// The learning trees: pages with a status, the prerequisite graph, its sources
// ---------------------------------------------------------------------------
//
// Unlike the relations trees, every page here exists on disk with the
// frontmatter a page carries — title, description, area, owner, tags
// and status — because the frontmatter gate, the prerequisite gate and the
// generators all read it. Each builder writes a tree every reader passes; a
// test then breaks exactly one thing in it.
//
// The clean graph, as records and as the edges that build it:
//
//   alpha   requires beta        related gamma    alpha prerequisite beta
//   beta    requires delta                        beta prerequisite delta
//   gamma                        related alpha    alpha combines-with gamma
//   delta
//
// Every record is reached by an edge alone, so no learning path is needed.

/** The published pages: three patterns, a hazard and the theme a tour renders on. */
export const PAGES: Readonly<Record<string, readonly FixtureRow[]>> = {
  patterns: [row('patterns', 'alpha'), row('patterns', 'beta'), row('patterns', 'gamma')],
  hazards: [row('hazards', 'delta')],
  themes: [row('themes', 'starting')],
};

export const ALL_ROWS: readonly FixtureRow[] = Object.values(PAGES).flat();

/** A published page's row, by slug. */
export function rowOf(slug: string): FixtureRow {
  const r = ALL_ROWS.find((x) => x.slug === slug);
  if (r === undefined) throw new Error(`no fixture page ${slug}`);
  return r;
}

export const titleOf = (slug: string): string => `${(slug[0] as string).toUpperCase()}${slug.slice(1)}`;
export const descriptionOf = (slug: string): string => `What ${slug} is, in one line`;

/**
 * A page as the converter writes one, `status` last among the page keys.
 * `status: null` leaves the line out; `body` follows the H1 and intro.
 */
export function learningPageText(slug: string, status: string | null = 'stable', body = ''): string {
  const folder = rowOf(slug).source.split('/')[1] as string;
  return [
    '---',
    `title: ${titleOf(slug)}`,
    `description: ${descriptionOf(slug)}`,
    `area: ${folder}`,
    'owner: Kb Tests',
    'tags: [testing]',
    ...(status === null ? [] : [`status: ${status}`]),
    '---',
    '',
    `# ${titleOf(slug)}`,
    '',
    `${descriptionOf(slug)}.`,
    ...(body === '' ? [] : ['', body]),
    '',
  ].join('\n');
}

/** Write every page, each `stable` unless `statuses` says otherwise (`null`: no status line). */
export function writePages(sb: Sandbox, statuses: Readonly<Record<string, string | null>> = {}): void {
  for (const r of ALL_ROWS) sb.write(r.source, learningPageText(r.slug, r.slug in statuses ? (statuses[r.slug] as string | null) : 'stable'));
}

/** A whole record for a fixture page: its label, definition and route come from the page. */
export function record(id: string, requires: readonly string[] = [], related: readonly string[] = []): PrereqRecord {
  const r = ALL_ROWS.find((x) => x.slug === id);
  return {
    id,
    label: titleOf(id),
    definition: descriptionOf(id),
    route: r?.route ?? `/patterns/${id}.html`,
    requires,
    related,
  };
}

/** The clean graph (see the section header). */
export const PREREQ_RECORDS: readonly PrereqRecord[] = [
  record('alpha', ['beta'], ['gamma']),
  record('beta', ['delta']),
  record('gamma', [], ['alpha']),
  record('delta'),
];

export function prerequisitesJson(records: readonly unknown[] = PREREQ_RECORDS, header: Readonly<Record<string, unknown>> = HEADER): string {
  return json({ ...header, records });
}

/** A tree the prerequisite gate passes: the structure, every page, the graph. */
export function prereqTree(
  sb: Sandbox,
  records: readonly unknown[] = PREREQ_RECORDS,
  statuses: Readonly<Record<string, string | null>> = {},
): void {
  sb.write('docs/data/site-structure.json', structureFileJson(PAGES));
  writePages(sb, statuses);
  sb.write('docs/data/prerequisites.json', prerequisitesJson(records));
}

/** The relations fixture's verbs, plus the pair a record's requires list is built from. */
export const LEARNING_VERBS: readonly Verb[] = [
  ...VERBS,
  { id: 'prerequisite', label: 'Requires', inverse: 'enables' },
  { id: 'enables', label: 'Enables', inverse: 'prerequisite' },
];

/** A content model with its own group order: every verb, in list order. */
export function learningModelJson(verbs: readonly { id: string }[] = LEARNING_VERBS, updated = HEADER.updated): string {
  return json({ ...HEADER, updated, relations: { verbs, order: verbs.map((v) => v.id) } });
}

/** The edges the clean graph is built from (see the section header). */
export const EDGES: readonly RelationRecord[] = [
  { a: 'alpha', verb: 'prerequisite', b: 'beta', note_a: 'Read beta first.', note_b: 'Then alpha.' },
  { a: 'beta', verb: 'prerequisite', b: 'delta', note_a: 'Know the hazard.', note_b: '' },
  { a: 'alpha', verb: 'combines-with', b: 'gamma', note_a: 'Alpha with gamma.', note_b: 'Gamma with alpha.' },
  { a: 'gamma', verb: 'variant-of', b: 'beta', note_a: 'A narrower beta.', note_b: '' },
];

/**
 * The sources gen-prerequisites builds the graph from — structure, pages,
 * content model and relations — with the stages every published route, so
 * the learning-path gate has nothing to note either. The structure also
 * declares the `reference` area, with no rows: the generator's own page says
 * `area: reference`, and the frontmatter gate reads that against the area ids.
 * The tree is committed: a data file whose content changes is dated by HEAD's
 * committer date.
 */
export function sourceTree(
  sb: Sandbox,
  edges: readonly unknown[] = EDGES,
  statuses: Readonly<Record<string, string | null>> = {},
): void {
  sb.write('docs/data/site-structure.json', structureFileJson({ ...PAGES, reference: [] }));
  writePages(sb, statuses);
  sb.write('docs/data/content-model.json', learningModelJson());
  sb.write('docs/data/relations.json', json({ ...HEADER, relations: edges }));
  sb.write(
    'docs/data/learning-paths.json',
    json({ ...HEADER, profiles: [{ id: 'starting', label: 'Starting out', stages: ALL_ROWS.map((r) => r.route) }] }),
  );
  sb.commit('the sources');
}

/** The committer date of the sandbox's HEAD, as a generated data file carries it. */
export const headOf = (sb: Sandbox): string => sb.git('log', '-1', '--format=%cs', 'HEAD').stdout.trim();

// ---------------------------------------------------------------------------
// The structure file and the tag list (spec: kb.data.structure, kb.data.tags)
// ---------------------------------------------------------------------------

const DATA_HEADER = { version: 1, updated: '2026-09-24', note: 'A fixture data file.' };

/** A coherent structure-file tree: two areas, three mirrored rows, the AREAS tuple, a learning path. */
export function structureTree(sb: Sandbox): void {
  const hub = { description: 'What the area holds.', intro: 'Start here.', tags: ['caching', 'latency'] };
  sb.write(
    'docs/data/site-structure.json',
    `${JSON.stringify(
      {
        ...DATA_HEADER,
        areas: [
          { id: 'patterns', label: 'Patterns', hub, pages: [] },
          {
            id: 'caching',
            label: 'Caching',
            nestUnder: 'patterns',
            hub,
            pages: ['one', 'two', 'three'].map((slug) => ({ slug, label: slug, source: `docs/caching/${slug}.md` })),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  sb.write('site/src/lib/types.ts', "export const AREAS = ['patterns', 'caching'] as const;\nexport const TAGS = ['caching', 'resilience', 'latency', 'cloud'] as const;\n");
  sb.write('docs/data/learning-paths.json', `${JSON.stringify({ ...DATA_HEADER, profiles: [{ id: 'reader', stages: ['/caching/one/', '/caching/two/'] }] }, null, 2)}\n`);
  for (const slug of ['one', 'two', 'three']) sb.write(`docs/caching/${slug}.md`, `# ${slug}\n`);
}

/** A clean tagged tree: a four-term tag list, its tuple, an empty allowlist and three pages using every term. */
export function tagsTree(sb: Sandbox): void {
  const term = (id: string, facet: string, label?: string): Record<string, unknown> => ({
    id,
    facet,
    ...(label === undefined ? {} : { label }),
    definition: `What ${id} means.`,
    applies: ['page'],
    owner: 'Tests',
  });
  sb.write(
    'docs/data/tags.json',
    `${JSON.stringify(
      {
        ...DATA_HEADER,
        facets: { topic: 'What is the page about?', skill: 'What does the reader do?', language: 'What machinery does it name?' },
        terms: [term('caching', 'topic', 'Caching'), term('resilience', 'topic', 'Resilience'), term('latency', 'skill'), term('cloud', 'language')],
      },
      null,
      2,
    )}\n`,
  );
  sb.write('site/src/lib/types.ts', "export const AREAS = ['caching'] as const;\nexport const TAGS = ['caching', 'resilience', 'latency', 'cloud'] as const;\n");
  sb.write('docs/data/allow/tags.json', `${JSON.stringify({ ...DATA_HEADER, entries: [] }, null, 2)}\n`);
  const page = (title: string, tags: string): string =>
    `---\ntitle: ${title}\ndescription: A page.\narea: caching\nowner: Tests\ntags: [${tags}]\nstatus: stable\n---\n\n# ${title}\n`;
  sb.write('docs/caching/one.md', page('One', 'caching, latency'));
  sb.write('docs/caching/two.md', page('Two', 'resilience, latency'));
  sb.write('docs/caching/three.md', page('Three', 'caching, cloud'));
}

/**
 * The time a test over the whole real tree may take: reading, converting or
 * round-tripping all 382 pages. Each costs seconds on an idle machine; beside
 * the rest of the suite, and other checkouts' suites on the same cores, the
 * converter's own check has taken 44 of vitest's default 60.
 */
export const REAL_TREE_TIMEOUT = 300_000;

// ---------------------------------------------------------------------------
// kb.mjs v2 (tools/src/kb): a small docs tree
// ---------------------------------------------------------------------------
//
// One page of each of the seven kinds plus a second pattern, a theme filed in a
// designs tier (kind by folder, dialect X-03) and a reference page that is no
// kind at all, with the five data files they read. Every construct the reader
// renders appears at least once: suffix ids, polarity and
// requirement groups, nested lists, variations, a prose sketch, fences with
// summaries and captions, a mermaid click, tables, the three
// marked regions. The content model is the real one, copied: the reader's shape
// is the repo's. Everything else is written here.

const kbFrontmatter = (fields: Readonly<Record<string, string>>): string =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n\n`;

const kbHeader = (title: string, area: string, extra: Readonly<Record<string, string>> = {}): string =>
  kbFrontmatter({ title, description: `The ${title.toLowerCase()} page`, area, owner: 'Test Owner', tags: '[resilience, latency]', status: 'stable', ...extra });

const kbFence = '```';

const KB_PAGES: Readonly<Record<string, string>> = {
  'docs/patterns/distributed/resilience/breaker.md': `${kbHeader('Breaker', 'distributed-resilience', {
    aliases: '[CB, fuse]',
    solves: '[my threads hang on a dead dependency, "one failing call, and the whole service falls"]',
    favourite: 'true',
  })}<!-- GENERATED by a converter from site/x.html. Do not edit this file. -->

# Breaker

Stops calling a failing thing — so callers **fail fast**.

## What it is
<!--meta block=description-->

A dependency stops answering and your threads wait. See [Retry](./retry.md), [the storm](../../../hazards/storm.md#cost), [itself](./breaker.md), [a site](https://example.com) and [a file](./notes.txt). Deeper detail for seniors. Retry, once more: [again](./retry.md) and [the queue](../../messaging/queue.md).

${explainBlock('Tune it against a slow dependency.')}

## How it works
<!--meta block=structure-->

~~~mermaid caption="How does the \`gate\` stop calls?"
flowchart LR
  A --> B
  click B "/patterns/distributed/resilience/retry.html"
  click A "/patterns/nowhere.html"
~~~

${kbFence}mermaid caption="The states."
stateDiagram-v2
  [*] --> Closed
${kbFence}

## Variations
<!--meta block=variations-->

- **Count-based** — Trip after N failures.
- **[Retry](./retry.md) guarded** — Wraps a retry.
- A plain variation with no name.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- Fails fast.
- Frees threads.

### Cons
<!--meta polarity=con-->

- Another thing to tune.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- You call a remote service.
  - Nested detail one.
  - Nested detail two.
- The call holds a thread.

  It holds a socket too.

### Avoid when
<!--meta polarity=avoid-->

- The call is local.

A trailing smell paragraph.

## Code sketch
<!--meta block=sketch-->

~~~typescript summary="TypeScript — the \`smallest\` breaker"
class Breaker {}
~~~

${kbFence}python summary="Python — shared"
class Shared: pass
${kbFence}

## In the wild
<!--meta block=wild-->

- **opossum** — The Node breaker: \`errorThresholdPercentage\` & more. {#wild-opossum}
- **[Hystrix](https://github.com/Netflix/Hystrix)** — The JVM one. {#wild-hystrix}
- A bare example with no name. {#wild-bare}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Failure threshold** — The count at which it opens (\`failureRateThreshold\`).
- **Window** — Measured over time.
- A knob with no label.

### Signals to watch
<!--meta polarity=signal-->

- **State** — Closed or open.

### Failure modes under load
<!--meta polarity=failure-->

- **Flapping** — Opens and closes.

### Readiness checklist
<!--meta polarity=check-->

- Every call has a timeout
- Operators can **force** it

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Steady](../../../themes/steady.md) — Stop hammering it. {#fluency-steady}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

**Combines with**

- [Retry](./retry.md) — Retry transient errors

**Prevents**

- [Storm](../../../hazards/storm.md) — Fails *fast*

<!-- relationships:end -->
`,

  'docs/patterns/distributed/resilience/retry.md': `${kbHeader('Retry', 'distributed-resilience', { solves: '[transient errors fail my requests]' })}# Retry

Tries again.

## What it is
<!--meta block=description-->

Try again after a pause, as the [breaker](./breaker.md) allows.

${explainBlock('Add jitter.')}

## How it works
<!--meta block=structure-->

Calls repeat.

## Variations
<!--meta block=variations-->

- **Fixed** — Same pause.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- Recovers blips.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- Errors are transient.

## Code sketch
<!--meta block=sketch-->

${kbFence}typescript
retry();
${kbFence}

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

**Combines with**

- [Breaker](./breaker.md) — Trip on sustained errors

<!-- relationships:end -->
`,

  'docs/patterns/messaging/queue.md': `${kbHeader('Queue', 'messaging', { tags: '[messaging]' })}# Queue

Holds work.

## What it is
<!--meta block=description-->

Work waits in line.

${explainBlock('Backpressure.')}

## How it works
<!--meta block=structure-->

In, then out.

## Variations
<!--meta block=variations-->

- **FIFO** — In order.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- Smooths bursts.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- Load is bursty.

## Code sketch
<!--meta block=sketch-->

${kbFence}
queue.push(job);
${kbFence}

## How it relates
<!--meta block=relationships-->
`,

  'docs/themes/steady.md': `${kbHeader('Steady', 'themes')}# Steady

Stay up.

## The question
<!--meta block=description-->

How do you stay up?

${explainBlock('Draw isolation lines.')}

## The trade-space
<!--meta block=tradespace-->

Patience against self-preservation.

## Patterns that implement the choice
<!--meta block=tour-->

<!-- tour:start -->

### [Breaker](../patterns/distributed/resilience/breaker.md) {#tour-breaker}

Trip open after enough failures.

### [Retry](../patterns/distributed/resilience/retry.md) {#tour-retry}

Try again, briefly.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Reach for |
| --- | --- |
| Stop calling a failing thing | [Breaker](../patterns/distributed/resilience/breaker.md) |
| Ride out a blip | [Retry](../patterns/distributed/resilience/retry.md) |

## Related areas
<!--meta block=siblings-->

- [Loop](./loop.md) — The other theme.
- A sibling with no link.
`,

  'docs/themes/loop.md': `${kbHeader('Loop', 'designs-mid')}# Loop

A theme filed in a designs tier.

## The question
<!--meta block=description-->

What loops?

${explainBlock('Three.')}

## The trade-space
<!--meta block=tradespace-->

Speed against care.

## Patterns that implement the choice
<!--meta block=tour-->

<!-- tour:start -->

### [Queue](../patterns/messaging/queue.md) {#tour-queue}

It holds the loop's work.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Reach for |
| --- | --- |
| Hold work | Queue |

## Related areas
<!--meta block=siblings-->

- [Steady](./steady.md) — The first theme.
`,

  'docs/hazards/storm.md': `${kbHeader('Storm', 'hazards', { solves: '[retries pile up during an outage]' })}# Storm

Retries that make an outage worse.

## What goes wrong
<!--meta block=description-->

Every client retries at once.

${explainBlock('Budgets cap it.')}

## Why it happens
<!--meta block=causes-->

No jitter.

## What it costs
<!--meta block=cost-->

An outage that lasts.

## How to avoid it
<!--meta block=mitigation-->

Add a [breaker](../patterns/distributed/resilience/breaker.md).

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

**Mitigated by**

- [Breaker](../patterns/distributed/resilience/breaker.md) — Fails fast

<!-- relationships:end -->
`,

  'docs/principles/quick.md': `${kbHeader('Quick', 'principles')}# Quick

Fail early.

## What it says
<!--meta block=description-->

Report a fault where it starts.

${explainBlock('Weigh it against availability.')}

## Why it helps
<!--meta block=rationale-->

Faults stay near their cause.

## How to apply it
<!--meta block=applying-->

Validate at the boundary.

## Where it goes too far
<!--meta block=overreach-->

Crashing on a recoverable blip.

## How it relates
<!--meta block=relationships-->
`,

  'docs/designs/shortener.md': `${kbHeader('Shortener', 'designs-mid', { solves: '[my short links collide]' })}# Shortener

Short names for long links.

## Understanding the problem
<!--meta block=description-->

**Q1 — How many links?** → NFR: scale. About a million a day.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

- Shorten a link.
- Expand a code.

### Non-functional
<!--meta requirement=nfr-->

- **Scale**
  - A million a day.
  - Reads dominate.

**Additional — later** {#requirements-h-additional}

- Custom aliases.
- Expiry.

{#requirements-ul-additional}

## Core entities & data design
<!--meta block=entities-->

- **Link** — The mapping.

  ${kbFence}sql summary="Link table"
  create table link (code text primary key);
  ${kbFence}

## How the system is built
<!--meta block=architecture-->

An API in front of a cache.

| Component | Role |
| --- | --- |
| API | Takes writes |
| Cache | Serves reads |

{#architecture-table-1}

## Deep dives
<!--meta block=deepdives-->

### 1 · Codes that never collide → NFR: scale

Use a counter.

> **Why hashing fails**
>
> Two links can share a hash.


## Limitations & trade-offs
<!--meta block=tradeoffs-->

The counter is a single point.

### Strengths
<!--meta polarity=pro-->

- Simple.

### Risks
<!--meta polarity=con-->

- A hot counter.

## How it relates
<!--meta block=relationships-->
`,

  'docs/capabilities/queues.md': `${kbHeader('Queues', 'capabilities', { tags: '[messaging, cloud]' })}# Queues

Managed queues across clouds.

## What it is
<!--meta block=description-->

A queue you rent.

${explainBlock('Mind the lock-in.')}

## Capabilities
<!--meta block=capabilities-->

- **Point-to-point** — One consumer per message.

## Across the clouds
<!--meta block=mapping-->

| Capability | AWS | Azure |
| --- | --- | --- |
| Point-to-point | Amazon SQS | Service Bus |

## Choosing
<!--meta block=choosing-->

Start with the default.

## Portability
<!--meta block=portability-->

- **Visibility timeout** — Named differently.

## How it relates
<!--meta block=relationships-->
`,

  'docs/comparisons/brokers.md': `${kbHeader('Brokers', 'comparisons', { aliases: '[Kafka, RabbitMQ]' })}# Brokers

Kafka against RabbitMQ.

## The decision
<!--meta block=description-->

Which broker?

${explainBlock('Operations cost.')}

## Contenders
<!--meta block=contenders-->

- **Kafka** — A log.
- **RabbitMQ** — A queue.

## The matrix
<!--meta block=matrix-->

| Condition | Kafka | RabbitMQ |
| --- | --- | --- |
| Replay | yes | no |

## Choosing
<!--meta block=choosing-->

Replay decides it.

## How it relates
<!--meta block=relationships-->
`,

  'docs/reference/notes.md': `${kbFrontmatter({ title: 'Notes', description: 'Not a page of any kind', area: 'reference', owner: 'Test Owner', tags: '[testing]', status: 'stable' })}# Notes\n\nA reference page.\n`,
};

const KB_HEAD = { version: 1, updated: '2026-09-24', note: 'Fixture.' };

const kbRow = (slug: string, source: string): Row => ({
  slug,
  label: slug,
  source,
  route: `/${source.replace(/^docs\//, '').replace(/\.md$/, '.html')}`,
});

const kbArea = (id: string, nestUnder: string | null, rows: readonly [string, string][]): Area => ({
  id,
  label: id,
  ...(nestUnder === null ? {} : { nestUnder }),
  hub: { description: id, intro: id, tags: [] },
  pages: rows.map(([s, src]) => kbRow(s, src)),
});

const KB_STRUCTURE: Structure = {
  ...KB_HEAD,
  areas: [
    kbArea('patterns', null, []),
    kbArea('distributed', 'patterns', []),
    kbArea('distributed-resilience', 'distributed', [
      ['breaker', 'docs/patterns/distributed/resilience/breaker.md'],
      ['retry', 'docs/patterns/distributed/resilience/retry.md'],
    ]),
    kbArea('messaging', 'patterns', [['queue', 'docs/patterns/messaging/queue.md']]),
    kbArea('hazards', null, [['storm', 'docs/hazards/storm.md']]),
    kbArea('designs', null, []),
    kbArea('designs-mid', 'designs', [
      ['shortener', 'docs/designs/shortener.md'],
      ['loop', 'docs/themes/loop.md'],
    ]),
    kbArea('themes', null, [['steady', 'docs/themes/steady.md']]),
    kbArea('principles', null, [['quick', 'docs/principles/quick.md']]),
    kbArea('capabilities', null, [['queues', 'docs/capabilities/queues.md']]),
    kbArea('comparisons', null, [['brokers', 'docs/comparisons/brokers.md']]),
    kbArea('reference', null, [['notes', 'docs/reference/notes.md']]),
  ],
};

const KB_RELATIONS: RelationsFile = {
  ...KB_HEAD,
  relations: [
    { a: 'breaker', verb: 'combines-with', b: 'retry', note_a: 'Retry transient errors', note_b: 'Trip on sustained errors' },
    { a: 'breaker', verb: 'prevents-hazard', b: 'storm', note_a: 'Fails *fast*', note_b: 'Fails fast' },
  ],
};

const KB_PATHS: LearningPaths = {
  ...KB_HEAD,
  profiles: [
    { id: 'steady', label: 'Steady', stages: ['/patterns/distributed/resilience/breaker.html', '/patterns/distributed/resilience/retry.html'] },
    { id: 'loop', label: 'Loop', stages: ['/patterns/messaging/queue.html', '/patterns/gone.html'] },
    { id: 'ghost', label: 'Ghost', stages: [] },
  ],
  notes: {
    '/patterns/distributed/resilience/breaker.html': { steady: { role: 'Stop hammering it', tour: 'Trip open after enough failures.', fluency: 'Stop hammering it.' } },
    '/patterns/distributed/resilience/retry.html': { steady: { role: 'Ride out blips', tour: 'Try again, briefly.', fluency: '' } },
    '/patterns/messaging/queue.html': { loop: { role: 'Holds the work', tour: "It holds the loop's work.", fluency: '' } },
  },
};

const KB_TAGS: { readonly version: number; readonly updated: string; readonly note: string; readonly terms: readonly Term[] } = {
  ...KB_HEAD,
  terms: ['resilience', 'latency', 'messaging', 'cloud', 'testing'].map((id) => ({ id, facet: 'skill', definition: id, applies: ['page'], owner: 'Test Owner' })),
};

/** Synonyms the fixture's search bridge reads, where scripts/kb.mjs reads them. */
const KB_SYNONYMS = {
  version: 1,
  updated: '2026-01-01',
  note: 'fixture',
  curated: { fuse: ['breaker'], hang: ['wait'] },
  expansions: { stall: ['hang'], fuse: ['trip'] },
};

/** The kb fixture tree plus a search oracle holding `cases`, for the search-oracle gate. */
export function searchOracleTree(sb: Sandbox, cases: readonly unknown[]): void {
  writeKbFixture(sb.dir);
  sb.write('docs/data/search-oracle.json', `${JSON.stringify({ version: 1, updated: '2026-09-30', note: 'fixture', cases }, null, 2)}\n`);
}

/** Write the whole fixture under `dir`. */
export function writeKbFixture(dir: string): void {
  const put = (rel: string, text: string): void => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  for (const [rel, text] of Object.entries(KB_PAGES)) put(rel, text);
  const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
  put('docs/data/site-structure.json', json(KB_STRUCTURE));
  put('docs/data/relations.json', json(KB_RELATIONS));
  put('docs/data/learning-paths.json', json(KB_PATHS));
  put('docs/data/tags.json', json(KB_TAGS));
  put('docs/data/content-model.json', fs.readFileSync(path.join(REPO_ROOT, 'docs/data/content-model.json'), 'utf8'));
  put('docs/data/search-synonyms.json', json(KB_SYNONYMS));
}
