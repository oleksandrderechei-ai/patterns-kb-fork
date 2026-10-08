/**
 * Text surgery on a page: frontmatter key by key through the one parser and
 * the one printer, the whole-file stamp, and a block put in, replaced or cut.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { frontmatter } from '../lib/frontmatter.js';
import { makeSandbox, type Sandbox } from '../lib/sandbox.js';

import { REPO } from './corpus.js';
import { blockSpans, eolOf, FM_ORDER, fmShapeProblem, putBlock, refuseStamped, rewriteFrontmatter, splitFrontmatter, stampOf, type FmChange } from './edit.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const FM = '---\ntitle: Breaker\ndescription: Stops calling\narea: resilience\nowner: A. Owner\ntags: [resilience, latency]\nstatus: stable\nsource: site/x.html\n---\n';

describe('splitFrontmatter and fmShapeProblem', () => {
  it('splits the fenced block from the body, or finds none', () => {
    expect(splitFrontmatter(`${FM}\n# T\n`)).toEqual({ fm: FM, body: '\n# T\n' });
    expect(splitFrontmatter('# T\n')).toEqual({ fm: '', body: '# T\n' });
    expect(splitFrontmatter('---\n---')).toEqual({ fm: '---\n---', body: '' });
  });

  it('names the first line that is not one `key: value`', () => {
    expect(fmShapeProblem(FM)).toBeNull();
    expect(fmShapeProblem('---\ntitle: x\nempty:\n---')).toBeNull();
    expect(fmShapeProblem('---\ntitle: x\ntags:\n  - a\n---\n')).toBe('  - a');
  });

  it('reads CRLF and a fence with trailing blanks as the one parser does, and says which ending a block uses', () => {
    const crlf = FM.replace(/\n/g, '\r\n');
    expect(splitFrontmatter(`${crlf}\r\n# T\r\n`)).toEqual({ fm: crlf, body: '\r\n# T\r\n' });
    expect(fmShapeProblem(crlf)).toBeNull();
    expect(fmShapeProblem('---\r\ntitle: x\r\ntags:\r\n  - a\r\n---\r\n')).toBe('  - a');
    expect(splitFrontmatter('--- \t\ntitle: x\n---  \nbody')).toEqual({ fm: '--- \t\ntitle: x\n---  \n', body: 'body' });
    expect(splitFrontmatter('----\ntitle: x\n---\n').fm).toBe('');
    sb.write('c.md', `${crlf}\r\nbody\r\n`);
    sb.write('t.md', '---  \ntitle: Loose\n---\n');
    expect(frontmatter(sb.dir, 'c.md', { lists: true })).toMatchObject({ title: 'Breaker', tags: ['resilience', 'latency'] });
    expect(frontmatter(sb.dir, 't.md', { lists: true })).toMatchObject({ title: 'Loose' });
    expect(eolOf(crlf)).toBe('\r\n');
    expect(eolOf(FM)).toBe('\n');
    expect(eolOf('')).toBe('\n');
  });
});

describe('rewriteFrontmatter', () => {
  const rewrite = (changes: [string, FmChange][]): string => {
    sb.write('p.md', `${FM}\nbody\n`);
    return rewriteFrontmatter(frontmatter(sb.dir, 'p.md', { raw: true }), new Map(changes));
  };

  it('keeps every untouched key byte for byte, and prints the one given', () => {
    expect(rewrite([['description', 'Stops calling: fast']])).toBe(FM.replace('description: Stops calling', 'description: "Stops calling: fast"'));
  });

  it('puts a new key where the dialect orders it, drops a null one, and prints a flag and a list', () => {
    const out = rewrite([
      ['favourite', true],
      ['aliases', ['CB', 'a, b']],
      ['status', null],
      ['solves', ['x']],
    ]);
    expect(out).toBe(
      '---\ntitle: Breaker\ndescription: Stops calling\narea: resilience\nowner: A. Owner\ntags: [resilience, latency]\naliases: [CB, "a, b"]\nsolves: [x]\nfavourite: true\nsource: site/x.html\n---\n',
    );
    sb.write('q.md', `${out}\n`);
    expect(frontmatter(sb.dir, 'q.md', { lists: true })).toMatchObject({ aliases: ['CB', 'a, b'], solves: ['x'], favourite: 'true' });
  });

  it('writes every line with the ending it is given', () => {
    expect(rewriteFrontmatter({ title: 'T' }, new Map<string, FmChange>([['favourite', true]]), '\r\n')).toBe('---\r\ntitle: T\r\nfavourite: true\r\n---\r\n');
  });

  it('puts a key with nothing before it first, and one the dialect does not order last', () => {
    expect(rewriteFrontmatter({ level: 'basic', extra: 'y' }, new Map<string, FmChange>([['title', 'T'], ['zzz', 'z']]))).toBe('---\ntitle: T\nlevel: basic\nextra: y\nzzz: z\n---\n');
    expect(rewriteFrontmatter({ empty: '' }, new Map())).toBe('---\nempty:\n---\n');
  });
});

describe('FM_ORDER', () => {
  it('is the key order of the dialect’s frontmatter table, no key more and none fewer', () => {
    const lines = fs.readFileSync(path.join(REPO, 'tools/src/lib/dialect.md'), 'utf8').split('\n');
    const at = lines.findIndex((l) => l.startsWith('**D-10 · Frontmatter.**'));
    const header = lines.findIndex((l, i) => i > at && l.startsWith('| Key |'));
    const keys: string[] = [];
    // The table is the run of `|` lines after its header and its rule line.
    for (const l of lines.slice(header + 2)) {
      if (!l.startsWith('|')) break;
      keys.push(/^\| `([a-z]+)` \|/.exec(l)?.[1] as string);
    }
    expect(at).toBeGreaterThanOrEqual(0);
    expect(keys.length).toBeGreaterThan(5);
    expect(keys).toEqual([...FM_ORDER]);
    expect(FM_ORDER).not.toContain('level');
  });
});

describe('stampOf and refuseStamped', () => {
  const STAMP = '<!-- GENERATED by tools/src/migrate/html-to-md.ts from site/x.html. Do not edit this file. -->';

  it('reads a whole-file stamp on a line of its own, outside a fence', () => {
    expect(stampOf(`${FM}\n${STAMP}\n\n# T\n`)).toEqual({ generator: 'tools/src/migrate/html-to-md.ts', source: 'site/x.html' });
    expect(stampOf(`# T\n\n\`\`\`\`md\n${STAMP}\n\`\`\`\nstill fenced\n\`\`\`\`\n`)).toBeNull();
    expect(stampOf(`~~~\n${STAMP}\n~~~\n\n${STAMP}\n`)).not.toBeNull();
    expect(stampOf(`text ${STAMP}\n<!-- GENERATED by g from s. Do not edit this block. -->\n`)).toBeNull();
  });

  it('refuses a stamped page and names what writes it', () => {
    expect(() => refuseStamped('docs/x.md', `${STAMP}\n`)).toThrow(
      'docs/x.md is generated by tools/src/migrate/html-to-md.ts from site/x.html (its stamp says so): edit site/x.html, then run make gen',
    );
    expect(() => refuseStamped('docs/x.md', '# T\n')).not.toThrow();
  });
});

const BODY = ['', '# T', '', 'Lead.', '', '## What', '<!--meta block=description-->', '', 'Words.', '', '## Rel', '<!--meta block=relationships-->', '', 'Rows.', ''].join('\n');
const ORDER = ['description', 'explain', 'wild', 'relationships'];

describe('blockSpans and putBlock', () => {
  it('finds each block from its ## to the next # or ##, a heading with no fact ending one too', () => {
    const body = `${BODY}\n## Loose\n\ntext\n`;
    expect(blockSpans(body).map((s) => [s.name, body.slice(s.start, s.end)])).toEqual([
      ['description', '## What\n<!--meta block=description-->\n\nWords.\n\n'],
      ['relationships', '## Rel\n<!--meta block=relationships-->\n\nRows.\n\n'],
    ]);
  });

  it('replaces a block where it stands', () => {
    expect(putBlock(BODY, 'description', ['## What', '<!--meta block=description-->', '', 'New.'], ORDER)).toBe(BODY.replace('Words.', 'New.'));
    expect(putBlock(BODY, 'relationships', ['## Rel', '<!--meta block=relationships-->', '', 'New.'], ORDER)).toBe(BODY.replace('Rows.', 'New.'));
  });

  it('puts a new block before the first later block of the kind, or at the end', () => {
    const lines = ['## Wild', '<!--meta block=wild-->', '', '- x'];
    expect(putBlock(BODY, 'wild', lines, ORDER)).toBe(BODY.replace('## Rel', `${lines.join('\n')}\n\n## Rel`));
    expect(putBlock(BODY, 'wild', lines, ['description', 'relationships', 'wild'])).toBe(`${BODY}\n${lines.join('\n')}\n`);
  });

  it('cuts a block out, leaving one newline at the end, and leaves a page without it alone', () => {
    expect(putBlock(BODY, 'relationships', null, ORDER)).toBe(BODY.slice(0, BODY.indexOf('## Rel')).replace(/\n+$/, '\n'));
    expect(putBlock(BODY, 'description', null, ORDER)).toBe(BODY.replace('## What\n<!--meta block=description-->\n\nWords.\n\n', ''));
    expect(putBlock(BODY, 'wild', null, ORDER)).toBe(BODY);
  });
});
