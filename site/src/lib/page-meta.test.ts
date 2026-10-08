/**
 * The one place a page's facts become meta tags and JSON-LD.
 *
 * Both serialisations are built from the same entry, so the cases pin that they
 * agree and that neither invents a field the entry does not carry.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Structure, StructureArea } from '../../../tools/src/lib/site-routes';
import {
  alternateLinks,
  alternatesOf,
  CONTENT_MODEL,
  jsonLd,
  jsonLdText,
  metaTags,
  pageMeta,
  readKinds,
  type MetaEntry,
} from './page-meta';
import { repoRoot } from './repo-root';

// filePath left off so lastModified() short-circuits before it shells out to
// git: this suite is about the shape, not about the repo it runs in.
const entry = (data: Partial<MetaEntry['data']> = {}): MetaEntry => ({
  data: {
    title: 'Circuit Breaker',
    description: "Stops calling a service that's already failing",
    area: 'distributed-resilience',
    owner: 'Oleksandr Derechei',
    ...data,
  },
});

describe('pageMeta', () => {
  it('defaults status to stable and tags to empty', () => {
    const meta = pageMeta(entry());
    expect(meta.status).toBe('stable');
    expect(meta.tags).toEqual([]);
    expect(meta.modified).toBeNull();
  });

  it('keeps the values a page did declare', () => {
    const meta = pageMeta(entry({ status: 'draft', tags: ['resilience', 'latency'] }));
    expect(meta.status).toBe('draft');
    expect(meta.tags).toEqual(['resilience', 'latency']);
  });
});

describe('metaTags', () => {
  it('emits the four kb:* names, tags joined by comma', () => {
    const tags = metaTags(pageMeta(entry({ tags: ['resilience', 'latency'] })));
    expect(tags.map(([name]) => name)).toEqual(['kb:area', 'kb:status', 'kb:owner', 'kb:tags']);
    expect(Object.fromEntries(tags)['kb:tags']).toBe('resilience,latency');
  });

  it('gives each alias and each solves phrase an element of its own, commas and all', () => {
    const tags = metaTags(
      pageMeta(
        entry({
          aliases: ['breaker', 'CB'],
          solves: ['one slow call, then another', 'retries make it worse'],
        }),
      ),
    );
    expect(tags.slice(4)).toEqual([
      ['kb:alias', 'breaker'],
      ['kb:alias', 'CB'],
      ['kb:solves', 'one slow call, then another'],
      ['kb:solves', 'retries make it worse'],
    ]);
    expect(metaTags(pageMeta(entry()))).toHaveLength(4);
  });
});

describe('jsonLd', () => {
  it('names the page, its area and its owner', () => {
    const ld = jsonLd(pageMeta(entry({ tags: ['resilience'] })));
    expect(ld).toMatchObject({
      '@type': 'TechArticle',
      headline: 'Circuit Breaker',
      isPartOf: { name: 'distributed-resilience' },
      author: { name: 'Oleksandr Derechei' },
      keywords: 'resilience',
    });
  });

  // schema.org keys are omitted rather than emitted empty: a `keywords: ""` is
  // a claim that the page has no keywords, which is not the same as silence.
  it('omits keywords, author and dateModified when there is nothing to say', () => {
    const ld = jsonLd(pageMeta(entry({ owner: '' })));
    expect(ld).not.toHaveProperty('keywords');
    expect(ld).not.toHaveProperty('author');
    expect(ld).not.toHaveProperty('dateModified');
    expect(
      jsonLd({ ...pageMeta(entry()), modified: '2026-09-24T10:00:00+02:00' }).dateModified,
    ).toBe('2026-09-24T10:00:00+02:00');
  });

  it('writes no < in its text, so a closing script tag in a value cannot end the block', () => {
    const text = jsonLdText(pageMeta(entry({ description: 'a </script> b' })));
    expect(text).not.toContain('<');
    expect((JSON.parse(text) as { description: string }).description).toBe('a </script> b');
  });
});

describe('alternatesOf', () => {
  const area = (
    id: string,
    pages: { slug: string; source: string; route: string }[],
    over: Partial<StructureArea> = {},
  ): StructureArea => ({
    id,
    label: id,
    hub: { description: id, intro: id, tags: [] },
    pages: pages.map((p) => ({ ...p, label: p.slug })),
    ...over,
  });
  // A page of the knowledge base, a page of the tree that is none, a page a generator writes and a
  // row of an unpublished area: the four shapes a row takes.
  const structure: Structure = {
    areas: [
      area('patterns', [{ slug: 'x', source: 'docs/patterns/x.md', route: '/patterns/x.html' }]),
      area('concepts', [
        { slug: 'guide', source: 'docs/concepts/guide.md', route: '/concepts/guide.html' },
      ]),
      area('map', [{ slug: 'stack', source: 'generated', route: '/map/stack.html' }], {
        nav: 'link',
        generated: 'tools/src/site/gen-map-pages.ts',
      }),
      area(
        'reference',
        [{ slug: 'old', source: 'docs/patterns/old.md', route: '/patterns/old.html' }],
        {
          nav: 'none',
        },
      ),
    ],
  };
  const kinds = [{ id: 'pattern', folder: 'patterns' }];
  const at = (rel: string): ReturnType<typeof alternatesOf> =>
    alternatesOf(`/repo/site/src/content/docs/${rel}`, structure, kinds);

  it('gives a page of the knowledge base its markdown and its record, its route with .md and .json', () => {
    expect(at('patterns/x.md')).toEqual({
      markdown: '/patterns/x.md',
      record: '/patterns/x.json',
    });
  });

  it('gives a page of the tree that is of no kind its markdown alone', () => {
    expect(at('concepts/guide.md')).toEqual({ markdown: '/concepts/guide.md', record: null });
  });

  it('gives no record to any page when the tree has no kinds, which is a tree with no content model', () => {
    expect(alternatesOf('/repo/site/src/content/docs/patterns/x.md', structure, [])).toEqual({
      markdown: '/patterns/x.md',
      record: null,
    });
  });

  it('gives a page a generator writes neither, since nothing under docs/ is its source', () => {
    expect(at('map/stack.mdx')).toEqual({ markdown: null, record: null });
  });

  it('gives neither to a hub, the home page, a row of an unpublished area or a path that names no page', () => {
    for (const rel of ['patterns/index.mdx', 'index.mdx', 'patterns/old.md', 'nowhere/at-all.md']) {
      expect(at(rel), rel).toEqual({ markdown: null, record: null });
    }
    for (const none of [null, undefined, '']) {
      expect(alternatesOf(none, structure, kinds), String(none)).toEqual({
        markdown: null,
        record: null,
      });
    }
    expect(alternatesOf('/elsewhere/patterns/x.md', structure, kinds)).toEqual({
      markdown: null,
      record: null,
    });
  });

  it('reads the real structure and content model when it is given none: a pattern has both, the home page neither', () => {
    const pattern = 'site/src/content/docs/patterns/distributed/resilience/circuit-breaker.md';
    expect(alternatesOf(pattern)).toEqual({
      markdown: '/patterns/distributed/resilience/circuit-breaker.md',
      record: '/patterns/distributed/resilience/circuit-breaker.json',
    });
    expect(alternatesOf('site/src/content/docs/index.mdx')).toEqual({
      markdown: null,
      record: null,
    });
  });
});

describe('readKinds', () => {
  it('reads the kinds of a content model, and none from a tree that has no content model', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-kinds-'));
    try {
      expect(readKinds(dir)).toEqual([]);
      fs.mkdirSync(path.join(dir, 'docs/data'), { recursive: true });
      const kinds = [{ id: 'pattern', folder: 'patterns' }];
      fs.writeFileSync(path.join(dir, CONTENT_MODEL), JSON.stringify({ kinds }));
      expect(readKinds(dir)).toEqual(kinds);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the seven kinds of this repository, patterns first', () => {
    expect(readKinds(repoRoot()).map((k) => k.id)).toEqual([
      'pattern',
      'hazard',
      'theme',
      'principle',
      'design',
      'capability',
      'comparison',
    ]);
  });
});

describe('alternateLinks', () => {
  it('names each file by the type it is served as, the markdown first', () => {
    expect(alternateLinks({ markdown: '/a/b.md', record: '/a/b.json' })).toEqual([
      ['text/markdown', '/a/b.md'],
      ['application/json', '/a/b.json'],
    ]);
  });

  it('names only the files there are', () => {
    expect(alternateLinks({ markdown: '/a/b.md', record: null })).toEqual([
      ['text/markdown', '/a/b.md'],
    ]);
    expect(alternateLinks({ markdown: null, record: '/a/b.json' })).toEqual([
      ['application/json', '/a/b.json'],
    ]);
    expect(alternateLinks({ markdown: null, record: null })).toEqual([]);
  });
});
