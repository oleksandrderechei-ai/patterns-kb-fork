/**
 * The search oracle gate: a file of cases that both rankings answer passes
 * with its count, each way a path can miss is one finding naming the query, the
 * hit, the wish and the path, a case limited to `find` is held to that path
 * alone, and a broken file is named before anything runs.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capture, expectFail, expectMisuse, expectPass, makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';
import { writeKbFixture } from '../lib/fixtures.js';
import { judge, shapeFindings, spec, SRC, type OracleCase } from './check-search-oracle.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
  writeKbFixture(sb.dir);
});
afterEach(() => sb.cleanup());

function oracle(cases: unknown, extra: Record<string, unknown> = {}): void {
  sb.write(SRC, `${JSON.stringify({ version: 1, updated: '2026-09-30', note: 'n', cases, ...extra }, null, 2)}\n`);
}

const hit = (id: string, kind = 'pattern', band = 'distributed') => ({ id, kind, band });

describe('check-search-oracle', () => {
  it('passes cases both paths answer, and says how many', async () => {
    oracle([
      { q: 'breaker', top: ['breaker'] },
      { q: 'cb', top: ['breaker', 'retry'] },
      { q: 'hazard', kind: 'hazard', n: 1 },
      { q: 'resilience', within: { breaker: 3 } },
    ]);
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe('[search-oracle] 4 queries hold on the site path and the kb.mjs path');
  });

  it('fails a first hit that is not the wished page, once per path, naming the query and what it got', async () => {
    oracle([{ q: 'breaker', top: ['queue'] }]);
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([`[search-oracle] FAIL ${SRC}: breaker → got breaker, wanted queue (site)`, `[search-oracle] FAIL ${SRC}: breaker → got breaker, wanted queue (cli)`]);
  });

  it('fails a kind, a band and a rank the hits miss', async () => {
    oracle([
      { q: 'breaker', kind: 'hazard', n: 1 },
      { q: 'breaker', band: 'messaging', n: 1 },
      { q: 'resilience', within: { queue: 2 } },
    ]);
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toContain('breaker → got breaker (pattern), wanted the first 1 of kind hazard (site)');
    expect(r.err).toContain('breaker → got breaker (distributed), wanted the first 1 of band messaging (cli)');
    expect(r.err).toMatch(/resilience → got queue absent \(.*\), wanted it within the first 2 \(site\)/);
  });

  it('passes a covers case both paths answer and a covers case only find answers, and says how many each path holds', async () => {
    oracle([
      { q: 'resilience', covers: { ids: ['breaker', 'retry', 'queue'], n: 3, min: 2 } },
      { q: 'breaker', covers: { ids: ['breaker', 'retry'], n: 5, min: 2 }, via: 'cli' },
      { q: 'breaker', top: ['breaker'] },
    ]);
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe('[search-oracle] 3 queries hold on the kb.mjs path, 2 of them on the site path too');
  });

  it('fails a covers case that gets too few of its ids, naming the ones missing and the hits it got, once per path', async () => {
    oracle([{ q: 'resilience', covers: { ids: ['queue', 'storm', 'retry'], n: 2, min: 2 } }]);
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([
      `[search-oracle] FAIL ${SRC}: resilience → got 1 of 3 in the first 2 (retry, breaker), wanted 2; missing queue, storm (site)`,
      `[search-oracle] FAIL ${SRC}: resilience → got 1 of 3 in the first 2 (retry, breaker), wanted 2; missing queue, storm (cli)`,
    ]);
  });

  it('holds a case limited to find to the kb.mjs path alone', async () => {
    // The search box lists only the page the word names; find reads the prose and lists its neighbours too.
    const wish = { ids: ['breaker', 'retry'], n: 5, min: 2 };
    oracle([{ q: 'breaker', covers: wish }]);
    const both = await sb.run(spec);
    expectFail(both);
    expect(both.err.split('\n')).toEqual([`[search-oracle] FAIL ${SRC}: breaker → got 1 of 2 in the first 5 (breaker), wanted 2; missing retry (site)`]);
    oracle([{ q: 'breaker', covers: wish, via: 'cli' }]);
    expectPass(await sb.run(spec));
    oracle([{ q: 'resilience', covers: { ids: ['queue'], n: 2, min: 1 }, via: 'cli' }]);
    const cliOnly = await sb.run(spec);
    expectFail(cliOnly);
    expect(cliOnly.err.split('\n')).toEqual([`[search-oracle] FAIL ${SRC}: resilience → got 0 of 1 in the first 2 (retry, breaker), wanted 1; missing queue (cli)`]);
  });

  it('fails a file that is missing, is not JSON, or has the wrong shape, before running anything', async () => {
    expectFail(await sb.run(spec), `${SRC}: is missing`);
    sb.write(SRC, '{');
    expectFail(await sb.run(spec), `${SRC}: is not valid JSON`);
    oracle([{ q: 'breaker', top: ['nowhere'] }]);
    expectFail(await sb.run(spec), '`top` names "nowhere", which is no page');
    oracle([{ q: 'breaker', covers: { ids: ['breaker', 'nowhere'], n: 5, min: 1 } }]);
    expectFail(await sb.run(spec), '`covers.ids` names "nowhere", which is no page');
  });

  it('takes no arguments', async () => {
    oracle([{ q: 'breaker', top: ['breaker'] }]);
    expectMisuse(await sb.run(spec, ['--nope']));
  });

  it('holds the real oracle (real tree)', async () => {
    const r = await capture(spec, [], REPO_ROOT);
    expectPass(r);
    expect(r.out.trim()).toMatch(/^\[search-oracle\] \d+ queries hold on (the site path and the kb\.mjs path|the kb\.mjs path, \d+ of them on the site path too)$/);
  }, 60_000);

  it('keeps the case-study cases the real oracle was given (real tree)', () => {
    const { cases } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, SRC), 'utf8')) as { cases: OracleCase[] };
    expect(cases.filter((c) => c.covers !== undefined).length).toBeGreaterThanOrEqual(12);
  });
});

describe('shapeFindings', () => {
  const known = new Set(['a', 'b']);

  it('accepts every case form', () => {
    const cases = [
      { q: 'a', top: ['a'] },
      { q: 'b', kind: 'x', band: 'y', n: 2 },
      { q: 'c', within: { a: 2 } },
      { q: 'd', covers: { ids: ['a', 'b'], n: 5, min: 2 } },
      { q: 'e', covers: { ids: ['a', 'b'], n: 1, min: 1 }, via: 'cli' },
    ];
    expect(shapeFindings({ version: 1, updated: 'x', note: 'n', cases }, known)).toEqual([]);
  });

  it('names each fault of the file and of a case', () => {
    expect(shapeFindings([], known)).toEqual(['is not a JSON object']);
    expect(shapeFindings({ cases: [] }, known)).toEqual(['lacks `version`', 'lacks `updated`', 'lacks `note`']);
    expect(shapeFindings({ version: 1, updated: 'x', note: 'n', cases: 'no' }, known)).toEqual(['`cases` is missing or is not a list']);
    const cases = [
      'text',
      { q: ' ', top: ['a'] },
      { q: 'one', wat: 1, top: 'a' },
      { q: 'two', top: [] },
      { q: 'three', within: {} },
      { q: 'four', within: { a: 0, z: 2 } },
      { q: 'five', kind: '', n: 0 },
      { q: 'six', n: 2, top: ['a'] },
      { q: 'seven' },
      { q: 'eight', band: 3, n: 1.5 },
      { top: ['a'] },
    ];
    expect(shapeFindings({ version: 1, updated: 'x', note: 'n', cases }, known)).toEqual([
      'case 1: is not an object',
      'case 2 " ": `q` is not a query',
      'case 3 "one": unknown key `wat`',
      'case 3 "one": `top` is not a list of ids',
      'case 4 "two": `top` is not a list of ids',
      'case 5 "three": `within` is not an object of id → rank',
      'case 6 "four": `within` names "z", which is no page',
      'case 6 "four": `within` gives "a" the rank 0, not a whole number from 1',
      'case 7 "five": `kind` is not a word',
      'case 7 "five": `n` is not a whole number from 1',
      'case 8 "six": `n` means something only beside `kind` or `band`',
      'case 9 "seven": expects nothing — give `top`, `kind`, `band`, `within` or `covers`',
      'case 10 "eight": `band` is not a word',
      'case 10 "eight": `n` is not a whole number from 1',
      'case 11: `q` is not a query',
    ]);
  });

  it('names each fault of a covers', () => {
    const cases = [
      { q: 'one', covers: 'a' },
      { q: 'two', covers: { ids: [], n: 0, min: 0, extra: 1 } },
      { q: 'three', covers: { ids: ['a', 'a', 'z'], n: 2, min: 4 } },
      { q: 'four', covers: { ids: ['a'], n: 'x', min: 1.5 } },
      { q: 'five', covers: { ids: [], n: 3, min: 2 } },
      { q: 'six', covers: { ids: ['a'], n: 'x', min: 1 } },
      { q: 'seven', covers: { ids: ['a', 2], n: 1, min: 1 } },
      { q: 'eight', covers: {} },
    ];
    expect(shapeFindings({ version: 1, updated: 'x', note: 'n', cases }, known)).toEqual([
      'case 1 "one": `covers` is not an object of ids, n and min',
      'case 2 "two": `covers` has an unknown key `extra`',
      'case 2 "two": `covers.ids` is not a list of ids',
      'case 2 "two": `covers.n` is not a whole number from 1',
      'case 2 "two": `covers.min` is not a whole number from 1',
      'case 3 "three": `covers.ids` names "a" twice',
      'case 3 "three": `covers.ids` names "z", which is no page',
      'case 3 "three": `covers.min` is 4, more than its 2 ids',
      'case 3 "three": `covers.min` is 4, more than the 2 hits `covers.n` looks at',
      'case 4 "four": `covers.n` is not a whole number from 1',
      'case 4 "four": `covers.min` is not a whole number from 1',
      'case 5 "five": `covers.ids` is not a list of ids',
      'case 6 "six": `covers.n` is not a whole number from 1',
      'case 7 "seven": `covers.ids` is not a list of ids',
      'case 8 "eight": `covers.ids` is not a list of ids',
      'case 8 "eight": `covers.n` is not a whole number from 1',
      'case 8 "eight": `covers.min` is not a whole number from 1',
    ]);
  });

  it('names a via that is not a path a case may be limited to', () => {
    const cases = [{ q: 'one', top: ['a'], via: 'site' }, { q: 'two', top: ['a'], via: 3 }, { q: 'three', via: 'cli' }];
    expect(shapeFindings({ version: 1, updated: 'x', note: 'n', cases }, known)).toEqual([
      'case 1 "one": `via` is not one of cli',
      'case 2 "two": `via` is not one of cli',
      'case 3 "three": expects nothing — give `top`, `kind`, `band`, `within` or `covers`',
    ]);
  });
});

describe('judge', () => {
  const c = (over: Partial<OracleCase>): OracleCase => ({ q: 'x', ...over });

  it('holds a case whose expectations are all met', () => {
    const hits = [hit('a'), hit('b'), hit('c')];
    expect(judge(c({ top: ['z', 'a'], kind: 'pattern', band: 'distributed', n: 3, within: { c: 3 }, covers: { ids: ['c', 'x'], n: 3, min: 1 } }), hits)).toEqual([]);
  });

  it('says what it got beside what it wanted, for each expectation', () => {
    const hits = [hit('a'), hit('b', 'design', 'design')];
    expect(judge(c({ top: ['b'] }), hits)).toEqual(['got a, wanted b']);
    expect(judge(c({ top: ['b'] }), [])).toEqual(['got nothing, wanted b']);
    expect(judge(c({ kind: 'pattern', n: 2 }), hits)).toEqual(['got a (pattern), b (design), wanted the first 2 of kind pattern']);
    expect(judge(c({ band: 'distributed', n: 5 }), hits)).toEqual(['got 2 hits (a, b), wanted 5 of band distributed']);
    expect(judge(c({ within: { b: 1, z: 5 } }), hits)).toEqual(['got b at 2 (a), wanted it within the first 1', 'got z absent (a, b), wanted it within the first 5']);
  });

  it('counts the wished ids among the first n hits and names the ones missing beside the hits it got', () => {
    const hits = [hit('a'), hit('b'), hit('c'), hit('d')];
    expect(judge(c({ covers: { ids: ['a', 'c', 'x'], n: 3, min: 2 } }), hits)).toEqual([]);
    expect(judge(c({ covers: { ids: ['a', 'd', 'x'], n: 3, min: 2 } }), hits)).toEqual(['got 1 of 3 in the first 3 (a, b, c), wanted 2; missing d, x']);
    expect(judge(c({ covers: { ids: ['a', 'b'], n: 2, min: 1 } }), [])).toEqual(['got 0 of 2 in the first 2 (nothing), wanted 1; missing a, b']);
  });

  it('looks at fewer hits than a covers asks for, when a path lists fewer', () => {
    expect(judge(c({ covers: { ids: ['a', 'z'], n: 8, min: 2 } }), [hit('a')])).toEqual(['got 1 of 2 in the first 8 (a), wanted 2; missing z']);
  });
});
