/**
 * The oracle scenarios that span more than one gate (spec:
 * acceptance/oracle.md: kb.gates, kb.data, kb.harness, kb.learning and the
 * real-tree half of kb.generation). Each scenario that belongs to a single
 * unit lives in that unit's own suite, named by its id; these are the ones
 * about the whole set — the driver running real gate programs over a
 * sandbox, and every registered row keeping the contract.
 *
 * The sandbox borrows the real `node_modules` by link so `tsx` resolves, and
 * runs the real gate programs from this checkout by absolute path, so every
 * trial exercises the code that ships.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IGNORE_LINES } from './gates/check-build-untracked.js';
import { spec as layerGate } from './gates/check-claude-md.js';
import { spec as shapeGate } from './gates/check-harness.js';
import { programsOf } from './gates/check-gates-sync.js';
import { ALLOWLIST } from './gates/check-test-colocation.js';
import { spec as genGates, SRC, TRIAGE, type Gate, type Registry } from './gen/gen-gates.js';
import { run } from './lib/exec.js';
import {
  ALL_ROWS,
  allowlistJson,
  bashSuiteTree,
  claimsTree,
  colocationTree,
  DRIVER_MAKEFILE,
  e2eProject,
  EDGES,
  gatesRegistry,
  gatesTree,
  harnessTree,
  glossaryTree,
  HEADER,
  json,
  row,
  structureFileJson,
  inboxTree,
  inboxEntry,
  KIND_BODY,
  PAGE_ALPHA,
  PAGE_GUIDE,
  pagesTree,
  pageText,
  inboxPage,
  layersTree,
  layerText,
  MAP_PAGE,
  mappedTree,
  matcherOwners,
  skillText,
  productsTree,
  searchOracleTree,
  learningPageText,
  learningPathsJson,
  learningTree,
  PREREQ_RECORDS,
  prereqTree,
  record,
  relationsJson,
  relationsTree,
  rowOf,
  sourceTree,
  structureTree,
  suiteProject,
  tagsTree,
  triagePage,
  typesProject,
  VOCABULARY_ALLOWLIST,
  WIDGET_GATE,
  WORKFLOW_FILE,
  workflowYaml,
  type RegistryFixture,
} from './lib/fixtures.js';
import type { GateSpec } from './lib/gate.js';
import { spec as frontmatterGate } from './gates/check-doc-frontmatter.js';
import { spec as prerequisitesGate } from './gates/check-prerequisites.js';
import { spec as learningPathsGate } from './gates/check-learning-paths.js';
import { spec as relationsGate } from './gates/check-relations.js';
import { spec as genPrerequisites, REFERENCE as PREREQ_REFERENCE } from './gen/gen-prerequisites.js';
import { spec as genRelations } from './gen/gen-relations.js';
import { spec as genTours } from './gen/gen-tours.js';
import { TRACKS_FILE } from './lib/tracks.js';
import { frontmatterMany } from './lib/frontmatter.js';
import { STATUSES } from './lib/page-block.js';
import { markers } from './lib/generated.js';
import { formatHtml } from './site/site-format.js';
import { builtPage, builtSite, docsTree, formattedSite } from './site/site-fixtures.js';
import { writeParitySite } from './site/parity-fixtures.js';
import { OUT as SYNONYMS_PAGE, render as renderSynonyms, SRC as SYNONYMS } from './gen/gen-search-synonyms.js';

/** A page clean for both accessibility gates: a language, one title, words in <main>. */
const A11Y_PAGE = `<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>t</h1><p>${'word '.repeat(40)}</p></main></body></html>`;

/** A theme's tour staging `stages` (slugs) beside one edge: a2a requires agent. */
function tourOrderTree(s: Sandbox, stages: string[]): void {
  const slugs = ['tour', 'agent', 'a2a'];
  const route = (slug: string): string => `/patterns/${slug}.html`;
  s.write(
    'docs/data/site-structure.json',
    JSON.stringify({ areas: [{ id: 'patterns', pages: slugs.map((slug) => ({ slug, route: route(slug), source: `docs/patterns/${slug}.md` })) }] }),
  );
  s.write('docs/data/relations.json', JSON.stringify({ relations: [{ a: 'a2a', verb: 'prerequisite', b: 'agent', note_a: '', note_b: '' }] }));
  s.write('docs/data/learning-paths.json', JSON.stringify({ profiles: [{ id: 'tour', label: 'Tour', stages: stages.map(route) }] }, null, 2));
}
import { capture, makeSandbox, REPO_ROOT, type Captured, type Sandbox } from './lib/sandbox.js';

/** Six published theme pages, each a learning-paths profile, and four tracks, the first walking `firstTrack`. */
function tracksTree(s: Sandbox, firstTrack: string[]): void {
  const slugs = ['t1', 't2', 't3', 't4', 't5', 't6'];
  const rows = slugs.map((slug) => row('themes', slug));
  const track = (id: string, themes: string[]): Record<string, unknown> => ({ id, label: id, blurb: `${id} blurb`, themes });
  s.write('docs/data/site-structure.json', structureFileJson({ themes: rows }));
  s.write('docs/data/learning-paths.json', learningPathsJson(slugs.map((id) => ({ id, label: id, stages: [] })), null));
  for (const r of rows) s.write(r.source, `---\ntitle: ${r.slug}\nstatus: stable\n---\n\n# ${r.slug}\n`);
  const tiers = Object.fromEntries(slugs.map((slug) => [slug, 'core']));
  s.write(TRACKS_FILE, json({ ...HEADER, tracks: [track('a', firstTrack), track('b', ['t2', 't3', 't4']), track('c', ['t3', 't4', 't5']), track('d', ['t4', 't5', 't6'])], tiers }));
}
import { drive, shellQuote, type DriverIo } from './run-gates.js';

/** Replace `from` with `to` in a sandbox file, failing loudly when the fixture no longer holds `from`. */
function edit(sb: Sandbox, file: string, from: string, to: string): void {
  const cur = sb.read(file);
  if (!cur.includes(from)) throw new Error(`fixture drifted: ${file} no longer contains ${JSON.stringify(from)}`);
  sb.write(file, cur.replace(from, to));
}

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

/** The whole-set run: the driver over the sandbox's registry, captured. */
async function wholeSet(argv: readonly string[] = []): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: DriverIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
  const status = await drive(argv, io, sb.dir);
  return { status, out: out.join('\n'), err: err.join('\n'), output: [...out, ...err].join('\n') };
}

/** A real gate program of this checkout, as a command the sandbox's driver can spawn. */
const realProgram = (program: string): string =>
  `node_modules/.bin/tsx ${shellQuote(path.join(REPO_ROOT, program))}`;

/** A row that runs a real program over the sandbox, locally, compared by eye. */
function realRow(id: string, name: string, program: string): Gate {
  return {
    id,
    name,
    protects: `${name} holds.`,
    command: realProgram(program),
    wired_note: 'the oracle runs the real program by absolute path',
    local_command: realProgram(program),
    positional: false,
    fixable: false,
    runs: ['local'],
    requires: ['node'],
    fix: `Repair what ${name} names.`,
    runbook: `${TRIAGE}#${name.toLowerCase().replace(/ /g, '-')}`,
  };
}

// ---------------------------------------------------------------------------
// A tree with one gate carrying all five pieces
// ---------------------------------------------------------------------------

const WIDGET_PROGRAM = 'tools/src/gates/check-widget.ts';
const WIDGET_TEST = 'tools/src/gates/check-widget.test.ts';
const WIDGET_SOURCE = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  '',
  "import { main, type GateSpec } from '../lib/gate.js';",
  '',
  'export const spec: GateSpec = {',
  "  name: 'widget-check',",
  "  usage: 'usage: check-widget',",
  '  run(ctx) {',
  "    if (fs.existsSync(path.join(ctx.root, 'widget.bad'))) ctx.fail('widget.bad', 'the widget is bent');",
  "    return '[widget-check] the widget is straight';",
  '  },',
  '};',
  '',
  'main(spec, import.meta.url);',
  '',
].join('\n');

/** The real Makefile's `gate` recipe, lifted as it is, minus the install stamp. */
function realGateTarget(): string {
  const lines = fs.readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('gate:'));
  const recipe: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith('\t')) break;
    recipe.push(l);
  }
  return ['gate:', ...recipe, ''].join('\n');
}

/**
 * The five pieces of the widget gate — program, test, row, CI step, triage
 * section — plus two real gates that check them: the sync gate and the
 * colocation gate.
 */
function fivePieces(): RegistryFixture {
  const reg = gatesRegistry((r) => {
    r.gates.push(
      realRow('gates-sync', 'Gate registry in sync', 'tools/src/gates/check-gates-sync.ts'),
      realRow('test-colocation', 'Test colocation', 'tools/src/gates/check-test-colocation.ts'),
    );
  });
  sb.linkRepo('node_modules');
  sb.write('.gitignore', 'node_modules\n');
  gatesTree(sb, reg);
  sb.write('Makefile', `${DRIVER_MAKEFILE}\n${realGateTarget()}`);
  sb.copyRepo('tools/src/lib/gate.ts');
  sb.write('tools/src/lib/gate.test.ts', '// the contract’s own suite, in the real tree\n');
  sb.write(WIDGET_PROGRAM, WIDGET_SOURCE);
  sb.write(WIDGET_TEST, "import { spec } from './check-widget.js';\n");
  sb.write(ALLOWLIST, allowlistJson());
  return reg;
}

describe('kb.gates', () => {
  it('gates-O1: a gate with all five pieces is green; removing any one turns the whole set red', async () => {
    const reg = fivePieces();
    const green = await wholeSet();
    expect(green.status, green.output).toBe(0);
    expect(green.out).toMatch(/^✓ 3 gates, no findings/);

    const snapshot = sb.snapshot();
    const restore = (): void => {
      for (const [f, bytes] of snapshot) if (!bytes.startsWith('-> ')) sb.write(f, bytes);
    };
    const trial = async (remove: () => void, needle: string): Promise<void> => {
      remove();
      const r = await wholeSet();
      expect(r.status, r.output).toBe(1);
      expect(r.err).toContain(needle);
      restore();
      expect((await wholeSet()).status).toBe(0);
    };

    // A missing row: the sync gate names the program no row runs.
    await trial(() => {
      sb.write(SRC, `${JSON.stringify({ ...reg, gates: reg.gates.filter((g) => g.id !== 'widget-check') }, null, 2)}\n`);
      sb.write(TRIAGE, triagePage(reg.gates.map((g) => g.name), { ...reg, gates: reg.gates.filter((g) => g.id !== 'widget-check') }));
    }, `[gates-sync] FAIL ${WIDGET_PROGRAM}: is a check gate no registry entry runs`);
    // A missing CI step: the sync gate names the workflow file.
    await trial(
      () => sb.write(WORKFLOW_FILE, workflowYaml([])),
      `[gates-sync] FAIL ${WORKFLOW_FILE}: no step named "Widget check"`,
    );
    // A missing triage section: the sync gate names the triage page.
    await trial(
      () => sb.write(TRIAGE, triagePage(['Gate registry in sync', 'Test colocation'], reg)),
      `[gates-sync] FAIL ${TRIAGE}: has no heading "#widget-check"`,
    );
    // A missing test: the colocation gate names the program.
    await trial(() => sb.rm(WIDGET_TEST), `[test-colocation] FAIL ${WIDGET_PROGRAM}: has no test`);
    // A missing program: its row runs nothing, and the sync gate says so.
    await trial(() => sb.rm(WIDGET_PROGRAM), `widget-check runs ${WIDGET_PROGRAM}, which does not exist`);
  });

  it('gates-O2: a finding from the gate alone, from the whole set and from its row’s command is one line', async () => {
    fivePieces();
    sb.write('widget.bad', 'bent\n');
    const finding = '[widget-check] FAIL widget.bad: the widget is bent';

    const alone = run('bash', ['-c', WIDGET_GATE.wired as string], sb.dir);
    expect(alone.status).toBe(1);
    expect(alone.stderr).toBe(`${finding}\n`);
    expect(matcherOwners(finding)).toEqual(['kb-gate']);

    const whole = await wholeSet();
    expect(whole.status).toBe(1);
    expect(whole.err.split('\n')).toContain(finding);

    // The row's `command` — `make gate G=check-widget`, through the real
    // Makefile's recipe — reproduces the same line.
    const viaMake = run('bash', ['-c', WIDGET_GATE.command], sb.dir);
    expect(viaMake.stderr.split('\n')).toContain(finding);
  });

  it('gates-O3: one row added — the sync gate names the missing CI step, triage section and stale total', async () => {
    const reg = gatesRegistry();
    gatesTree(sb, reg);
    const { spec: sync } = await import('./gates/check-gates-sync.js');
    const clean = await capture(sync, [], sb.dir);
    expect(clean.status, clean.output).toBe(0);

    const added = gatesRegistry((r) => {
      r.gates.push({
        ...structuredClone(WIDGET_GATE),
        id: 'gadget-check',
        name: 'Gadget check',
        command: 'make gate G=check-gadget',
        wired: 'node_modules/.bin/tsx tools/src/gates/check-gadget.ts',
        local_command: 'node_modules/.bin/tsx tools/src/gates/check-gadget.ts',
        ci_step: 'Gadget check',
        runbook: `${TRIAGE}#gadget-check`,
      });
    });
    sb.write(SRC, `${JSON.stringify(added, null, 2)}\n`);
    sb.write('tools/src/gates/check-gadget.ts', '// the new gate\n');

    const r = await capture(sync, [], sb.dir);
    expect(r.status).toBe(1);
    expect(r.err).toContain(`[gates-sync] FAIL ${WORKFLOW_FILE}: no step named "Gadget check"`);
    expect(r.err).toContain(`[gates-sync] FAIL ${TRIAGE}: has no heading "#gadget-check"`);
    expect(r.err).toContain(`[gates-sync] FAIL ${TRIAGE}: its gate count block is stale — the registry holds 2 gates`);
  });

  /** The fixture pages, a synonym table over their words and its rendered page. */
  const synonymsTree = (s: Sandbox, expansions: Record<string, string[]> = { lag: ['performance'] }): void => {
    docsTree(s);
    const table = { curated: { cache: ['caching'] }, expansions };
    s.write(SYNONYMS, `${JSON.stringify({ version: 1, updated: '2026-09-30', note: 'n', ...table, expansionMeta: { entries: Object.keys(expansions).length } }, null, 2)}\n`);
    s.write(SYNONYMS_PAGE, renderSynonyms(table));
  };

  // A row's clean tree can be a real site build (RT-2), a few seconds each on an idle machine.
  it('gates-O4: every registered row’s program exits 2 on --nope, 1 on a planted problem, 0 when clean', { timeout: 240_000 }, async () => {
    const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, SRC), 'utf8')) as Registry;

    /** How to make each row's program see a clean tree, and one with a problem. */
    // `rules`: the row's findings are in the rule-id shape, `<RULE-ID> <file>:<line> <message>`.
    const trees: Record<string, { clean(s: Sandbox): void; plant(s: Sandbox): void; rules?: true }> = {
      typecheck: {
        clean: typesProject,
        plant: (s) => s.write('tools/src/a.ts', "export const answer: number = 'forty-two';\n"),
      },
      'json-sanity': {
        clean: (s) => s.write('a.json', '{}\n'),
        plant: (s) => s.write('b.json', '{\n  oops\n}\n'),
      },
      'build-untracked': {
        clean: (s) => s.write('.gitignore', `${IGNORE_LINES.join('\n')}\n`),
        plant: (s) => {
          s.write('site/dist/x.html', '<p>x</p>\n');
          s.git('add', '-f', 'site/dist/x.html');
        },
      },
      'gates-sync': {
        clean: (s) => gatesTree(s),
        plant: (s) => s.write(WORKFLOW_FILE, workflowYaml().replace('- name: Widget check', '- name: Widget checks')),
      },
      'gates-fresh': {
        clean: (s) => {
          gatesTree(s);
          s.rm(TRIAGE);
          s.write(TRIAGE, triagePage());
        },
        plant: (s) => s.write('docs/reference/gates.md', `${s.read('docs/reference/gates.md')}hand-typed\n`),
      },
      'test-colocation': {
        clean: colocationTree,
        plant: (s) => s.write('tools/src/lib/untested.ts', 'export {};\n'),
      },
      claims: {
        clean: (s) => claimsTree(s),
        plant: (s) => claimsTree(s, ['make nope']),
      },
      'context-layers': {
        clean: (s) => layersTree(s),
        plant: (s) => s.write('tests/run.sh', 'true\n'),
      },
      'inbox-cap': {
        clean: (s) => inboxTree(s, 3),
        plant: (s) => inboxTree(s, 21),
      },
      'harness-shape': {
        clean: harnessTree,
        plant: (s) => s.write('.claude/stray/notes.md', 'x\n'),
      },
      'harness-routes': {
        clean: harnessTree,
        plant: (s) => s.write('.claude/skills/widget/SKILL.md', `${skillText('widget')}\nSee [the page](../../../docs/gone.md).\n`),
      },
      frontmatter: {
        clean: pagesTree,
        plant: (s) => s.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', owner: null })),
      },
      'docs-style': {
        clean: pagesTree,
        plant: (s) => s.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference' }, '#### Too deep\n')),
        rules: true,
      },
      'kb-shape': {
        clean: (s) => {
          pagesTree(s);
          s.write('docs/data/allow/kb-shape.json', allowlistJson());
        },
        plant: (s) => s.write(PAGE_ALPHA, pageText({ extra: ['solves: [only one]'] }, KIND_BODY)),
        rules: true,
      },
      'docs-map': {
        clean: mappedTree,
        plant: (s) => s.write('docs/reference/unlisted.md', pageText({ title: 'Unlisted', area: 'reference' })),
      },
      'map-fresh': {
        clean: mappedTree,
        plant: (s) => s.write(MAP_PAGE, s.read(MAP_PAGE).replace('| fixture |', '| by hand |')),
      },
      'mermaid-parse': {
        clean: (s) => s.write('docs/reference/flow.md', '# Flow\n\n```mermaid\nflowchart LR\n  a --> b\n```\n'),
        plant: (s) => s.write('docs/reference/flow.md', '# Flow\n\n```mermaid\nflowchart LR\n  a -->\n```\n'),
      },
      'repo-links': {
        clean: mappedTree,
        plant: (s) => s.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference' }, 'See [the gone page](gone.md).\n')),
      },
      vocabulary: {
        clean: (s) => glossaryTree(s),
        plant: (s) => glossaryTree(s, true),
      },
      'glossary-fresh': {
        clean: (s) => glossaryTree(s),
        plant: (s) => s.write('docs/reference/glossary.md', `${s.read('docs/reference/glossary.md')}hand-typed\n`),
      },
      'search-synonyms': {
        clean: (s) => synonymsTree(s),
        plant: (s) => synonymsTree(s, { lag: ['nowhere'] }),
      },
      'search-synonyms-fresh': {
        clean: (s) => synonymsTree(s),
        plant: (s) => {
          synonymsTree(s);
          s.write(SYNONYMS_PAGE, `${s.read(SYNONYMS_PAGE)}hand-typed\n`);
        },
      },
      'search-oracle': {
        clean: (s) => searchOracleTree(s, [{ q: 'breaker', top: ['breaker'] }]),
        plant: (s) => searchOracleTree(s, [{ q: 'breaker', top: ['queue'] }]),
      },
      // The record gate over the kb fixture and the published schemas; the plant leaves a page's marked region open, which the record builder refuses.
      'kb-record-schema': {
        clean: (s) => {
          searchOracleTree(s, [{ q: 'breaker', top: ['breaker'] }]);
          s.copyRepo('tools/src/contract/schema');
        },
        plant: (s) => {
          const page = 'docs/patterns/distributed/resilience/breaker.md';
          s.write(page, s.read(page).replace('<!-- relationships:end -->\n', ''));
        },
      },
      products: {
        clean: (s) => productsTree(s),
        plant: (s) => productsTree(s, true),
      },
      relations: {
        clean: (s) => relationsTree(s),
        plant: (s) => s.write('docs/data/relations.json', relationsJson([{ a: 'alpha', verb: 'combines-with', b: 'ghost', note_a: '', note_b: '' }])),
      },
      'learning-paths': {
        clean: (s) => learningTree(s),
        plant: (s) => learningTree(s, [{ id: 'starting', label: 'Starting', stages: ['/patterns/gone.html'] }], null),
      },
      // Four tracks over six published theme pages; the plant stages a theme with no page.
      tracks: {
        clean: (s) => tracksTree(s, ['t1', 't2', 't3']),
        plant: (s) => tracksTree(s, ['t1', 't2', 'ghost']),
      },
      // A theme's tour holds a page after its prerequisite; the plant swaps the two stages.
      'tour-order': {
        clean: (s) => tourOrderTree(s, ['agent', 'a2a']),
        plant: (s) => tourOrderTree(s, ['a2a', 'agent']),
      },
      prerequisites: {
        clean: (s) => prereqTree(s),
        plant: (s) => prereqTree(s, [...PREREQ_RECORDS, record('starting')]),
      },
      'prerequisites-fresh': {
        clean: (s) => sourceTree(s),
        plant: (s) => s.write(PREREQ_REFERENCE, `${s.read(PREREQ_REFERENCE)}hand-typed\n`),
      },
      // The two block generators, each over the learning tree with its markers in place.
      'relations-fresh': {
        clean: (s) => {
          sourceTree(s, EDGES);
          const [open, close] = markers('relationships');
          const block = ['## How it relates', '<!--meta block=relationships-->', '', open, close].join('\n');
          for (const slug of ['alpha', 'beta', 'gamma', 'delta']) s.write(rowOf(slug).source, learningPageText(slug, 'stable', block));
        },
        plant: (s) => edit(s, rowOf('alpha').source, 'Alpha with gamma.', 'Alpha with gamma, by hand.'),
      },
      'tours-fresh': {
        clean: (s) => {
          sourceTree(s);
          s.write('docs/data/learning-paths.json', learningPathsJson());
          const block = (name: string): string => {
            const [open, close] = markers(name);
            return [`## ${name}`, `<!--meta block=${name}-->`, '', open, close].join('\n');
          };
          s.write(rowOf('starting').source, learningPageText('starting', 'stable', block('tour')));
          for (const slug of ['alpha', 'beta', 'gamma']) s.write(rowOf(slug).source, learningPageText(slug, 'stable', block('fluency')));
        },
        plant: (s) => edit(s, rowOf('starting').source, 'Start here.', 'Start there.'),
      },
      // The data lane's rows (P3b): the structure file, the tag list and its reference page.
      'site-structure': {
        clean: structureTree,
        plant: (s) => s.write('site/src/lib/types.ts', "export const AREAS = ['patterns'] as const;\n"),
      },
      tags: {
        clean: tagsTree,
        plant: (s) => s.write('docs/caching/three.md', s.read('docs/caching/three.md').replace('tags: [caching, cloud]', 'tags: [cloud, caching]')),
      },
      'tags-fresh': {
        clean: tagsTree,
        plant: (s) => s.write('docs/reference/tags.md', `${s.read('docs/reference/tags.md')}hand-typed\n`),
      },
      // The site gates, over a small built site in the post-build shape.
      'site-portable': {
        clean: (s) => builtSite(s),
        plant: (s) => edit(s, 'site/dist/patterns/caching/beta.html', '<p>Beta.</p>', '<p><a href="/x.html">x</a></p>'),
      },
      // The HTML, the record and the markdown of the parity fixture's twelve pages; the plant has a page say a word differently.
      'site-parity': {
        clean: (s) => writeParitySite(s),
        plant: (s) => edit(s, 'site/dist/principles/boundary.html', 'Check each value once, at the edge.', 'Check each value twice, at the edge.'),
      },
      'site-absence': {
        clean: (s) => formattedSite(s),
        plant: (s) =>
          s.write(
            'site/dist/patterns/caching/beta.html',
            formatHtml(builtPage({ route: '/patterns/caching/beta.html', title: 'Beta', area: 'caching', body: '<p class="note" data-topic="x">Beta.</p>' })),
          ),
      },
      'site-links': {
        clean: (s) => builtSite(s),
        plant: (s) => edit(s, 'site/dist/patterns/caching/beta.html', '<p>Beta.</p>', '<p><a href="./gone.html">x</a></p>'),
      },
      'site-budget': {
        clean: (s) => builtSite(s),
        plant: (s) =>
          s.write('site/dist/patterns/caching/beta.html', builtPage({ route: '/patterns/caching/beta.html', title: 'Beta', area: 'caching', body: `<p>${'x'.repeat(400_000)}</p>` })),
      },
      // The two accessibility gates (P7): one clean page, then a planted defect.
      'site-accessibility': {
        clean: (s) => {
          s.write('site/dist/index.html', A11Y_PAGE);
          s.write('docs/data/allow/site-a11y.json', '{"bandMax":0}');
        },
        plant: (s) => s.write('site/dist/index.html', A11Y_PAGE.replace(' lang="en"', '')),
      },
      // The registry loop runs the real browser gate, and whether a browser is
      // installed differs by machine, so its plant is the one failure every
      // machine shares: no built site. A planted violation, through a fake
      // browser, is check-site-axe.test.ts's.
      'site-axe': {
        clean: (s) => s.write('site/dist/index.html', A11Y_PAGE),
        plant: (s) => s.rm('site/dist'),
      },
      // The reader flows run the real browser too, so the plant is again the
      // failure every machine shares; a failing flow is check-site-e2e.test.ts's.
      'site-e2e': {
        clean: (s) => e2eProject(s),
        plant: (s) => s.rm('site/dist'),
      },
      // The two site gates that read source, not a build.
      'site-tokens': {
        clean: (s) => s.write('site/src/components/Card/card.css', '.kb-card { color: var(--sl-color-text); }\n'),
        plant: (s) => s.write('site/src/components/Card/card.css', '.kb-card { color: #336699; }\n'),
      },
      'site-hooks': {
        clean: (s) => {
          s.write('docs/data/allow/site-hooks.json', allowlistJson());
          s.write('site/src/components/Menu/Menu.astro', '<nav data-kb-menu></nav>\n');
          s.write('site/src/components/Menu/menu.client.ts', "export const start = (d: Document) => d.querySelector('[data-kb-menu]');\n");
        },
        plant: (s) => s.write('site/src/components/Menu/Menu.astro', '<nav data-kb-menus></nav>\n'),
      },
      'tests-bash': {
        clean: (s) => bashSuiteTree(s),
        plant: (s) => bashSuiteTree(s, true),
      },
      'tests-vitest': {
        clean: (s) => suiteProject(s),
        plant: (s) => s.write('tools/src/sign.test.ts', "import { it, expect } from 'vitest';\nit('fails', () => expect(1).toBe(2));\n"),
      },
    };
    expect(Object.keys(trees).sort()).toEqual(real.gates.map((g) => g.id).sort());

    for (const row of real.gates) {
      const program = programsOf(row)[0] as string;
      const args = (row.wired ?? '').split(program)[1]?.trim().split(/\s+/).filter((a) => a !== '') ?? [];
      const mod = (await import(pathToFileURL(path.join(REPO_ROOT, program)).href)) as { spec: GateSpec };
      const tree = trees[row.id] as { clean(s: Sandbox): void; plant(s: Sandbox): void; rules?: true };
      const s = makeSandbox();
      try {
        tree.clean(s);
        // A generator's clean tree is one it has written.
        if (args.includes('--check')) await capture(mod.spec, [], s.dir);

        const before = s.snapshot();
        const misuse = await capture(mod.spec, [...args, '--nope'], s.dir);
        expect(misuse.status, `${row.id} --nope`).toBe(2);
        expect(misuse.out, row.id).toBe('');
        expect(s.snapshot(), `${row.id} wrote on misuse`).toEqual(before);

        const clean = await capture(mod.spec, args, s.dir);
        expect(clean.status, `${row.id} clean:\n${clean.output}`).toBe(0);
        expect(clean.out.split('\n'), row.id).toHaveLength(1);
        expect(clean.out.startsWith(`[${row.id}] `), row.id).toBe(true);

        tree.plant(s);
        const planted = await capture(mod.spec, args, s.dir);
        expect(planted.status, `${row.id} planted:\n${planted.output}`).toBe(1);
        expect(planted.out, row.id).toBe('');
        const findings = planted.err.split('\n').filter((l) => l.startsWith(`[${row.id}] FAIL`) || (tree.rules === true && /^[A-Z]+-[0-9]+ /.test(l)));
        expect(findings.length, row.id).toBeGreaterThan(0);
        for (const line of findings) {
          // A file-shaped finding matches exactly one pattern; `[name] FAIL: `
          // names no file and matches none, by design.
          expect(matcherOwners(line), line).toHaveLength(line.startsWith(`[${row.id}] FAIL: `) ? 0 : 1);
        }
      } finally {
        s.cleanup();
      }
    }
  });

  it('gates-O5: the repair run clears the fixable problem only; the whole set then reports the other', async () => {
    sb.write(
      'fixer.sh',
      [
        'if [ "$1" = "--fix" ] && [ -f problem-a ]; then rm problem-a; echo "[fixer] FIXED problem-a: removed" >&2; fi',
        'if [ -f problem-a ]; then echo "[fixer] FAIL problem-a: present" >&2; exit 1; fi',
        'echo "[fixer] clean"',
        '',
      ].join('\n'),
    );
    sb.write(
      'judge.sh',
      [
        'case "$1" in --*) echo "[judge] unknown argument: $1" >&2; exit 2;; esac',
        'if [ -f problem-b ]; then echo "[judge] FAIL problem-b: present" >&2; exit 1; fi',
        'echo "[judge] clean"',
        '',
      ].join('\n'),
    );
    const row = (id: string, fixable: boolean): Gate => ({
      ...realRow(id, id, ''),
      command: `bash ${id}.sh`,
      local_command: `bash ${id}.sh`,
      fixable,
    });
    sb.write(SRC, `${JSON.stringify(gatesRegistry((r) => (r.gates = [row('fixer', true), row('judge', false)])), null, 2)}\n`);
    sb.write('problem-a', 'x\n');
    sb.write('problem-b', 'x\n');

    const repair = await wholeSet(['--fix']);
    expect(repair.status, repair.output).toBe(0);
    expect(repair.err).toContain('[fixer] FIXED problem-a: removed');
    expect(sb.exists('problem-a')).toBe(false);
    expect(sb.exists('problem-b')).toBe(true);

    const r = await wholeSet();
    expect(r.status).toBe(1);
    expect(r.err).toContain('[judge] FAIL problem-b: present');
    expect(r.err).not.toContain('[fixer] FAIL');
    expect(r.err.split('\n').at(-1)).toBe('✗ 1 of 2 gate(s) failed: judge');
  });
});

describe('kb.data', () => {
  it('data-O3: a data file replaced by non-JSON — the whole set exits 1, the validity gate and its reader naming it', async () => {
    sb.linkRepo('node_modules');
    sb.write('.gitignore', 'node_modules\n');
    colocationTree(sb);
    sb.write(
      SRC,
      `${JSON.stringify(
        gatesRegistry((r) => {
          r.gates = [
            realRow('json-sanity', 'JSON sanity', 'tools/src/gates/check-json.ts'),
            realRow('test-colocation', 'Test colocation', 'tools/src/gates/check-test-colocation.ts'),
          ];
        }),
        null,
        2,
      )}\n`,
    );
    const green = await wholeSet();
    expect(green.status, green.output).toBe(0);

    sb.write(ALLOWLIST, 'not json\n');
    const r = await wholeSet();
    expect(r.status).toBe(1);
    expect(r.err).toMatch(new RegExp(`^\\[json-sanity\\] FAIL ${ALLOWLIST}(:\\d+)?: is not valid JSON`, 'm'));
    expect(r.err).toContain(`[test-colocation] FAIL ${ALLOWLIST}: is not valid JSON`);
    expect(r.err.split('\n').at(-1)).toBe('✗ 2 of 2 gate(s) failed: json-sanity, test-colocation');
  });

  it('exceptions-O1: a gate over committed files — plant, excuse, blank the reason, then the entry left behind', async () => {
    sb.linkRepo('node_modules');
    sb.write('.gitignore', 'node_modules\n');
    sb.write(SRC, `${JSON.stringify(gatesRegistry((r) => (r.gates = [realRow('vocabulary', 'Vocabulary bans', 'tools/src/gates/check-vocabulary.ts')])), null, 2)}\n`);
    // A gate over committed files runs clean, its allowlist empty.
    glossaryTree(sb);
    sb.commit('clean');
    const clean = await wholeSet();
    expect(clean.status, clean.output).toBe(0);

    // One unrecognized thing is planted: exit 1, one finding naming that file.
    glossaryTree(sb, true);
    const planted = await wholeSet();
    expect(planted.status).toBe(1);
    expect(planted.err.split('\n').filter((l) => l.startsWith('[vocabulary] FAIL'))).toEqual([
      '[vocabulary] FAIL docs/planted.md:3: use "widget" not "gizmo"',
    ]);

    // An allowlist entry with a non-empty reason exits 0; blanking the reason exits 1.
    const entry = { name: 'planted-page', match: 'docs/planted.md', reason: 'Rewritten in the next change.', owner: 'O', since: '2026-09-24' };
    sb.write(VOCABULARY_ALLOWLIST, allowlistJson([entry]));
    const excused = await wholeSet();
    expect(excused.status, excused.output).toBe(0);
    expect(excused.err).toContain('1 allowlist entry applied, excusing 1 hit');
    sb.write(VOCABULARY_ALLOWLIST, allowlistJson([{ ...entry, reason: '' }]));
    const blank = await wholeSet();
    expect(blank.status).toBe(1);
    expect(blank.err).toContain(`[vocabulary] FAIL ${VOCABULARY_ALLOWLIST}: entry "planted-page" has an empty reason`);

    // Deleting the plant but keeping its entry, the whole-set run exits 1, naming the entry.
    sb.write(VOCABULARY_ALLOWLIST, allowlistJson([entry]));
    sb.rm('docs/planted.md');
    const leftover = await wholeSet();
    expect(leftover.status).toBe(1);
    expect(leftover.err.split('\n').filter((l) => l.startsWith('[vocabulary] FAIL'))).toEqual([
      `[vocabulary] FAIL ${VOCABULARY_ALLOWLIST}: entry "planted-page" excuses nothing — no file it matches uses a banned phrasing; delete it`,
    ]);
  });

  it('data-O3: the registry’s own generator names a non-JSON registry too', async () => {
    sb.write(SRC, 'not json\n');
    const r = await capture(genGates, ['--check'], sb.dir);
    expect(r.status).toBe(1);
    expect(r.err).toBe(`[gates-fresh] FAIL ${SRC}: is not valid JSON`);
  });
});

describe('kb.harness', () => {
  /** The five harness gates (harness-C1): id, name and program. */
  const HARNESS = [
    ['context-layers', 'Context layers', 'tools/src/gates/check-claude-md.ts'],
    ['harness-shape', 'Harness shape', 'tools/src/gates/check-harness.ts'],
    ['harness-routes', 'Harness routes', 'tools/src/gates/check-harness-routes.ts'],
    ['claims', 'Command claims', 'tools/src/gates/check-claims.ts'],
    ['inbox-cap', 'Trap inbox cap', 'tools/src/gates/check-inbox.ts'],
  ] as const;
  const IDS = HARNESS.map(([id]) => id);
  /** The same five, as real rows over the sandbox. */
  const harnessRows = (): Gate[] => HARNESS.map(([id, name, program]) => realRow(id, name, program));

  /**
   * A tree all five pass: layers, a harness under .claude/, a Makefile and a
   * page fence that hold, an inbox of three.
   */
  function harnessSandbox(): void {
    sb.linkRepo('node_modules');
    sb.write('.gitignore', 'node_modules\n');
    sb.write(SRC, `${JSON.stringify(gatesRegistry((r) => (r.gates = harnessRows())), null, 2)}\n`);
    layersTree(sb);
    harnessTree(sb);
    claimsTree(sb);
    inboxTree(sb, 3);
  }

  it('harness-O1: one planted defect per harness surface — each of the five gates names its own file', async () => {
    harnessSandbox();
    sb.write('tests/run.sh', 'true\n');
    sb.write('.claude/stray/notes.md', 'x\n');
    sb.write('.claude/skills/widget/SKILL.md', `${skillText('widget')}\nSee [the page](../../../docs/gone.md).\n`);
    sb.write('docs/page.md', '# A page\n\n```bash\nmake nope\n```\n');
    sb.write('docs/inbox.md', inboxPage(Array.from({ length: 21 }, (_, i) => inboxEntry(i + 1)).join('')));

    const r = await wholeSet();
    expect(r.status, r.output).toBe(1);
    expect(r.out).toBe('');
    const lines = r.err.split('\n');
    const own = (id: string): string[] => lines.filter((l) => l.startsWith(`[${id}] FAIL `));
    expect(own('context-layers')).toEqual(['[context-layers] FAIL tests/CLAUDE.md: governed directory tests/ has no context layer (see docs/concepts/context-layering.md)']);
    expect(own('harness-shape')).toEqual([expect.stringMatching(/^\[harness-shape\] FAIL \.claude\/stray: a folder under \.claude\/ with no row in the folder list/)]);
    expect(own('harness-routes')).toEqual([
      '[harness-routes] FAIL .claude/skills/widget/SKILL.md:17: dead link: (../../../docs/gone.md) resolves to docs/gone.md, which does not exist',
    ]);
    expect(own('claims')).toEqual([expect.stringContaining('[claims] FAIL docs/page.md:4: `make nope` — the Makefile has no target nope')]);
    expect(own('inbox-cap')).toEqual([expect.stringContaining('[inbox-cap] FAIL docs/inbox.md: 21 entries, cap 20')]);
    for (const l of [...own('context-layers'), ...own('harness-shape'), ...own('harness-routes'), ...own('claims'), ...own('inbox-cap')]) {
      expect(matcherOwners(l), l).toHaveLength(1);
    }
    expect(lines.at(-1)).toBe(`✗ 5 of 5 gate(s) failed: ${IDS.join(', ')}`);

    // Each holds one registry row in the real registry (harness-C2).
    const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, SRC), 'utf8')) as Registry;
    for (const [id, , program] of HARNESS) {
      const rows = real.gates.filter((g) => g.id === id);
      expect(rows, id).toHaveLength(1);
      expect(programsOf(rows[0] as Gate), id).toEqual([program]);
      expect(rows[0]?.local_command, id).toBe(`node_modules/.bin/tsx ${program}`);
    }
  });

  it('harness-O2: the defects removed, the whole set exits 0 with one summary line per gate; each alone on --nope exits 2', async () => {
    harnessSandbox();
    const r = await wholeSet();
    expect(r.status, r.output).toBe(0);
    expect(r.out).toMatch(/^✓ 5 gates, no findings/);
    for (const id of IDS) {
      expect(r.err.split('\n').filter((l) => l.includes(`  [${id}] `)), id).toHaveLength(1);
    }

    // Each run alone, as its row runs it, with `--nope`: exit 2, changing no file.
    for (const row of harnessRows()) {
      const before = sb.snapshot();
      const alone = run('bash', ['-c', `${row.command} --nope`], sb.dir);
      expect(alone.status, `${row.id} --nope:\n${alone.stderr}`).toBe(2);
      expect(alone.stdout, row.id).toBe('');
      expect(sb.snapshot(), `${row.id} wrote on misuse`).toEqual(before);
    }
  });

  it('self-check-O1: a valid skill is green; an unlisted folder and a skill with no trigger or boundary each give one finding', async () => {
    sb.linkRepo('node_modules');
    sb.write('.gitignore', 'node_modules\n');
    const rows = harnessRows().filter((g) => g.id === 'harness-shape' || g.id === 'harness-routes');
    sb.write(SRC, `${JSON.stringify(gatesRegistry((r) => (r.gates = rows)), null, 2)}\n`);
    harnessTree(sb);
    const green = await wholeSet();
    expect(green.status, green.output).toBe(0);
    expect(green.err).toContain('[harness-shape] 4 folders under .claude/, all listed; 1 skill');

    /** Every finding line a whole-set run printed, from any gate. */
    const everyFinding = (err: string): string[] => err.split('\n').filter((l) => / FAIL /.test(l) && l.startsWith('['));

    sb.write('.claude/stray/notes.md', 'x\n');
    const folder = await wholeSet();
    expect(folder.status, folder.output).toBe(1);
    expect(everyFinding(folder.err)).toEqual([
      '[harness-shape] FAIL .claude/stray: a folder under .claude/ with no row in the folder list — add a row to CLAUDE_DIRS in ' +
        'tools/src/gates/check-harness.ts saying what its files are and what holds them, or move it out',
    ]);
    expect(folder.err.split('\n').at(-1)).toBe('✗ 1 of 2 gate(s) failed: harness-shape');
    sb.rm('.claude/stray');

    const SKILL_FILE = '.claude/skills/widget/SKILL.md';
    const finding =
      `[harness-shape] FAIL ${SKILL_FILE}:3: its description says neither when to use it ("Use when …") ` +
      'nor what it is not for ("Not for …") — without a trigger nothing loads it';
    sb.write(SKILL_FILE, skillText('widget', 'Does the widget job.'));
    const skill = await wholeSet();
    expect(skill.status, skill.output).toBe(1);
    expect(everyFinding(skill.err)).toEqual([finding]);
    expect(skill.err.split('\n').at(-1)).toBe('✗ 1 of 2 gate(s) failed: harness-shape');
    // The same tree, the gate alone: one finding, naming that skill's file.
    const alone = await capture(shapeGate, [], sb.dir);
    expect(alone.status).toBe(1);
    expect(alone.out).toBe('');
    expect(alone.err.split('\n').filter((l) => l !== '')).toEqual([finding]);
  });

  it('a 340-word directory layer: the advisory names 340 and 350, and the layer gate passes', async () => {
    // The hook reads the budgets out of the layer gate, so the sandbox holds a
    // copy — and tools/ is then a governed directory with its own layer.
    layersTree(sb, ['docs', 'scripts', 'tools']);
    sb.copyRepo('tools/src/gates/check-claude-md.ts');
    const text = layerText('docs');
    const have = text.split(/\s+/).filter((w) => w !== '').length;
    sb.write('docs/CLAUDE.md', `${text}\n${'word\n'.repeat(340 - have)}`);

    const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(sb.dir, 'docs/CLAUDE.md') } });
    const hook = run('bash', [path.join(REPO_ROOT, '.claude/hooks/after-write.sh')], sb.dir, { CLAUDE_PROJECT_DIR: sb.dir }, payload);
    expect(hook.status).toBe(0);
    const note = (JSON.parse(hook.stdout) as { systemMessage: string }).systemMessage;
    expect(note).toContain('340/350');

    const gate = await capture(layerGate, [], sb.dir);
    expect(gate.status, gate.output).toBe(0);
  });
});

describe('kb.learning', () => {
  /**
   * The learning set as real rows over the sandbox: the edges, the graph built
   * from them and its check, the graph's own gate, the page block, and the
   * paths. learning-O1 and learning-O2 name the frontmatter gate, which judges
   * `status` and `level`, and the structure gate. The frontmatter gate is here;
   * the stages are the learning-paths gate's, the one owner of that check
   * decided at the wave-1 merge, so the structure gate has no part in this set.
   */
  const learningRows = (): Gate[] => [
    realRow('relations', 'Relations closed and paired', 'tools/src/gates/check-relations.ts'),
    {
      ...realRow('prerequisites-fresh', 'Prerequisite graph in sync', 'tools/src/gen/gen-prerequisites.ts'),
      local_command: `${realProgram('tools/src/gen/gen-prerequisites.ts')} --check`,
    },
    realRow('prerequisites', 'Prerequisite graph holds', 'tools/src/gates/check-prerequisites.ts'),
    realRow('frontmatter', 'Page frontmatter', 'tools/src/gates/check-doc-frontmatter.ts'),
    realRow('learning-paths', 'Learning paths resolve', 'tools/src/gates/check-learning-paths.ts'),
  ];

  /** The source tree with the graph built from it, and the learning set registered. */
  async function built(edges: readonly unknown[] = EDGES, statuses: Readonly<Record<string, string | null>> = {}): Promise<void> {
    sb.linkRepo('node_modules');
    sb.write('.gitignore', 'node_modules\n');
    sb.write(SRC, `${JSON.stringify(gatesRegistry((r) => (r.gates = learningRows())), null, 2)}\n`);
    sourceTree(sb, edges, statuses);
    const gen = await capture(genPrerequisites, [], sb.dir);
    expect(gen.status, gen.output).toBe(0);
  }

  it('learning-O1: both children built — each gate and the reference check exit 0 with one line and no stderr; the page regenerates byte for byte', async () => {
    await built();
    // The scenario's tree: every record resolves (the gate below), and every page declares a status.
    const pages = frontmatterMany(sb.dir, ALL_ROWS.map((r) => r.source));
    for (const [page, fm] of pages) {
      expect(STATUSES, page).toContain(fm['status']);
    }
    expect(pages.size).toBe(ALL_ROWS.length);
    for (const [gate, args] of [
      [relationsGate, []],
      [prerequisitesGate, []],
      [frontmatterGate, []],
      [learningPathsGate, []],
      [genPrerequisites, ['--check']],
    ] as const) {
      const r = await capture(gate, args, sb.dir);
      expect(r.status, `${gate.name}:\n${r.output}`).toBe(0);
      expect(r.out.split('\n'), gate.name).toHaveLength(1);
      expect(r.out.startsWith(`[${gate.name}] `), gate.name).toBe(true);
      expect(r.err, gate.name).toBe('');
    }
    const page = sb.read(PREREQ_REFERENCE);
    const again = await capture(genPrerequisites, [], sb.dir);
    expect(again.out).toContain('wrote 0 of 2 outputs');
    expect(sb.read(PREREQ_REFERENCE)).toBe(page);

    const whole = await wholeSet();
    expect(whole.status, whole.output).toBe(0);
    expect(whole.out).toMatch(/^✓ 5 gates, no findings/);
  });

  it('learning-O2: a cycle in the graph and one page without its status line — the whole set exits 1, exactly two findings, one per file', async () => {
    // A recorded deviation: the graph is built from the relations file, and the
    // relations gate reads a two-page cycle (a requires b, b requires a) as one
    // directed edge written both ways round — a finding of its own beside the
    // cycle. So the shortest cycle that is one finding is three pages long. The
    // cycle's finding sits at its first edge in the relations file, the file an
    // author changes, and names the others.
    await built([...EDGES, { a: 'delta', verb: 'prerequisite', b: 'alpha', note_a: '', note_b: '' }], { gamma: null });
    const r = await wholeSet();
    expect(r.status, r.output).toBe(1);
    expect(r.out).toBe('');
    const edges = sb.read('docs/data/relations.json').split('\n');
    const edgeAt = (a: string, b: string): number =>
      edges.findIndex((l, n) => l.includes(`"a": "${a}"`) && edges[n + 1]?.includes('"prerequisite"') && edges[n + 2]?.includes(`"b": "${b}"`));
    const [ab, bd, da] = [edgeAt('alpha', 'beta'), edgeAt('beta', 'delta'), edgeAt('delta', 'alpha')];
    expect(r.err.split('\n').filter((l) => /^\[[a-z-]+\] FAIL/.test(l))).toEqual([
      `[prerequisites] FAIL docs/data/relations.json:${ab}: records 'alpha', 'beta' and 'delta' require one another round a cycle — none of them can be read first; unlink one of its prerequisite edges, at lines ${ab}, ${bd} and ${da}`,
      `[frontmatter] FAIL ${rowOf('gamma').source}: missing required key: status`,
    ]);
    expect(r.err.split('\n').at(-1)).toBe('✗ 2 of 5 gate(s) failed: prerequisites, frontmatter');
  });
});

describe('kb.generation, on the real tree', () => {
  /** Every generator that owns committed text under docs/: each registered row under tools/src/gen that runs with --check. */
  async function generators(): Promise<GateSpec[]> {
    const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, SRC), 'utf8')) as Registry;
    const programs = real.gates
      .filter((g) => (g.wired ?? '').endsWith(' --check'))
      .map((g) => programsOf(g)[0] as string)
      .filter((p) => p.startsWith('tools/src/gen/'));
    const specs: GateSpec[] = [];
    for (const p of programs) {
      specs.push(((await import(pathToFileURL(path.join(REPO_ROOT, p)).href)) as { spec: GateSpec }).spec);
    }
    return specs;
  }

  it('generation-O2 (real tree): every generator runs again over the committed tree — no byte changes, and every freshness check exits 0', async () => {
    sb.copyRepo('docs');
    const gens = await generators();
    expect(gens.map((g) => g.name)).toEqual(expect.arrayContaining(['gates-fresh', 'prerequisites-fresh', 'relations-fresh', 'tours-fresh']));
    const before = sb.snapshot();
    for (const g of gens) {
      const r = await capture(g, [], sb.dir);
      expect(r.status, `${g.name}:\n${r.output}`).toBe(0);
      expect(r.out, g.name).toMatch(/ wrote 0 of \d+ /);
    }
    expect(sb.snapshot()).toEqual(before);
    for (const g of gens) {
      const r = await capture(g, ['--check'], sb.dir);
      expect(r.status, `${g.name} --check:\n${r.output}`).toBe(0);
      expect(r.err, g.name).toBe('');
    }
  });

  it('marked-blocks-O1 (real tree): a stale line inside a real block of each kind — each generator exits 0 unflagged and with --check, bytes outside the markers unchanged, a stamp first inside, the count stated', async () => {
    sb.copyRepo('docs');
    const reg = JSON.parse(sb.read(SRC)) as Registry;
    const plants: [string, string][] = [
      ['relationships', 'docs/patterns/distributed/resilience/circuit-breaker.md'],
      ['fluency', 'docs/patterns/distributed/resilience/bulkhead.md'],
      ['tour', 'docs/themes/resilience.md'],
      ['gate-count', TRIAGE],
    ];
    const committed = new Map(plants.map(([, f]) => [f, sb.read(f)]));
    for (const [name, file] of plants) {
      const [open, close] = markers(name);
      const text = sb.read(file);
      sb.write(file, `${text.slice(0, text.indexOf(open) + open.length)}\n\na stale line\n\n${text.slice(text.indexOf(close))}`);
    }
    const planted = new Map(plants.map(([, f]) => [f, sb.read(f)]));

    for (const argv of [[], ['--check']]) {
      for (const gen of [genRelations, genTours, genGates]) {
        const r = await capture(gen, argv, sb.dir);
        expect(r.status, `${gen.name} ${argv.join(' ')}:\n${r.output}`).toBe(0);
      }
      for (const [name, file] of plants) {
        const [open, close] = markers(name);
        const was = planted.get(file) as string;
        const now = sb.read(file);
        expect(now.slice(0, now.indexOf(open)), `${file} before ${name}`).toBe(was.slice(0, was.indexOf(open)));
        expect(now.slice(now.indexOf(close)), `${file} after ${name}`).toBe(was.slice(was.indexOf(close)));
        const inside = now.slice(now.indexOf(open) + open.length, now.indexOf(close));
        expect(inside.split('\n').find((l) => l.trim() !== ''), `${file} ${name}`).toMatch(/^<!-- GENERATED by /);
        expect(inside).not.toContain('a stale line');
        expect(now, file).toBe(committed.get(file));
      }
      const count = sb.read(TRIAGE);
      const [open, close] = markers('gate-count');
      expect(count.slice(count.indexOf(open), count.indexOf(close))).toContain(`**${reg.gates.length} check gates**`);
    }
  });
});
