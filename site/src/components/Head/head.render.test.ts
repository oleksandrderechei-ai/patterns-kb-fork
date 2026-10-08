// @vitest-environment node
/**
 * The page head: what Starlight's head list passes through, and what the
 * override adds after it. The `node` docblock is the one every render test needs
 * (see ../SectionHub/section-hub.render.test.ts).
 *
 * Starlight's own head list is a fixture here, carrying the links and the meta
 * description a real route carries; the claims held are the ones a reader or a
 * crawler depends on: the description is present, the only absolute link is the
 * canonical one, the override adds the kb tags and one bundle tag, a page
 * that has files beside it links them as alternates, and a page of the
 * knowledge base says where it sits, each page by what the structure file says
 * it has.
 */
import { describe, expect, it } from 'vitest';

import { publicRoot } from '../../../../tools/src/site/site-output';
import { renderComponent } from '../../lib/render-fixture';

import Head from './Head.astro';

const CANONICAL = 'https://example.test/patterns/x.html';

const data = {
  title: 'Example',
  description: 'What the page is for.',
  area: 'distributed-resilience',
  owner: 'Someone',
  tags: ['a', 'b'],
  solves: ['my thread pool is exhausted'],
};

/** The route data of a page whose content file is `filePath`; none when the page has no file. */
const at = (filePath?: string): App.Locals =>
  ({
    starlightRoute: {
      lang: 'en',
      head: [
        { tag: 'link', attrs: { rel: 'canonical', href: CANONICAL } },
        { tag: 'link', attrs: { rel: 'stylesheet', href: '../_astro/style.css' } },
        { tag: 'meta', attrs: { name: 'description', content: 'What the page is for.' } },
      ],
      entry: { data, ...(filePath === undefined ? {} : { filePath }) },
    },
  }) as unknown as App.Locals;

const locals = at();

const render = (over: App.Locals = locals): Promise<string> =>
  renderComponent(Head, { locals: over });

/** The content file of a page that is in the real structure: a pattern of the knowledge base. */
const PATTERN = 'site/src/content/docs/patterns/distributed/resilience/circuit-breaker.md';

/** Every `href` and `src` the head writes, with the tag it sits on. */
function links(html: string): { tag: string; rel: string | undefined; url: string }[] {
  return [...html.matchAll(/<(link|script)\b([^>]*)>/g)].flatMap(([, tag, attrs]) => {
    const url = /\b(?:href|src)="([^"]*)"/.exec(attrs)?.[1];
    const rel = /\brel="([^"]*)"/.exec(attrs)?.[1];
    return url === undefined ? [] : [{ tag: tag, rel, url }];
  });
}

describe('Head', () => {
  it('keeps the meta description the head list carries', async () => {
    const html = await render();
    expect(html).toMatch(/<meta name="description" content="What the page is for\."/);
  });

  it('writes no absolute link but the canonical one: every other is relative or root-relative', async () => {
    const html = await render(at(PATTERN));
    expect(links(html).filter((l) => l.rel === 'alternate')).toHaveLength(2);
    const absolute = links(html).filter((l) => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(l.url));
    expect(absolute).toEqual([{ tag: 'link', rel: 'canonical', url: CANONICAL }]);
  });

  it('adds the kb meta tags from the frontmatter', async () => {
    const html = await render();
    expect(html).toContain('<meta name="kb:area" content="distributed-resilience"');
    expect(html).toContain('<meta name="kb:tags" content="a,b"');
    expect(html).toContain('<meta name="kb:solves" content="my thread pool is exhausted"');
  });

  it('links the markdown and the record beside a page of the knowledge base, root-absolute for the post-build pass to make relative', async () => {
    const html = await render(at(PATTERN));
    const alternates = [...html.matchAll(/<link\b[^>]*\brel="alternate"[^>]*>/g)].map((m) => m[0]);
    expect(alternates).toEqual([
      '<link rel="alternate" type="text/markdown" href="/patterns/distributed/resilience/circuit-breaker.md">',
      '<link rel="alternate" type="application/json" href="/patterns/distributed/resilience/circuit-breaker.json">',
    ]);
  });

  it('states where a page of the knowledge base sits: its kind, band and group, after its tags', async () => {
    const html = await render(at(PATTERN));
    const kbNames = [...html.matchAll(/<meta name="(kb:[a-z]+)"/g)].map((m) => m[1]);
    expect(kbNames).toEqual([
      'kb:area',
      'kb:status',
      'kb:owner',
      'kb:tags',
      'kb:kind',
      'kb:band',
      'kb:group',
      'kb:solves',
    ]);
    expect(html).toContain('<meta name="kb:kind" content="pattern"');
    expect(html).toContain('<meta name="kb:band" content="distributed"');
    expect(html).toContain('<meta name="kb:group" content="distributed-resilience"');
  });

  it('states no place for a page that links no record: the home page, a hub, and a head with no content file', async () => {
    for (const filePath of [
      'site/src/content/docs/index.mdx',
      'site/src/content/docs/patterns/index.mdx',
      undefined,
    ]) {
      const html = await render(at(filePath));
      expect(html, String(filePath)).not.toMatch(/name="kb:(kind|band|group)"/);
    }
  });

  it('links no file beside a page that has none: the home page, a hub, and a head with no content file', async () => {
    for (const filePath of [
      'site/src/content/docs/index.mdx',
      'site/src/content/docs/patterns/index.mdx',
      undefined,
    ]) {
      expect(await render(at(filePath)), String(filePath)).not.toContain('rel="alternate"');
    }
  });

  it('adds one JSON-LD block that parses, and one classic bundle script', async () => {
    const html = await render();
    const blocks = [
      ...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([^]*?)<\/script>/g),
    ];
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0]?.[1])).toMatchObject({
      '@type': 'TechArticle',
      headline: 'Example',
    });
    const bundle = html.match(/<script[^>]*data-kb="bundle"[^>]*>/g) ?? [];
    expect(bundle).toHaveLength(1);
    expect(bundle[0]).toContain('src="/kb.js"');
    expect(bundle[0]).toContain('defer');
    expect(bundle[0]).not.toContain('type="module"');
  });

  it("gives the JSON-LD the page's address under the published root, and its trail from Home", async () => {
    const html = await render(
      at('/r/site/src/content/docs/patterns/distributed/resilience/example.md'),
    );
    const block = /<script[^>]*type="application\/ld\+json"[^>]*>([^]*?)<\/script>/.exec(html)?.[1];
    const ld = JSON.parse(block ?? '{}') as {
      url?: string;
      inLanguage?: string;
      mainEntityOfPage?: { breadcrumb?: { itemListElement?: { name: string; item: string }[] } };
    };
    const root = publicRoot().href;
    const url = `${root}patterns/distributed/resilience/example.html`;
    expect(ld.url).toBe(url);
    expect(ld.inLanguage).toBe('en');
    const items = ld.mainEntityOfPage?.breadcrumb?.itemListElement ?? [];
    expect(items[0]).toMatchObject({ name: 'Home', item: root });
    expect(items[items.length - 1]).toMatchObject({ name: 'Example', item: url });
  });
});
