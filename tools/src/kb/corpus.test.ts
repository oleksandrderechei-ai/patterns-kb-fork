/**
 * The corpus: pages placed by the structure file and kind by folder, the
 * frontmatter read in one spawn, the tour memberships, the parse of a page and
 * the questions that need every page (where a link goes, what a page mentions),
 * the digest of a page's file, and the root.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeKbFixture } from '../lib/fixtures.js';
import { makeSandbox, type Sandbox } from '../lib/sandbox.js';

import { Corpus, KbError, KbUsageError, KIND_SEQ, metaOf, readModel, readOtherRows, readPages, REPO, rootFrom } from './corpus.js';
import { stripFrontmatter } from './page.js';

let sb: Sandbox;
beforeAll(() => {
  sb = makeSandbox();
  writeKbFixture(sb.dir);
});
afterAll(() => sb.cleanup());

describe('the pages', () => {
  it('places each page by its structure row: kind by folder, band and group by area', () => {
    const pages = readPages(sb.dir, readModel(sb.dir));
    expect(pages.map((p) => `${p.slug}:${p.kind}:${p.band}:${p.group}:${p.area}`)).toEqual([
      'breaker:pattern:distributed:distributed-resilience:distributed-resilience',
      'retry:pattern:distributed:distributed-resilience:distributed-resilience',
      'queue:pattern:messaging:messaging:messaging',
      'storm:hazard:hazard:hazard:hazards',
      'shortener:design:design:design:designs-mid',
      'loop:theme:theme:theme:designs-mid',
      'steady:theme:theme:theme:themes',
      'quick:principle:principle:principle:principles',
      'queues:capability:capability:capability:capabilities',
      'brokers:comparison:comparison:comparison:comparisons',
    ]);
    expect(pages[0]).toMatchObject({ route: '/patterns/distributed/resilience/breaker.html', path: 'patterns/distributed/resilience/breaker.html' });
    // The areas it sits in, outermost first, each with its label: what `categories` is made of.
    expect(pages[0]?.areaChain.map((a) => a.id)).toEqual(['patterns', 'distributed', 'distributed-resilience']);
    expect(pages[0]?.categories).toEqual(['patterns', 'distributed', 'distributed-resilience', 'pattern']);
    expect(pages.find((p) => p.slug === 'loop')?.areaChain.map((a) => a.id)).toEqual(['designs', 'designs-mid']);
    // The listing: kind by KIND_SEQ first, reading order within a kind.
    expect(new Corpus(sb.dir).listing.map((p) => p.slug)).toEqual(['breaker', 'retry', 'queue', 'storm', 'loop', 'steady', 'quick', 'shortener', 'queues', 'brokers']);
    expect(KIND_SEQ).toEqual(['pattern', 'hazard', 'theme', 'principle', 'design', 'capability', 'comparison']);
    expect(new Corpus(sb.dir).otherRows).toEqual([{ source: 'docs/reference/notes.md', route: '/reference/notes.html', area: 'reference' }]);
  });

  it('files a pattern listed on the patterns area itself under that band, and skips a row outside docs/', () => {
    const odd = makeSandbox();
    try {
      writeKbFixture(odd.dir);
      odd.write(
        'docs/data/site-structure.json',
        JSON.stringify({
          areas: [
            { id: 'patterns', pages: [{ slug: 'top', source: 'docs/patterns/top.md', route: '/patterns/top.html' }] },
            { id: 'elsewhere', pages: [{ slug: 'x', source: 'other/patterns/x.md', route: '/x.html' }, { slug: 'y', source: 'y.md', route: '/y.html' }] },
            { id: 'empty' },
          ],
        }),
      );
      expect(readPages(odd.dir, readModel(odd.dir)).map((p) => `${p.slug}:${p.band}`)).toEqual(['top:patterns']);
      // What readPages leaves out, each row with the area that lists it.
      expect(readOtherRows(odd.dir, readModel(odd.dir))).toEqual([
        { source: 'other/patterns/x.md', route: '/x.html', area: 'elsewhere' },
        { source: 'y.md', route: '/y.html', area: 'elsewhere' },
      ]);
      odd.write('docs/data/site-structure.json', '{}');
      expect(readPages(odd.dir, readModel(odd.dir))).toEqual([]);
      expect(readOtherRows(odd.dir, readModel(odd.dir))).toEqual([]);
    } finally {
      odd.cleanup();
    }
  });

  it('reads the content model: kinds, labelled verbs in display order, languages', () => {
    const m = readModel(REPO);
    expect(m.kinds.map((k) => k.id)).toEqual(['pattern', 'hazard', 'theme', 'principle', 'design', 'capability', 'comparison']);
    expect(m.verbs['combines-with']).toEqual({ label: 'Combines with', inverse: 'combines-with', symmetric: true });
    expect(m.verbs['prerequisite']).toEqual({ label: 'Requires', inverse: 'enables' });
    expect(m.relOrder.slice(0, 2)).toEqual(['Combines with', 'Alternative to']);
    expect(m.sketchLangs).toContain('typescript');
    expect(m.sketchLangs).toContain('go');
    expect(m.sketchOnly).toEqual({ go: { kind: 'pattern', area: 'concurrency' } });
    expect(m.groups['tradeoffs']).toEqual({ fact: 'polarity', values: ['pro', 'con'] });
  });
});

describe('lookups and facts', () => {
  it('finds a page by slug and route, and names the near misses of one it lacks', () => {
    const c = new Corpus(sb.dir);
    expect(c.page('storm')?.source).toBe('docs/hazards/storm.md');
    expect(c.byRoute('/themes/steady.html')?.slug).toBe('steady');
    expect(() => c.need('que')).toThrow(new KbError('unknown id: que\ndid you mean: queue, queues'));
    expect(() => c.need(undefined)).toThrow(new KbError('unknown id: (none given)'));
  });

  it('tells an id that names no page, a lookup that failed, from no id at all, a call made badly', () => {
    const c = new Corpus(sb.dir);
    const kind = (f: () => unknown): string[] => {
      try {
        f();
      } catch (e) {
        return [e instanceof KbUsageError ? 'usage' : e instanceof KbError ? 'lookup' : 'other'];
      }
      return [];
    };
    expect(kind(() => c.need('que'))).toEqual(['lookup']);
    expect(kind(() => c.need('zzz'))).toEqual(['lookup']);
    expect(kind(() => c.need(undefined))).toEqual(['usage']);
    expect(kind(() => c.need('queue'))).toEqual([]);
    // A usage error is a KbError, so a caller that catches one catches both.
    expect(new KbUsageError('x')).toBeInstanceOf(KbError);
  });

  it('reads every page’s frontmatter in one pass; lists split, a scalar list as one item', () => {
    const c = new Corpus(sb.dir);
    expect(c.meta('breaker')).toEqual({
      title: 'Breaker',
      essence: 'The breaker page',
      area: 'distributed-resilience',
      status: 'stable',
      owner: 'Test Owner',
      aliases: ['CB', 'fuse'],
      tags: ['resilience', 'latency'],
      solves: ['my threads hang on a dead dependency', 'one failing call, and the whole service falls'],
      favourite: true,
    });
    expect(c.meta('nope')).toEqual(metaOf({}));
    expect(c.frontmatter('breaker')).toMatchObject({ area: 'distributed-resilience', favourite: 'true', tags: ['resilience', 'latency'] });
    expect(c.frontmatter('nope')).toEqual({});
    expect(metaOf({ aliases: 'CB', tags: '', title: ['not', 'a', 'string'] })).toMatchObject({ title: '', aliases: ['CB'], tags: [] });
    expect(metaOf({ area: 'caching', owner: 'A. Owner', status: 'draft' })).toMatchObject({ area: 'caching', owner: 'A. Owner', status: 'draft' });
    // A key the page lacks reads as an empty string, a list as an empty list and the flag as false.
    expect(metaOf({})).toEqual({ title: '', essence: '', area: '', status: '', owner: '', aliases: [], tags: [], solves: [], favourite: false });
  });

  it('reads a page’s text once, and names a file it cannot read', () => {
    const odd = makeSandbox();
    try {
      writeKbFixture(odd.dir);
      odd.rm('docs/hazards/storm.md');
      const c = new Corpus(odd.dir);
      expect(c.meta('storm')).toEqual(metaOf({}));
      expect(() => c.text('storm')).toThrow(new KbError('storm: cannot read docs/hazards/storm.md'));
      expect(c.text('quick')).toBe(c.text('quick'));
      expect(c.cached('k', () => 1)).toBe(1);
      expect(c.cached('k', () => 2)).toBe(1);
      for (const p of c.pages) odd.rm(p.source);
      expect(new Corpus(odd.dir).meta('quick')).toEqual(metaOf({}));
    } finally {
      odd.cleanup();
    }
  });

  it('names the themes whose tour holds a page, with its role, and a theme’s members', () => {
    const c = new Corpus(sb.dir);
    expect(c.themesOf('retry')).toEqual([{ id: 'steady', name: 'Steady', role: 'Ride out blips', href: 'themes/steady.html' }]);
    expect(c.themesOf('storm')).toEqual([]);
    expect(c.membersOf('steady')).toEqual([
      { id: 'breaker', role: 'Stop hammering it' },
      { id: 'retry', role: 'Ride out blips' },
    ]);
    expect(c.membersOf('breaker')).toEqual([]);
  });

  it('gives a member with no note an empty role, and skips a profile with no theme page', () => {
    const odd = makeSandbox();
    try {
      writeKbFixture(odd.dir);
      odd.write(
        'docs/data/learning-paths.json',
        JSON.stringify({ profiles: [{ id: 'steady', stages: ['/hazards/storm.html'] }, { id: 'ghost', stages: ['/hazards/storm.html'] }], notes: {} }),
      );
      const c = new Corpus(odd.dir);
      expect(c.themesOf('storm')).toEqual([{ id: 'steady', name: 'Steady', role: '', href: 'themes/steady.html' }]);
      expect(c.membersOf('steady')).toEqual([{ id: 'storm', role: '' }]);
    } finally {
      odd.cleanup();
    }
  });
});

describe('a page read whole', () => {
  const BREAKER = 'docs/patterns/distributed/resilience/breaker.md';

  it('parses a page once and keeps the parse, with the markdown it was parsed from', () => {
    const c = new Corpus(sb.dir);
    const doc = c.doc('breaker');
    expect(c.doc('breaker')).toBe(doc);
    expect(doc.h1).toBe('Breaker');
    expect(doc.blocks[0]?.name).toBe('description');
    expect(doc.source).toBe(stripFrontmatter(c.text('breaker')));
    expect(() => c.doc('nope')).toThrow(new KbError('unknown id: nope'));
  });

  it('names the page a link url names, written on the page whose markdown is given', () => {
    const c = new Corpus(sb.dir);
    expect(c.linkTarget(BREAKER, './retry.md')?.slug).toBe('retry');
    expect(c.linkTarget(BREAKER, '../../../hazards/storm.md#cost')?.slug).toBe('storm');
    expect(c.linkTarget(BREAKER, '../../messaging/queue.md?x=1#y')?.slug).toBe('queue');
    expect(c.linkTarget('docs/themes/steady.md', '../patterns/distributed/resilience/retry.md')?.slug).toBe('retry');
    // A route is a page address from the site root, whichever page it is written on.
    expect(c.linkTarget(BREAKER, '/hazards/storm.html')?.slug).toBe('storm');
    expect(c.linkTarget('docs/themes/steady.md', '/hazards/storm.html#cost')?.slug).toBe('storm');
    expect(c.linkTarget(BREAKER, '/hazards/nope.html')).toBeUndefined();
  });

  it('names no page for an address elsewhere, a file that is not markdown, a page of no kind or a bare fragment', () => {
    const c = new Corpus(sb.dir);
    for (const url of ['https://example.com/x.md', 'http://example.com', '//example.com/x.md', 'mailto:a@b.c', './notes.txt', '../../../reference/notes.md', '#cost', '', '../nowhere.md']) {
      expect(c.linkTarget(BREAKER, url), url).toBeUndefined();
    }
  });

  it('hashes the bytes of a page’s file, which is not the hash of its text when the bytes are not text', () => {
    const own = makeSandbox();
    try {
      writeKbFixture(own.dir);
      const c = new Corpus(own.dir);
      expect(c.digest('breaker')).toBe(createHash('sha256').update(fs.readFileSync(path.join(own.dir, BREAKER))).digest('hex'));
      // A byte that is no UTF-8 reads back as U+FFFD, so the text hashes differently from the file.
      fs.writeFileSync(path.join(own.dir, 'docs/hazards/storm.md'), Buffer.concat([fs.readFileSync(path.join(own.dir, 'docs/hazards/storm.md')), Buffer.from([0xc3, 0x0a])]));
      const odd = new Corpus(own.dir);
      const bytes = fs.readFileSync(path.join(own.dir, 'docs/hazards/storm.md'));
      expect(odd.digest('storm')).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(odd.digest('storm')).not.toBe(createHash('sha256').update(odd.text('storm')).digest('hex'));
      own.rm('docs/hazards/storm.md');
      expect(() => new Corpus(own.dir).digest('storm')).toThrow(new KbError('storm: cannot read docs/hazards/storm.md'));
      expect(() => c.digest('nope')).toThrow(new KbError('unknown id: nope'));
    } finally {
      own.cleanup();
    }
  });
});

describe('mentions', () => {
  it('are the pages a page links to in its prose, first mention only, less itself and what a relation already names', () => {
    const c = new Corpus(sb.dir);
    // Retry twice, the storm and itself are named by edges or are the page; the queue is a mention.
    expect(c.mentions('breaker')).toEqual(['queue']);
    expect(c.mentions('breaker')).toBe(c.mentions('breaker'));
    expect(c.mentions('retry')).toEqual([]);
    expect(c.mentions('storm')).toEqual([]);
    expect(() => c.mentions('nope')).toThrow(new KbError('unknown id: nope'));
  });

  it('leave out a theme the page is in and a page its own tour names, and keep the first mention of any other', () => {
    const own = makeSandbox();
    try {
      writeKbFixture(own.dir);
      const retry = 'docs/patterns/distributed/resilience/retry.md';
      own.write(retry, own.read(retry).replace('Try again after a pause', 'Try again after a pause, under [the theme](../../../themes/steady.md), beside [the queue](../../messaging/queue.md) and [again](../../messaging/queue.md)'));
      const steady = 'docs/themes/steady.md';
      own.write(steady, own.read(steady).replace('Draw isolation lines.', 'Draw isolation lines, as [the breaker](../patterns/distributed/resilience/breaker.md) does, and see [the storm](../hazards/storm.md).'));
      const c = new Corpus(own.dir);
      expect(c.mentions('retry')).toEqual(['queue']);
      expect(c.mentions('steady')).toEqual(['storm']);
    } finally {
      own.cleanup();
    }
  });

  it('are taken from the markdown outside the generated blocks and the typed rows', () => {
    const c = new Corpus(sb.dir);
    // The theme's tour and its sibling rows link to pages, and none is a mention.
    expect(c.mentions('loop')).toEqual([]);
    expect(c.mentions('steady')).toEqual([]);
  });
});

describe('rootFrom', () => {
  it('takes KB_ROOT when set, this repo otherwise', () => {
    expect(rootFrom({ KB_ROOT: 'x/y' })).toBe(path.resolve('x/y'));
    expect(rootFrom({ KB_ROOT: '' })).toBe(REPO);
    expect(rootFrom({})).toBe(REPO);
  });
});
