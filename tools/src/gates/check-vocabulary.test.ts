/**
 * The ban gate: the glossary's own soundness, then every banned phrasing on a
 * markdown prose line (spec: kb.data.glossary, glossary-C1..C9; the
 * allowlist half is kb.data.exceptions).
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from '../lib/exec.js';
import { allowlistJson } from '../lib/fixtures.js';
import {
  ALLOWLIST,
  banPattern,
  dataFindings,
  fenceOpener,
  hitsIn,
  isChangelog,
  openItems,
  MARKER,
  message,
  proseOf,
  RECORDED_FIELDS,
  SRC,
  spec,
  stripCodeSpans,
  unquote,
  type Ban,
} from './check-vocabulary.js';
import { capture, expectFail, expectMisuse, expectPass, makeSandbox, REPO_ROOT, type Sandbox } from '../lib/sandbox.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

type T = Record<string, unknown>;

/** A sound term; `over` replaces fields, and a field set to undefined is left out. */
function term(id: string, over: T = {}): T {
  const t: T = { id, term: id, definition: `A ${id}.`, aliases: [], avoid: [], scope: 'house', owner: 'O', see: [], ...over };
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
  return t;
}

function glossary(terms: T[], scopes: T = { house: 'The owner decides.' }): string {
  return `${JSON.stringify({ version: 1, updated: '2026-09-24', note: 'n', scopes, terms }, null, 2)}\n`;
}

/** A sound glossary banning "gizmo" for "widget", and an empty allowlist. */
function tree(terms: T[] = [term('widget', { avoid: ['gizmo'] })]): void {
  sb.write(SRC, glossary(terms));
  sb.write(ALLOWLIST, allowlistJson());
}

const bansOf = (phrases: Record<string, string>): Map<string, Ban> =>
  new Map(Object.entries(phrases).map(([phrase, t]) => [phrase.toLowerCase(), { phrase, term: t, aliases: [] }]));

/** The lines `text` has hits on, with the phrasing each one names. */
function hitLines(text: string, phrases: Record<string, string> = { gizmo: 'widget' }): [number, string][] {
  const bans = bansOf(phrases);
  return hitsIn(text, bans, banPattern([...bans.values()])).map((h) => [h.line, h.ban.phrase]);
}

describe('glossary-O1', () => {
  it('three data faults, three findings naming their terms; repaired, one prose finding at line 3', async () => {
    // A term lacking one of its eight fields, a phrasing two terms ban, and a
    // term whose related concept does not list it back.
    sb.write(ALLOWLIST, allowlistJson());
    sb.write(
      SRC,
      glossary([
        term('widget', { avoid: ['gizmo'], see: ['gadget'] }),
        term('gadget', { avoid: ['gizmo'] }),
        term('sprocket', { owner: undefined }),
      ]),
    );
    const broken = await sb.run(spec);
    expectFail(broken);
    expect(broken.out).toBe('');
    expect(broken.err.split('\n')).toEqual([
      `[vocabulary] FAIL ${SRC}: term sprocket: missing owner`,
      `[vocabulary] FAIL ${SRC}: term widget: see names gadget, which does not list widget back`,
      `[vocabulary] FAIL ${SRC}: banned phrasing "gizmo" belongs to more than one term: widget, gadget`,
    ]);

    // Repaired: the file bans one phrasing. An uncommitted page uses it in
    // prose on line 3, in inline code, in a fence, inside a longer word and
    // on an opt-out line; an ignored file uses it too.
    sb.write(
      SRC,
      glossary([term('widget', { avoid: ['gizmo'], see: ['gadget'] }), term('gadget', { see: ['widget'] }), term('sprocket')]),
    );
    sb.write('.gitignore', 'ignored.md\n');
    sb.write('ignored.md', 'A gizmo, ignored.\n');
    sb.write(
      'page.md',
      ['# Page', '', 'Plug the gizmo in.', 'Run `gizmo` first.', '```', 'gizmo', '```', 'A gizmodo is not one.', `Name the gizmo here. ${MARKER}`, ''].join('\n'),
    );
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.out).toBe('');
    expect(r.err.split('\n')).toEqual(['[vocabulary] FAIL page.md:3: use "widget" not "gizmo"']);
  });
});

describe('the data (glossary-C1..C3)', () => {
  it('passes a sound file and counts what it scanned', async () => {
    tree();
    sb.write('a.md', 'Plain words.\n');
    sb.write('b.md', 'More plain words.\n');
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe('[vocabulary] no banned phrasing in 2 markdown files (1 phrasings from 1 terms); 0 allowlist entries applied, excusing 0 hits');
  });

  it('names the top-level shape once and stops there', () => {
    expect(dataFindings([])).toEqual(['is not a JSON object']);
    expect(dataFindings({ terms: [] })).toEqual(['`scopes` is missing or is not an object']);
    expect(dataFindings({ scopes: {} })).toEqual(['`terms` is missing or is not an array']);
  });

  it('names a term that is no object, a mistyped field, and every missing field at once', () => {
    const data = {
      scopes: { house: 'x' },
      terms: [7, term('a', { term: '', aliases: 'x', see: [1] }), { avoid: [] }],
    };
    expect(dataFindings(data)).toEqual([
      'term #1: is not an object',
      'term a: term is not a non-empty string; aliases is not a list of strings; see is not a list of strings',
      'term #3: missing id, term, definition, aliases, scope, owner, see',
    ]);
  });

  it('names a shared id once, an unknown scope, and a see that names nothing or itself', () => {
    const data = {
      scopes: { house: 'x', model: 'y' },
      terms: [term('a', { see: ['a', 'ghost'] }), term('a'), term('a'), term('b', { scope: 'nobody' })],
    };
    expect(dataFindings(data)).toEqual([
      'duplicate id: a (3 terms)',
      'term a: see names the term itself',
      'term a: see names "ghost", which is no term',
      'term b: unknown scope "nobody" (expected one of: house, model)',
    ]);
  });

  it('bans a phrasing to one owner, case ignored, and never bans a word to write', () => {
    const data = {
      scopes: { house: 'x' },
      terms: [
        term('use', { avoid: ['Leverage', ''], aliases: ['apply'] }),
        term('lever', { avoid: ['leverage'] }),
        term('apply', { avoid: ['apply'] }),
        term('then', { aliases: ['leverage'] }),
      ],
    };
    expect(dataFindings(data)).toEqual([
      'term use: avoid holds an empty phrasing',
      'banned phrasing "leverage" belongs to more than one term: use, lever',
      'term use: "apply" is a word to write here and a banned phrasing of apply',
      'term apply: bans "apply", which it also says to write',
      'term then: "leverage" is a word to write here and a banned phrasing of use, lever',
    ]);
  });

  it('names a missing or unparseable glossary, and a missing allowlist', async () => {
    sb.write(ALLOWLIST, allowlistJson());
    expectFail(await sb.run(spec), `[vocabulary] FAIL ${SRC}: is missing`);
    sb.write(SRC, '{ nope');
    expectFail(await sb.run(spec), `[vocabulary] FAIL ${SRC}: is not valid JSON`);
    sb.write(SRC, glossary([term('widget')]));
    sb.rm(ALLOWLIST);
    expectFail(await sb.run(spec), `[vocabulary] FAIL ${ALLOWLIST}: is missing — it holds the exceptions to the ban`);
  });

  it('reads no prose while the data has a fault', async () => {
    sb.write(ALLOWLIST, allowlistJson());
    sb.write(SRC, glossary([term('widget', { avoid: ['gizmo'], scope: 'nobody' })]));
    sb.write('page.md', 'A gizmo.\n');
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([`[vocabulary] FAIL ${SRC}: term widget: unknown scope "nobody" (expected one of: house)`]);
  });
});

describe('the prose (glossary-C4..C7)', () => {
  it('prints one finding per matching line, quoting the replacement and its also-fine words', async () => {
    tree([term('computed', { avoid: ['derived'], aliases: ['worked out', 'built from'] })]);
    sb.write('docs/a.md', 'Derived once.\n\nThen derived twice, derived thrice.\n');
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([
      '[vocabulary] FAIL docs/a.md:1: use "computed" not "derived" — also fine: worked out, built from',
      '[vocabulary] FAIL docs/a.md:3: use "computed" not "derived" — also fine: worked out, built from',
    ]);
  });

  it('matches whole words case-blind, a trailing s or es included, beside anything but a letter, digit or underscore', () => {
    const text = ['gizmos', 'GIZMOES', 'gizmo-shaped', '(gizmo)', 'gizmo_x', 'x_gizmo', 'gizmo2', 'gizmoed', 'a/gizmo.md'].join('\n');
    expect(hitLines(text)).toEqual([[1, 'gizmo'], [2, 'gizmo'], [3, 'gizmo'], [4, 'gizmo'], [9, 'gizmo']]);
  });

  it('names the longer phrasing where two overlap, and each phrasing once per line', () => {
    const phrases = { 'derived class': 'subclass', derived: 'computed' };
    expect(hitLines('A derived class, and a derived value.\nTwo derived classes.\n', phrases)).toEqual([
      [1, 'derived class'],
      [1, 'derived'],
      [2, 'derived class'],
    ]);
  });

  it('reads frontmatter values but not keys, and skips fences, multi-line comments, tags, link targets and suffixes', () => {
    const text = [
      '---', 'gizmo: plain', 'description: a gizmo', 'tags:', '  - gizmo', '---',
      '~~~', 'gizmo', '````', 'gizmo', '~~~~', 'after the tilde fence',
      '<!-- a comment', 'gizmo', '-->', 'a line before <!-- an open', 'gizmo', 'close -->',
      '<span data-x="gizmo">text</span>', '[text](../gizmo.md) and <https://gizmo.test/>', '[ref]: https://x.test/gizmo',
      'A heading {#gizmo-id}', '```js', 'gizmo', '```', 'A last gizmo',
    ].join('\n');
    expect(hitLines(text)).toEqual([[3, 'gizmo'], [5, 'gizmo'], [26, 'gizmo']]);
  });

  it('leaves the frontmatter fields that record other people\'s words alone: a searcher types what they type', () => {
    const text = [
      '---', 'title: The gizmo page', 'solves: [my gizmo broke, how do I stop the gizmo]', 'aliases:', '  - Gizmo pattern', '  - gizmo',
      'description: a gizmo', 'tags:', '  - gizmo', '---', 'A gizmo in the body.',
    ].join('\n');
    expect(hitLines(text)).toEqual([[2, 'gizmo'], [7, 'gizmo'], [9, 'gizmo'], [11, 'gizmo']]);
    expect(RECORDED_FIELDS).toEqual(['solves', 'aliases']);
  });

  it('skips a fence inside a blockquote or opened on a list item, and raw HTML code and pre (glossary-C6)', () => {
    const text = [
      '> ```', '> gizmo in a quoted fence', '> ```', '> a quoted gizmo',
      '- ```', '  gizmo in a list-item fence', '  ```', '- a listed gizmo',
      '1. ~~~', '   gizmo in a numbered item', '   ~~~',
      '> - ```', '>   gizmo quoted and listed', '>   ```',
      'An <code>gizmo</code> raw span, a <CODE class="x">gizmo</CODE> one and a <pre>gizmo</pre> one.',
      '<pre>', 'gizmo in a pre block', '</pre> and a gizmo after it',
      '<pre class="x">gizmo on the opening line', 'more gizmo', '</PRE>',
      'A last gizmo',
    ].join('\n');
    expect(hitLines(text)).toEqual([[4, 'gizmo'], [8, 'gizmo'], [18, 'gizmo'], [22, 'gizmo']]);
  });

  it('ends a quoted fence with its blockquote and a list-item fence with its item', () => {
    const text = [
      '> ```', '> gizmo', 'gizmo once the quote ends', '```', 'gizmo in a top-level fence', '```',
      '- ```', '  gizmo', '', '  gizmo after a blank line', 'gizmo once the item ends',
      '```', '> gizmo: quoted text inside a top-level fence is code', '> ```', 'gizmo still in the fence', '```',
    ].join('\n');
    expect(hitLines(text)).toEqual([[3, 'gizmo'], [11, 'gizmo']]);
    expect(unquote('> > x')).toEqual({ depth: 2, text: 'x' });
    expect(unquote('> > x', 1)).toEqual({ depth: 1, text: '> x' });
    expect(fenceOpener('- ```js', 0, 2)).toEqual({ run: '```', depth: 0, indent: 2 });
    expect(fenceOpener('10) ~~~~', 1, 4)).toEqual({ run: '~~~~', depth: 1, indent: 4 });
  });

  it('takes a fence indented four or more past its list item for indented code, never an opener', () => {
    const text = [
      'A paragraph.', '', '    ```', 'This gizmo line is prose after indented code.',
      '- an item', '', '    ```', '    gizmo in the item\'s fence', '    ```', 'A gizmo after the list.',
    ].join('\n');
    expect(hitLines(text)).toEqual([[4, 'gizmo'], [10, 'gizmo']]);
    expect(fenceOpener('    ```', 0)).toBeNull();
    expect(fenceOpener('    ```', 0, 2)).toEqual({ run: '```', depth: 0, indent: 2 });
  });

  it('keeps the content column of each open list item, innermost last', () => {
    expect(openItems([], '- a')).toEqual([2]);
    expect(openItems([2], '  1.  b')).toEqual([2, 6]);
    expect(openItems([2, 6], '')).toEqual([2, 6]);
    expect(openItems([2, 6], '  more of the first item')).toEqual([2]);
    expect(openItems([2], 'back at the margin')).toEqual([]);
    expect(openItems([], '-')).toEqual([2]);
    expect(openItems([], '-      far')).toEqual([2]);
    expect(openItems([], '-1 is no marker')).toEqual([]);
  });

  it('reads a line that opens on an inline triple-backtick span as prose, not a fence', () => {
    const text = ['```gizmo``` is inline code, not a fence.', 'This gizmo line is prose.', '- ```gizmo``` in a list item', 'And a gizmo after it.'].join('\n');
    expect(hitLines(text)).toEqual([[2, 'gizmo'], [4, 'gizmo']]);
    expect(fenceOpener('```gizmo``` inline', 0)).toBeNull();
    expect(fenceOpener('```js title="a"', 0)).toEqual({ run: '```', depth: 0, indent: null });
    expect(fenceOpener('~~~ has `ticks`', 0)).toEqual({ run: '~~~', depth: 0, indent: null });
  });

  it('opens no comment inside a code span, and reads what follows the line that closes one', () => {
    const text = [
      'A section fact opens with `<!--meta` and closes later.', 'This gizmo line is read.',
      '<!-- a note', 'still note --> but this gizmo is shown', '<!-- one --> a gizmo <!-- two', 'gizmo hidden', '-->',
      '<!-- note --> <!-- vocab-ok --> no', 'x --> after an unopened close, a gizmo',
    ].join('\n');
    expect(hitLines(text)).toEqual([[2, 'gizmo'], [4, 'gizmo'], [5, 'gizmo'], [9, 'gizmo']]);
    expect(hitLines(['<!-- a', 'b --> gizmo <!-- vocab-ok -->'].join('\n'))).toEqual([]);
  });

  it('frees a line only for the exact marker outside code, and never the line below', () => {
    const text = [`gizmo ${MARKER}`, 'gizmo', 'gizmo `<!-- vocab-ok -->`', 'gizmo vocab-ok.md'].join('\n');
    expect(hitLines(text)).toEqual([[2, 'gizmo'], [3, 'gizmo'], [4, 'gizmo']]);
  });

  it('strips code spans the CommonMark way: a run closes only on a run of the same length', () => {
    expect(stripCodeSpans('a `x` b')).toBe('a   b');
    expect(stripCodeSpans('a ``x ` y`` b')).toBe('a   b');
    expect(stripCodeSpans('a `x b')).toBe('a `x b');
    expect(stripCodeSpans('a \\`x\\` b')).toBe('a \\`x\\` b');
    expect(stripCodeSpans('a ``x` b')).toBe('a ``x` b');
    expect(proseOf('word {#an-id}')).toBe('word');
  });

  it('says the banning term verbatim as the replacement (glossary-C7)', () => {
    expect(message({ phrase: 'derivable', term: 'can be worked out', aliases: [] })).toBe('use "can be worked out" not "derivable"');
  });

  it('reports nothing in code, an ignored file, a fixture tree or a changelog', async () => {
    tree();
    sb.write('.gitignore', 'out/\n');
    sb.write('out/built.md', 'gizmo\n');
    sb.write('scripts/test/fixture/page.md', 'gizmo\n');
    sb.write('tests/fixtures/page.md', 'gizmo\n');
    sb.write('plugins/x/CHANGELOG.md', 'gizmo\n');
    sb.write('docs/page.md', 'Say `gizmo` in code only.\n');
    expectPass(await sb.run(spec));
    expect(isChangelog('CHANGELOG.md')).toBe(true);
  });

  it('turns an untouched file red when a new phrasing is banned', async () => {
    tree();
    sb.write('old.md', 'Written long ago about a doohickey.\n');
    sb.commit('old');
    expectPass(await sb.run(spec));
    sb.write(SRC, glossary([term('widget', { avoid: ['gizmo', 'doohickey'] })]));
    expectFail(await sb.run(spec), '[vocabulary] FAIL old.md:1: use "widget" not "doohickey"');
  });

  it('leaves out a tracked file deleted but not yet staged: there is nothing of it to read', async () => {
    tree();
    sb.write('docs/kept.md', 'fine\n');
    sb.write('docs/gone.md', 'gizmo\n');
    sb.commit('two pages');
    sb.rm('docs/gone.md');
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe('[vocabulary] no banned phrasing in 1 markdown files (1 phrasings from 1 terms); 0 allowlist entries applied, excusing 0 hits');
  });

  it('skips a file holding a NUL byte: it is not prose', async () => {
    tree();
    sb.write('binary.md', 'gizmo\u0000\n');
    sb.write('ok.md', 'fine\n');
    expectPass(await sb.run(spec));
  });

  it('with no phrasing banned, still reads the list and passes', async () => {
    tree([term('widget')]);
    sb.write('a.md', 'gizmo\n');
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toContain('(0 phrasings from 1 terms)');
  });
});

describe('arguments', () => {
  it('scans only the files named, still checking the data', async () => {
    tree();
    sb.write('a.md', 'gizmo\n');
    sb.write('b.md', 'gizmo\n');
    const one = await sb.run(spec, ['./b.md']);
    expectFail(one);
    expect(one.err.split('\n')).toEqual(['[vocabulary] FAIL b.md:1: use "widget" not "gizmo"']);
    sb.write(SRC, glossary([term('widget', { avoid: ['gizmo'], scope: 'nobody' })]));
    expectFail(await sb.run(spec, ['b.md']), `${SRC}: term widget: unknown scope`);
  });

  it('runs whole when the glossary or the allowlist is named: a new phrasing reaches untouched files', async () => {
    tree();
    sb.write('a.md', 'gizmo\n');
    sb.write('b.md', 'fine\n');
    const r = await sb.run(spec, ['b.md', SRC]);
    expectFail(r);
    expect(r.err.split('\n')).toEqual(['[vocabulary] FAIL a.md:1: use "widget" not "gizmo"']);
    sb.write('a.md', 'fine\n');
    sb.write(ALLOWLIST, allowlistJson([{ name: 'gone', match: 'a.md', reason: 'Fixed soon.', owner: 'O', since: '2026-09-24' }]));
    expectFail(await sb.run(spec, [ALLOWLIST]), `${ALLOWLIST}: entry "gone" excuses nothing`);
  });

  it('passes when nothing named is markdown it reads, and fails when the scan set is empty', async () => {
    tree();
    sb.write('x.json', '{}\n');
    sb.write('CHANGELOG.md', 'gizmo\n');
    const named = await sb.run(spec, ['x.json', 'CHANGELOG.md']);
    expectPass(named);
    expect(named.out).toBe('[vocabulary] no markdown file among the 2 path(s) named');
    sb.rm('CHANGELOG.md');
    expectFail(await sb.run(spec), '[vocabulary] FAIL: no markdown file to scan — the scan set is wrong');
  });

  it('is misuse to name a file that does not exist, or to ask for --fix (glossary-C9)', async () => {
    tree();
    sb.write('a.md', 'fine\n');
    const before = sb.snapshot();
    expectMisuse(await sb.run(spec, ['nope.md']));
    expectMisuse(await sb.run(spec, ['--fix']));
    expect(sb.snapshot()).toEqual(before);
  });
});

describe('the allowlist (kb.data.exceptions)', () => {
  const entry = { name: 'old-pages', match: 'docs/old/**', reason: 'Rewritten in the next batch.', owner: 'O', since: '2026-09-24' };

  it('excuses the hits in the files an entry matches, counting the entry and the hits', async () => {
    tree();
    sb.write(ALLOWLIST, allowlistJson([entry]));
    sb.write('docs/old/a.md', 'gizmo\ngizmo\n');
    sb.write('docs/old/b.md', 'gizmo\n');
    sb.write('docs/new.md', 'fine\n');
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe('[vocabulary] no banned phrasing in 3 markdown files (1 phrasings from 1 terms); 1 allowlist entry applied, excusing 3 hits');
  });

  it('fails an entry that excuses nothing on a full run only, and one with an empty reason always', async () => {
    tree();
    sb.write(ALLOWLIST, allowlistJson([entry]));
    sb.write('docs/old/a.md', 'fine now\n');
    const full = await sb.run(spec);
    expectFail(full);
    expect(full.err.split('\n')).toEqual([
      `[vocabulary] FAIL ${ALLOWLIST}: entry "old-pages" excuses nothing — no file it matches uses a banned phrasing; delete it`,
    ]);
    expectPass(await sb.run(spec, ['docs/old/a.md']));
    sb.write(ALLOWLIST, allowlistJson([{ ...entry, reason: '' }]));
    expectFail(await sb.run(spec, ['docs/old/a.md']), 'entry "old-pages" has an empty reason');
  });

  it('holds every entry to an owner and a since date: each one excuses a failure (exceptions-C3)', async () => {
    tree();
    sb.write('docs/old/a.md', 'gizmo\n');
    sb.write(ALLOWLIST, allowlistJson([{ name: 'later', match: 'docs/old/a.md', reason: 'Fix later.' }]));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([`[vocabulary] FAIL ${ALLOWLIST}: entry "later" excuses a failure but names no owner`]);
    sb.write(ALLOWLIST, allowlistJson([{ name: 'later', match: 'docs/old/a.md', reason: 'Fix later.', owner: 'O' }]));
    expectFail(await sb.run(spec), `entry "later" excuses a failure but has no since date`);
    sb.write(ALLOWLIST, allowlistJson([entry]));
    sb.write(ALLOWLIST, allowlistJson([{ ...entry, match: 'docs/old/a.md' }]));
    expectPass(await sb.run(spec));
  });

  it('holds a whole path: an entry for one folder does not excuse a longer one', async () => {
    tree();
    sb.write(ALLOWLIST, allowlistJson([{ ...entry, match: 'docs/old/*' }]));
    sb.write('docs/old/a.md', 'gizmo\n');
    sb.write('docs/old/deeper/b.md', 'gizmo\n');
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual(['[vocabulary] FAIL docs/old/deeper/b.md:1: use "widget" not "gizmo"']);
  });
});

describe('the real tree', () => {
  it('passes, scanning every markdown file git lists that no built-in exclusion drops', async () => {
    // testing-C4: the scan set is recounted here, straight from git and the
    // four exclusions, not through the gate's own listing.
    const listed = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md', '*.mdx'], REPO_ROOT)
      .stdout.split('\0')
      .filter((f) => f !== '');
    const kept = [...new Set(listed)].filter(
      (f) =>
        fs.existsSync(path.join(REPO_ROOT, f)) &&
        !f.startsWith('scripts/test/fixture/') &&
        !f.startsWith('tests/fixtures/') &&
        path.basename(f) !== 'CHANGELOG.md' &&
        !/^docs\/records\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/.test(f),
    );
    const data = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, SRC), 'utf8')) as { terms: { avoid: string[] }[] };
    const phrases = data.terms.reduce((n, t) => n + t.avoid.length, 0);
    const real = await capture(spec, [], REPO_ROOT);
    expectPass(real);
    expect(real.out).toMatch(
      new RegExp(`^\\[vocabulary\\] no banned phrasing in ${String(kept.length)} markdown files \\(${String(phrases)} phrasings from ${String(data.terms.length)} terms\\); \\d+ allowlist (entry|entries) applied, excusing \\d+ hits?$`),
    );
  }, 60_000);
});
