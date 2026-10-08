/**
 * The per-page lint: every check on a page built to fail it, and the clean
 * pages of the fixture tree passing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { explainBlock, writeKbFixture } from '../lib/fixtures.js';
import type { FmValue } from '../lib/frontmatter.js';
import { makeSandbox, type Sandbox } from '../lib/sandbox.js';

import { Corpus, type Page } from './corpus.js';
import { parsePage } from './page.js';
import { tagRules } from './tags.js';
import { blockProblems, descriptionLengthProblem, findingText, pageFindings, pageProblems, shapeRatchets, validateFindings, validatePages } from './validate.js';

let sb: Sandbox;
let corpus: Corpus;
const TERMS = tagRules(['resilience', 'latency'].map((id) => ({ id, facet: 'skill', applies: ['page'] })));
beforeAll(() => {
  sb = makeSandbox();
  writeKbFixture(sb.dir);
  corpus = new Corpus(sb.dir);
});
afterAll(() => sb.cleanup());

const quick = (): Page => corpus.need('quick');
const good = { title: 'Quick', description: 'd', area: 'principles', tags: ['resilience', 'latency'] };
const body = (blocks: string): string =>
  `---\ntitle: Quick\n---\n\n# Quick\n\n${blocks}`;
const PRINCIPLE = [
  '## A\n<!--meta block=description-->\n\nText.\n',
  `${explainBlock('Good.', 'B')}\n`,
  '## C\n<!--meta block=rationale-->\n\nWhy.\n',
  '## D\n<!--meta block=applying-->\n\nHow.\n',
  '## E\n<!--meta block=overreach-->\n\nToo far.\n',
  '## F\n<!--meta block=relationships-->\n',
];

describe('pageProblems', () => {
  it('passes a clean page', () => {
    expect(pageProblems(corpus, quick(), good, body(PRINCIPLE.join('\n')), TERMS)).toEqual([]);
  });

  it('holds the frontmatter to its shape', () => {
    const got = pageProblems(corpus, quick(), { area: 'themes', aliases: 'CB', solves: ['ok', ' '], tags: ['resilience', 'nope', 'latency', 'a', 'b', 'c'] }, body(PRINCIPLE.join('\n')), TERMS);
    expect(got).toEqual([
      'quick: frontmatter has no title',
      'quick: frontmatter has no description',
      'quick: frontmatter area "themes" but the structure file lists it under "principles"',
      'quick: aliases must be an inline list of non-empty strings',
      'quick: solves must be an inline list of non-empty strings',
      'quick: tag "nope" is not in the closed vocabulary',
      'quick: tag "a" is not in the closed vocabulary',
      'quick: tag "b" is not in the closed vocabulary',
      'quick: tag "c" is not in the closed vocabulary',
      'quick: tags carries 6 tag(s); a page needs 2-5',
    ]);
  });

  it('holds each solves phrase to 20 words', () => {
    const words = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');
    const at = (n: number): string[] => pageProblems(corpus, quick(), { ...good, solves: ['a', words(n), 'c'] }, body(PRINCIPLE.join('\n')), TERMS);
    expect(at(20)).toEqual([]);
    expect(at(21)).toEqual([`quick: a solves phrase is 21 words; say the one problem in 20 or fewer: "${words(21)}"`]);
  });

  it('holds a description to 160 characters, counting characters, not bytes', () => {
    const at = (n: number): string => `${'—'.repeat(10)}${'x'.repeat(n - 10)}`;
    expect(pageProblems(corpus, quick(), { ...good, description: at(160) }, body(PRINCIPLE.join('\n')), TERMS)).toEqual([]);
    expect(pageProblems(corpus, quick(), { ...good, description: at(161) }, body(PRINCIPLE.join('\n')), TERMS)).toEqual([
      'quick: description is 161 characters — 160 is where search results cut off',
    ]);
    expect(descriptionLengthProblem('short')).toBeNull();
  });

  it('holds the tag list to the tags gate once the list files a topic', () => {
    const faceted = tagRules([
      { id: 'resilience', facet: 'topic', applies: ['page'] },
      { id: 'caching', facet: 'topic', applies: ['page'] },
      { id: 'latency', facet: 'skill', applies: ['page'] },
      { id: 'drills', facet: 'skill', applies: ['exercise'] },
    ]);
    const at = (tags: string[]): string[] => pageProblems(corpus, quick(), { ...good, tags }, body(PRINCIPLE.join('\n')), faceted);
    expect(at(['resilience', 'latency'])).toEqual([]);
    expect(at(['latency', 'resilience'])).toEqual(['quick: tags are out of facet order at "resilience" — topics first, then skills, then languages']);
    expect(at(['resilience', 'caching'])).toEqual(['quick: 2 topic tags (resilience, caching) — a page has one, and it decides which hub group the page joins']);
    expect(at(['latency', 'drills'])).toEqual([
      'quick: tag "drills" does not apply to a page — widen its applies or pick another',
      'quick: no topic tag — what the page is about is the one tag it must carry, written first',
    ]);
    expect(at(['resilience', 'latency', 'latency'])).toEqual(['quick: tag "latency" is written twice']);
    // Before the retag no term is a topic: no page is held to one.
    expect(pageProblems(corpus, quick(), { ...good, tags: ['latency', 'resilience'] }, body(PRINCIPLE.join('\n')), TERMS)).toEqual([]);
  });

  it('counts a page with no tags as carrying none', () => {
    const { tags: _tags, ...untagged } = good;
    expect(pageProblems(corpus, quick(), untagged, body(PRINCIPLE.join('\n')), TERMS)).toEqual(['quick: tags carries 0 tag(s); a page needs 2-5']);
  });

  it('names a dialect problem at its line in the file', () => {
    const text = body(PRINCIPLE.join('\n').replace('Why.', 'Why. {level=advanced}'));
    const line = text.split('\n').findIndex((l) => l.includes('{level=advanced}')) + 1;
    expect(pageProblems(corpus, quick(), good, text, TERMS)).toEqual([
      `quick: line ${line}: \`level=\` is retired; delete it (a literal trailing brace is written \\{)`,
    ]);
  });

  it('holds the blocks to the kind: none missing, none unknown, in order', () => {
    const shuffled = [PRINCIPLE[0], PRINCIPLE[1], PRINCIPLE[3], PRINCIPLE[2], '## X\n<!--meta block=wild-->\n\n- **x** — y {#wild-x}\n', PRINCIPLE[5]].join('\n');
    expect(pageProblems(corpus, quick(), good, body(shuffled), TERMS)).toEqual([
      'quick: missing block "overreach"',
      'quick: unknown block "wild"',
      'quick: blocks out of order: description explain applying rationale wild relationships',
    ]);
  });

  it('holds the explain block to KB-014: one paragraph, a costs list, then one example', () => {
    const swap = (block: string): string => body(PRINCIPLE.map((b, k) => (k === 1 ? `${block}\n` : b)).join('\n'));
    const problems = (block: string): string[] => pageProblems(corpus, quick(), good, swap(block), TERMS);
    const head = '## B\n<!--meta block=explain-->\n\n';
    expect(problems(`${head}**Basic.** b.\n\n**Example.** e.`)).toEqual([
      'quick: KB-014 the explanation opens with the bold label "Basic." — write plain prose, the heading says what it is',
      'quick: KB-014 the explanation is 2 words — it runs 60 to 180, and what it costs goes in the costs list',
    ]);
    expect(problems(explainBlock('Good.', 'B'))).toEqual([]);
    expect(problems(`${explainBlock('Good.', 'B')}\n\nA third paragraph.`)).toEqual([
      'quick: KB-014 the explain block holds a paragraph after its example — it holds one paragraph, a costs list and one example, nothing else',
    ]);
    // A principle may leave the costs list out; a pattern may not.
    expect(problems(explainBlock('Good.', 'B').replace(/- \*\*Latency[^]*?thresholds\.\n\n/, ''))).toEqual([]);
    const breaker = corpus.text('breaker').replace(/- \*\*Latency[^]*?thresholds\.\n\n/, '');
    expect(pageProblems(corpus, corpus.need('breaker'), { ...good, area: 'distributed-resilience' }, breaker, TERMS)).toContainEqual(expect.stringMatching(/^breaker: KB-014 no costs list/));
  });

  it('holds the description block to KB-015: one paragraph of at most 80 words', () => {
    const swap = (block: string): string => body(PRINCIPLE.map((b, k) => (k === 0 ? `${block}\n` : b)).join('\n'));
    const problems = (text: string): string[] => pageProblems(corpus, quick(), good, swap(`## A\n<!--meta block=description-->\n\n${text}`), TERMS);
    const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${String(i)}`).join(' ');
    expect(problems(words(80))).toEqual([]);
    expect(problems(words(81))).toEqual(['quick: KB-015 the description is 81 words — say what the page is for in 80 or fewer']);
    expect(problems('One.\n\nTwo.')).toEqual(['quick: KB-015 the description holds 2 paragraphs — it is one paragraph']);
  });

  it('lets a page the kb-shape allowlist names break the ratchet its entry covers, and nothing else', () => {
    const listed = makeSandbox();
    try {
      writeKbFixture(listed.dir);
      const source = corpus.need('quick').source;
      const entry = (covers: string, extra: object = {}): object => ({ name: covers, match: source, covers, reason: 'r', owner: 'o', since: '2026-10-01', ...extra });
      const run = (entries: object[], explain: string, description: string): string[] => {
        listed.write('docs/data/allow/kb-shape.json', JSON.stringify({ entries }));
        const c = new Corpus(listed.dir);
        const text = body(PRINCIPLE.map((b, k) => (k === 1 ? `${explain}\n` : k === 0 ? `## A\n<!--meta block=description-->\n\n${description}\n` : b)).join('\n'));
        return pageProblems(c, c.need('quick'), good, text, TERMS);
      };
      const head = '## B\n<!--meta block=explain-->\n\n';
      const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${String(i)}`).join(' ');
      // An entry with no `covers` is the explain ratchet.
      expect(run([{ ...entry('explain'), covers: undefined }], `${head}Short.`, 'Text.')).toEqual([]);
      expect(run([entry('explain')], `${head}**Bold.** Short.`, 'Text.')).toEqual([
        'quick: KB-014 the explanation opens with the bold label "Bold." — write plain prose, the heading says what it is',
      ]);
      // Without an entry for its rule a page is not excused.
      expect(run([entry('costs')], `${head}Short.`, 'Text.')).toHaveLength(2);
      expect(run([entry('explain')], explainBlock('Good.', 'B'), words(90))).toEqual(['quick: KB-015 the description is 90 words — say what the page is for in 80 or fewer']);
      // The description ratchet excuses a page to its maxWords, and no further.
      expect(run([entry('description', { maxWords: 90 })], explainBlock('Good.', 'B'), words(90))).toEqual([]);
      expect(run([entry('description', { maxWords: 90 })], explainBlock('Good.', 'B'), words(91))).toEqual(['quick: KB-015 the description is 91 words — say what the page is for in 80 or fewer']);
      expect(run([entry('description')], explainBlock('Good.', 'B'), 'One.\n\nTwo.')).toEqual([]);
    } finally {
      listed.cleanup();
    }
  });

  it('holds go to a pattern page of the concurrency area, and the rest to the closed vocabulary', () => {
    const swap = (text: string, kind = 'pattern'): string[] => {
      const page = kind === 'pattern' ? corpus.need('breaker') : quick();
      return pageProblems(corpus, page, { ...good, area: page.area }, text, TERMS).filter((m) => m.includes('sketch language'));
    };
    const withGo = corpus.text('breaker').replace('## What it is', '```go\nx := 1\n```\n\n## What it is');
    expect(swap(withGo)).toEqual(['breaker: sketch language "go" is for pattern pages of area concurrency only — write this sketch in typescript']);
    expect(swap(body('```go\nx := 1\n```\n'), 'principle')).toEqual(['quick: sketch language "go" is for pattern pages of area concurrency only — write this sketch in typescript']);
    // Any other page is held to its area: a pattern page whose structure row is in the concurrency area passes.
    const area = { ...corpus.need('breaker'), area: 'concurrency' };
    expect(pageProblems(corpus, area, { ...good, area: 'concurrency' }, withGo, TERMS).filter((m) => m.includes('sketch language'))).toEqual([]);
  });

  it('holds the sketch languages to the content model', () => {
    const text = body([...PRINCIPLE.slice(0, 2), '## C\n<!--meta block=rationale-->\n\n```cobol\nx\n```\n', ...PRINCIPLE.slice(3)].join('\n'));
    expect(pageProblems(corpus, quick(), good, text, TERMS)).toEqual([
      'quick: sketch language "cobol" is not in the closed vocabulary (' + corpus.model.sketchLangs.join('/') + ')',
    ]);
  });

  it('holds the page’s edges to known verbs and existing pages', () => {
    const odd = makeSandbox();
    try {
      writeKbFixture(odd.dir);
      odd.write('docs/data/relations.json', JSON.stringify({ relations: [{ a: 'storm', verb: 'befriends', b: 'quick', note_a: '', note_b: '' }] }));
      const c = new Corpus(odd.dir);
      // The side that reads the inverse cannot: render-relations refuses the verb outright.
      expect(pageProblems(c, c.need('quick'), good, body(PRINCIPLE.join('\n')), TERMS)).toEqual(['quick: relations: unknown verb "befriends"']);
      expect(pageProblems(c, c.need('storm'), { ...good, area: 'hazards' }, c.text('storm'), TERMS)).toEqual(['storm: unknown relation verb "befriends"']);
      odd.write('docs/data/relations.json', JSON.stringify({ relations: [{ a: 'quick', verb: 'combines-with', b: 'gone', note_a: '', note_b: '' }] }));
      const d = new Corpus(odd.dir);
      expect(pageProblems(d, d.need('quick'), good, body(PRINCIPLE.join('\n')), TERMS)).toEqual(['quick: relation "combines-with" names no page "gone"']);
    } finally {
      odd.cleanup();
    }
  });
});

describe('pageFindings', () => {
  const full = body(PRINCIPLE.join('\n'));
  const swap = (index: number, block: string): string => body(PRINCIPLE.map((b, k) => (k === index ? `${block}\n` : b)).join('\n'));

  it('names the page and leaves the rule and the line null for a finding about the page as a whole', () => {
    expect(pageFindings(corpus, quick(), { ...good, title: '' }, full, TERMS)).toEqual([{ page: 'quick', rule: null, line: null, message: 'frontmatter has no title' }]);
    expect(pageFindings(corpus, quick(), good, body(PRINCIPLE.slice(0, 5).join('\n')), TERMS)).toEqual([{ page: 'quick', rule: null, line: null, message: 'missing block "relationships"' }]);
    expect(pageFindings(corpus, quick(), good, full, TERMS)).toEqual([]);
  });

  it('keys each finding as page, rule, line, message, in that order', () => {
    const [f] = pageFindings(corpus, quick(), { ...good, title: '' }, full, TERMS);
    expect(Object.keys(f as object)).toEqual(['page', 'rule', 'line', 'message']);
  });

  it('files the explain, description and selfcheck problems under KB-014, KB-015 and KB-016, with no line', () => {
    const head = '## B\n<!--meta block=explain-->\n\n';
    expect(pageFindings(corpus, quick(), good, swap(1, `${head}**Basic.** b.\n\n**Example.** e.`), TERMS)).toEqual([
      { page: 'quick', rule: 'KB-014', line: null, message: 'the explanation opens with the bold label "Basic." — write plain prose, the heading says what it is' },
      { page: 'quick', rule: 'KB-014', line: null, message: 'the explanation is 2 words — it runs 60 to 180, and what it costs goes in the costs list' },
    ]);
    const words = Array.from({ length: 81 }, (_, i) => `w${String(i)}`).join(' ');
    expect(pageFindings(corpus, quick(), good, swap(0, `## A\n<!--meta block=description-->\n\n${words}`), TERMS)).toEqual([
      { page: 'quick', rule: 'KB-015', line: null, message: 'the description is 81 words — say what the page is for in 80 or fewer' },
    ]);
    const withSelfcheck = body([...PRINCIPLE.slice(0, 5), '## S\n<!--meta block=selfcheck-->\n\n> not a question\n', PRINCIPLE[5]].join('\n'));
    const selfcheck = pageFindings(corpus, quick(), good, withSelfcheck, TERMS);
    expect(selfcheck.length).toBeGreaterThan(0);
    for (const f of selfcheck) expect(f).toMatchObject({ page: 'quick', rule: 'KB-016', line: null });
  });

  it('gives a dialect problem its line in the file and no rule id', () => {
    const text = body(PRINCIPLE.join('\n').replace('Why.', 'Why. {level=advanced}'));
    const line = text.split('\n').findIndex((l) => l.includes('{level=advanced}')) + 1;
    expect(pageFindings(corpus, quick(), good, text, TERMS)).toEqual([
      { page: 'quick', rule: null, line, message: '`level=` is retired; delete it (a literal trailing brace is written \\{)' },
    ]);
  });

  it('parses the page itself when it is not handed its parse', () => {
    const text = body(PRINCIPLE.join('\n').replace('Why.', 'Why. {level=advanced}'));
    expect(pageFindings(corpus, quick(), good, text, TERMS)).toEqual(pageFindings(corpus, quick(), good, text, TERMS, parsePage(text)));
  });

  it('makes the one line pageProblems prints from each finding, for every kind of finding', () => {
    const bad = body(PRINCIPLE.join('\n').replace('Why.', 'Why. {level=advanced}'));
    const cases: [Readonly<Record<string, FmValue>>, string][] = [
      [{ area: 'themes', aliases: 'CB', tags: ['nope'] }, full],
      [good, bad],
      [good, swap(1, '## B\n<!--meta block=explain-->\n\n**Basic.** b.\n\n**Example.** e.')],
    ];
    for (const [fm, text] of cases) {
      const findings = pageFindings(corpus, quick(), fm, text, TERMS);
      expect(findings.length).toBeGreaterThan(0);
      expect(pageProblems(corpus, quick(), fm, text, TERMS)).toEqual(findings.map(findingText));
    }
  });
});

describe('findingText', () => {
  it('is the page, then the line, then the rule id, then the words, each part there when the finding has it', () => {
    const f = { page: 'p', rule: null, line: null, message: 'm' };
    expect(findingText(f)).toBe('p: m');
    expect(findingText({ ...f, line: 3 })).toBe('p: line 3: m');
    expect(findingText({ ...f, rule: 'KB-014' })).toBe('p: KB-014 m');
    expect(findingText({ ...f, rule: 'KB-014', line: 3 })).toBe('p: line 3: KB-014 m');
    expect(findingText({ ...f, line: 0 })).toBe('p: line 0: m');
  });
});

describe('validateFindings', () => {
  it('is the findings of every page it is handed, in order, and validatePages is the same as lines', () => {
    const odd = makeSandbox();
    try {
      writeKbFixture(odd.dir);
      odd.write('docs/data/tags.json', '{}');
      const c = new Corpus(odd.dir);
      const pages = [c.need('retry'), c.need('storm')];
      const findings = validateFindings(c, pages);
      expect(findings.map((f) => f.page)).toEqual(['retry', 'retry', 'storm', 'storm']);
      expect(findings[0]).toEqual({ page: 'retry', rule: null, line: null, message: 'tag "resilience" is not in the closed vocabulary' });
      expect(validatePages(c, pages)).toEqual(findings.map(findingText));
      expect(validateFindings(c, [])).toEqual([]);
    } finally {
      odd.cleanup();
    }
  });
});

describe('the pieces', () => {
  it('reports blocks as scripts/lib/validate.mjs did', () => {
    expect(blockProblems(['a', 'b'], ['a', 'b', 'c'], ['c'])).toEqual([]);
    expect(blockProblems(['b', 'a'], ['a', 'b'], [])).toEqual(['blocks out of order: b a']);
  });

  it('reads the kb-shape allowlist as ratchets, and an unreadable or malformed one as excusing nothing', () => {
    const box = makeSandbox();
    try {
      expect(shapeRatchets(box.dir).excuses('explain', 'docs/a.md')).toBe(false);
      box.write('docs/data/allow/kb-shape.json', '{ not json');
      expect(shapeRatchets(box.dir).excuses('explain', 'docs/a.md')).toBe(false);
      box.write('docs/data/allow/kb-shape.json', JSON.stringify({ version: 1 }));
      expect(shapeRatchets(box.dir).excuses('explain', 'docs/a.md')).toBe(false);
      box.write('docs/data/allow/kb-shape.json', JSON.stringify({ entries: [{ match: 7 }, { match: 'docs/{a,b}.md' }, { match: 'docs/c.md', covers: 'costs' }] }));
      const list = shapeRatchets(box.dir);
      expect(list.excuses('explain', 'docs/a.md')).toBe(true);
      expect(list.excuses('explain', 'docs/c.md')).toBe(false);
      expect(list.excuses('costs', 'docs/c.md')).toBe(true);
      // The same file read again is the same compiled list; a changed file is read afresh.
      expect(shapeRatchets(box.dir)).toBe(list);
      box.write('docs/data/allow/kb-shape.json', JSON.stringify({ entries: [] }));
      expect(shapeRatchets(box.dir).excuses('explain', 'docs/a.md')).toBe(false);
    } finally {
      box.cleanup();
    }
  });

  it('validates no pages as none', () => {
    expect(validatePages(corpus, [])).toEqual([]);
  });

  it('reads a tag list that is missing as holding none', () => {
    const odd = makeSandbox();
    try {
      writeKbFixture(odd.dir);
      odd.write('docs/data/tags.json', '{}');
      const c = new Corpus(odd.dir);
      expect(validatePages(c, [c.need('retry')])).toEqual([
        'retry: tag "resilience" is not in the closed vocabulary',
        'retry: tag "latency" is not in the closed vocabulary',
      ]);
    } finally {
      odd.cleanup();
    }
  });
});
