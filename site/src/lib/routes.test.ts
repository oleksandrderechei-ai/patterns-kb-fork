/**
 * A page's route from its content file path, and the hubs above it.
 *
 * The cases are the shapes a loader hands over — a page, a hub, the home page,
 * a path that names no page — and a trail read off a small structure, so the
 * suite does not move when the real file does.
 */
import { describe, expect, it } from 'vitest';

import type { Structure } from '../../../tools/src/lib/site-routes';
import {
  areaLabel,
  areaOfRoute,
  crumbsOf,
  isHub,
  isMenuOnly,
  isPage,
  isTool,
  pagerLabel,
  routeOf,
  topAreaOf,
  topAreaOfRoute,
  trailOf,
  upOf,
} from './routes';

describe('routeOf', () => {
  it('turns a content file into the file route it builds', () => {
    expect(routeOf('/repo/site/src/content/docs/patterns/caching/cache-aside.md')).toBe(
      '/patterns/caching/cache-aside.html',
    );
  });

  it('puts a hub beside its folder, and the home page at the root', () => {
    expect(routeOf('site/src/content/docs/patterns/caching/index.mdx')).toBe(
      '/patterns/caching.html',
    );
    expect(routeOf('site/src/content/docs/index.mdx')).toBe('/index.html');
  });

  it('accepts Windows separators', () => {
    expect(routeOf('C:\\repo\\site\\src\\content\\docs\\hazards\\god-object.md')).toBe(
      '/hazards/god-object.html',
    );
  });

  it('answers null for anything outside the collection', () => {
    expect(routeOf(undefined)).toBeNull();
    expect(routeOf('')).toBeNull();
    expect(routeOf('docs/patterns/caching/cache-aside.md')).toBeNull();
  });
});

const hub = { description: 'd', intro: 'i', tags: [] };
const tiny: Structure = {
  areas: [
    { id: 'patterns', label: 'Patterns', hub, pages: [] },
    { id: 'caching', label: 'Caching', nestUnder: 'patterns', hub, pages: [] },
  ],
};

describe('trailOf', () => {
  it('lists every hub above a page, outermost first', () => {
    expect(trailOf('caching', '/patterns/caching/cache-aside.html', tiny)).toEqual([
      { href: '/patterns.html', label: 'Patterns' },
      { href: '/patterns/caching.html', label: 'Caching' },
    ]);
  });

  it('leaves a hub off its own trail', () => {
    expect(trailOf('caching', '/patterns/caching.html', tiny)).toEqual([
      { href: '/patterns.html', label: 'Patterns' },
    ]);
  });

  it('adds no crumb for an area with no placed hub, so a link area’s page has no trail', () => {
    const navs: Structure = {
      areas: [
        ...tiny.areas,
        {
          id: 'map',
          label: 'Map',
          nav: 'link',
          hub,
          pages: [{ slug: 'stack', label: 'S', source: 'generated', route: '/map/stack.html' }],
        },
      ],
    };
    expect(trailOf('map', '/map/stack.html', navs)).toEqual([]);
    expect(upOf('map', '/map/stack.html', navs)).toEqual({ href: '/index.html', label: 'Home' });
  });

  it('gives an area the file does not hold no trail', () => {
    expect(trailOf('nowhere', '/x.html', tiny)).toEqual([]);
  });

  it('reads the real structure file by default', () => {
    expect(trailOf('distributed-resilience', null)[0]).toEqual({
      href: '/patterns.html',
      label: 'Patterns',
    });
  });

  it('names each hub by its area label', () => {
    expect(trailOf('caching', null, tiny)[0]?.label).toBe('Patterns');
  });
});

describe('crumbsOf', () => {
  it('reads Home, every hub above the page, then the page with no link', () => {
    expect(crumbsOf('caching', '/patterns/caching/cache-aside.html', 'Cache-Aside', tiny)).toEqual([
      { href: '/index.html', label: 'Home' },
      { href: '/patterns.html', label: 'Patterns' },
      { href: '/patterns/caching.html', label: 'Caching' },
      { href: null, label: 'Cache-Aside' },
    ]);
  });

  it('gives the home page, the not-found page and a path that is no page no trail', () => {
    expect(crumbsOf('patterns', '/index.html', 'Home', tiny)).toEqual([]);
    expect(crumbsOf('patterns', '/404.html', 'Page not found', tiny)).toEqual([]);
    expect(crumbsOf('patterns', null, 'Nowhere', tiny)).toEqual([]);
  });

  it('reads Home › My marks for the marks page, a tool outside the tree', () => {
    expect(crumbsOf('patterns', '/marks.html', 'My marks', tiny)).toEqual([
      { href: '/index.html', label: 'Home' },
      { href: null, label: 'My marks' },
    ]);
  });

  it('reads the real structure file by default', () => {
    expect(crumbsOf('distributed-resilience', '/x.html', 'X')[1]).toEqual({
      href: '/patterns.html',
      label: 'Patterns',
    });
  });
});

describe('upOf', () => {
  it('goes from a page to its own hub, from a hub to the one above, and from a top hub home', () => {
    expect(upOf('caching', '/patterns/caching/cache-aside.html', tiny)).toEqual({
      href: '/patterns/caching.html',
      label: 'Caching',
    });
    expect(upOf('caching', '/patterns/caching.html', tiny)).toEqual({
      href: '/patterns.html',
      label: 'Patterns',
    });
    expect(upOf('patterns', '/patterns.html', tiny)).toEqual({
      href: '/index.html',
      label: 'Home',
    });
  });

  it('gives the home page, and a path that is no page, no up', () => {
    expect(upOf('patterns', '/index.html', tiny)).toBeNull();
    expect(upOf('patterns', null, tiny)).toBeNull();
  });
});

describe('pagerLabel', () => {
  it('names a hub by its area, and leaves a page its own title', () => {
    expect(pagerLabel('/patterns/caching.html', 'Overview', tiny)).toBe('Caching');
    expect(pagerLabel('/patterns.html', 'Overview', tiny)).toBe('Patterns');
    expect(pagerLabel('/patterns/caching/cache-aside.html', 'Cache-Aside', tiny)).toBe(
      'Cache-Aside',
    );
  });
});

describe('isPage', () => {
  const tiny: Structure = {
    areas: [
      {
        id: 'patterns',
        label: 'Patterns',
        hub,
        pages: [{ slug: 'a', label: 'A', source: 'docs/patterns/a.md' }],
      },
      {
        id: 'map',
        label: 'Map',
        nav: 'link',
        generated: 'gen',
        hub,
        pages: [{ slug: 'stack', label: 'S', source: 'generated', route: '/map/stack.html' }],
      },
    ],
  };

  it('answers yes for a page of the page tree only', () => {
    expect(isPage('/patterns/a.html', tiny)).toBe(true);
    expect(isPage('/patterns.html', tiny)).toBe(false);
    expect(isPage('/index.html', tiny)).toBe(false);
    expect(isPage('/map/stack.html', tiny)).toBe(false);
    expect(isPage(null, tiny)).toBe(false);
  });

  it('reads the real structure file by default', () => {
    expect(isPage('/patterns/distributed/resilience/circuit-breaker.html')).toBe(true);
  });
});

describe('the kind of a route', () => {
  it('names the outermost area an area nests under, itself for a top one', () => {
    expect(topAreaOf('caching', tiny)).toBe('patterns');
    expect(topAreaOf('patterns', tiny)).toBe('patterns');
    expect(topAreaOf('nowhere', tiny)).toBeUndefined();
  });

  it('knows a hub from a page and reads a route of either to its outermost area', () => {
    expect(isHub('/patterns/caching.html', tiny)).toBe(true);
    expect(isHub('/patterns/caching/cache-aside.html', tiny)).toBe(false);
    expect(isHub(null, tiny)).toBe(false);
    expect(topAreaOfRoute('/patterns/caching.html', tiny)).toBe('patterns');
    expect(topAreaOfRoute('/index.html', tiny)).toBeUndefined();
  });

  it('reads the real structure file by default', () => {
    expect(topAreaOfRoute('/hazards/god-object.html')).toBe('hazards');
    expect(topAreaOfRoute('/patterns/distributed/resilience/circuit-breaker.html')).toBe(
      'patterns',
    );
  });
});

describe('the tool pages', () => {
  it('knows the marks page and the not-found page as tools, and no page of the tree', () => {
    expect(isTool('/marks.html')).toBe(true);
    expect(isTool('/404.html')).toBe(true);
    expect(isTool('/patterns.html')).toBe(false);
    expect(isTool(null)).toBe(false);
  });

  it('has no trail above a tool page, so its way up is the home page', () => {
    expect(trailOf('patterns', '/marks.html', tiny)).toEqual([]);
    expect(upOf('patterns', '/marks.html', tiny)).toEqual({ href: '/index.html', label: 'Home' });
    expect(trailOf('patterns', '/patterns/a.html', tiny)).toHaveLength(1);
  });

  it('holds the phone menu on the home page and the tool pages alone', () => {
    expect(isMenuOnly('/index.html')).toBe(true);
    expect(isMenuOnly('/marks.html')).toBe(true);
    expect(isMenuOnly('/404.html')).toBe(true);
    expect(isMenuOnly('/hazards/god-object.html')).toBe(false);
    expect(isMenuOnly(null)).toBe(false);
  });
});

describe('the area of a route', () => {
  const hub = { description: 'd', intro: 'i', tags: [] };
  const small: Structure = {
    areas: [
      { id: 'patterns', label: 'Patterns', hub, pages: [] },
      {
        id: 'caching',
        label: 'Caching',
        nestUnder: 'patterns',
        hub,
        pages: [{ slug: 'a', label: 'A', source: 'docs/patterns/caching/a.md' }],
      },
    ],
  };

  it('reads a page to its own area and a hub to the area it stands for', () => {
    expect(areaOfRoute('/patterns/caching/a.html', small)).toBe('caching');
    expect(areaOfRoute('/patterns/caching.html', small)).toBe('caching');
    expect(areaOfRoute('/index.html', small)).toBeUndefined();
    expect(areaOfRoute('/marks.html', small)).toBeUndefined();
  });

  it('names an area by its label', () => {
    expect(areaLabel('caching', small)).toBe('Caching');
    expect(areaLabel('nowhere', small)).toBeUndefined();
    expect(areaLabel('hazards')).toBe('Hazards & Antipatterns');
  });
});
