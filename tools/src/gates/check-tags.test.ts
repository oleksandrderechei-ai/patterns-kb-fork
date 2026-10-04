/**
 * Every page tagged from one closed, faceted vocabulary (spec: kb.data.tags).
 *
 * The fail cases are the point of the suite, and one of them is the reason the
 * gate exists at all: a block list renders perfectly and carries no tags, so
 * without a check for the form there is no symptom to notice.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { frontmatter } from '../lib/frontmatter.js';
import { TYPES_FILE } from '../lib/published.js';
import { capture, expectFail, expectMisuse, expectPass, makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';
import { TAG_LIST } from '../lib/tags.js';
import { ALLOWLIST, FRONTMATTER_FREE, ID_SHAPE, lookupOf, NAME, scanSet, spec, structuralFindings, tagFindings } from './check-tags.js';

type Json = Record<string, unknown>;

const term = (id: string, facet: string, applies: string[] = ['page'], label?: string): Json => ({
  id,
  facet,
  ...(label === undefined ? {} : { label }),
  definition: 'What it means.',
  applies,
  owner: 'Tests',
});

const TERMS = [
  term('caching', 'topic', ['page', 'exercise'], 'Caching'),
  term('resilience', 'topic', ['page', 'exercise'], 'Resilience'),
  term('latency', 'skill'),
  term('drills', 'skill', ['exercise']),
  term('cloud', 'language'),
];
const IDS = TERMS.map((t) => String(t['id']));

const tagList = (terms: unknown[] = TERMS, facets: unknown = { topic: 'about', skill: 'doing', language: 'machinery' }): string =>
  JSON.stringify({ version: 1, updated: '2026-09-24', note: 'n', facets, terms });

const tuple = (...values: string[]): string => `export const TAGS = [\n${values.map((v) => `  '${v}',`).join('\n')}\n] as const;\n`;

const allowlist = (entries: unknown[] = []): string => JSON.stringify({ version: 1, updated: '2026-09-24', note: 'n', entries });

let sb: Sandbox;

/** A page under docs/, with whatever tags line the test wants (null: none). */
function page(rel: string, tagLine: string | null = 'tags: [caching, latency]'): void {
  sb.write(
    rel,
    ['---', 'title: A page', 'description: A page.', 'area: caching', 'owner: Tests', ...(tagLine === null ? [] : [tagLine]), '---', '', '# A page', ''].join('\n'),
  );
}

function exercise(rel: string, tagLine = 'tags: [caching, resilience, drills]', type = 'exercise'): void {
  sb.write(rel, ['---', 'description: Do the thing.', 'area: drills', `type: ${type}`, 'level: [beginner]', tagLine, '---', '', '# Do the thing', ''].join('\n'));
}

beforeEach(() => {
  sb = makeSandbox();
  sb.write(TAG_LIST, tagList());
  sb.write(TYPES_FILE, tuple(...IDS));
  sb.write(ALLOWLIST, allowlist());
  page('docs/patterns/one.md', 'tags: [caching, latency]');
  page('docs/patterns/two.md', 'tags: [resilience, latency, cloud]');
  exercise('docs/exercises/drills/three.md');
});
afterEach(() => sb.cleanup());

const err = async (argv: string[] = []): Promise<string> => (await sb.run(spec, argv)).err;

describe('a clean tree', () => {
  it('exits 0 with a summary counting pages, exercises and terms', async () => {
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe(`[${NAME}] OK — 2 pages, 1 exercises, 5 terms`);
    expect(r.err).toBe('');
  });

  it('skips the context layers and the refused trees', async () => {
    sb.write('docs/CLAUDE.md', '# Working in docs/\n');
    sb.write(`${FRONTMATTER_FREE[0]}2026-09-24-sweep.md`, '# A record\n');
    expect(scanSet(sb.dir)).toEqual(['docs/exercises/drills/three.md', 'docs/patterns/one.md', 'docs/patterns/two.md']);
    expectPass(await sb.run(spec));
  });

  it('skips an exercise index, which carries no tags by design', async () => {
    exercise('docs/exercises/drills/INDEX.md', 'tags: []', 'index');
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toContain('2 pages, 1 exercises');
  });
});

describe('tags-O2', () => {
  // A clean tree: a tag list of four terms, a tuple listing all four, three pages using them.
  const FOUR = [term('caching', 'topic', ['page'], 'Caching'), term('resilience', 'topic', ['page'], 'Resilience'), term('latency', 'skill'), term('cloud', 'language')];
  const FOUR_IDS = FOUR.map((t) => String(t['id']));

  beforeEach(() => {
    sb.rm('docs');
    sb.write(TAG_LIST, tagList(FOUR));
    sb.write(TYPES_FILE, tuple(...FOUR_IDS));
    sb.write(ALLOWLIST, allowlist());
    page('docs/patterns/one.md', 'tags: [caching, latency]');
    page('docs/patterns/two.md', 'tags: [resilience, latency]');
    page('docs/patterns/three.md', 'tags: [caching, cloud]');
  });

  it('a term added to the list only is two findings; added to the tuple too, the dead member alone; narrowed to one page, clean', async () => {
    expectPass(await sb.run(spec));

    sb.write(TAG_LIST, tagList([...FOUR, term('batching', 'skill')]));
    let r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n').filter((l) => l !== '')).toEqual([
      `[${NAME}] FAIL ${TYPES_FILE}: TAGS is missing "batching", a term in ${TAG_LIST}`,
      `[${NAME}] FAIL ${TAG_LIST}: term "batching" is used by no page — a dead member`,
    ]);

    // Added in its facet's place: the tuple runs in facet order, like a page's tags.
    sb.write(TYPES_FILE, tuple('caching', 'resilience', 'latency', 'batching', 'cloud'));
    r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n').filter((l) => l !== '')).toEqual([`[${NAME}] FAIL ${TAG_LIST}: term "batching" is used by no page — a dead member`]);

    r = await sb.run(spec, ['docs/patterns/one.md']);
    expectPass(r);
    expect(r.out).toBe(`[${NAME}] OK — 1 pages, 0 exercises, 5 terms`);
  });
});

describe('the page rules', () => {
  it('fails a page with no tags key', async () => {
    page('docs/patterns/one.md', null);
    expect(await err()).toContain(`[${NAME}] FAIL docs/patterns/one.md: missing required key: tags — a page carries them`);
  });

  it('fails a block list with that finding alone, naming the loss', async () => {
    page('docs/patterns/one.md', 'tags:\n  - caching\n  - latency');
    const lines = (await err(['docs/patterns/one.md'])).split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tags is not an inline list');
    expect(lines[0]).toContain('every tag on this page is dropped');
  });

  it('fails one tag and six', async () => {
    page('docs/patterns/one.md', 'tags: [caching]');
    expect(await err()).toContain('1 tags — a page carries 2-5');
    page('docs/patterns/one.md', 'tags: [caching, latency, cloud, drills, resilience, x]');
    expect(await err()).toContain('6 tags — a page carries 2-5');
  });

  it('fails an unknown tag once, and skips it when checking order', async () => {
    page('docs/patterns/one.md', 'tags: [caching, invented, latency]');
    const lines = (await err(['docs/patterns/one.md'])).split('\n').filter((l) => l !== '');
    expect(lines).toEqual([`[${NAME}] FAIL docs/patterns/one.md: unknown tag "invented" — every value is a term in ${TAG_LIST}`]);
  });

  it('fails a tag written twice', async () => {
    page('docs/patterns/one.md', 'tags: [caching, latency, latency]');
    expect(await err()).toContain('tag "latency" is written twice');
  });

  it('fails a term whose applies does not name the page class', async () => {
    page('docs/patterns/one.md', 'tags: [caching, drills]');
    expect(await err()).toContain('tag "drills" does not apply to a page');
    exercise('docs/exercises/drills/three.md', 'tags: [caching, latency, cloud]');
    expect(await err()).toContain('tag "latency" does not apply to an exercise');
  });

  it('reports only the first facet-order break, naming that tag', async () => {
    page('docs/patterns/one.md', 'tags: [latency, caching, cloud, latency2]');
    page('docs/patterns/two.md', 'tags: [cloud, latency, caching]');
    const lines = (await err(['docs/patterns/two.md'])).split('\n').filter((l) => l.includes('facet order'));
    expect(lines).toEqual([`[${NAME}] FAIL docs/patterns/two.md: tags are out of facet order at "latency" — topics first, then skills, then languages`]);
  });

  it('fails a page with no topic, and one with two; lets an exercise span two', async () => {
    page('docs/patterns/one.md', 'tags: [latency, cloud]');
    expect(await err()).toContain('docs/patterns/one.md: no topic tag');
    page('docs/patterns/one.md', 'tags: [caching, resilience, latency]');
    expect(await err()).toContain('2 topic tags (caching, resilience) — a page has one');
    page('docs/patterns/one.md', 'tags: [caching, latency]');
    expectPass(await sb.run(spec));
  });

  it('holds an exercise to 3-5 tags', async () => {
    exercise('docs/exercises/drills/three.md', 'tags: [caching, drills]');
    expect(await err()).toContain('2 tags — an exercise carries 3-5');
    exercise('docs/exercises/drills/three.md', 'tags: [drills, cloud, drills]');
    expect(await err()).toContain('docs/exercises/drills/three.md: no topic tag');
  });

  it('builds its lookups from the terms that have an id, and reads a term with no applies as applying nowhere', () => {
    const lookup = lookupOf([{ id: 3 }, { id: 'loose' }, { id: 'caching', facet: 'topic', applies: 'page' }]);
    expect([...lookup.facet]).toEqual([['caching', 'topic']]);
    expect([...lookup.applies]).toEqual([['loose', []], ['caching', []]]);
    // A known tag with no applies entry applies to nothing.
    const bare = { facet: new Map([['caching', 'topic'], ['latency', 'skill']]), applies: new Map<string, string[]>() };
    expect(tagFindings(['caching', 'latency'], 'page', bare).map((f) => f.what)).toEqual([
      'tag "caching" does not apply to a page — widen its applies or pick another',
      'tag "latency" does not apply to a page — widen its applies or pick another',
    ]);
  });

  it('reads a missing tags key on an exercise in its own words', () => {
    expect(tagFindings(undefined, 'exercise', lookupOf([]))[0]?.what).toBe('missing required key: tags — an exercise carries them');
  });
});

describe('the retag allowlist', () => {
  const entry = (match: string, reason = 'retag pending'): Json => ({ name: 'retag-patterns', match, reason, owner: 'Tests', since: '2026-09-24' });

  it('excuses a page\'s facet findings, counts them, and nothing else', async () => {
    page('docs/patterns/one.md', 'tags: [latency, caching, resilience, invented]');
    sb.write(ALLOWLIST, allowlist([entry('docs/patterns/{one,nine}.md')]));
    const r = await sb.run(spec);
    expectFail(r);
    // The unknown tag is still a finding; the order break and the two topics are excused.
    expect(r.err.split('\n').filter((l) => l !== '')).toEqual([`[${NAME}] FAIL docs/patterns/one.md: unknown tag "invented" — every value is a term in ${TAG_LIST}`]);
    page('docs/patterns/one.md', 'tags: [latency, caching, resilience]');
    const ok = await sb.run(spec);
    expectPass(ok);
    expect(ok.out).toBe(`[${NAME}] OK — 2 pages, 1 exercises, 5 terms, 2 facet findings excused by ${ALLOWLIST}`);
  });

  it('fails an entry that excuses nothing, on a whole run only', async () => {
    sb.write(ALLOWLIST, allowlist([entry('docs/patterns/one.md')]));
    expectFail(await sb.run(spec), `[${NAME}] FAIL ${ALLOWLIST}: entry "retag-patterns" excuses nothing — its pages carry one topic in facet order now; delete it`);
    expectPass(await sb.run(spec, ['docs/patterns/one.md']));
  });

  it('fails a missing list and an entry with a blank reason, excusing nothing', async () => {
    sb.rm(ALLOWLIST);
    expectFail(await sb.run(spec), `${ALLOWLIST}: is missing — it excuses the facet findings`);
    page('docs/patterns/one.md', 'tags: [latency, caching]');
    sb.write(ALLOWLIST, allowlist([entry('docs/patterns/one.md', ' ')]));
    const r = await sb.run(spec);
    expectFail(r, `${ALLOWLIST}: entry "retag-patterns" has an empty reason — say which retag is pending and who lands it`);
    expectFail(r, 'docs/patterns/one.md: tags are out of facet order at "caching"');
  });
});

describe('the tag list itself', () => {
  it('fails a missing file and one that is not an object', async () => {
    sb.rm(TAG_LIST);
    expectFail(await sb.run(spec), `[${NAME}] FAIL ${TAG_LIST}: is missing`);
    sb.write(TAG_LIST, '[1, 2]');
    expectFail(await sb.run(spec), `${TAG_LIST}: is not a JSON object`);
  });

  it('stops at a structural finding before measuring any page', async () => {
    sb.write(TAG_LIST, tagList([term('caching', 'topic')]));
    page('docs/patterns/one.md', 'tags: [nothing-known]');
    const lines = (await err()).split('\n').filter((l) => l !== '');
    expect(lines).toEqual([`[${NAME}] FAIL ${TAG_LIST}: term caching: a topic needs a label — it is the heading a hub groups its pages under`]);
  });

  it('names each term fault: missing key, unknown facet, bad or duplicate id, empty or unknown applies, a label missing, misplaced or shared', () => {
    const findings = structuralFindings(
      JSON.parse(
        tagList([
          { id: 'caching', facet: 'topic', label: 'Same' },
          term('resilience', 'topic', ['page'], 'Same'),
          term('latency', 'mood'),
          term('Two Words', 'skill'),
          term('latency', 'skill', []),
          term('cloud', 'language', ['page', 'runbook']),
          term('edge', 'language', ['page'], 'Edge'),
          { ...term('x', 'topic'), id: 9 },
          'not a term',
        ]),
      ) as Json,
    );
    expect(findings).toEqual([
      'term caching: missing key "definition"',
      'term caching: missing key "applies"',
      'term caching: missing key "owner"',
      'term latency: unknown facet "mood" (expected one of: topic, skill, language)',
      'term Two Words: id is not kebab-case — it has to survive "tags: [a, b]"',
      'term latency: applies is empty — a term no page may use',
      'term cloud: applies has "runbook" (expected one of: page, exercise)',
      'term edge: only a topic carries a label, and nothing renders this one',
      'term #8: a topic needs a label — it is the heading a hub groups its pages under',
      'term #9 is not an object',
      'duplicate id: latency',
      'two topics share the heading "Same": caching, resilience',
    ]);
  });

  it('stops at the shape when the file is not a tag list, and names facets out of order', () => {
    expect(structuralFindings({})).toEqual(['`facets` is missing or is not an object']);
    expect(structuralFindings({ facets: {} })).toEqual(['`terms` is missing or is not an array']);
    expect(structuralFindings({ facets: { skill: 's', topic: 't', language: 'l' }, terms: [] })).toEqual([
      '`facets` holds skill, topic, language — it maps exactly topic, skill, language, in that order',
    ]);
    expect(structuralFindings({ facets: {}, terms: [] })).toEqual(['`facets` holds nothing — it maps exactly topic, skill, language, in that order']);
  });
});

describe('the TAGS tuple', () => {
  it('names the tuple missing a term, and a tuple member no term declares', async () => {
    sb.write(TYPES_FILE, tuple(...IDS.filter((t) => t !== 'cloud'), 'invented'));
    const r = await sb.run(spec);
    expectFail(r, `[${NAME}] FAIL ${TYPES_FILE}: TAGS is missing "cloud", a term in ${TAG_LIST}`);
    expectFail(r, `[${NAME}] FAIL ${TYPES_FILE}: TAGS lists "invented", which is not a term in ${TAG_LIST}`);
  });

  it('fails a reshaped declaration rather than comparing against nothing, and a missing file', async () => {
    sb.write(TYPES_FILE, 'export const TAGS = new Set();\n');
    expectFail(await sb.run(spec), 'no `const TAGS = [...]`');
    sb.write(TYPES_FILE, `export const TAGS = [...BASE, 'cloud'] as const;\n`);
    expectFail(await sb.run(spec), 'no `const TAGS = [...]` holding only quoted ids');
    sb.rm(TYPES_FILE);
    expectFail(await sb.run(spec), `${TYPES_FILE}: missing — TAGS here is the flat tuple`);
  });

  it('does not count a member commented out of the tuple', async () => {
    sb.write(TYPES_FILE, tuple(...IDS).replace(`  'cloud',`, `  // 'cloud',`));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n').filter((l) => l !== '')).toEqual([`[${NAME}] FAIL ${TYPES_FILE}: TAGS is missing "cloud", a term in ${TAG_LIST}`]);
  });

  it('reads a comment holding an apostrophe as a comment, with no finding', async () => {
    sb.write(TYPES_FILE, tuple(...IDS).replace(`  'latency',`, `  // the reader's skills\n  'latency',`));
    expectPass(await sb.run(spec));
  });

  it('fails an id listed twice once, however many times it repeats', async () => {
    sb.write(TYPES_FILE, tuple(...IDS, 'cloud', 'cloud'));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n').filter((l) => l !== '')).toEqual([
      `[${NAME}] FAIL ${TYPES_FILE}: TAGS lists "cloud" more than once — it holds each id once, as many members as ${TAG_LIST} has terms (5)`,
    ]);
  });

  it('fails a tuple out of facet order at its first break, and takes any order within a facet', async () => {
    sb.write(TYPES_FILE, tuple('cloud', 'caching', 'resilience', 'latency', 'drills'));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n').filter((l) => l !== '')).toEqual([
      `[${NAME}] FAIL ${TYPES_FILE}: TAGS runs out of facet order at "caching" — topics first, then skills, then languages, as ${TAG_LIST} files them`,
    ]);
    sb.write(TYPES_FILE, tuple('resilience', 'caching', 'drills', 'latency', 'cloud'));
    expectPass(await sb.run(spec));
  });

  it('checks order on the members the list knows, leaving an unknown one to its own finding', async () => {
    sb.write(TYPES_FILE, tuple('caching', 'resilience', 'invented', 'latency', 'drills', 'cloud'));
    const r = await sb.run(spec);
    expect(r.err.split('\n').filter((l) => l !== '')).toEqual([`[${NAME}] FAIL ${TYPES_FILE}: TAGS lists "invented", which is not a term in ${TAG_LIST}`]);
  });
});

describe('misuse and vacuous success', () => {
  it('treats an unknown flag and --fix as misuse, and changes nothing', async () => {
    const before = sb.snapshot();
    expectMisuse(await sb.run(spec, ['--chekc']));
    expectMisuse(await sb.run(spec, ['--fix']));
    expect(sb.snapshot()).toEqual(before);
  });

  it('fails a named path it does not govern rather than passing silently', async () => {
    sb.write('README.md', '# Root\n');
    expectMisuse(await sb.run(spec, ['README.md']));
    expectMisuse(await sb.run(spec, ['site/src/lib/other.ts']));
  });

  it('drops the files it reads but does not measure, as make validate-changed hands them over', async () => {
    sb.write('docs/CLAUDE.md', '# Working in docs/\n');
    sb.write(`${FRONTMATTER_FREE[0]}2026-09-24-sweep.md`, '# A record\n');
    const r = await sb.run(spec, ['docs/CLAUDE.md', `${FRONTMATTER_FREE[0]}2026-09-24-sweep.md`, 'docs/patterns/deleted.md', 'docs/patterns/one.md']);
    expectPass(r);
    expect(r.out).toContain('1 pages, 0 exercises');
  });

  it('tolerates a ./ prefix, and measures every page when one of its own data files is named', async () => {
    expectPass(await sb.run(spec, ['./docs/patterns/one.md']));
    for (const f of [TAG_LIST, TYPES_FILE, ALLOWLIST, `./${TAG_LIST}`]) {
      const r = await sb.run(spec, [f, 'docs/patterns/one.md']);
      expectPass(r);
      expect(r.out, f).toContain('2 pages, 1 exercises');
    }
  });

  it('fails a term retired from the list and the tuple while a page still carries it, with only those two files named', async () => {
    sb.write(TAG_LIST, tagList(TERMS.filter((t) => t['id'] !== 'cloud')));
    sb.write(TYPES_FILE, tuple(...IDS.filter((t) => t !== 'cloud')));
    const r = await sb.run(spec, [TAG_LIST, TYPES_FILE]);
    expectFail(r);
    expect(r.err.split('\n').filter((l) => l !== '')).toEqual([`[${NAME}] FAIL docs/patterns/two.md: unknown tag "cloud" — every value is a term in ${TAG_LIST}`]);
  });

  it('runs whole when the allowlist alone is named, so a deleted entry strands its pages loudly', async () => {
    page('docs/patterns/one.md', 'tags: [latency, caching]');
    expectFail(await sb.run(spec, [ALLOWLIST]), 'docs/patterns/one.md: tags are out of facet order at "caching"');
  });

  it('still refuses a stray path named beside a data file', async () => {
    sb.write('README.md', '# Root\n');
    expectMisuse(await sb.run(spec, [TAG_LIST, 'README.md']));
  });

  it('fails when there are no pages at all, naming the tag list', async () => {
    sb.rm('docs/patterns');
    sb.rm('docs/exercises');
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n').filter((l) => l !== '')).toEqual([`[${NAME}] FAIL ${TAG_LIST}: no page under docs/ is tagged from it — the scan set is wrong`]);
  });
});

describe('the constants', () => {
  it('accepts a kebab-case id and refuses what the inline form would split', () => {
    expect(ID_SHAPE.test('low-level-design')).toBe(true);
    expect(ID_SHAPE.test('s3')).toBe(true);
    for (const bad of ['two words', 'a,b', 'Caps', 'a]', '-a', 'a--b']) expect(ID_SHAPE.test(bad), bad).toBe(false);
  });
});

describe('the real tree', () => {
  it('passes, counting every page under docs/ but the layers and every term in the list', async () => {
    // testing-C4: the pages are recounted by a walk written here.
    let pages = 0;
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(child);
        else if (e.name.endsWith('.md') && e.name !== 'CLAUDE.md' && !FRONTMATTER_FREE.some((r) => child.startsWith(r))) pages += 1;
      }
    };
    walk('docs');
    const terms = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, TAG_LIST), 'utf8')) as { terms: unknown[] }).terms.length;
    const r = await capture(spec, [], REPO_ROOT);
    expectPass(r);
    expect(r.out).toMatch(new RegExp(`^\\[${NAME}\\] OK — ${String(pages)} pages, 0 exercises, ${String(terms)} terms(, \\d+ facet findings excused by ${ALLOWLIST.replace(/\//g, '\\/')})?$`));
    // The door reads the real pages the same way the gate does.
    expect(Array.isArray(frontmatter(REPO_ROOT, 'docs/patterns/distributed/resilience/circuit-breaker.md', { lists: true })['tags'])).toBe(true);
  }, 60_000);
});
