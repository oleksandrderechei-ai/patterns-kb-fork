/**
 * The head entries the middleware writes: the tool pages' robots meta and the
 * home page's canonical address.
 */
import { describe, expect, it } from 'vitest';

import { canonicalAtRoot, noindex, type HeadEntry } from './head-entries';

describe('noindex', () => {
  it('keeps a page out of the index and its links followed, a fresh entry each time', () => {
    expect(noindex()).toEqual({
      tag: 'meta',
      attrs: { name: 'robots', content: 'noindex, follow' },
    });
    expect(noindex()).not.toBe(noindex());
  });
});

describe('canonicalAtRoot', () => {
  it('points the canonical link and og:url at the root of their origin, and nothing else', () => {
    const head: HeadEntry[] = [
      { tag: 'title', content: 'Home' },
      { tag: 'link', attrs: { rel: 'canonical', href: 'https://example.test/index.html' } },
      { tag: 'meta', attrs: { property: 'og:url', content: 'https://example.test/index.html' } },
      { tag: 'meta', attrs: { property: 'og:title', content: 'Home' } },
      { tag: 'link', attrs: { rel: 'stylesheet', href: '/style.css' } },
      { tag: 'meta' },
    ];
    canonicalAtRoot(head);
    expect(head).toEqual([
      { tag: 'title', content: 'Home' },
      { tag: 'link', attrs: { rel: 'canonical', href: 'https://example.test/' } },
      { tag: 'meta', attrs: { property: 'og:url', content: 'https://example.test/' } },
      { tag: 'meta', attrs: { property: 'og:title', content: 'Home' } },
      { tag: 'link', attrs: { rel: 'stylesheet', href: '/style.css' } },
      { tag: 'meta' },
    ]);
  });

  it('leaves a canonical entry with no address as it is', () => {
    const head: HeadEntry[] = [{ tag: 'link', attrs: { rel: 'canonical' } }];
    canonicalAtRoot(head);
    expect(head).toEqual([{ tag: 'link', attrs: { rel: 'canonical' } }]);
  });
});
