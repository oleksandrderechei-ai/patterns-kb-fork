/**
 * Every page under docs/ opens with the block its regime asks for (spec:
 * kb.content.frontmatter). The title rule is why the gate exists: `title:` is
 * what the site shows and the `# H1` what GitHub shows, so a page whose two
 * names disagree is cited by the wrong one.
 */

import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PAGE_ALPHA, PAGE_GUIDE, pagesTree, pageText } from '../lib/fixtures.js';
import { STATUSES } from '../lib/page-block.js';
import { capture, expectFail, expectMisuse, expectPass, makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';
import { areaIds, descriptionColonUnquoted, doubledKeys, MARKER, owner, regimeOf, spec, whyOutside, withKeys } from './check-doc-frontmatter.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
  pagesTree(sb);
});
afterEach(() => sb.cleanup());

/** The real tree is 380-odd pages: on a loaded machine one run outlasts the suite's default. */
const REAL_TREE_TIMEOUT = 180_000;

/** The findings a run printed, one per line. */
const findings = (err: string): string[] => err.split('\n').filter((l) => l.startsWith('[frontmatter] FAIL'));

/** What a finding adds when the page declares a key twice. */
const TWICE = "this repo's reader keeps the first, a YAML reader the last or none; keep one";

/** An exercise page in the regime's shape; `edit` replaces or drops lines. */
function exercise(file: string, lines: readonly string[] = ['description: Try it.', 'area: caching', 'type: exercise', 'level: [beginner]', 'tags: [caching, latency, testing]']): void {
  sb.write(file, ['---', ...lines, '---', '', '# Try it', '', 'Body.', ''].join('\n'));
}

it('frontmatter-O1: A lacks owner, B has two names, C writes its tags as a block list — exactly three findings', async () => {
  sb.write('docs/patterns/caching/a.md', pageText({ title: 'A', owner: null }));
  sb.write('docs/patterns/caching/b.md', pageText({ title: 'B' }).replace('# B', '# Bee'));
  sb.write('docs/patterns/caching/c.md', pageText({ title: 'C', tags: null, extra: ['tags:', '  - caching', '  - latency'] }));
  const r = await sb.run(spec);
  expectFail(r);
  expect(r.out).toBe('');
  expect(findings(r.err)).toEqual([
    '[frontmatter] FAIL docs/patterns/caching/a.md: missing required key: owner',
    '[frontmatter] FAIL docs/patterns/caching/b.md: title "B" and H1 "Bee" disagree — the site shows one, GitHub the other',
    '[frontmatter] FAIL docs/patterns/caching/c.md: tags is not an inline list — write `tags: [a, b]`; the parser reads a block list as empty, so every tag on the page is dropped',
  ]);
  expect(r.err).not.toContain('missing required key: tags');
});

it('maturity-O1 (the gate half): one page with its status deleted, one with a value outside the list — two findings naming status; --fix writes only the placeholder, never a value, and still exits 1', async () => {
  // The hub chip, the head meta, the manifest, the payload and the badge need a built
  // site: that half is 'maturity-O1 (the built-site half)' in tools/src/site/site-sandbox.test.ts.
  const clean = sb.read(PAGE_ALPHA);
  sb.write(PAGE_ALPHA, clean.replace('status: stable\n', ''));
  sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', status: 'finished' }));
  const outside = `[frontmatter] FAIL ${PAGE_GUIDE}: status "finished" is not one of draft, stable, deprecated`;

  let r = await sb.run(spec);
  expectFail(r);
  expect(r.out).toBe('');
  expect(findings(r.err)).toEqual([`[frontmatter] FAIL ${PAGE_ALPHA}: missing required key: status`, outside]);

  const guide = sb.read(PAGE_GUIDE);
  r = await sb.run(spec, ['--fix']);
  expectFail(r);
  const alpha = sb.read(PAGE_ALPHA);
  expect(alpha).toBe(clean.replace('status: stable', `status: ${MARKER}`));
  for (const s of STATUSES) expect(alpha).not.toContain(`status: ${s}`);
  expect(sb.read(PAGE_GUIDE)).toBe(guide);
  const placeholder = `[frontmatter] FAIL ${PAGE_ALPHA}: status is ${MARKER} — only you can answer it`;
  expect(r.err.split('\n')).toEqual([`[frontmatter] FIXED ${PAGE_ALPHA}: added status: ${MARKER} — answer it`, placeholder, outside]);

  // The placeholder stays a finding on a run without --fix, and --fix never touches it again.
  r = await sb.run(spec);
  expectFail(r);
  expect(findings(r.err)).toEqual([placeholder, outside]);
  r = await sb.run(spec, ['--fix']);
  expectFail(r);
  expect(r.err).not.toContain('FIXED');
  expect(sb.read(PAGE_ALPHA)).toBe(alpha);
});

describe('a clean tree', () => {
  it('passes, counting the pages and leaving the layer alone', async () => {
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe('[frontmatter] OK — 3 pages, 0 exercises');
    expect(r.err).toBe('');
  });

  it('holds the real tree', async () => {
    const r = await capture(spec, [], REPO_ROOT);
    expectPass(r);
    expect(Number(/(\d+) pages/.exec(r.out)?.[1])).toBeGreaterThan(380);
  }, REAL_TREE_TIMEOUT);
});

describe('the page block', () => {
  it.each(['title', 'description', 'area', 'owner', 'status'] as const)('names a missing %s', async (k) => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', [k]: null }));
    const r = await sb.run(spec);
    expectFail(r, `${PAGE_GUIDE}: missing required key: ${k}`);
    expect(findings(r.err)).toHaveLength(1);
  });

  it('names a key declared empty as missing', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', owner: '' }));
    expectFail(await sb.run(spec), 'missing required key: owner');
  });

  it('names missing tags, and an empty inline list as missing too', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', tags: null }));
    expectFail(await sb.run(spec), 'missing required key: tags');
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', tags: '[]' }));
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([`[frontmatter] FAIL ${PAGE_GUIDE}: missing required key: tags`]);
  });

  it('holds every page, published or not, to a description of one plain line of 160 characters at most', async () => {
    // The trap inbox and the docs map are no rows of the structure file, so docs-style never measures them.
    sb.write('docs/inbox.md', pageText({ title: 'Inbox', area: 'reference', description: 'x'.repeat(161) }));
    sb.write('docs/README.md', pageText({ title: 'Docs map', area: 'reference', description: '>' }).replace('description: >\n', 'description: >\n  folded over\n  two lines\n'));
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', description: `"${'—'.repeat(160)}"` }));
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([
      '[frontmatter] FAIL docs/README.md: description is a block scalar — write it as one plain line so its length means something',
      '[frontmatter] FAIL docs/inbox.md: description is 161 characters — 160 is where search results cut off',
    ]);
    expectFail(await sb.run(spec, ['docs/inbox.md']), 'docs/inbox.md: description is 161 characters');
  });

  it('fails a page with no block at all', async () => {
    sb.write(PAGE_GUIDE, '# Guide\n\nNo block.\n');
    expectFail(await sb.run(spec), 'no frontmatter — every page opens with the page block: title, description, area, owner, tags, status');
  });

  it('holds status and area to their closed lists', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'nowhere', status: 'done' }));
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([
      `[frontmatter] FAIL ${PAGE_GUIDE}: status "done" is not one of draft, stable, deprecated`,
      `[frontmatter] FAIL ${PAGE_GUIDE}: area "nowhere" is no area of docs/data/site-structure.json`,
    ]);
  });

  it('says why a value a YAML reader would take as listed is outside its list here: a trailing comment, trailing spaces', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference # hand-written', status: 'stable   ' }));
    const comment = "a # comment follows the value, and this repo's reader keeps it as part of the value; move the comment to its own line";
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([
      `[frontmatter] FAIL ${PAGE_GUIDE}: status "stable   " is not one of draft, stable, deprecated — it ends in spaces, which this repo's reader keeps as part of the value; delete them`,
      `[frontmatter] FAIL ${PAGE_GUIDE}: area "reference # hand-written" is no area of docs/data/site-structure.json — ${comment}`,
    ]);
  });

  it('names a key declared twice once, at its first line, and neither judges nor repairs it', async () => {
    // The parser reads the first line of each: an empty tags list and a status outside the list.
    const twice = pageText({ title: 'Guide', area: 'reference', owner: null, tags: '[]', status: 'bogus', extra: ['tags: [testing]', 'status: stable'] });
    sb.write(PAGE_GUIDE, twice);
    let r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `[frontmatter] FAIL ${PAGE_GUIDE}: missing required key: owner`,
      `[frontmatter] FAIL ${PAGE_GUIDE}:5: declares tags 2 times, at lines 5 and 7 — ${TWICE}`,
      `[frontmatter] FAIL ${PAGE_GUIDE}:6: declares status 2 times, at lines 6 and 8 — ${TWICE}`,
    ]);

    // --fix adds the owner above them and leaves both pairs as written; the lines named are the page's as it now stands.
    r = await sb.run(spec, ['--fix']);
    expectFail(r);
    expect(sb.read(PAGE_GUIDE)).toBe(twice.replace('area: reference\n', 'area: reference\nowner: kb tests\n'));
    expect(r.err.split('\n')).toEqual([
      `[frontmatter] FIXED ${PAGE_GUIDE}: added owner`,
      `[frontmatter] FAIL ${PAGE_GUIDE}:6: declares tags 2 times, at lines 6 and 8 — ${TWICE}`,
      `[frontmatter] FAIL ${PAGE_GUIDE}:7: declares status 2 times, at lines 7 and 9 — ${TWICE}`,
    ]);
  });

  it('quotes a list-valued scalar as written', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', status: '[stable]' }));
    expectFail(await sb.run(spec), 'status "[stable]" is not one of');
  });

  it('keeps the block closed', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', extra: ['section: guides', 'favourite: true'] }));
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([`[frontmatter] FAIL ${PAGE_GUIDE}: key "section" is not in the page block — the keys are title, description, area, owner, tags, status, source, aliases, solves, favourite`]);
  });

  it('names the structure file when the area list cannot be read, and checks the rest', async () => {
    sb.write('docs/data/site-structure.json', '{"areas": 3}\n');
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual(['[frontmatter] FAIL docs/data/site-structure.json: is missing or has no areas list — the area list is its area ids']);
  });

  it('fails an unquoted ": " in the description, and passes a quoted one', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', description: 'A thing: another' }));
    expectFail(await sb.run(spec), 'description contains ": " unquoted');
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', description: '"A thing: another"' }));
    expectPass(await sb.run(spec));
  });

  it('names a placeholder the repair left, once, instead of a list miss', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: MARKER, tags: `[${MARKER}]` }));
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([
      `[frontmatter] FAIL ${PAGE_GUIDE}: area is ${MARKER} — only you can answer it`,
      `[frontmatter] FAIL ${PAGE_GUIDE}: tags is ${MARKER} — only you can answer it`,
    ]);
  });
});

describe('the title in two places', () => {
  it('fails a page with no H1', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference' }).replace('# Guide\n', ''));
    expectFail(await sb.run(spec), "no '# ' heading");
  });

  it('does not read a fenced # line or a YAML comment as the H1', async () => {
    const text = pageText({ title: 'Guide', area: 'reference', extra: ['# a YAML comment'] }).replace('# Guide', '```bash\n# a shell comment\n```\n\n# Guide');
    sb.write(PAGE_GUIDE, text);
    expectPass(await sb.run(spec));
  });

  it('reads a trailing space in the title as the same name', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide ', area: 'reference' }).replace('# Guide ', '# Guide'));
    expectPass(await sb.run(spec));
  });

  it('reads a CRLF page the same as an LF one', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', owner: null }).replace(/\n/g, '\r\n'));
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([`[frontmatter] FAIL ${PAGE_GUIDE}: missing required key: owner`]);
  });
});

describe('the other regimes', () => {
  it('refuses a dated record, with or without a block', async () => {
    sb.write('docs/records/2026-09-24-sweep.md', '# Sweep\n\nWhat changed.\n');
    expectFail(await sb.run(spec), 'docs/records/2026-09-24-sweep.md: dated records are not kept');
    sb.write('docs/records/2026-09-24-sweep.md', pageText({ area: 'reference' }));
    expectFail(await sb.run(spec), 'docs/records/2026-09-24-sweep.md: dated records are not kept');
  });

  it('passes an exercise and an index in the exercise regime', async () => {
    exercise('docs/exercises/caching/warm-up.md');
    exercise('docs/exercises/README.md', ['description: Every exercise.', 'type: index', 'level: [beginner, advanced]']);
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toContain('2 exercises');
  });

  it('names every way an exercise breaks its regime', async () => {
    exercise('docs/exercises/caching/warm-up.md', ['title: Warm up', 'area: messaging', 'type: drill', 'level: advanced', 'related: peer', 'description: "A: b"']);
    exercise('docs/exercises/README.md', ['area: caching', 'type: index', 'level: [expert]', 'tags: [caching]']);
    sb.write('docs/exercises/caching/bare.md', '# Bare\n');
    sb.write('docs/exercises/caching/no-h1.md', '---\ndescription: x: y\ntype: exercise\narea: caching\nlevel: [beginner]\ntags: [a]\n---\n\nNo heading.\n');
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([
      '[frontmatter] FAIL docs/exercises/README.md: missing required key: description',
      '[frontmatter] FAIL docs/exercises/README.md: the exercise tree root spans every area — omit area:',
      '[frontmatter] FAIL docs/exercises/README.md: level "expert" is not one of beginner, intermediate, advanced',
      '[frontmatter] FAIL docs/exercises/README.md: tags on an index — an index lists exercises, it is not one',
      '[frontmatter] FAIL docs/exercises/caching/bare.md: no frontmatter — an exercise carries the exercise block',
      "[frontmatter] FAIL docs/exercises/caching/no-h1.md: no '# ' heading — an exercise's H1 is its title, there is no title: key",
      '[frontmatter] FAIL docs/exercises/caching/no-h1.md: description contains ": " unquoted — invalid YAML; rephrase with a dash or quote the value',
      '[frontmatter] FAIL docs/exercises/caching/warm-up.md: key "title" is not in the exercise block — an exercise carries only description, area, type, level, tags, related',
      '[frontmatter] FAIL docs/exercises/caching/warm-up.md: type "drill" — an exercise file is type: exercise | index',
      '[frontmatter] FAIL docs/exercises/caching/warm-up.md: area "messaging" must equal the folder: caching',
      '[frontmatter] FAIL docs/exercises/caching/warm-up.md: level is not an inline list — write `level: [beginner]`; the parser reads a block list as empty',
      '[frontmatter] FAIL docs/exercises/caching/warm-up.md: related is not an inline list — write `related: [peer-exercise]`',
    ]);
  });

  it('names a key an exercise declares twice', async () => {
    exercise('docs/exercises/caching/warm-up.md', ['description: Try it.', 'area: caching', 'type: exercise', 'level: [beginner]', 'tags: [caching]', 'type: index']);
    const r = await sb.run(spec, ['--fix']);
    expect(findings(r.err)).toEqual([`[frontmatter] FAIL docs/exercises/caching/warm-up.md:4: declares type 2 times, at lines 4 and 7 — ${TWICE}`]);
  });

  it('asks an exercise for its tags, as a non-empty inline list', async () => {
    exercise('docs/exercises/caching/warm-up.md', ['description: Try it.', 'area: caching', 'type: exercise', 'level: [beginner]', 'related: [peer]']);
    expectFail(await sb.run(spec), 'warm-up.md: missing required key: tags');
    exercise('docs/exercises/caching/warm-up.md', ['description: Try it.', 'area: caching', 'type: exercise', 'level: [beginner]', 'tags: []']);
    expectFail(await sb.run(spec), 'warm-up.md: missing required key: tags');
    exercise('docs/exercises/caching/warm-up.md', ['description: Try it.', 'area: caching', 'type: exercise', 'level: [beginner]', 'tags:', '  - caching']);
    const r = await sb.run(spec);
    expect(findings(r.err)).toEqual([
      '[frontmatter] FAIL docs/exercises/caching/warm-up.md: tags is not an inline list — write `tags: [a, b]`; the parser reads a block list as empty, so every tag on the page is dropped',
    ]);
  });

  it('holds an exercise to a description of 160 characters at most', async () => {
    exercise('docs/exercises/caching/warm-up.md', [`description: ${'x'.repeat(170)}`, 'area: caching', 'type: exercise', 'level: [beginner]', 'tags: [caching, latency, testing]']);
    expectFail(await sb.run(spec), 'warm-up.md: description is 170 characters');
  });
});

describe('arguments', () => {
  it('narrows to named pages, dropping a layer', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', owner: null }));
    const r = await sb.run(spec, [`./${PAGE_ALPHA}`, 'docs/CLAUDE.md']);
    expectPass(r);
    expect(r.out).toContain('1 pages');
    expectFail(await sb.run(spec, [PAGE_GUIDE]), 'missing required key: owner');
  });

  it('measures every page when the structure file is named, since each area is read against it', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', owner: null }));
    const r = await sb.run(spec, [PAGE_ALPHA, 'docs/data/site-structure.json']);
    expectFail(r, `${PAGE_GUIDE}: missing required key: owner`);
    expect(findings(r.err)).toHaveLength(1);
    sb.rm(PAGE_GUIDE);
    const clean = await sb.run(spec, ['./docs/data/site-structure.json']);
    expectPass(clean);
    expect(clean.out).toBe('[frontmatter] OK — 2 pages, 0 exercises');
  });

  it('is misuse for an unknown flag, a file outside docs/ or a missing one, and writes nothing', async () => {
    sb.write('README.md', '# Readme\n');
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', owner: null }));
    const before = sb.snapshot();
    for (const argv of [['--nope'], ['README.md'], ['docs/nope.md'], ['docs/data/tags.json'], ['--fix', 'README.md']]) {
      const r = await sb.run(spec, argv);
      expectMisuse(r);
      expect(r.out).toBe('');
    }
    expect(sb.snapshot()).toEqual(before);
  });

  it('does not read a committed page deleted or moved from disk and not yet staged, and still reports every other finding', async () => {
    sb.commit('pages');
    // The converter removes a page whose site page is gone; the deletion is not staged yet.
    sb.rm(PAGE_GUIDE);
    let r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe('[frontmatter] OK — 2 pages, 0 exercises');
    sb.write(PAGE_ALPHA, pageText({ status: null }));
    r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([`[frontmatter] FAIL ${PAGE_ALPHA}: missing required key: status`]);
  });

  it('fails a tree with no page under docs/', async () => {
    sb.rm('docs');
    sb.write('docs/CLAUDE.md', '# A layer\n');
    expectFail(await sb.run(spec), '[frontmatter] FAIL: no pages found under docs/');
  });
});

describe('--fix', () => {
  it('fills title from the H1 and marks description, in declared order; the run fails for description alone', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: null, description: null, area: 'reference' }).replace('# Alpha', '# Guide'));
    const r = await sb.run(spec, ['--fix']);
    expectFail(r);
    expect(findings(r.err)).toEqual([`[frontmatter] FAIL ${PAGE_GUIDE}: description is ${MARKER} — only you can answer it`]);
    expect(r.err).toContain(`[frontmatter] FIXED ${PAGE_GUIDE}: added title`);
    expect(r.err).toContain(`[frontmatter] FIXED ${PAGE_GUIDE}: added description: ${MARKER} — answer it`);
    expect(sb.read(PAGE_GUIDE).split('\n').slice(0, 5)).toEqual(['---', 'title: Guide', `description: ${MARKER}`, 'area: reference', 'owner: Tests']);
  });

  it('credits git with the owner and repairs a page to green, saying how many keys it added', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', owner: null }));
    const r = await sb.run(spec, ['--fix']);
    expectPass(r);
    expect(r.out).toBe('[frontmatter] OK — 3 pages, 0 exercises, 1 key(s) added');
    expect(sb.read(PAGE_GUIDE)).toContain('area: reference\nowner: kb tests\ntags:');
  });

  it('opens a block on a page with none, marking what only a person knows', async () => {
    sb.write(PAGE_GUIDE, '# Guide\n\nWhat this is.\n');
    const r = await sb.run(spec, ['--fix']);
    expectFail(r);
    expect(sb.read(PAGE_GUIDE)).toBe(
      ['---', 'title: Guide', `description: ${MARKER}`, `area: ${MARKER}`, 'owner: kb tests', `tags: [${MARKER}]`, `status: ${MARKER}`, '---', '', '# Guide', '', 'What this is.', ''].join('\n'),
    );
    expect(findings(r.err)).toHaveLength(4);
  });

  it('marks a title it has no H1 for, and an owner git cannot name', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: null, area: 'reference', owner: null }).replace('# Alpha\n', ''));
    const saved = { ...process.env };
    try {
      process.env['GIT_CONFIG_GLOBAL'] = path.join(sb.dir, 'no-such-config');
      process.env['GIT_CONFIG_NOSYSTEM'] = '1';
      sb.git('config', '--unset', 'user.name');
      const r = await sb.run(spec, ['--fix', PAGE_GUIDE]);
      expect(findings(r.err)).toEqual([
        `[frontmatter] FAIL ${PAGE_GUIDE}: title is ${MARKER} — only you can answer it`,
        `[frontmatter] FAIL ${PAGE_GUIDE}: owner is ${MARKER} — only you can answer it`,
        `[frontmatter] FAIL ${PAGE_GUIDE}: no '# ' heading — the H1 is the page's name wherever markdown renders`,
      ]);
    } finally {
      process.env = saved;
    }
  });

  it('fills a key declared empty where it stands, so the block holds it once', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', owner: '', tags: '[]' }));
    const r = await sb.run(spec, ['--fix']);
    expect(findings(r.err)).toEqual([`[frontmatter] FAIL ${PAGE_GUIDE}: tags is ${MARKER} — only you can answer it`]);
    const block = sb.read(PAGE_GUIDE).split('\n').slice(0, 9);
    expect(block.filter((l) => l.startsWith('owner:'))).toEqual(['owner: kb tests']);
    expect(block.filter((l) => l.startsWith('tags:'))).toEqual([`tags: [${MARKER}]`]);
  });

  it('re-reads the repaired description before judging it', async () => {
    sb.write(PAGE_GUIDE, pageText({ title: 'Guide', area: 'reference', owner: null, description: 'A: b' }));
    expectFail(await sb.run(spec, ['--fix']), 'description contains ": " unquoted');
  });

  it('writes nothing on an exercise or a dated record', async () => {
    exercise('docs/exercises/caching/warm-up.md', ['area: caching', 'type: exercise', 'level: [beginner]']);
    sb.write('docs/records/2026-09-24-sweep.md', pageText({ owner: null }));
    const before = sb.snapshot();
    expectFail(await sb.run(spec, ['--fix']));
    expect(sb.snapshot()).toEqual(before);
  });
});

describe('the helpers', () => {
  it('sorts a file into its regime', () => {
    expect(regimeOf('docs/CLAUDE.md')).toBe('layer');
    expect(regimeOf('docs/reference/CLAUDE.md')).toBe('layer');
    expect(regimeOf('docs/records/2026-09-24-x.md')).toBe('refused');
    expect(regimeOf('docs/exercises/a/b.md')).toBe('exercise');
    expect(regimeOf('docs/inbox.md')).toBe('page');
  });

  it('finds a key declared twice inside the block only, bounded as the parser bounds it', () => {
    expect(doubledKeys('---\nstatus: a\ntitle: T\nstatus: b\nstatus: c\n---\nstatus: d\n')).toEqual([{ key: 'status', lines: [2, 4, 5] }]);
    // Unclosed and CRLF; an indented line and a YAML comment are no fields.
    expect(doubledKeys('---\r\ntitle: A\r\n  title: nested\r\n# title: comment\r\ntags: [a]\r\ntitle: B\r\n')).toEqual([{ key: 'title', lines: [2, 6] }]);
    expect(doubledKeys('---\ntitle: T\ntags: [a]\n---\n')).toEqual([]);
    expect(doubledKeys('# no block\ntitle: A\ntitle: B\n')).toEqual([]);
    expect(doubledKeys('')).toEqual([]);
  });

  it('says why a value is outside its list: a trailing comment before trailing spaces, nothing for a plain value', () => {
    expect(whyOutside('stable # x ')).toContain('a # comment follows the value');
    expect(whyOutside('stable\t')).toContain('it ends in spaces');
    expect(whyOutside('stable#x')).toBe('');
    expect(whyOutside('finished')).toBe('');
  });

  it('reads an unquoted ": " only', () => {
    expect(descriptionColonUnquoted('A: b')).toBe(true);
    expect(descriptionColonUnquoted('"A: b"')).toBe(false);
    expect(descriptionColonUnquoted("'A: b'")).toBe(false);
    expect(descriptionColonUnquoted('A — b')).toBe(false);
  });

  it('splices keys into an unclosed or CRLF block, and leaves a text with nothing to add alone', () => {
    expect(withKeys('---\nstatus: x\n', { title: 'T' })).toBe('---\ntitle: T\nstatus: x\n');
    expect(withKeys('---\r\ntitle: T\r\n---\r\n', { owner: 'O' })).toBe('---\r\ntitle: T\r\nowner: O\n---\r\n');
    expect(withKeys('---\ntitle: T\n---\n', {})).toBe('---\ntitle: T\n---\n');
    expect(withKeys('', { title: 'T' })).toBe('---\ntitle: T\n---\n\n');
    expect(withKeys('---\ntitle: T\nowner:\ntags: []\n---\n', { owner: 'O', tags: '[x]' })).toBe('---\ntitle: T\nowner: O\ntags: [x]\n---\n');
  });

  it('reads the area ids, or null when the file is unreadable', () => {
    expect([...(areaIds(sb.dir) ?? [])]).toEqual(['patterns', 'themes', 'caching', 'themes-data', 'reference']);
    sb.write('docs/data/site-structure.json', 'not json');
    expect(areaIds(sb.dir)).toBeNull();
  });

  it('credits the configured name, or nobody, when git has no author for the page', () => {
    expect(owner(sb.dir, PAGE_GUIDE)).toBe('kb tests');
    sb.commit('pages');
    expect(owner(sb.dir, PAGE_GUIDE)).toBe('kb tests');
    const saved = { ...process.env };
    try {
      process.env['GIT_CONFIG_GLOBAL'] = path.join(sb.dir, 'no-such-config');
      process.env['GIT_CONFIG_NOSYSTEM'] = '1';
      sb.git('config', '--unset', 'user.name');
      expect(owner(sb.dir, 'docs/never-committed.md')).toBe('');
    } finally {
      process.env = saved;
    }
  });
});
