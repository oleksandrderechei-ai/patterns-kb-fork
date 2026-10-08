import { describe, expect, it } from 'vitest';

import { onRequest } from './route-middleware';

const run = (toc: unknown): { toc: unknown } => {
  const route = { toc };
  (onRequest as unknown as (c: unknown) => void)({ locals: { starlightRoute: route } });
  return route;
};

describe('route middleware', () => {
  it('removes the outline of a page that has one entry', () => {
    expect(
      run({ items: [{ children: [] }], minHeadingLevel: 2, maxHeadingLevel: 3 }).toc,
    ).toBeUndefined();
  });

  it('keeps an outline of two entries, and a page with none to begin with', () => {
    const toc = { items: [{ children: [] }, { children: [] }] };
    expect(run(toc).toc).toBe(toc);
    expect(run(undefined).toc).toBeUndefined();
  });
});

describe('route middleware: the phone menu', () => {
  const at = (filePath: string): { hasSidebar: boolean } => {
    const route = { hasSidebar: false, entry: { filePath } };
    (onRequest as unknown as (c: unknown) => void)({ locals: { starlightRoute: route } });
    return route;
  };

  it('gives the home page, the marks page and the not-found page the sidebar that carries the menu', () => {
    expect(at('/r/site/src/content/docs/index.mdx').hasSidebar).toBe(true);
    expect(at('/r/site/src/content/docs/404.mdx').hasSidebar).toBe(true);
    expect(at('/r/site/src/content/docs/marks.md').hasSidebar).toBe(true);
  });

  it('leaves every other page as Starlight decided', () => {
    expect(at('/r/site/src/content/docs/hazards/god-object.md').hasSidebar).toBe(false);
    expect(at('/r/elsewhere.md').hasSidebar).toBe(false);
  });
});

describe('route middleware: the title', () => {
  const SUFFIX = ' · Software Design Atlas';
  type Entry = { tag: string; content?: unknown };
  const titled = (filePath: string, title: unknown, head: Entry[]): Entry[] => {
    const route = { entry: { filePath, data: { title } }, head };
    (onRequest as unknown as (c: unknown) => void)({ locals: { starlightRoute: route } });
    return route.head;
  };

  it('writes the kind into a page title, and gives the home page its own', () => {
    const page = titled(
      '/r/site/src/content/docs/patterns/distributed/resilience/circuit-breaker.md',
      'Circuit Breaker',
      [{ tag: 'meta' }, { tag: 'title', content: `Circuit Breaker${SUFFIX}` }],
    );
    expect(page[1]?.content).toBe(`Circuit Breaker pattern${SUFFIX}`);
    const home = titled('/r/site/src/content/docs/index.mdx', 'Software Design Atlas', [
      { tag: 'title', content: `Software Design Atlas${SUFFIX}` },
    ]);
    expect(home[0]?.content).toBe('Software Design Atlas: design patterns and system design');
  });

  it('leaves a head with no title entry, a title with no text and an entry with no title alone', () => {
    const meta = [{ tag: 'meta' }];
    expect(titled('/r/site/src/content/docs/index.mdx', 'Software Design Atlas', meta)).toEqual([
      { tag: 'meta' },
    ]);
    expect(
      titled('/r/site/src/content/docs/index.mdx', 'Software Design Atlas', [{ tag: 'title' }]),
    ).toEqual([{ tag: 'title' }]);
    expect(
      titled('/r/site/src/content/docs/index.mdx', undefined, [{ tag: 'title', content: 'T' }]),
    ).toEqual([{ tag: 'title', content: 'T' }]);
  });
});
