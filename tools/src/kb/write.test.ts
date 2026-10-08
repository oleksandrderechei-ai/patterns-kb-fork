/**
 * kb.mjs v2's writers over the fixture tree (`writeKbFixture`), made into the
 * shape every page takes at the cutover: no converter stamp, every marked
 * block rendered from its data file. Each write is driven through `run`, then
 * read back three ways — through v2's own reader with a fresh corpus, through
 * the frontmatter door and through kb-attrs — and the tree is held to what
 * the converter's --check and the round-trip hold the real one to:
 *
 *   fresh       every marked block is what its renderer gives from the data files
 *   readable    every page parses through the dialect with no problem, and its
 *               frontmatter through the one parser
 *   contained   nothing outside what the command owns moved: the same elements,
 *               ids and text everywhere else
 *
 * The real tree is write-tree.test.ts's.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { frontmatter, frontmatterMany } from '../lib/frontmatter.js';
import { splice } from '../lib/generated.js';
import { writeKbFixture } from '../lib/fixtures.js';
import { deriveElements, parseKb, type KbElement } from '../lib/kb-attrs.js';
import { renderRelations, type PageRef, type RelationsFile } from '../lib/render-relations.js';
import { renderFluency, renderTour, type LearningPaths } from '../lib/render-tours.js';
import { makeSandbox, PERMISSIONS_ENFORCED, type Sandbox } from '../lib/sandbox.js';

import { run } from './cli.js';
import { Corpus, type Page } from './corpus.js';
import { splitFrontmatter } from './edit.js';
import { parsePage } from './page.js';
import { flagsOf, usageLine } from './spec.js';
import { Change, commonHeading, placeNew, withProfile } from './write.js';

const TODAY = '2026-09-28';
const BREAKER = 'docs/patterns/distributed/resilience/breaker.md';
const RETRY = 'docs/patterns/distributed/resilience/retry.md';
const QUEUE = 'docs/patterns/messaging/queue.md';
const STORM = 'docs/hazards/storm.md';
const STEADY = 'docs/themes/steady.md';
const SHORTENER = 'docs/designs/shortener.md';
const RELATIONS = 'docs/data/relations.json';
const PATHS = 'docs/data/learning-paths.json';
const STRUCTURE = 'docs/data/site-structure.json';

let sb: Sandbox;
let root: string;

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** One command over the sandbox, with a fresh corpus: what the next process would read. */
async function kb(...argv: string[]): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, new Corpus(root), { today: TODAY });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const ok = async (...argv: string[]): Promise<string> => {
  const r = await kb(...argv);
  expect(r.err, `kb.mjs ${argv.join(' ')}`).toBe('');
  expect(r.code).toBe(0);
  return r.out;
};
const fails = async (...argv: string[]): Promise<string> => {
  const r = await kb(...argv);
  expect(r.code, `kb.mjs ${argv.join(' ')}\n${r.out}`).toBe(1);
  return r.err;
};
/** A call made badly — a retired command or flag, a positional left out — is exit 2, with nothing on stdout. */
const misuse = async (...argv: string[]): Promise<string> => {
  const r = await kb(...argv);
  expect(r.code, `kb.mjs ${argv.join(' ')}\n${r.out}`).toBe(2);
  expect(r.out).toBe('');
  return r.err;
};
const getJson = async (...argv: string[]): Promise<Record<string, unknown>> => JSON.parse(await ok('get', ...argv, '--json')) as Record<string, unknown>;

const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const put = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const json = <T>(rel: string): T => JSON.parse(read(rel)) as T;
const edit = (rel: string, f: (t: string) => string): void => put(rel, f(read(rel)));

/** Every page as the renderers name it. */
function refs(corpus: Corpus): { bySlug: Map<string, PageRef>; byRoute: Map<string, PageRef> } {
  const list = corpus.pages.map((p) => ({ slug: p.slug, route: p.route, source: p.source, title: corpus.meta(p.slug).title }));
  return { bySlug: new Map(list.map((r) => [r.slug, r])), byRoute: new Map(list.map((r) => [r.route, r])) };
}

/** A page's text with every marked block it carries rendered from the data files. */
function rendered(corpus: Corpus, page: Page, text: string): string {
  const { bySlug, byRoute } = refs(corpus);
  const blocks = [];
  if (text.includes('<!-- relationships:start -->')) {
    blocks.push({ name: 'relationships', lines: renderRelations(page.slug, corpus.relations, { verbs: corpus.model.verbs, relOrder: corpus.model.relOrder, pages: bySlug }) });
  }
  const lp = corpus.paths as unknown as LearningPaths;
  if (text.includes('<!-- tour:start -->')) blocks.push({ name: 'tour', lines: renderTour(page.slug, lp, { pages: byRoute }) });
  if (text.includes('<!-- fluency:start -->')) blocks.push({ name: 'fluency', lines: renderFluency(page.route, lp, { pages: byRoute }) });
  return (splice(text, blocks) as { text: string }).text;
}

/** The fixture as a source tree: no page stamps, every marked block fresh. */
function cutoverTree(): void {
  sb = makeSandbox();
  root = sb.dir;
  writeKbFixture(root);
  // The reader's fixture tours a page that is gone; a tree the renderers can draw tours none.
  edit(PATHS, (t) => t.replace(/,\s*"\/patterns\/gone\.html"/, ''));
  const corpus = new Corpus(root);
  for (const p of corpus.pages) put(p.source, rendered(corpus, p, read(p.source).replace(/^<!-- GENERATED by [^\n]*\n\n/m, '')));
}

/** The tree holds what the converter's --check and the round-trip hold the real one to. */
function invariants(): void {
  const corpus = new Corpus(root);
  for (const p of corpus.pages) {
    const text = read(p.source);
    expect(parsePage(text).problems, p.slug).toEqual([]);
    expect(rendered(corpus, p, text), `${p.slug}: a marked block is stale`).toBe(text);
  }
  const fm = frontmatterMany(root, corpus.pages.map((p) => p.source), { lists: true });
  for (const p of corpus.pages) expect(fm.get(p.source)?.['title'], p.slug).toBe(corpus.meta(p.slug).title);
  const file = corpus.relations;
  for (const r of file.relations) {
    expect(corpus.page(r.a), `${r.a} → ${r.b}`).toBeDefined();
    expect(corpus.page(r.b), `${r.a} → ${r.b}`).toBeDefined();
    expect(Object.keys(corpus.model.verbs)).toContain(r.verb);
  }
}

/** A page's elements, as the round-trip compares them. */
function elements(text: string): KbElement[] {
  return deriveElements(parseKb(splitFrontmatter(text).body).tree);
}

/** Every element outside `blocks` is the same before and after. */
function contained(before: string, after: string, blocks: readonly string[]): void {
  const keep = (t: string): KbElement[] => elements(t).filter((e) => e.block === null || !blocks.includes(e.block));
  expect(keep(after)).toEqual(keep(before));
}

beforeEach(() => cutoverTree());
afterEach(() => sb.cleanup());

describe('the tree the writers start from', () => {
  it('is fresh and readable before anything is written', () => {
    invariants();
  });
});

describe('the guard on generated files', () => {
  it('refuses a page that carries the converter stamp, naming the site page to edit instead', async () => {
    edit(BREAKER, (t) => t.replace('# Breaker', '<!-- GENERATED by tools/src/migrate/html-to-md.ts from site/patterns/x.html. Do not edit this file. -->\n\n# Breaker'));
    const before = read(BREAKER);
    for (const argv of [
      ['set', 'breaker', '--favourite', 'false'],
      ['wild', 'breaker', '--items', '[]'],
      ['production', 'breaker', '--knobs', '[]'],
      ['explain', 'breaker', '--text', 'a', '--example', 'b'],
      ['link', 'breaker', 'combines-with', 'queue'],
      ['unlink', 'retry', 'breaker'],
    ]) {
      expect(await fails(...argv)).toBe(
        `${BREAKER} is generated by tools/src/migrate/html-to-md.ts from site/patterns/x.html (its stamp says so): edit site/patterns/x.html, then run make gen`,
      );
    }
    expect(read(BREAKER)).toBe(before);
  });

  it('refuses a data file whose note says it is generated', async () => {
    const want = (rel: string): string => `${rel} is generated (its note says so): edit the file its note names, then run make gen`;
    edit(PATHS, (t) => t.replace('"note": "Fixture."', '"note": "GENERATED by x from y."'));
    expect(await fails('new', 'x', '--kind', 'theme', '--name', 'X')).toBe(want(PATHS));
    for (const rel of [RELATIONS, STRUCTURE]) edit(rel, (t) => t.replace('"note": "Fixture."', '"note": "GENERATED by x from y."'));
    expect(await fails('link', 'queue', 'combines-with', 'retry')).toBe(want(RELATIONS));
    expect(await fails('new', 'x', '--kind', 'hazard', '--name', 'X')).toBe(want(STRUCTURE));
  });
});

describe('set', () => {
  it('writes the frontmatter keys it is given, keeps every other byte, and reads back through the door and the reader', async () => {
    const before = read(BREAKER);
    expect(await ok('set', 'breaker', '--aliases', '["CB","fuse, box"]', '--tags', '["latency","resilience"]', '--solves', '["a: b"]', '--essence', '  Stops calling: fast  ', '--favourite', 'false')).toBe(
      'breaker: aliases=2 tags=2 solves=1 favourite=false essence',
    );
    const after = read(BREAKER);
    expect(splitFrontmatter(after).body).toBe(splitFrontmatter(before).body);
    expect(splitFrontmatter(after).fm).toBe(
      '---\ntitle: Breaker\ndescription: "Stops calling: fast"\narea: distributed-resilience\nowner: Test Owner\ntags: [latency, resilience]\nstatus: stable\naliases: [CB, "fuse, box"]\nsolves: ["a: b"]\n---\n',
    );
    expect(frontmatter(root, BREAKER, { lists: true })).toMatchObject({ description: 'Stops calling: fast', aliases: ['CB', 'fuse, box'], solves: ['a: b'] });
    expect(await getJson('breaker', '--block', 'description')).toMatchObject({ essence: 'Stops calling: fast' });
    const ls = JSON.parse(await ok('ls', '--kind', 'pattern', '--json')) as { id: string; favourite?: boolean; aliases?: string[] }[];
    expect(ls.find((n) => n.id === 'breaker')).toMatchObject({ aliases: ['CB', 'fuse, box'] });
    expect(ls.find((n) => n.id === 'breaker')?.favourite).toBeUndefined();
    invariants();
  });

  it('adds a key where the dialect orders it, drops a list set empty, and says when nothing changed', async () => {
    expect(await ok('set', 'retry', '--favourite', 'true', '--aliases', '["again"]', '--solves', '[]')).toBe('retry: aliases=1 solves=0 favourite=true');
    expect(splitFrontmatter(read(RETRY)).fm).toBe(
      '---\ntitle: Retry\ndescription: The retry page\narea: distributed-resilience\nowner: Test Owner\ntags: [resilience, latency]\nstatus: stable\naliases: [again]\nfavourite: true\n---\n',
    );
    const bytes = read(RETRY);
    expect(await ok('set', 'retry', '--favourite', 'true')).toBe('retry: favourite=true (unchanged)');
    expect(read(RETRY)).toBe(bytes);
  });

  it('refuses what scripts/kb.mjs refused, in its words', async () => {
    // A malformed call (exit 2: fix the command): nothing to set, text that is no JSON, JSON of the wrong shape, a word that is not true or false.
    expect(await misuse('set', 'breaker')).toBe('nothing to set — pass --aliases / --tags / --solves / --favourite / --essence');
    expect(await misuse('set', 'breaker', '--aliases', '[x')).toMatch(/^--aliases is not valid JSON: /);
    expect(await misuse('set', 'breaker', '--tags', 'resilience')).toMatch(/^--tags is not valid JSON: /);
    expect(await misuse('set', 'breaker', '--solves', '')).toMatch(/^--solves is not valid JSON: /);
    expect(await misuse('set', 'breaker', '--aliases', '"x"')).toBe('--aliases: must be a JSON array');
    expect(await misuse('set', 'breaker', '--solves', '[1]')).toBe('--solves: every item must be a string');
    expect(await misuse('set', 'breaker', '--solves', '[" "]')).toBe('--solves: no empty strings');
    expect(await misuse('set', 'breaker', '--favourite', 'yes')).toBe('--favourite: must be true or false');
    // A well-formed call the KB refuses (exit 1: fix the content): the tag vocabulary and count, the description rules, an id that is no page.
    expect(await fails('set', 'breaker', '--tags', '["resilience","nope"]')).toBe(
      '--tags: not in the closed vocabulary: nope\n  legal tags: resilience latency messaging cloud testing\n  add one to docs/data/tags.json only if it will apply to 3+ pages',
    );
    expect(await fails('set', 'breaker', '--tags', '["resilience"]')).toBe('--tags: 1 given; a page needs 2-5 (one tag groups nothing, six filter nothing)');
    expect(await fails('set', 'breaker', '--essence', ' ')).toBe('--essence: cannot be empty');
    expect(await fails('set', 'breaker', '--essence', 'two\nlines')).toBe('--essence: one line, with no tab');
    expect(await fails('set', 'nope', '--favourite', 'true')).toBe('unknown id: nope');
  });

  it('refuses a description longer than a search result shows, counting characters', async () => {
    const at = (n: number): string => `${'—'.repeat(10)}${'x'.repeat(n - 10)}`;
    expect(await fails('set', 'breaker', '--essence', at(161))).toBe('--essence: description is 161 characters — 160 is where search results cut off');
    expect(await ok('set', 'breaker', '--essence', at(160))).toBe('breaker: essence');
    expect(await ok('validate', 'breaker')).toBe('OK — 1 page(s) structurally valid.');
  });

  it('holds tags to the list the tags gate accepts, once the tag list files a topic', async () => {
    // Before the retag every term is a skill: no list needs a topic.
    expect(await ok('set', 'breaker', '--tags', '["latency","resilience"]')).toBe('breaker: tags=2');
    expect(await fails('set', 'breaker', '--tags', '["latency","latency"]')).toBe('--tags: tag "latency" is written twice');
    edit('docs/data/tags.json', (t) => {
      const list = JSON.parse(t) as { terms: { id: string; facet: string }[] };
      for (const term of list.terms) if (term.id === 'resilience' || term.id === 'messaging') term.facet = 'topic';
      return `${JSON.stringify(list, null, 2)}\n`;
    });
    expect(await fails('set', 'retry', '--tags', '["latency","resilience"]')).toBe('--tags: tags are out of facet order at "resilience" — topics first, then skills, then languages');
    expect(await fails('set', 'retry', '--tags', '["resilience","messaging"]')).toBe(
      '--tags: 2 topic tags (resilience, messaging) — a page has one, and it decides which hub group the page joins',
    );
    expect(await fails('set', 'retry', '--tags', '["latency","cloud"]')).toBe('--tags: no topic tag — what the page is about is the one tag it must carry, written first');
    expect(await fails('new', 'fuse', '--kind', 'hazard', '--name', 'Fuse', '--tags', '["latency","resilience"]')).toBe(
      '--tags: tags are out of facet order at "resilience" — topics first, then skills, then languages',
    );
    expect(await ok('set', 'retry', '--tags', '["resilience","latency"]')).toBe('retry: tags=2 (unchanged)');
    // The lint holds a page written some other way to the same list: breaker now carries a topic last.
    expect(await fails('validate', 'breaker')).toBe('1 problem(s) across 1 page(s):\n  breaker: tags are out of facet order at "resilience" — topics first, then skills, then languages');
  });

  it('keeps a CRLF page’s line ending, and reads a fence with trailing blanks as the parser does', async () => {
    edit(RETRY, (t) => t.replace(/\n/g, '\r\n'));
    expect(frontmatter(root, RETRY, { lists: true })).toMatchObject({ title: 'Retry' });
    expect(await ok('set', 'retry', '--favourite', 'true')).toBe('retry: favourite=true');
    const after = read(RETRY);
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(splitFrontmatter(after).fm).toBe(
      '---\r\ntitle: Retry\r\ndescription: The retry page\r\narea: distributed-resilience\r\nowner: Test Owner\r\ntags: [resilience, latency]\r\nstatus: stable\r\nsolves: [transient errors fail my requests]\r\nfavourite: true\r\n---\r\n',
    );
    expect(frontmatter(root, RETRY, { lists: true })).toMatchObject({ favourite: 'true' });
    edit(QUEUE, (t) => t.replace(/^---\n/, '---  \n'));
    expect(await ok('set', 'queue', '--favourite', 'true')).toBe('queue: favourite=true');
    expect(read(QUEUE).startsWith('---\ntitle: Queue\n')).toBe(true);
  });

  it('writes a page that already had a problem, as long as the write adds none', async () => {
    edit(QUEUE, (t) => t.replace('Work waits in line.\n', 'Work waits in line.\n\n<!--meta polarity=pro-->\n'));
    expect(await ok('set', 'queue', '--favourite', 'true')).toBe('queue: favourite=true');
    expect(parsePage(read(QUEUE)).problems.map((p) => p.message)).toEqual(['a section fact belongs on the line under a heading']);
  });

  it('names every tag unknown when the vocabulary lists none', async () => {
    edit('docs/data/tags.json', (t) => `${JSON.stringify({ ...(JSON.parse(t) as object), terms: undefined }, null, 2)}\n`);
    expect(await fails('set', 'queue', '--tags', '["messaging","cloud"]')).toBe('--tags: not in the closed vocabulary: messaging, cloud\n  legal tags: \n  add one to docs/data/tags.json only if it will apply to 3+ pages');
  });

  it('refuses a page with no frontmatter, or one holding a line the dialect does not write', async () => {
    edit(RETRY, (t) => splitFrontmatter(t).body);
    expect(await fails('set', 'retry', '--favourite', 'true')).toBe(`${RETRY} has no frontmatter to set`);
    edit(QUEUE, (t) => t.replace('tags: [messaging]', 'tags:\n  - messaging'));
    expect(await fails('set', 'queue', '--favourite', 'true')).toBe(`${QUEUE}: the frontmatter holds a line that is not one \`key: value\` ("  - messaging") — kb.mjs writes only the dialect's one-line keys`);
  });
});

describe('link', () => {
  it('writes one record in its one spelling, and renders both pages from it', async () => {
    const [q, r] = [read(QUEUE), read(RETRY)];
    expect(await ok('link', 'queue', 'combines-with', 'retry', '--note', 'Queue the *retries*')).toBe(
      'queue —[combines-with]→ retry written to docs/data/relations.json, and both pages\' relationships blocks rendered from it. Now run: make gen && make validate',
    );
    const file = json<RelationsFile>(RELATIONS);
    expect(file.updated).toBe(TODAY);
    // Symmetric: read from the page first in site-path order (distributed < messaging).
    expect(file.relations.at(-1)).toEqual({ a: 'retry', verb: 'combines-with', b: 'queue', note_a: 'Queue the \\*retries\\*', note_b: 'Queue the \\*retries\\*' });
    expect(JSON.parse(await ok('related', 'queue', '--json'))).toEqual([{ type: 'combines-with', verb: 'combines-with', to: 'retry', label: 'Combines with', note: 'Queue the *retries*' }]);
    expect((JSON.parse(await ok('related', 'retry', '--json')) as { to: string }[]).map((x) => x.to)).toEqual(['breaker', 'queue']);
    expect(read(QUEUE)).toContain('<!-- relationships:start -->\n\n<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->\n\n**Combines with**\n\n- [Retry](../distributed/resilience/retry.md) — Queue the \\*retries\\*\n\n<!-- relationships:end -->\n');
    contained(q, read(QUEUE), ['relationships']);
    contained(r, read(RETRY), ['relationships']);
    invariants();
  });

  it('writes a pair by its first verb, the notes swapped, and each side its own note and group', async () => {
    await ok('link', 'storm', 'mitigated-by', 'retry', '--note', 'Retries with jitter', '--note-back', 'Spreads the storm', '--group', 'Softened by', '--group-back', 'Prevents');
    expect(json<RelationsFile>(RELATIONS).relations.at(-1)).toEqual({ a: 'retry', verb: 'prevents-hazard', b: 'storm', note_a: 'Spreads the storm', note_b: 'Retries with jitter', group_b: 'Softened by' });
    expect(JSON.parse(await ok('related', 'storm', '--json'))).toContainEqual({ type: 'mitigated-by', verb: 'mitigated-by', to: 'retry', label: 'Mitigated by', note: 'Retries with jitter' });
    expect(read(STORM)).toContain('**Softened by**\n\n- [Retry](../patterns/distributed/resilience/retry.md) — Retries with jitter');
    expect(read(RETRY)).toContain('**Prevents**\n\n- [Storm](../../../hazards/storm.md) — Spreads the storm');
    invariants();
  });

  it('gives a page its markers, or its whole relationships block, when it has none', async () => {
    const q = read(QUEUE);
    expect(q).not.toContain('relationships:start');
    await ok('link', 'queue', 'alternative-to', 'steady');
    expect(read(QUEUE)).toMatch(/## How it relates\n<!--meta block=relationships-->\n\n<!-- relationships:start -->\n\n.*\n\n\*\*Alternative to\*\*\n\n- \[Steady\]\(\.\.\/\.\.\/themes\/steady\.md\)\n\n<!-- relationships:end -->\n$/);
    // No theme carries the block, so it takes the heading most pages of any kind give it.
    expect(read(STEADY)).toContain('- A sibling with no link.\n\n## How it relates\n<!--meta block=relationships-->\n\n<!-- relationships:start -->\n\n');
    expect(read(STEADY).endsWith('**Alternative to**\n\n- [Queue](../patterns/messaging/queue.md)\n\n<!-- relationships:end -->\n')).toBe(true);
    contained(q, read(QUEUE), ['relationships']);
    invariants();
  });

  it('gives a relationships block its markers where it stands, when a section follows it', async () => {
    edit(QUEUE, (t) => `${t}\n## Stray\n\nNot a block.\n`);
    await ok('link', 'queue', 'alternative-to', 'retry');
    expect(read(QUEUE)).toMatch(/<!--meta block=relationships-->\n\n<!-- relationships:start -->\n[^]*<!-- relationships:end -->\n\n## Stray\n\nNot a block\.\n$/);
  });

  it('puts a missing relationships block last, as every kind orders it, after a trailing section', async () => {
    edit(BREAKER, (t) => `${t.slice(0, t.indexOf('## How it relates')).replace(/\n+$/, '\n')}\n## Stray\n\nNot a block.\n`);
    await ok('link', 'breaker', 'alternative-to', 'queue');
    expect(read(BREAKER)).toMatch(/## Stray\n\nNot a block\.\n\n## How it relates\n<!--meta block=relationships-->\n\n<!-- relationships:start -->\n[^]*<!-- relationships:end -->\n$/);
  });

  it('pins an implements edge to a table row with its label, and refuses a pin it cannot make', async () => {
    edit(STEADY, (t) => `${t}\n## What each cloud calls it\n<!--meta block=mapping-->\n\n| Capability | AWS |\n| --- | --- |\n| Blobs | S3 |\n| Queues | SQS |\n`);
    expect(await fails('link', 'steady', 'implements', 'queue', '--maps', 'mapping-row-9')).toBe(
      '--maps: steady has no row "mapping-row-9" in its mapping or matrix table (rows: mapping-row-1 Blobs; mapping-row-2 Queues)',
    );
    // A page with no mapping or matrix table has no rows to list.
    expect(await fails('link', 'retry', 'implements', 'queue', '--maps', 'mapping-row-1')).toBe('--maps: retry has no row "mapping-row-1" in its mapping or matrix table');
    expect(await fails('link', 'steady', 'combines-with', 'queue', '--maps', 'mapping-row-2')).toBe(
      '--maps: only an implements edge pins a table row, and this edge reads "combines-with"',
    );
    // Written from the pattern's side, the record still reads implements from the page that holds the row.
    await ok('link', 'queue', 'implemented-by', 'steady', '--note', 'Bought', '--note-back', 'Sells it', '--maps', 'mapping-row-2');
    expect(json<RelationsFile>(RELATIONS).relations.at(-1)).toEqual({
      a: 'steady',
      verb: 'implements',
      b: 'queue',
      note_a: 'Sells it',
      note_b: 'Bought',
      maps_a: 'mapping-row-2',
      maps_label_a: 'Queues',
    });
  });

  it('refuses a second edge between two pages, a page related to itself, and a bad invocation', async () => {
    expect(await fails('link', 'retry', 'alternative-to', 'breaker')).toBe('retry already relates to breaker via "combines-with" — edit that edge instead of adding a second one');
    expect(await fails('link', 'storm', 'combines-with', 'breaker')).toBe('storm already relates to breaker via "mitigated-by" — edit that edge instead of adding a second one');
    expect(await fails('link', 'retry', 'combines-with', 'retry')).toBe('a page cannot relate to itself');
    const usage = await fails('link', 'retry', 'loves', 'queue');
    expect(usage).toMatch(/^usage: kb\.mjs link <from> <verb> <to> \[--note "…"\] \[--note-back "…"\] \[--group "…"\] \[--group-back "…"\] \[--maps <row-id>\]\nverbs: combines-with, alternative-to, /);
    // The first line is the signature the usage prints, so the two cannot differ.
    expect(usage.split('\n')[0]).toBe(`usage: ${usageLine('link')}`);
    // A positional left out is misuse and gets the same usage; a verb that is no verb, or what every object inherits, is a refusal.
    expect(await misuse('link', 'retry', 'combines-with')).toBe(usage);
    expect(await misuse('link', 'retry')).toBe(usage);
    expect(await misuse('link')).toBe(usage);
    expect(await fails('link', 'retry', 'constructor', 'queue')).toBe(usage);
    expect(await fails('link', 'nope', 'combines-with', 'queue')).toBe('unknown id: nope');
    expect(await fails('link', 'retry', 'combines-with', 'queue', '--group', ' ')).toBe('--group: cannot be empty');
  });

  // Root ignores file modes, so the permission failure this test needs cannot be produced.
  it.skipIf(!PERMISSIONS_ENFORCED)('writes all of an edge or none of it: a file it cannot write leaves every file as it was', async () => {
    const before = sb.snapshot();
    const dir = path.join(root, 'docs/patterns/messaging');
    fs.chmodSync(dir, 0o555);
    try {
      const r = await kb('link', 'retry', 'combines-with', 'queue', '--note', 'x').catch((e: unknown) => e as Error);
      expect(r).toBeInstanceOf(Error);
      expect(String(r)).toMatch(/EACCES/);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    expect(sb.snapshot()).toEqual(before);
  });

  it('creates the folders a new file needs, and removes them again when the write fails', () => {
    const change = new Change(root);
    change.put('docs/fresh/deeper/note.json', '{}\n');
    expect(change.commit()).toBe(1);
    expect(read('docs/fresh/deeper/note.json')).toBe('{}\n');
    const blocked = new Change(root);
    blocked.put('docs/other/deeper/a.json', 'a');
    blocked.put('docs/other/deeper/b.json', 'b');
    const real = fs.writeFileSync.bind(fs);
    let n = 0;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      n += 1;
      if (n === 2) throw new Error('ENOSPC: no space');
      real(file, data, options);
    });
    try {
      expect(() => blocked.commit()).toThrow('ENOSPC');
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(path.join(root, 'docs/other/deeper'))).toBe(false);

    // A rename that fails after a new file went in takes that file out again.
    const renamed = new Change(root);
    renamed.put('docs/third/a.json', 'a');
    renamed.put('docs/third/b.json', 'b');
    const realRename = fs.renameSync.bind(fs);
    let m = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      m += 1;
      if (m === 2) throw new Error('EIO: rename failed');
      realRename(from, to);
    });
    try {
      expect(() => renamed.commit()).toThrow('EIO');
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.existsSync(path.join(root, 'docs/third/a.json'))).toBe(false);
  });

  it('puts back what it replaced when a rename fails partway', async () => {
    const before = sb.snapshot();
    const real = fs.renameSync.bind(fs);
    let n = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      n += 1;
      if (n === 2) throw Object.assign(new Error('EIO: rename failed'), { code: 'EIO' });
      real(from, to);
    });
    try {
      await expect(kb('link', 'retry', 'combines-with', 'queue', '--note', 'x')).rejects.toThrow('EIO');
    } finally {
      spy.mockRestore();
    }
    expect(sb.snapshot()).toEqual(before);
  });

  it('refuses to render an edge to no page, and a block that lost one marker', async () => {
    edit(RELATIONS, (t) => t.replace('"b": "storm"', '"b": "gone"'));
    expect(await fails('link', 'breaker', 'alternative-to', 'queue')).toBe('breaker: relations: breaker → gone: no such page');
    cutoverTree();
    edit(RETRY, (t) => t.replace('<!-- relationships:end -->', ''));
    expect(await fails('link', 'retry', 'alternative-to', 'queue')).toBe(`${RETRY}: the relationships block has one of its markers but not <!-- relationships:end --> — mend it by hand first`);
  });
});

describe('unlink', () => {
  it('drops every edge between two pages, from the data and from both blocks', async () => {
    const [b, s] = [read(BREAKER), read(STORM)];
    expect(await ok('unlink', 'storm', 'breaker')).toBe(
      'storm: removed mitigated-by → breaker (with its now-empty group)\nbreaker: removed prevents-hazard → storm (with its now-empty group)\nNow run: make gen && make validate',
    );
    expect(json<RelationsFile>(RELATIONS).relations.map((r) => `${r.a} ${r.verb} ${r.b}`)).toEqual(['breaker combines-with retry']);
    expect(read(STORM)).toContain('<!-- relationships:start -->\n\n<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->\n\n<!-- relationships:end -->');
    contained(b, read(BREAKER), ['relationships']);
    contained(s, read(STORM), ['relationships']);
    invariants();
  });

  it('drops two families on one pair, and says a group that keeps other rows is not empty', async () => {
    await ok('link', 'queue', 'combines-with', 'retry');
    edit(RELATIONS, (t) => {
      const f = JSON.parse(t) as RelationsFile;
      return `${JSON.stringify({ ...f, relations: [...f.relations, { a: 'queue', verb: 'often-confused-with', b: 'retry', note_a: '', note_b: '' }] }, null, 2)}\n`;
    });
    expect(await ok('unlink', 'retry', 'queue')).toBe(
      'retry: removed combines-with → queue\nretry: removed often-confused-with → queue (with its now-empty group)\nqueue: removed combines-with → retry (with its now-empty group)\nqueue: removed often-confused-with → retry (with its now-empty group)\nNow run: make gen && make validate',
    );
    invariants();
  });

  it('re-pins a group order that named a group now gone, and drops a pin the default order already gives', async () => {
    await ok('link', 'retry', 'alternative-to', 'queue');
    await ok('link', 'retry', 'prevents-hazard', 'storm', '--group', 'Custom');
    await ok('link', 'queue', 'combines-with', 'storm');
    edit(RELATIONS, (t) => {
      const f = JSON.parse(t) as RelationsFile;
      return `${JSON.stringify({ ...f, group_order: { retry: ['Alternative to', 'Custom', 'Combines with'], breaker: ['Combines with', 'Prevents'], queue: ['Combines with'] } }, null, 2)}\n`;
    });
    await ok('unlink', 'retry', 'queue');
    // The pin keeps the order it gave the groups still there; queue's pin names only groups it still has.
    expect(json<RelationsFile>(RELATIONS).group_order).toEqual({ retry: ['Custom', 'Combines with'], breaker: ['Combines with', 'Prevents'], queue: ['Combines with'] });
    await ok('unlink', 'queue', 'storm');
    expect(json<RelationsFile>(RELATIONS).group_order).toEqual({ retry: ['Custom', 'Combines with'], breaker: ['Combines with', 'Prevents'] });
    await ok('unlink', 'retry', 'storm');
    expect(json<RelationsFile>(RELATIONS).group_order).toEqual({ breaker: ['Combines with', 'Prevents'] });
    await ok('unlink', 'breaker', 'storm');
    expect(json<RelationsFile>(RELATIONS).group_order).toBeUndefined();
    invariants();
  });

  it('says when two pages share no edge, and refuses a bad invocation', async () => {
    const r = await kb('unlink', 'queue', 'retry');
    expect(r).toEqual({ code: 1, out: '', err: 'queue: no relation to retry\nretry: no relation to queue' });
    expect(await misuse('unlink', 'queue')).toBe('usage: kb.mjs unlink <a> <b>');
    expect(await misuse('unlink')).toBe(`usage: ${usageLine('unlink')}`);
    expect(await fails('unlink', 'queue', 'queue')).toBe('a page cannot relate to itself');
    expect(await fails('unlink', 'queue', 'nope')).toBe('unknown id: nope');
  });
});

describe('wild', () => {
  it('replaces the block with the items given, and dumps them back in the same shape', async () => {
    const before = read(BREAKER);
    const items = [
      { id: 'opossum', name: 'opossum', note: 'Node: <code>errorThresholdPercentage</code> &amp; more.' },
      { id: 'hystrix', name: 'Hystrix', note: 'The JVM one.', href: 'https://github.com/Netflix/Hystrix' },
      { id: 'resilience4j', name: 'Resilience4j', note: 'Its *successor* — a ~modular~ one.' },
    ];
    expect(await ok('wild', 'breaker', '--items', JSON.stringify(items))).toBe('breaker: wild = 3 example(s)');
    const dumped = (await getJson('breaker', '--block', 'wild')) as { items: { wild: unknown[] } };
    expect(dumped.items.wild).toEqual(items);
    contained(before, read(BREAKER), ['wild']);
    // What was dumped goes back in unchanged.
    const bytes = read(BREAKER);
    await ok('wild', 'breaker', '--items', JSON.stringify(dumped.items.wild));
    expect(read(BREAKER)).toBe(bytes);
    invariants();
  });

  it('puts the block in before the next block the kind orders, and takes it out', async () => {
    const before = read(RETRY);
    await ok('wild', 'retry', '--items', '[{"id":"polly","name":"Polly","note":"The .NET one."}]');
    expect(read(RETRY)).toContain('```\n\n## In the wild\n<!--meta block=wild-->\n\n- **Polly** — The .NET one. {#wild-polly}\n\n## How it relates');
    expect(await ok('wild', 'retry', '--items', '[]')).toBe('retry: wild removed');
    expect(read(RETRY)).toBe(before);
    expect(await ok('wild', 'retry', '--items', '[]')).toBe('retry: wild removed');
    expect(read(RETRY)).toBe(before);
  });

  it('refuses items that would not make a valid block, and a kind without one', async () => {
    // A malformed call (exit 2: fix the command): no --items, text that is no JSON, items of the wrong shape or grammar.
    const bad = async (items: string): Promise<string> => misuse('wild', 'breaker', '--items', items);
    expect(await misuse('wild', 'breaker')).toBe('pass --items \'[{"id":…,"name":…,"note":…}]\' — kb.mjs get <id> --block wild --json dumps the current ones');
    expect(await misuse('wild', 'breaker', '--items', '[{"id":"x"')).toMatch(/^--items is not valid JSON: /);
    expect(await bad('{}')).toBe('--items: must be a JSON array');
    expect(await bad('[1]')).toBe('--items: every item must be an object');
    expect(await bad('[{"id":"x","name":"X"}]')).toBe('--items: every item needs id, name and note');
    expect(await bad('[{"id":"X Y","name":"X","note":"n"}]')).toBe('--items: every id is lower-case letters, digits and hyphens (it becomes #wild-<id>)');
    expect(await bad('[{"id":"x","name":"X","note":"n","href":"a b"}]')).toBe('--items: an href is one URL, with no space or angle bracket');
    expect(await bad('[{"id":"x","name":"X","note":"n","href":1}]')).toBe('--items: an href is one URL, with no space or angle bracket');
    expect(await bad('[{"id":"x","name":"X","note":"n","level":"advanced"}]')).toBe('--items: `level` is retired: a page reads at one depth; delete the key');
    // A well-formed call the page refuses (exit 1: fix the content): a repeated id, a kind with no such block.
    expect(await fails('wild', 'breaker', '--items', '[{"id":"x","name":"X","note":"n"},{"id":"x","name":"Y","note":"m"}]')).toMatch(/^docs\/patterns\/distributed\/resilience\/breaker\.md: the write would leave a problem on the page — duplicate id "wild-x"/);
    expect(await fails('wild', 'storm', '--items', '[]')).toBe('storm: a hazard page carries no wild block');
  });
});

describe('production', () => {
  it('replaces the block, a group per non-empty list, under the page’s own group headings', async () => {
    const before = read(BREAKER);
    const knobs = [{ label: 'Threshold', note: 'When it opens (<code>n</code>).' }];
    const checklist = ['Every call has a timeout', { text: 'Operators can force it' }];
    expect(await ok('production', 'breaker', '--knobs', JSON.stringify(knobs), '--signals', '[]', '--checklist', JSON.stringify(checklist))).toBe(
      'breaker: production = knobs:1 signals:0 failures:0 checklist:2',
    );
    const dumped = (await getJson('breaker', '--block', 'production')) as { items: { production: unknown } };
    expect(dumped.items.production).toEqual({ knobs, signals: [], failures: [], checklist: [{ text: 'Every call has a timeout' }, { text: 'Operators can force it' }] });
    expect(read(BREAKER)).toContain('### Tuning knobs\n<!--meta polarity=knob-->\n\n- **Threshold** — When it opens (`n`).\n\n### Readiness checklist\n<!--meta polarity=check-->');
    contained(before, read(BREAKER), ['production']);
    invariants();
  });

  it('puts the block in with the corpus’s headings, and takes it out when every list is empty', async () => {
    const before = read(RETRY);
    await ok('production', 'retry', '--signals', '[{"label":"Attempts","note":"Per call."}]');
    expect(read(RETRY)).toContain('## In production\n<!--meta block=production-->\n\n### Signals to watch\n<!--meta polarity=signal-->\n\n- **Attempts** — Per call.\n\n## How it relates');
    expect(await ok('production', 'retry', '--knobs', '[]', '--signals', '[]')).toBe('retry: production removed');
    expect(read(RETRY)).toBe(before);
  });

  it('refuses what scripts/kb.mjs refused', async () => {
    // Every refusal of the lists is a malformed call (exit 2): none of the four, text that is no JSON, or JSON of the wrong shape.
    expect(await misuse('production', 'breaker')).toMatch(/^pass --knobs \/ --signals \/ --failures /);
    expect(await misuse('production', 'breaker', '--knobs', '[{')).toMatch(/^--knobs is not valid JSON: /);
    expect(await misuse('production', 'breaker', '--checklist', 'every call has a timeout')).toMatch(/^--checklist is not valid JSON: /);
    expect(await misuse('production', 'breaker', '--knobs', '{}')).toBe('--knobs: must be a JSON array');
    expect(await misuse('production', 'breaker', '--signals', '["x"]')).toBe('--signals: every item must be an object');
    expect(await misuse('production', 'breaker', '--failures', '[{"label":"x"}]')).toBe('--failures: every item needs label and note');
    expect(await misuse('production', 'breaker', '--knobs', '[{"label":"x","note":"y","level":"advanced"}]')).toBe('--knobs: `level` is retired: a page reads at one depth; delete the key');
    expect(await misuse('production', 'breaker', '--checklist', '{}')).toBe('--checklist: must be a JSON array');
    expect(await misuse('production', 'breaker', '--checklist', '[" "]')).toBe('--checklist: every item must be a non-empty string, or an object with text');
    expect(await misuse('production', 'breaker', '--checklist', '[{"text":""}]')).toBe('--checklist: every item must be a non-empty string, or an object with text');
    expect(await misuse('production', 'breaker', '--checklist', '[1]')).toBe('--checklist: every item must be a non-empty string, or an object with text');
    expect(await misuse('production', 'breaker', '--checklist', '[{"text":"t","level":"x"}]')).toBe('--checklist: `level` is retired: a page reads at one depth; delete the key');
    // A kind with no production block is the KB's refusal (exit 1).
    expect(await fails('production', 'storm', '--knobs', '[]')).toBe('storm: a hazard page carries no production block');
  });
});

const QUEUE_COSTS = '- **Latency.** Every call pays for one extra hop.\n- **Upkeep.** Someone owns the counters and the thresholds.';

/** An explanation inside KB-014's word bounds, opening with `first`. */
const explanation = (first: string): string => `${first} ${'It counts recent failures and answers from a fallback once there are too many. '.repeat(7)}`.trim();

describe('explain', () => {
  it('rewrites the block under the page’s heading: the paragraph, then the labelled example', async () => {
    const before = read(QUEUE);
    const text = `${explanation('A line of  work.')} {x}`;
    expect(await ok('explain', 'queue', '--text', text, '--example', 'Checkout  queues 200 orders a second.')).toMatch(/^queue: explain = \d+w, 2 cost\(s\), then an example of 6w$/);
    // No --costs: the page's own list stays between the paragraph and the example.
    expect(read(QUEUE)).toContain(`## Explained\n<!--meta block=explain-->\n\n${explanation('A line of work.')} \\{x}\n\n${QUEUE_COSTS}\n\n**Example.** Checkout queues 200 orders a second.\n\n## How it works`);
    const got = (await getJson('queue', '--block', 'explain')) as { blocks: { explain: string }; items: { explain: { text: string; example: string } } };
    expect(got.blocks.explain).toContain('\n\nEXAMPLE\n\nCheckout queues 200 orders a second.');
    expect(got.items.explain).toEqual({
      text: `${explanation('A line of work.')} {x}`,
      costs: [
        { lead: 'Latency.', note: 'Every call pays for one extra hop.' },
        { lead: 'Upkeep.', note: 'Someone owns the counters and the thresholds.' },
      ],
      example: 'Checkout queues 200 orders a second.',
    });
    contained(before, read(QUEUE), ['explain']);
    invariants();
  });

  it('writes a sketch example as a captioned fence, newlines kept, and dumps it back', async () => {
    await ok('explain', 'queue', '--text', explanation('A line of work.'), '--example', 'const a = 1;\nconst b = 2;', '--example-lang', 'typescript', '--example-caption', 'How does  it look?');
    expect(read(QUEUE)).toContain('```typescript caption="How does it look?"\nconst a = 1;\nconst b = 2;\n```\n\n## How it works');
    expect(await ok('explain', 'queue', '--text', explanation('A line of work.'), '--example', 'x = 1', '--example-lang', 'python', '--example-caption', 'One line.')).toMatch(/2 cost\(s\), then a python sketch of 1 lines$/);
    const got = (await getJson('queue', '--block', 'explain')) as { blocks: { explain: string }; items: { explain: unknown } };
    expect(got.items.explain).toMatchObject({ text: explanation('A line of work.'), example: 'x = 1', exampleLang: 'python', exampleCaption: 'One line.' });
    expect(got.blocks.explain).toContain('EXAMPLE\n\nOne line.\n\n```python\nx = 1\n```');
  });

  it('writes the costs list from --costs, links a term from [label](path), and drops the list on []', async () => {
    const costs = JSON.stringify([
      { lead: 'Latency.', note: 'One more hop.' },
      { lead: 'Upkeep.', note: 'Someone owns [the breaker](./breaker.md).' },
    ]);
    const text = `A [breaker](../resilience/breaker.md) opens. ${explanation('It guards a call.')}`;
    await ok('explain', 'queue', '--text', text, '--costs', costs, '--example', 'One order.');
    expect(read(QUEUE)).toContain(`A [breaker](../resilience/breaker.md) opens. It guards a call.`);
    // A link inside a bullet's note is plain text there: the writer links the paragraph only.
    expect(read(QUEUE)).toContain('- **Upkeep.** Someone owns \\[the breaker\\](./breaker.md).');
    const dumped = (await getJson('queue', '--block', 'explain')) as { items: { explain: { text: string; costs: unknown[] } } };
    expect(dumped.items.explain.text).toContain('A [breaker](../resilience/breaker.md) opens.');
    expect(dumped.items.explain.costs).toHaveLength(2);
    // The dump feeds the writer: rewriting it leaves the page byte for byte as it was.
    const written = read(QUEUE);
    await ok('explain', 'queue', '--text', dumped.items.explain.text, '--example', 'One order.');
    expect(read(QUEUE)).toBe(written);
    // A design may leave the list out: --costs [] drops what it had, and no flag keeps what it has.
    await ok('explain', 'shortener', '--text', text, '--costs', costs, '--example', 'One order.');
    expect(read(SHORTENER)).toContain('- **Latency.** One more hop.');
    await ok('explain', 'shortener', '--text', text, '--example', 'Two orders.');
    expect(read(SHORTENER)).toContain('- **Latency.** One more hop.');
    expect(await ok('explain', 'shortener', '--text', text, '--costs', '[]', '--example', 'Three orders.')).toMatch(/0 cost\(s\)/);
    expect(read(SHORTENER)).not.toContain('Latency.');
  });

  it('refuses a bad --costs, and a pattern with no costs list', async () => {
    const text = explanation('A line.');
    expect(await misuse('explain', 'queue', '--text', text, '--example', 'x', '--costs', 'nope')).toContain('--costs is not valid JSON');
    expect(await misuse('explain', 'queue', '--text', text, '--example', 'x', '--costs', '{}')).toBe('--costs: must be a JSON array');
    expect(await misuse('explain', 'queue', '--text', text, '--example', 'x', '--costs', '[{"lead":"a"}]')).toBe('--costs: every item needs a lead and a note');
    expect(await misuse('explain', 'queue', '--text', text, '--example', 'x', '--costs', '[1]')).toBe('--costs: every item needs a lead and a note');
    // A costs list the explain block's rules refuse (KB-014) is the KB's refusal: exit 1.
    expect(await fails('explain', 'queue', '--text', text, '--example', 'x', '--costs', '[]')).toContain('no costs list');
    expect(await fails('explain', 'queue', '--text', text, '--example', 'x', '--costs', '[{"lead":"A.","note":"b"}]')).toContain('the costs list has 1 bullets');
  });

  it('puts the block in after the lead block of a design without one, and takes it out', async () => {
    const before = read(SHORTENER);
    await ok('explain', 'shortener', '--text', explanation('A short link.'), '--example', 'A million a day.');
    // No design in the fixture has the block: the heading is the one other kinds give it.
    expect(read(SHORTENER)).toContain('About a million a day.\n\n## Explained\n<!--meta block=explain-->\n\nA short link.');
    expect(await ok('explain', 'shortener', '--text', '', '--example', ' ')).toBe('shortener: explain removed');
    expect(read(SHORTENER)).toBe(before);
  });

  it('treats a missing flag, a caption without a language and a sketch without a caption as misuse', async () => {
    expect(await misuse('explain', 'queue', '--text', 'a')).toBe('pass --text "…" and --example "…" (both empty to remove)');
    expect(await misuse('explain', 'queue', '--example', 'a')).toBe('pass --text "…" and --example "…" (both empty to remove)');
    expect(await misuse('explain', 'queue')).toBe('pass --text "…" and --example "…" (both empty to remove)');
    expect(await misuse('explain', 'queue', '--text', 'a', '--example', 'b', '--example-caption', 'c')).toBe('--example-caption goes with --example-lang: a caption names a sketch');
    expect(await misuse('explain', 'queue', '--text', 'a', '--example', 'b', '--example-lang', 'text')).toBe('--example-lang needs --example-caption "…": a sketch example names the question it answers');
    expect(await misuse('explain', 'queue', '--text', 'a', '--example', 'b', '--example-lang', 'text', '--example-caption', ' ')).toBe('--example-lang needs --example-caption "…": a sketch example names the question it answers');
  });

  it('refuses a block KB-014 rejects, and writes nothing', async () => {
    const before = read(QUEUE);
    const refused = await fails('explain', 'queue', '--text', 'Too short.', '--example', 'An example.');
    expect(refused).toBe('queue: the explain block breaks KB-014:\n  - the explanation is 2 words — it runs 60 to 180, and what it costs goes in the costs list');
    expect(await fails('explain', 'queue', '--text', explanation('A line.'), '--example', 'word '.repeat(121))).toContain('the example is 121 words — at most 120');
    expect(await fails('explain', 'queue', '--text', explanation('A line.'), '--example', 'x', '--example-lang', 'mermaid', '--example-caption', 'c')).toContain('mermaid');
    expect(await fails('explain', 'queue', '--text', explanation('A line.'), '--example', '')).toContain('holds no words');
    expect(await fails('explain', 'queue', '--text', explanation('A line.'), '--example', 'x', '--example-lang', 'two words', '--example-caption', 'c')).toContain('neither #id nor key=value');
    expect(read(QUEUE)).toBe(before);
  });
});

describe('the retired level command', () => {
  it('names the retirement and writes nothing', async () => {
    const before = read(BREAKER);
    expect(await misuse('level', 'breaker', 'tradeoffs-con-1', 'advanced')).toBe('reading levels were retired: a page reads at one depth');
    expect(await misuse('get', 'breaker', '--level', 'basic')).toBe('--level is gone: reading levels were retired, a page reads at one depth');
    expect(read(BREAKER)).toBe(before);
  });
});

describe('new', () => {
  it('scaffolds a pattern in its area, with a structure row, and the reader and the lint take it as it is', async () => {
    expect(await ok('new', 'bulkhead', '--kind', 'pattern', '--band', 'distributed', '--group', 'distributed-resilience', '--name', 'Bulkhead', '--tags', '["resilience","latency"]', '--order', '1')).toBe(
      [
        'docs/patterns/distributed/resilience/bulkhead.md written, with its row in docs/data/site-structure.json. Next:',
        '  1. replace the TODOs (description, prose, diagram, sketch)',
        '  2. node scripts/kb.mjs set bulkhead --essence "…" --aliases … --solves …',
        '  3. node scripts/kb.mjs link bulkhead <verb> <other-id> --note "…"',
        '  4. make validate',
      ].join('\n'),
    );
    const area = json<{ areas: { id: string; pages: { slug: string }[] }[] }>(STRUCTURE).areas.find((a) => a.id === 'distributed-resilience');
    expect(area?.pages.map((p) => p.slug)).toEqual(['bulkhead', 'breaker', 'retry']);
    expect(json<{ updated: string }>(STRUCTURE).updated).toBe(TODAY);
    // The lint names only what is still to write: the TODO paragraph is short of KB-014's word bound.
    const linted = await kb('validate', 'bulkhead');
    expect(linted.code).toBe(1);
    expect(linted.err).toBe('1 problem(s) across 1 page(s):\n  bulkhead: KB-014 the explanation is 1 words — it runs 60 to 180, and what it costs goes in the costs list');
    const got = await getJson('bulkhead');
    expect(got).toMatchObject({ id: 'bulkhead', name: 'Bulkhead', kind: 'pattern', band: 'distributed', group: 'distributed-resilience', essence: 'TODO — the terse one-liner' });
    expect(Object.keys(got['blocks'] as object)).toEqual(['description', 'explain', 'structure', 'variations', 'tradeoffs', 'usage', 'sketch', 'relationships']);
    expect(frontmatter(root, 'docs/patterns/distributed/resilience/bulkhead.md', { lists: true })).toEqual({
      title: 'Bulkhead',
      description: 'TODO — the terse one-liner',
      area: 'distributed-resilience',
      owner: 'Test Owner',
      tags: ['resilience', 'latency'],
      status: 'draft',
    });
    await ok('link', 'bulkhead', 'combines-with', 'breaker');
    invariants();
  });

  it('scaffolds a theme with its profile, placed after the theme before it', async () => {
    await ok('new', 'calm', '--kind', 'theme', '--name', 'Calm', '--tags', '["resilience","latency"]');
    expect(json<LearningPaths>(PATHS).profiles.map((p) => p.id)).toEqual(['steady', 'calm', 'loop', 'ghost']);
    expect(json<LearningPaths>(PATHS).profiles[1]).toEqual({ id: 'calm', label: 'Calm', stages: [] });
    expect(read('docs/themes/calm.md')).toContain('## Patterns that implement the choice\n<!--meta block=tour-->\n\nTODO — the stages');
    expect((await kb('validate', 'calm')).err).toBe('1 problem(s) across 1 page(s):\n  calm: KB-014 the explanation is 1 words — it runs 60 to 180, and what it costs goes in the costs list');
    invariants();
  });

  it('files a theme in a designs tier that holds one, and each other kind in its folder', async () => {
    await ok('new', 'ring', '--kind', 'theme', '--group', 'designs-mid', '--name', 'Ring');
    expect(read('docs/themes/ring.md')).toContain('area: designs-mid');
    await ok('new', 'cache-kata', '--kind', 'design', '--group', 'designs-mid', '--name', 'Cache kata', '--tags', '["resilience","latency"]');
    const design = read('docs/designs/cache-kata.md');
    expect(Object.keys((await getJson('cache-kata'))['blocks'] as object)).toEqual(['description', 'requirements', 'entities', 'architecture', 'deepdives', 'tradeoffs', 'relationships']);
    expect(design).toContain('### Functional\n<!--meta requirement=fr-->\n\n- TODO.\n\n### Non-functional\n<!--meta requirement=nfr-->');
    expect(design).toContain('### Strengths\n<!--meta polarity=pro-->');
    expect(await ok('validate', 'cache-kata')).toBe('OK — 1 page(s) structurally valid.');
    await ok('new', 'fail-early', '--kind', 'principle', '--name', 'Fail early');
    expect(read('docs/principles/fail-early.md')).toContain('## Where it goes too far\n<!--meta block=overreach-->');
    invariants();
  });

  it('names the owner most pages in the area name, else most pages at all, and levels a page by its area', async () => {
    edit(BREAKER, (t) => t.replace('owner: Test Owner', 'owner: Other Owner'));
    await ok('new', 'one', '--kind', 'pattern', '--band', 'distributed', '--group', 'distributed-resilience', '--name', 'One');
    // One page each: the first in reading order wins the tie.
    expect(frontmatter(root, 'docs/patterns/distributed/resilience/one.md')['owner']).toBe('Other Owner');
    edit(RETRY, (t) => t.replace('owner: Test Owner', 'owner: Other Owner'));
    edit('docs/patterns/distributed/resilience/one.md', (t) => t.replace('owner: Other Owner', 'owner: Test Owner'));
    await ok('new', 'uno', '--kind', 'pattern', '--band', 'distributed', '--group', 'distributed-resilience', '--name', 'Uno');
    expect(frontmatter(root, 'docs/patterns/distributed/resilience/uno.md')['owner']).toBe('Other Owner');
    edit(STORM, (t) => t.replace('owner: Test Owner\n', 'owner:\n'));
    await ok('new', 'two', '--kind', 'hazard', '--name', 'Two');
    expect(frontmatter(root, 'docs/hazards/two.md')).toMatchObject({ owner: 'Test Owner' });
  });

  it('names no owner in a tree that has none', async () => {
    for (const p of new Corpus(root).pages) edit(p.source, (t) => t.replace(/^owner: .*\n/m, ''));
    await ok('new', 'calm', '--kind', 'theme', '--name', 'Calm');
    expect(frontmatter(root, 'docs/themes/calm.md')).toMatchObject({ owner: 'TODO' });
  });

  it('refuses a bad invocation, an id taken, and an area the kind cannot sit in', async () => {
    // A malformed call (exit 2: fix the command): short of its id, --kind, a name or, for a pattern, --band, each answered with the one usage.
    const usage = await misuse('new', 'x', '--kind', 'pattern', '--name', 'X');
    expect(usage).toMatch(/^usage: kb\.mjs new <id> --kind pattern\|hazard\|theme\|principle\|design\|capability\|comparison --band <b> \[--group <g>\] --name "…" \[--order <n>\]/);
    // This usage says which flags are required, so it is written by hand; it must still name every flag the spec gives the command.
    for (const name of flagsOf('new').filter((n) => n !== 'json' && n !== 'diagrams')) expect(usage, name).toContain(`--${name}`);
    expect(await misuse('new', 'x', '--kind', 'hazard')).toBe(usage);
    expect(await misuse('new', '--kind', 'hazard', '--name', 'X')).toBe(usage);
    expect(await misuse('new', 'x', '--kind', 'hazard', '--name', ' ')).toBe(usage);
    expect(await misuse('new', 'x', '--name', 'X')).toBe(usage);
    expect(await misuse('new')).toBe(usage);
    expect(await misuse('new', 'x', '--kind', 'hazard', '--name', 'X', '--tags', 'resilience')).toMatch(/^--tags is not valid JSON: /);
    // Also malformed: an id that is not an id, tags that are not a list of strings, a place that is not a whole number.
    expect(await misuse('new', 'Bad_Id', '--kind', 'hazard', '--name', 'X')).toBe('"Bad_Id" is not a page id — lower-case letters, digits and hyphens');
    expect(await misuse('new', 'x', '--kind', 'hazard', '--name', 'X', '--tags', '["a",1]')).toBe('--tags: must be a JSON array of non-empty strings');
    expect(await misuse('new', 'x', '--kind', 'hazard', '--name', 'X', '--tags', '"a"')).toBe('--tags: must be a JSON array of non-empty strings');
    expect(await misuse('new', 'x', '--kind', 'hazard', '--name', 'X', '--order', '0')).toBe('--order: a place in the area, 1 or more');
    expect(await misuse('new', 'x', '--kind', 'hazard', '--name', 'X', '--order', 'last')).toBe('--order: a place in the area, 1 or more');
    // Well formed, and the KB refuses it (exit 1: fix the content): a tag outside the vocabulary, no such kind, band or group, an id taken.
    expect(await fails('new', 'x', '--kind', 'hazard', '--name', 'X', '--tags', '["nope","latency"]')).toBe('--tags: not in the closed vocabulary: nope\n  legal tags: resilience latency messaging cloud testing');
    expect(await fails('new', 'x', '--kind', 'widget', '--name', 'X')).toBe('unknown kind: widget (one of pattern, hazard, theme, principle, design, capability, comparison)');
    expect(await fails('new', 'x', '--kind', 'pattern', '--band', 'nope', '--name', 'X')).toBe('unknown band: nope');
    expect(await fails('new', 'x', '--kind', 'pattern', '--band', 'distributed', '--name', 'X')).toBe('--group: distributed is split into areas — name one of distributed-resilience');
    expect(await fails('new', 'x', '--kind', 'pattern', '--band', 'distributed', '--group', 'messaging', '--name', 'X')).toBe(
      '--group: messaging is not an area a pattern page can sit in — one of distributed-resilience',
    );
    expect(await fails('new', 'x', '--kind', 'design', '--name', 'X')).toBe('--group: designs is split into areas — name one of designs-mid');
    expect(await fails('new', 'x', '--kind', 'hazard', '--group', 'themes', '--name', 'X')).toBe('--group: themes is not an area a hazard page can sit in — one of hazards');
    expect(await fails('new', 'retry', '--kind', 'pattern', '--band', 'messaging', '--name', 'X')).toBe(`already exists: ${RETRY}`);
    put('docs/hazards/ghost.md', '# Ghost\n');
    expect(await fails('new', 'ghost', '--kind', 'hazard', '--name', 'Ghost')).toBe('already exists: docs/hazards/ghost.md');
  });
});

describe('the parts a command reaches through the data', () => {
  const area = (id: string, nestUnder: string | null, sources: readonly string[]): Parameters<typeof placeNew>[0][number] => ({
    id,
    label: id,
    ...(nestUnder === null ? {} : { nestUnder }),
    hub: {},
    pages: sources.map((s) => ({ slug: path.posix.basename(s, '.md'), label: s, source: s, route: s })),
  });
  const kind = { id: 'pattern', folder: 'patterns', blocks: [], optional: [] };

  it('places a page in an area with no rows yet by the folder layout, and in its sibling’s folder otherwise', () => {
    const areas = [area('patterns', null, []), area('distributed', 'patterns', []), area('distributed-routing', 'distributed', []), area('ml', 'patterns', ['docs/patterns/elsewhere/x.md'])];
    expect(placeNew(areas, kind, 'distributed', 'distributed-routing').folder).toBe('docs/patterns/distributed/routing');
    expect(placeNew(areas, kind, 'ml', null).folder).toBe('docs/patterns/elsewhere');
    expect(placeNew([area('hazards', null, [])], { id: 'hazard', folder: 'hazards', blocks: [], optional: [] }, null, null).folder).toBe('docs/hazards');
  });

  it('puts a new profile after the nearest earlier theme’s, else before the next one’s, else last', () => {
    const lp = { version: 1, updated: '', note: '', notes: {}, profiles: ['a', 'c'].map((id) => ({ id, label: id, stages: [] })) } as LearningPaths;
    const p = { id: 'n', label: 'n', stages: [] };
    const ids = (order: string[]): string[] => withProfile(lp, order, 'n', p).profiles.map((x) => x.id);
    expect(ids(['a', 'n', 'c'])).toEqual(['a', 'n', 'c']);
    expect(ids(['n', 'c', 'a'])).toEqual(['a', 'n', 'c']);
    expect(ids(['n'])).toEqual(['a', 'c', 'n']);
  });

  it('heads a block by what most pages of the kind call it, else any kind, else by its name', async () => {
    const { Session } = await import('./cli.js');
    const { parseArgs } = await import('./args.js');
    edit(RETRY, (t) => t.replace('## Code sketch', '## A sketch'));
    const s = new Session(new Corpus(root), parseArgs([]));
    expect(commonHeading(s, 'pattern', 'sketch')).toBe('Code sketch');
    expect(commonHeading(s, 'design', 'levels')).toBe('Levels');
    expect(commonHeading(s, 'design', 'requirements')).toBe('Requirements');
    expect(commonHeading(s, 'design', 'tradeoffs', 'con')).toBe('Risks');
    expect(commonHeading(s, 'pattern', 'tradeoffs', 'con')).toBe('Cons');
  });
});
